/**
 * @file stages.ts
 * Architectural Pipeline Stage: AI Stage Schemas, Analysis, Exploration, and Test Generation.
 *
 * Coordination with pipeline:
 * 1. Coordinates directly with `workflow.ts`, which orchestrates the QA lifecycle
 *    steps: `analyse` (plan stage) -> `explore` (browser exploration) -> `generate`
 *    (test generation) -> `reviewRevision` (adversarial code review).
 * 2. Receives `BranchContext` from `branch.ts` via `session.context` to ground
 *    scenario discovery in actual diffs, AST imports, and detected test runners.
 * 3. Enforces strict schema validation (`validateSchema`, `validateTests`) before
 *    persisting revisions or handing generated test suites to `interactive.ts` for
 *    developer review and to `execution.ts` for sandboxed test runs.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invokeCodex } from "./codex.js";
import { record } from "./contracts.js";
import { excluded } from "./context.js";
import { safeRelative } from "./branch.js";
import {
  sha256,
  type Session,
  type Scenario,
  type GeneratedTest,
  type Exploration,
} from "./session.js";

const string = { type: "string" };
const strings = { type: "array", items: string };
const gaps = {
  type: "array",
  description:
    "Only concrete unresolved approved behavior, missing prerequisites, or omitted relevant context. No summaries, progress messages, routine upcoming stages, or resolved checks.",
  items: string,
};
const object = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items: object) => ({ type: "array", items });

/**
 * JSON Schema defining the structured output format for the QA analysis and planning stage.
 */
export const planSchema = object({
  summary: string,
  conflicts: strings,
  gaps,
  scenarios: array(
    object({
      title: string,
      criteria: strings,
      kind: {
        type: "string",
        enum: ["normal", "boundary", "error", "regression"],
      },
      steps: strings,
      expected: string,
    }),
  ),
});

/**
 * JSON Schema defining the structured output format for interactive browser exploration.
 */
export const explorationSchema = object({
  flows: array(
    object({
      scenarioId: string,
      status: { type: "string", enum: ["observed", "failed", "incomplete"] },
      steps: strings,
      observed: string,
      evidence: strings,
    }),
  ),
  gaps,
});

/**
 * JSON Schema defining the structured output format for generated test suites.
 */
export const testsSchema = object({
  tests: array(
    object({
      id: string,
      path: string,
      kind: {
        type: "string",
        enum: ["browser", "unit", "integration", "support"],
      },
      runner: {
        type: "string",
        enum: ["playwright", "vitest", "jest", "node"],
      },
      scenarioIds: strings,
      purpose: string,
      expected: string,
      content: string,
      supportIds: strings,
    }),
  ),
  gaps,
});

/**
 * JSON Schema defining the structured output format for independent test reviews.
 */
export const reviewSchema = object({
  assessment: string,
  issues: strings,
  gaps,
});

/**
 * Recursively validates an untrusted AI response against a JSON Schema definition,
 * verifying types, required object fields, and enum values.
 *
 * @param value - Untrusted parsed JSON response.
 * @param schema - Schema definition to validate against.
 * @param path - Current property path for error diagnostics.
 * @throws {Error} If value does not strictly adhere to the schema.
 */
