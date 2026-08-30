import { createHash } from "node:crypto";
import path from "node:path";
import { parseConfig, type BuildConfig, type BuildConfigDocument } from "../config/types";
import type { BuildConfigV3 } from "../topology/contracts";
import { factGraphEnabled as factGraphFlagEnabled } from "../config/io";
import { assertValidConfig } from "../config/validate";
import { evaluateBuild, type BuildEvaluation } from "../core/evaluate";
import {
  DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  type CaseRuntimeAdapterRegistry,
} from "../adapters/runtime";
import { authoritativeEvaluationPayload, stableAgentJson, AGENT_EVALUATION_SCHEMA_VERSION } from "../agent/evaluation-contract";
import {
  ARTIFACT_LOCK_ROLES,
  createArtifactLockfile,
  hashContent,
  isSha256Hex,
  validateArtifactPayload,
  verifyContentAddressedRef,
  type ArtifactLockEntries,
  type ArtifactLockRole,
  type ArtifactLockfile,
  type ArtifactPayload,
  type ContentAddressedRef,
  type LockedArtifactRef,
  type SnapshotHashes,
} from "../hash";
import type { ConflictSet, FactRecord, FactSnapshot, UpdateDecision } from "../facts/contracts";
import { verifyConflictSet } from "../facts/conflicts";
import { verifyFactRecord } from "../facts/hash";
import { verifyFactSnapshot } from "../facts/snapshots";
import { verifyUpdateDecision } from "../facts/update-decisions";
import type { ObservationProjectionContext, UserObservation, UserObservationSnapshot } from "../observations/contracts";
import { verifyUserObservationRuntime, verifyUserObservationSnapshotRuntime } from "../observations/canonical-runtime.mjs";
import type { SkuCatalog } from "../sku/types";
import type { PriceSnapshotFile } from "../price/types";
import { validateRequirementSpec } from "../requirements/contracts";
import { validateSimulationInputSources, verifySimulationInputHashClosure } from "../simulation/contracts";
import { applyPriceSnapshot } from "../price/merge";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { loadRuntimePriceSnapshot, resolveActiveGenerationRoot } from "./runtime-price-snapshot";
import { hashPlanConfigRuntime } from "../plans/canonical-runtime.mjs";
import { hashPlanConfig, sha256Hex as hashPlanValue } from "../plans/canonical";
import {
  assessEvaluationFreshness,
  authoritativeEvaluationHash,
  createPlanPartialEvaluationV3,
  isPlanPartialEvaluationV3,
  isTopologyEvaluationV3,
  matchesBuildConfigV3Evaluation,
  type EvaluationFreshness,
} from "../plans/evaluation";
import { createPlanEvaluationLock } from "../plans/evaluation-lock";
import type { EvaluationLockRepository } from "../plans/evaluation-lock-repository";
import { PLAN_SCHEMA_VERSION, type PlanEvaluation, type PlanEvaluationLock, type PlanEvaluationSnapshot, type PlanPartialEvaluationV3 } from "../plans/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION,
  type FactUpdateEvaluationDomain,
  type SnapshotEvaluationReceipt,
} from "../facts/update-evaluation";
import { factSubjectKey } from "../facts/resolver";
import { verifyCaseAdapterSnapshotPayload } from "../adapters/registry";
import { verifyWorkspaceStandardSetPayload } from "../standards/artifact";
import type { CaseAdapterArtifactPayload } from "../adapters/registry";
import type { CaseAdapterManifest } from "../adapters/contracts";
import { resolveCaseInstanceOverridesAtRoot, type CaseInstanceOverrides } from "../adapters/instance-overrides";
import { caseAdapterSpatialProjectionHash } from "../adapters/spatial-projection";
import { verifyCaseInstanceOverridesRuntime } from "../observations/canonical-runtime.mjs";
import {
  compileLockedCaseAdapterManifestRuntime,
  compileLockedCaseAdapterRuntime,
} from "../adapters/runtime-compiler";
import type { CaseRuntimeModel } from "../adapters/runtime-model";
import { isProgressiveBuildEvaluation } from "../compatibility/contracts";
import { validateWorkspaceSystemProfilePayloadRuntime } from "../system-profiles/runtime.mjs";

export interface AuthoritativeEvaluationResponseV2 {
  schemaVersion: typeof AGENT_EVALUATION_SCHEMA_VERSION;
  configHash: string;
  evaluationHash: string;
  catalogVersion: string;
  priceSnapshotVersion: string;
  evaluation: BuildEvaluation;
}
export interface AuthoritativeEvaluationResponseV3 {
  schemaVersion: typeof AGENT_EVALUATION_SCHEMA_VERSION;
  configHash: string;
  evaluationHash: string;
  catalogVersion: string;
  /** V3 partial evaluation makes no price-snapshot or total-price claim. */
  priceSnapshotVersion: null;
  evaluation: PlanPartialEvaluationV3;
}
export type AuthoritativeEvaluationResponse = AuthoritativeEvaluationResponseV2 | AuthoritativeEvaluationResponseV3;
interface AuthoritativeCatalogRepositoryOptions {
  persistRoot?: string;
  runtimeRoot?: string;
  generationAware?: boolean;
  baseCatalogPath?: string;
  priceRuntimeRoot?: string;
  allowSeedPriceFallback?: boolean;
}

export type EvaluationTargetRequest =
  | { kind: "draft"; expectedDraftRevision: number; expectedConfigHash: string }
  | { kind: "version"; versionId: string; expectedConfigHash?: string };

export interface EvaluateCurrentPlanRequest {
  planId: string;
  target: EvaluationTargetRequest;
}

export interface EvaluationTargetSnapshot {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: BuildConfigDocument;
  /** Immutable version lock supplied by the plan repository, never transport input. */
  pinnedEvaluationLock?: PlanEvaluationLock;
}

export interface LoadedArtifactInput {
  ref: LockedArtifactRef;
  /** Exact inert bytes/value verified against ref before the evaluator sees it. */
  payload: unknown;
}

export type LoadedArtifactInputs = Readonly<Record<ArtifactLockRole, LoadedArtifactInput>>;

export interface LoadedExternalSnapshot {
  /** Repository-issued content address; shape-only hashes are rejected. */
  ref: ContentAddressedRef;
  /** Exact immutable payload verified against ref before evaluation. */
  payload: unknown;
}

export interface LoadedExternalEvaluationInputs {
  requirementSpec: LoadedExternalSnapshot;
  priceSnapshot: LoadedExternalSnapshot;
  simulationInput: LoadedExternalSnapshot;
}

const EXTERNAL_ARTIFACT_MEDIA = Object.freeze({
  priceSnapshot: "application/vnd.buildsim.price-snapshot+json",
  simulationInput: "application/vnd.buildsim.sourced-simulation-input+json",
} as const);

const EVALUATION_ARTIFACT_BINDINGS = Object.freeze({
  ruleSet: { domain: "artifact.rule-set", payloadSchema: "workspace-rule-set-v1", media: "application/vnd.buildsim.rule-set+json" },
  standardSet: { domain: "artifact.standard-set", payloadSchema: "workspace-standard-set-v1", media: "application/vnd.buildsim.standard-set+json" },
  systemProfile: { domain: "artifact.system-profile", payloadSchema: "workspace-system-profile-v1", media: "application/vnd.buildsim.system-profile+json" },
  adapterSnapshot: { domain: "artifact.adapter-snapshot", payloadSchema: "workspace-adapter-snapshot-v1", media: "application/vnd.buildsim.adapter-snapshot+json" },
  engine: { domain: "artifact.engine", payloadSchema: "workspace-engine-v1", media: "application/vnd.buildsim.engine+json" },
  simulationModel: { domain: "artifact.simulation-model", payloadSchema: "workspace-simulation-model-binding-v1", media: "application/vnd.buildsim.simulation-model+json" },
} as const);

export interface ResolvedFactSnapshotClosure {
  snapshot: FactSnapshot;
  facts: FactRecord[];
  conflicts: ConflictSet[];
  decisions: UpdateDecision[];
}

export interface ResolvedObservationRecord {
  recordHash: string;
  observation: UserObservation;
  projectionContext: ObservationProjectionContext;
  attachmentClosureVerified: true;
}

export interface ResolvedObservationSnapshotClosure {
  snapshot: UserObservationSnapshot;
  observations: ResolvedObservationRecord[];
}

export interface EvaluationSnapshotAuthority {
  /** Must resolve the repository's current active set, never a caller-supplied fact list. */
  resolveFactSnapshotAtRoot(activeRoot: string, target: EvaluationTargetSnapshot): Promise<ResolvedFactSnapshotClosure>;
  resolveObservationSnapshotAtRoot(
    activeRoot: string,
    target: EvaluationTargetSnapshot,
    artifacts?: LoadedArtifactInputs,
  ): Promise<ResolvedObservationSnapshotClosure>;
  loadArtifactsAtRoot(
    activeRoot: string,
    target: EvaluationTargetSnapshot,
    activeRuntimeGeneration: number,
  ): Promise<LoadedArtifactInputs>;
  loadExternalInputsAtRoot(
    activeRoot: string,
    target: EvaluationTargetSnapshot,
    closure: {
      factSnapshot: FactSnapshot;
      observationSnapshot: UserObservationSnapshot;
      artifactLockfile: ArtifactLockfile;
      caseInstanceOverrides: CaseInstanceOverrides[];
    },
  ): Promise<LoadedExternalEvaluationInputs>;
}

