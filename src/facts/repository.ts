import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import { verifyEvidenceClaim } from "../evidence/claims";
import type { EvidenceClaim } from "../evidence/contracts";
import { canProjectUserObservation, type ObservationProjectionContext, type UserObservation } from "../observations/contracts";
import {
  canFactAloneSupportSafetyPass,
  validateConflictSet,
  validateFactRecord,
  validateFactSnapshot,
  type ConflictSet,
  type FactRecord,
  type FactSnapshot,
  type FactSubject,
  type UpdateDecision,
} from "./contracts";
import { createConflictSet, verifyConflictSet } from "./conflicts";
import { verifyFactRecord } from "./hash";
import { factSubjectKey } from "./resolver";
import { createFactSnapshot, verifyFactSnapshot } from "./snapshots";
import { verifyUpdateDecision } from "./update-decisions";
import {
  validateReplayableInferenceTrace,
  verifyReplayableInferenceTrace,
  inferenceTraceIsCurrent,
  type ReplayableInferenceTrace,
} from "./inference-policy";
import { factFieldPolicy } from "./field-registry";
import { validateInferenceApprovalTransactionRuntime } from "./inference-candidate-runtime.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;
const OBSERVATION_REF = /^observation:([A-Za-z0-9][A-Za-z0-9._-]{0,159})@sha256:([a-f0-9]{64})$/;
export const LEGACY_INFERENCE_IMPORT_CAPABILITY = "fact-inference-legacy-import-v1" as const;

export class FactRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "FactRepositoryError";
  }
}

export interface EvidenceClaimClosureLookup {
  getClaim(claimId: string): Promise<EvidenceClaim | null>;
  getClaimAtRoot?(activeRoot: string, claimId: string): Promise<EvidenceClaim | null>;
}

export interface ObservationFactClosure {
  observation: UserObservation;
  context: ObservationProjectionContext;
}

export interface ObservationFactClosureLookup {
  resolveForFact(planId: string, observationId: string): Promise<ObservationFactClosure | null>;
  resolveForFactAtRoot?(activeRoot: string, planId: string, observationId: string): Promise<ObservationFactClosure | null>;
}

/**
 * The provider must return only a decision which is the active committed
 * memory head. FactRepository still verifies the complete decision payload and
 * its conflict/fact ownership before accepting a resolution transition.
 */
export interface AcceptedUpdateDecisionClosureLookup {
  getActiveDecision(decisionId: string): Promise<UpdateDecision | null>;
  getActiveDecisionAtRoot?(activeRoot: string, decisionId: string): Promise<UpdateDecision | null>;
}

/** Internal plan authority. Fact IDs are never accepted by transport routes. */
export interface PlanFactSelectionAuthority {
  selectRelevantProductFactIdsAtRoot(
    activeRoot: string,
    planId: string,
    currentProductFacts: readonly Readonly<FactRecord>[],
  ): Promise<readonly string[]>;
}

interface StoredFact {
  schemaVersion: "fact-repository-v1";
  revision: 0;
  recordHash: string;
  fact: FactRecord;
}

interface StoredConflict {
  schemaVersion: "fact-repository-v1";
  revision: number;
  recordHash: string;
  conflict: ConflictSet;
}

interface Envelope<T> {
  schemaVersion: "fact-repository-envelope-v1";
  kind: "fact" | "conflict" | "conflict-pointer" | "snapshot" | "inference" | "inference-approval";
  checksum: string;
  payload: T;
}

export interface FactRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  now?: () => string;
  evidenceClaims?: EvidenceClaimClosureLookup;
  observations?: ObservationFactClosureLookup;
  acceptedUpdateDecisions?: AcceptedUpdateDecisionClosureLookup;
  planFactSelection?: PlanFactSelectionAuthority;
  currentInferenceArtifactHash?: (trace: ReplayableInferenceTrace, activeRoot?: string) => string | null | Promise<string | null>;
  inferenceCandidateApprovalAuthority?: InferenceCandidateApprovalAuthority;
  /** Production/read-model mode: Agent inference without a committed candidate approval is never current. */
  requireCandidateApprovalForInference?: boolean;
  /** Test/host crash seam; production composition leaves this undefined. */
  inferenceApprovalFaultInjector?: (
    point: "after_trace_write",
    context: Readonly<{ transactionId: string; trace: ReplayableInferenceTrace; fact: FactRecord }>,
  ) => void | Promise<void>;
}

export interface PutFactInput {
  fact: FactRecord;
  expectedHash?: string;
  maintenanceLeaseToken?: string;
}

export interface PutLegacyInferenceFactInput extends PutFactInput {
  legacyImportCapability: typeof LEGACY_INFERENCE_IMPORT_CAPABILITY;
}

export interface PutConflictInput {
  conflict: ConflictSet;
  expectedHash?: string;
  maintenanceLeaseToken?: string;
}

export interface CreateFactSnapshotInput {
  factIds?: string[];
  conflictSetIds?: string[];
  expectedActiveSetHash?: string;
  maintenanceLeaseToken?: string;
}

export interface ResolvedFactRepositorySnapshotClosure {
  snapshot: FactSnapshot;
  facts: FactRecord[];
  conflicts: ConflictSet[];
}

export interface CreateFactUpdateCandidateSnapshotInput {
  planId: string;
  baseSnapshotId: string;
  subjectKey: string;
  field: string;
  /** Server-selected current facts for this exact governed subject and field. */
  replacementFactIds: readonly string[];
}

export interface FactConflictStateRef {
  conflictSetId: string;
  contentHash: string;
}

export interface FactUpdateConflictPointer {
  schemaVersion: "fact-update-conflict-pointer-v1";
  conflictKey: string;
  conflictSetId: string;
  revision: number;
  decisionId: string;
  decisionHash: string;
  decisionMemoryKey: string;
  selectedConflictRef: FactConflictStateRef;
  previousConflictRef: FactConflictStateRef;
  previousDecisionId?: string;
  previousDecisionHash?: string;
  updatedAt: string;
}

/** Exact immutable transition embedded in the update recovery transaction. */
export interface FactUpdateConflictTransition {
  schemaVersion: "fact-update-conflict-transition-v1";
  pointer: FactUpdateConflictPointer;
  before: ConflictSet;
  after: ConflictSet;
}

export interface PutInferenceTraceInput {
  trace: ReplayableInferenceTrace;
  /** Explicit maintenance-only seam for pre-U4 replay authorities. */
  legacyImportCapability?: typeof LEGACY_INFERENCE_IMPORT_CAPABILITY;
  maintenanceLeaseToken?: string;
}

export interface PutInferenceFactWithTraceInput {
  trace: ReplayableInferenceTrace;
  fact: FactRecord;
  maintenanceLeaseToken?: string;
}

export interface InferenceCandidateApprovalClosure {
  readonly candidate: { readonly candidateId: string; readonly contentHash: string };
  readonly trace: ReplayableInferenceTrace;
  readonly proposedFact: FactRecord;
}

export interface InferenceCandidateApprovalAuthority {
  /** Object-identity capability retained only by the production approval composition. */
  readonly approvalCapability: object;
  resolveForApprovalAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    expectedCandidateHash: string,
  ): Promise<InferenceCandidateApprovalClosure>;
  /** Read-side replay used to invalidate committed facts on plan/input/rule drift. */
  resolveCurrentFactAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    expectedCandidateHash: string,
    currentFacts: readonly Readonly<FactRecord>[],
  ): Promise<InferenceCandidateApprovalClosure | null>;
}

export interface PutInferenceCandidateApprovalInput {
  candidateId: string;
  expectedCandidateHash: string;
  /** Durable server-issued approval artifact for the exact approve Tool call. */
  approvalAuthorityRef?: `sha256:${string}`;
  /** Cannot be reconstructed from transport data or persisted candidate content. */
  approvalCapability: object;
  maintenanceLeaseToken?: string;
}

export interface PutInferenceFactWithTraceResult {
  transactionId: string;
  trace: ReplayableInferenceTrace;
  fact: FactRecord;
  recovered: boolean;
}

export interface InferenceApprovalTransaction {
  schemaVersion: "fact-inference-approval-transaction-v1";
  transactionId: string;
  candidateId: string;
  candidateHash: string;
  approvalAuthorityRef?: `sha256:${string}`;
  status: "pending" | "committed" | "aborted_stale";
  trace: ReplayableInferenceTrace;
  fact: FactRecord;
  createdAt: string;
  committedAt?: string;
  abortedAt?: string;
  abortReason?: "authority_or_input_stale";
  contentHash: string;
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }
function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function inferenceApprovalTransactionId(
  candidateId: string,
  candidateHash: string,
  trace: ReplayableInferenceTrace,
  fact: FactRecord,
  approvalAuthorityRef?: `sha256:${string}`,
): string {
  return `inference-approval-sha256-${sha256Json({
    schemaVersion: "fact-inference-approval-identity-v1",
    candidateId,
    candidateHash,
    inferenceTraceId: trace.inferenceTraceId,
    factId: fact.factId,
    ...(approvalAuthorityRef === undefined ? {} : { approvalAuthorityRef }),
  })}`;
}

function inferenceApprovalContentHash(transaction: Omit<InferenceApprovalTransaction, "contentHash">): string {
  return sha256Json(transaction);
}

function updateDecisionMemoryKey(decision: Pick<UpdateDecision, "subjectKey" | "claimKey" | "revision" | "planIds">): string {
  return sha256Json({
    subjectKey: decision.subjectKey,
    claimKey: decision.claimKey,
    revision: decision.revision,
    planIds: [...decision.planIds].sort(),
  });
}

function effectiveAt(value: { retrievedAt: string; validFrom?: string; validUntil?: string }, timestamp: string): boolean {
  const at = Date.parse(timestamp);
  const retrieved = Date.parse(value.retrievedAt);
  const validFrom = value.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value.validFrom);
  const validUntil = value.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(value.validUntil);
  return Number.isFinite(at) && Number.isFinite(retrieved) && retrieved <= at
    && !Number.isNaN(validFrom) && !Number.isNaN(validUntil)
    && validFrom <= at && at <= validUntil;
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new FactRepositoryError("invalid_input", `${label} invalid`);
}

function subjectMatchesClaim(subject: FactSubject, claim: EvidenceClaim): boolean {
  if (subject.kind !== "product") return false;
  const { kind: _kind, ...identity } = subject;
  return same(identity, claim.subject);
}

function subjectMatchesObservation(subject: FactSubject, observation: UserObservation): boolean {
  return subject.kind === "plan_subject"
    && subject.planId === observation.planId
    && same(subject.subjectRef, observation.subjectRef);
}

export class FactRepository {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;
  private readonly evidenceClaims: EvidenceClaimClosureLookup | undefined;
  private readonly observations: ObservationFactClosureLookup | undefined;
  private readonly acceptedUpdateDecisions: AcceptedUpdateDecisionClosureLookup | undefined;
  private readonly planFactSelection: PlanFactSelectionAuthority | undefined;
  private readonly currentInferenceArtifactHash: FactRepositoryOptions["currentInferenceArtifactHash"];
  private readonly inferenceCandidateApprovalAuthority: InferenceCandidateApprovalAuthority | undefined;
  private readonly requireCandidateApprovalForInference: boolean;
  private readonly inferenceApprovalFaultInjector: FactRepositoryOptions["inferenceApprovalFaultInjector"];

  constructor(options: FactRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? options.coordinator?.root ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "facts"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
    this.evidenceClaims = options.evidenceClaims;
    this.observations = options.observations;
    this.acceptedUpdateDecisions = options.acceptedUpdateDecisions;
    this.planFactSelection = options.planFactSelection;
    this.currentInferenceArtifactHash = options.currentInferenceArtifactHash;
    this.inferenceCandidateApprovalAuthority = options.inferenceCandidateApprovalAuthority;
    this.requireCandidateApprovalForInference = options.requireCandidateApprovalForInference === true;
    this.inferenceApprovalFaultInjector = options.inferenceApprovalFaultInjector;
  }

  private recordFile(repositoryRoot: string, factId: string): string {
    assertId(factId, "fact ID");
    return confined(repositoryRoot, "records", `${factId}.json`);
  }

  private conflictFile(repositoryRoot: string, conflictSetId: string): string {
    assertId(conflictSetId, "conflict set ID");
    return confined(repositoryRoot, "conflicts", `${conflictSetId}.json`);
  }

  private conflictVersionFile(repositoryRoot: string, contentHash: string): string {
    if (!SHA256.test(contentHash)) throw new FactRepositoryError("invalid_input", "conflict version hash invalid");
    return confined(repositoryRoot, "conflict-versions", `${contentHash}.json`);
  }

