/**
 * @file interactive.ts
 * Architectural Pipeline Stage: Developer Interaction and Human-in-the-Loop Review.
 *
 * Coordination with pipeline:
 * 1. Coordinates with `workflow.ts` across multiple transition checkpoints:
 *    - After `stages.analyse`: developers review, tweak, or exclude scenarios via `reviewScenarios`.
 *    - After `stages.generate`: developers inspect, approve, edit, or reject tests via `reviewTests`.
 *    - In `editRevision`: opens external editors to safely create immutable new revisions.
 *    - After `execution.executeRevision`: developers classify observed findings via `reviewFindings`.
 *    - Upon workflow completion: facilitates safe export of approved tests via `exportTests`.
 * 2. Employs `Terminal` to provide responsive UI prompts, handle cancellation signals
 *    gracefully (Ctrl-C / cancel), and display non-scrolling progress spinners.
 */

import { createInterface, type Interface } from "node:readline";
import ora from "ora";
import pc from "picocolors";
import { type Readable } from "node:stream";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { safeRelative } from "./branch.js";
import {
  feedback,
  isDeep,
  saveSession,
  sha256,
  containedPath,
} from "./session.js";
import type { Session, Scenario } from "./session-types.js";
import { selectSupport } from "./execution.js";
import { validateTests } from "./stages.js";

const exec = promisify(execFile);

/**
 * Interactive terminal manager handling text prompts, formatted output,
 * spinners, and keyboard interrupt (SIGINT/abort) propagation.
 */
export class Terminal {
  private lines: Interface;
  private iterator: AsyncIterator<string>;
  readonly controller = new AbortController();
  private interrupt = () => {
    this.controller.abort();
    this.lines.close();
  };

  /**
   * Constructs a new Terminal instance wrapping a readable input stream.
   *
   * @param input - Input readable stream (defaults to process.stdin).
   */
  constructor(input: Readable = process.stdin) {
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.lines.on("SIGINT", this.interrupt);
    this.lines.on("close", () => this.controller.abort());
    process.on("SIGINT", this.interrupt);
  }

  /**
   * Prints plain text to standard output.
   *
   * @param text - Message to print.
   */
  show(text: string): void {
    console.log(text);
  }

  /**
   * Prints a highlighted title heading with a divider rule above it.
   *
   * @param title - Section header title text.
   */
  section(title: string): void {
    const width = Math.min(process.stdout.columns || 80, 80);
    console.log(
      "\n" + pc.dim("─".repeat(width)) + "\n" + pc.bold(pc.cyan(title)),
    );
  }

  /**
   * Prints a dimmed informational message.
   *
   * @param text - Information message text.
   */
  info(text: string): void {
    console.log(pc.dim(text));
  }

  /**
   * Prints a green success message prefixed with a check mark.
   *
   * @param text - Success message text.
   */
  success(text: string): void {
    console.log(pc.green("✔ ") + text);
  }

  /**
   * Prints a yellow warning message prefixed with a warning symbol.
   *
   * @param text - Warning message text.
   */
  warn(text: string): void {
    console.log(pc.yellow("⚠ ") + text);
  }

  /**
   * Prints a red error message prefixed with an error symbol.
   *
   * @param text - Error message text.
   */
  error(text: string): void {
    console.log(pc.red("✖ ") + text);
  }

  /**
   * Runs an asynchronous task with an active Ora spinner, dynamically updating
   * progress without spamming scrollable terminal output.
   *
   * @param label - Initial spinner label text.
   * @param task - Async task taking a progress reporter callback.
   * @returns Result of the task promise.
   */
  async working<T>(
    label: string,
    task: (progress: (text: string) => void) => Promise<T>,
  ): Promise<T> {
    const spinner = ora({
      text: label,
      color: "cyan",
      discardStdin: false,
    }).start();
    const started = Date.now();
    let detail = "";
    const render = () => {
      spinner.text = `${label} ${pc.dim(`(${Math.round((Date.now() - started) / 1000)}s)`)}${detail ? pc.dim(" · " + detail) : ""}`;
    };
    const tick = setInterval(render, 1000);
    const progress = (text: string) => {
      detail = text
        .replace(/\s+/g, " ")
        .trim()
        .slice(
          0,
          Math.max(20, (process.stdout.columns || 80) - label.length - 16),
        );
      render();
    };
    const suffix = () =>
      pc.dim(`(${Math.round((Date.now() - started) / 1000)}s)`);
    try {
      const result = await task(progress);
      clearInterval(tick);
      spinner.succeed(`${label} ${suffix()}`);
      return result;
    } catch (error) {
      clearInterval(tick);
      spinner.fail(`${label} ${suffix()}`);
      throw error;
    }
  }

