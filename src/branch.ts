/**
 * @file branch.ts
 * Architectural Pipeline Stage: Branch Context and Source Snapshotting.
 *
 * Coordination with pipeline:
 * 1. Invoked by `workflow.ts` during the initial `context` stage to gather
 *    Git branch metadata, commits, diffs, candidate bases, and test runners.
 * 2. Feeds `BranchContext` to `stages.ts` for AI-assisted acceptance mapping,
 *    scenario generation, and test scoping.
 * 3. Provides `createSnapshot` to `execution.ts` to instantiate clean, isolated
 *    filesystem sandboxes of the target revision so tests can run without
 *    modifying working repository sources or leaking dirty state.
 */

import {
  readFile,
  writeFile,
  mkdir,
  symlink,
  lstat,
  unlink,
  cp,
  readdir,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  git,
  excluded,
  safeContent,
  parseChanges,
  MAX_CONTEXT_BYTES,
  type Context,
} from "./context.js";

const exec = promisify(execFile);

/**
 * Detected test runner configuration in the target repository.
 */
export type Runner = {
  /** Test runner kind (Vitest, Jest, or native Node.js test runner). */
  kind: "vitest" | "jest" | "node";
  /** Discovered test file paths associated with this runner. */
  tests: string[];
  /** Config file path if explicitly detected in the repo tree, or null. */
  config: string | null;
};

/**
 * Extended context describing Git branch revision state, diffs, and runner metadata.
 */
export type BranchContext = Context & {
  /** Commit SHA of the branch HEAD. */
  head: string;
  localChanges?: Context["changes"];
  /** Name or ref of the target base branch. */
  base: string;
  /** Common ancestor commit SHA between base and HEAD. */
  mergeBase: string;
  /** Current branch name, or empty string if detached HEAD. */
  branch: string;
  /** Whether uncommitted local changes and untracked files are included. */
  local: boolean;
  /** Optional directory path pointing to a frozen source snapshot. */
  snapshot?: string;
  /** Commit history leading from merge base to HEAD. */
  commits: { sha: string; subject: string; body: string }[];
  /** Discovered test runners available in the repository. */
  runners: Runner[];
  /** Full list of relative file paths present in the HEAD tree. */
  tree: string[];
};

const eligible = /\.(?:[cm]?[jt]sx?|html?|css|scss|sass|json)$/i;
const testPath =
  /(?:^|\/)(?:__tests__\/|test\/|tests\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Identifies potential base branch names (e.g. main, master, or origin/HEAD)
 * for comparison within the repository.
 *
 * @param repo - Repository root path.
 * @returns Array of candidate base branch ref strings.
 */
export async function baseCandidates(repo: string): Promise<string[]> {
  const remote = await git(repo, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]).catch(() => "");
  const candidates = [
    remote.trim().replace(/^refs\/remotes\//, ""),
    "main", "origin/main", "master", "origin/master",
  ].filter(Boolean);
  const available: string[] = [];
  for (const ref of [...new Set(candidates)]) {
    if (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])
      .then(() => true).catch(() => false)) {
      available.push(ref);
    }
  }
  return available;
}

/**
 * Validates that a path is a safe relative path without leading slashes,
 * null bytes, Windows separators, or parent directory traversal components.
 *
 * @param path - Input relative path string.
 * @returns The validated relative path.
 * @throws {Error} If path is absolute, contains null bytes or parent traversal.
 */
export function safeRelative(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new Error(`Invalid relative path: ${path}`);
  }
  return path;
}

/**
 * Retrieves the text content of a file at a specific Git revision.
 *
 * @param repo - Repository root directory path.
 * @param head - Git commit ref or SHA.
 * @param path - Relative file path to read.
 * @returns Decoded UTF-8 content of the file.
 * @throws {Error} If file is excluded, a symlink/submodule, binary, or too large.
 */
export async function revisionContent(
  repo: string,
  head: string,
  path: string,
): Promise<string> {
  safeRelative(path);
  if (excluded.test(path)) {
    throw new Error(`Excluded context: ${path}`);
  }
  const entry = await git(repo, ["ls-tree", "-z", head, "--", path]);
  if (!entry || entry.startsWith("120000 ") || entry.startsWith("160000 ")) {
    throw new Error(`Missing or unsupported revision file: ${path}`);
  }
  const content = await git(repo, ["show", `${head}:${path}`]);
  if (content.includes("\0")) {
    throw new Error(`Binary context: ${path}`);
  }
  if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES) {
    throw new Error(`Context exceeds ${MAX_CONTEXT_BYTES} bytes: ${path}`);
  }
  return content;
}