export interface EvaluationTargetAuthority {
  /** Reads plan-owned config; transport callers never submit config bytes. */
  readTargetAtRoot(activeRoot: string, planId: string, target: EvaluationTargetRequest): Promise<EvaluationTargetSnapshot>;
}

export interface GovernedEvaluationInput {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: Readonly<BuildConfigDocument>;
  snapshotHashes: SnapshotHashes;
  factClosure: Readonly<ResolvedFactSnapshotClosure>;
  observationClosure: Readonly<ResolvedObservationSnapshotClosure>;
  artifactLockfile: ArtifactLockfile;
  artifacts: LoadedArtifactInputs;
  externalInputs: LoadedExternalEvaluationInputs;
  evaluationLock: PlanEvaluationLock;
}

/** Server-internal detached candidate input. Transport routes must never accept
 * this shape: the scenario/solver services supply the config after replaying an
 * immutable server-owned patch. */
export interface DetachedCandidateEvaluationInput {
  planId: string;
  basePlanVersionId: string;
  config: BuildConfigV3;
}

export interface GovernedEvaluationResult {
  evaluation: PlanEvaluation;
  catalogVersion: string;
  priceSnapshotVersion: string | null;
}

export type GovernedEvaluationExecutor = (input: GovernedEvaluationInput) => GovernedEvaluationResult | Promise<GovernedEvaluationResult>;

export type EvaluationTargetBinding =
  | { kind: "draft"; draftRevision: number }
  | { kind: "version"; versionId: string };

export interface AuthoritativeEvaluationReceipt {
  schemaVersion: "authoritative-evaluation-receipt-v1";
  planId: string;
  target: EvaluationTargetBinding;
  runtimeGeneration: number;
  preparedRevision: number;
  committedRevision: number;
  configHash: string;
  evaluationHash: string;
  evaluationLock: PlanEvaluationLock;
  evaluatedAt: string;
  evaluation: PlanEvaluation;
  catalogVersion: string;
  priceSnapshotVersion: string | null;
  cacheStatus: "hit" | "miss";
}

export interface EvaluationReceiptAuthority {
  /** Returns the exact envelope read back after its checksum/identity validation. */
  commitAtRoot(
    activeRoot: string,
    receipt: AuthoritativeEvaluationReceipt,
    options?: { installCurrent?: boolean },
  ): Promise<AuthoritativeEvaluationReceipt>;
  /** Replays only a checksum-verified receipt bound to this exact full evaluation lock. */
  getReceiptByLockAtRoot(
    activeRoot: string,
    planId: string,
    target: EvaluationTargetBinding,
    evaluationLockHash: string,
  ): Promise<AuthoritativeEvaluationReceipt | null>;
  currentLockAtRoot(activeRoot: string, planId: string, target: EvaluationTargetBinding): Promise<PlanEvaluationLock | null>;
}

export interface AuthorizedFactCandidateEvaluationRequest extends EvaluateCurrentPlanRequest {
  /** Server-issued update notice identity; never a caller-supplied snapshot. */
  updateNoticeId: string;
  phase: "before" | "after";
}

export interface AuthorizedFactCandidateAuthority {
  /**
   * Resolves and re-authorizes an exact before/after snapshot from the durable
   * notice at this active root. Transport code must never implement this from
   * request snapshot bytes or hashes.
   */
  resolveAtRoot(
    activeRoot: string,
    input: {
      planId: string;
      target: EvaluationTargetSnapshot;
      targetRequest: EvaluationTargetRequest;
      updateNoticeId: string;
      phase: "before" | "after";
    },
  ): Promise<ResolvedFactSnapshotClosure>;
}

export interface AuthoritativeEvaluationSnapshotPipelineOptions {
  runtimeRoot: string;
  coordinator?: RuntimeCoordinator;
  factGraphEnabled: boolean;
  genericAdaptersEnabled?: boolean;
  targets?: EvaluationTargetAuthority;
  snapshots?: EvaluationSnapshotAuthority;
  locks?: EvaluationLockRepository;
  receipts?: EvaluationReceiptAuthority;
  factCandidates?: AuthorizedFactCandidateAuthority;
  evaluator?: GovernedEvaluationExecutor;
  now?: () => string;
}

interface PreparedEvaluation {
  target: EvaluationTargetSnapshot;
  targetBinding: EvaluationTargetBinding;
  configHash: string;
  factClosure: ResolvedFactSnapshotClosure;
  observationClosure: ResolvedObservationSnapshotClosure;
  artifacts: LoadedArtifactInputs;
  artifactLockfile: ArtifactLockfile;
  externalInputs: LoadedExternalEvaluationInputs;
  snapshotHashes: SnapshotHashes;
  evaluationLock: PlanEvaluationLock;
  runtimeGeneration: number;
  persistedReceipt: AuthoritativeEvaluationReceipt | null;
}

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}

function artifactContentRef(ref: LockedArtifactRef): ContentAddressedRef {
  return {
    ref: ref.ref,
    hashSpecVersion: ref.hashSpecVersion,
    algorithm: ref.algorithm,
    contentHash: ref.contentHash,
    domain: ref.domain,
    schemaVersion: ref.schemaVersion,
    canonicalizationPolicyId: ref.canonicalizationPolicyId,
  };
}

function validateEvaluateCurrentRequest(value: unknown): asserts value is EvaluateCurrentPlanRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["planId", "target"])) throw new TypeError("evaluation request must contain exactly planId and target");
  const request = value as Record<string, unknown>;
  if (typeof request.planId !== "string" || !PLAN_ID.test(request.planId)) throw new TypeError("evaluation request planId invalid");
  if (!request.target || typeof request.target !== "object" || Array.isArray(request.target)) throw new TypeError("evaluation request target invalid");
  const target = request.target as Record<string, unknown>;
  if (target.kind === "draft") {
    if (!exactKeys(target, ["kind", "expectedDraftRevision", "expectedConfigHash"])
      || !Number.isInteger(target.expectedDraftRevision) || (target.expectedDraftRevision as number) < 0
      || !isSha256Hex(target.expectedConfigHash)) throw new TypeError("draft evaluation target invalid");
    return;
  }
  if (target.kind === "version") {
    const allowed = target.expectedConfigHash === undefined ? ["kind", "versionId"] : ["kind", "versionId", "expectedConfigHash"];
    if (!exactKeys(target, allowed)
      || typeof target.versionId !== "string" || !PLAN_ID.test(target.versionId)
      || (target.expectedConfigHash !== undefined && !isSha256Hex(target.expectedConfigHash))) throw new TypeError("version evaluation target invalid");
    return;
  }
  throw new TypeError("evaluation request target kind invalid");
}

function validateAuthorizedFactCandidateRequest(value: unknown): asserts value is AuthorizedFactCandidateEvaluationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["planId", "target", "updateNoticeId", "phase"])) {
    throw new TypeError("fact candidate evaluation request must contain exactly planId, target, updateNoticeId, and phase");
  }
  const input = value as Record<string, unknown>;
  validateEvaluateCurrentRequest({ planId: input.planId, target: input.target });
  if (typeof input.updateNoticeId !== "string" || !PLAN_ID.test(input.updateNoticeId)
    || !["before", "after"].includes(String(input.phase))) {
    throw new TypeError("fact candidate evaluation notice binding invalid");
  }
}

function targetBinding(target: EvaluationTargetSnapshot, request: EvaluationTargetRequest): EvaluationTargetBinding {
  if (request.kind === "draft") {
    if (target.planVersionId !== null || target.draftRevision !== request.expectedDraftRevision) throw new Error("draft evaluation target changed");
    return { kind: "draft", draftRevision: target.draftRevision };
  }
  if (target.planVersionId !== request.versionId) throw new Error("version evaluation target changed");
  return { kind: "version", versionId: request.versionId };
}

function assertTargetOwnership(target: EvaluationTargetSnapshot, planId: string): void {
  if (target.planId !== planId || !PLAN_ID.test(target.planId)
    || !Number.isInteger(target.draftRevision) || target.draftRevision < 0
    || (target.planVersionId !== null && !PLAN_ID.test(target.planVersionId))) throw new Error("evaluation target authority returned an invalid owner/binding");
  if (target.pinnedEvaluationLock && (target.planVersionId === null
    || target.pinnedEvaluationLock.planId !== planId
    || target.pinnedEvaluationLock.snapshotHashes.configHash !== hashPlanConfigRuntime(target.config))) {
    throw new Error("evaluation target authority returned an invalid pinned version lock");
  }
}

async function assertExternalInputs(
  value: LoadedExternalEvaluationInputs,
  options: { planId: string; requireCaseInstanceOverrides: boolean },
): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value as unknown as Record<string, unknown>, ["requirementSpec", "priceSnapshot", "simulationInput"])) {
    throw new Error("external snapshot authority returned an incomplete closure");
  }
  for (const field of ["requirementSpec", "priceSnapshot", "simulationInput"] as const) {
    const snapshot = value[field];
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || !exactKeys(snapshot as unknown as Record<string, unknown>, ["ref", "payload"])
      || !await verifyContentAddressedRef(snapshot.payload, snapshot.ref)) throw new Error(`external ${field} snapshot payload/ref invalid`);
    if (field === "requirementSpec") {
      if (snapshot.ref.domain !== "requirement-spec" || snapshot.ref.schemaVersion !== "1.0.0"
        || validateRequirementSpec(snapshot.payload).length) throw new Error("external requirementSpec semantic authority invalid");
      continue;
    }
    if (snapshot.ref.domain !== "artifact" || snapshot.ref.schemaVersion !== "artifact-payload-v1"
      || validateArtifactPayload(snapshot.payload).length) throw new Error(`external ${field} artifact authority invalid`);
    const artifact = snapshot.payload as ArtifactPayload;
    if (artifact.contentHash !== snapshot.ref.contentHash || artifact.mediaType !== EXTERNAL_ARTIFACT_MEDIA[field]) {
      throw new Error(`external ${field} artifact role binding invalid`);
    }
    if (field === "priceSnapshot"
      ? !validGovernedPriceSnapshot(artifact.payload)
      : !await validGovernedSimulationInput(artifact.payload, options.planId, options.requireCaseInstanceOverrides)) {
      throw new Error(`external ${field} semantic payload invalid`);
    }
  }
}