  /**
   * Prompts the user with an interactive question line and awaits an input response.
   *
   * @param text - Question text prompt.
   * @param fallback - Default value if user enters blank.
   * @returns Trimmed user response or default value.
   * @throws {Error} If cancelled by user or input stream ends.
   */
  async ask(text: string, fallback = ""): Promise<string> {
    if (this.controller.signal.aborted) {
      throw new Error("Cancelled.");
    }
    process.stdout.write(
      pc.bold(pc.magenta("? ")) +
        pc.bold(text) +
        (fallback ? pc.dim(` [${fallback}]`) : "") +
        pc.dim(" › "),
    );
    const next = await this.iterator.next();
    if (next.done || this.controller.signal.aborted) {
      throw new Error("Cancelled (input closed).");
    }
    const value = next.value.trim();
    if (/^(?:cancel|quit)$/i.test(value)) {
      this.controller.abort();
      throw new Error("Cancelled.");
    }
    return value || fallback;
  }

  /**
   * Prompts the user until a non-empty string value is provided.
   *
   * @param text - Prompt label.
   * @param fallback - Optional fallback default value.
   * @returns Non-empty input string.
   */
  async required(text: string, fallback = ""): Promise<string> {
    while (true) {
      const value = await this.ask(text, fallback);
      if (value) {
        return value;
      }
      this.show("Enter a value, or cancel.");
    }
  }

  /**
   * Prompts the user for a binary yes/no confirmation.
   *
   * @param text - Confirmation question prompt.
   * @returns Boolean true for yes/y, false for no/n.
   */
  async confirm(text: string): Promise<boolean> {
    while (true) {
      const value = await this.ask(text + " (yes/no)");
      if (/^(y|yes)$/i.test(value)) {
        return true;
      }
      if (/^(n|no)$/i.test(value)) {
        return false;
      }
    }
  }

  /**
   * Closes readline interface and releases SIGINT listeners.
   */
  close(): void {
    this.lines.close();
    process.removeListener("SIGINT", this.interrupt);
  }
}

/**
 * Guides developer through interactive review of proposed QA scenarios,
 * allowing approval, editing, manual addition, or scope exclusion.
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 * @throws {Error} If approval is attempted with zero active scenarios.
 */
export async function reviewScenarios(
  session: Session,
  ui: Terminal,
): Promise<void> {
  while (true) {
    ui.section("Scenarios");
    const tint = (status: string) =>
      status === "approved"
        ? pc.green(status)
        : status === "excluded"
          ? pc.red(status)
          : pc.yellow(status);
    ui.show(
      session.scenarios
        .map(
          (item) =>
            `${pc.bold(item.id)} ${tint(item.status)} ${pc.bold(item.title)} ${pc.dim(`(${item.criteria.join(", ")}, ${item.kind})`)}\n  ${item.steps.join(pc.dim(" → "))}\n  ${pc.dim("Expect:")} ${item.expected}${item.reason ? "\n  " + pc.dim("Reason: " + item.reason) : ""}`,
        )
        .join("\n\n"),
    );
    const action = await ui.ask(
      "Plan: approve / edit / add / exclude",
      "approve",
    );
    if (action === "approve") {
      if (!session.scenarios.some((item) => item.status !== "excluded")) {
        throw new Error("No scenarios selected.");
      }
      for (const item of session.scenarios) {
        if (item.status !== "excluded") {
          item.status = "approved";
        }
      }
      feedback(
        session,
        "plan",
        "approved",
        "Developer approved the displayed scenario revision.",
      );
      await saveSession(session);
      return;
    }
    if (action === "add") {
      const item: Scenario = {
        id:
          "S" +
          (Math.max(
            0,
            ...session.scenarios.map((item) => Number(item.id.slice(1))),
          ) +
            1),
        title: await ui.required("Scenario title"),
        criteria: (await ui.required("Acceptance IDs (comma-separated)", "AC1"))
          .split(",")
          .map((value) => value.trim()),
        kind: "normal",
        steps: (await ui.required("Steps (separate with |)"))
          .split("|")
          .map((value) => value.trim()),
        expected: await ui.required("Expected behavior"),
        status: "pending",
        reason: "",
      };
      if (
        item.criteria.some(
          (id) =>
            !/^AC[1-9]\d*$/.test(id) ||
            Number(id.slice(2)) > session.input.criteria.length,
        )
      ) {
        ui.show("Invalid acceptance IDs.");
        continue;
      }
      session.scenarios.push(item);
      feedback(session, item.id, "added", item.title);
    } else if (action === "edit" || action === "exclude") {
      const id = await ui.required("Scenario ID");
      const item = session.scenarios.find((item) => item.id === id);
      if (!item) {
        ui.show("Unknown scenario ID.");
        continue;
      }
      const before = JSON.stringify(item);
      const reason = await ui.required("Reason for the revision");
      if (action === "exclude") {
        item.status = "excluded";
        item.reason = reason;
      } else {
        item.title = await ui.required("Title", item.title);
        item.steps = (
          await ui.required("Steps (separate with |)", item.steps.join(" | "))
        )
          .split("|")
          .map((text) => text.trim());
        item.expected = await ui.required("Expected behavior", item.expected);
        item.status = "pending";
        item.reason = reason;
      }
      feedback(
        session,
        item.id,
        action,
        JSON.stringify({ reason, before: JSON.parse(before), after: item }),
      );
    } else {
      ui.show("Choose approve, edit, add, or exclude.");
    }
    await saveSession(session);
  }
}