export function validateSchema(
  value: unknown,
  schema: object,
  path = "response",
): void {
  const definition = schema as {
    type?: string;
    enum?: unknown[];
    properties?: Record<string, object>;
    items?: object;
  };
  if (definition.enum && !definition.enum.includes(value)) {
    throw new Error(`Malformed AI ${path}: unexpected value.`);
  }
  if (definition.type === "object") {
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !==
        Object.keys(definition.properties!).sort().join(",")
    ) {
      throw new Error(`Malformed AI ${path}: object fields mismatch.`);
    }
    for (const [key, child] of Object.entries(definition.properties!)) {
      validateSchema(value[key], child, `${path}.${key}`);
    }
  } else if (definition.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Malformed AI ${path}: expected array.`);
    }
    value.forEach((item, i) => {
      validateSchema(item, definition.items!, `${path}[${i}]`);
    });
  } else if (typeof value !== definition.type) {
    throw new Error(`Malformed AI ${path}: expected ${definition.type}.`);
  }
}

function aiOptions(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
) {
  return {
    ...(session.input.model ? { model: session.input.model } : {}),
    timeout: session.input.timeout,
    signal,
    progress,
  };
}
/**
 * Analyzes repository diffs, commit intent, and acceptance criteria to produce
 * a structured plan of candidate test scenarios.
 *
 * @param session - Current QA session.
 * @param signal - AbortSignal to cancel execution.
 * @param progress - Callback for progress reporting.
 * @throws {Error} If AI produces no scenarios or acceptance mappings are invalid.
 */
export async function analyse(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const result = await invokeCodex({
    ...aiOptions(session, signal, progress),
    dir: join(session.dir, "analysis-" + Date.now()),
    role: "qa-expert",
    schema: planSchema,
    prompt: `Map developer acceptance criteria AC1..AC${session.input.criteria.length} to normal behavior, relevant errors/boundaries, and regressions at the changed behavior boundary. Use the line-level diff and affected components to keep scope narrow: do not test unchanged sibling cards, modals, or page controls merely because they share the same screen. Add keyboard, negative-input, and state-transition checks only when the changed behavior or a directly shared handler/container can affect them; label inferred checks and keep them on the affected surface. Every scenario's criteria field MUST contain only exact acceptance IDs such as ["AC1"] or ["AC1","AC2"], never descriptions, prefixes, or other prose. Put human-readable explanations in the scenario title, steps, expected value, summary, or gaps. Every scenario must include at least one exact acceptance ID. Flag conflicts between intent and commit subjects/bodies, and explicitly report omitted/uncovered behavior. Browser replay is supplied by this tool with its own Playwright installation; target-repo browser dependencies are unnecessary. Routine upcoming exploration/execution is not a coverage gap. Do not invent requirements or strict focus-confinement expectations; scope keyboard checks to documented usability. Label inferred regression invariants and hypotheses explicitly for developer review.\n${JSON.stringify({ input: session.input, context: session.context })}`,
  });
  validateSchema(result, planSchema);
  const plan = result as {
    summary: string;
    conflicts: string[];
    gaps: string[];
    scenarios: Omit<Scenario, "id" | "status" | "reason">[];
  };
  if (!plan.scenarios.length) {
    throw new Error("AI produced no QA scenarios.");
  }
  for (const item of plan.scenarios) {
    if (
      !item.title.trim() ||
      !item.expected.trim() ||
      !item.steps.length ||
      !item.criteria.length ||
      item.criteria.some(
        (id) =>
          !/^AC[1-9]\d*$/.test(id) ||
          Number(id.slice(2)) > session.input.criteria.length,
      )
    ) {
      throw new Error("Invalid scenario or acceptance-criteria mapping.");
    }
  }
  session.summary = plan.summary;
  session.conflicts = plan.conflicts;
  session.gaps = plan.gaps;
  session.scenarios = plan.scenarios.map((item, i) => ({
    ...item,
    id: "S" + (i + 1),
    status: "pending",
    reason: "",
  }));
  for (let i = 1; i <= session.input.criteria.length; i++) {
    if (!session.scenarios.some((item) => item.criteria.includes("AC" + i))) {
      session.gaps.push(`AC${i}: no scenario proposed.`);
    }
  }
}

/**
 * Exercises approved UI scenarios within an isolated Playwright Chromium instance,
 * capturing screenshots, trace zip files, console messages, and network requests.
 *
 * @param session - Current QA session.
 * @param signal - AbortSignal to cancel execution.
 * @param progress - Callback for progress reporting.
 * @throws {Error} If exploration yields duplicate or unapproved scenario IDs.
 */