  private conflictKey(conflictSetId: string): string {
    assertId(conflictSetId, "conflict set ID");
    return sha256Json({ conflictSetId });
  }

  private conflictPointerFile(repositoryRoot: string, conflictSetId: string): string {
    return confined(repositoryRoot, "conflict-pointers", `${this.conflictKey(conflictSetId)}.json`);
  }

  private snapshotFile(repositoryRoot: string, snapshotId: string): string {
    assertId(snapshotId, "fact snapshot ID");
    return confined(repositoryRoot, "snapshots", `${snapshotId}.json`);
  }

  private inferenceFile(repositoryRoot: string, inferenceTraceId: string): string {
    if (!/^inference-sha256-[a-f0-9]{64}$/.test(inferenceTraceId)) throw new FactRepositoryError("invalid_input", "inference trace ID invalid");
    return confined(repositoryRoot, "inferences", `${inferenceTraceId}.json`);
  }

  private inferenceApprovalFile(repositoryRoot: string, transactionId: string): string {
    if (!/^inference-approval-sha256-[a-f0-9]{64}$/.test(transactionId)) {
      throw new FactRepositoryError("invalid_input", "inference approval transaction ID invalid");
    }
    return confined(repositoryRoot, "inference-approval-transactions", `${transactionId}.json`);
  }