/**
 * Prompts developer to select a test or support file to edit in their configured
 * editor ($VISUAL, $EDITOR, or manual in-place edit), then validates the resulting test suite
 * and creates a new immutable revision in the session.
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 * @throws {Error} If selected test ID is not found or the external editor exits with non-zero code.
 */
export async function editRevision(
  session: Session,
  ui: Terminal,
): Promise<void> {
  const original = session.revisions.at(-1)!;
  const id = await ui.required("Test/support ID to edit");
  const selected = original.tests.find((item) => item.id === id);
  if (!selected) {
    throw new Error("Unknown test ID.");
  }
  const number = session.revisions.length + 1;
  const dir = join(
    session.dir,
    "revision-" + number + "-" + randomUUID().slice(0, 8),
  );
  for (const item of original.tests) {
    const path = join(dir, "tests", item.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.content, { mode: 0o600 });
  }
  const path = join(dir, "tests", selected.path);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    ui.show(`Opening ${path} in your configured editor.`);
    const child = spawn(
      "/bin/sh",
      ["-c", `${editor} "$1"`, "agent-qa-editor", path],
      { stdio: "inherit", signal: ui.controller.signal },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) {
      throw new Error("Editor failed; partial edited files retained.");
    }
  } else {
    ui.show(`Edit ${path}, then return here.`);
    await ui.required("Enter done when saved", "done");
  }
  const reason = await ui.required("Reason for edited revision");
  const response = {
    tests: await Promise.all(
      original.tests.map(async (item) => ({
        id: item.id,
        path: item.path,
        kind: item.kind,
        runner: item.runner,
        scenarioIds: item.scenarioIds,
        purpose: item.purpose,
        expected: item.expected,
        supportIds: item.supportIds,
        content: await readFile(join(dir, "tests", item.path), "utf8"),
      })),
    ),
    gaps: [],
  };
  const validated = validateTests(response, session);
  session.revisions.push({
    number,
    dir,
    tests: validated.tests,
    review: "",
    feedback: reason,
  });
  feedback(session, selected.id, "edited", reason);
  await saveSession(session);
}

/**
 * Guides developer through interactive review of generated test files and independent critique.
 * Allows viewing source code, initiating in-editor modifications, requesting LLM regeneration,
 * rejecting tests, or approving tests for local execution.
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 * @returns Next workflow transition: "execute", "regenerate", or "edited".
 * @throws {Error} If disk files do not match recorded SHA256 checksums.
 */
