import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { collectBranch } from "../src/branch.js";
import { newSession, saveSession, root, sha256 } from "../src/session.js";
import { executeRevision } from "../src/execution.js";
import { validateTests } from "../src/stages.js";
import { invokeCodex } from "../src/codex.js";
import { testsSchema } from "../src/stages.js";

for (const kind of ["node", "vitest", "jest"] as const) {
  test(
    `${kind}: snapshot baseline failure stays distinct; reviewed generated tests pass and regression fails`,
    { timeout: 300_000 },
    async () => {
      const repo = join(
        root,
        ".agent-qa",
        `runner-fixture-${kind}-${Date.now()}`,
      );
      await mkdir(repo, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
      const dependencies = join(
        root,
        ".agent-qa",
        "fixture-dependencies",
        "node_modules",
      );
      if (kind !== "node") {
        await symlink(dependencies, join(repo, "node_modules"));
      }
      const extension = kind === "vitest" ? "js" : "cjs";
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          ...(kind === "vitest" ? { type: "module" } : {}),
          scripts: { test: kind === "node" ? "node --test" : kind },
          devDependencies:
            kind === "node"
              ? {}
              : { [kind]: kind === "vitest" ? "4.1.0" : "30.2.0" },
        }),
      );
      const source =
        kind === "vitest"
          ? "export const formatResult = name => `Created ${name}`;\n"
          : "exports.formatResult = name => `Created ${name}`;\n";
      await writeFile(join(repo, "format." + extension), source);
      const imports =
        kind === "vitest"
          ? "import { test, expect } from 'vitest'; import { formatResult } from './format.js';"
          : kind === "jest"
            ? "const { formatResult } = require('./format.cjs');"
            : "const test = require('node:test'); const assert = require('node:assert/strict'); const { formatResult } = require('./format.cjs');";
      const assertion =
        kind === "node"
          ? "assert.equal(formatResult('Ada'), 'BROKEN baseline')"
          : "expect(formatResult('Ada')).toBe('BROKEN baseline')";
      await writeFile(
        join(repo, "format.existing.test." + extension),
        imports + `\ntest('pre-existing failure', () => { ${assertion}; });\n`,
      );
      await writeFile(join(repo, ".gitignore"), "node_modules\n");
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      git("add", ".");
      git("commit", "-qm", "baseline");
      git("checkout", "-qb", "feature");
      await writeFile(
        join(repo, "format." + extension),
        source + "// Feature formats confirmation.\n",
      );
      git("add", ".");
      git("commit", "-qm", "Format confirmation");
      const session = await newSession({
        depth: "standard",
        repo,
        url: "http://127.0.0.1:1/",
        intent: "formatResult(name) returns Created followed by the exact name",
        criteria: ['formatResult("Ada") returns "Created Ada"'],
        changeType: "feature",
        base: "main",
        local: false,
        context: [],
        timeout: 30_000,
        headless: true,
      });
      session.context = await collectBranch({ repo, base: "main" });
      session.scenarios = [
        {
          id: "S1",
          title: "Format name",
          criteria: ["AC1"],
          kind: "normal",
          steps: ['Call formatResult("Ada")'],
          expected: "Created Ada",
          status: "approved",
          reason: "",
        },
      ];
      const content =
        imports.replace("'./format.", "'../format.") +
        `\ntest('formats confirmation', () => { ${assertion.replace("BROKEN baseline", "Created Ada")}; });\n`;
      let response: unknown = {
        tests: [
          {
            id: "T1",
            path: "test/generated.test." + extension,
            kind: "unit",
            runner: kind,
            scenarioIds: ["S1"],
            purpose: "Format confirmation",
            expected: "Created Ada",
            content,
            supportIds: [],
          },
        ],
        gaps: [],
      };
      if (process.env.AGENT_QA_LIVE === "1") {
        response = await invokeCodex({
          dir: join(session.dir, "generation"),
          role: "test-automator",
          schema: testsSchema,
          timeout: 180_000,
          prompt: `Generate ONLY unit/integration tests with runner ${kind} for S1: formatResult("Ada") MUST return "Created Ada". Use exactly the supplied ${extension} setup and relative source imports. Do not create browser tests. The existing failure is intentional fixture data, do not copy its broken expectation.\n${JSON.stringify(session.context)}`,
        });
      }
      const generated = validateTests(response, session);
      assert(
        generated.tests.some(
          (item) => item.kind === "unit" || item.kind === "integration",
        ),
      );
      const dir = join(session.dir, "generated-tests", "revision-1");
      for (const item of generated.tests) {
        item.approved = true;
        const path = join(dir, "tests", item.path);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, item.content);
      }
      session.revisions.push({
        number: 1,
        dir,
        tests: generated.tests,
        review: "Fixture assertions inspected before execution.",
        feedback: "",
      });
      const before = git("status", "--porcelain");
      await executeRevision(session, new AbortController().signal, console.log);
      assert.equal(
        session.executions.find((item) => item.phase === "existing")!.status,
        "failed",
        JSON.stringify(session.executions),
      );
      assert.equal(
        session.executions.find((item) => item.phase === "generated")!.status,
        "passed",
        JSON.stringify(session.executions),
      );
      assert.equal(git("status", "--porcelain"), before);
      assert.equal(
        await readFile(join(repo, "format." + extension), "utf8"),
        source + "// Feature formats confirmation.\n",
      );
      for (const item of session.revisions[0]!.tests) {
        assert.equal(
          sha256(await readFile(join(dir, "tests", item.path), "utf8")),
          item.sha256,
        );
      }
      const committed = session.context.head;
      await writeFile(
        join(repo, "format." + extension),
        source.replace("Created", "REGRESSION"),
      );
      git("add", ".");
      git("commit", "-qm", "Deliberate regression");
      session.context = await collectBranch({ repo, base: "main" });
      await executeRevision(session, new AbortController().signal, console.log);
      assert.equal(
        session.executions.filter((item) => item.phase === "generated").at(-1)!
          .status,
        "failed",
      );
      assert.notEqual(session.context.head, committed);
      assert(
        session.findings.some((item) => item.observed.includes("Pre-existing")),
      );
      await saveSession(session);
      console.log(`${kind.toUpperCase()} EVIDENCE: ${session.dir}`);
    },
  );
}