function validGovernedPriceSnapshot(value: unknown): value is PriceSnapshotFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "asOf", "note", "snapshotId", "generatedAt", "catalogVersion", "inputHash", "contentHash", "priceVersion", "quotes"];
  if (Object.keys(snapshot).some((key) => !allowed.includes(key))
    || snapshot.schemaVersion !== "1.1.0" || snapshot.priceVersion !== "price-snapshot-v2"
    || typeof snapshot.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf)
    || typeof snapshot.snapshotId !== "string" || !/^price-snapshot-[a-f0-9]{20}$/.test(snapshot.snapshotId)
    || typeof snapshot.inputHash !== "string" || !isSha256Hex(snapshot.inputHash)
    || snapshot.snapshotId !== `price-snapshot-${snapshot.inputHash.slice(0, 20)}`
    || typeof snapshot.generatedAt !== "string" || !Number.isFinite(Date.parse(snapshot.generatedAt))
    || typeof snapshot.contentHash !== "string" || !isSha256Hex(snapshot.contentHash)
    || !Array.isArray(snapshot.quotes)) return false;
  const material = {
    schemaVersion: snapshot.schemaVersion,
    asOf: snapshot.asOf,
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    snapshotId: snapshot.snapshotId,
    generatedAt: snapshot.generatedAt,
    ...(snapshot.catalogVersion === undefined ? {} : { catalogVersion: snapshot.catalogVersion }),
    inputHash: snapshot.inputHash,
    priceVersion: snapshot.priceVersion,
    quotes: snapshot.quotes,
  };
  if (createHash("sha256").update(JSON.stringify(material)).digest("hex") !== snapshot.contentHash) return false;
  const quoteKeys = [
    "skuId", "platform", "priceCny", "currency", "listingUrl", "match", "evidence", "priceKind", "variantLabel",
    "priceAmount", "priceCurrency", "fetchedAt", "provenanceId", "sourceHash", "provenance", "note", "title",
  ];
  return snapshot.quotes.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const quote = candidate as Record<string, unknown>;
    return !Object.keys(quote).some((key) => !quoteKeys.includes(key))
      && typeof quote.skuId === "string" && quote.skuId.length > 0
      && typeof quote.platform === "string" && quote.platform.length > 0
      && typeof quote.priceCny === "number" && Number.isFinite(quote.priceCny) && quote.priceCny > 0
      && quote.currency === "CNY" && quote.evidence === "audited" && quote.priceKind === "variant"
      && typeof quote.variantLabel === "string" && quote.variantLabel.trim().length > 0
      && typeof quote.listingUrl === "string" && /^https:\/\//i.test(quote.listingUrl);
  });
}

async function validGovernedSimulationInput(value: unknown, planId: string, requireOverrides: boolean): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const isFrozenClosure = payload.schemaVersion === "simulation-input-hash-closure-v1";
  if (isFrozenClosure) {
    const closure = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "caseInstanceOverrides"));
    if (!await verifySimulationInputHashClosure(closure)
      || Object.keys(payload).some((key) => !["schemaVersion", "sourcedInput", "logicalLayouts", "contentHash", "caseInstanceOverrides"].includes(key))) return false;
  } else if (validateSimulationInputSources(value).length > 0
    || Object.keys(payload).some((key) => !["input", "sources", "caseInstanceOverrides"].includes(key))) return false;
  if (payload.caseInstanceOverrides === undefined) return !requireOverrides;
  const overrides = payload.caseInstanceOverrides;
  if (!Array.isArray(overrides)
    || overrides.some((entry) => !verifyCaseInstanceOverridesRuntime(entry) || entry.planId !== planId)
    || new Set(overrides.map((entry) => entry.instanceId)).size !== overrides.length) return false;
  return overrides.every((entry, index) => index === 0 || overrides[index - 1]!.instanceId < entry.instanceId);
}

function validArtifactSources(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((source) => source && typeof source === "object"
    && !Array.isArray(source) && exactKeys(source as Record<string, unknown>, ["moduleId", "bytes"])
    && typeof (source as { moduleId?: unknown }).moduleId === "string" && Boolean((source as { moduleId: string }).moduleId)
    && typeof (source as { bytes?: unknown }).bytes === "string" && Boolean((source as { bytes: string }).bytes));
}

function validUniqueStrings(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((entry) => typeof entry === "string" && entry.length > 0)
    && new Set(value).size === value.length;
}

async function validEvaluationArtifactPayload(role: ArtifactLockRole, value: unknown, genericAdaptersEnabled: boolean): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (!validArtifactSources(payload.sources)) return false;
  if (role === "ruleSet") return exactKeys(payload, ["schemaVersion", "ruleIds", "sources"])
    && payload.schemaVersion === "workspace-rule-set-v1" && validUniqueStrings(payload.ruleIds);
  if (role === "standardSet") return genericAdaptersEnabled || "library" in payload
    ? verifyWorkspaceStandardSetPayload(payload)
    : exactKeys(payload, ["schemaVersion", "standardIds", "sources"])
      && payload.schemaVersion === "workspace-standard-set-v1" && validUniqueStrings(payload.standardIds);
  if (role === "systemProfile") return payload.schemaVersion === "workspace-system-profile-v2"
    ? validateWorkspaceSystemProfilePayloadRuntime(payload).length === 0
    : exactKeys(payload, ["schemaVersion", "profileId", "supportedPlanSchemas", "sources"])
      && payload.schemaVersion === "workspace-system-profile-v1"
      && typeof payload.profileId === "string" && Boolean(payload.profileId)
      && validUniqueStrings(payload.supportedPlanSchemas)
      && (payload.supportedPlanSchemas as string[]).every((schema) => schema === "2.0.0" || schema === "3.0.0");
  if (role === "adapterSnapshot") {
    const hasRegistryClosure = [
      "caseManifests", "runtimeAdapters", "capabilityProviderManifests", "capabilityProviderRuntimes",
    ].some((key) => key in payload);
    if (genericAdaptersEnabled || hasRegistryClosure) {
      return await verifyCaseAdapterSnapshotPayload(payload)
        && await verifyLockedCaseRuntimeExecutors(payload as unknown as CaseAdapterArtifactPayload);
    }
    if (!exactKeys(payload, ["schemaVersion", "catalog", "sources"])
      || payload.schemaVersion !== "workspace-adapter-snapshot-v1"
      || !payload.catalog || typeof payload.catalog !== "object" || Array.isArray(payload.catalog)) return false;
    const catalog = payload.catalog as Record<string, unknown>;
    return typeof catalog.schemaVersion === "string" && Array.isArray(catalog.skus)
      && catalog.skus.every((sku) => sku && typeof sku === "object" && !Array.isArray(sku)
        && typeof (sku as { id?: unknown }).id === "string" && Boolean((sku as { id: string }).id)
        && typeof (sku as { category?: unknown }).category === "string" && Boolean((sku as { category: string }).category)
        && typeof (sku as { name?: unknown }).name === "string" && Boolean((sku as { name: string }).name));
  }
  if (role === "engine") return exactKeys(payload, ["schemaVersion", "engineId", "engineVersion", "sources"])
    && payload.schemaVersion === "workspace-engine-v1"
    && typeof payload.engineId === "string" && Boolean(payload.engineId)
    && typeof payload.engineVersion === "string" && Boolean(payload.engineVersion);
  return exactKeys(payload, ["schemaVersion", "modelId", "modelVersion", "claims", "sources"])
    && payload.schemaVersion === "workspace-simulation-model-binding-v1"
    && typeof payload.modelId === "string" && Boolean(payload.modelId)
    && typeof payload.modelVersion === "string" && Boolean(payload.modelVersion)
    && payload.claims === "unknown";
}

