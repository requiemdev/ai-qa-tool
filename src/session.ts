/**
 * @file session.ts
 * Session data structures, state persistence, reporting, and hash validation.
 * Manages atomic writes of session history, execution findings, user feedback,
 * and markdown report generation.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, Scenario, GeneratedTest, Improvement } from "./session-types.js";

import { safeRelative } from "./branch.js";
import { record } from "./contracts.js";
import { validateImprovementCandidate } from "./schemas.js";

export type {
  Session,
  Scenario,
  GeneratedTest,
  Exploration,
  ExecutionResult,
  Finding,
  Improvement,
  ImprovementCandidate,
  Feedback,
} from "./session-types.js";

/**
 * Root directory of the agent-qa tool package.
 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Missing depth identifies legacy sessions, which keep their detailed workflow.
export const isDeep = (session: Session): boolean =>
  session.input.depth !== "standard";
export const scenarioSelected = (item: Scenario): boolean =>
  item.status === "approved" || item.status === "selected";

/**
 * Computes hexadecimal SHA-256 digest of input string content.
 *
 * @param content - String content to hash.
 * @returns 64-character hexadecimal SHA-256 hash string.
 */
export const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

/**
 * Initializes and persists a new QA session on disk.
 *
 * @param input - Session configuration options.
 * @returns Initialized Session object.
 */
export async function newSession(input: Session["input"]): Promise<Session> {
  const id =
    "session-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID().slice(0, 8);
  const dir = join(root, ".agent-qa", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const session: Session = {
    version: 2,
    id,
    dir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: "context",
    status: "active",
    input,
    assumptions: { serverMatchesSource: false, repeatableData: false },
    summary: "",
    conflicts: [],
    gaps: [],
    scenarios: [],
    explorations: [],
    revisions: [],
    executions: [],
    findings: [],
    improvements: [],
    feedback: [],
    exports: [],
    reason: "",
  };
  await saveSession(session);
  return session;
}

/**
 * Atomically writes session state and reports (JSON and Markdown) to disk.
 *
 * @param session - Session object to persist.
 */
export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  const content = JSON.stringify(session, null, 2) + "\n";
  const temp = join(session.dir, "session-" + randomUUID() + ".tmp");
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, join(session.dir, "session.json"));
  await writeFile(join(session.dir, "report.json"), content, { mode: 0o600 });
  await writeFile(join(session.dir, "report.md"), renderReport(session), {
    mode: 0o600,
  });
}

/**
 * Loads and validates an existing session record from disk by session ID.
 *
 * @param id - Session identifier string (e.g. 'session-...').
 * @returns Deserialized and validated Session object.
 * @throws {Error} If ID format is invalid, file missing, or schema validation fails.
 */
export async function loadSession(id: string): Promise<Session> {
  if (!/^session-[\w-]+$/.test(id)) {
    throw new Error("Use the printed session ID, not a path.");
  }
  const dir = await realpath(join(root, ".agent-qa", id));
  const value: unknown = JSON.parse(
    await readFile(join(dir, "session.json"), "utf8"),
  );
  if (
    !record(value) ||
    value.version !== 2 ||
    value.id !== id ||
    !record(value.input) ||
    [
      "scenarios",
      "revisions",
      "executions",
      "feedback",
      "findings",
      "gaps",
      "conflicts",
      "explorations",
      "exports",
    ].some((key) => !Array.isArray(value[key])) ||
    ["repo", "url", "intent", "base"].some(
      (key) =>
        typeof (value.input as Record<string, unknown>)[key] !== "string",
    ) ||
    !Array.isArray(value.input.criteria) ||
    (value.input.depth !== undefined && !["standard", "deep"].includes(String(value.input.depth))) ||
    !record(value.assumptions) ||
    typeof value.summary !== "string" ||
    ![
      "context",
      "plan",
      "explore",
      "generate",
      "review-tests",
      "execute",
      "findings",
      "complete",
    ].includes(String(value.stage))
  ) {
    throw new Error("Invalid or unsupported session record.");
  }
  const session = value as unknown as Session;
  if (value.improvements === undefined) {
    session.improvements = [];
  } else {
    try {
      if (!Array.isArray(value.improvements)) throw new Error("Expected array.");
      const ids = new Set<string>();
      for (const item of value.improvements) {
        if (!record(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) || !["pending", "supported", "unverified", "dismissed"].includes(String(item.assessment)) || typeof item.assessmentReason !== "string" || (item.assessment !== "pending" && !item.assessmentReason.trim())) {
          throw new Error("Malformed improvement record.");
        }
        ids.add(item.id);
        const { id: _id, assessment: _assessment, assessmentReason: _reason, ...candidate } = item;
        validateImprovementCandidate(candidate, session.scenarios.map((scenario) => scenario.id), session.context?.files ?? []);
      }
    } catch {
      throw new Error("Invalid or unsupported session improvement record.");
    }
  }
  session.dir = dir;
  return session;
}