export async function reviewTests(
  session: Session,
  ui: Terminal,
): Promise<"execute" | "regenerate" | "edited"> {
  while (true) {
    const revision = session.revisions.at(-1)!;
    ui.section(`Test revision ${revision.number}`);
    ui.show(
      `${revision.tests
        .map(
          (item) =>
            `${item.id} ${item.kind}/${item.runner} ${item.path} (${item.scenarioIds.join(", ")})\n  Purpose: ${item.purpose}\n  Expect: ${item.expected}\n  SHA256: ${item.sha256}`,
        )
        .join("\n")}${isDeep(session) ? "\n\nIndependent review:\n" + revision.review : "\n\nIndependent AI review skipped (standard depth)."}`,
    );
    if (isDeep(session) && session.context) {
      ui.show(
        "Existing baseline files to execute before generated unit/integration tests:\n" +
          session.context.runners
            .map(
              (runner) =>
                runner.kind + ": " + (runner.tests.join(", ") || "(none)"),
            )
            .join("\n"),
      );
    }
    if (!isDeep(session)) {
      ui.show(`Scope: ${session.input.intent}\n${session.input.criteria.map((text, i) => `AC${i + 1}: ${text}`).join("\n")}\nComparison reference: ${session.input.base}; target branch: ${session.context?.branch || "(detached/pending)"}; local work: ${session.input.local ? "included" : "excluded"}.\nPrerequisites (${session.assumptions.basis ?? "assumed"}): matching server and repeatable development data. Required support is included in Run all.`);
      for (const item of revision.tests) {
        ui.show(`--- ${item.path} ---\n${item.content}`);
      }
    }
    const action = (await ui.ask(
      isDeep(session) ? "Tests: source / edit / regenerate / approve / reject" : "Run all / inspect / edit / regenerate / cancel (approves displayed files, required support, and execution as trusted local code)",
      isDeep(session) ? "source" : "",
    )).toLowerCase();
    if (action === "cancel") {
      throw new Error("Cancelled.");
    }
    if (action === "source" || action === "inspect") {
      const id = await ui.required("Test ID (or all)", "all");
      for (const item of revision.tests.filter(
        (item) => id === "all" || item.id === id,
      )) {
        ui.show(`--- ${item.path} ---\n${item.content}`);
      }
    } else if (action === "edit") {
      await editRevision(session, ui);
      return "edited";
    } else if (action === "regenerate") {
      feedback(
        session,
        "tests",
        "regenerate",
        await ui.required("Regeneration feedback"),
      );
      await saveSession(session);
      return "regenerate";
    } else if (action === "reject") {
      feedback(session, "tests", "rejected", await ui.required("Reason"));
      await saveSession(session);
      return "regenerate";
    } else if ((action === "approve" && isDeep(session)) || (action === "run all" && !isDeep(session))) {
      const selected = isDeep(session) ? await ui.required(
        "IDs to approve (comma-separated, or all)",
      ) : "all";
      const ids =
        selected === "all"
          ? revision.tests
              .filter((item) => item.kind !== "support")
              .map((item) => item.id)
          : selected.split(",").map((text) => text.trim());
      const tests = selectSupport(revision.tests, ids);
      for (const item of tests) {
        const diskContent = await readFile(
          join(revision.dir, "tests", item.path),
          "utf8",
        );
        if (sha256(diskContent) !== item.sha256) {
          throw new Error(
            "Files changed since review; use edit to record a new revision.",
          );
        }
      }
      ui.show(
        "Selected exact files:\n" + tests.map((item) => item.path).join("\n"),
      );
      if (
        isDeep(session) && !(await ui.confirm(
          "Approve these files, required support, and execution as trusted local code",
        ))
      ) {
        continue;
      }
      for (const item of revision.tests) {
        item.approved = tests.some((test) => test.id === item.id);
      }
      feedback(
        session,
        "revision-" + revision.number,
        "approved",
        tests.map((item) => item.id).join(", "),
      );
      await saveSession(session);
      return "execute";
    }
  }
}