/**
 * Inspects repository file trees, package.json scripts and dependencies, and sample test
 * contents to determine which test runners (Vitest, Jest, Node) are configured.
 *
 * @param tree - File tree paths in the repository.
 * @param pkgText - Raw JSON content of package.json.
 * @param representative - Map of sample test paths to their contents.
 * @returns Array of detected Runner objects.
 */
export function detectRunners(
  tree: string[],
  pkgText: string,
  representative: Record<string, string> = {},
): Runner[] {
  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: object;
    devDependencies?: object;
  } = {};
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    /* Source without package metadata. */
  }
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const scripts = Object.values(pkg.scripts ?? {}).join(" ");
  const tests = tree.filter(
    (path) =>
      testPath.test(path) &&
      /\.[cm]?[jt]sx?$/.test(path) &&
      !/playwright|e2e/.test(path),
  );
  const runners: Runner[] = [];
  const evidence = Object.values(representative).join("\n");
  for (const kind of ["vitest", "jest", "node"] as const) {
    const config =
      tree.find((path) =>
        new RegExp(`^${kind}\\.config\\.[cm]?[jt]s$`).test(path),
      ) ?? null;
    if (
      kind === "node"
        ? /\bnode\b[^\n]*--test/.test(scripts) ||
          /['"]node:test['"]/.test(evidence)
        : deps.includes(kind) ||
          new RegExp(`\\b${kind}\\b`).test(scripts) ||
          config ||
          new RegExp(
            `['"]${kind === "jest" ? "@jest/globals" : "vitest"}['"]`,
          ).test(evidence)
    ) {
      runners.push({ kind, tests, config });
    }
  }
  return runners;
}

/**
 * Collects Git branch metadata, diffs against the merge base, commit history,
 * imported dependencies, and runner configurations into a BranchContext.
 *
 * @param options - Configuration options for branch inspection.
 * @returns Fully populated BranchContext object.
 * @throws {Error} If base ref is invalid or context limits are exceeded.
 */
