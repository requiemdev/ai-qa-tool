import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
  chmod,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  collectBranch,
  baseCandidates,
  createSnapshot,
  detectRunners,
  availableRunners,
} from "../src/branch.js";
import {
  newSession,
  saveSession,
  loadSession,
  feedback,
  coverageGaps,
  passingTests,
  sessionExitCode,
  sha256,
  containedPath,
  renderReport,
} from "../src/session.js";
import { validateSchema, planSchema, validateTests } from "../src/stages.js";
import { validateDiscoveryResponse, validateImprovementCandidate } from "../src/schemas.js";
import { executeRevision, resultStatus, selectSupport, fileStatus } from "../src/execution.js";
import {
  reviewScenarios,
  reviewTests,
  exportTests,
  editRevision,
  Terminal,
  reviewFindings,
} from "../src/interactive.js";
import { check } from "../src/workflow.js";
import { browserActionSetPrompt, browserTools } from "../src/codex.js";

const input = {
  repo: "/tmp",
  url: "http://127.0.0.1:3000/",
  intent: "Create item",
  criteria: ["Create item shows confirmation"],
  changeType: "feature" as const,
  base: "main",
  local: false,
  context: [],
  timeout: 30_000,
  headless: true,
};
class ScriptedTerminal extends Terminal {
  output: string[] = [];
  prompts: string[] = [];
  constructor(private answers: string[]) {
    super(new PassThrough());
  }
  override show(text: string): void {
    this.output.push(text);
  }
  override async ask(_text: string, fallback = ""): Promise<string> {
    this.prompts.push(_text);
    const value = this.answers.shift();
    if (value === undefined) {
      throw new Error("Scripted input exhausted.");
    }
    if (value === "cancel") {
      this.controller.abort();
      throw new Error("Cancelled.");
    }
    return value || fallback;
  }
}
const scenario = {
  id: "S1",
  title: "Create item",
  criteria: ["AC1"],
  kind: "normal" as const,
  steps: ["Open dialog", "Submit Name"],
  expected: "Confirmation appears",
  status: "approved" as const,
  reason: "",
};
const generated = {
  id: "T1",
  path: "tests/create.spec.ts",
  kind: "browser",
  runner: "playwright",
  scenarioIds: ["S1"],
  purpose: "Create item behavior",
  expected: "Confirmation appears",
  content:
    "import { test, expect } from '@playwright/test'; test('Create', async ({page}) => { await expect(page.getByRole('status')).toHaveText('Created Ada'); });\n",
  supportIds: [],
};