async function verifyLockedCaseRuntimeExecutors(payload: CaseAdapterArtifactPayload): Promise<boolean> {
  try {
    const manifestsByHash = new Map(payload.caseManifests.map((manifest) => [manifest.contentHash, manifest]));
    const modelsByHash = new Map(payload.runtimeModels.map((model) => [model.contentHash, model]));
    for (const descriptor of payload.runtimeAdapters) {
      const manifest = manifestsByHash.get(descriptor.manifestHash);
      if (!manifest) return false;
      const projectionHash = await caseAdapterSpatialProjectionHash(manifest);
      const adapter = descriptor.executionStatus === "ready"
        ? await compileLockedCaseAdapterRuntime(
          manifest,
          modelsByHash.get(descriptor.modelHash ?? "") as CaseRuntimeModel,
          { projectionHash },
        )
        : await compileLockedCaseAdapterManifestRuntime(manifest, { projectionHash });
      if (adapter.adapterId !== descriptor.adapterId || adapter.adapterVersion !== descriptor.adapterVersion
        || adapter.authorityStatus !== descriptor.authorityStatus
        || adapter.identity.manifestHash !== descriptor.manifestHash
        || adapter.identity.projectionHash !== projectionHash
        || adapter.identity.skuId !== manifest.identity.skuId
        || adapter.identity.region !== manifest.identity.region
        || adapter.identity.revision !== manifest.identity.revision) return false;
      const blockedDomains = Object.values(adapter.domains).filter((domain) => domain.status === "blocked").length;
      if ((descriptor.executionStatus === "ready" && blockedDomains !== 0)
        || (descriptor.executionStatus === "partial" && blockedDomains === 0)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function evidenceContentHashFromFactRef(ref: string): string | null {
  // CaseRuntimeModel authorityRefs are explicitly EvidenceClaim content
  // hashes. Observation and generic artifact hashes cannot satisfy this role.
  const match = /^claim-sha256-([a-f0-9]{64})$/u.exec(ref);
  return match?.[1] ?? null;
}

/**
 * Executable means only that the declarative model can run. A model marked as
 * governed must independently close over the replay-locked fact snapshot; a
 * self-hashed model can never promote legacy data into governed authority.
 */
function verifyCaseRuntimeModelFactAuthorityClosure(
  artifacts: LoadedArtifactInputs,
  factClosure: ResolvedFactSnapshotClosure,
): boolean {
  const payload = artifacts.adapterSnapshot.payload as Partial<CaseAdapterArtifactPayload>;
  if (!Array.isArray(payload.runtimeModels)) return true;
  const factsById = new Map(factClosure.facts.map((fact) => [fact.factId, fact]));
  for (const model of payload.runtimeModels) {
    if (model.authorityStatus === "legacy_unverified") {
      if (model.authorityRefs.factIds.length !== 0 || model.authorityRefs.derivationIds.length !== 0
        || model.authorityRefs.evidenceContentHashes.length !== 0) return false;
      continue;
    }
    if (model.authorityStatus !== "governed_fact_derivation_bound") return false;
    const selected = model.authorityRefs.factIds.map((factId) => factsById.get(factId));
    if (selected.some((fact) => !fact || fact.status !== "active")) return false;
    const selectedFacts = selected as FactRecord[];
    const selectedIds = new Set(model.authorityRefs.factIds);
    if (selectedFacts.some((fact) => fact.derivedFromFactIds.some((factId) => !selectedIds.has(factId)))) return false;
    const derivationIds = [...new Set(selectedFacts.flatMap((fact) => fact.inferenceTraceId ? [fact.inferenceTraceId] : []))].sort();
    const evidenceContentHashes = [...new Set(selectedFacts.flatMap((fact) => fact.evidenceRefs
      .map(evidenceContentHashFromFactRef).filter((hash): hash is string => hash !== null)))].sort();
    if (stableAgentJson(derivationIds) !== stableAgentJson([...model.authorityRefs.derivationIds].sort())
      || stableAgentJson(evidenceContentHashes) !== stableAgentJson([...model.authorityRefs.evidenceContentHashes].sort())) return false;
  }
  return true;
}

function parsedArtifactSource(payload: unknown, moduleId: string): unknown | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const sources = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return null;
  const source = sources.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && (candidate as { moduleId?: unknown }).moduleId === moduleId) as { bytes?: unknown } | undefined;
  if (!source || typeof source.bytes !== "string") return null;
  try { return JSON.parse(source.bytes); }
  catch { return null; }
}

function validGenericArtifactTransitiveClosure(artifacts: LoadedArtifactInputs): boolean {
  const ruleClosure = parsedArtifactSource(artifacts.ruleSet.payload, "artifact/standard-set-transitive-closure");
  const engineClosure = parsedArtifactSource(artifacts.engine.payload, "artifact/evaluation-transitive-closure");
  return ruleClosure !== null && stableAgentJson(ruleClosure) === stableAgentJson(artifacts.standardSet.payload)
    && engineClosure !== null && stableAgentJson(engineClosure) === stableAgentJson({
      ruleSet: artifacts.ruleSet.payload,
      standardSet: artifacts.standardSet.payload,
      adapterSnapshot: artifacts.adapterSnapshot.payload,
    });
}

function lockedAdapterManifests(artifacts: LoadedArtifactInputs): CaseAdapterManifest[] {
  const payload = artifacts.adapterSnapshot.payload as Partial<CaseAdapterArtifactPayload>;
  return Array.isArray(payload.caseManifests) ? structuredClone(payload.caseManifests) : [];
}

function observationTargetsCaseInstance(
  observation: UserObservation,
  config: import("../topology/contracts").BuildConfigV3,
  instanceId: string,
): boolean {
  const subject = observation.subjectRef;
  if (subject.kind === "instance" || subject.kind === "port" || subject.kind === "firmware_instance") return subject.instanceId === instanceId;
  if (subject.kind === "mount") return subject.ownerInstanceId === instanceId;
  if (subject.kind === "placement") {
    return config.placements.find((placement) => placement.placementId === subject.placementId)?.mountOwnerInstanceId === instanceId;
  }
  if (subject.kind === "connection") {
    const connection = config.connections.find((candidate) => candidate.connectionId === subject.connectionId);
    return connection?.from.instanceId === instanceId || connection?.to.instanceId === instanceId;
  }
  return false;
}

async function caseInstanceObservationClosure(
  target: EvaluationTargetSnapshot,
  instanceId: string,
  closure: ResolvedObservationSnapshotClosure,
): Promise<ResolvedObservationSnapshotClosure> {
  const config = target.config;
  if (config.schemaVersion !== "3.0.0") throw new Error("case instance observation projection requires topology V3");
  const observations = closure.observations
    .filter((entry) => observationTargetsCaseInstance(entry.observation, config, instanceId))
    .sort((left, right) => left.observation.observationId.localeCompare(right.observation.observationId));
  const base = {
    schemaVersion: "user-observation-snapshot-v1" as const,
    snapshotId: `case-instance-observations-${instanceId}`,
    planId: target.planId,
    observationIds: observations.map((entry) => entry.observation.observationId),
    observationRecordHashes: Object.fromEntries(observations.map((entry) => [entry.observation.observationId, entry.recordHash])),
    createdAt: config.updatedAt,
  };
  return {
    snapshot: {
      ...base,
      contentHash: await hashContent(base, {
        domain: "user-observation-snapshot",
        schemaVersion: "user-observation-snapshot-v1",
      }),
    },
    observations: structuredClone(observations),
  };
}

async function resolveLockedCaseInstanceOverridesAtRoot(
  activeRoot: string,
  target: EvaluationTargetSnapshot,
  observationClosure: ResolvedObservationSnapshotClosure,
  artifacts: LoadedArtifactInputs,
  requireLockedManifests: boolean,
): Promise<CaseInstanceOverrides[]> {
  if (target.config.schemaVersion !== "3.0.0") return [];
  const config = structuredClone(target.config);
  const bySku = new Map<string, CaseAdapterManifest[]>();
  for (const manifest of lockedAdapterManifests(artifacts)) {
    bySku.set(manifest.identity.skuId, [...(bySku.get(manifest.identity.skuId) ?? []), manifest]);
  }
  const result: CaseInstanceOverrides[] = [];
  const instances = target.config.components
    .filter((component) => component.kind === "case" && component.identity.status === "resolved")
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  for (const instance of instances) {
    if (instance.identity.status !== "resolved") continue;
    const candidates = bySku.get(instance.identity.skuId) ?? [];
    if (candidates.length === 0) {
      if (requireLockedManifests) {
        throw new Error(`locked case adapter manifest is unavailable for ${instance.instanceId}`);
      }
      continue;
    }
    if (candidates.length !== 1) throw new Error(`locked case adapter identity is ambiguous for ${instance.instanceId}`);
    const manifest = candidates[0]!;
    const baseProjectionHash = await caseAdapterSpatialProjectionHash(manifest);
    const instanceObservationClosure = await caseInstanceObservationClosure(target, instance.instanceId, observationClosure);
    result.push(await resolveCaseInstanceOverridesAtRoot(activeRoot, {
      planId: target.planId,
      instanceId: instance.instanceId,
      observationSnapshotId: instanceObservationClosure.snapshot.snapshotId,
      observationSnapshotHash: instanceObservationClosure.snapshot.contentHash,
      baseManifestHash: manifest.contentHash,
      baseProjectionHash,
    }, {
      authorityKind: "case-instance-override-root-bound-v1",
      resolveCaseInstanceOverrideClosureAtRoot: async () => ({
        config: structuredClone(config),
        baseManifest: structuredClone(manifest),
        baseProjectionHash,
        observationClosure: structuredClone(instanceObservationClosure),
      }),
    }));
  }
  return result;
}

export async function verifyResolvedFactSnapshotClosure(closure: ResolvedFactSnapshotClosure): Promise<boolean> {
  if (!closure || typeof closure !== "object" || Array.isArray(closure)
    || !exactKeys(closure as unknown as Record<string, unknown>, ["snapshot", "facts", "conflicts", "decisions"])
    || !Array.isArray(closure.facts) || !Array.isArray(closure.conflicts) || !Array.isArray(closure.decisions)
    || !await verifyFactSnapshot(closure.snapshot)) return false;
  if (closure.facts.length !== closure.snapshot.factRefs.length || closure.conflicts.length !== closure.snapshot.conflictRefs.length) return false;
  const facts = new Map(closure.facts.map((fact) => [fact.factId, fact]));
  const conflicts = new Map(closure.conflicts.map((conflict) => [conflict.conflictSetId, conflict]));
  const decisions = new Map(closure.decisions.map((decision) => [decision.updateDecisionId, decision]));
  if (facts.size !== closure.facts.length || conflicts.size !== closure.conflicts.length || decisions.size !== closure.decisions.length) return false;
  for (const ref of closure.snapshot.factRefs) {
    const fact = facts.get(ref.factId);
    if (!fact || fact.contentHash !== ref.contentHash || !await verifyFactRecord(fact)) return false;
  }
  for (const ref of closure.snapshot.conflictRefs) {
    const conflict = conflicts.get(ref.conflictSetId);
    if (!conflict || conflict.contentHash !== ref.contentHash || !await verifyConflictSet(conflict)) return false;
    const subject = stableAgentJson(conflict.subject);
    if ([...conflict.factIds, ...conflict.resolutionFactIds].some((factId) => {
      const fact = facts.get(factId);
      return !fact || fact.field !== conflict.field || stableAgentJson(fact.subject) !== subject;
    })) return false;
    for (const decisionId of conflict.decisionIds) {
      const decision = decisions.get(decisionId);
      const memberIds = new Set([...conflict.factIds, ...conflict.resolutionFactIds]);
      if (!decision || !await verifyUpdateDecision(decision)
        || decision.subjectKey !== factSubjectKey(conflict.subject)
        || decision.claimKey !== conflict.field
        || [...decision.oldFactIds, ...decision.newFactIds].some((factId) => !memberIds.has(factId))
        || decision.fieldDiffs.some((field) => field.field !== conflict.field
          || [...field.beforeFactIds, ...field.afterFactIds].some((factId) => !memberIds.has(factId)))) return false;
    }
  }
  const referencedDecisionIds = new Set(closure.conflicts.flatMap((conflict) => conflict.decisionIds));
  if (closure.decisions.some((decision) => !referencedDecisionIds.has(decision.updateDecisionId))) return false;
  return true;
}

function verifyObservationClosure(closure: ResolvedObservationSnapshotClosure, planId: string, configHash: string): boolean {
  if (!closure || typeof closure !== "object" || Array.isArray(closure)
    || !exactKeys(closure as unknown as Record<string, unknown>, ["snapshot", "observations"])
    || !Array.isArray(closure.observations)
    || !verifyUserObservationSnapshotRuntime(closure.snapshot)
    || closure.snapshot.planId !== planId
    || closure.observations.length !== closure.snapshot.observationIds.length) return false;
  const records = new Map(closure.observations.map((entry) => [entry.observation.observationId, entry]));
  if (records.size !== closure.observations.length) return false;
  for (const observationId of closure.snapshot.observationIds) {
    const record = records.get(observationId);
    if (!record || !exactKeys(record as unknown as Record<string, unknown>, ["recordHash", "observation", "projectionContext", "attachmentClosureVerified"])
      || record.observation.planId !== planId || !verifyUserObservationRuntime(record.observation)
      || record.observation.status !== "active" || !record.observation.confirmedByUser
      || record.observation.validatedAt === undefined || record.observation.invalidatedAt !== undefined
      || record.attachmentClosureVerified !== true
      || record.projectionContext.planId !== planId || !record.projectionContext.subjectExists
      || record.projectionContext.currentConfigHash !== configHash
      || record.projectionContext.currentSubjectRevisionHash !== record.observation.subjectRevisionHash) return false;
    if (!isSha256Hex(record.recordHash)
      || record.recordHash !== sha256AgentValue(record.observation)
      || closure.snapshot.observationRecordHashes?.[observationId] !== record.recordHash) return false;
  }
  return true;
}

function clone<T>(value: T): T { return structuredClone(value); }

function assertLegacyUnlockedEvaluationAllowed(): void {
  if (factGraphFlagEnabled(process.env)) {
    throw new Error("fact graph is enabled; use AuthoritativeEvaluationSnapshotPipeline so repository snapshots and artifacts are locked");
  }
}

let catalogRepositoryOptions: AuthoritativeCatalogRepositoryOptions = {};

export function sha256AgentValue(value: unknown): string {
  return createHash("sha256").update(stableAgentJson(value)).digest("hex");
}

/**
 * Domain identity for fact-update comparison. `status: unknown` is explicit
 * for V3 partial evaluations: the hash records that the authoritative locked
 * input changed without pretending a compatibility/thermal verdict exists.
 */
export function authoritativeFactUpdateDomainHash(
  receipt: AuthoritativeEvaluationReceipt,
  domain: FactUpdateEvaluationDomain,
): string {
  const progressive = isProgressiveBuildEvaluation(receipt.evaluation)
    ? receipt.evaluation.domainEvaluations.find((candidate) => candidate.domain === domain) ?? null
    : null;
  return sha256AgentValue({
    domain: "authoritative-evaluation-domain",
    schemaVersion: "authoritative-evaluation-domain-v1",
    evaluationDomain: domain,
    status: isPlanPartialEvaluationV3(receipt.evaluation) ? "unknown"
      : progressive?.verdict ?? "governed",
    // Progressive evaluations expose the domain-scoped replay object while
    // retaining the exact lock identity used by the update transaction.
    domainEvaluation: progressive,
    ...(progressive === null && !isPlanPartialEvaluationV3(receipt.evaluation)
      ? { evaluationHash: receipt.evaluationHash } : {}),
    evaluationLockHash: receipt.evaluationLock.contentHash,
  });
}

/** Stable receipt projection consumed by FactUpdateNoticeService. */
export function factUpdateSnapshotReceipt(
  receipt: AuthoritativeEvaluationReceipt,
  domains: readonly FactUpdateEvaluationDomain[],
): SnapshotEvaluationReceipt {
  const domainHashes = Object.fromEntries([...new Set(domains)].sort().map((domain) => [
    domain,
    authoritativeFactUpdateDomainHash(receipt, domain),
  ])) as Partial<Record<FactUpdateEvaluationDomain, string>>;
  return {
    schemaVersion: FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION,
    planId: receipt.planId,
    target: clone(receipt.target),
    runtimeGeneration: receipt.runtimeGeneration,
    configHash: receipt.configHash,
    factSnapshotId: receipt.evaluationLock.factSnapshotId,
    factSnapshotHash: receipt.evaluationLock.snapshotHashes.factSnapshotHash,
    evaluationHash: receipt.evaluationHash,
    evaluationLock: clone(receipt.evaluationLock),
    domainHashes,
  };
}

/**
 * Fact-graph evaluation entry point. The transport supplies only a plan target
 * and optimistic guards; every input hash and payload is resolved by injected
 * repositories at one active-root barrier. Evaluation runs on the detached,
 * verified closure, then installs its receipt only after a second revision CAS.
 */
export class AuthoritativeEvaluationSnapshotPipeline {
  private readonly coordinator: RuntimeCoordinator;
  private readonly now: () => string;
  private readonly cache = new Map<string, GovernedEvaluationResult>();

  constructor(private readonly options: AuthoritativeEvaluationSnapshotPipelineOptions) {
    this.coordinator = options.coordinator ?? new RuntimeCoordinator({ root: path.resolve(options.runtimeRoot) });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private authorities(): {
    targets: EvaluationTargetAuthority;
    snapshots: EvaluationSnapshotAuthority;
    locks: EvaluationLockRepository;
    receipts: EvaluationReceiptAuthority;
    evaluator: GovernedEvaluationExecutor;
  } {
    if (!this.options.factGraphEnabled) throw new Error("authoritative snapshot evaluation requires the fact graph flag");
    const { targets, snapshots, locks, receipts, evaluator } = this.options;
    if (!targets || !snapshots || !locks || !receipts || !evaluator) {
      throw new Error("fact graph evaluation authority is unavailable; refusing an unlocked evaluation");
    }
    return { targets, snapshots, locks, receipts, evaluator };
  }

  private async readAndVerifyTarget(
    activeRoot: string,
    request: EvaluateCurrentPlanRequest,
    targets: EvaluationTargetAuthority,
  ): Promise<{ target: EvaluationTargetSnapshot; binding: EvaluationTargetBinding; configHash: string }> {
    const target = clone(await targets.readTargetAtRoot(activeRoot, request.planId, clone(request.target)));
    assertTargetOwnership(target, request.planId);
    const binding = targetBinding(target, request.target);
    const configHash = await hashPlanConfig(target.config);
    const expectedConfigHash = request.target.expectedConfigHash;
    if (expectedConfigHash !== undefined && expectedConfigHash !== configHash) throw new Error("evaluation target config hash conflict");
    return { target, binding, configHash };
  }

  private async loadArtifacts(
    activeRoot: string,
    activeRuntimeGeneration: number,
    target: EvaluationTargetSnapshot,
    authority: EvaluationSnapshotAuthority,
  ): Promise<{ artifacts: LoadedArtifactInputs; lockfile: ArtifactLockfile }> {
    const artifacts = clone(await authority.loadArtifactsAtRoot(
      activeRoot,
      clone(target),
      activeRuntimeGeneration,
    ));
    if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)
      || !exactKeys(artifacts as unknown as Record<string, unknown>, ARTIFACT_LOCK_ROLES)) {
      throw new Error("artifact authority returned an incomplete replay closure");
    }
    const entries = {} as Record<ArtifactLockRole, LockedArtifactRef>;
    const requireCurrentGenericClosure = this.options.genericAdaptersEnabled === true && target.pinnedEvaluationLock === undefined;
    for (const role of ARTIFACT_LOCK_ROLES) {
      const input = artifacts[role];
      const binding = EVALUATION_ARTIFACT_BINDINGS[role];
      if (!input || typeof input !== "object" || Array.isArray(input)
        || !exactKeys(input as unknown as Record<string, unknown>, ["ref", "payload"])
        || input.ref.role !== role
        || input.ref.domain !== binding.domain || input.ref.schemaVersion !== "1.0.0"
        || input.ref.mediaType !== binding.media
        || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
        || (role === "systemProfile"
          ? !["workspace-system-profile-v1", "workspace-system-profile-v2"].includes(String((input.payload as { schemaVersion?: unknown }).schemaVersion))
          : (input.payload as { schemaVersion?: unknown }).schemaVersion !== binding.payloadSchema)
        || !await validEvaluationArtifactPayload(role, input.payload, requireCurrentGenericClosure)
        || !await verifyContentAddressedRef(input.payload, artifactContentRef(input.ref))) {
        throw new Error(`artifact ${role} payload/ref closure invalid`);
      }
      entries[role] = clone(input.ref);
    }
    if (requireCurrentGenericClosure && !validGenericArtifactTransitiveClosure(artifacts)) {
      throw new Error("generic artifact transitive closure invalid");
    }
    if (requireCurrentGenericClosure) {
      const registry = (artifacts.adapterSnapshot.payload as CaseAdapterArtifactPayload).runtimeRegistry;
      if (registry.schemaVersion !== "runtime-case-adapter-registry-binding-v2"
        || registry.activeRuntimeGeneration !== activeRuntimeGeneration) {
        throw new Error("current generic adapter snapshot does not bind the coordinator runtime generation");
      }
    }
    return {
      artifacts,
      lockfile: await createArtifactLockfile(entries as ArtifactLockEntries),
    };
  }

  private async prepareAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    request: EvaluateCurrentPlanRequest,
    authority: ReturnType<AuthoritativeEvaluationSnapshotPipeline["authorities"]>,
    factResolver?: (target: EvaluationTargetSnapshot) => Promise<ResolvedFactSnapshotClosure>,
  ): Promise<PreparedEvaluation> {
    const { target, binding, configHash } = await this.readAndVerifyTarget(activeRoot, request, authority.targets);
    const factClosure = clone(await (factResolver
      ? factResolver(clone(target))
      : authority.snapshots.resolveFactSnapshotAtRoot(activeRoot, clone(target))));
    if (!await verifyResolvedFactSnapshotClosure(factClosure)) throw new Error("fact snapshot payload closure is invalid or dangling");
    const { artifacts, lockfile: artifactLockfile } = await this.loadArtifacts(
      activeRoot,
      runtimeGeneration,
      target,
      authority.snapshots,
    );
    if (!verifyCaseRuntimeModelFactAuthorityClosure(artifacts, factClosure)) {
      throw new Error("case runtime model governed fact/derivation/evidence closure is invalid or dangling");
    }
    const observationClosure = clone(await authority.snapshots.resolveObservationSnapshotAtRoot(activeRoot, clone(target), clone(artifacts)));
    if (!verifyObservationClosure(observationClosure, request.planId, configHash)) throw new Error("observation snapshot payload closure is invalid or dangling");
    const factSnapshot = factClosure.snapshot;
    const observationSnapshot = observationClosure.snapshot;
    const caseInstanceOverrides = await resolveLockedCaseInstanceOverridesAtRoot(
      activeRoot,
      target,
      observationClosure,
      artifacts,
      this.options.genericAdaptersEnabled === true && target.pinnedEvaluationLock === undefined,
    );
    for (const role of ARTIFACT_LOCK_ROLES) await authority.locks.putArtifactPayloadAtRoot(activeRoot, artifacts[role]);
    const externalInputs = clone(await authority.snapshots.loadExternalInputsAtRoot(activeRoot, clone(target), {
      factSnapshot: clone(factSnapshot),
      observationSnapshot: clone(observationSnapshot),
      artifactLockfile: clone(artifactLockfile),
      caseInstanceOverrides: clone(caseInstanceOverrides),
    }));
    await assertExternalInputs(externalInputs, {
      planId: request.planId,
      requireCaseInstanceOverrides: this.options.genericAdaptersEnabled === true && target.pinnedEvaluationLock === undefined,
    });
    for (const role of ["requirementSpec", "priceSnapshot", "simulationInput"] as const) {
      await authority.locks.putExternalSnapshotAtRoot(activeRoot, role, externalInputs[role]);
    }
    const snapshotHashes: SnapshotHashes = Object.freeze({
      configHash,
      requirementSpecHash: externalInputs.requirementSpec.ref.contentHash,
      factSnapshotHash: factSnapshot.contentHash,
      userObservationSnapshotHash: observationSnapshot.contentHash,
      priceSnapshotHash: externalInputs.priceSnapshot.ref.contentHash,
      ruleSetHash: artifactLockfile.artifacts.ruleSet.contentHash,
      systemProfileHash: artifactLockfile.artifacts.systemProfile.contentHash,
      adapterSnapshotHash: artifactLockfile.artifacts.adapterSnapshot.contentHash,
      engineHash: artifactLockfile.artifacts.engine.contentHash,
      simulationModelHash: artifactLockfile.artifacts.simulationModel.contentHash,
      simulationInputHash: externalInputs.simulationInput.ref.contentHash,
    });
    await authority.locks.putArtifactLockfileAtRoot(activeRoot, artifactLockfile);
    const evaluationLock = await createPlanEvaluationLock({
      planId: request.planId,
      snapshotHashes,
      factSnapshotId: factSnapshot.snapshotId,
      userObservationSnapshotId: observationSnapshot.snapshotId,
      artifactLockfileHash: artifactLockfile.lockfileHash,
    });
    if (target.pinnedEvaluationLock
      && stableAgentJson(target.pinnedEvaluationLock) !== stableAgentJson(evaluationLock)) {
      throw new Error("immutable PlanVersion evaluation lock closure changed");
    }
    await authority.locks.putEvaluationLockAtRoot(activeRoot, evaluationLock);
    const persistedReceipt = await authority.receipts.getReceiptByLockAtRoot(
      activeRoot,
      request.planId,
      binding,
      evaluationLock.contentHash,
    );
    return {
      target, targetBinding: binding, configHash, factClosure, observationClosure, artifacts, artifactLockfile,
      externalInputs, snapshotHashes, evaluationLock, runtimeGeneration, persistedReceipt,
    };
  }

  private async validateResult(prepared: PreparedEvaluation, value: GovernedEvaluationResult): Promise<GovernedEvaluationResult> {
    const result = clone(value);
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !exactKeys(result as unknown as Record<string, unknown>, ["evaluation", "catalogVersion", "priceSnapshotVersion"])
      || typeof result.catalogVersion !== "string" || !result.catalogVersion
      || (result.priceSnapshotVersion !== null && (typeof result.priceSnapshotVersion !== "string" || !result.priceSnapshotVersion))) {
      throw new Error("governed evaluator returned an invalid result envelope");
    }
    const config = prepared.target.config;
    if (config.schemaVersion === "3.0.0") {
      if (!await matchesBuildConfigV3Evaluation(config, result.evaluation)) {
        throw new Error("governed evaluator returned a V3 evaluation that does not match the locked topology");
      }
    } else {
      if (isTopologyEvaluationV3(result.evaluation)) throw new Error("governed evaluator returned a V3 topology evaluation for V2 config");
      if (await hashPlanConfig(result.evaluation.config) !== prepared.configHash) {
        throw new Error("governed evaluator evaluation.config does not match the locked plan config");
      }
    }
    return result;
  }

  private async execute(prepared: PreparedEvaluation, evaluator: GovernedEvaluationExecutor): Promise<GovernedEvaluationResult> {
    return this.validateResult(prepared, clone(await evaluator({
      planId: prepared.target.planId,
      planVersionId: prepared.target.planVersionId,
      draftRevision: prepared.target.draftRevision,
      config: clone(prepared.target.config),
      snapshotHashes: clone(prepared.snapshotHashes),
      factClosure: clone(prepared.factClosure),
      observationClosure: clone(prepared.observationClosure),
      artifactLockfile: clone(prepared.artifactLockfile),
      artifacts: clone(prepared.artifacts),
      externalInputs: clone(prepared.externalInputs),
      evaluationLock: clone(prepared.evaluationLock),
    })));
  }

  /**
   * Resolves a server-owned candidate config against the current active-root
   * authorities without installing an evaluation receipt. Callers must already
   * hold the coordinator barrier represented by `activeRoot` and
   * `runtimeGeneration`.
   */
  async resolveDetachedCandidateAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    input: DetachedCandidateEvaluationInput,
  ): Promise<GovernedEvaluationInput> {
    if (!activeRoot || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1
      || !input || input.config?.schemaVersion !== "3.0.0") {
      throw new TypeError("detached candidate evaluation input is invalid");
    }
    const authority = this.authorities();
    const configHash = await hashPlanConfig(input.config);
    const request: EvaluateCurrentPlanRequest = {
      planId: input.planId,
      target: {
        kind: "version",
        versionId: input.basePlanVersionId,
        expectedConfigHash: configHash,
      },
    };
    const target: EvaluationTargetSnapshot = {
      planId: input.planId,
      planVersionId: input.basePlanVersionId,
      draftRevision: 0,
      config: clone(input.config),
    };
    const prepared = await this.prepareAtRoot(activeRoot, runtimeGeneration, request, {
      ...authority,
      targets: {
        readTargetAtRoot: async () => clone(target),
      },
    });
    return {
      planId: input.planId,
      planVersionId: input.basePlanVersionId,
      draftRevision: 0,
      config: clone(prepared.target.config),
      snapshotHashes: clone(prepared.snapshotHashes),
      factClosure: clone(prepared.factClosure),
      observationClosure: clone(prepared.observationClosure),
      artifactLockfile: clone(prepared.artifactLockfile),
      artifacts: clone(prepared.artifacts),
      externalInputs: clone(prepared.externalInputs),
      evaluationLock: clone(prepared.evaluationLock),
    };
  }

  /** Execute a server-resolved detached candidate with the same evaluator as
   * the workspace path. This method accepts no transport-shaped request and
   * rechecks the complete lock/ref closure before evaluation. */
  async evaluateDetachedGovernedInput(input: GovernedEvaluationInput): Promise<GovernedEvaluationResult> {
    if (!input || input.config.schemaVersion !== "3.0.0" || input.planVersionId === null
      || input.evaluationLock.planId !== input.planId
      || stableAgentJson(input.evaluationLock.snapshotHashes) !== stableAgentJson(input.snapshotHashes)
      || input.evaluationLock.artifactLockfileHash !== input.artifactLockfile.lockfileHash
      || input.externalInputs.requirementSpec.ref.contentHash !== input.snapshotHashes.requirementSpecHash
      || input.externalInputs.priceSnapshot.ref.contentHash !== input.snapshotHashes.priceSnapshotHash
      || input.externalInputs.simulationInput.ref.contentHash !== input.snapshotHashes.simulationInputHash
      || await hashPlanConfig(input.config) !== input.snapshotHashes.configHash
      || !await verifyResolvedFactSnapshotClosure(clone(input.factClosure))
      || !verifyObservationClosure(clone(input.observationClosure), input.planId, input.snapshotHashes.configHash)) {
      throw new Error("detached candidate governed input closure is invalid");
    }
    for (const role of ARTIFACT_LOCK_ROLES) {
      const artifact = input.artifacts[role];
      const locked = input.artifactLockfile.artifacts[role];
      if (!artifact || stableAgentJson(artifact.ref) !== stableAgentJson(locked)) {
        throw new Error(`detached candidate ${role} lock binding is invalid`);
      }
    }
    const hashBindings: Array<[ArtifactLockRole, keyof SnapshotHashes]> = [
      ["ruleSet", "ruleSetHash"], ["systemProfile", "systemProfileHash"], ["adapterSnapshot", "adapterSnapshotHash"],
      ["engine", "engineHash"], ["simulationModel", "simulationModelHash"],
    ];
    if (hashBindings.some(([role, field]) => input.artifacts[role].ref.contentHash !== input.snapshotHashes[field])) {
      throw new Error("detached candidate artifact snapshot binding is invalid");
    }
    const prepared: PreparedEvaluation = {
      target: { planId: input.planId, planVersionId: input.planVersionId, draftRevision: input.draftRevision, config: clone(input.config) },
      targetBinding: { kind: "version", versionId: input.planVersionId },
      configHash: input.snapshotHashes.configHash,
      factClosure: clone(input.factClosure), observationClosure: clone(input.observationClosure),
      artifacts: clone(input.artifacts), artifactLockfile: clone(input.artifactLockfile), externalInputs: clone(input.externalInputs),
      snapshotHashes: clone(input.snapshotHashes), evaluationLock: clone(input.evaluationLock), runtimeGeneration: 1, persistedReceipt: null,
    };
    return this.execute(prepared, this.authorities().evaluator);
  }

  private async evaluatePrepared(
    request: EvaluateCurrentPlanRequest,
    authority: ReturnType<AuthoritativeEvaluationSnapshotPipeline["authorities"]>,
    prepared: PreparedEvaluation,
    preparedRevision: number,
    options: {
      installCurrent: boolean;
      verifyFactCandidateAtRoot?: (activeRoot: string, target: EvaluationTargetSnapshot) => Promise<ResolvedFactSnapshotClosure>;
      reprepareCandidateAtCommit?: boolean;
    },
  ): Promise<AuthoritativeEvaluationReceipt> {
    const memoryCached = this.cache.get(prepared.evaluationLock.contentHash);
    const persistedCached = prepared.persistedReceipt
      ? await this.validateResult(prepared, {
        evaluation: clone(prepared.persistedReceipt.evaluation),
        catalogVersion: prepared.persistedReceipt.catalogVersion,
        priceSnapshotVersion: prepared.persistedReceipt.priceSnapshotVersion,
      })
      : null;
    const cached = memoryCached ? clone(memoryCached) : persistedCached;
    const cacheStatus = cached ? "hit" as const : "miss" as const;
    const result = cached ?? await this.execute(prepared, authority.evaluator);
    const evaluationHash = await authoritativeEvaluationHash(result.evaluation, prepared.evaluationLock);
    const evaluatedAt = this.now();
    const committed = await this.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number; revision: number };
    }) => {
      if (state.runtimeGeneration !== prepared.runtimeGeneration) throw new Error("runtime generation changed during evaluation");
      const current = await this.readAndVerifyTarget(activeRoot, request, authority.targets);
      if (current.configHash !== prepared.configHash
        || JSON.stringify(current.binding) !== JSON.stringify(prepared.targetBinding)) throw new Error("plan target changed during evaluation");
      if (options.verifyFactCandidateAtRoot) {
        if (options.reprepareCandidateAtCommit) {
          const finalPrepared = await this.prepareAtRoot(
            activeRoot,
            state.runtimeGeneration,
            request,
            authority,
            (target) => options.verifyFactCandidateAtRoot!(activeRoot, target),
          );
          if (finalPrepared.evaluationLock.contentHash !== prepared.evaluationLock.contentHash) {
            throw new Error("authorized fact candidate evaluation closure changed during evaluation");
          }
        } else {
          const candidate = clone(await options.verifyFactCandidateAtRoot(activeRoot, clone(current.target)));
          if (!await verifyResolvedFactSnapshotClosure(candidate)
            || candidate.snapshot.snapshotId !== prepared.factClosure.snapshot.snapshotId
            || candidate.snapshot.contentHash !== prepared.factClosure.snapshot.contentHash) {
            throw new Error("authorized fact candidate changed during evaluation");
          }
        }
      }
      if (!await authority.locks.verifyAtRoot(activeRoot, prepared.evaluationLock)) throw new Error("evaluation lock closure changed during evaluation");
      const receiptPreparedRevision = options.reprepareCandidateAtCommit ? state.revision : preparedRevision;
      const receipt: AuthoritativeEvaluationReceipt = {
        schemaVersion: "authoritative-evaluation-receipt-v1",
        planId: request.planId,
        target: clone(prepared.targetBinding),
        runtimeGeneration: prepared.runtimeGeneration,
        preparedRevision: receiptPreparedRevision,
        committedRevision: state.revision + 1,
        configHash: prepared.configHash,
        evaluationHash,
        evaluationLock: clone(prepared.evaluationLock),
        evaluatedAt,
        evaluation: clone(result.evaluation),
        catalogVersion: result.catalogVersion,
        priceSnapshotVersion: result.priceSnapshotVersion,
        cacheStatus,
      };
      const persisted = await authority.receipts.commitAtRoot(activeRoot, clone(receipt), {
        installCurrent: options.installCurrent,
      });
      if (stableAgentJson(persisted) !== stableAgentJson(receipt)) {
        throw new Error("evaluation receipt repository did not round-trip the committed envelope");
      }
      return persisted;
    }, options.reprepareCandidateAtCommit ? {} : { expectedRevision: preparedRevision });
    this.cache.set(prepared.evaluationLock.contentHash, clone(result));
    return clone(committed.result as AuthoritativeEvaluationReceipt);
  }

  async evaluateCurrent(value: unknown): Promise<AuthoritativeEvaluationReceipt> {
    validateEvaluateCurrentRequest(value);
    const request = clone(value);
    const authority = this.authorities();
    await this.coordinator.initialize();
    const preparedResult = await this.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number };
    }) => this.prepareAtRoot(activeRoot, state.runtimeGeneration, request, authority));
    return this.evaluatePrepared(
      request,
      authority,
      preparedResult.result as PreparedEvaluation,
      preparedResult.state.revision as number,
      { installCurrent: true },
    );
  }

  /**
   * Internal update-service entry point. The durable notice authority chooses
   * the before/after snapshot at both barriers. Its immutable receipt is
   * persisted for replay, but the plan's current evaluation pointer is not
   * changed before the user accepts the update.
   */
  async evaluateAuthorizedFactCandidate(value: unknown): Promise<AuthoritativeEvaluationReceipt> {
    validateAuthorizedFactCandidateRequest(value);
    const request = clone(value);
    const authority = this.authorities();
    const candidates = this.options.factCandidates;
    if (!candidates) throw new Error("authorized fact candidate authority is unavailable");
    const resolve = (activeRoot: string, target: EvaluationTargetSnapshot) => candidates.resolveAtRoot(activeRoot, {
      planId: request.planId,
      target: clone(target),
      targetRequest: clone(request.target),
      updateNoticeId: request.updateNoticeId,
      phase: request.phase,
    });
    await this.coordinator.initialize();
    const preparedResult = await this.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number };
    }) => this.prepareAtRoot(
      activeRoot,
      state.runtimeGeneration,
      request,
      authority,
      (target) => resolve(activeRoot, target),
    ));
    return this.evaluatePrepared(
      request,
      authority,
      preparedResult.result as PreparedEvaluation,
      preparedResult.state.revision as number,
      {
        installCurrent: false,
        verifyFactCandidateAtRoot: resolve,
        reprepareCandidateAtCommit: true,
      },
    );
  }

  /** Resolves the current lock from the receipt repository; callers cannot nominate it. */
  async assessFreshness(snapshot: PlanEvaluationSnapshot, target: EvaluationTargetBinding): Promise<EvaluationFreshness> {
    const authority = this.authorities();
    await this.coordinator.initialize();
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const current = await authority.receipts.currentLockAtRoot(activeRoot, snapshot.planId, clone(target));
      return assessEvaluationFreshness(snapshot, current, (lock) => authority.locks.verifyAtRoot(activeRoot, lock));
    })).result as EvaluationFreshness;
  }

  clearCache(): void { this.cache.clear(); }
}