/**
 * Appends developer feedback to the session history.
 *
 * @param session - Target session object.
 * @param targetId - Entity ID or stage being reviewed.
 * @param decision - Decision classification.
 * @param reason - Explanation or instruction notes.
 */
export function feedback(
  session: Session,
  targetId: string,
  decision: string,
  reason: string,
): void {
  session.feedback.push({
    id: randomUUID(),
    targetId,
    revision: session.revisions.length,
    decision,
    reason,
    at: new Date().toISOString(),
  });
}

/**
 * Computes the CLI process exit code based on session status.
 *
 * @param session - Evaluated session object.
 * @returns 0 on pass, 1 on test failure, 2 on blockage or cancellation.
 */
export function sessionExitCode(session: Session): number {
  if (session.status === "failed") {
    return 1;
  }
  if (session.status !== "passed" || session.stage !== "complete") {
    return 2;
  }
  return 0;
}

/** Approved tests with passing evidence from their latest execution in the current revision. */
export function passingTests(session: Session): GeneratedTest[] {
  const revision = session.revisions.at(-1);
  return revision?.tests.filter((test) => {
    if (!test.approved || test.kind === "support") return false;
    const run = session.executions.findLast(
      (run) => run.revision === revision.number && run.phase === "generated" && run.testIds.includes(test.id),
    );
    return (run?.checks?.find((check) => check.testId === test.id)?.status ?? run?.status) === "passed";
  }) ?? [];
}

/**
 * Identifies approved scenarios that have not been fully explored or lack passing tests.
 *
 * @param session - Session to inspect.
 * @returns List of description strings for unresolved coverage gaps.
 */
export function coverageGaps(session: Session): string[] {
  const revision = session.revisions.at(-1);
  const passed = passingTests(session);
  return session.scenarios
    .filter(scenarioSelected)
    .flatMap((item) => {
      const observed = session.explorations.find(
        (flow) => flow.scenarioId === item.id && flow.status !== "incomplete",
      );
      const tests =
        revision?.tests.filter(
          (test) =>
            test.approved &&
            test.kind !== "support" &&
            test.scenarioIds.includes(item.id),
        ) ?? [];
      const executed = tests.some((test) => passed.includes(test));
      const needsBrowser =
        !tests.length || tests.some((test) => test.kind === "browser");
      return [
        ...(needsBrowser && !observed
          ? [`${item.id}: exploration incomplete`]
          : []),
        ...(!executed ? [`${item.id}: no passing approved test`] : []),
      ];
    });
}

/** Shared advisory detail for terminal results and Markdown reports. */
export function formatImprovement(item: Improvement): string {
  return `${item.title} (${item.priority}; ${item.assessment})\nObservation: ${item.observed}\nExpected benefit (inferred): ${item.benefit}\nSuggested change: ${item.suggestedChange}\nAssessment: ${item.assessmentReason}\nSource: ${item.source.join(", ") || "None cited."}\nEvidence: ${item.evidence.join(", ")}`;
}

/**
 * Renders a complete Markdown summary report of the session, including
 * acceptance scope, exploration findings, execution history, and developer feedback.
 *
 * @param session - Session to format into Markdown.
 * @returns Formatted Markdown report string.
 */
