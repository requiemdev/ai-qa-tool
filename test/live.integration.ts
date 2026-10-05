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
  constructor() {
    super(new PassThrough());
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
      assert(this.sourceShown);
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
  "live Codex fluid session records prompt/stage/time metrics and detects unchanged-assertion regression",
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
    const html = `<h1>Items</h1><button onclick="document.querySelector('dialog').showModal()">Create item</button><dialog aria-label="Create item"><form onsubmit="event.preventDefault(); document.querySelector('output').textContent='Created '+document.querySelector('input').value; document.querySelector('dialog').close()"><label>Name<input required></label><button>Create</button></form></dialog><output aria-label="Result"></output>`;
    if (!previous) {
      await writeFile(join(repo, "index.html"), html);
      git("add", ".");
      git(
        "commit",
        "-qm",
        "Create item dialog with required Name and post-submit confirmation",
      );
    }
    let regression = false;
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        regression
          ? html.replace("textContent='Created '", "textContent='REGRESSION '")
          : html,
      );
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
      assert.equal(
        session.status,
        "passed",
        session.reason + "\n" + JSON.stringify(session.executions),
      );
      assert.equal(sessionExitCode(session), 0);
      assert(session.explorations.some((item) => item.status === "observed"));
      if (deep || (previous && previous.input.depth !== "standard")) {
        assert(session.exports.length > 0);
      } else {
        assert.equal(ui.prompts.length, 1, ui.prompts.join("\n"));
        assert.equal(session.exports.length, 0);
      }
      const invocations = (await readdir(session.dir, {recursive: true})).filter(path => path.endsWith("invocation.json"));
      const metrics = { depth: session.input.depth ?? "deep (legacy)", promptCount: ui.prompts.length, aiStageCount: invocations.length, elapsedMs: Date.now() - started, session: session.id };
      if (!deep && !previous) { assert.equal(metrics.aiStageCount, 3); }
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
      regression = true;
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
      session.reason = "Deliberate fixture regression failed with unchanged approved assertions; the original passing run is retained.";
      await saveSession(session);
      console.log(`LIVE SESSION EVIDENCE: ${session.dir}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
