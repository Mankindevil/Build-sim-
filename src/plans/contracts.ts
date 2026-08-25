import type { BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";

export const PLAN_SCHEMA_VERSION = "1.0.0" as const;

export type PlanSchemaVersion = typeof PLAN_SCHEMA_VERSION;
export type PlanStatus = "active" | "archived";
export type PlanSaveStatus = "clean" | "dirty" | "saving" | "saved" | "conflict" | "failed" | "offline";
export type PlanVersionReason = "initial" | "manual-save" | "agent-proposal" | "import" | "restore";

export interface PlanDraft {
  schemaVersion: PlanSchemaVersion;
  baseVersionId: string | null;
  config: BuildConfig;
  dirty: boolean;
  updatedAt: string;
}

export interface BuildPlan {
  schemaVersion: PlanSchemaVersion;
  id: string;
  name: string;
  description?: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  activeVersionId: string | null;
  draftRevision: number;
  draft: PlanDraft;
  metadata: {
    useCase?: string;
    budgetCny?: number | null;
    tags?: string[];
  };
}

export interface BuildPlanSummary {
  schemaVersion: PlanSchemaVersion;
  id: string;
  name: string;
  status: PlanStatus;
  updatedAt: string;
  activeVersionId: string | null;
  draftRevision: number;
  dirty: boolean;
}

export interface PlanVersion {
  readonly schemaVersion: PlanSchemaVersion;
  readonly id: string;
  readonly planId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly reason: PlanVersionReason;
  readonly summary?: string;
  readonly config: Readonly<BuildConfig>;
  readonly configHash: string;
  readonly parentVersionId: string | null;
}

export interface PlanEvaluationSnapshot {
  schemaVersion: PlanSchemaVersion;
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  evaluatedAt: string;
  evaluation: BuildEvaluation;
}

export interface PlanAgentContext {
  schemaVersion: PlanSchemaVersion;
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  buildConfig: BuildConfig;
  evaluation: BuildEvaluation;
  spatialSelection?: {
    partId: string;
    view: string;
    findingId?: string;
  } | null;
  purchaseSummary: unknown;
  buildTaskSummary: unknown;
}

export const PLAN_PATCH_PATHS = [
  "/name",
  "/caseId",
  "/boardId",
  "/cpuId",
  "/selection/psuId",
  "/selection/psuTopology",
  "/selection/secondaryPsuId",
  "/selection/dualStart",
  "/selection/coolerId",
  "/selection/gpuId",
  "/selection/memoryId",
  "/selection/diskCount",
  "/selection/diskSkuId",
  "/selection/nvmeCount",
  "/selection/boot",
  "/selection/hbaMode",
  "/selection/hbaSkuId",
  "/bom",
  "/notes",
] as const;

export type PlanPatchPath = (typeof PLAN_PATCH_PATHS)[number];

export type PlanPatchOperation =
  | { op: "add" | "replace"; path: PlanPatchPath; value: unknown }
  | { op: "remove"; path: PlanPatchPath };

export interface PlanChangeProposal {
  schemaVersion: PlanSchemaVersion;
  id: string;
  planId: string;
  expectedDraftRevision: number;
  expectedConfigHash: string;
  createdAt: string;
  summary: string;
  rationale: string[];
  operations: PlanPatchOperation[];
  predictedImpact: {
    resolvedFindingIds: string[];
    introducedFindingIds: string[];
    budgetDeltaCny: number | null;
  };
  status: "proposed" | "applied" | "rejected" | "stale";
}

export interface PlanTransactionLink {
  schemaVersion: PlanSchemaVersion;
  planId: string | null;
  planVersionIdAtCapture: string | null;
  planItemId: string | null;
  linkStatus: "linked" | "unlinked" | "stale";
}

export interface BuildTask {
  schemaVersion: PlanSchemaVersion;
  id: string;
  planId: string;
  sourceVersionId: string;
  kind: "purchase" | "assembly" | "wiring" | "verification";
  sourceRef: string;
  title: string;
  status: "todo" | "doing" | "done" | "blocked" | "obsolete";
  staleReason?: string;
}

export interface CreatePlanInput {
  name: string;
  description?: string;
  config: BuildConfig;
  metadata?: BuildPlan["metadata"];
  idempotencyKey?: string;
}

export interface UpdateDraftInput {
  expectedRevision: number;
  config: BuildConfig;
  idempotencyKey?: string;
}

export interface SaveVersionInput {
  expectedRevision: number;
  expectedConfigHash: string;
  reason: PlanVersionReason;
  summary?: string;
  idempotencyKey?: string;
}

export interface UpdatePlanInfoInput {
  expectedRevision: number;
  name: string;
  description?: string;
  metadata?: BuildPlan["metadata"];
}

export interface DuplicatePlanInput {
  name: string;
  idempotencyKey?: string;
}

export interface PlanRepository {
  list(): Promise<BuildPlanSummary[]>;
  get(planId: string): Promise<BuildPlan>;
  create(input: CreatePlanInput): Promise<BuildPlan>;
  updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan>;
  updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan>;
  saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion>;
  duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan>;
  archive(planId: string): Promise<void>;
  restore(planId: string): Promise<void>;
  delete(planId: string): Promise<void>;
  listVersions(planId: string): Promise<PlanVersion[]>;
}
