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
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createSnapshot } from "./branch.js";
import { command } from "./process.js";
import { record } from "./contracts.js";
import { resultStatus, fileStatus, failureText } from "./runner-results.js";

import {
  root,
  sha256,
  saveSession,
  containedPath,
} from "./session.js";
import type { Session, GeneratedTest, ExecutionResult } from "./session-types.js";

export { resultStatus, fileStatus } from "./runner-results.js";

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

/** Runs one runner/phase group and persists its execution evidence and findings. */
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
