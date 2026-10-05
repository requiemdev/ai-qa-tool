/**
 * @file contracts.ts
 * Core validation contracts and type guard predicates for agent-qa.
 * Enforces security invariants such as verifying loopback target URLs
 * and asserting object shapes.
 */

/**
 * Type guard predicate that validates whether a value is a non-null,
 * non-array object record.
 *
 * @param value - Unknown input value to test.
 * @returns True if value is a plain object Record, false otherwise.
 */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates that an input URL string is an explicit HTTP or HTTPS loopback
 * URL without embedded user authentication credentials.
 *
 * @param input - URL string to parse and validate.
 * @returns The normalized URL href string if valid.
 * @throws {Error} If the URL is not a valid loopback address or contains credentials.
 */
export function localUrl(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "--url must be an explicit HTTP(S) loopback URL without embedded credentials.",
    );
  }
  return url.href;
}