export async function collectBranch(options: {
  repo: string;
  base: string;
  local?: boolean;
  context?: string[];
}): Promise<BranchContext> {
  const repo = (
    await git(resolve(options.repo), ["rev-parse", "--show-toplevel"])
  ).trim();
  if (!options.base || options.base.startsWith("-")) {
    throw new Error("Select a valid base ref.");
  }
  const head = (
    await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();
  const base = (
    await git(repo, ["rev-parse", "--verify", `${options.base}^{commit}`])
  ).trim();
  const mergeBase = (await git(repo, ["merge-base", head, base])).trim();
  const local = options.local ?? true;
  const localChanges = parseChanges(await git(repo, [
    "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", head, "--",
  ]));
  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    mergeBase,
    ...(local ? [] : [head]),
  ];
  const changes = parseChanges(
    await git(repo, [...diffArgs, "--name-status", "-z", "--"]),
  );
  const untracked = (
    await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const tree = (await git(repo, ["ls-tree", "-r", "--name-only", "-z", head]))
    .split("\0")
    .filter(Boolean)
    .filter((path) => !excluded.test(path));
  if (local) {
    for (const change of changes) {
      if (change.status.startsWith("D") && tree.includes(change.path)) {
        tree.splice(tree.indexOf(change.path), 1);
      }
    }
  }
  if (local) {
    for (const path of untracked) {
      if (!excluded.test(path) && !tree.includes(path)) {
        tree.push(path);
      }
    }
  }
  const content = (path: string) =>
    local ? safeContent(repo, path) : revisionContent(repo, head, path);
  const pkg = await content("package.json").catch(() => "{}");
  const representative: Record<string, string> = {};
  for (const path of tree.filter((path) => testPath.test(path)).slice(0, 20)) {
    representative[path] = await content(path).catch(() => "");
  }
  const runners = detectRunners(tree, pkg, representative);
  const files: Context["files"] = [];
  const skipped: string[] = [];
  const imported: string[] = [];
  let bytes = 0;
  const add = async (
    path: string,
    diff: string,
    explicit = false,
    deleted = false,
  ) => {
    if (files.some((file) => file.path === path)) {
      return;
    }
    if (excluded.test(path)) {
      if (explicit) {
        throw new Error(`Excluded context: ${path}`);
      }
      skipped.push(path);
      return;
    }
    try {
      const value = deleted ? "" : await content(path);
      const size = Buffer.byteLength(value + diff);
      if (bytes + size > MAX_CONTEXT_BYTES - 15_000) {
        if (explicit) {
          throw new Error("Explicit context exceeds context limit.");
        }
        skipped.push(`${path} (context limit)`);
        return;
      }
      bytes += size;
      files.push({ path, content: value, diff });
    } catch (error) {
      if (explicit) {
        throw error;
      }
      skipped.push(
        `${path} (${error instanceof Error ? error.message : error})`,
      );
    }
  };
  for (const change of changes) {
    if (
      !eligible.test(change.path) &&
      !(change.previousPath && eligible.test(change.previousPath))
    ) {
      skipped.push(change.path);
      continue;
    }
    if (change.previousPath && excluded.test(change.previousPath)) {
      skipped.push(change.path);
      continue;
    }
    const diff = await git(repo, [
      ...diffArgs,
      "-U3",
      "--",
      ...(change.previousPath ? [change.previousPath] : []),
      change.path,
    ]);
    await add(change.path, diff, false, change.status.startsWith("D"));
  }
  if (local) {
    for (const change of changes) {
      if (change.status.startsWith("D") && tree.includes(change.path)) {
        tree.splice(tree.indexOf(change.path), 1);
      }
    }
  }
  if (local) {
    for (const path of untracked) {
      if (eligible.test(path)) {
        await add(path, "Untracked local source.");
      } else {
        skipped.push(path);
      }
    }
  }
  if (!files.some(file => changes.some(change => change.path === file.path) || (local && untracked.includes(file.path)))) {
    throw new Error(`No reviewable changes against ${options.base}. Check the comparison reference${local ? " or add eligible source changes" : " or omit --committed-only to include local work"}. Excluded files: ${skipped.join(", ") || "none"}.`);
  }
  for (const path of options.context ?? []) {
    await add(
      safeRelative(relative(repo, resolve(repo, path))),
      "Explicit supporting source.",
      true,
    );
  }
  for (const path of tree.filter((path) =>
    /^(package\.json|tsconfig[^/]*\.json|(?:vite|vitest|jest|playwright)\.config\.[cm]?[jt]s)$/.test(
      path,
    ),
  )) {
    await add(path, "Runner/application configuration.");
  }
  for (const runner of runners) {
    for (const path of runner.tests.slice(0, 3)) {
      await add(path, "Representative existing test.");
    }
  }
  // Follow local imports using the same selected revision, including CSS/HTML.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const refs = [
      ...file.content.matchAll(
        /(?:from\s*|import\s*|require\s*\()['"](\.\.?\/[^'"\n]+)['"]/g,
      ),
    ].map((match) => match[1]!);
    if (/\.html?$/.test(file.path)) {
      for (const match of file.content.matchAll(
        /\b(?:src|href)\s*=\s*['"]([^'"\n]+)['"]/g,
      )) {
        const path = match[1]!.split(/[?#]/)[0]!;
        if (!/^(?:[a-z]+:|\/\/)/i.test(path) && eligible.test(path)) {
          refs.push(path);
        }
      }
    }
    for (const specifier of refs) {
      const basePath = specifier.startsWith("/")
        ? specifier.slice(1)
        : relative(repo, resolve(repo, dirname(file.path), specifier));
      const stem = basePath.replace(/\.[cm]?js$/, "");
      const path = [
        basePath,
        ...[
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".css",
          ".html",
        ].flatMap((ext) => [stem + ext, join(basePath, "index" + ext)]),
      ].find((path) => tree.includes(path));
      if (path && !files.some((item) => item.path === path)) {
        await add(path, `Imported by ${file.path}.`);
        if (files.some((item) => item.path === path)) {
          imported.push(path);
        }
      }
    }
  }
  const raw = await git(repo, [
    "log",
    "--format=%H%x00%s%x00%b%x00",
    `${mergeBase}..${head}`,
  ]);
  const parts = raw.split("\0");
  const commits: BranchContext["commits"] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    commits.push({
      sha: parts[i]!.trim(),
      subject: parts[i + 1]!,
      body: parts[i + 2]!,
    });
  }
  const result: BranchContext = {
    repo,
    comparison: mergeBase,
    head,
    base,
    mergeBase,
    branch: (await git(repo, ["branch", "--show-current"])).trim(),
    local,
    changes,
    localChanges,
    untracked,
    skipped,
    imported,
    files,
    commits,
    runners,
    tree,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CONTEXT_BYTES) {
    throw new Error("Branch metadata exceeds context limit. Narrow scope.");
  }
  return result;
}

/**
 * Creates an isolated snapshot sandbox directory containing the source tree
 * of the target revision. Reuses matching installed node_modules via symlinks.
 *
 * @param context - Collected BranchContext.
 * @param dir - Target parent directory for the snapshot.
 * @param reuseDependencies - Whether to link compatible installed node_modules packages.
 * @returns Absolute path to the created snapshot source directory.
 * @throws {Error} If symlinks escape, sources mismatch, or dependencies differ.
 */
export async function createSnapshot(
  context: BranchContext,
  dir: string,
  reuseDependencies = true,
): Promise<string> {
  const snapshot = join(dir, "source");
  await mkdir(snapshot, { recursive: true, mode: 0o700 });
  if (context.snapshot) {
    await cp(context.snapshot, snapshot, {
      recursive: true,
      filter: (path) => basename(path) !== "node_modules",
    });
  } else {
    const archive = join(dir, "source.tar");
    await exec("git", [
      "-C",
      context.repo,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      context.head,
    ]);
    await exec("tar", ["-xf", archive, "-C", snapshot]);
    for (const path of await readdir(snapshot, { recursive: true })) {
      if ((await lstat(join(snapshot, path))).isSymbolicLink()) {
        throw new Error(
          `Source snapshot contains unsupported symlink: ${path}`,
        );
      }
    }
  }
  if (context.local && !context.snapshot) {
    const localChanges = parseChanges(
      await git(context.repo, [
        "diff",
        "--no-ext-diff",
        "--name-status",
        "-z",
        "-M",
        context.head,
        "--",
      ]),
    );
    for (const change of localChanges) {
      if (change.previousPath) {
        await unlink(join(snapshot, safeRelative(change.previousPath))).catch(
          () => {},
        );
      }
      const destination = join(snapshot, safeRelative(change.path));
      if (change.status.startsWith("D")) {
        await unlink(destination).catch(() => {});
      } else if (!excluded.test(change.path)) {
        const content = await safeContent(context.repo, change.path).catch(() => undefined);
        if (content !== undefined) {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content);
        } else {
          // Excluded local source must not fall back to stale committed content.
          await unlink(destination).catch(() => {});
        }
      }
    }
    for (const path of context.untracked) {
      if (eligible.test(path) && !excluded.test(path)) {
        const destination = join(snapshot, safeRelative(path));
        const content = await safeContent(context.repo, path).catch(() => undefined);
        if (content !== undefined) {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content);
        }
      }
    }
  }
  for (const file of context.files) {
    if (
      !context.changes.some(
        (change) => change.path === file.path && change.status.startsWith("D"),
      )
    ) {
      if ((await readFile(join(snapshot, file.path), "utf8")) !== file.content) {
        throw new Error(
          `Snapshot differs from selected source: ${file.path}; check archive attributes or local source stability.`,
        );
      }
    }
  }
  if (!reuseDependencies) {
    return snapshot;
  }
  // Archive never contains node_modules; reuse only matching installed dependencies.
  const selectedPkg = JSON.parse(
    await readFile(join(snapshot, "package.json"), "utf8").catch(() => "{}"),
  );
  const installedPkg = JSON.parse(
    await readFile(join(context.repo, "package.json"), "utf8").catch(
      () => "{}",
    ),
  );
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (JSON.stringify(selectedPkg[key]) !== JSON.stringify(installedPkg[key])) {
      throw new Error(
        "Installed dependency declarations differ from selected revision; prepare matching dependencies.",
      );
    }
  }
  for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const selected = await readFile(join(snapshot, lock), "utf8").catch(
      () => null,
    );
    const installed = await readFile(join(context.repo, lock), "utf8").catch(
      () => null,
    );
    if (selected !== installed) {
      throw new Error(
        `Installed ${lock} differs from selected revision; prepare matching dependencies.`,
      );
    }
  }
  if (
    await lstat(join(context.repo, "node_modules"))
      .then(() => true)
      .catch(() => false)
  ) {
    await mkdir(join(snapshot, "node_modules"));
    // Link packages individually so runner caches/build output stay in the snapshot.
    for (const name of await readdir(join(context.repo, "node_modules"))) {
      if (!name.startsWith(".")) {
        await symlink(
          join(context.repo, "node_modules", name),
          join(snapshot, "node_modules", name),
        );
      }
    }
  }
  return snapshot;
}

