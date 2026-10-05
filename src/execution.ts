/**
 * @file execution.ts
 * Architectural Pipeline Stage: Test Execution, Runner Adapters, and Result Analysis.
 *
 * Coordination with pipeline:
 * 1. Invoked by `workflow.ts` during the `execute` stage to run both pre-existing
 *    baseline tests and newly approved generated tests against isolated snapshot trees.
 * 2. Uses `createSnapshot` from `branch.ts` to clone the target revision into an
 *    isolated sandbox, preventing modification of working repository files.
 * 3. Enforces cryptographic tamper-proofing by verifying test hashes against the
 *    developer-approved revision created in `interactive.ts` and `stages.ts`.
 * 4. Dispatches tests across Playwright, Vitest, Jest, and native Node test runners,
 *    parsing logs, failure messages, and TAP/JSON events to construct findings records
 *    that feed into `workflow.ts` and `interactive.ts` for developer classification.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createSnapshot } from "./branch.js";
import { command } from "./process.js";
import { record } from "./contracts.js";
import {
  root,
  sha256,
  saveSession,
  containedPath,
  type Session,
  type GeneratedTest,
  type ExecutionResult,
} from "./session.js";

const require = createRequire(import.meta.url);

/**
 * Resolves the transitive closure of required support files for a given set of test IDs.
 *
 * @param tests - All generated tests available in the revision.
 * @param selected - Primary test IDs chosen for execution or export.
 * @returns Array of tests including primary tests and all transitively required support files.
 * @throws {Error} If any selected test ID cannot be found.
 */
export function selectSupport(
  tests: GeneratedTest[],
  selected: string[],
): GeneratedTest[] {
  const ids = new Set(selected);
  for (const id of ids) {
    const item = tests.find((test) => test.id === id);
    if (!item) {
      throw new Error(`Unknown selected test: ${id}`);
    }
    for (const support of item.supportIds) {
      ids.add(support);
    }
  }
  return tests.filter((item) => ids.has(item.id));
}

/**
 * Determines the execution status (passed, failed, blocked, invalid) from
 * runner exit codes, output logs, and parsed JSON test results.
 *
 * @param runner - Test runner kind (playwright, node, vitest, jest).
 * @param code - Process exit code.
 * @param value - Parsed JSON results from runner output, if available.
 * @param logs - Combined stdout and stderr string logs.
 * @returns Execution outcome classification status.
 */