test("advisories validate independently and survive version-2 session persistence", async () => {
  const session = await newSession(input);
  const candidate = {
    scenarioIds: ["S1"],
    title: "Explain the submit result",
    observed: "The working submit flow has no visible confirmation.",
    benefit: "Inferred: users can recognize completion without repeating the action.",
    suggestedChange: "Add a visible status message after submission.",
    priority: "medium" as const,
    source: [],
    evidence: ["exploration/response.json"],
  };
  const files = [{ path: "src/form.ts", content: "submit();\n" }];
  try {
    assert.deepEqual(session.improvements, []);
    session.scenarios = [scenario];
    const response = { summary: "Scoped plan", conflicts: [], gaps: [], scenarios: [], improvements: [candidate, { ...candidate, scenarioIds: ["S999"] }, { ...candidate, source: ["unknown.ts:1"] }] };
    const validated = validateDiscoveryResponse(response, planSchema, ["S1"], files);
    assert.deepEqual(validated.improvements, [candidate]);
    assert.equal(validated.rejected.length, 2);
    assert.equal(response.improvements.length, 3);
    for (const invalid of [
      { ...candidate, observed: " " },
      { ...candidate, source: [], evidence: [] },
      { ...candidate, scenarioIds: [], source: [] },
      { ...candidate, evidence: [""] },
      { ...candidate, source: ["src/form.ts:0"] },
      { ...candidate, source: ["src/form.ts:99"] },
    ]) assert.throws(() => validateImprovementCandidate(invalid, ["S1"], files));
    assert.deepEqual(validateImprovementCandidate({ ...candidate, scenarioIds: [], source: ["src/form.ts:1"], evidence: [] }, ["S1"], files).scenarioIds, []);
    session.improvements = [{ ...candidate, id: "I1", assessment: "dismissed", assessmentReason: "The existing confirmation is intentional and sufficient." }];
    await saveSession(session);
    assert.deepEqual((await loadSession(session.id)).improvements, session.improvements);
    assert.deepEqual(session.findings, []);
    const path = join(session.dir, "session.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    const { improvements: _improvements, ...legacy } = saved;
    await writeFile(path, JSON.stringify(legacy));
    assert.deepEqual((await loadSession(session.id)).improvements, []);
    for (const improvements of [null, {}, [1], [{ ...session.improvements[0], scenarioIds: ["S999"] }], [{ ...session.improvements[0], assessment: "bug" }], [{ ...session.improvements[0], assessmentReason: "" }]]) {
      await writeFile(path, JSON.stringify({ ...saved, improvements }));
      await assert.rejects(loadSession(session.id), /improvement record/);
    }
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("reports lead with failures and advisory actions, preserve passing checks and dismissed history", async () => {
  const session = await newSession({ ...input, depth: "standard" });
  try {
    session.scenarios = [scenario];
    session.explorations = [{ scenarioId: "S1", status: "observed", observed: "Created Ada", steps: [], evidence: ["flow.json"] }];
    session.revisions = [{ number: 1, dir: session.dir, tests: [{ ...generated, kind: "browser", runner: "playwright", sha256: sha256(generated.content), approved: true }], review: "", feedback: "" }];
    session.executions = [{ id: "run", revision: 1, phase: "generated", runner: "playwright", testIds: ["T1"], files: [{ path: generated.path, sha256: sha256(generated.content) }], status: "passed", artifacts: "execution-evidence", reason: "", startedAt: session.createdAt }];
    session.findings = [{ id: "F1", executionId: "old-run", scenarioIds: ["S1"], category: "observed-failure", observed: "Earlier submission showed the wrong name.", suspectedCause: "Hypothesis: stale state", suggestedFix: "Inspect state handling", source: [], evidence: ["original-failure"] }];
    const candidate = { scenarioIds: ["S1"], title: "Explain the next step", observed: "Submission succeeds without next-step instructions.", benefit: "Users can continue after creating an item.", suggestedChange: "Add a next-step hint.", priority: "medium" as const, source: [], evidence: ["flow.json"], assessmentReason: "Structured observation supports the recommendation." };
    session.improvements = [
      { ...candidate, id: "I1", assessment: "supported" },
      { ...candidate, id: "I2", title: "Unverified responsive claim", assessment: "unverified", assessmentReason: "No resize evidence supplied." },
      { ...candidate, id: "I3", title: "Dismissed colour preference", assessment: "dismissed", assessmentReason: "Intentional styling; unsupported preference." },
    ];
    const report = renderReport(session);
    assert(report.indexOf("## Observed failures") < report.indexOf("## Potential improvements"));
    assert(report.indexOf("## Potential improvements") < report.indexOf("## Source and assumptions"));
    assert.match(report, /Expected benefit \(inferred\): Users can continue/);
    assert.match(report, /Observation: Submission succeeds/);
    assert.match(report, /Suggested change: Add a next-step hint/);
    assert.match(report, /Unverified improvement candidates[\s\S]*No resize evidence supplied/);
    assert(report.indexOf("Dismissed colour preference") > report.indexOf("## Dismissed improvement history"));
    assert.match(report, /T1: tests\/create.spec.ts/);
    assert.match(report, /original-failure/);
    assert.match(report, /execution-evidence/);
    const ui = new ScriptedTerminal([]);
    try {
      await reviewFindings(session, ui, false);
      assert.equal(ui.prompts.length, 0);
      const output = ui.output.join("\n");
      assert(output.indexOf("Selected scope:") < output.indexOf("Observed failure F1"));
      assert(output.indexOf("Explain the next step") < output.indexOf("execution-evidence"));
      assert(!output.includes("Dismissed colour preference"));
      assert.match(output, /Unverified responsive claim/);
      assert.match(output, /Passing checks: T1/);
    } finally { ui.close(); }
    session.improvements = [];
    assert.match(renderReport(session), /No improvements were identified within the inspected scope/);
  } finally { await rm(session.dir, { recursive: true, force: true }); }
});

test("browser prompts match the enabled action set", () => {
  for (const tool of browserTools) {
    assert.match(browserActionSetPrompt, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(browserActionSetPrompt, /only those exact tool names/);
  assert.match(browserActionSetPrompt, /hover, drag, evaluate, arbitrary code/);
  assert.match(browserActionSetPrompt, /deferred to generated Playwright assertions/);
  assert.match(browserActionSetPrompt, /Intentional depth skips.*never be returned as gaps/);
});

test("committed branch selection excludes dirty imports and includes HTML/config/renames/deletes; bases use priority order", async () => {
  const repo = await mkdtemp(join(tmpdir(), "qa-branch-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    await writeFile(
      join(repo, "App.ts"),
      "import './styles.css'; import { value } from './value.js'; export { value };\n",
    );
    await writeFile(join(repo, "value.ts"), "export const value = 1;\n");
    await writeFile(join(repo, "client.js"), "export const client = 1;");
    await writeFile(join(repo, "styles.css"), "body { color: black }");
    await writeFile(join(repo, "rename.ts"), "export const rename = true;\n");
    await writeFile(join(repo, "delete.ts"), "export const gone = true;\n");
    await writeFile(join(repo, "binary.ts"), "export const initiallyText = true;\n");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    git("add", ".");
    git("commit", "-qm", "baseline");
    git("branch", "master");
    git("checkout", "-qb", "feature");
    await writeFile(
      join(repo, "App.ts"),
      "import './styles.css'; import { value } from './value.js'; export const feature = value;\n",
    );
    await writeFile(
      join(repo, "page.html"),
      '<button>Create item</button><script src="client.js"></script><link href="/styles.css" rel="stylesheet">',
    );
    git("mv", "rename.ts", "renamed.ts");
    git("rm", "-q", "delete.ts");
    git("add", ".");
    git(
      "commit",
      "-qm",
      "Create dialog",
      "-m",
      "Shows result after submission.",
    );
    await writeFile(join(repo, "value.ts"), "export const value = 999;\n");
    await writeFile(join(repo, "client.js"), "export const client = 999;");
    await writeFile(join(repo, "App.ts"), "export const DIRTY = true;\n");
    await writeFile(join(repo, "untracked.ts"), "export const local = true;\n");
    await writeFile(join(repo, ".env"), "SECRET=must-not-submit");
    const before = git("status", "--porcelain");
    assert.deepEqual(await baseCandidates(repo), ["main", "master"]);
    const branch = await collectBranch({ repo, base: "main", local: false });
    assert.match(
      branch.files.find((file) => file.path === "App.ts")!.content,
      /feature = value/,
    );
    assert.match(
      branch.files.find((file) => file.path === "value.ts")!.content,
      /value = 1/,
    );
    assert(branch.files.some((file) => file.path === "styles.css"));
    assert(branch.files.some((file) => file.path === "page.html"));
    assert.match(
      branch.files.find((file) => file.path === "client.js")!.content,
      /client = 1/,
    );
    assert.equal(
      branch.files.find((file) => file.path === "delete.ts")!.content,
      "",
    );
    assert.equal(
      branch.changes.find((change) => change.path === "renamed.ts")!
        .previousPath,
      "rename.ts",
    );
    assert.equal(
      branch.commits[0]!.body.trim(),
      "Shows result after submission.",
    );
    assert(!JSON.stringify(branch).includes("must-not-submit"));
    assert(!branch.files.some((file) => file.path === "untracked.ts"));
    const scratch = await mkdtemp(join(tmpdir(), "qa-snapshot-"));
    const snapshot = await createSnapshot(branch, scratch);
    assert.match(
      await readFile(join(snapshot, "value.ts"), "utf8"),
      /value = 1/,
    );
    assert.match(await readFile(join(repo, "value.ts"), "utf8"), /value = 999/);
    assert.equal(git("status", "--porcelain"), before);
    await rm(scratch, { recursive: true, force: true });
    await writeFile(join(repo, "binary.ts"), Buffer.from([0, 1, 2]));
    await symlink("/etc/passwd", join(repo, "linked.ts"));
    await writeFile(join(repo, "staged.ts"), "export const staged = true;\n");
    git("add", "staged.ts");
    const local = await collectBranch({ repo, base: "main" });
    assert(local.files.some(file => file.path === "staged.ts"));
    assert(local.files.some(file => file.path === "page.html"));
    assert(local.localChanges?.some(change => change.path === "App.ts"));
    const committedOnly = await collectBranch({ repo, base: "main", local: false });
    assert(!committedOnly.files.some(file => file.path === "staged.ts" || file.path === "untracked.ts"));
    assert.match(committedOnly.files.find(file => file.path === "App.ts")!.content, /feature = value/);
    assert(local.skipped.includes(".env"));
    assert(local.skipped.some(path => path.startsWith("binary.ts")));
    assert(local.skipped.some(path => path.startsWith("linked.ts")));
    assert.equal(local.local, true);
    assert(local.files.some((file) => file.path === "untracked.ts"));
    assert.match(
      local.files.find((file) => file.path === "App.ts")!.content,
      /DIRTY/,
    );
    const frozenDir = await mkdtemp(join(tmpdir(), "qa-frozen-"));
    try {
      local.snapshot = await createSnapshot(local, frozenDir, false);
      await writeFile(join(repo, "App.ts"), "export const LATER = true;");
      const cloned = await createSnapshot(local, join(frozenDir, "run"));
      assert.match(await readFile(join(cloned, "App.ts"), "utf8"), /DIRTY/);
      await assert.rejects(readFile(join(cloned, "binary.ts")), /ENOENT/);
    } finally {
      await rm(frozenDir, { recursive: true, force: true });
    }
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.deepEqual(await baseCandidates(repo), ["main", "master"]);
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "main"));
    assert.deepEqual(await baseCandidates(repo), ["origin/main", "main", "master"]);
    await assert.rejects(collectBranch({ repo, base: "--bad" }), /valid base/);
    await assert.rejects(
      collectBranch({ repo, base: "main", context: [".env"] }),
      /Excluded/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("versioned review records preserve exclusions, reject/regenerate, cancelled sessions and source approvals", async () => {
  const session = await newSession(input);
  try {
    session.scenarios = [{ ...scenario, status: "pending" }];
    let ui = new ScriptedTerminal([
      "edit",
      "S1",
      "Clarify post-submit state",
      "",
      "",
      "Created Ada appears",
      "approve",
    ]);
    try {
      await reviewScenarios(session, ui);
    } finally {
      ui.close();
    }
    assert.equal(session.scenarios[0]!.expected, "Created Ada appears");
    assert(
      session.feedback.some(
        (item) =>
          item.decision === "edit" &&
          item.reason.includes("Confirmation appears"),
      ),
    );
    const validated = validateTests({ tests: [generated], gaps: [] }, session);
    const dir = join(session.dir, "revision-1");
    await mkdir(join(dir, "tests/tests"), { recursive: true });
    await writeFile(join(dir, "tests", generated.path), generated.content);
    session.revisions.push({
      number: 1,
      dir,
      tests: validated.tests,
      review: "Assertions reviewed.",
      feedback: "",
    });
    ui = new ScriptedTerminal(["reject", "Needs error coverage"]);
    try {
      assert.equal(await reviewTests(session, ui), "regenerate");
    } finally {
      ui.close();
    }
    assert(session.feedback.some((item) => item.decision === "rejected"));
    ui = new ScriptedTerminal(["source", "all", "approve", "all", "yes"]);
    try {
      assert.equal(await reviewTests(session, ui), "execute");
    } finally {
      ui.close();
    }
    assert(session.revisions[0]!.tests[0]!.approved);
    await writeFile(
      join(dir, "tests", generated.path),
      generated.content + "// changed",
    );
    ui = new ScriptedTerminal(["approve", "all"]);
    try {
      await assert.rejects(reviewTests(session, ui), /changed since review/);
    } finally {
      ui.close();
    }
    session.stage = "review-tests";
    await saveSession(session);
    assert.equal(
      (await loadSession(session.id)).feedback.length,
      session.feedback.length,
    );
    ui = new ScriptedTerminal(["cancel"]);
    const cancelled = await check({ session: session.id }, ui);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(sessionExitCode(cancelled), 2);
    assert.equal((await loadSession(session.id)).status, "cancelled");
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("malformed AI output, unsupported setups and incomplete results never become passing scope", async () => {
  const session = await newSession(input);
  try {
    session.scenarios = [scenario];
    assert.throws(
      () => validateSchema({ summary: "x" }, planSchema),
      /Malformed/,
    );
    assert.throws(
      () =>
        validateSchema(
          { summary: "x", conflicts: [1], gaps: [], scenarios: [] },
          planSchema,
        ),
      /Malformed/,
    );
    assert.throws(
      () =>
        validateTests(
          { tests: [{ ...generated, scenarioIds: ["S999"] }], gaps: [] },
          session,
        ),
      /approved scenarios/,
    );
    assert.throws(
      () =>
        validateTests(
          { tests: [{ ...generated, path: "../source.ts" }], gaps: [] },
          session,
        ),
      /relative path/,
    );
    assert.throws(
      () =>
        validateTests(
          { tests: [{ ...generated, kind: "unit", runner: "jest" }], gaps: [] },
          session,
        ),
      /Unsupported/,
    );
    assert.throws(
      () =>
        validateTests(
          { tests: [{ ...generated, supportIds: ["missing"] }], gaps: [] },
          session,
        ),
      /support/,
    );
    const four = Array.from({ length: 4 }, (_, i) => ({
      ...generated,
      id: "T" + i,
      path: `tests/${i}.spec.ts`,
    }));
    assert.equal(
      validateTests({ tests: four, gaps: [] }, session).tests.length,
      4,
    );
    assert.equal(
      resultStatus(
        "playwright",
        0,
        { stats: { expected: 1, unexpected: 0, skipped: 1 } },
        "",
      ),
      "blocked",
    );
    assert.equal(
      resultStatus(
        "playwright",
        1,
        { stats: { expected: 0, unexpected: 1, skipped: 0 } },
        "",
      ),
      "failed",
    );
    assert.equal(
      resultStatus("playwright", 1, { errors: ["SyntaxError"], stats: {} }, ""),
      "invalid",
    );
    assert.equal(
      resultStatus("node", 1, null, "Cannot find module missing"),
      "blocked",
    );
    assert.equal(
      resultStatus("node", 1, null, "# tests 1\n# fail 1"),
      "failed",
    );
    assert.equal(
      fileStatus(
        {
          events: [
            {
              type: "test:summary",
              data: {
                file: "/tmp/test/a.cjs",
                counts: { tests: 1, passed: 1, failed: 0 },
                success: true,
              },
            },
          ],
        },
        "/tmp/test/a.cjs",
        "/tmp",
      ),
      "passed",
    );
    assert.equal(
      resultStatus(
        "node",
        0,
        { stats: { tests: 1, failed: 0 } },
        "console: Cannot find module",
      ),
      "passed",
    );
    assert.equal(
      resultStatus(
        "vitest",
        0,
        { numTotalTests: 1, numPassedTests: 1, numPendingTests: 0 },
        "",
      ),
      "passed",
    );
    assert.equal(
      fileStatus(
        {
          suites: [
            {
              specs: [
                {
                  file: "tests/a.spec.ts",
                  tests: [{ results: [{ status: "passed" }] }],
                },
                {
                  file: "tests/b.spec.ts",
                  tests: [{ results: [{ status: "failed" }] }],
                },
              ],
            },
          ],
        },
        "/tmp/tests/a.spec.ts",
        "/tmp",
      ),
      "passed",
    );
    assert.equal(
      fileStatus(
        {
          testResults: [
            {
              name: "/tmp/tests/a.test.js",
              assertionResults: [{ status: "failed" }],
            },
          ],
        },
        "/tmp/tests/a.test.js",
        "/tmp",
      ),
      "failed",
    );
    assert.equal(
      resultStatus("jest", 1, { numTotalTests: 1, numFailedTests: 1 }, ""),
      "failed",
    );
    assert(coverageGaps(session).length);
    session.status = "passed";
    assert.equal(sessionExitCode(session), 2);
    assert.deepEqual(
      detectRunners(
        ["test/a.test.js", "vitest.config.ts"],
        JSON.stringify({
          scripts: { test: "node --test" },
          devDependencies: { jest: "30" },
        }),
      ).map((item) => item.kind),
      ["vitest", "jest", "node"],
    );
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("normal features require unit tests or an explicit gap and preserve detected runners", async () => {
  const session = await newSession({ ...input, depth: "standard" });
  try {
    session.scenarios = [scenario];
    const unit = { ...generated, kind: "unit", runner: "vitest", content: "import {test,expect} from 'vitest'; test('feature', () => expect(1).toBe(1));" };
    assert.deepEqual(availableRunners(), [{ kind: "vitest", tests: [], config: null }]);
    assert.equal(validateTests({ tests: [unit], gaps: [] }, session).tests[0]!.runner, "vitest");
    assert.throws(() => validateTests({ tests: [generated], gaps: [] }, session), /require unit tests/);
    assert.throws(() => validateTests({ tests: [{ ...unit, kind: "integration" }], gaps: [] }, session), /require unit tests/);
    assert.throws(() => validateTests({ tests: [generated], gaps: ["Selectors unobserved for browser coverage."] }, session), /require unit tests/);
    assert.equal(validateTests({ tests: [generated], gaps: ["Unit coverage unavailable: markup-only feature has no executable logic."] }, session).tests.length, 1);
    for (const kind of ["node", "jest", "vitest"] as const) {
      session.context = {
        repo: input.repo, comparison: "main", changes: [], untracked: [], files: [], imported: [], skipped: [],
        head: "fixture", base: "main", mergeBase: "fixture", branch: "feature", local: false, commits: [], tree: [],
        runners: [{ kind, tests: [], config: null }],
      };
      assert.equal(availableRunners(session.context), session.context.runners);
      assert.equal(validateTests({ tests: [{ ...unit, runner: kind }], gaps: [] }, session).tests[0]!.runner, kind);
      if (kind !== "vitest") {
        assert.throws(() => validateTests({ tests: [unit], gaps: [] }, session), /Unsupported/);
      }
    }
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("standard browser validation accepts delegated Playwright support assertions", async () => {
  const session = await newSession({ ...input, depth: "standard", changeType: "bug-fix" });
  try {
    session.scenarios = [scenario];
    const browser = {
      ...generated,
      content:
        "import { test } from '@playwright/test'; test('delegated', () => { assertLayout(); });\n",
      supportIds: ["H1"],
    };
    const support = {
      ...generated,
      id: "H1",
      path: "tests/helper.ts",
      kind: "support",
      runner: "playwright",
      scenarioIds: [],
      content:
        "import { expect } from '@playwright/test'; export function assertLayout() { expect(true).toBe(true); }\n",
      supportIds: [],
    };
    const result = validateTests(
      { tests: [browser, support], gaps: [] },
      session,
    );
    assert.equal(result.tests.find((item) => item.id === "H1")?.runner, "playwright");
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("partial sessions can export approved files with support, collision previews and symlink protection", async () => {
  const repo = await mkdtemp(join(tmpdir(), "qa-export-"));
  const session = await newSession({ ...input, repo });
  try {
    session.scenarios = [scenario];
    const support = {
      ...generated,
      id: "H1",
      path: "tests/helper.ts",
      kind: "support",
      content: 'export const name = "Ada";\n',
      scenarioIds: [],
      supportIds: [],
    };
    const result = validateTests(
      { tests: [{ ...generated, supportIds: ["H1"] }, support], gaps: [] },
      session,
    );
    const dir = join(session.dir, "revision-1");
    for (const item of result.tests) {
      item.approved = true;
      await mkdir(join(dir, "tests/tests"), { recursive: true });
      await writeFile(join(dir, "tests", item.path), item.content);
    }
    session.revisions.push({
      number: 1,
      dir,
      tests: result.tests,
      review: "",
      feedback: "",
    });
    assert.deepEqual(
      selectSupport(result.tests, ["T1"]).map((item) => item.id),
      ["T1", "H1"],
    );
    session.status = "partial";
    session.stage = "complete";
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, generated.path), "KEEP EXISTING");
    const ui = new ScriptedTerminal([
      "T1",
      "",
      "",
      "tests/new.spec.ts",
      "",
      "yes",
    ]);
    try {
      await exportTests(session, ui);
    } finally {
      ui.close();
    }
    assert.equal(
      await readFile(join(repo, generated.path), "utf8"),
      "KEEP EXISTING",
    );
    assert.equal(
      await readFile(join(repo, "tests/new.spec.ts"), "utf8"),
      generated.content,
    );
    assert.equal(
      await readFile(join(repo, support.path), "utf8"),
      support.content,
    );
    assert.equal(session.exports.length, 2);
    assert(ui.output.some((item) => item.includes("Collision:")));
    await symlink("/etc", join(repo, "outside"));
    await assert.rejects(containedPath(repo, "outside/passwd"), /escapes/);
    feedback(session, "T1", "invalid", "Example test invalid");
    await saveSession(session);
    assert.equal(
      (await loadSession(session.id)).exports[0]!.sha256,
      sha256(generated.content),
    );
    assert.equal((await loadSession(session.id)).status, "partial");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("editor changes create a new unapproved revision while originals remain immutable", async () => {
  const session = await newSession({ ...input, depth: "standard" });
  const savedEditor = process.env.EDITOR;
  const savedVisual = process.env.VISUAL;
  try {
    session.scenarios = [scenario];
    const gap = "Unit coverage unavailable: this feature changes markup only.";
    const validated = validateTests({ tests: [generated], gaps: [gap] }, session);
    session.gaps.push("Revision 1: " + gap);
    const dir = join(session.dir, "revision-1");
    await mkdir(join(dir, "tests/tests"), { recursive: true });
    await writeFile(join(dir, "tests", generated.path), generated.content);
    validated.tests[0]!.approved = true;
    session.revisions.push({
      number: 1,
      dir,
      tests: validated.tests,
      review: "Original review",
      feedback: "",
    });
    const editor = join(session.dir, "fixture-editor.mjs");
    await writeFile(
      editor,
      "import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[2], '// reviewed edit\\n');\n",
    );
    process.env.EDITOR = process.execPath + " " + editor;
    delete process.env.VISUAL;
    const ui = new ScriptedTerminal(["T1", "Clarify the test comment"]);
    try {
      await editRevision(session, ui);
    } finally {
      ui.close();
    }
    assert.equal(session.revisions.length, 2);
    assert.equal(join(session.revisions[1]!.dir, ".."), join(session.dir, "generated-tests"));
    assert.equal(
      await readFile(join(dir, "tests", generated.path), "utf8"),
      generated.content,
    );
    assert.equal(session.revisions[1]!.tests[0]!.approved, false);
    assert.notEqual(
      session.revisions[1]!.tests[0]!.sha256,
      session.revisions[0]!.tests[0]!.sha256,
    );
    assert.equal(session.revisions[1]!.review, "");
    assert(session.gaps.includes("Revision 2: " + gap));
  } finally {
    if (savedEditor === undefined) {
      delete process.env.EDITOR;
    } else {
      process.env.EDITOR = savedEditor;
    }
    if (savedVisual === undefined) {
      delete process.env.VISUAL;
    } else {
      process.env.VISUAL = savedVisual;
    }
    await rm(session.dir, { recursive: true, force: true });
  }
});

class WorkflowTerminal extends ScriptedTerminal {
  stages: string[] = [];
  override warn(text: string): void { this.output.push(text); }
  execute = false;
  assessmentResponse?: unknown;
  override async working<T>(label: string, task: (progress: (text: string) => void) => Promise<T>): Promise<T> {
    this.stages.push(label);
    if (label === "Assessing findings and improvement evidence" && this.assessmentResponse !== undefined) return this.assessmentResponse as T;
    // Exercise workflow transitions without starting a browser in terminal checks.
    if (label === "Executing approved tests" && !this.execute) { return undefined as T; }
    return task(() => {});
  }
}

test("fluid workflow requires explicit repo, bypasses supplied flags, asks four/default or one/flags responses, and retains deep review", async () => {
  const repo = await mkdtemp(join(tmpdir(), "qa-fluid-"));
  const oldPath = process.env.PATH;
  const sessions: string[] = [];
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    await writeFile(join(repo, "index.html"), "<h1>Before</h1>");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await writeFile(join(repo, "value.cjs"), "exports.value = 1;\n");
    await writeFile(join(repo, "existing.test.cjs"), "const test = require('node:test'); const assert = require('node:assert/strict'); test('baseline', () => assert.equal(require('./value.cjs').value, 1));\n");
    git("add", "."); git("commit", "-qm", "baseline");
    git("checkout", "-qb", "feature");
    await writeFile(join(repo, "index.html"), "<h1>After</h1>");
    git("add", "."); git("commit", "-qm", "Show After");
    const bin = join(repo, "fixture-bin");
    await mkdir(bin);
    const fakeCodex = join(bin, "codex");
    await writeFile(fakeCodex, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const prompt = readFileSync(0, 'utf8');
const scenario = {title:'Show After',criteria:['AC1'],kind:'normal',steps:['Open page'],expected:'After appears'};
const test = ${JSON.stringify({ ...generated, content: "import {test,expect} from '@playwright/test'; test('After', async ({page}) => { await page.goto('http://127.0.0.1:3000/'); await expect(page.getByRole('heading')).toHaveText('After'); });" })};
const unit = {...test, id:'T2', path:'tests/unit.test.cjs', kind:'unit', runner:'node', content:"const test = require('node:test'); const assert = require('node:assert/strict'); const { value } = require('../value.cjs'); const { expected } = require('./unit-helper.cjs'); test('value', () => assert.equal(value, expected));", supportIds:['H1']};
const support = {...unit, id:'H1', path:'tests/unit-helper.cjs', kind:'support', scenarioIds:[], content:'exports.expected = 1;', supportIds:[]};
const fallback = prompt.includes('fallback-vitest fixture');
const vitestUnit = {...unit, path:'tests/unit.test.js', runner:'vitest', content:"import {test,expect} from 'vitest'; import {value} from '../value.cjs'; import {expected} from './unit-helper.js'; test('value', () => expect(value).toBe(expected));"};
const vitestSupport = {...support, path:'tests/unit-helper.js', runner:'vitest', content:'export const expected = 1;'};
const candidate = {scenarioIds:['S1'],title:'Clarify confirmation',observed:'The selected flow has no clear next-step instruction.',benefit:'An explicit next step could make the completed action easier to understand.',suggestedChange:'Add a next-step instruction beside the confirmation.',priority:'low',source:['index.html:1'],evidence:[]};
const advisory = prompt.includes('advisory fixture');
let result;
if (schema.properties.scenarios) result = {summary:'Changed heading',conflicts:[],gaps:[],scenarios:prompt.includes('untestable fixture') ? [] : [scenario],improvements:advisory ? [candidate, ...(prompt.includes('malformed fixture') ? [{...candidate,scenarioIds:['S999']},{...candidate,source:['unknown.ts:1']}] : [])] : []};
else if (schema.properties.flows) result = {flows:[{scenarioId:'S1',status:'observed',steps:['Open page'],observed:'After appears; getByRole heading observed',evidence:[]}],gaps:[],improvements:advisory ? [{...candidate,evidence:['flow:S1']}, ...(prompt.includes('malformed fixture') ? [{...candidate,source:[],evidence:['made-up-screenshot.png']}] : [])] : []};
else if (schema.properties.tests) {
  if (fallback && (!prompt.includes('Available unit runners: vitest') || !prompt.includes('MUST include focused unit tests'))) process.exit(2);
  result = {tests:fallback ? [vitestUnit,vitestSupport] : prompt.includes('unit-only fixture') ? [{...unit,content:prompt.includes('failing-unit fixture') ? unit.content.replace('assert.equal(value, expected)', 'assert.equal(value, 2)') : unit.content},support] : [test,unit,support],gaps:[]};
}
else if (schema.properties.findings) {
  const supplied = JSON.parse(prompt.trim().split('\\n').at(-1));
  const intent = supplied.input.intent;
  if (intent.includes('unavailable fixture')) process.exit(1);
  const assessments = supplied.improvements.map(item => ({id:item.id,assessment:intent.includes('dismissed fixture') ? 'dismissed' : 'supported',assessmentReason:intent.includes('dismissed fixture') ? 'Current behavior is intentional; no benefit is supported.' : 'The structured flow and supplied source support the proposed next-step instruction.'}));
  if (intent.includes('unknown-assessment fixture')) assessments[0].id = 'unknown';
  if (intent.includes('duplicate-assessment fixture')) assessments.push(assessments[0]);
  if (intent.includes('missing-assessment fixture')) assessments.length = 0;
  result = {findings:supplied.findings.map(item => ({id:item.id,suspectedCause:'Hypothesis: value differs from required output.',suggestedFix:'Check the selected value handling.',source:['index.html:1']})), improvements:assessments};
}
else result = {assessment:'Reviewed assertions',issues:[],gaps:[]};
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
`);
    await chmod(fakeCodex, 0o700);
    process.env.PATH = bin + ":" + oldPath;
    const required = new WorkflowTerminal(["cancel"]);
    await assert.rejects(check({ url: input.url, intent: input.intent }, required), /Cancelled/);
    assert.deepEqual(required.prompts, ["Repository path"]);
    const invalid = new WorkflowTerminal([]);
    await assert.rejects(check({ repo: bin, committedOnly: true, local: true }, invalid), /cannot be combined/);
    await assert.rejects(check({ repo: "/not-a-repo" }, new WorkflowTerminal([])), /Git inspection/);
    const before = git("status", "--porcelain");
    for (const withFlags of [false, true]) {
      const ui = new WorkflowTerminal(withFlags ? ["run all"] : [repo, input.url, "Show After", "run all"]);
      const session = await check(withFlags ? { repo, url: input.url, intent: "Show After", committedOnly: true } : {}, ui);
      sessions.push(session.dir);
      assert.equal(ui.prompts.length, withFlags ? 1 : 4, ui.prompts.join("\n"));
      assert.match(ui.prompts.at(-1)!, /^Run all \/ inspect/);
      assert.equal(session.input.depth, "standard");
      assert.equal(session.input.local, !withFlags);
      assert.deepEqual(session.input.criteria, ["Show After"]);
      assert.equal(session.input.base, "main");
      assert.equal(session.assumptions.basis, "assumed");
      assert.equal(session.scenarios[0]!.status, "selected");
      assert(session.feedback.some(item => item.decision === "automatically-selected"));
      assert.equal(ui.stages.length, 4); // analysis, exploration, generation, execution
      assert.equal(session.stage, "complete");
      assert.equal(session.status, "blocked"); // intentionally no execution coverage
      assert.equal(session.exports.length, 0);
      assert(!ui.output.some(text => text.startsWith("--- ")));
      assert(!ui.output.some(text => text.includes("import {test,expect}")));
      const revision = session.revisions.at(-1)!;
      assert.equal(join(revision.dir, ".."), join(session.dir, "generated-tests"));
      assert.deepEqual(revision.tests.map(file => file.kind), ["browser", "unit", "support"]);
      assert.equal(revision.tests.find(file => file.kind === "support")!.runner, "node");
      assert(revision.tests.every(file => file.approved));
      assert(ui.output.includes(`Test files saved automatically: ${join(revision.dir, "tests")}`));
      for (const file of revision.tests) {
        assert.equal(await readFile(join(revision.dir, "tests", file.path), "utf8"), file.content);
      }
      const inspectUi = new WorkflowTerminal(["inspect", "all", "run all"]);
      try {
        assert.equal(await reviewTests(session, inspectUi), "execute");
        assert(inspectUi.output.some(text => text.startsWith("--- ") && text.includes(revision.tests[0]!.content)));
      } finally {
        inspectUi.close();
      }
      const analysisDir = (await readdir(session.dir)).find(name => name.startsWith("analysis-"))!;
      const invocation = JSON.parse(await readFile(join(session.dir, analysisDir, "invocation.json"), "utf8"));
      assert.equal(invocation.reasoningEffort, "medium");
      const report = await readFile(join(session.dir, "report.md"), "utf8");
      assert.match(report, /Review depth: standard/);
      assert.match(report, /Prerequisites \(assumed\)/);
      assert(report.includes(`Test files saved automatically: ${join(revision.dir, "tests")}`));
      session.stage = "execute";
      session.status = "cancelled";
      await saveSession(session);
      const resumedUi = new WorkflowTerminal(["cancel"]);
      const resumed = await check({ session: session.id, deep: true, local: !session.input.local }, resumedUi);
      assert.equal(resumed.status, "cancelled");
      assert.equal(resumed.input.depth, "standard");
      assert.equal(resumed.input.local, session.input.local);
      assert.match(resumedUi.prompts[0]!, /^Run all/);
      assert(!resumedUi.stages.includes("Executing approved tests"));
      const file = session.revisions.at(-1)!.tests[0]!;
      await writeFile(join(session.revisions.at(-1)!.dir, "tests", file.path), file.content + "// altered");
      await assert.rejects(executeRevision(session, new AbortController().signal, () => {}), /Approved files changed/);
      const changedUi = new WorkflowTerminal(["run all"]);
      const changed = await check({ session: session.id }, changedUi);
      assert.equal(changed.status, "blocked");
      assert.match(changed.reason, /changed since review/);
    }
    const deepUi = new WorkflowTerminal(["yes", "yes", "approve", "source", "all", "approve", "all", "yes", "finish"]);
    const deep = await check({ repo, url: input.url, intent: "Show After", deep: true, local: false }, deepUi);
    sessions.push(deep.dir);
    assert.equal(deep.input.depth, "deep");
    assert(deepUi.prompts.some(text => text.startsWith("Plan:")));
    assert(deepUi.stages.includes("Independently reviewing generated assertions"));
    assert.equal(deep.assumptions.basis, "developer-confirmed");
    const deepAnalysis = (await readdir(deep.dir)).find(name => name.startsWith("analysis-"))!;
    assert.equal(JSON.parse(await readFile(join(deep.dir, deepAnalysis, "invocation.json"), "utf8")).reasoningEffort, "xhigh");
    assert.equal(deep.status, "blocked");
    assert.equal(deepUi.prompts.at(-1), "Results: finish / revise-tests / revise-plan / rerun");
    assert.equal(deepUi.prompts.some((prompt) => prompt.includes("Export selected approved tests")), false);
    const revision = deep.revisions.at(-1)!;
    assert.equal(
      await readFile(join(revision.dir, "tests", revision.tests[0]!.path), "utf8"),
      revision.tests[0]!.content,
    );
    deep.input.intent = "advisory fixture unavailable fixture";
    deep.improvements = [{ id: "I-deep", scenarioIds: ["S1"], title: "Clarify confirmation", observed: "No next-step instruction appears.", benefit: "An instruction could clarify the next step.", suggestedChange: "Add a next-step instruction.", priority: "low", source: ["index.html:1"], evidence: [], assessment: "pending", assessmentReason: "Pending assessment." }];
    deep.stage = "findings";
    await saveSession(deep);
    const deepFailureUi = new WorkflowTerminal(["no", "finish"]);
    const deepFailure = await check({ session: deep.id }, deepFailureUi);
    assert.equal(deepFailure.improvements[0]!.assessment, "unverified");
    assert(deepFailure.gaps.includes("Independent finding assessment incomplete."));
    const limitedUi = new WorkflowTerminal([]);
    const limited = await check({ repo, url: input.url, intent: "untestable fixture", committedOnly: true }, limitedUi);
    sessions.push(limited.dir);
    assert.equal(limited.status, "blocked");
    assert.match(limited.reason, /No testable scenarios/);
    assert.equal(limitedUi.prompts.length, 0);
    const unitUi = new WorkflowTerminal(["run all"]);
    unitUi.execute = true;
    const unitSession = await check({ repo, url: input.url, intent: "unit-only fixture", committedOnly: true }, unitUi);
    sessions.push(unitSession.dir);
    assert.equal(unitSession.status, "passed", unitSession.reason);
    assert.equal(unitUi.prompts.length, 1);
    assert.deepEqual(unitSession.executions.map(run => [run.phase, run.runner, run.status]), [["existing", "node", "passed"], ["generated", "node", "passed"]]);
    assert.equal(coverageGaps(unitSession).length, 0);
    for (const variant of ["supported", "dismissed", "unavailable", "malformed", "unknown-assessment", "duplicate-assessment", "missing-assessment", "failing-unit", "failing-unit unknown-assessment"] ) {
      const advisoryUi = new WorkflowTerminal(["run all"]);
      advisoryUi.execute = true;
      const advisorySession = await check({ repo, url: input.url, intent: `unit-only fixture advisory fixture ${variant.split(" ").map(word => word + " fixture").join(" ")}`, committedOnly: true }, advisoryUi);
      sessions.push(advisorySession.dir);
      assert.equal(advisorySession.status, variant.includes("failing-unit") ? "failed" : "passed", advisorySession.reason);
      assert.equal(sessionExitCode(advisorySession), variant.includes("failing-unit") ? 1 : 0);
      assert.equal(advisoryUi.prompts.length, 1);
      assert.equal(advisorySession.improvements.length, 1, "Exact plan/exploration duplicates merge; malformed references are rejected.");
      const candidate = advisorySession.improvements[0]!;
      assert.equal(candidate.assessment, ["unavailable", "unknown-assessment", "duplicate-assessment", "missing-assessment"].some(value => variant.includes(value)) ? "unverified" : variant === "dismissed" ? "dismissed" : "supported");
      assert.equal(candidate.observed, "The selected flow has no clear next-step instruction.");
      assert(candidate.evidence.some(ref => ref.includes("analysis-") && ref.endsWith("response.json")));
      assert(candidate.evidence.some(ref => ref.includes("exploration-") && ref.endsWith("#flow:S1")));
      assert.equal(advisorySession.gaps.length, 0);
      assert.equal(advisoryUi.stages.filter(label => label === "Assessing findings and improvement evidence").length, 1);
      if (candidate.assessment === "unverified") assert(advisoryUi.output.some(text => text.includes("Evidence assessment incomplete")));
      if (variant.includes("failing-unit")) {
        assert(advisorySession.findings.length > 0);
        assert(advisorySession.findings.every(item => item.observed.length));
        assert(advisorySession.findings.every(item => variant.includes("unknown-assessment") ? item.suspectedCause === "" && item.suggestedFix === "" : item.suspectedCause.startsWith("Hypothesis:")), "Invalid ID mappings must not partially mutate findings.");
      }
      const reopenedUi = new WorkflowTerminal([]);
      const reopened = await check({ session: advisorySession.id }, reopenedUi);
      assert.deepEqual(reopened.improvements, advisorySession.improvements);
      assert.equal(reopenedUi.stages.length, 0, "Reopening complete sessions does not repeat assessment.");
      if (variant === "supported") {
        reopened.improvements.push({ ...candidate, id: "I-new", observed: "A newly inspected state also lacks a next-step instruction.", assessment: "pending", assessmentReason: "New candidate pending assessment." });
        reopened.stage = "findings";
        await saveSession(reopened);
        const reassessmentUi = new WorkflowTerminal([]);
        const reassessed = await check({ session: reopened.id }, reassessmentUi);
        assert.equal(reassessmentUi.prompts.length, 0);
        assert.equal(reassessmentUi.stages.length, 1);
        assert.equal(reassessed.improvements.length, 2);
        assert(reassessed.improvements.every(item => item.assessment === "supported"));
        assert.equal(reassessed.status, "passed");
      }
      const discoveryDir = (await readdir(advisorySession.dir)).find(name => name.startsWith("analysis-"))!;
      const planningPrompt = await readFile(join(advisorySession.dir, discoveryDir, "prompt.txt"), "utf8");
      assert.match(planningPrompt, /Benefits remain inferred until assessed/);
      const assessmentDir = (await readdir(advisorySession.dir)).find(name => name.startsWith("finding-review-"))!;
      const assessmentPrompt = await readFile(join(advisorySession.dir, assessmentDir, "prompt.txt"), "utf8");
      assert.match(assessmentPrompt, /no screenshots are supplied/);
    }
    assert.equal(git("branch", "--show-current"), "feature");
    assert.equal(git("status", "--porcelain"), before);
    await assert.rejects(collectBranch({ repo, base: "HEAD", local: false }), /No reviewable changes/);
    await writeFile(join(repo, "extra.ts"), "export const extra = true;");
    assert((await collectBranch({ repo, base: "HEAD" })).files.some(file => file.path === "extra.ts"));
    git("branch", "-D", "main");
    assert.deepEqual(await baseCandidates(repo), []);
    const missingBaseUi = new WorkflowTerminal(["HEAD", "cancel"]);
    const missingBase = await check({repo, url: input.url, intent: "Show After", local: true}, missingBaseUi);
    sessions.push(missingBase.dir);
    assert.match(missingBaseUi.prompts[0]!, /^Comparison reference/);
    assert.equal(missingBase.input.base, "HEAD");
    // No unit runner, with unrelated tests and a Vite config that must never load.
    git("branch", "main");
    await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module" }));
    await rm(join(repo, "existing.test.cjs"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "tests/unit.test.js.extra.test.js"), "throw new Error('Unselected test executed');\n");
    await writeFile(join(repo, "vite.config.mjs"), "throw new Error('Target Vite config loaded');\n");
    git("add", "."); git("commit", "-qm", "Feature without unit runner");
    for (const value of [1, 2]) {
      if (value === 2) {
        await writeFile(join(repo, "value.cjs"), "exports.value = 2;\n");
        git("add", "value.cjs"); git("commit", "-qm", "Feature regression");
      }
      const targetStatus = git("status", "--porcelain");
      const fallbackUi = new WorkflowTerminal(["run all"]);
      fallbackUi.execute = true;
      const fallbackSession = await check({ repo, url: input.url, intent: "fallback-vitest fixture", committedOnly: true }, fallbackUi);
      sessions.push(fallbackSession.dir);
      assert(fallbackSession.context, fallbackSession.reason);
      assert.deepEqual(fallbackSession.context!.runners, []);
      assert.equal(fallbackUi.prompts.length, 1);
      assert.deepEqual(fallbackSession.executions.map(run => [run.phase, run.runner, run.status]), [["generated", "vitest", value === 1 ? "passed" : "failed"]], JSON.stringify(fallbackSession.executions));
      assert.equal(fallbackSession.status, value === 1 ? "passed" : "failed", fallbackSession.reason);
      assert.equal(fallbackSession.gaps.length, 0);
      assert.equal(git("status", "--porcelain"), targetStatus);
      assert.equal(await readFile(join(repo, "value.cjs"), "utf8"), `exports.value = ${value};\n`);
      for (const file of fallbackSession.revisions.at(-1)!.tests) {
        assert.equal(await readFile(join(fallbackSession.revisions.at(-1)!.dir, "tests", file.path), "utf8"), file.content);
      }
    }
  } finally {
    process.env.PATH = oldPath;
    for (const dir of sessions) { await rm(dir, { recursive: true, force: true }); }
    await rm(repo, { recursive: true, force: true });
  }
});

test("automatic reporting retains partial coverage and exposes only current passing tests without mandatory classification", async () => {
  const session = await newSession({ ...input, depth: "standard", changeType: "bug-fix" });
  try {
    session.scenarios = [{ ...scenario, status: "selected" }];
    session.explorations = [{ scenarioId: "S1", status: "observed", steps: [], observed: "Created Ada", evidence: [] }];
    session.revisions = [{ number: 1, dir: session.dir, tests: validateTests({ tests: [generated], gaps: [] }, session).tests.map(item => ({ ...item, approved: true })), review: "", feedback: "" }];
    const run = { id: "run-1", revision: 1, phase: "generated" as const, runner: "playwright", testIds: ["T1"], files: [], status: "passed" as const, artifacts: session.dir, reason: "", startedAt: new Date().toISOString() };
    for (const expected of ["passed", "failed", "partial", "blocked"] as const) {
      session.stage = "findings";
      session.executions = [{ ...run, status: expected === "partial" ? "passed" : expected }];
      session.explorations[0]!.status = expected === "partial" ? "incomplete" : "observed";
      session.findings = expected === "failed" ? [{ id: "F1", executionId: run.id, scenarioIds: ["S1"], category: "observed-failure", observed: "Wrong confirmation", suspectedCause: "", suggestedFix: "", source: [], evidence: [] }] : [];
      // A developer classification is retained as feedback, never erasing failed execution.
      if (expected === "failed") { feedback(session, "F1", "intended", "Fixture classification"); }
      await saveSession(session);
      const ui = new WorkflowTerminal([]);
      ui.assessmentResponse = { findings: session.findings.map((item) => ({ id: item.id, suspectedCause: "Hypothesis: confirmation content differs.", suggestedFix: "Check the confirmation rendering.", source: [] })), improvements: [] };
      const result = await check({ session: session.id }, ui);
      assert.equal(result.status, expected);
      assert.equal(result.stage, "complete");
      assert.equal(ui.prompts.length, 0);
      assert.equal(result.findings.length, session.findings.length);
      assert.equal(sessionExitCode(result), expected === "passed" ? 0 : expected === "failed" ? 1 : 2);
      assert.deepEqual(passingTests(result).map(test => test.id), expected === "passed" || expected === "partial" ? ["T1"] : []);
      if (expected === "partial") {
        assert.deepEqual(coverageGaps(result), ["S1: exploration incomplete"]);
        const report = await readFile(join(session.dir, "report.md"), "utf8");
        assert.match(report, /Status: \*\*partial\*\*/);
        assert.match(report, /T1: tests\/create.spec.ts/);
        assert.match(report, new RegExp(`export --session ${session.id}`));
        assert.match(report, /S1: exploration incomplete/);
      }
    }

    session.explorations[0]!.status = "observed";
    session.executions = [run, { ...run, id: "rerun", status: "blocked" }];
    assert.deepEqual(passingTests(session), []); // old success cannot mask an incomplete rerun
    assert.deepEqual(coverageGaps(session), ["S1: no passing approved test"]);
    session.executions = [{ ...run, revision: 0 }];
    assert.deepEqual(passingTests(session), []); // old revisions cannot supply current coverage
    session.executions = [run];
    session.revisions[0]!.tests[0]!.approved = false;
    assert.deepEqual(passingTests(session), []);
    session.revisions[0]!.tests[0]!.approved = true;

    // A runner can have usable passing files while other files are blocked or failed.
    for (const status of ["blocked", "failed"] as const) {
      session.executions = [{ ...run, status, checks: [{ testId: "T1", status: "passed" }] }];
      await saveSession(session);
      const result = await check({ session: session.id }, new WorkflowTerminal([]));
      assert.equal(result.status, status === "failed" ? "failed" : "partial");
      assert.deepEqual(passingTests(result).map(test => test.id), ["T1"]);
    }

    session.executions = [run];
    session.gaps = ["AC1: some selected behavior remains uncovered."];
    await saveSession(session);
    const result = await check({ session: session.id }, new WorkflowTerminal([]));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.gaps, session.gaps);
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});
