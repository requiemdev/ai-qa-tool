import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
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
} from "../src/branch.js";
import {
  newSession,
  saveSession,
  loadSession,
  feedback,
  coverageGaps,
  sessionExitCode,
  sha256,
  containedPath,
} from "../src/session.js";
import { validateSchema, planSchema, validateTests } from "../src/stages.js";
import { resultStatus, selectSupport, fileStatus } from "../src/execution.js";
import {
  reviewScenarios,
  reviewTests,
  exportTests,
  editRevision,
  Terminal,
} from "../src/interactive.js";
import { check } from "../src/workflow.js";

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
  constructor(private answers: string[]) {
    super(new PassThrough());
  }
  override show(text: string): void {
    this.output.push(text);
  }
  override async ask(_text: string, fallback = ""): Promise<string> {
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

test("committed branch selection excludes dirty imports and includes HTML/config/renames/deletes; ambiguous bases require a choice", async () => {
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
    const branch = await collectBranch({ repo, base: "main" });
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
    const local = await collectBranch({ repo, base: "main", local: true });
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
    } finally {
      await rm(frozenDir, { recursive: true, force: true });
    }
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.deepEqual(await baseCandidates(repo), ["origin/main"]);
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

test("export requires selected approved files, includes support, previews collisions and protects symlink escapes", async () => {
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
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(session.dir, { recursive: true, force: true });
  }
});

test("editor changes create a new unapproved revision while originals remain immutable", async () => {
  const session = await newSession(input);
  const savedEditor = process.env.EDITOR;
  const savedVisual = process.env.VISUAL;
  try {
    session.scenarios = [scenario];
    const validated = validateTests({ tests: [generated], gaps: [] }, session);
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