export function resultStatus(
  runner: string,
  code: number,
  value: unknown,
  logs: string,
): ExecutionResult["status"] {
  // runner-message heuristics; use structured error adapters if attribution is ambiguous.
  if (
    code !== 0 &&
    /executable doesn't exist|failed to launch|browser.*(?:crash|closed)|ECONNREFUSED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED)|ENOTFOUND|Cannot find (?:module|package)|ENOENT/i.test(
      logs + JSON.stringify(value),
    )
  ) {
    return "blocked";
  }
  if (runner === "playwright") {
    if (
      !record(value) ||
      !record(value.stats) ||
      (Array.isArray(value.errors) && value.errors.length)
    ) {
      return "invalid";
    }
    const stats = value.stats;
    if (
      stats.skipped ||
      stats.flaky ||
      typeof stats.expected !== "number" ||
      typeof stats.unexpected !== "number"
    ) {
      return "blocked";
    }
    if (code === 0 && stats.expected > 0) {
      return "passed";
    }
    return code !== 0 && stats.unexpected > 0 ? "failed" : "blocked";
  }
  if (runner === "node") {
    if (
      /SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(
        logs,
      )
    ) {
      return "invalid";
    }
    if (record(value) && record(value.stats)) {
      if (
        !value.stats.tests ||
        value.stats.skipped ||
        value.stats.todo ||
        value.stats.cancelled
      ) {
        return "blocked";
      }
      return code === 0 && value.stats.failed === 0
        ? "passed"
        : code !== 0 &&
            typeof value.stats.failed === "number" &&
            value.stats.failed > 0
          ? "failed"
          : "blocked";
    }
    const count = /# tests (\d+)/.exec(logs);
    if (!count || Number(count[1]) < 1 || /# (?:skipped|todo) [1-9]/.test(logs)) {
      return "blocked";
    }
    return code === 0 ? "passed" : "failed";
  }
  if (
    !record(value) ||
    typeof value.numTotalTests !== "number" ||
    value.numTotalTests < 1 ||
    value.numPendingTests ||
    value.numTodoTests
  ) {
    return "blocked";
  }
  if (value.numFailedTestSuites && !value.numFailedTests) {
    return "invalid";
  }
  return code === 0 && value.numPassedTests === value.numTotalTests
    ? "passed"
    : code !== 0 &&
        typeof value.numFailedTests === "number" &&
        value.numFailedTests > 0
      ? "failed"
      : "blocked";
}
async function executeGroup(
  session: Session,
  runner: string,
  phase: ExecutionResult["phase"],
  tests: { id: string; path: string; content: string }[],
  source: string,
  dir: string,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const revision = session.revisions.at(-1)!.number;
  const supports =
    phase === "generated"
      ? selectSupport(
          session.revisions.at(-1)!.tests,
          tests.map((item) => item.id),
        ).filter((item) => item.kind === "support")
      : [];
  const result: ExecutionResult = {
    id: randomUUID(),
    revision,
    phase,
    runner,
    testIds: tests.map((item) => item.id),
    files: tests.map((item) => ({
      path: item.path,
      sha256: sha256(item.content),
    })),
    status: "blocked",
    artifacts: dir,
    reason: "",
    startedAt: new Date().toISOString(),
  };
  session.executions.push(result);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await saveSession(session);
  result.files.push(
    ...supports.map((item) => ({ path: item.path, sha256: item.sha256 })),
  );
  try {
    let cli: string;
    let args: string[];
    let cwd: string;
    if (runner === "playwright") {
      cwd = root;
      cli = join(
        dirname(require.resolve("@playwright/test/package.json")),
        "cli.js",
      );
      const config = {
        testDir: source,
        testMatch: tests.map((item) => join(source, item.path)),
        outputDir: join(dir, "test-results"),
        workers: 1,
        retries: 0,
        timeout: 30_000,
        globalTimeout: session.input.timeout,
        globalSetup: join(root, "dist/src/setup.js"),
        metadata: { url: session.input.url, artifacts: dir },
        reporter: [
          ["list"],
          ["json", { outputFile: join(dir, "results.json") }],
        ],
        use: {
          browserName: "chromium",
          headless: true,
          viewport: { width: 1280, height: 720 },
          baseURL: new URL(session.input.url).origin,
          reducedMotion: "reduce",
          trace: "on",
          screenshot: "on",
        },
      };
      await writeFile(
        join(dir, "playwright.config.mjs"),
        "export default " + JSON.stringify(config) + ";\n",
        { mode: 0o600 },
      );
      args = [cli, "test", "--config", join(dir, "playwright.config.mjs")];
    } else {
      cwd = source;
      const resolver = createRequire(join(source, "package.json"));
      if (runner === "node") {
        args = [
          "--test",
          "--test-reporter=" + join(root, "dist/src/node-reporter.js"),
          ...tests.map((item) => item.path),
        ];
      } else {
        const pkg = resolver.resolve(runner + "/package.json");
        cli = join(
          dirname(pkg),
          runner === "vitest" ? "vitest.mjs" : "bin/jest.js",
        );
        args =
          runner === "vitest"
            ? [
                cli,
                "run",
                ...tests.map((item) => item.path),
                "--no-cache",
                "--no-update",
                "--maxWorkers=1",
                "--reporter=json",
                "--outputFile=" + join(dir, "results.json"),
              ]
            : [
                cli,
                "--ci",
                "--cacheDirectory=" + join(dir, "jest-cache"),
                "--runInBand",
                "--runTestsByPath",
                ...tests.map((item) => item.path),
                "--json",
                "--outputFile=" + join(dir, "results.json"),
              ];
      }
    }
    progress(`Running ${phase} ${runner} tests (${tests.length} files).`);
    const code = await command(process.execPath, args, {
      cwd,
      artifacts: dir,
      signal,
      timeout: session.input.timeout + 10_000,
    });
    const logs =
      (await readFile(join(dir, "stdout.log"), "utf8")) +
      (await readFile(join(dir, "stderr.log"), "utf8"));
    let raw: unknown = await readFile(join(dir, "results.json"), "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    if (runner === "node") {
      const events: unknown[] = [];
      for (const line of (
        await readFile(join(dir, "stdout.log"), "utf8")
      ).split("\n")) {
        try {
          events.push(JSON.parse(line) as unknown);
        } catch {
          /* Any raw test output remains in logs. */
        }
      }
      const summary = events.findLast(
        (event) =>
          record(event) &&
          event.type === "test:summary" &&
          record(event.data) &&
          !event.data.file,
      );
      raw = {
        stats:
          record(summary) && record(summary.data) ? summary.data.counts : null,
        events,
      };
      await writeFile(
        join(dir, "results.json"),
        JSON.stringify(raw, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    const blocked = await readFile(join(dir, "blocked.json"), "utf8").catch(
      () => "",
    );
    result.status = blocked ? "blocked" : resultStatus(runner, code, raw, logs);
    result.checks = tests.map((item) => ({
      testId: item.id,
      status:
        result.status === "blocked" || result.status === "invalid"
          ? result.status
          : fileStatus(raw, join(source, item.path), source),
    }));
    if (
      result.status === "passed" &&
      result.checks.some((check) => check.status !== "passed")
    ) {
      result.status = "blocked";
    }
    result.reason =
      blocked ||
      (result.status === "passed"
        ? ""
        : result.status === "failed"
          ? `${phase === "existing" ? "Pre-existing" : "Generated"} checks failed: ${tests
              .filter((test) =>
                result.checks?.some(
                  (check) =>
                    check.testId === test.id && check.status === "failed",
                ),
              )
              .map((test) => test.path)
              .join(", ")}. ${failureText(raw)}`
          : "Runner/prerequisite failure or incomplete results; inspect logs/results.");
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  if (result.status !== "passed") {
    session.findings.push({
      id: randomUUID(),
      executionId: result.id,
      scenarioIds: session.revisions
        .at(-1)!
        .tests.filter((test) => result.testIds.includes(test.id))
        .flatMap((test) => test.scenarioIds),
      category:
        result.status === "failed"
          ? "observed-failure"
          : result.status === "invalid"
            ? "invalid-test"
            : "environment",
      observed: result.reason,
      suspectedCause: "",
      suggestedFix: "",
      source: [],
      evidence: [dir],
    });
  }
  await writeFile(
    join(dir, "execution.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  await saveSession(session);
}

function failureText(value: unknown): string {
  const messages: string[] = [];
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (!record(item)) {
      return;
    }
    if (Array.isArray(item.errors)) {
      for (const error of item.errors) {
        if (record(error) && typeof error.message === "string") {
          messages.push(error.message);
        }
      }
    }
    if (record(item.error) && typeof item.error.message === "string") {
      messages.push(item.error.message);
    }
    if (Array.isArray(item.failureMessages)) {
      for (const message of item.failureMessages) {
        if (typeof message === "string") {
          messages.push(message);
        }
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  return (
    [...new Set(messages)]
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .slice(0, 1500) ||
    "Inspect unchanged executed files and retained evidence before attributing an application bug."
  );
}

/**
 * Executes approved tests in a revision against a fresh snapshot sandbox of the repository.
 * Runs pre-existing tests to establish a baseline before executing generated test suites.
 *
 * @param session - Current QA session.
 * @param signal - AbortSignal to cancel execution.
 * @param progress - Callback for reporting progress.
 * @throws {Error} If tests are unapproved, hashes do not match, or execution is aborted.
 */
export async function executeRevision(
  session: Session,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<void> {
  const revision = session.revisions.at(-1)!;
  const tests = selectSupport(
    revision.tests,
    revision.tests
      .filter((item) => item.approved && item.kind !== "support")
      .map((item) => item.id),
  );
  if (!tests.length) {
    throw new Error("No approved tests selected.");
  }
  for (const test of tests) {
    const content = await readFile(
      join(revision.dir, "tests", test.path),
      "utf8",
    );
    if (!test.approved || sha256(content) !== test.sha256) {
      throw new Error(
        "Approved files changed or required support is unapproved; review a new revision before execution.",
      );
    }
  }
  const dir = join(session.dir, "execution-" + randomUUID());
  await mkdir(dir, { mode: 0o700 });
  const browserDir = join(dir, "browser");
  await mkdir(browserDir);
  for (const test of tests.filter((item) => item.runner === "playwright")) {
    const path = join(browserDir, test.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, test.content, { mode: 0o600 });
  }
  const browserTests = tests.filter((item) => item.kind === "browser");
  const localTests = tests.filter(
    (item) => item.kind === "unit" || item.kind === "integration",
  );
  if (localTests.length) {
    try {
      const snapshot = await createSnapshot(session.context!, dir);
      const runners = [...new Set(localTests.map((item) => item.runner))];
      // Establish baseline BEFORE adding any generated files/support to the selected source.
      for (const runner of runners) {
        const paths = session.context!.runners.find(
          (item) => item.kind === runner,
        )!.tests;
        if (paths.length) {
          await executeGroup(
            session,
            runner,
            "existing",
            await Promise.all(
              paths.map(async (path) => ({
                id: "existing:" + path,
                path,
                content: await readFile(join(snapshot, path), "utf8"),
              })),
            ),
            snapshot,
            join(dir, "existing-" + runner),
            signal,
            progress,
          );
        } else {
          session.gaps.push(
            `${runner}: no existing tests available for a baseline.`,
          );
        }
      }
      for (const test of tests.filter((item) => item.runner !== "playwright")) {
        const path = await containedPath(snapshot, test.path);
        if (
          await lstat(path)
            .then(() => true)
            .catch(() => false)
        ) {
          throw new Error(
            `Generated test collides with selected source: ${test.path}`,
          );
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, test.content, { flag: "wx", mode: 0o600 });
      }
      for (const runner of runners) {
        await executeGroup(
          session,
          runner,
          "generated",
          localTests.filter((item) => item.runner === runner),
          snapshot,
          join(dir, "generated-" + runner),
          signal,
          progress,
        );
      }
    } catch (error) {
      const result: ExecutionResult = {
        id: randomUUID(),
        revision: revision.number,
        phase: "generated",
        runner: "snapshot",
        testIds: localTests.map((item) => item.id),
        files: localTests.map((item) => ({
          path: item.path,
          sha256: item.sha256,
        })),
        status: "blocked",
        artifacts: dir,
        reason: error instanceof Error ? error.message : String(error),
        startedAt: new Date().toISOString(),
      };
      session.executions.push(result);
      session.findings.push({
        id: randomUUID(),
        executionId: result.id,
        scenarioIds: localTests.flatMap((item) => item.scenarioIds),
        category: "environment",
        observed: result.reason,
        suspectedCause: "",
        suggestedFix: "",
        source: [],
        evidence: [dir],
      });
      await saveSession(session);
    }
  }
  if (signal.aborted) {
    throw new Error("Cancelled.");
  }
  if (browserTests.length) {
    await executeGroup(
      session,
      "playwright",
      "generated",
      browserTests,
      browserDir,
      join(dir, "generated-playwright"),
      signal,
      progress,
    );
  }
}

/**
 * Evaluates execution outcome for a specific test file from the runner summary
 * or individual test suite assertion lists.
 *
 * @param value - Parsed JSON object from test runner.
 * @param file - Canonical path to the test file.
 * @param source - Repository root or snapshot base directory.
 * @returns Status of the test file execution (passed, failed, or blocked).
 */
export function fileStatus(
  value: unknown,
  file: string,
  source: string,
): ExecutionResult["status"] {
  const statuses: string[] = [];
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (!record(item)) {
      return;
    }
    if (
      item.type === "test:summary" &&
      record(item.data) &&
      item.data.file === file &&
      record(item.data.counts) &&
      item.data.counts.tests
    ) {
      statuses.push(
        item.data.counts.failed
          ? "failed"
          : item.data.success &&
              !item.data.counts.skipped &&
              !item.data.counts.todo &&
              !item.data.counts.cancelled
            ? "passed"
            : "blocked",
      );
    }
    if (
      typeof item.file === "string" &&
      resolve(source, item.file) === file &&
      Array.isArray(item.tests)
    ) {
      for (const test of item.tests) {
        if (record(test) && Array.isArray(test.results)) {
          for (const run of test.results) {
            if (record(run) && typeof run.status === "string") {
              statuses.push(run.status);
            }
          }
        }
      }
    }
    if (
      typeof item.name === "string" &&
      resolve(source, item.name) === file &&
      Array.isArray(item.assertionResults)
    ) {
      for (const assertion of item.assertionResults) {
        if (record(assertion) && typeof assertion.status === "string") {
          statuses.push(assertion.status);
        }
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  if (statuses.some((status) => status === "failed" || status === "timedOut")) {
    return "failed";
  }
  return statuses.length && statuses.every((status) => status === "passed")
    ? "passed"
    : "blocked";
}

