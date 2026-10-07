/**
 * @file runner-results.ts
 * Pure interpretation of Playwright, Node, Vitest, and Jest execution evidence.
 * execution.ts owns subprocesses, snapshots, and persistence.
 */

import { resolve } from "node:path";
import { record } from "./contracts.js";
import type { ExecutionResult } from "./session-types.js";

/**
 * Determines the execution status (passed, failed, blocked, invalid) from
 * runner exit codes, output logs, and parsed JSON test results.
 *
 * @param runner - Test runner kind (playwright, node, vitest, jest).
 * @param code - Process exit code.
 * @param value - Parsed JSON results from runner output, if available.
 * @param logs - Combined stdout and stderr string logs.
 * @returns Execution outcome classification status.
 */
export function resultStatus(
  runner: string,
  code: number,
  value: unknown,
  logs: string,
): ExecutionResult["status"] {
  // runner-message heuristics; use structured error adapters if attribution is ambiguous.
  if (
    code !== 0 &&
    /executable doesn't exist|failed to launch|browser.*(?:crash|closed)|ECONNREFUSED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED)|ENOTFOUND|Cannot find (?:module|package)|ENOENT/i.test(
      logs + JSON.stringify(value),
    )
  ) {
    return "blocked";
  }
  if (runner === "playwright") {
    if (
      !record(value) ||
      !record(value.stats) ||
      (Array.isArray(value.errors) && value.errors.length)
    ) {
      return "invalid";
    }
    const stats = value.stats;
    if (
      stats.skipped ||
      stats.flaky ||
      typeof stats.expected !== "number" ||
      typeof stats.unexpected !== "number"
    ) {
      return "blocked";
    }
    if (code === 0 && stats.expected > 0) {
      return "passed";
    }
    return code !== 0 && stats.unexpected > 0 ? "failed" : "blocked";
  }
  if (runner === "node") {
    if (
      /SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(
        logs,
      )
    ) {
      return "invalid";
    }
    if (record(value) && record(value.stats)) {
      if (
        !value.stats.tests ||
        value.stats.skipped ||
        value.stats.todo ||
        value.stats.cancelled
      ) {
        return "blocked";
      }
      return code === 0 && value.stats.failed === 0
        ? "passed"
        : code !== 0 &&
            typeof value.stats.failed === "number" &&
            value.stats.failed > 0
          ? "failed"
          : "blocked";
    }
    const count = /# tests (\d+)/.exec(logs);
    if (!count || Number(count[1]) < 1 || /# (?:skipped|todo) [1-9]/.test(logs)) {
      return "blocked";
    }
    return code === 0 ? "passed" : "failed";
  }
  if (
    !record(value) ||
    typeof value.numTotalTests !== "number" ||
    value.numTotalTests < 1 ||
    value.numPendingTests ||
    value.numTodoTests
  ) {
    return "blocked";
  }
  if (value.numFailedTestSuites && !value.numFailedTests) {
    return "invalid";
  }
  return code === 0 && value.numPassedTests === value.numTotalTests
    ? "passed"
    : code !== 0 &&
        typeof value.numFailedTests === "number" &&
        value.numFailedTests > 0
      ? "failed"
      : "blocked";
}
/** Extracts a bounded, deduplicated failure summary while retaining raw evidence in logs. */
export function failureText(value: unknown): string {
  const messages: string[] = [];
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (!record(item)) {
      return;
    }
    if (Array.isArray(item.errors)) {
      for (const error of item.errors) {
        if (record(error) && typeof error.message === "string") {
          messages.push(error.message);
        }
      }
    }
    if (record(item.error) && typeof item.error.message === "string") {
      messages.push(item.error.message);
    }
    if (Array.isArray(item.failureMessages)) {
      for (const message of item.failureMessages) {
        if (typeof message === "string") {
          messages.push(message);
        }
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  return (
    [...new Set(messages)]
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .slice(0, 1500) ||
    "Inspect unchanged executed files and retained evidence before attributing an application bug."
  );
}

/**
 * Evaluates execution outcome for a specific test file from the runner summary
 * or individual test suite assertion lists.
 *
 * @param value - Parsed JSON object from test runner.
 * @param file - Canonical path to the test file.
 * @param source - Repository root or snapshot base directory.
 * @returns Status of the test file execution (passed, failed, or blocked).
 */
export function fileStatus(
  value: unknown,
  file: string,
  source: string,
): ExecutionResult["status"] {
  const statuses: string[] = [];
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (!record(item)) {
      return;
    }
    if (
      item.type === "test:summary" &&
      record(item.data) &&
      item.data.file === file &&
      record(item.data.counts) &&
      item.data.counts.tests
    ) {
      statuses.push(
        item.data.counts.failed
          ? "failed"
          : item.data.success &&
              !item.data.counts.skipped &&
              !item.data.counts.todo &&
              !item.data.counts.cancelled
            ? "passed"
            : "blocked",
      );
    }
    if (
      typeof item.file === "string" &&
      resolve(source, item.file) === file &&
      Array.isArray(item.tests)
    ) {
      for (const test of item.tests) {
        if (record(test) && Array.isArray(test.results)) {
          for (const run of test.results) {
            if (record(run) && typeof run.status === "string") {
              statuses.push(run.status);
            }
          }
        }
      }
    }
    if (
      typeof item.name === "string" &&
      resolve(source, item.name) === file &&
      Array.isArray(item.assertionResults)
    ) {
      for (const assertion of item.assertionResults) {
        if (record(assertion) && typeof assertion.status === "string") {
          statuses.push(assertion.status);
        }
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  if (statuses.some((status) => status === "failed" || status === "timedOut")) {
    return "failed";
  }
  return statuses.length && statuses.every((status) => status === "passed")
    ? "passed"
    : "blocked";
}
