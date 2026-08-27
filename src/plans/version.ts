import type { BuildConfig } from "../config/types";
import type { PlanEvidenceBinding } from "../evidence/contracts";
import { deepReadonly, sha256Hex } from "./canonical";
import { PLAN_SCHEMA_VERSION, type PlanVersion, type PlanVersionReason } from "./contracts";
import { assertValidPlanVersion } from "./validation";

export interface CreatePlanVersionInput {
  id: string;
  planId: string;
  versionNumber: number;
  createdAt: string;
  reason: PlanVersionReason;
  summary?: string;
  evaluationHash?: string;
  evaluatedAt?: string;
  config: BuildConfig;
  evidenceBindings?: readonly PlanEvidenceBinding[];
  parentVersionId: string | null;
}

export async function createImmutablePlanVersion(input: CreatePlanVersionInput): Promise<PlanVersion> {
  const config = structuredClone(input.config);
  const evidenceBindings = structuredClone(input.evidenceBindings ?? []).map((binding) => ({
    ...binding,
    planId: input.planId,
    planVersionId: input.id,
  }));
  const version: PlanVersion = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: input.id,
    planId: input.planId,
    versionNumber: input.versionNumber,
    createdAt: input.createdAt,
    reason: input.reason,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    config,
    configHash: await sha256Hex(config),
    evidenceBindings,
    evidenceHash: await sha256Hex(evidenceBindings),
    ...(input.evaluationHash ? { evaluationHash: input.evaluationHash } : {}),
    ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {}),
    parentVersionId: input.parentVersionId,
  };
  assertValidPlanVersion(version);
  return deepReadonly(version) as PlanVersion;
}