export async function explore(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const dir = join(session.dir, "exploration-" + Date.now());
  const approved = session.scenarios.filter(
    (item) => item.status === "approved",
  );
  const ux = await readFile(
    join(dirname(dirname(session.dir)), "roles", "ui-ux-tester.md"),
    "utf8",
  );
  try {
    const result = await invokeCodex({
      ...aiOptions(session, signal, progress),
      dir,
      role: "browser-debugger",
      schema: explorationSchema,
      browser: { url: session.input.url, headless: session.input.headless },
      prompt: `Navigate to ${session.input.url} and exercise ONLY these approved flows on their affected UI surface. Do not click or keyboard through unrelated cards, modals, links, or external destinations unless an approved scenario explicitly names them. For external links, inspect the current-page href, label, focus, and target semantics instead of navigating away unless navigation is the explicit behavior under test. Return one flow per scenario ID. Unit-only scenarios will be verified later by their detected runner, so browser-only tool access is not itself a permanent gap. Record exact inputs, observed outcomes, selectors at the state where used, screenshots of successes and failures, console/network evidence. Expected behavior stays defined by criteria; if actual behavior differs retain the original expectation. Use prepared repeatable data, do not authenticate. Save screenshots with auto-generated names.\nSCOPED UX GUIDANCE: ${ux}\n${JSON.stringify({ approved, intent: session.input.intent, criteria: session.input.criteria, changedPaths: session.context?.changes.map((change) => change.path) ?? [], developerFeedback: session.feedback })}`,
    });
    validateSchema(result, explorationSchema);
    const value = result as { flows: Exploration[]; gaps: string[] };
    if (
      new Set(value.flows.map((flow) => flow.scenarioId)).size !==
        value.flows.length ||
      value.flows.some(
        (flow) => !approved.some((item) => item.id === flow.scenarioId),
      )
    ) {
      throw new Error(
        "Exploration contains duplicate or unapproved scenario IDs.",
      );
    }
    session.explorations = approved.map(
      (item) =>
        value.flows.find((flow) => flow.scenarioId === item.id) ?? {
          scenarioId: item.id,
          status: "incomplete",
          observed: "No exploration result returned.",
          steps: [],
          evidence: [dir],
        },
    );
    session.gaps.push(...value.gaps);
  } catch (error) {
    session.explorations = approved.map((item) => ({
      scenarioId: item.id,
      status: "incomplete",
      observed: error instanceof Error ? error.message : String(error),
      steps: [],
      evidence: [dir],
    }));
    throw error;
  }
}

/**
 * Validates generated test specifications for safety, collisions with existing
 * repository files, supported runner kinds, and absence of disabled assertions.
 *
 * @param value - Untrusted AI response object containing generated tests.
 * @param session - Current QA session.
 * @returns Validated GeneratedTest array and recorded gaps.
 * @throws {Error} If tests collide with source tree, use unsupported runners, or contain invalid syntax.
 */
