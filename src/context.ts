/**
 * @file context.ts
 * Repository context collection and security boundary enforcement.
 * Safely inspects Git state, parses file status changes, and reads file
 * contents while preventing path traversal and excluding sensitive files.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Change } from "./context-types.js";

export type { Change, Context } from "./context-types.js";

const exec = promisify(execFile);

/**
 * Maximum byte size allowed for aggregated source context sent to the AI model.
 */
export const MAX_CONTEXT_BYTES = 100_000;

/**
 * Regular expression matching excluded directories, lockfiles, credentials,
 * certificates, and generated artifacts to prevent sensitive data leaks.
 */
const excluded =
  /(^|\/)(?:node_modules|dist|build|out|coverage|\.git|\.agent-qa|\.next|\.nuxt|\.cache|\.output|\.svelte-kit|\.aws|\.ssh)(\/|$)|(^|\/)(?:secrets?|credentials?)(?:\.[^\/]*)?(\/|$)|(^|\/)\.env(?:\.|$)|(?:\.pem|\.key|\.p12|\.pfx|\.map|\.min\.[jt]s|\.storage-state\.json)$|(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_rsa|id_ed25519)$/i;


/**
 * Executes a Git command safely within the target repository.
 *
 * @param repo - Repository directory path.
 * @param args - Command line arguments passed to git.
 * @returns Decoded stdout string.
 * @throws {Error} If git fails or returns non-zero exit code.
 */
async function git(repo: string, args: string[]): Promise<string> {
  try {
    const result = await exec(
      "git",
      ["--literal-pathspecs", "-C", repo, ...args],
      { maxBuffer: 2_000_000, encoding: "buffer" },
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch (error) {
    throw new Error(
      `Git inspection failed; verify the repository/ref or narrow large changes. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parses raw null-delimited Git `diff --name-status -z` output into structured Change objects.
 *
 * @param raw - Null-delimited Git output string.
 * @returns Array of parsed Change records.
 * @throws {Error} If the output format is malformed or missing paths.
 */
export function parseChanges(raw: string): Change[] {
  const parts = raw.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    const first = parts[i++];
    if (!status || !first) {
      throw new Error("Malformed Git name-status output.");
    }
    if (/^[RC]/.test(status)) {
      const path = parts[i++];
      if (!path) {
        throw new Error("Missing renamed/copied Git path.");
      }
      changes.push({ status, previousPath: first, path });
    } else {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

/**
 * Safely reads the text content of a file within the repository, ensuring
 * it does not escape via directory traversal, symlinks, or violate exclusions.
 *
 * @param repo - Repository root directory path.
 * @param path - Relative path to the target file.
 * @returns UTF-8 decoded string content of the file.
 * @throws {Error} If path is excluded, outside repo, a symlink, binary, or too large.
 */
async function safeContent(repo: string, path: string): Promise<string> {
  const candidate = resolve(repo, path);
  const rel = relative(repo, candidate);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("../") ||
    isAbsolute(rel) ||
    excluded.test(rel)
  ) {
    throw new Error(`Excluded or outside-repository context: ${path}`);
  }
  const canonical = await realpath(candidate);
  const resolvedRel = relative(repo, canonical);
  if (
    resolvedRel === ".." ||
    resolvedRel.startsWith("../") ||
    isAbsolute(resolvedRel) ||
    excluded.test(resolvedRel)
  ) {
    throw new Error(`Excluded or outside-repository symlink: ${path}`);
  }
  if ((await lstat(candidate)).isSymbolicLink()) {
    throw new Error(`Symlink context is unsupported: ${path}`);
  }
  const size = (await lstat(candidate)).size;
  if (size > MAX_CONTEXT_BYTES) {
    throw new Error(
      `Context exceeds ${MAX_CONTEXT_BYTES} bytes. Narrow --context or selected changes.`,
    );
  }
  const bytes = await readFile(candidate);
  if (bytes.includes(0)) {
    throw new Error(`Binary context is unsupported: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export { git, excluded, safeContent };