  private async boundary<T>(
    write: boolean,
    operation: (repositoryRoot: string, activeRoot?: string, runtimeGeneration?: number) => Promise<T>,
    maintenanceLeaseToken?: string,
  ): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) return (await this.coordinator.withWrite(({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => operation(confined(activeRoot, "facts"), activeRoot, state.runtimeGeneration), { maintenanceLeaseToken })).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => operation(confined(activeRoot, "facts"), activeRoot, state.runtimeGeneration))).result as T;
    }
    return withDirectoryLock(confined(this.root, ".locks", "repository-global"), () => operation(this.root));
  }

  private async readEnvelope<T>(file: string, kind: Envelope<T>["kind"], optional = false): Promise<T | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (optional) return null;
        throw new FactRepositoryError("not_found", `${kind} authority was not found`);
      }
      throw new FactRepositoryError("corrupt_data", `${kind} authority cannot be read`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FactRepositoryError("corrupt_data", `${kind} envelope invalid`);
    const envelope = parsed as Partial<Envelope<T>>;
    if (envelope.schemaVersion !== "fact-repository-envelope-v1" || envelope.kind !== kind || !("payload" in envelope)
      || envelope.checksum !== sha256Json(envelope.payload)) throw new FactRepositoryError("corrupt_data", `${kind} envelope checksum invalid`);
    return clone(envelope.payload as T);
  }

  private async writeEnvelope<T>(file: string, kind: Envelope<T>["kind"], payload: T): Promise<void> {
    await atomicWriteJson(file, { schemaVersion: "fact-repository-envelope-v1", kind, checksum: sha256Json(payload), payload });
  }

  private async readStoredFactAt(repositoryRoot: string, factId: string): Promise<StoredFact> {
    const stored = await this.readEnvelope<StoredFact>(this.recordFile(repositoryRoot, factId), "fact");
    if (!stored || stored.schemaVersion !== "fact-repository-v1" || stored.revision !== 0 || stored.fact.factId !== factId
      || stored.recordHash !== sha256Json(stored.fact) || validateFactRecord(stored.fact).length || !await verifyFactRecord(stored.fact)) {
      throw new FactRepositoryError("corrupt_data", "fact authority integrity invalid");
    }
    return stored;
  }

  private async validateStoredConflict(stored: StoredConflict | null, conflictSetId: string, contentHash?: string): Promise<StoredConflict> {
    if (!stored || stored.schemaVersion !== "fact-repository-v1" || !Number.isInteger(stored.revision) || stored.revision < 0
      || stored.conflict.conflictSetId !== conflictSetId || stored.recordHash !== sha256Json(stored.conflict)
      || (contentHash !== undefined && stored.conflict.contentHash !== contentHash)
      || validateConflictSet(stored.conflict).length || !await verifyConflictSet(stored.conflict)) {
      throw new FactRepositoryError("corrupt_data", "fact conflict authority integrity invalid");
    }
    return stored;
  }

  private async readStoredConflictAt(repositoryRoot: string, conflictSetId: string): Promise<StoredConflict> {
    return this.validateStoredConflict(
      await this.readEnvelope<StoredConflict>(this.conflictFile(repositoryRoot, conflictSetId), "conflict"),
      conflictSetId,
    );
  }

  /** Resolves the immutable state pinned by a snapshot, not today's mutable head. */
  private async readStoredConflictVersionAt(
    repositoryRoot: string,
    conflictSetId: string,
    contentHash: string,
  ): Promise<StoredConflict> {
    const version = await this.readEnvelope<StoredConflict>(
      this.conflictVersionFile(repositoryRoot, contentHash),
      "conflict",
      true,
    );
    if (version) return this.validateStoredConflict(version, conflictSetId, contentHash);

    // Read compatibility for repositories created before immutable conflict
    // versions existed. A legacy head is sufficient only while it is still the
    // exact state pinned by the snapshot. The first transition persists it.
    const head = await this.readStoredConflictAt(repositoryRoot, conflictSetId);
    if (head.conflict.contentHash !== contentHash) {
      throw new FactRepositoryError("corrupt_data", "fact snapshot conflict version authority is missing");
    }
    return head;
  }

  private async writeConflictVersionAt(repositoryRoot: string, stored: StoredConflict): Promise<void> {
    const contentHash = stored.conflict.contentHash;
    const file = this.conflictVersionFile(repositoryRoot, contentHash);
    const existing = await this.readEnvelope<StoredConflict>(file, "conflict", true);
    if (existing) {
      const valid = await this.validateStoredConflict(existing, stored.conflict.conflictSetId, contentHash);
      if (!same(valid, stored)) throw new FactRepositoryError("corrupt_data", "immutable fact conflict version collision");
      return;
    }
    await this.writeEnvelope(file, "conflict", stored);
  }

  private async readConflictPointerAt(
    repositoryRoot: string,
    conflictSetId: string,
    optional = false,
  ): Promise<FactUpdateConflictPointer | null> {
    const pointer = await this.readEnvelope<FactUpdateConflictPointer>(
      this.conflictPointerFile(repositoryRoot, conflictSetId),
      "conflict-pointer",
      optional,
    );
    if (!pointer) return null;
    const allowed = [
      "schemaVersion", "conflictKey", "conflictSetId", "revision", "decisionId", "decisionHash",
      "decisionMemoryKey", "selectedConflictRef", "previousConflictRef", "previousDecisionId",
      "previousDecisionHash", "updatedAt",
    ];
    const required = allowed.filter((key) => key !== "previousDecisionId" && key !== "previousDecisionHash");
    const keys = Object.keys(pointer);
    const previousPresent = pointer.previousDecisionId !== undefined || pointer.previousDecisionHash !== undefined;
    const validRef = (ref: FactConflictStateRef) => ref && Object.keys(ref).length === 2
      && ref.conflictSetId === conflictSetId && SHA256.test(ref.contentHash);
    if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))
      || keys.length !== required.length + (previousPresent ? 2 : 0)
      || pointer.schemaVersion !== "fact-update-conflict-pointer-v1"
      || pointer.conflictSetId !== conflictSetId || pointer.conflictKey !== this.conflictKey(conflictSetId)
      || !Number.isInteger(pointer.revision) || pointer.revision < 0
      || !/^update-decision-sha256-[a-f0-9]{64}$/.test(pointer.decisionId)
      || pointer.decisionId !== `update-decision-sha256-${pointer.decisionHash}`
      || !SHA256.test(pointer.decisionMemoryKey)
      || !validRef(pointer.selectedConflictRef) || !validRef(pointer.previousConflictRef)
      || same(pointer.selectedConflictRef, pointer.previousConflictRef)
      || previousPresent !== (pointer.previousDecisionId !== undefined && pointer.previousDecisionHash !== undefined)
      || (previousPresent && (!/^update-decision-sha256-[a-f0-9]{64}$/.test(pointer.previousDecisionId!)
        || pointer.previousDecisionId !== `update-decision-sha256-${pointer.previousDecisionHash}`))
      || !Number.isFinite(Date.parse(pointer.updatedAt))) {
      throw new FactRepositoryError("corrupt_data", "fact conflict pointer authority invalid");
    }
    await this.readStoredConflictVersionAt(repositoryRoot, conflictSetId, pointer.selectedConflictRef.contentHash);
    await this.readStoredConflictVersionAt(repositoryRoot, conflictSetId, pointer.previousConflictRef.contentHash);
    return pointer;
  }

  private async listConflictPointersAt(repositoryRoot: string): Promise<FactUpdateConflictPointer[]> {
    const keys = await this.listFiles(confined(repositoryRoot, "conflict-pointers"), "fact conflict pointers");
    if (keys.some((key) => !SHA256.test(key))) {
      throw new FactRepositoryError("corrupt_data", "fact conflict pointer path identity invalid");
    }
    return Promise.all(keys.map(async (key) => {
      const raw = await this.readEnvelope<FactUpdateConflictPointer>(
        confined(repositoryRoot, "conflict-pointers", `${key}.json`),
        "conflict-pointer",
      );
      if (!raw || raw.conflictKey !== key) throw new FactRepositoryError("corrupt_data", "fact conflict pointer path identity invalid");
      const pointer = await this.readConflictPointerAt(repositoryRoot, raw.conflictSetId);
      if (!pointer || pointer.conflictKey !== key) throw new FactRepositoryError("corrupt_data", "fact conflict pointer disappeared");
      return pointer;
    }));
  }

  private async readInferenceAt(repositoryRoot: string, inferenceTraceId: string): Promise<ReplayableInferenceTrace> {
    const trace = await this.readEnvelope<ReplayableInferenceTrace>(this.inferenceFile(repositoryRoot, inferenceTraceId), "inference");
    if (!trace || trace.inferenceTraceId !== inferenceTraceId || validateReplayableInferenceTrace(trace).length
      || !await verifyReplayableInferenceTrace(trace)) throw new FactRepositoryError("corrupt_data", "inference trace authority invalid");
    return trace;
  }

  private async validateInferenceApprovalTransaction(
    transaction: InferenceApprovalTransaction | null,
    expectedTransactionId: string,
  ): Promise<InferenceApprovalTransaction> {
    if (validateInferenceApprovalTransactionRuntime(transaction, expectedTransactionId).length
      || !transaction || transaction.schemaVersion !== "fact-inference-approval-transaction-v1"
      || transaction.transactionId !== expectedTransactionId
      || !/^fact-inference-candidate-sha256-[a-f0-9]{64}$/.test(transaction.candidateId)
      || !SHA256.test(transaction.candidateHash)
      || inferenceApprovalTransactionId(
        transaction.candidateId,
        transaction.candidateHash,
        transaction.trace,
        transaction.fact,
        transaction.approvalAuthorityRef,
      ) !== expectedTransactionId
      || (transaction.approvalAuthorityRef !== undefined && !ARTIFACT_REF.test(transaction.approvalAuthorityRef))
      || !["pending", "committed", "aborted_stale"].includes(transaction.status)
      || !canonicalIso(transaction.createdAt)
      || (transaction.status === "pending"
        ? transaction.committedAt !== undefined || transaction.abortedAt !== undefined || transaction.abortReason !== undefined
        : transaction.status === "committed"
          ? !canonicalIso(transaction.committedAt) || transaction.abortedAt !== undefined || transaction.abortReason !== undefined
          : transaction.committedAt !== undefined || !canonicalIso(transaction.abortedAt)
            || transaction.abortReason !== "authority_or_input_stale")
      || validateReplayableInferenceTrace(transaction.trace).length
      || !await verifyReplayableInferenceTrace(transaction.trace)
      || validateFactRecord(transaction.fact).length
      || !await verifyFactRecord(transaction.fact)) {
      throw new FactRepositoryError("corrupt_data", "inference approval transaction authority invalid");
    }
    const keys = Object.keys(transaction).sort();
    const expectedKeys = [
      "schemaVersion", "transactionId", "candidateId", "candidateHash", "status", "trace", "fact", "createdAt", "contentHash",
      ...(transaction.approvalAuthorityRef === undefined ? [] : ["approvalAuthorityRef"]),
      ...(transaction.status === "committed" ? ["committedAt"] : []),
      ...(transaction.status === "aborted_stale" ? ["abortedAt", "abortReason"] : []),
    ].sort();
    const { contentHash: _contentHash, ...material } = transaction;
    if (!same(keys, expectedKeys) || !SHA256.test(transaction.contentHash)
      || transaction.contentHash !== inferenceApprovalContentHash(material)) {
      throw new FactRepositoryError("corrupt_data", "inference approval transaction integrity invalid");
    }
    return transaction;
  }

  private async readInferenceApprovalAt(
    repositoryRoot: string,
    transactionId: string,
    optional = false,
  ): Promise<InferenceApprovalTransaction | null> {
    const transaction = await this.readEnvelope<InferenceApprovalTransaction>(
      this.inferenceApprovalFile(repositoryRoot, transactionId),
      "inference-approval",
      optional,
    );
    return transaction ? this.validateInferenceApprovalTransaction(transaction, transactionId) : null;
  }

  private async readSnapshotAt(repositoryRoot: string, snapshotId: string, verifyClosure = true): Promise<FactSnapshot> {
    const snapshot = await this.readEnvelope<FactSnapshot>(this.snapshotFile(repositoryRoot, snapshotId), "snapshot");
    if (!snapshot || snapshot.snapshotId !== snapshotId || validateFactSnapshot(snapshot).length || !await verifyFactSnapshot(snapshot)) {
      throw new FactRepositoryError("corrupt_data", "fact snapshot authority integrity invalid");
    }
    if (verifyClosure) {
      for (const ref of snapshot.factRefs) {
        const fact = await this.readStoredFactAt(repositoryRoot, ref.factId);
        if (fact.fact.contentHash !== ref.contentHash) throw new FactRepositoryError("corrupt_data", "fact snapshot record closure invalid");
      }
      for (const ref of snapshot.conflictRefs) {
        await this.readStoredConflictVersionAt(repositoryRoot, ref.conflictSetId, ref.contentHash);
      }
    }
    return snapshot;
  }

  private async listFiles(directory: string, label: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new FactRepositoryError("corrupt_data", `${label} contains a symlink`);
    if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) throw new FactRepositoryError("corrupt_data", `${label} contains an unknown authority path`);
    return entries.map((entry) => entry.name.slice(0, -5)).sort();
  }

  private async listStoredFactsAt(repositoryRoot: string): Promise<StoredFact[]> {
    const ids = await this.listFiles(confined(repositoryRoot, "records"), "fact records");
    return Promise.all(ids.map((id) => this.readStoredFactAt(repositoryRoot, id)));
  }

  private async listStoredConflictsAt(repositoryRoot: string): Promise<StoredConflict[]> {
    const ids = await this.listFiles(confined(repositoryRoot, "conflicts"), "fact conflicts");
    return Promise.all(ids.map((id) => this.readStoredConflictAt(repositoryRoot, id)));
  }

  private async listStoredConflictVersionsAt(repositoryRoot: string): Promise<StoredConflict[]> {
    const hashes = await this.listFiles(confined(repositoryRoot, "conflict-versions"), "fact conflict versions");
    if (hashes.some((hash) => !SHA256.test(hash))) {
      throw new FactRepositoryError("corrupt_data", "fact conflict version path identity invalid");
    }
    return Promise.all(hashes.map(async (hash) => {
      const stored = await this.readEnvelope<StoredConflict>(this.conflictVersionFile(repositoryRoot, hash), "conflict");
      if (!stored) throw new FactRepositoryError("corrupt_data", "fact conflict version disappeared");
      return this.validateStoredConflict(stored, stored.conflict.conflictSetId, hash);
    }));
  }

  private async listInferencesAt(repositoryRoot: string): Promise<ReplayableInferenceTrace[]> {
    const ids = await this.listFiles(confined(repositoryRoot, "inferences"), "fact inferences");
    return Promise.all(ids.map((id) => this.readInferenceAt(repositoryRoot, id)));
  }

  private async listInferenceApprovalsAt(repositoryRoot: string): Promise<InferenceApprovalTransaction[]> {
    const ids = await this.listFiles(confined(repositoryRoot, "inference-approval-transactions"), "inference approval transactions");
    if (ids.some((id) => !/^inference-approval-sha256-[a-f0-9]{64}$/.test(id))) {
      throw new FactRepositoryError("corrupt_data", "inference approval transaction path identity invalid");
    }
    return Promise.all(ids.map(async (id) => {
      const transaction = await this.readInferenceApprovalAt(repositoryRoot, id);
      if (!transaction) throw new FactRepositoryError("corrupt_data", "inference approval transaction disappeared");
      return transaction;
    }));
  }

  private async lookupEvidenceClaim(activeRoot: string | undefined, claimId: string): Promise<EvidenceClaim> {
    if (!this.evidenceClaims) throw new FactRepositoryError("invalid_input", "evidence claim closure provider is unavailable");
    if (activeRoot && !this.evidenceClaims.getClaimAtRoot) throw new FactRepositoryError("invalid_input", "coordinated evidence claim closure provider is unavailable");
    const claim = activeRoot ? await this.evidenceClaims.getClaimAtRoot!(activeRoot, claimId) : await this.evidenceClaims.getClaim(claimId);
    if (!claim || !await verifyEvidenceClaim(claim)) throw new FactRepositoryError("invalid_input", "fact evidence claim closure is missing or invalid");
    return claim;
  }

  private async ensureSourceClosure(repositoryRoot: string, activeRoot: string | undefined, fact: FactRecord, evaluatedAt?: string): Promise<void> {
    if ((fact.authority === "official" || fact.authority === "third_party")) {
      for (const claimId of fact.evidenceRefs) {
        const claim = await this.lookupEvidenceClaim(activeRoot, claimId);
        if (claim.claimId !== claimId || claim.status !== "active" || claim.authority !== fact.authority || claim.fieldId !== fact.field
          || claim.scope !== fact.scope || !subjectMatchesClaim(fact.subject, claim) || !same(claim.value, fact.value)
          || claim.unit !== fact.unit || (evaluatedAt !== undefined && !effectiveAt(claim, evaluatedAt))) {
          throw new FactRepositoryError("invalid_input", "fact does not match a currently effective evidence claim authority");
        }
      }
      return;
    }
    if (fact.authority === "user_observation") {
      if (!this.observations) throw new FactRepositoryError("invalid_input", "observation closure provider is unavailable");
      if (activeRoot && !this.observations.resolveForFactAtRoot) throw new FactRepositoryError("invalid_input", "coordinated observation closure provider is unavailable");
      for (const ref of fact.evidenceRefs) {
        const match = OBSERVATION_REF.exec(ref);
        if (!match) throw new FactRepositoryError("invalid_input", "fact observation reference invalid");
        const observationId = match[1]!;
        const observationHash = match[2]!;
        const closure = activeRoot
          ? await this.observations.resolveForFactAtRoot!(activeRoot, (fact.subject as { planId: string }).planId, observationId)
          : await this.observations.resolveForFact((fact.subject as { planId: string }).planId, observationId);
        if (!closure || closure.observation.contentHash !== observationHash || !canProjectUserObservation(closure.observation, closure.context)
          || !subjectMatchesObservation(fact.subject, closure.observation) || fact.field !== closure.observation.fieldId
          || !same(fact.value, closure.observation.value) || fact.unit !== closure.observation.unit
          || (evaluatedAt !== undefined && (Date.parse(closure.observation.capturedAt) > Date.parse(evaluatedAt)
            || (closure.observation.validatedAt !== undefined && Date.parse(closure.observation.validatedAt) > Date.parse(evaluatedAt))))) {
          throw new FactRepositoryError("invalid_input", "fact observation closure is stale, mismatched, or invalid");
        }
      }
      return;
    }
    if (!fact.inferenceTraceId) throw new FactRepositoryError("invalid_input", "inference fact has no governed trace");
    const trace = await this.readInferenceAt(repositoryRoot, fact.inferenceTraceId);
    if (!trace.outputFactIds.includes(fact.factId)
      || trace.ruleOrModelVersion !== fact.extractorOrRuleVersion
      || !same(trace.assumptions, fact.assumptions ?? [])
      || !same(trace.inputFactRefs.map((ref) => ref.factId).sort(), [...fact.derivedFromFactIds].sort())) {
      throw new FactRepositoryError("invalid_input", "inference fact does not match its trace authority");
    }
    for (const inputRef of trace.inputFactRefs) {
      const stored = await this.readStoredFactAt(repositoryRoot, inputRef.factId);
      if (stored.fact.contentHash !== inputRef.contentHash) throw new FactRepositoryError("invalid_input", "inference trace input fact hash is stale");
    }
    if (this.currentInferenceArtifactHash) {
      const activeArtifactHash = await this.currentInferenceArtifactHash(trace, activeRoot);
      if (activeArtifactHash !== trace.ruleOrModelArtifactHash) throw new FactRepositoryError("invalid_input", "inference trace rule/model artifact is stale");
    }
    for (const inputId of fact.derivedFromFactIds) {
      if (inputId === fact.factId) throw new FactRepositoryError("invalid_input", "inference fact cannot depend on itself");
    }
  }

  private async assertLegacyInferenceImportAuthority(
    capability: unknown,
    maintenanceLeaseToken: string | undefined,
  ): Promise<void> {
    if (capability !== LEGACY_INFERENCE_IMPORT_CAPABILITY) {
      throw new FactRepositoryError("invalid_input", "legacy inference import capability is required");
    }
    if (!this.coordinator || !maintenanceLeaseToken) {
      throw new FactRepositoryError(
        "invalid_input",
        "legacy inference import requires coordinated migration authority and a maintenance lease",
      );
    }
    await this.coordinator.assertMaintenanceLease(maintenanceLeaseToken)
      .catch(() => { throw new FactRepositoryError("invalid_input", "legacy inference import maintenance lease is invalid"); });
  }

  private async resolveInferenceCandidateApprovalAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    input: Pick<PutInferenceCandidateApprovalInput, "candidateId" | "expectedCandidateHash">,
    approvalCapability?: object,
    internalRecovery = false,
  ): Promise<InferenceCandidateApprovalClosure> {
    if (!/^fact-inference-candidate-sha256-[a-f0-9]{64}$/.test(input.candidateId)
      || !SHA256.test(input.expectedCandidateHash)
      || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new FactRepositoryError("invalid_input", "inference candidate approval identity is invalid");
    }
    const authority = this.inferenceCandidateApprovalAuthority;
    if (!authority) {
      throw new FactRepositoryError("invalid_input", "inference candidate approval authority is unavailable");
    }
    if (!internalRecovery && approvalCapability !== authority.approvalCapability) {
      throw new FactRepositoryError("invalid_input", "inference candidate approval capability is invalid");
    }
    let closure: InferenceCandidateApprovalClosure;
    try {
      closure = await authority.resolveForApprovalAtRoot(
        activeRoot,
        runtimeGeneration,
        input.candidateId,
        input.expectedCandidateHash,
      );
    } catch (error) {
      if (error instanceof FactRepositoryError) throw error;
      throw new FactRepositoryError(
        "conflict",
        `inference candidate is not current for approval${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }
    if (closure.candidate.candidateId !== input.candidateId
      || closure.candidate.contentHash !== input.expectedCandidateHash) {
      throw new FactRepositoryError("conflict", "inference candidate approval authority returned a mismatched candidate");
    }
    return {
      candidate: clone(closure.candidate),
      trace: clone(closure.trace),
      proposedFact: clone(closure.proposedFact),
    };
  }

  async putInferenceTrace(input: PutInferenceTraceInput): Promise<ReplayableInferenceTrace> {
    await this.assertLegacyInferenceImportAuthority(input.legacyImportCapability, input.maintenanceLeaseToken);
    const trace = clone(input.trace);
    if (validateReplayableInferenceTrace(trace).length || !await verifyReplayableInferenceTrace(trace)) throw new FactRepositoryError("invalid_input", "inference trace content authority invalid");
    return this.boundary(true, async (repositoryRoot) => {
      for (const ref of trace.inputFactRefs) {
        const fact = await this.readStoredFactAt(repositoryRoot, ref.factId);
        if (fact.fact.contentHash !== ref.contentHash) throw new FactRepositoryError("invalid_input", "inference trace input fact hash mismatch");
      }
      const file = this.inferenceFile(repositoryRoot, trace.inferenceTraceId);
      const existing = await this.readEnvelope<ReplayableInferenceTrace>(file, "inference", true);
      if (existing) {
        const valid = await this.readInferenceAt(repositoryRoot, trace.inferenceTraceId);
        if (!same(valid, trace)) throw new FactRepositoryError("conflict", "immutable inference trace ID collision");
        return clone(valid);
      }
      await this.writeEnvelope(file, "inference", trace);
      return clone(trace);
    }, input.maintenanceLeaseToken);
  }

  async getInferenceTrace(inferenceTraceId: string): Promise<ReplayableInferenceTrace> {
    return this.boundary(false, (repositoryRoot) => this.readInferenceAt(repositoryRoot, inferenceTraceId));
  }

  /** Read-only immutable approval journal projection for server-owned plan summaries. */
  async listInferenceApprovalTransactionsAtRoot(activeRoot: string): Promise<InferenceApprovalTransaction[]> {
    return clone(await this.listInferenceApprovalsAt(confined(activeRoot, "facts")));
  }

  async listInferenceApprovalTransactions(): Promise<InferenceApprovalTransaction[]> {
    return this.boundary(false, async (repositoryRoot) => clone(await this.listInferenceApprovalsAt(repositoryRoot)));
  }

  private async preflightInferenceFactWithTraceAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    candidateId: string,
    candidateHash: string,
    trace: ReplayableInferenceTrace,
    fact: FactRecord,
    approvalAuthorityRef?: `sha256:${string}`,
  ): Promise<{
    transactionId: string;
    existingTransaction: InferenceApprovalTransaction | null;
    traceExists: boolean;
    factExists: boolean;
  }> {
    if (!/^fact-inference-candidate-sha256-[a-f0-9]{64}$/.test(candidateId) || !SHA256.test(candidateHash)
      || (approvalAuthorityRef !== undefined && !ARTIFACT_REF.test(approvalAuthorityRef))) {
      throw new FactRepositoryError("invalid_input", "inference approval candidate binding is invalid");
    }
    const traceErrors = validateReplayableInferenceTrace(trace);
    const factErrors = validateFactRecord(fact);
    if (traceErrors.length || !await verifyReplayableInferenceTrace(trace)
      || factErrors.length || !await verifyFactRecord(fact)) {
      throw new FactRepositoryError("invalid_input", [
        ...traceErrors,
        ...factErrors,
      ].join("; ") || "inference fact/trace content authority invalid");
    }
    const policy = factFieldPolicy(fact.field);
    const requiredInvalidations = ["input_fact_hash_changed", "plan_revision_changed", "rule_artifact_changed"];
    if (!policy || fact.authority !== "agent_inference" || fact.status !== "active"
      || fact.safetyClass !== policy.safetyClass || !policy.allowedScopes.includes(fact.scope)
      || fact.evidenceRefs.length !== 0 || !fact.inferenceTraceId
      || fact.inferenceTraceId !== trace.inferenceTraceId
      || trace.outputFactIds.length !== 1 || trace.outputFactIds[0] !== fact.factId
      || trace.ruleOrModelVersion !== fact.extractorOrRuleVersion
      || !same(trace.assumptions, fact.assumptions ?? [])
      || !same(trace.inputFactRefs.map((ref) => ref.factId).sort(), [...fact.derivedFromFactIds].sort())
      || requiredInvalidations.some((condition) => !trace.invalidationConditions.includes(condition))
      || canFactAloneSupportSafetyPass(fact)) {
      throw new FactRepositoryError("invalid_input", "inference fact does not close to its governed trace/field/safety authority");
    }
    if (!trace.outputRange || typeof fact.value !== "number" || !Number.isFinite(fact.value)
      || fact.value < trace.outputRange.min || fact.value > trace.outputRange.max
      || trace.outputRange.unit !== fact.unit) {
      throw new FactRepositoryError("invalid_input", "inference fact value does not close to its governed output range");
    }
    if (!this.currentInferenceArtifactHash) {
      throw new FactRepositoryError("invalid_input", "current inference artifact authority is unavailable");
    }
    const currentFacts = await this.currentFactsAt(repositoryRoot, activeRoot, this.now());
    const artifactHash = await this.currentInferenceArtifactHash(trace, activeRoot);
    if (!artifactHash || artifactHash !== trace.ruleOrModelArtifactHash
      || !await inferenceTraceIsCurrent(trace, currentFacts, artifactHash)) {
      throw new FactRepositoryError("conflict", "inference trace inputs or executable artifact are no longer current");
    }

    const traceFile = this.inferenceFile(repositoryRoot, trace.inferenceTraceId);
    const existingTrace = await this.readEnvelope<ReplayableInferenceTrace>(traceFile, "inference", true);
    if (existingTrace) {
      const valid = await this.readInferenceAt(repositoryRoot, trace.inferenceTraceId);
      if (!same(valid, trace)) throw new FactRepositoryError("conflict", "immutable inference trace ID collision");
    }
    const factFile = this.recordFile(repositoryRoot, fact.factId);
    const existingFact = await this.readEnvelope<StoredFact>(factFile, "fact", true);
    if (existingFact) {
      const valid = await this.readStoredFactAt(repositoryRoot, fact.factId);
      if (!same(valid.fact, fact)) throw new FactRepositoryError("conflict", "immutable inference fact ID collision");
    }
    const transactionId = inferenceApprovalTransactionId(candidateId, candidateHash, trace, fact, approvalAuthorityRef);
    const existingTransaction = await this.readInferenceApprovalAt(repositoryRoot, transactionId, true);
    if (existingTransaction && (existingTransaction.candidateId !== candidateId
      || existingTransaction.candidateHash !== candidateHash
      || existingTransaction.approvalAuthorityRef !== approvalAuthorityRef
      || !same(existingTransaction.trace, trace) || !same(existingTransaction.fact, fact))) {
      throw new FactRepositoryError("conflict", "immutable inference approval transaction collision");
    }
    return {
      transactionId,
      existingTransaction,
      traceExists: existingTrace !== null,
      factExists: existingFact !== null,
    };
  }

  private async publishInferenceFactWithTraceAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    candidateId: string,
    candidateHash: string,
    trace: ReplayableInferenceTrace,
    fact: FactRecord,
    invokeFaultInjector: boolean,
    approvalAuthorityRef?: `sha256:${string}`,
  ): Promise<PutInferenceFactWithTraceResult> {
    const preflight = await this.preflightInferenceFactWithTraceAt(
      repositoryRoot,
      activeRoot,
      candidateId,
      candidateHash,
      trace,
      fact,
      approvalAuthorityRef,
    );
    if (preflight.existingTransaction?.status === "committed") {
      if (!preflight.traceExists || !preflight.factExists) {
        throw new FactRepositoryError("corrupt_data", "committed inference approval transaction closure is incomplete");
      }
      return {
        transactionId: preflight.transactionId,
        trace: clone(trace),
        fact: clone(fact),
        recovered: true,
      };
    }
    if (preflight.existingTransaction?.status === "aborted_stale") {
      throw new FactRepositoryError("conflict", "stale inference approval transaction was permanently aborted");
    }

    const createdAt = preflight.existingTransaction?.createdAt ?? new Date(this.now()).toISOString();
    const pendingMaterial: Omit<InferenceApprovalTransaction, "contentHash"> = {
      schemaVersion: "fact-inference-approval-transaction-v1",
      transactionId: preflight.transactionId,
      candidateId,
      candidateHash,
      ...(approvalAuthorityRef === undefined ? {} : { approvalAuthorityRef }),
      status: "pending",
      trace: clone(trace),
      fact: clone(fact),
      createdAt,
    };
    const pending: InferenceApprovalTransaction = {
      ...pendingMaterial,
      contentHash: inferenceApprovalContentHash(pendingMaterial),
    };
    if (!preflight.existingTransaction) {
      await this.writeEnvelope(
        this.inferenceApprovalFile(repositoryRoot, preflight.transactionId),
        "inference-approval",
        pending,
      );
    }
    if (!preflight.traceExists) {
      await this.writeEnvelope(this.inferenceFile(repositoryRoot, trace.inferenceTraceId), "inference", trace);
    }
    if (invokeFaultInjector && this.inferenceApprovalFaultInjector) {
      await this.inferenceApprovalFaultInjector("after_trace_write", Object.freeze({
        transactionId: preflight.transactionId,
        trace: clone(trace),
        fact: clone(fact),
      }));
    }
    if (!preflight.factExists) {
      // This call now observes the trace written above, while remaining inside
      // the same coordinator writer and root generation.
      await this.ensureSourceClosure(repositoryRoot, activeRoot, fact);
      const stored: StoredFact = {
        schemaVersion: "fact-repository-v1",
        revision: 0,
        recordHash: sha256Json(fact),
        fact: clone(fact),
      };
      await this.writeEnvelope(this.recordFile(repositoryRoot, fact.factId), "fact", stored);
    }
    const committedMaterial: Omit<InferenceApprovalTransaction, "contentHash"> = {
      ...pendingMaterial,
      status: "committed",
      committedAt: new Date(this.now()).toISOString(),
    };
    const committed: InferenceApprovalTransaction = {
      ...committedMaterial,
      contentHash: inferenceApprovalContentHash(committedMaterial),
    };
    await this.writeEnvelope(
      this.inferenceApprovalFile(repositoryRoot, preflight.transactionId),
      "inference-approval",
      committed,
    );
    return {
      transactionId: preflight.transactionId,
      trace: clone(trace),
      fact: clone(fact),
      recovered: preflight.existingTransaction !== null,
    };
  }

  /**
   * Removed production seam retained only to fail closed for pre-candidate
   * callers. A trace/fact payload can never prove user approval or rule replay.
   */
  async putInferenceFactWithTrace(input: PutInferenceFactWithTraceInput): Promise<PutInferenceFactWithTraceResult> {
    void input;
    throw new FactRepositoryError(
      "invalid_input",
      "direct inference trace/fact publication is forbidden; approve an immutable candidate",
    );
  }

  /** Removed root-bound payload seam; see putInferenceCandidateApprovalAtRoot. */
  async putInferenceFactWithTraceAtRoot(
    activeRoot: string,
    input: Omit<PutInferenceFactWithTraceInput, "maintenanceLeaseToken">,
  ): Promise<PutInferenceFactWithTraceResult> {
    void activeRoot;
    void input;
    throw new FactRepositoryError(
      "invalid_input",
      "direct root-bound inference trace/fact publication is forbidden; approve an immutable candidate",
    );
  }

  /**
   * One-writer durable approval commit. The caller supplies no executable
   * values: the server-owned authority reloads and replays the immutable
   * candidate inside this exact root/generation before the first write.
   */
  async putInferenceCandidateApproval(
    input: PutInferenceCandidateApprovalInput,
  ): Promise<PutInferenceFactWithTraceResult> {
    return this.boundary(true, async (repositoryRoot, activeRoot, runtimeGeneration) => {
      if (!activeRoot || runtimeGeneration === undefined) {
        throw new FactRepositoryError("invalid_input", "coordinated inference approval authority is required");
      }
      const closure = await this.resolveInferenceCandidateApprovalAtRoot(
        activeRoot,
        runtimeGeneration,
        input,
        input.approvalCapability,
      );
      return this.publishInferenceFactWithTraceAt(
        repositoryRoot,
        activeRoot,
        closure.candidate.candidateId,
        closure.candidate.contentHash,
        closure.trace,
        closure.proposedFact,
        true,
        input.approvalAuthorityRef,
      );
    }, input.maintenanceLeaseToken);
  }

  /** Root-bound primitive callable only by the production approval composition. */
  async putInferenceCandidateApprovalAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    input: Omit<PutInferenceCandidateApprovalInput, "maintenanceLeaseToken">,
  ): Promise<PutInferenceFactWithTraceResult> {
    const closure = await this.resolveInferenceCandidateApprovalAtRoot(
      activeRoot,
      runtimeGeneration,
      input,
      input.approvalCapability,
    );
    return this.publishInferenceFactWithTraceAt(
      confined(activeRoot, "facts"),
      activeRoot,
      closure.candidate.candidateId,
      closure.candidate.contentHash,
      closure.trace,
      closure.proposedFact,
      true,
      input.approvalAuthorityRef,
    );
  }

  /** Replays every pending journal without invoking the crash seam. */
  async recoverPendingInferenceApprovals(maintenanceLeaseToken?: string): Promise<{
    recovered: PutInferenceFactWithTraceResult[];
    abortedTransactionIds: string[];
  }> {
    return this.boundary(true, async (repositoryRoot, activeRoot, runtimeGeneration) => {
      if (!activeRoot || runtimeGeneration === undefined) {
        throw new FactRepositoryError("invalid_input", "coordinated inference recovery authority is required");
      }
      const pending = (await this.listInferenceApprovalsAt(repositoryRoot))
        .filter((transaction) => transaction.status === "pending");
      const recovered: PutInferenceFactWithTraceResult[] = [];
      const abortedTransactionIds: string[] = [];
      for (const transaction of pending) {
        try {
          const closure = await this.resolveInferenceCandidateApprovalAtRoot(activeRoot, runtimeGeneration, {
            candidateId: transaction.candidateId,
            expectedCandidateHash: transaction.candidateHash,
          }, undefined, true);
          if (!same(closure.trace, transaction.trace) || !same(closure.proposedFact, transaction.fact)) {
            throw new FactRepositoryError("conflict", "pending inference approval replay changed");
          }
          recovered.push(await this.publishInferenceFactWithTraceAt(
            repositoryRoot,
            activeRoot,
            closure.candidate.candidateId,
            closure.candidate.contentHash,
            closure.trace,
            closure.proposedFact,
            false,
            transaction.approvalAuthorityRef,
          ));
        } catch (error) {
          if (!(error instanceof FactRepositoryError) || !["conflict", "invalid_input"].includes(error.code)) throw error;
          const abortedMaterial: Omit<InferenceApprovalTransaction, "contentHash"> = {
            schemaVersion: transaction.schemaVersion,
            transactionId: transaction.transactionId,
            candidateId: transaction.candidateId,
            candidateHash: transaction.candidateHash,
            ...(transaction.approvalAuthorityRef === undefined ? {} : {
              approvalAuthorityRef: transaction.approvalAuthorityRef,
            }),
            status: "aborted_stale",
            trace: clone(transaction.trace),
            fact: clone(transaction.fact),
            createdAt: transaction.createdAt,
            abortedAt: new Date(this.now()).toISOString(),
            abortReason: "authority_or_input_stale",
          };
          await this.writeEnvelope(
            this.inferenceApprovalFile(repositoryRoot, transaction.transactionId),
            "inference-approval",
            { ...abortedMaterial, contentHash: inferenceApprovalContentHash(abortedMaterial) },
          );
          abortedTransactionIds.push(transaction.transactionId);
        }
      }
      return { recovered, abortedTransactionIds };
    }, maintenanceLeaseToken);
  }

  async putFact(input: PutFactInput): Promise<FactRecord> {
    if (input.fact.authority === "agent_inference") {
      throw new FactRepositoryError(
        "invalid_input",
        "agent inference facts require server-owned immutable candidate approval",
      );
    }
    return this.putValidatedFact(input);
  }

  /** Maintenance-only import seam for pre-U4 trace/fact authority pairs. */
  async putLegacyInferenceFact(input: PutLegacyInferenceFactInput): Promise<FactRecord> {
    if (input.fact.authority !== "agent_inference") {
      throw new FactRepositoryError("invalid_input", "legacy inference import accepts only agent inference facts");
    }
    await this.assertLegacyInferenceImportAuthority(input.legacyImportCapability, input.maintenanceLeaseToken);
    return this.putValidatedFact(input);
  }

  private async putValidatedFact(input: PutFactInput): Promise<FactRecord> {
    const fact = clone(input.fact);
    assertId(fact.factId, "fact ID");
    const errors = validateFactRecord(fact);
    if (errors.length || !await verifyFactRecord(fact)) throw new FactRepositoryError("invalid_input", errors.length ? errors.join("; ") : "fact contentHash mismatch");
    return this.boundary(true, async (repositoryRoot, activeRoot) => {
      await this.ensureSourceClosure(repositoryRoot, activeRoot, fact);
      const file = this.recordFile(repositoryRoot, fact.factId);
      const existing = await this.readEnvelope<StoredFact>(file, "fact", true);
      if (existing) {
        const valid = await this.readStoredFactAt(repositoryRoot, fact.factId);
        if (input.expectedHash !== undefined && input.expectedHash !== valid.fact.contentHash) throw new FactRepositoryError("conflict", "fact expected hash mismatch");
        if (valid.fact.contentHash !== fact.contentHash || valid.recordHash !== sha256Json(fact)) throw new FactRepositoryError("conflict", "immutable fact ID already exists with different content");
        return clone(valid.fact);
      }
      if (input.expectedHash !== undefined) throw new FactRepositoryError("conflict", "fact expected hash does not reference an existing fact");
      if (fact.supersedesFactId) {
        const old = await this.readStoredFactAt(repositoryRoot, fact.supersedesFactId);
        if (old.fact.contentHash !== fact.supersededFactHash) throw new FactRepositoryError("conflict", "replacement old fact hash mismatch");
        if (old.fact.status !== "active" || !same(old.fact.subject, fact.subject) || old.fact.field !== fact.field || old.fact.scope !== fact.scope) {
          throw new FactRepositoryError("conflict", "replacement fact ownership or active status mismatch");
        }
        const records = await this.listStoredFactsAt(repositoryRoot);
        if (records.some((record) => record.fact.supersedesFactId === fact.supersedesFactId)) throw new FactRepositoryError("conflict", "fact already has an immutable replacement");
      }
      const stored: StoredFact = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
      await this.writeEnvelope(file, "fact", stored);
      return clone(fact);
    }, input.maintenanceLeaseToken);
  }

  async getFact(factId: string): Promise<FactRecord> {
    return this.boundary(false, async (repositoryRoot) => clone((await this.readStoredFactAt(repositoryRoot, factId)).fact));
  }

  async getFactAtRoot(activeRoot: string, factId: string): Promise<FactRecord | null> {
    const repositoryRoot = confined(activeRoot, "facts");
    try { return clone((await this.readStoredFactAt(repositoryRoot, factId)).fact); }
    catch (error) { if (error instanceof FactRepositoryError && error.code === "not_found") return null; throw error; }
  }

  async listFacts(): Promise<FactRecord[]> {
    return this.boundary(false, async (repositoryRoot) => (await this.listStoredFactsAt(repositoryRoot)).map((stored) => clone(stored.fact)));
  }

  async listCurrentFacts(): Promise<FactRecord[]> {
    return this.boundary(false, async (repositoryRoot, activeRoot, runtimeGeneration) => {
      const evaluatedAt = this.now();
      return (await this.currentFactsAt(repositoryRoot, activeRoot, evaluatedAt, runtimeGeneration)).map(clone);
    });
  }

  /** Root-pinned current set for server-side, plan-relevance selection. */
  async listCurrentFactsAtRoot(activeRoot: string, runtimeGeneration?: number): Promise<FactRecord[]> {
    const evaluatedAt = this.now();
    return (await this.currentFactsAt(
      confined(activeRoot, "facts"),
      activeRoot,
      evaluatedAt,
      runtimeGeneration,
    )).map(clone);
  }

  private async currentFactsAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    evaluatedAt: string,
    runtimeGeneration?: number,
  ): Promise<FactRecord[]> {
    const all = (await this.listStoredFactsAt(repositoryRoot)).map((stored) => stored.fact);
    const superseded = new Set(all.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
    const candidates = all.filter((fact) => fact.status === "active" && !superseded.has(fact.factId) && effectiveAt(fact, evaluatedAt));
    const current: FactRecord[] = [];
    const pendingInference: FactRecord[] = [];
    for (const fact of candidates) {
      if (fact.authority === "agent_inference") {
        pendingInference.push(fact);
        continue;
      }
      try {
        await this.ensureSourceClosure(repositoryRoot, activeRoot, fact, evaluatedAt);
        current.push(fact);
      } catch (error) {
        if (error instanceof FactRepositoryError && error.code === "invalid_input") continue;
        throw error;
      }
    }

    // A committed Agent inference is current only after all of its own inputs
    // are already current. Repeated passes provide a deterministic topological
    // fixed point; stale ancestors and cycles therefore fail closed instead of
    // being validated against the unfiltered raw active set.
    const approvalsByFactId = new Map<string, InferenceApprovalTransaction>();
    if (this.inferenceCandidateApprovalAuthority) {
      for (const transaction of await this.listInferenceApprovalsAt(repositoryRoot)) {
        if (transaction.status !== "committed") continue;
        if (approvalsByFactId.has(transaction.fact.factId)) {
          throw new FactRepositoryError("corrupt_data", "inference fact has duplicate committed candidate approvals");
        }
        approvalsByFactId.set(transaction.fact.factId, transaction);
      }
    }
    const inferredGeneration = runtimeGeneration ?? (() => {
      const parsed = activeRoot ? Number.parseInt(path.basename(activeRoot), 10) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
    })();
    let remaining = pendingInference.sort((left, right) => left.factId.localeCompare(right.factId));
    let advanced = true;
    while (advanced && remaining.length > 0) {
      advanced = false;
      const deferred: FactRecord[] = [];
      for (const fact of remaining) {
        try {
          await this.ensureSourceClosure(repositoryRoot, activeRoot, fact, evaluatedAt);
          if (!fact.inferenceTraceId || !this.currentInferenceArtifactHash) {
            deferred.push(fact);
            continue;
          }
          const trace = await this.readInferenceAt(repositoryRoot, fact.inferenceTraceId);
          const artifactHash = await this.currentInferenceArtifactHash(trace, activeRoot);
          if (!artifactHash || !await inferenceTraceIsCurrent(trace, current, artifactHash)) {
            deferred.push(fact);
            continue;
          }
          if (this.requireCandidateApprovalForInference && !this.inferenceCandidateApprovalAuthority) {
            deferred.push(fact);
            continue;
          }
          if (this.inferenceCandidateApprovalAuthority) {
            if (!activeRoot) {
              deferred.push(fact);
              continue;
            }
            const transaction = approvalsByFactId.get(fact.factId);
            if (!transaction || !same(transaction.fact, fact) || !same(transaction.trace, trace)) {
              deferred.push(fact);
              continue;
            }
            const closure = await this.inferenceCandidateApprovalAuthority.resolveCurrentFactAtRoot(
              activeRoot,
              inferredGeneration,
              transaction.candidateId,
              transaction.candidateHash,
              current.map((item) => Object.freeze(clone(item))),
            );
            if (!closure || closure.candidate.candidateId !== transaction.candidateId
              || closure.candidate.contentHash !== transaction.candidateHash
              || !same(closure.trace, trace) || !same(closure.proposedFact, fact)) {
              deferred.push(fact);
              continue;
            }
          }
          current.push(fact);
          advanced = true;
        } catch (error) {
          if (error instanceof FactRepositoryError && ["invalid_input", "conflict"].includes(error.code)) {
            deferred.push(fact);
            continue;
          }
          throw error;
        }
      }
      remaining = deferred;
    }
    return current;
  }

  private async currentFactsForPlanAt(
    repositoryRoot: string,
    activeRoot: string,
    planId: string,
    evaluatedAt: string,
  ): Promise<FactRecord[]> {
    assertId(planId, "plan ID");
    if (!this.planFactSelection) throw new FactRepositoryError("invalid_input", "plan fact selection authority is unavailable");
    const current = await this.currentFactsAt(repositoryRoot, activeRoot, evaluatedAt);
    const productFacts = current.filter((fact) => fact.subject.kind === "product");
    const selectedIds = [...await this.planFactSelection.selectRelevantProductFactIdsAtRoot(
      activeRoot,
      planId,
      productFacts.map((fact) => Object.freeze(clone(fact))),
    )];
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new FactRepositoryError("invalid_input", "plan fact selection returned duplicate fact IDs");
    }
    const selected = selectedIds.map((factId) => productFacts.find((fact) => fact.factId === factId));
    if (selected.some((fact) => !fact)) {
      throw new FactRepositoryError("invalid_input", "plan fact selection returned a non-current or non-product fact");
    }
    return [
      ...selected.map((fact) => clone(fact!)),
      ...current.filter((fact) => fact.subject.kind === "plan_subject" && fact.subject.planId === planId).map(clone),
    ].sort((left, right) => left.factId.localeCompare(right.factId));
  }

  /** Plan scope is resolved by a server-side authority, never by transport fact IDs. */
  async listCurrentFactsForPlanAtRoot(activeRoot: string, planId: string): Promise<FactRecord[]> {
    return this.currentFactsForPlanAt(confined(activeRoot, "facts"), activeRoot, planId, this.now());
  }

  private async acceptedDecision(
    activeRoot: string | undefined,
    decisionId: string,
  ): Promise<UpdateDecision> {
    const decision = await this.activeDecisionOrNull(activeRoot, decisionId);
    if (!decision) {
      throw new FactRepositoryError("invalid_input", "conflict resolution decision closure is missing or invalid");
    }
    return decision;
  }

  private async activeDecisionOrNull(
    activeRoot: string | undefined,
    decisionId: string,
  ): Promise<UpdateDecision | null> {
    if (!this.acceptedUpdateDecisions) {
      throw new FactRepositoryError("invalid_input", "accepted update decision closure provider is unavailable");
    }
    if (activeRoot && !this.acceptedUpdateDecisions.getActiveDecisionAtRoot) {
      throw new FactRepositoryError("invalid_input", "coordinated accepted update decision closure provider is unavailable");
    }
    const decision = activeRoot
      ? await this.acceptedUpdateDecisions.getActiveDecisionAtRoot!(activeRoot, decisionId)
      : await this.acceptedUpdateDecisions.getActiveDecision(decisionId);
    if (!decision) return null;
    if (decision.updateDecisionId !== decisionId || !await verifyUpdateDecision(decision)) {
      throw new FactRepositoryError("corrupt_data", "active update decision closure is invalid");
    }
    return decision;
  }

  private async effectiveStoredConflictAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    physicalHead: StoredConflict,
  ): Promise<StoredConflict> {
    const pointer = await this.readConflictPointerAt(repositoryRoot, physicalHead.conflict.conflictSetId, true);
    if (!pointer) return physicalHead;
    const selected = await this.readStoredConflictVersionAt(
      repositoryRoot,
      pointer.conflictSetId,
      pointer.selectedConflictRef.contentHash,
    );
    const previous = await this.readStoredConflictVersionAt(
      repositoryRoot,
      pointer.conflictSetId,
      pointer.previousConflictRef.contentHash,
    );
    const currentDecision = await this.activeDecisionOrNull(activeRoot, pointer.decisionId);
    if (currentDecision) {
      if (currentDecision.contentHash !== pointer.decisionHash
        || updateDecisionMemoryKey(currentDecision) !== pointer.decisionMemoryKey
        || (selected.conflict.status === "resolved"
          ? currentDecision.decision !== "accept" || !selected.conflict.decisionIds.includes(currentDecision.updateDecisionId)
          : currentDecision.decision !== "undo" || currentDecision.supersedesDecisionId !== pointer.previousDecisionId)) {
        throw new FactRepositoryError("corrupt_data", "fact conflict pointer current-decision closure invalid");
      }
      await this.ensureResolvedConflictDecisionClosure(activeRoot, selected.conflict);
      return selected;
    }
    if (pointer.previousDecisionId) {
      const previousDecision = await this.activeDecisionOrNull(activeRoot, pointer.previousDecisionId);
      if (!previousDecision || previousDecision.contentHash !== pointer.previousDecisionHash) {
        throw new FactRepositoryError("corrupt_data", "fact conflict pointer has no active recovery predecessor");
      }
      if (previous.conflict.status === "resolved"
        && !previous.conflict.decisionIds.includes(previousDecision.updateDecisionId)) {
        throw new FactRepositoryError("corrupt_data", "fact conflict pointer predecessor does not own the resolved state");
      }
      await this.ensureResolvedConflictDecisionClosure(activeRoot, previous.conflict);
      return previous;
    }
    if (pointer.revision !== 0 || previous.conflict.status !== "open") {
      throw new FactRepositoryError("corrupt_data", "fact conflict pointer recovery revision invalid");
    }
    return previous;
  }

  private async listEffectiveStoredConflictsAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
  ): Promise<StoredConflict[]> {
    return Promise.all((await this.listStoredConflictsAt(repositoryRoot)).map(
      (head) => this.effectiveStoredConflictAt(repositoryRoot, activeRoot, head),
    ));
  }

  private async ensureResolvedConflictDecisionClosure(
    activeRoot: string | undefined,
    conflict: ConflictSet,
  ): Promise<void> {
    if (conflict.status !== "resolved") return;
    const subjectKey = factSubjectKey(conflict.subject);
    const coveredResolutionFactIds = new Set<string>();
    for (const decisionId of conflict.decisionIds) {
      const decision = await this.acceptedDecision(activeRoot, decisionId);
      const resolutionIds = conflict.resolutionFactIds.filter((factId) => decision.newFactIds.includes(factId));
      if (decision.decision !== "accept" || decision.subjectKey !== subjectKey || decision.claimKey !== conflict.field
        || resolutionIds.length === 0
        || Date.parse(decision.decidedAt) < Date.parse(conflict.createdAt)
        || Date.parse(decision.decidedAt) > Date.parse(conflict.resolvedAt!)) {
        throw new FactRepositoryError("invalid_input", "conflict resolution decision does not own its accepted subject, field, facts, or time");
      }
      for (const factId of resolutionIds) coveredResolutionFactIds.add(factId);
    }
    if (coveredResolutionFactIds.size !== conflict.resolutionFactIds.length) {
      throw new FactRepositoryError("invalid_input", "conflict resolution facts are not covered by accepted update decisions");
    }
  }

  private conflictStaticAuthority(conflict: ConflictSet): Omit<ConflictSet, "status" | "resolutionFactIds" | "decisionIds" | "resolvedAt" | "contentHash"> {
    const {
      status: _status,
      resolutionFactIds: _resolutionFactIds,
      decisionIds: _decisionIds,
      resolvedAt: _resolvedAt,
      contentHash: _contentHash,
      ...material
    } = conflict;
    return material;
  }

  private async validateUpdateConflictTransition(
    decision: UpdateDecision,
    transition: FactUpdateConflictTransition,
  ): Promise<void> {
    const pointer = transition.pointer;
    if (transition.schemaVersion !== "fact-update-conflict-transition-v1"
      || pointer.decisionId !== decision.updateDecisionId || pointer.decisionHash !== decision.contentHash
      || pointer.decisionMemoryKey !== updateDecisionMemoryKey(decision)
      || pointer.previousConflictRef.contentHash !== transition.before.contentHash
      || pointer.selectedConflictRef.contentHash !== transition.after.contentHash
      || transition.before.conflictSetId !== pointer.conflictSetId
      || transition.after.conflictSetId !== pointer.conflictSetId
      || !same(this.conflictStaticAuthority(transition.before), this.conflictStaticAuthority(transition.after))
      || !await verifyConflictSet(transition.before) || !await verifyConflictSet(transition.after)) {
      throw new FactRepositoryError("invalid_input", "fact update conflict transition authority invalid");
    }
    if (decision.decision === "accept") {
      if (transition.before.status !== "open" || transition.after.status !== "resolved"
        || !same(transition.after.resolutionFactIds, decision.newFactIds)
        || !same(transition.after.decisionIds, [decision.updateDecisionId])
        || transition.after.resolvedAt !== decision.decidedAt
        || !decision.oldFactIds.every((id) => transition.before.factIds.includes(id))
        || !decision.newFactIds.every((id) => transition.before.factIds.includes(id))) {
        throw new FactRepositoryError("invalid_input", "accepted update does not exactly own its conflict resolution");
      }
    } else if (decision.decision === "undo") {
      if (transition.before.status !== "resolved" || transition.after.status !== "open"
        || !decision.supersedesDecisionId
        || !transition.before.decisionIds.includes(decision.supersedesDecisionId)
        || pointer.previousDecisionId !== decision.supersedesDecisionId
        || pointer.previousDecisionHash !== decision.supersedesDecisionHash) {
        throw new FactRepositoryError("invalid_input", "undo does not exactly restore its accepted conflict predecessor");
      }
    } else {
      throw new FactRepositoryError("invalid_input", "reject/defer cannot transition conflict lifecycle");
    }
  }

  private async transitionFromPointerAt(
    repositoryRoot: string,
    decision: UpdateDecision,
    pointer: FactUpdateConflictPointer,
  ): Promise<FactUpdateConflictTransition> {
    const before = (await this.readStoredConflictVersionAt(
      repositoryRoot,
      pointer.conflictSetId,
      pointer.previousConflictRef.contentHash,
    )).conflict;
    const after = (await this.readStoredConflictVersionAt(
      repositoryRoot,
      pointer.conflictSetId,
      pointer.selectedConflictRef.contentHash,
    )).conflict;
    const transition: FactUpdateConflictTransition = {
      schemaVersion: "fact-update-conflict-transition-v1",
      pointer: clone(pointer),
      before: clone(before),
      after: clone(after),
    };
    await this.validateUpdateConflictTransition(decision, transition);
    return transition;
  }

  private async prepareUpdateConflictTransitionsAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    decision: UpdateDecision,
  ): Promise<FactUpdateConflictTransition[]> {
    if (decision.decision !== "accept" && decision.decision !== "undo") return [];
    if (!await verifyUpdateDecision(decision)) {
      throw new FactRepositoryError("invalid_input", "fact update conflict decision authority invalid");
    }
    const heads = await this.listStoredConflictsAt(repositoryRoot);
    const transitions: FactUpdateConflictTransition[] = [];
    for (const head of heads) {
      const existingPointer = await this.readConflictPointerAt(repositoryRoot, head.conflict.conflictSetId, true);
      if (existingPointer?.decisionId === decision.updateDecisionId) {
        transitions.push(await this.transitionFromPointerAt(repositoryRoot, decision, existingPointer));
        continue;
      }
      const effective = await this.effectiveStoredConflictAt(repositoryRoot, activeRoot, head);
      const conflict = effective.conflict;
      if (factSubjectKey(conflict.subject) !== decision.subjectKey || conflict.field !== decision.claimKey) continue;
      let before: ConflictSet;
      let after: ConflictSet;
      if (decision.decision === "accept") {
        if (conflict.status !== "open"
          || !decision.oldFactIds.every((id) => conflict.factIds.includes(id))
          || !decision.newFactIds.every((id) => conflict.factIds.includes(id))) continue;
        before = conflict;
        after = await createConflictSet({
          ...this.conflictStaticAuthority(conflict),
          status: "resolved",
          resolutionFactIds: clone(decision.newFactIds),
          decisionIds: [decision.updateDecisionId],
          resolvedAt: decision.decidedAt,
        });
      } else {
        if (conflict.status !== "resolved" || !decision.supersedesDecisionId
          || !conflict.decisionIds.includes(decision.supersedesDecisionId)) continue;
        before = conflict;
        if (existingPointer && existingPointer.selectedConflictRef.contentHash === conflict.contentHash) {
          after = (await this.readStoredConflictVersionAt(
            repositoryRoot,
            conflict.conflictSetId,
            existingPointer.previousConflictRef.contentHash,
          )).conflict;
        } else {
          const openVersions = (await this.listStoredConflictVersionsAt(repositoryRoot)).filter((stored) => (
            stored.conflict.conflictSetId === conflict.conflictSetId
              && stored.conflict.status === "open"
              && same(this.conflictStaticAuthority(stored.conflict), this.conflictStaticAuthority(conflict))
          ));
          if (openVersions.length !== 1) {
            throw new FactRepositoryError("corrupt_data", "resolved conflict has no unique immutable open predecessor");
          }
          after = openVersions[0]!.conflict;
        }
      }
      const previousDecisionId = decision.decision === "undo"
        ? decision.supersedesDecisionId
        : existingPointer?.decisionId;
      const previousDecisionHash = decision.decision === "undo"
        ? decision.supersedesDecisionHash
        : existingPointer?.decisionHash;
      const pointer: FactUpdateConflictPointer = {
        schemaVersion: "fact-update-conflict-pointer-v1",
        conflictKey: this.conflictKey(conflict.conflictSetId),
        conflictSetId: conflict.conflictSetId,
        revision: existingPointer ? existingPointer.revision + 1 : 0,
        decisionId: decision.updateDecisionId,
        decisionHash: decision.contentHash,
        decisionMemoryKey: updateDecisionMemoryKey(decision),
        selectedConflictRef: { conflictSetId: conflict.conflictSetId, contentHash: after.contentHash },
        previousConflictRef: { conflictSetId: conflict.conflictSetId, contentHash: before.contentHash },
        ...(previousDecisionId && previousDecisionHash ? { previousDecisionId, previousDecisionHash } : {}),
        updatedAt: decision.decidedAt,
      };
      const transition: FactUpdateConflictTransition = {
        schemaVersion: "fact-update-conflict-transition-v1",
        pointer,
        before: clone(before),
        after: clone(after),
      };
      await this.validateUpdateConflictTransition(decision, transition);
      transitions.push(transition);
    }
    return transitions.sort((left, right) => left.pointer.conflictSetId.localeCompare(right.pointer.conflictSetId));
  }

  /** Derives conflict lifecycle bytes from repository authority; no transport bytes are accepted. */
  async prepareUpdateConflictTransitionsAtRoot(
    activeRoot: string,
    decision: UpdateDecision,
  ): Promise<FactUpdateConflictTransition[]> {
    return clone(await this.prepareUpdateConflictTransitionsAt(confined(activeRoot, "facts"), activeRoot, decision));
  }

  async prepareUpdateConflictTransitions(decision: UpdateDecision): Promise<FactUpdateConflictTransition[]> {
    return this.boundary(false, async (repositoryRoot, activeRoot) => (
      clone(await this.prepareUpdateConflictTransitionsAt(repositoryRoot, activeRoot, decision))
    ));
  }

  private async publishUpdateConflictTransitionsAt(
    repositoryRoot: string,
    decision: UpdateDecision,
    transitions: readonly FactUpdateConflictTransition[],
  ): Promise<void> {
    if (new Set(transitions.map((transition) => transition.pointer.conflictSetId)).size !== transitions.length) {
      throw new FactRepositoryError("invalid_input", "fact update conflict transition set contains duplicates");
    }
    for (const transition of transitions) {
      await this.validateUpdateConflictTransition(decision, transition);
      const currentPointer = await this.readConflictPointerAt(repositoryRoot, transition.pointer.conflictSetId, true);
      if (currentPointer && same(currentPointer, transition.pointer)) continue;
      if (currentPointer) {
        if (transition.pointer.revision !== currentPointer.revision + 1
          || transition.pointer.previousConflictRef.contentHash !== currentPointer.selectedConflictRef.contentHash
          || transition.pointer.previousDecisionId !== currentPointer.decisionId
          || transition.pointer.previousDecisionHash !== currentPointer.decisionHash) {
          throw new FactRepositoryError("conflict", "fact update conflict pointer CAS mismatch");
        }
      } else {
        const head = await this.readStoredConflictAt(repositoryRoot, transition.pointer.conflictSetId);
        if (transition.pointer.revision !== 0 || head.conflict.contentHash !== transition.before.contentHash) {
          throw new FactRepositoryError("conflict", "initial fact update conflict pointer CAS mismatch");
        }
      }
      const ensureVersion = async (conflict: ConflictSet, fallbackRevision: number) => {
        const existing = await this.readEnvelope<StoredConflict>(
          this.conflictVersionFile(repositoryRoot, conflict.contentHash),
          "conflict",
          true,
        );
        if (existing) {
          await this.validateStoredConflict(existing, conflict.conflictSetId, conflict.contentHash);
          if (!same(existing.conflict, conflict)) throw new FactRepositoryError("corrupt_data", "fact conflict version payload collision");
          return;
        }
        await this.writeConflictVersionAt(repositoryRoot, {
          schemaVersion: "fact-repository-v1",
          revision: fallbackRevision,
          recordHash: sha256Json(conflict),
          conflict: clone(conflict),
        });
      };
      await ensureVersion(transition.before, Math.max(0, transition.pointer.revision));
      await ensureVersion(transition.after, transition.pointer.revision + 1);
      await this.writeEnvelope(
        this.conflictPointerFile(repositoryRoot, transition.pointer.conflictSetId),
        "conflict-pointer",
        clone(transition.pointer),
      );
    }
  }

  /** Publishes exact transaction-embedded transitions before the decision memory commit point. */
  async publishUpdateConflictTransitionsAtRoot(
    activeRoot: string,
    decision: UpdateDecision,
    transitions: readonly FactUpdateConflictTransition[],
  ): Promise<void> {
    await this.publishUpdateConflictTransitionsAt(confined(activeRoot, "facts"), decision, transitions);
  }

  async publishUpdateConflictTransitions(
    decision: UpdateDecision,
    transitions: readonly FactUpdateConflictTransition[],
  ): Promise<void> {
    await this.boundary(true, (repositoryRoot) => (
      this.publishUpdateConflictTransitionsAt(repositoryRoot, decision, transitions)
    ));
  }

  async putConflict(input: PutConflictInput): Promise<ConflictSet> {
    const conflict = clone(input.conflict);
    assertId(conflict.conflictSetId, "conflict set ID");
    const errors = validateConflictSet(conflict);
    if (errors.length || !await verifyConflictSet(conflict)) throw new FactRepositoryError("invalid_input", errors.length ? errors.join("; ") : "conflict contentHash mismatch");
    return this.boundary(true, async (repositoryRoot, activeRoot) => {
      if (await this.readConflictPointerAt(repositoryRoot, conflict.conflictSetId, true)) {
        throw new FactRepositoryError("conflict", "decision-governed conflict lifecycle cannot be mutated directly");
      }
      const facts = await Promise.all(conflict.factIds.map((factId) => this.readStoredFactAt(repositoryRoot, factId)));
      if (facts.some((stored) => !same(stored.fact.subject, conflict.subject) || stored.fact.field !== conflict.field)) throw new FactRepositoryError("invalid_input", "conflict facts do not share subject and field ownership");
      for (const factId of conflict.resolutionFactIds) {
        const resolution = await this.readStoredFactAt(repositoryRoot, factId);
        if (!same(resolution.fact.subject, conflict.subject) || resolution.fact.field !== conflict.field) {
          throw new FactRepositoryError("invalid_input", "conflict resolution facts do not share subject and field ownership");
        }
      }
      const existing = await this.readEnvelope<StoredConflict>(this.conflictFile(repositoryRoot, conflict.conflictSetId), "conflict", true);
      if (!existing) {
        if (input.expectedHash !== undefined) throw new FactRepositoryError("conflict", "conflict expected hash does not reference an existing set");
        if (conflict.status !== "open") throw new FactRepositoryError("conflict", "a conflict set must be recorded open before it can be resolved");
        const stored: StoredConflict = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(conflict), conflict };
        await this.writeConflictVersionAt(repositoryRoot, stored);
        await this.writeEnvelope(this.conflictFile(repositoryRoot, conflict.conflictSetId), "conflict", stored);
        return clone(conflict);
      }
      const current = await this.readStoredConflictAt(repositoryRoot, conflict.conflictSetId);
      if (input.expectedHash === undefined || input.expectedHash !== current.conflict.contentHash) throw new FactRepositoryError("conflict", "conflict set CAS hash mismatch");
      if (current.conflict.status !== "open" || conflict.status !== "resolved"
        || !same({ ...current.conflict, status: undefined, resolutionFactIds: undefined, decisionIds: undefined, resolvedAt: undefined, contentHash: undefined },
          { ...conflict, status: undefined, resolutionFactIds: undefined, decisionIds: undefined, resolvedAt: undefined, contentHash: undefined })) {
        throw new FactRepositoryError("conflict", "only an ownership-preserving open-to-resolved transition is allowed");
      }
      await this.ensureResolvedConflictDecisionClosure(activeRoot, conflict);
      // Persist both sides before advancing the mutable head. This also
      // upgrades a legacy open head on its first resolution.
      await this.writeConflictVersionAt(repositoryRoot, current);
      const stored: StoredConflict = { schemaVersion: "fact-repository-v1", revision: current.revision + 1, recordHash: sha256Json(conflict), conflict };
      await this.writeConflictVersionAt(repositoryRoot, stored);
      await this.writeEnvelope(this.conflictFile(repositoryRoot, conflict.conflictSetId), "conflict", stored);
      return clone(conflict);
    }, input.maintenanceLeaseToken);
  }

  async getConflict(conflictSetId: string): Promise<ConflictSet> {
    return this.boundary(false, async (repositoryRoot, activeRoot) => clone((
      await this.effectiveStoredConflictAt(repositoryRoot, activeRoot, await this.readStoredConflictAt(repositoryRoot, conflictSetId))
    ).conflict));
  }

  async getConflictAtRoot(activeRoot: string, conflictSetId: string): Promise<ConflictSet | null> {
    const repositoryRoot = confined(activeRoot, "facts");
    try {
      return clone((await this.effectiveStoredConflictAt(
        repositoryRoot,
        activeRoot,
        await this.readStoredConflictAt(repositoryRoot, conflictSetId),
      )).conflict);
    } catch (error) {
      if (error instanceof FactRepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  private ensureSnapshotConflictClosure(selected: readonly FactRecord[], conflicts: readonly ConflictSet[]): void {
    const selectedIds = new Set(selected.map((fact) => fact.factId));
    if (conflicts.some((conflict) => conflict.status !== "open"
      || conflict.factIds.some((factId) => !selectedIds.has(factId)))) {
      throw new FactRepositoryError("invalid_input", "fact snapshot conflict is not open over the selected fact closure");
    }
    const groups = new Map<string, FactRecord[]>();
    for (const fact of selected) {
      const key = `${factSubjectKey(fact.subject)}\0${fact.field}`;
      const group = groups.get(key) ?? [];
      group.push(fact);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (new Set(group.map((fact) => sha256Json({ value: fact.value, unit: fact.unit }))).size <= 1) continue;
      const first = group[0]!;
      const groupIds = group.map((fact) => fact.factId).sort();
      const covered = conflicts.some((conflict) => conflict.field === first.field
        && factSubjectKey(conflict.subject) === factSubjectKey(first.subject)
        && same([...conflict.factIds].sort(), groupIds));
      if (!covered) {
        throw new FactRepositoryError("invalid_input", "divergent current facts require one complete open conflict set in the snapshot");
      }
    }
  }

  private async persistSnapshotAt(
    repositoryRoot: string,
    selected: readonly FactRecord[],
    conflicts: readonly StoredConflict[],
    createdAt: string,
    expectedActiveSetHash?: string,
  ): Promise<FactSnapshot> {
    this.ensureSnapshotConflictClosure(selected, conflicts.map((stored) => stored.conflict));
    const factRefs = selected.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash }))
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const conflictRefs = conflicts.map((stored) => ({
      conflictSetId: stored.conflict.conflictSetId,
      contentHash: stored.conflict.contentHash,
    })).sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    const activeSetHash = sha256Json({ factRefs, conflictRefs });
    if (expectedActiveSetHash !== undefined && expectedActiveSetHash !== activeSetHash) {
      throw new FactRepositoryError("conflict", "fact active set changed before snapshot creation");
    }
    const snapshot = await createFactSnapshot({ schemaVersion: "fact-snapshot-v2", factRefs, conflictRefs, createdAt });
    const file = this.snapshotFile(repositoryRoot, snapshot.snapshotId);
    const existing = await this.readEnvelope<FactSnapshot>(file, "snapshot", true);
    if (existing) {
      const valid = await this.readSnapshotAt(repositoryRoot, snapshot.snapshotId);
      if (valid.contentHash !== snapshot.contentHash) throw new FactRepositoryError("corrupt_data", "fact snapshot identity collision");
      return clone(valid);
    }
    await this.writeEnvelope(file, "snapshot", snapshot);
    return clone(snapshot);
  }

  private async snapshotConflictsForFactsAt(
    repositoryRoot: string,
    activeRoot: string | undefined,
    selected: readonly FactRecord[],
    requestedConflictIds?: readonly string[],
  ): Promise<StoredConflict[]> {
    const allConflicts = await this.listEffectiveStoredConflictsAt(repositoryRoot, activeRoot);
    const selectedIdSet = new Set(selected.map((fact) => fact.factId));
    const applicable = allConflicts.filter((stored) => stored.conflict.status === "open"
      && stored.conflict.factIds.every((factId) => selectedIdSet.has(factId)));
    const conflictIds = requestedConflictIds ? [...requestedConflictIds] : applicable.map((stored) => stored.conflict.conflictSetId);
    if (new Set(conflictIds).size !== conflictIds.length) {
      throw new FactRepositoryError("invalid_input", "fact snapshot contains duplicate conflict IDs");
    }
    if (applicable.some((stored) => !conflictIds.includes(stored.conflict.conflictSetId))) {
      throw new FactRepositoryError("invalid_input", "fact snapshot cannot omit an applicable open conflict set");
    }
    const conflicts = conflictIds.map((id) => allConflicts.find((stored) => stored.conflict.conflictSetId === id));
    if (conflicts.some((conflict) => !conflict)) {
      throw new FactRepositoryError("invalid_input", "fact snapshot conflict closure is incomplete");
    }
    return conflicts.map((stored) => stored!);
  }

  private async createSnapshotAt(repositoryRoot: string, activeRoot: string | undefined, input: CreateFactSnapshotInput): Promise<FactSnapshot> {
    const snapshotCreatedAt = this.now();
    const current = await this.currentFactsAt(repositoryRoot, activeRoot, snapshotCreatedAt);
    const selectedIds = input.factIds ? [...input.factIds] : current.map((fact) => fact.factId);
    if (new Set(selectedIds).size !== selectedIds.length) throw new FactRepositoryError("invalid_input", "fact snapshot contains duplicate fact IDs");
    const selected = selectedIds.map((id) => current.find((fact) => fact.factId === id));
    if (selected.some((fact) => !fact)) throw new FactRepositoryError("invalid_input", "fact snapshot may only pin current active facts");
    const conflicts = await this.snapshotConflictsForFactsAt(repositoryRoot, activeRoot, selected.map((fact) => fact!), input.conflictSetIds);
    return this.persistSnapshotAt(repositoryRoot, selected.map((fact) => fact!), conflicts, snapshotCreatedAt, input.expectedActiveSetHash);
  }

  async createSnapshot(input: CreateFactSnapshotInput = {}): Promise<FactSnapshot> {
    return this.boundary(true, (repositoryRoot, activeRoot) => this.createSnapshotAt(repositoryRoot, activeRoot, input), input.maintenanceLeaseToken);
  }

  /** Root-bound write for an outer RuntimeCoordinator transaction; never reacquires the barrier. */
  async createSnapshotAtRoot(activeRoot: string, input: Omit<CreateFactSnapshotInput, "maintenanceLeaseToken"> = {}): Promise<FactSnapshot> {
    return this.createSnapshotAt(confined(activeRoot, "facts"), activeRoot, input);
  }

  /**
   * Creates the plan's current snapshot from a server-injected relevance
   * selector. Product facts from other plans/SKUs and every other plan's
   * plan_subject observations are excluded before hashing.
   */
  async createCurrentSnapshotForPlanAtRoot(activeRoot: string, planId: string): Promise<FactSnapshot> {
    const repositoryRoot = confined(activeRoot, "facts");
    const snapshotCreatedAt = this.now();
    const selected = await this.currentFactsForPlanAt(repositoryRoot, activeRoot, planId, snapshotCreatedAt);
    const conflicts = await this.snapshotConflictsForFactsAt(repositoryRoot, activeRoot, selected);
    return this.persistSnapshotAt(repositoryRoot, selected, conflicts, snapshotCreatedAt);
  }

  /**
   * Materializes one server-authorized, single-field candidate. All unrelated
   * immutable refs from the selected plan snapshot are preserved exactly.
   */
  async createFactUpdateCandidateSnapshotAtRoot(
    activeRoot: string,
    input: CreateFactUpdateCandidateSnapshotInput,
  ): Promise<FactSnapshot> {
    assertId(input.planId, "plan ID");
    assertId(input.baseSnapshotId, "fact snapshot ID");
    if (!input.subjectKey || input.subjectKey !== input.subjectKey.normalize("NFC")
      || !input.field || input.field !== input.field.normalize("NFC")
      || input.replacementFactIds.length === 0
      || new Set(input.replacementFactIds).size !== input.replacementFactIds.length) {
      throw new FactRepositoryError("invalid_input", "fact update candidate selector invalid");
    }
    const repositoryRoot = confined(activeRoot, "facts");
    const snapshotCreatedAt = this.now();
    const base = await this.readSnapshotAt(repositoryRoot, input.baseSnapshotId);
    const baseFacts = await Promise.all(base.factRefs.map(async (ref) => (await this.readStoredFactAt(repositoryRoot, ref.factId)).fact));
    if (baseFacts.some((fact) => fact.subject.kind === "plan_subject" && fact.subject.planId !== input.planId)) {
      throw new FactRepositoryError("invalid_input", "fact update base snapshot crosses plan_subject ownership");
    }
    const oldGroup = baseFacts.filter((fact) => factSubjectKey(fact.subject) === input.subjectKey && fact.field === input.field);
    if (!oldGroup.length || oldGroup.some((fact) => fact.subject.kind !== "product")) {
      throw new FactRepositoryError("invalid_input", "fact update candidate has no selected product field authority");
    }
    const current = await this.currentFactsAt(repositoryRoot, activeRoot, snapshotCreatedAt);
    const replacements = input.replacementFactIds.map((factId) => current.find((fact) => fact.factId === factId));
    if (replacements.some((fact) => !fact)
      || replacements.some((fact) => fact!.subject.kind !== "product"
        || factSubjectKey(fact!.subject) !== input.subjectKey || fact!.field !== input.field)) {
      throw new FactRepositoryError("invalid_input", "fact update candidate replacement is not a current fact for its product field");
    }
    const candidateFacts = [
      ...baseFacts.filter((fact) => factSubjectKey(fact.subject) !== input.subjectKey || fact.field !== input.field),
      ...replacements.map((fact) => fact!),
    ].sort((left, right) => left.factId.localeCompare(right.factId));
    if (new Set(candidateFacts.map((fact) => fact.factId)).size !== candidateFacts.length
      || same(base.factRefs, candidateFacts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })))) {
      throw new FactRepositoryError("invalid_input", "fact update candidate does not change its selected field");
    }
    const conflicts = await this.snapshotConflictsForFactsAt(
      repositoryRoot,
      activeRoot,
      candidateFacts,
      base.conflictRefs.map((ref) => ref.conflictSetId),
    );
    return this.persistSnapshotAt(repositoryRoot, candidateFacts, conflicts, snapshotCreatedAt);
  }

  /** Resolves every immutable payload referenced by one verified snapshot at the same active root. */
  async getSnapshotClosureAtRoot(activeRoot: string, snapshotId: string): Promise<ResolvedFactRepositorySnapshotClosure | null> {
    const repositoryRoot = confined(activeRoot, "facts");
    try {
      const snapshot = await this.readSnapshotAt(repositoryRoot, snapshotId);
      const facts = await Promise.all(snapshot.factRefs.map(async (ref) => clone((await this.readStoredFactAt(repositoryRoot, ref.factId)).fact)));
      const conflicts = await Promise.all(snapshot.conflictRefs.map(async (ref) => clone((
        await this.readStoredConflictVersionAt(repositoryRoot, ref.conflictSetId, ref.contentHash)
      ).conflict)));
      return { snapshot: clone(snapshot), facts, conflicts };
    } catch (error) {
      if (error instanceof FactRepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  async createCurrentSnapshotClosureAtRoot(activeRoot: string): Promise<ResolvedFactRepositorySnapshotClosure> {
    const snapshot = await this.createSnapshotAtRoot(activeRoot);
    const closure = await this.getSnapshotClosureAtRoot(activeRoot, snapshot.snapshotId);
    if (!closure) throw new FactRepositoryError("corrupt_data", "new fact snapshot closure disappeared");
    return closure;
  }

  async createCurrentSnapshotClosureForPlanAtRoot(
    activeRoot: string,
    planId: string,
  ): Promise<ResolvedFactRepositorySnapshotClosure> {
    const snapshot = await this.createCurrentSnapshotForPlanAtRoot(activeRoot, planId);
    const closure = await this.getSnapshotClosureAtRoot(activeRoot, snapshot.snapshotId);
    if (!closure) throw new FactRepositoryError("corrupt_data", "new plan fact snapshot closure disappeared");
    return closure;
  }

  async getSnapshot(snapshotId: string): Promise<FactSnapshot> {
    return this.boundary(false, (repositoryRoot) => this.readSnapshotAt(repositoryRoot, snapshotId));
  }

  async getSnapshotAtRoot(activeRoot: string, snapshotId: string): Promise<FactSnapshot | null> {
    try { return await this.readSnapshotAt(confined(activeRoot, "facts"), snapshotId); }
    catch (error) { if (error instanceof FactRepositoryError && error.code === "not_found") return null; throw error; }
  }

  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "facts";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const repositoryRoot = confined(activeRoot, "facts");
    const facts = await this.listStoredFactsAt(repositoryRoot);
    const conflicts = await this.listStoredConflictsAt(repositoryRoot);
    const conflictVersions = await this.listStoredConflictVersionsAt(repositoryRoot);
    const effectiveConflictVersions = [
      ...conflictVersions,
      ...conflicts.filter((head) => !conflictVersions.some((version) => (
        version.conflict.contentHash === head.conflict.contentHash
      ))),
    ];
    const inferences = await this.listInferencesAt(repositoryRoot);
    const inferenceApprovals = await this.listInferenceApprovalsAt(repositoryRoot);
    const snapshotIds = await this.listFiles(confined(repositoryRoot, "snapshots"), "fact snapshots");
    const snapshots = await Promise.all(snapshotIds.map((id) => this.readSnapshotAt(repositoryRoot, id)));
    const nodes = [
      ...facts.map((stored) => `fact:${stored.fact.factId}`),
      ...conflicts.map((stored) => `fact-conflict:${stored.conflict.conflictSetId}`),
      ...effectiveConflictVersions.map((stored) => `fact-conflict-version:${stored.conflict.conflictSetId}@sha256:${stored.conflict.contentHash}`),
      ...inferences.map((trace) => `fact-inference:${trace.inferenceTraceId}`),
      ...inferenceApprovals.map((transaction) => `fact-inference-approval:${transaction.transactionId}`),
      ...snapshots.map((snapshot) => `fact-snapshot:${snapshot.snapshotId}`),
    ].sort();
    const edges = [
      ...facts.flatMap((stored) => stored.fact.authority === "official" || stored.fact.authority === "third_party"
        ? stored.fact.evidenceRefs.map((id) => ({ fromRef: `fact:${stored.fact.factId}`, toRef: `evidence-claim:${id}`, necessity: "required_for_replay" as const }))
        : stored.fact.authority === "user_observation"
          ? stored.fact.evidenceRefs.map((ref) => ({ fromRef: `fact:${stored.fact.factId}`, toRef: `observation:${OBSERVATION_REF.exec(ref)?.[1] ?? "invalid"}`, necessity: "required_for_replay" as const }))
          : [
            ...stored.fact.derivedFromFactIds.map((id) => ({ fromRef: `fact:${stored.fact.factId}`, toRef: `fact:${id}`, necessity: "required_for_replay" as const })),
            ...(stored.fact.inferenceTraceId ? [{ fromRef: `fact:${stored.fact.factId}`, toRef: `fact-inference:${stored.fact.inferenceTraceId}`, necessity: "required_for_replay" as const }] : []),
          ]),
      ...inferences.flatMap((trace) => trace.inputFactRefs.map((ref) => ({ fromRef: `fact-inference:${trace.inferenceTraceId}`, toRef: `fact:${ref.factId}`, necessity: "required_for_replay" as const }))),
      ...inferenceApprovals.flatMap((transaction) => transaction.status === "committed" ? [
        { fromRef: `fact-inference-approval:${transaction.transactionId}`, toRef: `fact-inference:${transaction.trace.inferenceTraceId}`, necessity: "required_for_replay" as const },
        { fromRef: `fact-inference-approval:${transaction.transactionId}`, toRef: `fact:${transaction.fact.factId}`, necessity: "required_for_replay" as const },
      ] : []),
      ...conflicts.map((stored) => ({
        fromRef: `fact-conflict:${stored.conflict.conflictSetId}`,
        toRef: `fact-conflict-version:${stored.conflict.conflictSetId}@sha256:${stored.conflict.contentHash}`,
        necessity: "required_for_replay" as const,
      })),
      ...effectiveConflictVersions.flatMap((stored) => [
        ...new Set([...stored.conflict.factIds, ...stored.conflict.resolutionFactIds]),
      ].map((id) => ({ fromRef: `fact-conflict-version:${stored.conflict.conflictSetId}@sha256:${stored.conflict.contentHash}`, toRef: `fact:${id}`, necessity: "required_for_replay" as const }))),
      ...effectiveConflictVersions.flatMap((stored) => stored.conflict.decisionIds.map((id) => ({ fromRef: `fact-conflict-version:${stored.conflict.conflictSetId}@sha256:${stored.conflict.contentHash}`, toRef: `fact-update-decision:${id}`, necessity: "required_for_replay" as const }))),
      ...snapshots.flatMap((snapshot) => [
        ...snapshot.factRefs.map((ref) => ({ fromRef: `fact-snapshot:${snapshot.snapshotId}`, toRef: `fact:${ref.factId}`, necessity: "required_for_replay" as const })),
        ...snapshot.conflictRefs.map((ref) => ({ fromRef: `fact-snapshot:${snapshot.snapshotId}`, toRef: `fact-conflict-version:${ref.conflictSetId}@sha256:${ref.contentHash}`, necessity: "required_for_replay" as const })),
      ]),
    ].sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
    return {
      providerId: "facts",
      revision: facts.length + conflicts.reduce((sum, item) => sum + item.revision + 1, 0) + conflictVersions.length
        + inferences.length + inferenceApprovals.length + snapshots.length,
      manifestHash: sha256Json({
        facts: facts.map((stored) => ({ factId: stored.fact.factId, contentHash: stored.fact.contentHash, recordHash: stored.recordHash })),
        conflicts: conflicts.map((stored) => ({ conflictSetId: stored.conflict.conflictSetId, contentHash: stored.conflict.contentHash, revision: stored.revision })),
        conflictVersions: conflictVersions.map((stored) => ({ conflictSetId: stored.conflict.conflictSetId, contentHash: stored.conflict.contentHash, revision: stored.revision })),
        inferences: inferences.map((trace) => ({ inferenceTraceId: trace.inferenceTraceId, contentHash: trace.contentHash })),
        inferenceApprovals: inferenceApprovals.map((transaction) => ({
          transactionId: transaction.transactionId,
          status: transaction.status,
          contentHash: transaction.contentHash,
        })),
        snapshots: snapshots.map((snapshot) => ({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash })),
      }),
      snapshotPointers: snapshots.map((snapshot) => `fact-snapshot:${snapshot.snapshotId}`).sort(),
      nodes,
      edges,
    };
  }
}
