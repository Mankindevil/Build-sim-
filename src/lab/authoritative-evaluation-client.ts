import type { BuildConfigDocument } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { BuildPlan, PlanEvaluationSnapshot, PlanVersion } from "../plans/contracts";
import { canonicalJson, hashPlanConfig } from "../plans/canonical";
import {
  authoritativeEvaluationHash,
  createPlanPartialEvaluationV3,
  isPlanPartialEvaluationV3,
  isTopologyEvaluationV3,
  matchesBuildConfigV3Evaluation,
} from "../plans/evaluation";
import { projectTopologyBom } from "../topology/projections";
import { verifyPlanEvaluationLock } from "../plans/evaluation-lock";
import { validatePlanEvaluationSnapshot } from "../plans/validation";
import type {
  AuthoritativeEvaluationReceipt,
  AuthoritativeEvaluationResponse,
} from "../server/evaluation-service";

export type WorkspaceEvaluationMode = "probing" | "enabled" | "disabled" | "unavailable";

export type PlanEvaluationTransportResult =
  | { mode: "enabled"; snapshot: PlanEvaluationSnapshot; receipt: AuthoritativeEvaluationReceipt }
  | { mode: "disabled"; response: AuthoritativeEvaluationResponse };

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => ({ error: "invalid_response" }));
}

function errorMessage(payload: unknown, fallback: string): string {
  const input = record(payload);
  return typeof input?.message === "string"
    ? input.message
    : typeof input?.error === "string" ? input.error : fallback;
}

/**
 * Converts a checksum-verified server receipt into the exact client snapshot.
 * This deliberately preserves the server's evaluatedAt timestamp: plan-version
 * issuance later proves the complete receipt tuple, including that timestamp.
 */
export async function snapshotFromAuthoritativeReceipt(
  plan: BuildPlan<BuildConfigDocument>,
  value: unknown,
): Promise<{ snapshot: PlanEvaluationSnapshot; receipt: AuthoritativeEvaluationReceipt }> {
  const input = record(value);
  if (!input || input.schemaVersion !== "authoritative-evaluation-receipt-v1") {
    throw new Error("Authoritative evaluation response is not a receipt");
  }
  const receipt = value as AuthoritativeEvaluationReceipt;
  const configHash = await hashPlanConfig(plan.draft.config);
  if (receipt.planId !== plan.id
    || receipt.target.kind !== "draft"
    || receipt.target.draftRevision !== plan.draftRevision
    || receipt.configHash !== configHash) {
    throw new Error("Authoritative evaluation receipt does not match the active draft");
  }
  if (!await verifyPlanEvaluationLock(receipt.evaluationLock)
    || receipt.evaluationLock.planId !== plan.id
    || receipt.evaluationLock.snapshotHashes.configHash !== configHash) {
    throw new Error("Authoritative evaluation receipt lock is invalid");
  }
  if (receipt.evaluationHash !== await authoritativeEvaluationHash(receipt.evaluation, receipt.evaluationLock)) {
    throw new Error("Authoritative evaluation receipt identity is invalid");
  }
  if (plan.draft.config.schemaVersion === "3.0.0") {
    if (!await matchesBuildConfigV3Evaluation(plan.draft.config, receipt.evaluation)) {
      throw new Error("Authoritative V3 evaluation does not match the active topology");
    }
  } else {
    if (isPlanPartialEvaluationV3(receipt.evaluation)
      || await hashPlanConfig((receipt.evaluation as BuildEvaluation).config) !== configHash) {
      throw new Error("Authoritative V2 evaluation does not match the active config");
    }
  }
  const snapshot: PlanEvaluationSnapshot = {
    schemaVersion: plan.schemaVersion,
    planId: plan.id,
    planVersionId: plan.activeVersionId,
    draftRevision: plan.draftRevision,
    configHash,
    evaluationHash: receipt.evaluationHash,
    evaluationLock: structuredClone(receipt.evaluationLock),
    evaluatedAt: receipt.evaluatedAt,
    evaluation: structuredClone(receipt.evaluation),
  };
  const errors = validatePlanEvaluationSnapshot(snapshot);
  if (errors.length) throw new Error(`Authoritative evaluation snapshot is invalid: ${errors.join("; ")}`);
  return { snapshot, receipt: structuredClone(receipt) };
}

/**
 * Fact-graph evaluation is always attempted first. Only the workspace route's
 * explicit feature-disabled response authorizes use of the legacy agent route.
 */
