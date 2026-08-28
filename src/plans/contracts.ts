import type { BuildConfig, BuildConfigDocument } from "../config/types";
import type { TopologyV3PatchOperation } from "../contracts/registries";
import type { BuildEvaluation } from "../core/evaluate";
import type {
  EvidenceCapture,
  EvidenceDocument,
  PlanEvidenceBinding,
} from "../evidence/contracts";
import type { BuildConfigV3 } from "../topology/contracts";
import type { TopologyBomLine } from "../topology/projections";
import type {
  BuildConfigV2RollbackRef,
  BuildConfigV3MigrationCatalogBinding,
  BuildConfigV3MigrationDiff,
  BuildConfigV3MigrationWarning,
} from "./migration";

export const PLAN_SCHEMA_VERSION = "1.0.0" as const;
/** In-process capability for binding a governed higher-level request to a plan write. */
export const PLAN_IDEMPOTENCY_REQUEST = Symbol("plan-idempotency-request");

export type PlanSchemaVersion = typeof PLAN_SCHEMA_VERSION;
export type PlanStatus = "active" | "archived";
export type PlanSaveStatus = "clean" | "dirty" | "saving" | "saved" | "conflict" | "failed" | "offline";
export type PlanVersionReason = "initial" | "manual-save" | "agent-proposal" | "import" | "restore" | "migration-source";
export type PlanConfig = BuildConfigDocument;

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

export interface PlanConfigMigrationRecord {
  schemaVersion: "plan-config-migration-v1";
  sourceSchemaVersion: "2.0.0";
  targetSchemaVersion: "3.0.0";
  sourceVersionId: string;
  /** Legacy PlanVersion config hash of the immutable V2 source object. */
  sourceConfigHash: string;
  migratedAt: string;
  catalogBinding: BuildConfigV3MigrationCatalogBinding;
  diff: BuildConfigV3MigrationDiff[];
  warnings: BuildConfigV3MigrationWarning[];
  rollbackRef: BuildConfigV2RollbackRef;
}

export interface PlanConfigAccess {
  mode: "v2_fallback";
  sourceVersionId: string;
}

export interface PlanDraft<TConfig extends PlanConfig = BuildConfig> {
  schemaVersion: PlanSchemaVersion;
  baseVersionId: string | null;
  config: TConfig;
  /** Durable source/version closure for an explicit V2 -> V3 draft migration. */
  configMigration?: PlanConfigMigrationRecord;
  /** Read-only runtime projection; never persisted. */
  configAccess?: PlanConfigAccess;
  /** Mutable evidence edges for the draft. Legacy plans may omit this field. */
  evidenceBindings?: PlanEvidenceBinding[];
  dirty: boolean;
  updatedAt: string;
}