export function validateTests(
  value: unknown,
  session: Session,
): { tests: GeneratedTest[]; gaps: string[] } {
  validateSchema(value, testsSchema);
  const response = value as {
    tests: Omit<GeneratedTest, "sha256" | "approved">[];
    gaps: string[];
  };
  if (!response.tests.length) {
    throw new Error("No tests generated.");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const tests = response.tests.map((item) => {
    safeRelative(item.path);
    if (session.context?.tree.includes(item.path)) {
      throw new Error(
        `Generated file collides with selected source: ${item.path}`,
      );
    }
    if (
      excluded.test(item.path) ||
      !(item.kind === "support"
        ? /\.(?:[cm]?[jt]sx?|json|txt|html?|css)$/.test(item.path)
        : /\.[cm]?[jt]sx?$/.test(item.path)) ||
      /(?:^|\/)(?:package\.json|.*\.config\.[^/]+)$/.test(item.path)
    ) {
      throw new Error(`Unsafe generated test path: ${item.path}`);
    }
    if (
      !item.id ||
      ids.has(item.id) ||
      paths.has(item.path) ||
      !item.content.trim() ||
      !item.purpose.trim()
    ) {
      throw new Error("Duplicate/empty generated test.");
    }
    ids.add(item.id);
    paths.add(item.path);
    if (
      item.kind !== "support" &&
      (!item.scenarioIds.length ||
        item.scenarioIds.some(
          (id) =>
            !session.scenarios.some(
              (scenario) =>
                scenario.id === id && scenario.status === "approved",
            ),
        ))
    ) {
      throw new Error("Tests must map to approved scenarios.");
    }
    if (
      item.kind === "browser"
        ? item.runner !== "playwright"
        : item.kind !== "support" &&
          (item.runner === "playwright" ||
            !session.context?.runners.some(
              (runner) => runner.kind === item.runner,
            ))
    ) {
      throw new Error(`Unsupported test runner: ${item.runner}`);
    }
    if (
      item.kind !== "support" &&
      /\b(?:test|it|describe)\.(?:only|skip|fixme|fail|todo)\b/.test(
        item.content,
      )
    ) {
      throw new Error(
        "Generated checks cannot hide, skip, or expect failed assertions.",
      );
    }
    if (
      item.kind !== "support" &&
      (!/\b(?:test|it)(?:\.(?:each|concurrent))?\s*\(/.test(item.content) ||
        !/\b(?:expect\s*\(|assert(?:\.|\s*\())/.test(item.content))
    ) {
      throw new Error(
        "Generated tests require test declarations and behavior assertions.",
      );
    }
    if (
      item.kind === "browser" &&
      (!/\bexpect\s*\(/.test(item.content) || !/\btest\s*\(/.test(item.content))
    ) {
      throw new Error(
        "Browser specs require ordinary test declarations and behavior assertions.",
      );
    }
    return { ...item, sha256: sha256(item.content), approved: false };
  });
  for (const item of tests) {
    if (
      item.supportIds.some(
        (id) =>
          !tests.some(
            (support) => support.id === id && support.kind === "support",
          ),
      )
    ) {
      throw new Error("Unknown required test support file.");
    }
  }
  return { tests, gaps: response.gaps };
}

/**
 * Prompts the AI model to generate complete test files for all approved scenarios,
 * writes them to a new revision directory, and computes content hashes.
 *
 * @param session - Current QA session.
 * @param signal - AbortSignal to cancel execution.
 * @param progress - Callback for progress reporting.
 * @param feedback - Optional feedback string from prior review iterations.
 */
export async function generate(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
  feedback = "",
): Promise<void> {
  const number = session.revisions.length + 1;
  const dir = join(
    session.dir,
    "revision-" + number + "-" + randomUUID().slice(0, 8),
  );
  const result = await invokeCodex({
    ...aiOptions(session, signal, progress),
    dir: join(dir, "generation"),
    role: "test-automator",
    schema: testsSchema,
    prompt: `The tool supplies its own Playwright runner/config/dependency; target-repo browser setup is unnecessary. Report only missing approved coverage or prerequisites, not routine pending execution. Generate ordinary reviewable test files for ALL approved scenarios, without a fixed test-count ceiling. Unit-only scenarios must be covered through their existing runner; do not invent browser flows for them. Browser tests import {test,expect} from '@playwright/test', navigate to ${session.input.url}, use semantic locators observed at the correct state, and assert developer expected behavior. Each file should isolate one scenario so selection/coverage is clear. Dynamic dialog and post-navigation locators are valid. Unit/integration tests use ONLY detected existing runners and conventions and import source via relative paths at the proposed destination. All generated destinations must be NEW paths absent from context.tree; do not copy or replace an existing test. Existing tests are executed separately as a baseline. Support files must be test-only, referenced by supportIds. No app source/configuration changes. Do not weaken expectations to match observed bugs. Report gaps for unobserved selectors, missing fixtures/services, or unsupported setups. Feedback produces a NEW revision.\n${JSON.stringify({ input: session.input, context: session.context, scenarios: session.scenarios, exploration: session.explorations, previous: session.revisions.at(-1)?.tests, developerFeedback: session.feedback, feedback })}`,
  });
  const generated = validateTests(result, session);
  await mkdir(join(dir, "tests"), { recursive: true, mode: 0o700 });
  for (const item of generated.tests) {
    const path = join(dir, "tests", item.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.content, { mode: 0o600 });
  }
  session.revisions.push({
    number,
    dir,
    tests: generated.tests,
    review: "",
    feedback,
  });
  session.gaps.push(
    ...generated.gaps.map((gap) => `Revision ${number}: ${gap}`),
  );
}

/**
 * Conducts an independent adversarial code review of generated test files,
 * assessing assertion strength, selector accuracy, and repeatability.
 *
 * @param session - Current QA session.
 * @param signal - AbortSignal to cancel execution.
 * @param progress - Callback for progress reporting.
 */
export async function reviewRevision(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const revision = session.revisions.at(-1)!;
  const result = await invokeCodex({
    ...aiOptions(session, signal, progress),
    dir: join(revision.dir, "review-" + Date.now()),
    role: "reviewer",
    schema: reviewSchema,
    prompt: `Browser replay uses the tool's own installed Playwright dependency/config, one Chromium worker, fresh contexts, and the developer-confirmed localhost server, so target-repo Playwright setup is not required. Do not claim visual verification of unseen screenshots. Independently review assertions, acceptance coverage, selector evidence, repeatability, imports, and fixture assumptions. Separate evidence from suspected causes. Cite source path/line only when supplied evidence supports it. Flag weak assertions or hidden skipped behavior.\n${JSON.stringify({ criteria: session.input.criteria, scenarios: session.scenarios, explorations: session.explorations, tests: revision.tests, source: session.context?.files })}`,
  });
  validateSchema(result, reviewSchema);
  const review = result as {
    assessment: string;
    issues: string[];
    gaps: string[];
  };
  revision.review = [review.assessment, ...review.issues, ...review.gaps].join(
    "\n",
  );
  await writeFile(join(revision.dir, "review.md"), revision.review + "\n", {
    mode: 0o600,
  });
}