export function configureAuthoritativeCatalogRepository(options: AuthoritativeCatalogRepositoryOptions): void {
  catalogRepositoryOptions = { ...options };
}

function configuredRuntimeRoot(): string | undefined {
  const configured = [catalogRepositoryOptions.runtimeRoot, catalogRepositoryOptions.priceRuntimeRoot]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => path.resolve(value));
  if (new Set(configured).size > 1) throw new Error("catalog and price runtime roots must resolve to the same active generation");
  return configured[0];
}

function consistentRuntimeSnapshot(): { runtimeRoot: string; activeRoot: string; priceSnapshot: PriceSnapshotFile } | null {
  const runtimeRoot = configuredRuntimeRoot();
  if (!runtimeRoot) return null;
  const activeRoot = resolveActiveGenerationRoot(runtimeRoot);
  return {
    runtimeRoot,
    activeRoot,
    priceSnapshot: loadRuntimePriceSnapshot({ runtimeRoot, activeRoot, allowSeedFallback: false }),
  };
}

function loadAuthoritativeCatalogWithoutPrices(): SkuCatalog {
  const runtimeRoot = configuredRuntimeRoot();
  if (runtimeRoot) {
    const activeRoot = resolveActiveGenerationRoot(runtimeRoot);
    return loadMergedCatalogSync({ ...catalogRepositoryOptions, activeRoot, generationAware: true }) as SkuCatalog;
  }
  return loadMergedCatalogSync(catalogReadOptions()) as SkuCatalog;
}

