import type { PlanEvaluation } from "../plans/contracts";

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
 * The Agent receives the same V2 evaluation or explicit V3 partial-evaluation
 * object used by the plan context. Projections belong to individual Tools;
 * the authoritative hash covers every deterministic field in this payload.
 */
export function authoritativeEvaluationPayload(evaluation: PlanEvaluation): unknown {
  return canonicalAgentValue(evaluation);
}