export function renderReport(session: Session): string {
  const criteriaText = session.input.criteria
    .map((text, i) => `- AC${i + 1}: ${text}`)
    .join("\n");

  const scenariosText = session.scenarios
    .map(
      (item) =>
        `- ${item.id} [${item.status}] ${item.title} (${item.criteria.join(", ")}, ${item.kind})\n  Expected: ${item.expected}${item.reason ? `; reason: ${item.reason}` : ""}`,
    )
    .join("\n");

  const gapsList = [
    ...session.gaps,
    ...coverageGaps(session),
  ];
  const gapsText =
    gapsList.map((item) => `- ${item}`).join("\n") || "None recorded.";

  const explorationsText =
    session.explorations
      .map(
        (item) =>
          `- ${item.scenarioId} ${item.status}: ${item.observed}; evidence: ${item.evidence.join(", ")}`,
      )
      .join("\n") || "Pending.";

  const executionsText =
    session.executions
      .map(
        (item) =>
          `- ${item.id} revision ${item.revision} ${item.phase} ${item.runner}: ${item.status}. ${item.reason}\n  Evidence: ${item.artifacts}`,
      )
      .join("\n") || "None.";

  const findingsText =
    session.findings
      .map(
        (item) =>
          `- ${item.id} (${item.category}): ${item.observed}\n  Suspected cause: ${item.suspectedCause || "Unknown."}\n  Suggested fix: ${item.suggestedFix || "Inspect retained evidence."}\n  Source: ${item.source.join(", ") || "None cited."}; evidence: ${item.evidence.join(", ")}`,
      )
      .join("\n") || "None recorded.";

  const failuresSummary = session.findings.map((item) =>
    `- ${item.id} (${item.category}): ${item.observed.split("\n")[0]}\n  Suspected cause: ${item.suspectedCause || "Unknown."}\n  Suggested fix: ${item.suggestedFix || "Inspect retained evidence."}\n  Evidence: ${item.evidence.join(", ")}`,
  ).join("\n\n") || "None recorded.";

  const feedbackText =
    session.feedback
      .map(
        (item) =>
          `- ${item.at} ${item.targetId} revision ${item.revision}: ${item.decision}; ${item.reason}`,
      )
      .join("\n") || "None.";

  const exportsText =
    session.exports
      .map(
        (item) =>
          `- ${item.testId} revision ${item.revision}: ${item.destination} (${item.sha256})`,
      )
      .join("\n") || "None.";

  const passed = passingTests(session);
  const revision = session.revisions.at(-1);
  const passingText = passed.length
    ? passed.map((test) => `- ${test.id}: ${test.path}`).join("\n") +
      `\n\nExport selected tests: \`npm run qa -- export --session ${session.id}\`. Coverage gaps remain recorded.`
    : "None.";

  const advisories = (states: Improvement["assessment"][]) => session.improvements
    .filter((item) => states.includes(item.assessment))
    .map((item) => `- ${item.id}: ${formatImprovement(item).replaceAll("\n", "\n  ")}`)
    .join("\n\n");
  const supportedText = advisories(["supported"]) || (session.improvements.length
    ? "No supported recommendations. See unverified candidates and detailed history."
    : "No improvements were identified within the inspected scope.");

  return (
    `# QA session ${session.id}\n\n` +
    `Status: **${session.status}**. Stage: ${session.stage}. ${session.reason}\n\n` +
    `Selected scope: ${session.input.intent}\n\n` +
    `## Observed failures\n\n${failuresSummary}\n\n` +
    `## Potential improvements\n\n${supportedText}\n\n` +
    `## Unverified improvement candidates\n\n${advisories(["pending", "unverified"]) || "None."}\n\n` +
    `## Coverage limitations\n\n${gapsText}\n\n` +
    `## Passing checks available for reuse\n\n${passingText}\n\n` +
    `Review depth: ${isDeep(session) ? "deep" : "standard"}.\n\n` +
    `Skipped modules: ${isDeep(session) ? "none by default" : "independent AI test review, mandatory finding classification, automatic export to target repository"}.\n\n` +
    (revision ? `Test files saved automatically: ${join(revision.dir, "tests")}\n\n` : "") +
    `## Source and assumptions\n\n` +
    `Repository: ${session.input.repo}\n\n` +
    `Target branch: ${session.context?.branch || "(detached/pending)"}; comparison reference: ${session.input.base}; head: ${session.context?.head ?? "pending"}; merge base: ${session.context?.mergeBase ?? "pending"}; local edits: ${session.input.local}.\n\n` +
    `Prerequisites (${session.assumptions.basis ?? "developer-confirmed"}): server represents selected source: ${session.assumptions.serverMatchesSource}. Backend data repeatable/resettable: ${session.assumptions.repeatableData}. Browser isolation does not reset backend state or isolate the OS. Generated tests run as trusted reviewed local code.\n\n` +
    `## Acceptance scope\n\n` +
    `${criteriaText}\n\n` +
    `${scenariosText}\n\n` +
    `## Planning summary\n\n${session.summary}\n\n` +
    `## Excluded files\n\n${session.context?.skipped.join("\n") || "None."}\n\n` +
    `## Uncommitted work\n\n${session.context?.localChanges?.map(item => item.status + " " + item.path).join("\n") || "None recorded."}\n\nEligible untracked selection: ${session.input.local ? "included" : "excluded (--committed-only)"}; untracked paths: ${session.context?.untracked.join(", ") || "none"}.\n\n` +
    `## Exploration\n\n` +
    `${explorationsText}\n\n` +
    `## Executions\n\n` +
    `${executionsText}\n\n` +
    `## Detailed failure history\n\n${findingsText}\n\n` +
    `## Dismissed improvement history\n\n${advisories(["dismissed"]) || "None."}\n\n` +
    `## Selection and developer feedback (append only)\n\n` +
    `${feedbackText}\n\n` +
    `## Accepted exports\n\n` +
    `${exportsText}\n`
  );
}

/**
 * Validates that a target file path resolves within the specified directory
 * without escaping through parent traversal or symlink hops.
 *
 * @param dir - Containing directory path.
 * @param path - Relative path to resolve.
 * @returns Canonical absolute destination path.
 * @throws {Error} If destination escapes dir through directory traversal or symlinks.
 */
export async function containedPath(
  dir: string,
  path: string,
): Promise<string> {
  const destination = join(dir, safeRelative(path));
  const rootDir = await realpath(dir);
  let parent = dirname(destination);
  while (true) {
    const stat = await lstat(parent).catch(() => undefined);
    if (stat) {
      const canonical = await realpath(parent);
      const rel = relative(rootDir, canonical);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        throw new Error("Destination escapes repository through a symlink.");
      }
      break;
    }
    parent = dirname(parent);
  }
  return destination;
}