function catalogReadOptions(): AuthoritativeCatalogRepositoryOptions & { direct?: boolean } {
  if (configuredRuntimeRoot() || catalogRepositoryOptions.generationAware === true) return catalogRepositoryOptions;
  // Unit/offline callers without a runtime root consume the immutable seed (and
  // an explicitly configured legacy test overlay) rather than inventing an
  // uninitialised active-generation pointer in the source checkout.
  return { ...catalogRepositoryOptions, direct: true, generationAware: false };
}

export function loadAuthoritativeCatalog(snapshot?: PriceSnapshotFile): SkuCatalog {
  // An evaluation must bind its catalog merge and reported price version to the
  // same immutable generation. Callers that already resolved a snapshot pass it
  // through instead of resolving the active pointer a second time.
  const consistent = consistentRuntimeSnapshot();
  if (consistent) {
    const catalog = loadMergedCatalogSync({ ...catalogRepositoryOptions, activeRoot: consistent.activeRoot, generationAware: true }) as SkuCatalog;
    return applyPriceSnapshot(catalog, snapshot ?? consistent.priceSnapshot);
  }
  return applyPriceSnapshot(loadMergedCatalogSync(catalogReadOptions()) as SkuCatalog, snapshot ?? loadAuthoritativePriceSnapshot());
}

