import type { BuildConfig } from "../config/types";
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
  config: BuildConfig;
  parentVersionId: string | null;
}

export async function createImmutablePlanVersion(input: CreatePlanVersionInput): Promise<PlanVersion> {
  const config = structuredClone(input.config);
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
    parentVersionId: input.parentVersionId,
  };
  assertValidPlanVersion(version);
  return deepReadonly(version) as PlanVersion;
}
