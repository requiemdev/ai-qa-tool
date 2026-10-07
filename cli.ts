#!/usr/bin/env node
/**
 * @file cli.ts
 * Command-line interface entry point for agent-qa.
 * Parses CLI arguments, configures session options, runs the main workflow,
 * and formats the final exit code and console output.
 */

import { parseArgs } from "node:util";
import pc from "picocolors";
import { join } from "node:path";
import { check, exportSession } from "./src/workflow.js";
import { sessionExitCode, passingTests } from "./src/session.js";

const help = `agent-qa [check] [--repo <path>] [--base <ref>] [--url <localhost URL>] [--intent <description>]
  [--criteria <criterion> ...] [--change-type feature|bug-fix] [--include-local | --committed-only] [--deep] [--context <file> ...]
  [--model <Codex model override>] [--timeout <milliseconds>] [--headless]
agent-qa review --session <id>
agent-qa export --session <id>
agent-qa check --session <id>
Default: select repo → URL and intent → analyse/explore → generate → approve and run → report.
--deep adds detailed scenario review and independent review.
Ctrl-C or cancel retains partial results. Artifacts: .agent-qa/session-*/.

`;

/**
 * Main command-line handler.
 * Dispatches CLI invocations to check, review, or export actions.
 */
async function main(): Promise<void> {
  const first = process.argv[2];
  if (first === "--help" || first === "-h") {
    console.log(help);
    return;
  }
  const cmd = !first || first.startsWith("--") ? "check" : first;
  if (["check", "review", "export"].includes(cmd)) {
    const { values } = parseArgs({
      args: process.argv.slice(!first || first.startsWith("--") ? 2 : 3),
      options: {
        repo: { type: "string" },
        url: { type: "string" },
        intent: { type: "string" },
        base: { type: "string" },
        criteria: { type: "string", multiple: true },
        "change-type": { type: "string" },
        "include-local": { type: "boolean" },
        "committed-only": { type: "boolean" },
        deep: { type: "boolean" },
        context: { type: "string", multiple: true },
        session: { type: "string" },
        model: { type: "string" },
        timeout: { type: "string" },
        headless: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(help);
      return;
    }
    if ((cmd === "review" || cmd === "export") && !values.session) {
      throw new Error("--session is required.");
    }
    if (cmd === "export") {
      await exportSession(values.session!);
      return;
    }
    const result = await check({
      followup: cmd === "review",
      ...(values.repo ? { repo: values.repo } : {}),
      ...(values.url ? { url: values.url } : {}),
      ...(values.intent ? { intent: values.intent } : {}),
      ...(values.base ? { base: values.base } : {}),
      ...(values.criteria ? { criteria: values.criteria } : {}),
      ...(values["change-type"] ? { changeType: values["change-type"] } : {}),
      ...(values["include-local"] !== undefined
        ? { local: values["include-local"] }
        : {}),
      ...(values["committed-only"] !== undefined ? { committedOnly: values["committed-only"] } : {}),
      ...(values.deep !== undefined ? { deep: values.deep } : {}),
      ...(values.context ? { context: values.context } : {}),
      ...(values.session ? { session: values.session } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.timeout ? { timeout: Number(values.timeout) } : {}),
      ...(values.headless !== undefined ? { headless: values.headless } : {}),
    });
    let paint = pc.yellow;
    if (result.status === "passed") {
      paint = pc.green;
    } else if (result.status === "failed") {
      paint = pc.red;
    }
    console.log(
      `\n${paint(pc.bold(result.status.toUpperCase()))}  ${result.dir}\n${pc.dim("Report:")} ${result.dir}/report.md`,
    );
    console.log(result.reason);
    const revision = result.revisions.at(-1);
    if (revision) {
      console.log(`Test files saved automatically: ${join(revision.dir, "tests")}`);
    }
    const passed = passingTests(result);
    if (passed.length) {
      console.log(`Passing tests available: ${passed.map((test) => test.id).join(", ")}`);
    }
    process.exitCode = sessionExitCode(result);
    return;
  }
  throw new Error(`Unknown command: ${cmd}\n${help}`);
}

main().catch((error) => {
  console.error(
    pc.red("✖ ") + (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 2;
});