export function loadAuthoritativeCatalogAtRoot(activeRoot: string, options: { runtimeRoot?: string } = {}): SkuCatalog {
  return loadMergedCatalogSync({
    activeRoot,
    ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
    generationAware: true,
  }) as SkuCatalog;
}

export function loadAuthoritativePriceSnapshot() {
  return loadRuntimePriceSnapshot({
    ...(catalogRepositoryOptions.priceRuntimeRoot ?? catalogRepositoryOptions.runtimeRoot ?? catalogRepositoryOptions.persistRoot ? { runtimeRoot: catalogRepositoryOptions.priceRuntimeRoot ?? catalogRepositoryOptions.runtimeRoot ?? catalogRepositoryOptions.persistRoot } : {}),
    ...(catalogRepositoryOptions.allowSeedPriceFallback !== undefined ? { allowSeedFallback: catalogRepositoryOptions.allowSeedPriceFallback } : {}),
  });
}

export function parseAuthoritativeBuildConfigDocument(
  value: unknown,
  catalog: SkuCatalog = loadAuthoritativeCatalog(),
  options: { topologyV3Enabled?: boolean; caseRuntimeRegistry?: CaseRuntimeAdapterRegistry } = {},
): BuildConfigDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("buildConfig must be an object");
  const config = parseConfig(JSON.stringify(value), { topologyV3Enabled: options.topologyV3Enabled === true });
  const adapterCapabilities = config.schemaVersion === "2.0.0" && options.caseRuntimeRegistry
    ? options.caseRuntimeRegistry.resolveLegacySku(config.caseId)?.capabilities ?? null
    : undefined;
  assertValidConfig(config, catalog, {
    topologyV3Enabled: options.topologyV3Enabled === true,
    ...(adapterCapabilities !== undefined ? { caseCapabilities: adapterCapabilities } : {}),
  });
  return config;
}

