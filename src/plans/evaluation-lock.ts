import { hashContent, isSha256Hex, isSnapshotHashes, type SnapshotHashes } from "../hash";
import type { PlanEvaluationLock } from "./contracts";

export type PlanEvaluationLockInput = Omit<PlanEvaluationLock, "contentHash">;

const CONTRACT = Object.freeze({
  domain: "plan-evaluation-lock",
  schemaVersion: "plan-evaluation-lock-v1",
  canonicalizationPolicyId: "plan-evaluation-lock-content-v1",
} as const);

export function validatePlanEvaluationLock(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["evaluation lock must be an object"];
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "planId", "snapshotHashes", "factSnapshotId", "userObservationSnapshotId", "artifactLockfileHash", "contentHash"].includes(key))) errors.push("evaluation lock contains unknown fields");
  if (input.schemaVersion !== "plan-evaluation-lock-v1") errors.push("evaluation lock schemaVersion invalid");
  if (typeof input.planId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.planId)) errors.push("evaluation lock planId invalid");
  if (!isSnapshotHashes(input.snapshotHashes)) errors.push("evaluation lock snapshotHashes invalid");
  for (const field of ["factSnapshotId", "userObservationSnapshotId"] as const) if (typeof input[field] !== "string" || !input[field]) errors.push(`evaluation lock ${field} invalid`);
  for (const field of ["artifactLockfileHash", "contentHash"] as const) if (!isSha256Hex(input[field])) errors.push(`evaluation lock ${field} invalid`);
  return errors;
}

export async function evaluationLockContentHash(value: PlanEvaluationLockInput | PlanEvaluationLock): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createPlanEvaluationLock(input: { planId: string; snapshotHashes: SnapshotHashes; factSnapshotId: string; userObservationSnapshotId: string; artifactLockfileHash: string }): Promise<PlanEvaluationLock> {
  const material: PlanEvaluationLockInput = { schemaVersion: "plan-evaluation-lock-v1", ...structuredClone(input) };
  const lock: PlanEvaluationLock = Object.freeze({ ...material, contentHash: await evaluationLockContentHash(material) });
  const errors = validatePlanEvaluationLock(lock);
  if (errors.length) throw new TypeError(`Invalid PlanEvaluationLock: ${errors.join("; ")}`);
  return lock;
}

export async function verifyPlanEvaluationLock(value: unknown): Promise<boolean> {
  if (validatePlanEvaluationLock(value).length) return false;
  const lock = value as PlanEvaluationLock;
  return lock.contentHash === await evaluationLockContentHash(lock);
}
