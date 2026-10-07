/**
 * @file schemas.ts
 * Strict structured-output schemas and validation for untrusted AI responses.
 * Stage orchestration lives in stages.ts.
 */

import { record } from "./contracts.js";

const string = { type: "string" };
const strings = { type: "array", items: string };
const gaps = {
  type: "array",
  description:
    "Only concrete missing acceptance behavior or prerequisites that prevent the selected checks. Use an empty array when none. Never list pending runtime verification, deliberately skipped modules, unchanged helper coverage, absence of unnecessary backend services, summaries, or progress messages.",
  items: string,
};
const object = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items: object) => ({ type: "array", items });

/**
 * JSON Schema defining the structured output format for the QA analysis and planning stage.
 */
export const planSchema = object({
  summary: string,
  conflicts: strings,
  gaps,
  scenarios: array(
    object({
      title: string,
      criteria: strings,
      kind: {
        type: "string",
        enum: ["normal", "boundary", "error", "regression"],
      },
      steps: strings,
      expected: string,
    }),
  ),
});

/**
 * JSON Schema defining the structured output format for interactive browser exploration.
 */
export const explorationSchema = object({
  flows: array(
    object({
      scenarioId: string,
      status: { type: "string", enum: ["observed", "failed", "incomplete"] },
      steps: strings,
      observed: string,
      evidence: strings,
    }),
  ),
  gaps,
});

/**
 * JSON Schema defining the structured output format for generated test suites.
 */
export const testsSchema = object({
  tests: array(
    object({
      id: string,
      path: string,
      kind: {
        type: "string",
        enum: ["browser", "unit", "integration", "support"],
      },
      runner: {
        type: "string",
        enum: ["playwright", "vitest", "jest", "node"],
      },
      scenarioIds: strings,
      purpose: string,
      expected: string,
      content: string,
      supportIds: strings,
    }),
  ),
  gaps,
});

/**
 * JSON Schema defining the structured output format for independent test reviews.
 */
export const reviewSchema = object({
  assessment: string,
  issues: strings,
  gaps,
});

/**
 * JSON Schema defining independent assessment of execution findings.
 */
export const findingReviewSchema = object({
  findings: array(
    object({
      id: string,
      suspectedCause: string,
      suggestedFix: string,
      source: strings,
    }),
  ),
});

/**
 * Recursively validates an untrusted AI response against a JSON Schema definition,
 * verifying types, required object fields, and enum values.
 *
 * @param value - Untrusted parsed JSON response.
 * @param schema - Schema definition to validate against.
 * @param path - Current property path for error diagnostics.
 * @throws {Error} If value does not strictly adhere to the schema.
 */
export function validateSchema(
  value: unknown,
  schema: object,
  path = "response",
): void {
  const definition = schema as {
    type?: string;
    enum?: unknown[];
    properties?: Record<string, object>;
    items?: object;
  };
  if (definition.enum && !definition.enum.includes(value)) {
    throw new Error(`Malformed AI ${path}: unexpected value.`);
  }
  if (definition.type === "object") {
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !==
        Object.keys(definition.properties!).sort().join(",")
    ) {
      throw new Error(`Malformed AI ${path}: object fields mismatch.`);
    }
    for (const [key, child] of Object.entries(definition.properties!)) {
      validateSchema(value[key], child, `${path}.${key}`);
    }
  } else if (definition.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Malformed AI ${path}: expected array.`);
    }
    value.forEach((item, i) => {
      validateSchema(item, definition.items!, `${path}[${i}]`);
    });
  } else if (typeof value !== definition.type) {
    throw new Error(`Malformed AI ${path}: expected ${definition.type}.`);
  }
}
