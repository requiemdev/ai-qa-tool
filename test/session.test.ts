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
} from "../src/session.js";
import { validateSchema, planSchema, validateTests } from "../src/stages.js";
import { executeRevision, resultStatus, selectSupport, fileStatus } from "../src/execution.js";
import {
  reviewScenarios,
  reviewTests,
  exportTests,
  editRevision,
  Terminal,
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

test("standard browser validation accepts delegated Playwright support assertions", async () => {
  const session = await newSession({ ...input, depth: "standard" });
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
      runner: "node",
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

class WorkflowTerminal extends ScriptedTerminal {
  stages: string[] = [];
  override async working<T>(label: string, task: (progress: (text: string) => void) => Promise<T>): Promise<T> {
    this.stages.push(label);
    // Exercise workflow transitions without starting a browser in terminal checks.
    if (label === "Executing approved tests") { return undefined as T; }
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
let result;
if (schema.properties.scenarios) result = {summary:'Changed heading',conflicts:[],gaps:[],scenarios:prompt.includes('unit-only fixture') ? [] : [scenario]};
else if (schema.properties.flows) result = {flows:[{scenarioId:'S1',status:'observed',steps:['Open page'],observed:'After appears; getByRole heading observed',evidence:[]}],gaps:[]};
else if (schema.properties.tests) result = {tests:[test],gaps:[]};
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
    const limitedUi = new WorkflowTerminal([]);
    const limited = await check({ repo, url: input.url, intent: "unit-only fixture", committedOnly: true }, limitedUi);
    sessions.push(limited.dir);
    assert.equal(limited.status, "blocked");
    assert.match(limited.reason, /No browser-verifiable.*--deep/);
    assert.equal(limitedUi.prompts.length, 0);
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
  } finally {
    process.env.PATH = oldPath;
    for (const dir of sessions) { await rm(dir, { recursive: true, force: true }); }
    await rm(repo, { recursive: true, force: true });
  }
});

test("automatic reporting retains partial coverage and exposes only current passing tests without mandatory classification", async () => {
  const session = await newSession({ ...input, depth: "standard" });
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
