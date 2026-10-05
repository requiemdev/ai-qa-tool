/**
 * @file workflow.ts
 * Architectural Pipeline Stage: End-to-End QA Pipeline Coordination and Lifecycle Management.
 *
 * Pipeline Stage Lifecycle:
 * 1. context: Collects branch changes, base commits, runners, and snapshots via `branch.collectBranch`
 *    and verifies server-source alignment.
 * 2. plan: Dispatches to `stages.analyse` to extract test scenarios, clarifies intent conflicts,
 *    and invokes `interactive.reviewScenarios` for human approval or adjustment.
 * 3. explore: Executes approved scenarios dynamically in Chromium via `stages.explore`.
 * 4. generate: Generates runnable unit/integration/browser tests via `stages.generate`.
 * 5. review-tests: Conducts independent critique via `stages.reviewRevision` and developer review
 *    via `interactive.reviewTests`.
 * 6. execute: Executes approved tests against the running server via `execution.executeRevision`.
 * 7. findings: Synthesizes execution failures via `assessFindings` (using `codex.invokeCodex`)
 *    and interactive developer review via `interactive.reviewFindings`.
 * 8. complete: Computes final status via `finishStatus`, offers test export via `interactive.exportTests`.
 */

import { readFile } from "node:fs/promises";
import pc from "picocolors";
import { join, resolve } from "node:path";
import { git } from "./context.js";
import { localUrl, record } from "./contracts.js";
import { baseCandidates, collectBranch, createSnapshot } from "./branch.js";
import {
  newSession,
  loadSession,
  saveSession,
  feedback,
  coverageGaps,
  isDeep,
  type Session,
} from "./session.js";
import {
  Terminal,
  reviewScenarios,
  reviewTests,
  reviewFindings,
  exportTests,
} from "./interactive.js";
import {
  analyse,
  explore,
  generate,
  reviewRevision,
  validateSchema,
} from "./stages.js";
import { executeRevision } from "./execution.js";
import { DEFAULT_TIMEOUT, invokeCodex } from "./codex.js";

/**
 * Configuration options supplied to initialize or resume a QA checking session.
 */
export type CheckOptions = {
  /** Target repository root directory. Required; prompted when omitted. */
  repo?: string;
  /** Running application localhost URL. */
  url?: string;
  /** Natural-language description of feature or bug fix under test. */
  intent?: string;
  /** Explicit acceptance criteria statements. */
  criteria?: string[];
  /** Categorization of changes ("feature" or "bug-fix"). */
  changeType?: string;
  /** Base git branch or commit ref to diff against. */
  base?: string;
  /** Whether to include local working tree modifications and untracked files. */
  local?: boolean;
  committedOnly?: boolean;
  deep?: boolean;
  followup?: boolean;
  /** Explicit glob patterns or file paths to include as supporting context. */
  context?: string[];
  /** Identifier of an existing session to resume. */
  session?: string;
  /** LLM model override for generation and assessment. */
  model?: string;
  /** Timeout in milliseconds for subprocesses and LLM calls (1000..3600000). */
  timeout?: number;
  /** Whether to run browser exploration in headless mode. */
  headless?: boolean;
};

/**
 * Validates that the specified timeout falls within the allowed range (1000ms to 3600000ms).
 *
 * @param timeout - Candidate timeout in milliseconds.
 * @returns Validated timeout value.
 * @throws {Error} If timeout is non-finite or outside the permitted bounds.
 */
function validTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 3_600_000) {
    throw new Error("--timeout must be 1000..3600000 milliseconds.");
  }
  return timeout;
}

/**
 * Interactively prompts developer for missing configuration parameters required to start a new QA session.
 *
 * @param options - CLI or programmatically provided options.
 * @param ui - Terminal UI instance.
 * @returns Complete session input configuration.
 * @throws {Error} If acceptance criteria are empty.
 */
