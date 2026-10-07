/**
 * @file schemas.ts
 * Strict structured-output schemas and validation for untrusted AI responses.
 * Stage orchestration lives in stages.ts.
 */

import { record } from "./contracts.js";
import type { ImprovementCandidate } from "./session-types.js";

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

export const improvementSchema = object({
  scenarioIds: strings,
  title: string,
  observed: string,
  benefit: string,
  suggestedChange: string,
  priority: { type: "string", enum: ["low", "medium", "high"] },
  source: {
    ...strings,
    description: "Exact supplied source path:line references, for example index.html:5. A bare filename is invalid. Use [] when grounded only in retained flow evidence.",
    items: { type: "string", pattern: "^.+:[1-9][0-9]*$" },
  },
  evidence: { ...strings, description: "Retained discovery artifact paths or flow:S1 style observation references. For a screenshot use its exact saved filename/path without a screenshot: prefix. Use [] for source-only candidates." },
});

/**
 * JSON Schema defining the structured output format for the QA analysis and planning stage.
 */
export const planSchema = object({
  summary: string,
  conflicts: strings,
  gaps,
  improvements: array(improvementSchema),
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
  improvements: array(improvementSchema),
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
  improvements: array(object({
    id: string,
    assessment: { type: "string", enum: ["supported", "unverified", "dismissed"] },
    assessmentReason: string,
  })),
});

/** Validate one advisory without making it a test requirement or a coverage gap. */
export function validateImprovementCandidate(
  value: unknown,
  scenarioIds: readonly string[],
  files: readonly { path: string; content: string }[],
): ImprovementCandidate {
  validateSchema(value, improvementSchema);
  const candidate = value as ImprovementCandidate;
  if ([candidate.title, candidate.observed, candidate.benefit, candidate.suggestedChange].some((text) => !text.trim())) {
    throw new Error("Improvement descriptions must be meaningful.");
  }
  if (candidate.scenarioIds.some((id) => !scenarioIds.includes(id)) || new Set(candidate.scenarioIds).size !== candidate.scenarioIds.length) {
    throw new Error("Improvement contains unknown or duplicate scenario IDs.");
  }
  if ((!candidate.source.length && !candidate.evidence.length) || (!candidate.scenarioIds.length && !candidate.source.length) || candidate.evidence.some((ref) => !ref.trim())) {
    throw new Error("Improvement requires source or evidence; a source-only observation requires source references.");
  }
  for (const ref of candidate.source) {
    const match = /^(.*):([1-9]\d*)$/.exec(ref);
    const file = match && files.find((file) => file.path === match[1]);
    if (!file || Number(match![2]) > file.content.split("\n").length) {
      throw new Error(`Improvement source reference is outside supplied files: ${ref}`);
    }
  }
  return candidate;
}

/** Keep valid planning/exploration output when individual advisories are malformed. */
export function validateDiscoveryResponse(
  value: unknown,
  schema: object,
  scenarioIds: readonly string[],
  files: readonly { path: string; content: string }[],
): { improvements: ImprovementCandidate[]; rejected: string[] } {
  validateSchema(record(value) ? { ...value, improvements: [] } : value, schema);
  const candidates = (value as Record<string, unknown>).improvements;
  const improvements: ImprovementCandidate[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(candidates)) {
    return { improvements, rejected: ["Malformed improvement output: expected array."] };
  }
  for (const candidate of candidates) {
    try {
      improvements.push(validateImprovementCandidate(candidate, scenarioIds, files));
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { improvements, rejected };
}

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
