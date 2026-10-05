/**
 * @file node-reporter.ts
 * Custom reporter for Node.js native test runner (`node:test`).
 * Serializes raw test events to JSON lines, preserving file identities,
 * error stacks, and test statistics for structured processing.
 */

/**
 * Transforms an async iterable of `node:test` events into newline-delimited JSON.
 *
 * @param events - Stream of test runner events emitted by Node's test runner.
 * @returns Async generator yielding serialized JSON strings followed by a newline.
 */
export default async function* reporter(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  for await (const event of events) {
    const serialized =
      JSON.stringify(event, (_key, value: unknown) => {
        if (value instanceof Error) {
          return { message: value.message, stack: value.stack };
        }
        if (typeof value === "bigint") {
          return String(value);
        }
        return value;
      }) + "\n";
    yield serialized;
  }
}

