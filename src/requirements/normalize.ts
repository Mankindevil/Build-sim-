import { isMetricId, type MetricId } from "../contracts/registries";
import {
  isActionableWorkloadRequirement,
  validateRequirementSpec,
  type RequirementSpec,
} from "./contracts";

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(value: string): string {
  return value.normalize("NFC");
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return normalizedText(value);
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [normalizedText(key), normalizeJsonValue(child)] as const)
      .sort(([left], [right]) => compareCanonicalText(left, right));
    const normalized = new Map<string, unknown>();
    for (const [key, child] of entries) {
      if (normalized.has(key)) throw new TypeError(`requirement object keys collide after NFC normalization: ${key}`);
      normalized.set(key, child);
    }
    return Object.fromEntries(normalized);
  }
  return value;
}

/**
 * A metric ID is unique only within its workload. The JSON tuple avoids
 * delimiter ambiguity and matches the stable parent/child selector semantics.
 */
export function requirementMetricIdentity(workloadId: string, metricId: MetricId): string {
  if (normalizedText(workloadId).trim().length === 0) throw new TypeError("workloadId must not be empty");
  if (!isMetricId(metricId)) throw new TypeError(`metricId is not governed: ${String(metricId)}`);
  return JSON.stringify([normalizedText(workloadId), normalizedText(metricId)]);
}

/**
 * Produces the canonical RequirementSpec value consumed by topology/content
 * hashing. Stable IDs are retained; only governed set ordering and Unicode/
 * JSON scalar normalization change. The caller's object is never mutated.
 */
export function normalizeRequirementSpec(spec: RequirementSpec): RequirementSpec {
  const errors = validateRequirementSpec(spec);
  if (errors.length > 0) throw new TypeError(`invalid RequirementSpec: ${errors.join("; ")}`);
  const normalized = normalizeJsonValue(spec) as RequirementSpec;
  normalized.workloads.sort((left, right) => compareCanonicalText(left.workloadId, right.workloadId));
  for (const workload of normalized.workloads) {
    if (!isActionableWorkloadRequirement(workload)) continue;
    workload.metrics.sort((left, right) => compareCanonicalText(left.metricId, right.metricId));
    if (workload.evidenceOrBenchmarkRefs) workload.evidenceOrBenchmarkRefs.sort(compareCanonicalText);
  }
  normalized.constraints.sort((left, right) => compareCanonicalText(left.constraintId, right.constraintId));
  const normalizedErrors = validateRequirementSpec(normalized);
  if (normalizedErrors.length > 0) throw new TypeError(`normalized RequirementSpec is invalid: ${normalizedErrors.join("; ")}`);
  return normalized;
}
