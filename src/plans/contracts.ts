import type { BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type {
  EvidenceCapture,
  EvidenceDocument,
  PlanEvidenceBinding,
} from "../evidence/contracts";

export const PLAN_SCHEMA_VERSION = "1.0.0" as const;

export type PlanSchemaVersion = typeof PLAN_SCHEMA_VERSION;
export type PlanStatus = "active" | "archived";
export type PlanSaveStatus = "clean" | "dirty" | "saving" | "saved" | "conflict" | "failed" | "offline";
export type PlanVersionReason = "initial" | "manual-save" | "agent-proposal" | "import" | "restore";

export interface BuildIntent {
  useCase: string;
  budgetCny?: number | null;
  region?: string;
  targetResolution?: "1080p" | "1440p" | "4k" | "other";
  targetFps?: number | null;
  games?: string[];
  ownedSkuIds?: string[];
  preferences?: string[];
}

export interface PlanInitializationState {
  status: "pending" | "initialized";
  source: "agent" | "template" | "manual";
  intent?: BuildIntent;
  proposalId?: string;
  initializedAt?: string;
}

export interface BuildPlanMetadata {
  useCase?: string;
  budgetCny?: number | null;
  tags?: string[];
  initialization?: PlanInitializationState;
}

export interface PlanDraft {
  schemaVersion: PlanSchemaVersion;
  baseVersionId: string | null;
  config: BuildConfig;
  /** Mutable evidence edges for the draft. Legacy plans may omit this field. */
  evidenceBindings?: PlanEvidenceBinding[];
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
  metadata: BuildPlanMetadata;
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
  initializationStatus?: PlanInitializationState["status"];
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
  /** Immutable evidence edges pinned when this version was saved. */
  readonly evidenceBindings?: readonly PlanEvidenceBinding[];
  /** Canonical SHA-256 of evidenceBindings for version-integrity checks. */
  readonly evidenceHash?: string;
  readonly evaluationHash?: string;
  readonly evaluatedAt?: string;
  readonly parentVersionId: string | null;
}

export interface PlanEvidenceSummary {
  readonly count: number;
  readonly bindings: ReadonlyArray<Pick<PlanEvidenceBinding,
    "documentId" | "captureId" | "subject" | "purposes" | "locators"
  >>;
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
  spatialViewContext?: unknown;
  purchaseSummary: unknown;
  buildTaskSummary: unknown;
  /** Read-only, bounded projection of draft evidence bindings. */
  evidenceSummary?: PlanEvidenceSummary;
  initialization?: PlanInitializationState;
}

export const PLAN_PATCH_PATHS = Object.freeze([
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
  "/selection/fanMode",
  "/selection/fanGroups",
  "/bom",
  "/notes",
] as const);

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
  kind?: "change" | "initialization";
  intent?: BuildIntent;
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
  order?: number;
  dependsOn?: string[];
  relatedPartId?: string;
  cableId?: string;
  findingId?: string;
  note?: string;
  evidenceRefs?: string[];
  statusSource?: "derived" | "manual";
  updatedAt?: string;
  completedAt?: string;
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
  name?: string;
  metadata?: BuildPlanMetadata;
  idempotencyKey?: string;
}

export interface SaveVersionInput {
  expectedRevision: number;
  expectedConfigHash: string;
  reason: PlanVersionReason;
  summary?: string;
  evaluationHash?: string;
  evaluatedAt?: string;
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

export interface BindPlanEvidenceInput {
  expectedRevision: number;
  documentId: PlanEvidenceBinding["documentId"];
  /** Optional optimistic pin supplied by a caller; repository facts remain authoritative. */
  contentHash?: string;
  captureId?: PlanEvidenceBinding["captureId"];
  subject: PlanEvidenceBinding["subject"];
  purposes: PlanEvidenceBinding["purposes"];
  locators?: PlanEvidenceBinding["locators"];
  note?: string;
  idempotencyKey?: string;
}

export interface UnbindPlanEvidenceInput {
  expectedRevision: number;
  bindingId: PlanEvidenceBinding["id"];
  idempotencyKey?: string;
}

export type EvidenceDocumentLookup = (
  documentId: PlanEvidenceBinding["documentId"],
) => EvidenceDocument | null | Promise<EvidenceDocument | null>;

export type EvidenceCaptureLookup = (
  captureId: NonNullable<PlanEvidenceBinding["captureId"]>,
) => EvidenceCapture | null | Promise<EvidenceCapture | null>;

export interface PlanRepository {
  list(): Promise<BuildPlanSummary[]>;
  get(planId: string): Promise<BuildPlan>;
  create(input: CreatePlanInput): Promise<BuildPlan>;
  updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan>;
  updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan>;
  saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion>;
  duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan>;
  listEvidenceBindings(planId: string): Promise<PlanEvidenceBinding[]>;
  bindEvidence(planId: string, input: BindPlanEvidenceInput): Promise<PlanEvidenceBinding>;
  unbindEvidence(planId: string, input: UnbindPlanEvidenceInput): Promise<void>;
  archive(planId: string): Promise<void>;
  restore(planId: string): Promise<void>;
  delete(planId: string): Promise<void>;
  listVersions(planId: string): Promise<PlanVersion[]>;
}
