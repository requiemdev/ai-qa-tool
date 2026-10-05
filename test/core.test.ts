import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localUrl } from "../src/contracts.js";
import { command } from "../src/process.js";

test("loopback URLs reject external hosts and embedded credentials", () => {
  assert.equal(
    localUrl("http://127.0.0.1:3000/settings"),
    "http://127.0.0.1:3000/settings",
  );
  for (const url of [
    "https://example.com/",
    "file:///etc/passwd",
    "http://user:pass@localhost/",
  ]) {
    assert.throws(() => localUrl(url));
  }
});

test("spawn failure and stubborn timed-out subprocess retain logs and terminate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-qa-process-"));
  try {
    await assert.rejects(
      command("agent-qa-missing-executable", [], { cwd: dir, artifacts: dir }),
      /ENOENT/,
    );
    await assert.rejects(
      command(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM", () => {}); console.log("started"); setInterval(() => {}, 1000)',
        ],
        { cwd: dir, artifacts: dir, timeout: 500 },
      ),
      /timed out/,
    );
    assert.match(await readFile(join(dir, "stdout.log"), "utf8"), /started/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
