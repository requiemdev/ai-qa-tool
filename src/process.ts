/**
 * @file process.ts
 * Child process execution and lifecycle management.
 * Provides safe subprocess spawning with log streaming, timeout protection,
 * process tree termination, and abort signal handling.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { join } from "node:path";

/**
 * Spawns an external command or script, logging stdout/stderr streams to disk,
 * enforcing timeouts, and gracefully terminating processes and subprocess trees.
 *
 * @param executable - Path to the executable or binary name.
 * @param args - Command line arguments passed to the process.
 * @param options - Execution configuration options including working directory and timeouts.
 * @returns Exit code of the finished process.
 * @throws {Error} If the process times out or execution is cancelled.
 */
export async function command(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    artifacts: string;
    input?: string;
    timeout?: number;
    chatgptAuth?: boolean;
    signal?: AbortSignal;
    progress?: (line: string) => void;
  },
): Promise<number> {
  const stdout = createWriteStream(join(options.artifacts, "stdout.log"), {
    mode: 0o600,
    flags: "a",
  });
  const stderr = createWriteStream(join(options.artifacts, "stderr.log"), {
    mode: 0o600,
    flags: "a",
  });
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  // A nested CLI is a new runner, not a node:test worker of its caller.
  delete env.NODE_TEST_CONTEXT;
  if (options.chatgptAuth) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  const child = spawn(executable, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let pending = "";
  if (options.progress) {
    child.stdout.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        options.progress!(line);
      }
    });
  }
  child.stdin.on("error", () => {}); // ENOENT/early exit is reported by the process result.
  child.stdin.end(options.input);
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  };
  const stop = () => {
    kill("SIGTERM");
    clearTimeout(killTimer);
    killTimer = setTimeout(() => kill("SIGKILL"), 2000);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) {
    stop();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout ?? 600_000);
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", stop);
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
  }
  if (timedOut) {
    throw new Error(
      `Process timed out. Logs retained in ${options.artifacts}.`,
    );
  }
  if (options.signal?.aborted) {
    throw new Error("Cancelled. Partial results retained.");
  }
  return code;
}