export async function requestPlanEvaluation(
  plan: BuildPlan<BuildConfigDocument>,
  fetchImplementation: FetchImplementation = fetch,
): Promise<PlanEvaluationTransportResult> {
  const configHash = await hashPlanConfig(plan.draft.config);
  const workspaceResponse = await fetchImplementation(`/api/workspace/plans/${encodeURIComponent(plan.id)}/evaluations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: {
        kind: "draft",
        expectedDraftRevision: plan.draftRevision,
        expectedConfigHash: configHash,
      },
    }),
  });
  const workspacePayload = await json(workspaceResponse);
  const workspaceError = record(workspacePayload)?.error;
  if (workspaceResponse.status === 404 && workspaceError === "fact_graph_evaluation_disabled") {
    const legacyResponse = await fetchImplementation("/api/agent/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildConfig: plan.draft.config }),
    });
    const legacyPayload = await json(legacyResponse);
    if (!legacyResponse.ok) {
      throw new Error(errorMessage(legacyPayload, `Legacy evaluation failed with HTTP ${legacyResponse.status}`));
    }
    return { mode: "disabled", response: legacyPayload as AuthoritativeEvaluationResponse };
  }
  if (!workspaceResponse.ok) {
    throw new Error(errorMessage(workspacePayload, `Authoritative evaluation failed with HTTP ${workspaceResponse.status}`));
  }
  const resolved = await snapshotFromAuthoritativeReceipt(plan, workspacePayload);
  return { mode: "enabled", ...resolved };
}

export function canPublishLegacyEvaluation(mode: WorkspaceEvaluationMode): boolean {
  return mode === "disabled";
}

function snapshotMatchesActivePlan(
  plan: BuildPlan<BuildConfigDocument> | null | undefined,
  snapshot: PlanEvaluationSnapshot | null | undefined,
): snapshot is PlanEvaluationSnapshot {
  if (!plan || !snapshot || snapshot.planId !== plan.id || snapshot.draftRevision !== plan.draftRevision) return false;
  if (plan.draft.config.schemaVersion === "3.0.0") {
    if (isPlanPartialEvaluationV3(snapshot.evaluation)) {
      return canonicalJson(snapshot.evaluation) === canonicalJson(createPlanPartialEvaluationV3(plan.draft.config));
    }
    return isTopologyEvaluationV3(snapshot.evaluation)
      && snapshot.evaluation.authority.configHash === snapshot.configHash
      && canonicalJson(snapshot.evaluation.topologyBom) === canonicalJson(projectTopologyBom(plan.draft.config));
  }
  return !isTopologyEvaluationV3(snapshot.evaluation)
    && canonicalJson(snapshot.evaluation.config) === canonicalJson(plan.draft.config);
}

export function canUsePlanAgentContext(
  mode: WorkspaceEvaluationMode,
  snapshot: PlanEvaluationSnapshot | null,
  plan: BuildPlan<BuildConfigDocument> | null | undefined,
): boolean {
  if (!snapshotMatchesActivePlan(plan, snapshot)) return false;
  if (mode === "enabled") return Boolean(snapshot.evaluationLock);
  return mode === "disabled";
}

/** Select only the server-issued V2 evaluation for the exact active draft. */
export function governedBuildEvaluationForActivePlan(
  mode: WorkspaceEvaluationMode,
  plan: BuildPlan<BuildConfigDocument> | null | undefined,
  snapshot: PlanEvaluationSnapshot | null | undefined,
): BuildEvaluation | null {
  if (mode !== "enabled" || !plan || !snapshotMatchesActivePlan(plan, snapshot) || !snapshot.evaluationLock
    || plan.draft.config.schemaVersion !== "2.0.0"
    || snapshot.evaluationLock.planId !== plan.id
    || snapshot.evaluationLock.snapshotHashes.configHash !== snapshot.configHash
    || isTopologyEvaluationV3(snapshot.evaluation)) return null;
  return structuredClone(snapshot.evaluation);
}

/**
 * Governed checklist export requires the exact immutable version receipt.
 * Legacy V2 versions without that lock remain readable but are not re-evaluated
 * locally and presented as traced while fact authority is enabled.
 */
export function governedBuildEvaluationForSavedVersion(
  mode: WorkspaceEvaluationMode,
  version: PlanVersion<BuildConfigDocument> | null | undefined,
  snapshot: PlanEvaluationSnapshot | null | undefined,
): BuildEvaluation | null {
  if (mode !== "enabled" || !version || !snapshot?.evaluationLock
    || version.config.schemaVersion !== "2.0.0" || !version.evaluationLock
    || !version.evaluationHash || !version.evaluatedAt
    || snapshot.planId !== version.planId || snapshot.planVersionId !== version.id
    || snapshot.configHash !== version.configHash || snapshot.evaluationHash !== version.evaluationHash
    || snapshot.evaluationLock.contentHash !== version.evaluationLock.contentHash
    || snapshot.evaluationLock.snapshotHashes.configHash !== version.configHash
    || isTopologyEvaluationV3(snapshot.evaluation)
    || canonicalJson(snapshot.evaluation.config) !== canonicalJson(version.config)) return null;
  return structuredClone(snapshot.evaluation);
}