export interface BuildPlan<TConfig extends PlanConfig = BuildConfig> {
  schemaVersion: PlanSchemaVersion;
  id: string;
  name: string;
  description?: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  activeVersionId: string | null;
  draftRevision: number;
  draft: PlanDraft<TConfig>;
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

export interface PlanVersion<TConfig extends PlanConfig = BuildConfig> {
  readonly schemaVersion: PlanSchemaVersion;
  readonly id: string;
  readonly planId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly reason: PlanVersionReason;
  readonly summary?: string;
  readonly config: Readonly<TConfig>;
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

export const PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION = "plan-partial-evaluation-v1" as const;
export const PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS = Object.freeze([
  "compatibility",
  "geometry",
  "occupancy",
  "wiring",
  "routing",
  "assembly",
  "power",
  "price",
  "noise",
  "physical",
  "calibration",
  "thermal",
] as const);

export type PlanPartialEvaluationV3UnknownDomain = (typeof PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS)[number];

/**
 * Deliberately incomplete V3 evaluation. The topology BOM is a lossless
 * projection of the persisted graph; every unimplemented derived domain stays
 * explicitly unknown and no V2 compatibility or price result is synthesized.
 */
export interface PlanPartialEvaluationV3 {
  schemaVersion: typeof PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION;
  kind: "topology-v3-partial";
  configSchemaVersion: BuildConfigV3["schemaVersion"];
  topologyBom: TopologyBomLine[];
  unknownDomains: PlanPartialEvaluationV3UnknownDomain[];
}

export type PlanEvaluation = BuildEvaluation | PlanPartialEvaluationV3;

export interface PlanEvaluationSnapshot {
  schemaVersion: PlanSchemaVersion;
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  evaluatedAt: string;
  evaluation: PlanEvaluation;
}

export interface PlanAgentContext {
  schemaVersion: PlanSchemaVersion;
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  buildConfig: BuildConfigDocument;
  evaluation: PlanEvaluation;
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

export type PlanProposalOperation<TConfig extends PlanConfig = BuildConfig> =
  TConfig extends BuildConfigV3 ? TopologyV3PatchOperation : PlanPatchOperation;

export interface PlanChangeProposal<TConfig extends PlanConfig = BuildConfig> {
  schemaVersion: PlanSchemaVersion;
  id: string;
  planId: string;
  expectedDraftRevision: number;
  expectedConfigHash: string;
  createdAt: string;
  summary: string;
  rationale: string[];
  /** Omitted on legacy persisted proposals and therefore interpreted as V2. */
  configSchemaVersion?: TConfig["schemaVersion"];
  /** Immutable V2 -> V3 migration input reviewed with this proposal. */
  migrationCatalogBinding?: BuildConfigV3MigrationCatalogBinding;
  operations: PlanProposalOperation<TConfig>[];
  /** Stable reviewed RequirementSpec fields eligible for a separate confirmation action. */
  confirmableRequirementFieldIds?: string[];
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

export interface CreatePlanInput<TConfig extends PlanConfig = BuildConfig> {
  name: string;
  description?: string;
  config: TConfig;
  metadata?: BuildPlan<TConfig>["metadata"];
  idempotencyKey?: string;
}

export interface UpdateDraftInput<TConfig extends PlanConfig = BuildConfig> {
  expectedRevision: number;
  config: TConfig;
  name?: string;
  metadata?: BuildPlanMetadata;
  idempotencyKey?: string;
  /**
   * Optional higher-level request whose canonical hash owns this write's
   * idempotency slot. It is never persisted verbatim.
   */
  [PLAN_IDEMPOTENCY_REQUEST]?: unknown;
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

export interface MigrateDraftToV3Input {
  expectedRevision: number;
  /** Exact reviewed catalog input; prevents preview/write catalog drift. */
  catalogBinding?: BuildConfigV3MigrationCatalogBinding;
  /** Optional reviewed V3 edit applied to the migrated draft inside the same repository write. */
  operations?: TopologyV3PatchOperation[];
  metadata?: BuildPlanMetadata;
  confirmedRequirementFieldIds?: string[];
  idempotencyKey?: string;
  /** Higher-level request hash authority; never persisted verbatim. */
  [PLAN_IDEMPOTENCY_REQUEST]?: unknown;
}

export interface ReplayIdempotentPlanWriteInput {
  idempotencyKey: string;
  /** Must exactly match the higher-level request bound to the completed write. */
  request: unknown;
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

export interface PlanRepository<TConfig extends PlanConfig = BuildConfig> {
  list(): Promise<BuildPlanSummary[]>;
  get(planId: string): Promise<BuildPlan<TConfig>>;
  create(input: CreatePlanInput<TConfig>): Promise<BuildPlan<TConfig>>;
  updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan<TConfig>>;
  updateDraft(planId: string, input: UpdateDraftInput<TConfig>): Promise<BuildPlan<TConfig>>;
  /**
   * Replays a completed draft write only while the authoritative Plan still
   * matches the immutable result boundary captured by that write. A reused key,
   * legacy unbounded receipt, or subsequently superseded Plan fails closed.
   */
  replayIdempotentPlanWrite?(planId: string, input: ReplayIdempotentPlanWriteInput): Promise<BuildPlan<TConfig> | null>;
  /** File-backed U2 repositories expose explicit V2 -> V3 migration. */
  migrateDraftToV3?(planId: string, input: MigrateDraftToV3Input): Promise<BuildPlan<BuildConfigDocument>>;
  saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion<TConfig>>;
  duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan<TConfig>>;
  listEvidenceBindings(planId: string): Promise<PlanEvidenceBinding[]>;
  bindEvidence(planId: string, input: BindPlanEvidenceInput): Promise<PlanEvidenceBinding>;
  unbindEvidence(planId: string, input: UnbindPlanEvidenceInput): Promise<void>;
  archive(planId: string): Promise<void>;
  restore(planId: string): Promise<void>;
  delete(planId: string): Promise<void>;
  listVersions(planId: string): Promise<PlanVersion<TConfig>[]>;
}
