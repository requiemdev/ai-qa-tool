import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { check } from "../src/workflow.js";
import { Terminal } from "../src/interactive.js";
import {
  root,
  loadSession,
  sha256,
  saveSession,
  sessionExitCode,
} from "../src/session.js";
import { executeRevision } from "../src/execution.js";

class FixtureReview extends Terminal {
  prompts: string[] = [];
  stages: { label: string; elapsedMs: number }[] = [];
  constructor() {
    super(new PassThrough());
  }
  override async working<T>(label: string, task: (progress: (text: string) => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    try { return await super.working(label, task); }
    finally { this.stages.push({ label, elapsedMs: Date.now() - started }); }
  }
  private sourceShown = false;
  private sessionId = "";
  private selectedExport = "";
  private revisedPlan = false;
  override show(text: string): void {
    console.log(text);
    const id = /Session[:\s]+(?:\u001b\[\d+m)?(session-[\w-]+)/.exec(text)?.[1];
    if (id) {
      this.sessionId = id;
    }
    if (text.startsWith("--- ")) {
      assert.match(text, /(?:expect\(|assert\.)/);
      this.sourceShown = true;
    }
  }
  override async ask(prompt: string, fallback = ""): Promise<string> {
    this.prompts.push(prompt);
    console.log("FIXTURE REVIEW: " + prompt);
    if (prompt.startsWith("Run all")) {
      const session = await loadSession(this.sessionId);
      for (const file of session.revisions.at(-1)!.tests) {
        assert.equal(await readFile(join(session.revisions.at(-1)!.dir, "tests", file.path), "utf8"), file.content);
        assert.equal(sha256(file.content), file.sha256);
        if (file.kind !== "support") assert.match(file.content, /(?:expect\(|assert\.)/);
      }
      return "run all";
    }
    if (
      prompt.startsWith("Repository") ||
      prompt.startsWith("Running localhost") ||
      prompt.startsWith("Feature/bug")
    ) {
      return fallback;
    }
    if (prompt.startsWith("Plan:")) {
      const session = await loadSession(this.sessionId);
      const inferredFocus = session.scenarios.find(
        (item) =>
          item.id === "S3" &&
          /remain within|focus enters/i.test(item.steps.join(" ")) &&
          item.status !== "excluded",
      );
      return inferredFocus ? "exclude" : "approve";
    }
    if (prompt.startsWith("Scenario ID")) {
      return "S3";
    }
    if (prompt.startsWith("Reason for the revision")) {
      return "Strict focus confinement through browser chrome is not an acceptance criterion; keyboard submission remains covered by S2 and S5.";
    }
    if (prompt.startsWith("Tests:")) {
      return this.sourceShown ? "approve" : "source";
    }
    if (prompt.startsWith("Test ID")) {
      return "all";
    }
    if (prompt.startsWith("IDs to approve")) {
      assert(this.sourceShown);
      return "all";
    }
    if (prompt.startsWith("Clarify")) {
      return "Acceptance criteria define intended behavior; retain explicit expectations.";
    }
    if (prompt.startsWith("Classify:")) {
      return "unresolved";
    }
    if (prompt.startsWith("Reason/evidence")) {
      return "Fixture retains original results for investigation.";
    }
    if (prompt.startsWith("Scope exclusion reason")) {
      return "Outside the explicitly approved dialog and formatting scope.";
    }
    if (prompt.startsWith("Results:")) {
      if (process.env.AGENT_QA_RESUME_SESSION && !this.revisedPlan) {
        this.revisedPlan = true;
        this.sourceShown = false;
        return "revise-plan";
      }
      return "finish";
    }
    if (prompt.startsWith("Select test IDs")) {
      const session = await loadSession(this.sessionId);
      const selected = session.revisions
        .at(-1)!
        .tests.find((item) => item.approved && item.kind === "browser")!;
      assert(selected);
      this.selectedExport = selected.id;
      return this.selectedExport;
    }
    if (prompt.startsWith("Choose an unused destination")) {
      return "test/accepted-" + Date.now() + ".spec.ts";
    }
    if (
      prompt.startsWith("Destination repository") ||
      prompt.startsWith("Destination path")
    ) {
      return fallback;
    }
    if (prompt.includes("(yes/no)")) {
      return "yes";
    }
    throw new Error("Unexpected fixture review prompt: " + prompt);
  }
}

test(
  "live Codex normal session discovers an improvement alongside working flow and reproducible failure",
  { timeout: 1_200_000 },
  async () => {
    const previous = process.env.AGENT_QA_RESUME_SESSION
      ? await loadSession(process.env.AGENT_QA_RESUME_SESSION)
      : undefined;
    const repo =
      previous?.input.repo ??
      join(root, ".agent-qa", "live-fixture-" + Date.now());
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    if (!previous) {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
      );
      await writeFile(
        join(repo, "format.cjs"),
        "exports.formatResult = name => `Created ${name}`;\n",
      );
      await writeFile(
        join(repo, "format.test.cjs"),
        "const test = require('node:test'); const assert = require('node:assert/strict'); const {formatResult} = require('./format.cjs'); test('format confirmation', () => assert.equal(formatResult('Ada'), 'Created Ada'));\n",
      );
      await writeFile(join(repo, "index.html"), "<h1>Items</h1>");
      git("init", "-q", "-b", "main");
      git("config", "user.name", "QA fixture");
      git("config", "user.email", "fixture@example.test");
      git("add", ".");
      git("commit", "-qm", "baseline");
      git("checkout", "-qb", "create-item");
    }
    const html = `<h1>Items</h1>
<button onclick="document.querySelector('dialog').showModal()">Create item</button>
<dialog aria-label="Create item" style="width:1100px;max-width:none">
<form onsubmit="event.preventDefault(); document.querySelector('output').textContent='Created '+document.querySelector('input').value; document.querySelector('dialog').close()">
<label>Name<input></label><button>Create</button>
</form></dialog>
<output aria-label="Result"></output>`;
    if (!previous) {
      await writeFile(join(repo, "index.html"), html);
      git("add", ".");
      git(
        "commit",
        "-qm",
        "Create item dialog and post-submit confirmation",
      );
    }
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    });
    server.listen(
      previous ? Number(new URL(previous.input.url).port) : 0,
      "127.0.0.1",
    );
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
      const ui = new FixtureReview();
      const started = Date.now();
      const deep = process.env.AGENT_QA_DEEP === "1";
      const session = await check(
        previous
          ? { session: previous.id }
          : {
              repo,
              deep,
              headless: true,
              base: "main",
              local: false,
              url: `http://127.0.0.1:${address.port}/`,
              intent:
                "Create item opens a dialog with required Name. Entering Ada and clicking Create closes the dialog and shows Created Ada. Empty submission must keep the dialog open and not create a result. Use Ada only and no backend services.",
              criteria: [
                "Create item opens the named dialog; submitting Name Ada closes it and displays Created Ada.",
                "Empty required Name blocks submission and keeps the dialog open.",
                ...(deep ? ['formatResult("Ada") returns "Created Ada".'] : []),
              ],
              changeType: "feature",
              timeout: 600_000,
            },
        ui,
      );
      assert.equal(session.status, "failed", session.reason + "\n" + JSON.stringify(session.executions));
      assert.equal(sessionExitCode(session), 1);
      assert(session.improvements.some((item) => item.assessment === "supported"), JSON.stringify(session.improvements));
      assert(session.findings.some((item) => item.category === "observed-failure"));
      assert(session.executions.some((run) => run.checks?.some((check) => check.status === "passed")), "Working flow retains a passing generated check.");
      assert(session.explorations.some((item) => item.status === "observed"));
      if (deep || (previous && previous.input.depth !== "standard")) {
        assert(ui.prompts.some((prompt) => prompt.startsWith("Tests:")));
        assert.equal(session.exports.length, 0);
      } else {
        assert.equal(ui.prompts.length, 1, ui.prompts.join("\n"));
        assert.equal(session.exports.length, 0);
      }
      const invocations = (await readdir(session.dir, {recursive: true})).filter(path => path.endsWith("invocation.json"));
      const metrics = { depth: session.input.depth ?? "deep (legacy)", promptCount: ui.prompts.length, aiStageCount: invocations.length, stages: ui.stages, elapsedMs: Date.now() - started, totalWithReplayMs: 0, session: session.id };
      if (!deep && !previous) { assert(metrics.aiStageCount >= 4, "Discovery plus conditional assessment; any generation retries are retained."); }
      await writeFile(join(session.dir, "live-metrics.json"), JSON.stringify(metrics, null, 2));
      console.log("LIVE METRICS: " + JSON.stringify(metrics));
      const explorationDir = (await readdir(session.dir)).find((path) =>
        path.startsWith("exploration-"),
      )!;
      const evidence = await readdir(join(session.dir, explorationDir), {
        recursive: true,
      });
      assert(evidence.some((path) => path.endsWith(".png")));
      assert(evidence.some((path) => path.endsWith(".trace")));
      const revision = session.revisions.at(-1)!;
      const hashes = revision.tests.map((item) => item.sha256);
      // Replay the same application failure with unchanged approved assertions.
      await executeRevision(session, new AbortController().signal, console.log);
      assert.equal(
        session.executions
          .filter((item) => item.runner === "playwright")
          .at(-1)!.status,
        "failed",
      );
      assert.deepEqual(
        revision.tests.map((item) => item.sha256),
        hashes,
      );
      for (const item of revision.tests) {
        assert.equal(
          sha256(
            await readFile(join(revision.dir, "tests", item.path), "utf8"),
          ),
          item.sha256,
        );
      }
      const failed = session.executions
        .filter((item) => item.runner === "playwright")
        .at(-1)!;
      const failureEvidence = await readdir(failed.artifacts, {
        recursive: true,
      });
      assert(failureEvidence.some((path) => path.endsWith("trace.zip")));
      assert(failureEvidence.some((path) => path.endsWith(".png")));
      session.status = "failed";
      session.reason = "Missing required Name validation reproduced with unchanged approved assertions; the working create flow and supported improvements are retained.";
      await saveSession(session);
      const report = await readFile(join(session.dir, "report.md"), "utf8");
      assert.match(report, /Observed failures/);
      assert.match(report, /Potential improvements/);
      assert.match(report, /Passing checks available for reuse/);
      const reopened = await check({ session: session.id }, new FixtureReview());
      assert.deepEqual(reopened.improvements, session.improvements);
      assert.equal((await readdir(session.dir, { recursive: true })).filter(path => path.endsWith("invocation.json")).length, invocations.length);
      metrics.totalWithReplayMs = Date.now() - started;
      await writeFile(join(session.dir, "live-metrics.json"), JSON.stringify(metrics, null, 2));
      console.log(`LIVE SESSION EVIDENCE: ${session.dir}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
