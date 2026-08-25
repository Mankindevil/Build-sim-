import type { BuildEvaluation } from "../core/evaluate";

export const AGENT_EVALUATION_SCHEMA_VERSION = "1.0.0" as const;

export function canonicalAgentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAgentValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalAgentValue(item)]),
    );
  }
  return value;
}
export function stableAgentJson(value: unknown): string {
  return JSON.stringify(canonicalAgentValue(value));
}

/**
 * The Agent receives the same complete evaluation object used by the UI. This
 * function is deliberately boring: projections belong to individual Tools,
 * while the authoritative hash must cover every deterministic consumer field.
 */
export function authoritativeEvaluationPayload(evaluation: BuildEvaluation): unknown {
  return canonicalAgentValue(evaluation);
}
