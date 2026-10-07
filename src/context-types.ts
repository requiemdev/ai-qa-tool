/**
 * @file context-types.ts
 * Source selection, Git changes, and detected test runner models.
 * context.ts reads individual files; branch.ts collects branch context and snapshots.
 */

/**
 * Represents a changed file detected by Git diff.
 */
export type Change = {
  /** Git status code (e.g. M, A, D, R100). */
  status: string;
  /** Current relative file path. */
  path: string;
  /** Prior path if file was renamed or copied. */
  previousPath?: string;
};

/**
 * Aggregated source code and Git metadata collected for analysis.
 */
export type Context = {
  /** Absolute path to repository root. */
  repo: string;
  /** Comparison ref or merge base sha. */
  comparison: string;
  /** List of detected file changes. */
  changes: Change[];
  /** List of untracked file paths. */
  untracked: string[];
  /** List of files skipped due to size or exclusion rules. */
  skipped: string[];
  /** List of auxiliary files discovered via local imports. */
  imported: string[];
  /** Loaded source files along with unified diffs. */
  files: { path: string; content: string; diff: string }[];
};

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