async function collectInput(
  options: CheckOptions,
  ui: Terminal,
): Promise<Session["input"]> {
  const suppliedRepo = options.repo ?? (await ui.required("Repository path"));
  if (!suppliedRepo.trim()) {
    throw new Error("Repository path is required.");
  }
  const repo = (
    await git(resolve(suppliedRepo), ["rev-parse", "--show-toplevel"])
  ).trim();
  const base = options.base ?? (await baseCandidates(repo))[0] ??
    (await ui.required("Comparison reference (no fetch)"));
  const url = localUrl(options.url ?? await ui.required("Running localhost URL"));
  const intent = options.intent ?? (await ui.required("Feature/bug-fix description"));
  if (!intent.trim()) { throw new Error("Intent cannot be empty."); }
  const criteria = options.criteria?.length ? options.criteria : [intent];
  if (criteria.some(value => !value.trim())) {
    throw new Error("Acceptance criteria cannot be empty.");
  }
  const changeType = options.changeType ?? "feature";
  if (changeType !== "feature" && changeType !== "bug-fix") {
    throw new Error("--change-type must be feature or bug-fix.");
  }
  const local = options.committedOnly ? false : options.local ?? true;
  const timeout = validTimeout(options.timeout ?? DEFAULT_TIMEOUT);
  return {
    depth: options.deep ? "deep" : "standard",
    explicitCriteria: Boolean(options.criteria?.length),
    repo,
    url,
    intent,
    criteria,
    changeType,
    base,
    local,
    context: options.context ?? [],
    timeout,
    headless: options.headless ?? false,
    ...(options.model ? { model: options.model } : {}),
  };
}

/**
 * Recursively parses and extracts test failures, error messages, and summary statistics
 * from raw JSON test runner results.
 *
 * @param text - Raw test output text (JSON or plain text).
 * @returns Structured summary of test failures or truncated raw text snippet.
 */
function summarizeEvidence(text: string): unknown {
  try {
    const raw: unknown = JSON.parse(text);
    const failures: unknown[] = [];
    const walk = (item: unknown): void => {
      if (Array.isArray(item)) {
        item.forEach(walk);
        return;
      }
      if (!record(item)) {
        return;
      }
      if (Array.isArray(item.errors) && item.errors.length) {
        failures.push({ status: item.status, errors: item.errors });
      }
      if (
        item.status === "failed" &&
        typeof item.failureMessages !== "undefined"
      ) {
        failures.push({
          name: item.fullName,
          failureMessages: item.failureMessages,
        });
      }
      Object.values(item).forEach(walk);
    };
    walk(raw);
    return {
      stats: record(raw)
        ? (raw.stats ?? {
            total: raw.numTotalTests,
            passed: raw.numPassedTests,
            failed: raw.numFailedTests,
          })
        : null,
      failures: failures.slice(0, 12),
      omittedFailures: Math.max(0, failures.length - 12),
    };
  } catch {
    return text.slice(-5000);
  }
}

/**
 * Uses an independent LLM reviewer pass to analyze raw test artifacts and stderr logs
 * for unexplained findings, inferring suspected root causes and suggested remediation fixes.
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 */
async function assessFindings(session: Session, ui: Terminal): Promise<void> {
  const current = session.findings.filter(
    (item) => !item.suspectedCause && !item.suggestedFix,
  );
  if (!current.length) {
    return;
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "suspectedCause", "suggestedFix", "source"],
          properties: {
            id: { type: "string" },
            suspectedCause: { type: "string" },
            suggestedFix: { type: "string" },
            source: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
  const evidence = await Promise.all(
    session.executions
      .filter((run) =>
        current.some((finding) => finding.executionId === run.id),
      )
      .map(async (run) => ({
        run,
        results: summarizeEvidence(
          await readFile(join(run.artifacts, "results.json"), "utf8").catch(
            () => "",
          ),
        ),
        stderr: (
          await readFile(join(run.artifacts, "stderr.log"), "utf8").catch(
            () => "",
          )
        ).slice(-3000),
      })),
  );
  const result = await ui.working("Assessing findings", async (progress) =>
    invokeCodex({
      dir: join(session.dir, "finding-review-" + Date.now()),
      role: "reviewer",
      schema,
      signal: ui.controller.signal,
      reasoning: isDeep(session) ? "xhigh" : "medium",
      timeout: session.input.timeout,
      ...(session.input.model ? { model: session.input.model } : {}),
      progress,
      prompt: `Independently assess evidence supporting these findings. Original observations/classifications are immutable. Return only suspected causes and suggested fixes, clearly labeling hypotheses. Cite source path:line only when the supplied source supports it. Environment and invalid-test failures do not establish application bugs.\n${JSON.stringify({ findings: current, evidence, source: session.context?.files, tests: session.revisions.at(-1)?.tests })}`,
    }),
  );
  validateSchema(result, schema);
  for (const suggestion of (
    result as {
      findings: {
        id: string;
        suspectedCause: string;
        suggestedFix: string;
        source: string[];
      }[];
    }
  ).findings) {
    const finding = current.find((item) => item.id === suggestion.id);
    if (!finding) {
      throw new Error("Reviewer referenced unknown finding.");
    }
    finding.suspectedCause = suggestion.suspectedCause;
    finding.suggestedFix = suggestion.suggestedFix;
    finding.source = suggestion.source.filter((citation) =>
      session.context?.files.some((file) =>
        citation.startsWith(file.path + ":"),
      ),
    );
  }
}

/**
 * Determines and sets the final session outcome status ("passed", "failed", or "blocked")
 * based on the most recent execution outcomes for each runner and unresolved coverage gaps.
 *
 * @param session - Current QA session to finalize.
 */
function finishStatus(session: Session): void {
  const revision = session.revisions.at(-1)?.number;
  const runs = session.executions.filter((item) => item.revision === revision);
  const newest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    newest.set(run.phase + ":" + run.runner, run);
  }
  const results = [...newest.values()];
  if (results.some((run) => run.status === "failed")) {
    session.status = "failed";
  } else if (
    !results.some((run) => run.phase === "generated") ||
    results.some((run) => run.status !== "passed") ||
    coverageGaps(session).length ||
    unresolvedGaps(session).length
  ) {
    session.status = "blocked";
  } else {
    session.status = "passed";
  }
  session.reason =
    session.status === "passed"
      ? "Approved scope passed."
      : session.status === "failed"
        ? "Checks failed; original evidence and developer classifications retained."
        : "Execution or approved coverage is incomplete; inspect report.";
}