/**
 * Prompts developer to classify test execution failures and anomalies.
 * Displays execution outcomes, finding details, evidence, and allows classifications
 * into "bug", "intended", "invalid", or "unresolved".
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 */
export async function reviewFindings(
  session: Session,
  ui: Terminal,
  classify = true,
): Promise<void> {
  ui.section("Results");
  for (const item of session.executions) {
    const symbol = item.status === "passed" ? pc.green("✔") : pc.red("✖");
    const statusText =
      item.status === "passed" ? pc.green(item.status) : pc.red(item.status);
    ui.show(
      `${symbol} ${item.phase}/${item.runner}: ${statusText} ${pc.dim("(" + item.artifacts + ")")}`,
    );
  }
  for (const finding of session.findings) {
    ui.show(
      `${pc.bold(pc.red("Finding " + finding.id))}: ${pc.bold(finding.category)}\n${finding.observed}\nEvidence: ${finding.evidence.join(", ")}\nSuspected cause: ${finding.suspectedCause || "Unknown"}\nSuggested fix: ${finding.suggestedFix || "Inspect evidence"}`,
    );
    if (
      !classify ||
      session.feedback.some((item) => item.targetId === finding.id)
    ) {
      continue;
    }
    let decision: string;
    do {
      decision = await ui.required(
        "Classify: bug / intended / invalid / unresolved",
      );
    } while (!["bug", "intended", "invalid", "unresolved"].includes(decision));
    feedback(
      session,
      finding.id,
      decision,
      await ui.required("Reason/evidence for classification"),
    );
    await saveSession(session);
  }
}

/**
 * Exports approved generated tests and necessary supporting files into the target repository.
 * Detects collisions with existing files, verifies hashes against the approved revision,
 * displays diff previews, and prevents directory traversal.
 *
 * @param session - Current QA session.
 * @param ui - Terminal UI instance.
 * @throws {Error} If no approved tests exist, destination collides without resolution, or checksums mismatch.
 */
export async function exportTests(
  session: Session,
  ui: Terminal,
): Promise<void> {
  const revision = session.revisions.at(-1);
  if (!revision) {
    throw new Error("Session has no generated tests.");
  }
  const eligible = revision.tests.filter(
    (item) => item.approved && item.kind !== "support",
  );
  if (!eligible.length) {
    throw new Error("Session has no approved tests.");
  }
  ui.show(
    "Approved tests:\n" +
      eligible.map((item) => `${item.id}: ${item.path}`).join("\n"),
  );
  const ids = (
    await ui.required("Select test IDs for export (comma-separated)")
  )
    .split(",")
    .map((text) => text.trim());
  if (ids.some((id) => !eligible.some((item) => item.id === id))) {
    throw new Error("Select only approved test IDs.");
  }
  const tests = selectSupport(revision.tests, ids);
  const destinationRepo = resolve(
    await ui.required("Destination repository", session.input.repo),
  );
  const plans: { item: (typeof tests)[number]; destination: string }[] = [];
  for (const item of tests) {
    const testContent = await readFile(
      join(revision.dir, "tests", item.path),
      "utf8",
    );
    if (!item.approved || sha256(testContent) !== item.sha256) {
      throw new Error("Export source differs from approved revision.");
    }
    let path = safeRelative(
      await ui.required(`Destination path for ${item.id}`, item.path),
    );
    let destination = await containedPath(destinationRepo, path);
    while (
      await lstat(destination)
        .then(() => true)
        .catch(() => false)
    ) {
      const isSymlink = (await lstat(destination)).isSymbolicLink();
      const diff = isSymlink
        ? "Existing destination is a symlink; choose an unused path."
        : await exec("git", [
            "diff",
            "--no-index",
            "--no-ext-diff",
            destination,
            join(revision.dir, "tests", item.path),
          ])
            .then((result) => result.stdout)
            .catch(
              (error: { stdout?: string }) =>
                error.stdout ?? "Existing destination cannot be compared.",
            );
      ui.show(`Collision: ${destination}\n${diff}`);
      path = safeRelative(
        await ui.required(
          "Choose an unused destination path (imports must remain valid)",
        ),
      );
      destination = await containedPath(destinationRepo, path);
    }
    if (plans.some((plan) => plan.destination === destination)) {
      throw new Error("Duplicate export destinations.");
    }
    ui.show(
      `New file: ${destination}\n${item.content
        .split("\n")
        .map((line) => "+" + line)
        .join("\n")}`,
    );
    plans.push({ item, destination });
  }
  if (
    !(await ui.confirm("Export the displayed tests and required support files"))
  ) {
    return;
  }
  for (const { item, destination } of plans) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, item.content, { flag: "wx", mode: 0o600 });
    session.exports.push({
      testId: item.id,
      revision: revision.number,
      destination,
      sha256: item.sha256,
    });
    await saveSession(session);
  }
  feedback(
    session,
    "export",
    "exported",
    plans.map((plan) => plan.destination).join(", "),
  );
  await saveSession(session);
}