export function parseAuthoritativeBuildConfig(
  value: unknown,
  catalog: SkuCatalog = loadAuthoritativeCatalog(),
  caseRuntimeRegistry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
): BuildConfig {
  const config = parseAuthoritativeBuildConfigDocument(value, catalog, {
    topologyV3Enabled: false,
    caseRuntimeRegistry,
  });
  if (config.schemaVersion !== "2.0.0") throw new Error("Authoritative BuildEvaluation currently requires BuildConfig V2");
  return config;
}

export function evaluateBuildDocumentAuthoritatively(
  value: unknown,
  catalog?: SkuCatalog,
  options: { topologyV3Enabled?: boolean; caseRuntimeRegistry?: CaseRuntimeAdapterRegistry } = {},
): AuthoritativeEvaluationResponse {
  assertLegacyUnlockedEvaluationAllowed();
  if (value && typeof value === "object" && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === "3.0.0") {
    // A V3 partial evaluation deliberately makes no price claim. Resolve the
    // governed catalog from the active generation without requiring prices/latest.json;
    // price availability must not block progressive topology capture.
    const resolvedCatalog = catalog ?? loadAuthoritativeCatalogWithoutPrices();
    const config = parseAuthoritativeBuildConfigDocument(value, resolvedCatalog, { topologyV3Enabled: options.topologyV3Enabled === true });
    if (config.schemaVersion !== "3.0.0") throw new Error("BuildConfig V3 evaluation schema mismatch");
    const evaluation: PlanEvaluation = createPlanPartialEvaluationV3(config);
    const payload = authoritativeEvaluationPayload(evaluation);
    return {
      schemaVersion: AGENT_EVALUATION_SCHEMA_VERSION,
      configHash: hashPlanConfigRuntime(config),
      evaluationHash: sha256AgentValue(payload),
      catalogVersion: resolvedCatalog.catalogVersion ?? `${resolvedCatalog.schemaVersion}:${resolvedCatalog.updatedAt}`,
      priceSnapshotVersion: null,
      evaluation,
    };
  }
  return evaluateBuildAuthoritatively(value, catalog, options.caseRuntimeRegistry);
}

export function evaluateBuildAuthoritatively(
  value: unknown,
  catalog?: SkuCatalog,
  caseRuntimeRegistry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
): AuthoritativeEvaluationResponseV2 {
  assertLegacyUnlockedEvaluationAllowed();
  const consistent = catalog ? null : consistentRuntimeSnapshot();
  const snapshot = consistent?.priceSnapshot ?? loadAuthoritativePriceSnapshot();
  // When the caller did not supply a pre-resolved catalog, merge the exact
  // snapshot selected above. This avoids a restore/pointer switch between the
  // catalog read and the version reported in the response.
  const resolvedCatalog = catalog ?? (consistent
    ? applyPriceSnapshot(loadMergedCatalogSync({ ...catalogRepositoryOptions, activeRoot: consistent.activeRoot, generationAware: true }) as SkuCatalog, snapshot)
    : loadAuthoritativeCatalog(snapshot));
  const config = parseAuthoritativeBuildConfig(value, resolvedCatalog, caseRuntimeRegistry);
  const evaluation = evaluateBuild(config, resolvedCatalog, undefined, caseRuntimeRegistry);
  const payload = authoritativeEvaluationPayload(evaluation);
  return {
    schemaVersion: AGENT_EVALUATION_SCHEMA_VERSION,
    configHash: sha256AgentValue(config),
    evaluationHash: sha256AgentValue(payload),
    catalogVersion: resolvedCatalog.catalogVersion ?? `${resolvedCatalog.schemaVersion}:${resolvedCatalog.updatedAt}`,
    priceSnapshotVersion: `${snapshot.schemaVersion}:${snapshot.asOf}`,
    evaluation,
  };
}