/**
 * Returns any reported coverage gaps in the session that have not been explicitly excluded by developer feedback.
 *
 * @param session - Current QA session.
 * @returns Array of active unresolved gap descriptions.
 */
function unresolvedGaps(session: Session): string[] {
  const latest = session.revisions.at(-1)?.number;
  return session.gaps.filter(
    (gap) =>
      (!/^Revision \d+:/.test(gap) || gap.startsWith(`Revision ${latest}:`)) &&
      !session.feedback.some(
        (item) =>
          item.targetId === "gap:" + gap && item.decision === "excluded",
      ),
  );
}

/**
 * Coordinates and executes the end-to-end interactive QA verification workflow.
 * Manages state persistence, pipeline stage transitions (context -> plan -> explore -> generate -> review -> execute -> findings -> complete),
 * cancellation signal handling, and final report / test export.
 *
 * @param options - Session configuration options.
 * @param ui - Terminal UI manager (defaults to a new Terminal instance).
 * @returns Final completed or interrupted Session record.
 */
export async function check(
  options: CheckOptions,
  ui = new Terminal(),
): Promise<Session> {
  let session: Session | undefined;
  let freshExecutionApproval = false;
  try {
    if (options.local && options.committedOnly) {
      throw new Error("--include-local and --committed-only cannot be combined.");
    }
    const requestedTimeout =
      options.timeout === undefined ? undefined : validTimeout(options.timeout);
    session = options.session
      ? await loadSession(options.session)
      : await newSession(await collectInput(options, ui));
    if (options.session && requestedTimeout !== undefined) {
      session.input.timeout = requestedTimeout;
    }
    ui.section("agent-qa");
    ui.show(`Session   ${pc.bold(session.id)}\nArtifacts ${session.dir}`);
    ui.info("Enter cancel or press Ctrl-C to retain partial results.");
    session.status = "active";
    session.reason = "";
    await saveSession(session);
    while (true) {
      if (ui.controller.signal.aborted) {
        throw new Error("Cancelled.");
      }
      if (session.stage === "context") {
        session.context = await collectBranch({
          repo: session.input.repo,
          base: session.input.base,
          local: session.input.local,
          context: session.input.context,
        });
        if (session.input.local) {
          session.context.snapshot = await createSnapshot(
            session.context,
            join(session.dir, "selected-local-source"),
            false,
          );
          for (const file of session.context.files) {
            if (
              !session.context.changes.some(
                (change) =>
                  change.path === file.path && change.status.startsWith("D"),
              )
            ) {
              const frozen = await readFile(
                join(session.context.snapshot, file.path),
                "utf8",
              );
              if (frozen !== file.content) {
                throw new Error(
                  "Local source changed during collection; restart with a stable working tree.",
                );
              }
            }
          }
        }
        ui.section("Branch context");
        ui.show(
          `Target branch ${session.context.branch || "(detached)"}\nHead ${session.context.head}\nComparison reference ${session.input.base} (${session.context.base})\nMerge base ${session.context.mergeBase}\nCommits:\n${session.context.commits.map((item) => item.sha.slice(0, 8) + " " + item.subject + (item.body ? "\n" + item.body : "")).join("\n") || "(none)"}\nChanged areas:\n${session.context.changes.map((item) => item.status + " " + item.path).join("\n")}\nDetected runners: ${session.context.runners.map((item) => item.kind).join(", ") || "none"}\nUncommitted work (${session.input.local ? "included" : "excluded"}): ${session.context.localChanges?.map(item => item.status + " " + item.path).join(", ") || "none"}\nUntracked paths: ${session.context.untracked.join(", ") || "none"}\nExcluded files: ${session.context.skipped.join(", ") || "none"}`,
        );
        if (isDeep(session)) {
          if (
            !(await ui.confirm(
              "Does the supplied running server represent this selected source",
            ))
          ) {
            throw new Error(
              "Server/source mismatch; prepare the matching server before resuming.",
            );
          }
          session.assumptions.serverMatchesSource = true;
          session.assumptions.repeatableData = await ui.confirm(
            "Is test data repeatable/resettable for exploration and fresh-context replay",
          );
          if (!session.assumptions.repeatableData) {
            throw new Error(
              "Prepare repeatable test data; browser isolation does not reset backend state.",
            );
          }
          session.assumptions.basis = "developer-confirmed";
        } else {
          session.assumptions = { serverMatchesSource: true, repeatableData: true, basis: "assumed" };
          ui.show("Assumed prerequisites: server represents the selected source; development data is repeatable/resettable. Browser isolation does not reset backend state.");
        }
        session.stage = "plan";
        await saveSession(session);
      }
      if (session.stage === "plan") {
        if (!session.scenarios.length) {
          ui.section("Analyse");
          await ui.working(
            "Analysing branch and acceptance scope",
            (progress) => analyse(session!, ui.controller.signal, progress),
          );
          await saveSession(session);
        }
        ui.section("Plan");
        ui.show(session.summary);
        for (const conflict of session.conflicts) {
          if (
            !session.feedback.some(
              (item) => item.targetId === "conflict:" + conflict,
            )
          ) {
            ui.show("Intent/commit conflict: " + conflict);
            feedback(
              session,
              "conflict:" + conflict,
              "clarified",
              await ui.required("Clarify the intended behavior"),
            );
          }
        }
        if (isDeep(session)) {
          await reviewScenarios(session, ui);
        } else {
          for (const item of session.scenarios) {
            if (item.status !== "excluded") { item.status = "selected"; }
          }
          ui.show(session.scenarios.map(item => `${item.id} [${item.status}] ${item.title} (${item.criteria.join(", ")})\n  ${item.steps.join(" → ")}\n  Expect: ${item.expected}`).join("\n\n"));
          feedback(session, "plan", "automatically-selected", "Displayed scenarios selected automatically; this is not developer approval.");
          if (!session.scenarios.length) {
            const limitation = "No browser-verifiable behavior identified. Standard review cannot verify this change; use --deep for existing-runner unit/integration coverage.";
            session.gaps.push(limitation);
            session.status = "blocked";
            session.reason = limitation;
            session.stage = "complete";
            ui.warn(limitation);
            await saveSession(session);
            return session;
          }
        }
        session.stage = "explore";
        await saveSession(session);
      }
      if (session.stage === "explore") {
        ui.section("Explore");
        await ui.working(
          "Exploring approved scenarios in Chromium",
          (progress) => explore(session!, ui.controller.signal, progress),
        );
        session.stage = "generate";
        await saveSession(session);
      }
      if (session.stage === "generate") {
        ui.section("Generate");
        const requested =
          session.feedback.filter((item) => item.targetId === "tests").at(-1)
            ?.reason ?? "";
        await ui.working("Generating reviewable tests", (progress) =>
          generate(session!, ui.controller.signal, progress, requested),
        );
        session.stage = "review-tests";
        await saveSession(session);
      }
      if (session.stage === "review-tests") {
        if (isDeep(session) && !session.revisions.at(-1)?.review) {
          ui.section("Review");
          await ui.working(
            "Independently reviewing generated assertions",
            (progress) =>
              reviewRevision(session!, ui.controller.signal, progress),
          );
          await saveSession(session);
        }
        const action = await reviewTests(session, ui);
        freshExecutionApproval = action === "execute";
        session.stage =
          action === "execute"
            ? "execute"
            : action === "regenerate"
              ? "generate"
              : "review-tests";
        await saveSession(session);
        if (session.stage !== "execute") {
          continue;
        }
      }
      if (session.stage === "execute") {
        // A reopened interrupted execution requires approval again, with the same hashes.
        ui.section("Execute");
        if (!freshExecutionApproval) {
          if (!isDeep(session)) {
            const action = await reviewTests(session, ui);
            if (action !== "execute") {
              session.stage = action === "regenerate" ? "generate" : "review-tests";
              await saveSession(session);
              continue;
            }
          } else if (!(await ui.confirm("Resume interrupted execution of approved files against the confirmed server and prepared data"))) {
            throw new Error("Execution deferred.");
          }
        }
        freshExecutionApproval = false;
        await ui.working("Executing approved tests", (progress) =>
          executeRevision(session!, ui.controller.signal, progress),
        );
        session.stage = "findings";
        await saveSession(session);
      }
      if (session.stage === "findings" || session.stage === "complete") {
        if (!isDeep(session) && !options.followup) {
          await reviewFindings(session, ui, false);
          ui.show([...coverageGaps(session), ...unresolvedGaps(session)].join("\n") || "Selected coverage complete.");
          finishStatus(session);
          session.stage = "complete";
          await saveSession(session);
          return session;
        }
        if (isDeep(session) && session.stage === "findings") {
          try {
            await assessFindings(session, ui);
          } catch (error) {
            if (ui.controller.signal.aborted) {
              throw error;
            }
            ui.warn(
              `Finding review incomplete: ${error instanceof Error ? error.message : String(error)}`,
            );
            session.gaps.push("Independent finding assessment incomplete.");
          }
        }
        await reviewFindings(session, ui);
        ui.section("Coverage");
        ui.show(
          coverageGaps(session).join("\n") ||
            "All approved scenarios have explored states and passing tests.",
        );
        for (const gap of unresolvedGaps(session)) {
          ui.warn("Reported gap: " + gap);
          if (
            await ui.confirm("Explicitly exclude this gap from accepted scope")
          ) {
            feedback(
              session,
              "gap:" + gap,
              "excluded",
              await ui.required("Scope exclusion reason"),
            );
          }
        }
        const action = await ui.ask(
          "Results: finish / revise-tests / revise-plan / rerun",
          "finish",
        );
        if (action === "revise-tests") {
          feedback(
            session,
            "tests",
            "regenerate",
            await ui.required("Feedback for new revision"),
          );
          session.stage = "generate";
          await saveSession(session);
          continue;
        }
        if (action === "revise-plan") {
          session.stage = "plan";
          await saveSession(session);
          continue;
        }
        if (action === "rerun") {
          session.stage = "review-tests";
          await saveSession(session);
          continue;
        }
        if (action !== "finish") {
          continue;
        }
        finishStatus(session);
        session.stage = "complete";
        await saveSession(session);
        if (await ui.confirm("Export selected approved tests")) {
          await exportTests(session, ui);
        }
        return session;
      }
    }
  } catch (error) {
    if (!session) {
      throw error;
    }
    session.status =
      ui.controller.signal.aborted || /Cancelled/.test(String(error))
        ? "cancelled"
        : "blocked";
    session.reason = error instanceof Error ? error.message : String(error);
    await saveSession(session);
    ui.error(`${session.status.toUpperCase()}: ${session.reason}`);
    ui.info(`Resume: agent-qa review --session ${session.id}`);
    return session;
  } finally {
    ui.close();
  }
}

/**
 * Loads an existing QA session by ID and initiates an interactive session test export flow.
 *
 * @param id - Session identifier.
 */
export async function exportSession(id: string): Promise<void> {
  const ui = new Terminal();
  try {
    await exportTests(await loadSession(id), ui);
  } finally {
    ui.close();
  }
}
