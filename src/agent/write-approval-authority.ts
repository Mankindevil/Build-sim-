import { createHash, randomBytes } from "node:crypto";
import { AGENT_CONTRACT_VERSION, type AgentPendingWriteApproval, type AgentToolCall, type AgentWriteApprovalEnvelope } from "./contracts";
import { agentAuditHash } from "./audit";
import { validateWriteApprovalEnvelope } from "./approval-contract";
import { stableAgentJson } from "./evaluation-contract";
import type { BackgroundJob, BackgroundJobStatus } from "../jobs/contracts";
import { validateBackgroundJob } from "../jobs/contracts";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { confined, readJson, sha256Json } from "../runtime/fs.mjs";
import {
  agentWriteApprovalArtifactMetadataRuntime,
  agentWriteApprovalArtifactReferencesRuntime,
  validateAgentWriteApprovalArtifactClosureRuntime,
  validateAgentWriteApprovalArtifactRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "./write-approval-runtime.mjs";

const REF = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const REVIEWER = /^[A-Za-z0-9._:-]{8,160}$/;
const MAX_LIFETIME_MS = 10 * 60_000;
const APPROVAL_MEDIA_TYPE = "application/vnd.buildsim.agent-write-approval+json";

export interface AgentWriteApprovalExecution {
  toolName: string;
  toolDefinitionHash: string;
  sessionId: string;
  runId: string;
  inputHash: string;
  callId: string;
}

interface ApprovalArtifactStore {
  put(input: {
    bytes: Buffer;
    mediaType: string;
    privacyClass: "runtime_internal";
    kind: string;
    references?: Array<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }>;
  }, options?: {
    expectedRuntimeGeneration?: number;
    expectedJobLease?: { jobId: string; expectedRevision: number; leaseToken: string };
  }): Promise<{ record: { ref: string } }>;
  get(ref: string): Promise<{
    bytes: Buffer;
    record: {
      schemaVersion: string;
      ref: string;
      sha256: string;
      byteLength: number;
      mediaType: string;
      privacyClass: string;
      kind: string;
      references: Array<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }>;
    };
  } | null>;
}

interface ApprovalJobStore {
  get(jobId: string): Promise<BackgroundJob>;
}

export interface AgentApprovalWriteFence {
  runtimeGeneration: number;
  jobId: string;
  expectedRevision: number;
  leaseToken: string;
}

interface PendingArtifact {
  schemaVersion: "agent-write-approval-pending-v1";
  pending: AgentPendingWriteApproval;
}

interface ConfirmedArtifact {
  schemaVersion: "agent-write-approval-confirmed-v1";
  pendingRef: string;
  pending: AgentPendingWriteApproval;
  envelope: AgentWriteApprovalEnvelope;
}

interface ConsumedArtifact {
  schemaVersion: "agent-write-approval-consumed-v1";
  confirmedRef: string;
  pending: AgentPendingWriteApproval;
  envelope: AgentWriteApprovalEnvelope;
  resultHash: string;
  consumedAt: string;
}

type ApprovalArtifact = PendingArtifact | ConfirmedArtifact | ConsumedArtifact;

interface ReadApprovalArtifact {
  artifact: ApprovalArtifact;
  authorityRef: string;
}

const validatedProofs = new WeakSet<object>();
const validatedDurableMaterials = new WeakSet<object>();

/**
 * Ephemeral capability minted only after a durable approval artifact has been
 * verified. Writers can reject structurally forged objects with the WeakSet
 * brand while durable restart rehydrates a fresh capability from the artifact.
 */
export interface ValidatedAgentWriteApprovalProof {
  readonly schemaVersion: "agent-write-approval-proof-v1";
  readonly authorityRef: string;
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly idempotencyKey: string;
  readonly execution: Readonly<AgentWriteApprovalExecution>;
}

export interface ValidatedAgentWriteApprovalDurableMaterial {
  readonly schemaVersion: "agent-write-approval-durable-material-v1";
  /** Current job checkpoint. Before the first commit this is the confirmed ref. */
  readonly authorityRef: string;
  readonly confirmedAuthorityRef: string;
  readonly pendingRef: string;
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly idempotencyKey: string;
  readonly execution: Readonly<AgentWriteApprovalExecution>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly runtimeGeneration: number;
  readonly jobId: string;
  readonly checkpointRef: string;
}

export interface AgentWriteApprovalBinding {
  readonly schemaVersion: "agent-write-approval-binding-v1";
  readonly confirmedAuthorityRef: string;
  readonly pendingRef: string;
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly toolDefinitionHash: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly inputHash: string;
  readonly callId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly runtimeGeneration: number;
  readonly jobId: string;
  /** Stable human-approval checkpoint; later consumption remains a child ref. */
  readonly checkpointRef: string;
  readonly planContextHash: string;
  readonly contentHash: string;
}

export function createAgentWriteApprovalBinding(
  material: ValidatedAgentWriteApprovalDurableMaterial,
  planContextHash: string,
): AgentWriteApprovalBinding {
  if (!material || typeof material !== "object" || !validatedDurableMaterials.has(material as object)
    || material.schemaVersion !== "agent-write-approval-durable-material-v1" || !HASH.test(planContextHash)) {
    throw new Error("Agent write approval durable material/plan context hash is invalid");
  }
  const unsigned = {
    schemaVersion: "agent-write-approval-binding-v1" as const,
    confirmedAuthorityRef: material.confirmedAuthorityRef,
    pendingRef: material.pendingRef,
    approvalId: material.approvalId,
    approvedBy: material.approvedBy,
    idempotencyKey: material.idempotencyKey,
    toolName: material.execution.toolName,
    toolDefinitionHash: material.execution.toolDefinitionHash,
    sessionId: material.execution.sessionId,
    runId: material.execution.runId,
    inputHash: material.execution.inputHash,
    callId: material.execution.callId,
    issuedAt: material.issuedAt,
    expiresAt: material.expiresAt,
    runtimeGeneration: material.runtimeGeneration,
    jobId: material.jobId,
    checkpointRef: material.confirmedAuthorityRef,
    planContextHash,
  };
  const binding = Object.freeze({ ...unsigned, contentHash: agentAuditHash(unsigned) });
  const errors = validateAgentWriteApprovalBindingRuntime(binding);
  if (errors.length) throw new Error(`Agent write approval binding is invalid: ${errors.join("; ")}`);
  return binding;
}

export function assertValidatedAgentWriteApprovalProof(
  proof: unknown,
  expected: AgentWriteApprovalExecution,
): asserts proof is ValidatedAgentWriteApprovalProof {
  if (!proof || typeof proof !== "object" || !validatedProofs.has(proof as object)) {
    throw new Error("server-issued Agent write approval proof is required");
  }
  const value = proof as ValidatedAgentWriteApprovalProof;
  if (stableAgentJson(value.execution) !== stableAgentJson(expected)) {
    throw new Error("Agent write approval proof does not match the exact execution");
  }
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function executionFor(pending: AgentPendingWriteApproval): AgentWriteApprovalExecution {
  return {
    toolName: pending.call.name,
    toolDefinitionHash: pending.toolDefinitionHash,
    sessionId: pending.sessionId,
    runId: pending.runId,
    inputHash: pending.inputHash,
    callId: pending.call.id,
  };
}

function executionIdentity(input: AgentWriteApprovalExecution): string {
  return agentAuditHash({
    contractVersion: AGENT_CONTRACT_VERSION,
    toolName: input.toolName,
    toolDefinitionHash: input.toolDefinitionHash,
    sessionId: input.sessionId,
    runId: input.runId,
    inputHash: input.inputHash,
    callId: input.callId,
  });
}

function validatePending(value: unknown): AgentPendingWriteApproval {
  if (!ownRecord(value) || !exactKeys(value, [
    "contractVersion", "status", "approvalId", "nonce", "runId", "sessionId", "call", "toolTitle",
    "toolDefinitionHash", "inputHash", "idempotencyKey", "requestedAt", "expiresAt", "backup", "rollback",
  ])) throw new Error("pending Agent write approval shape is invalid");
  const pending = value as unknown as AgentPendingWriteApproval;
  const requested = Date.parse(pending.requestedAt);
  const expires = Date.parse(pending.expiresAt);
  const execution = executionFor(pending);
  const identity = executionIdentity(execution);
  if (pending.contractVersion !== AGENT_CONTRACT_VERSION || pending.status !== "pending"
    || pending.approvalId !== `approval-${identity}` || pending.idempotencyKey !== `agent-write-${identity}`
    || !/^nonce-[a-f0-9]{64}$/.test(pending.nonce)
    || !pending.call || typeof pending.call.id !== "string" || !pending.call.id || pending.call.name !== execution.toolName
    || pending.inputHash !== agentAuditHash(pending.call.input) || !HASH.test(pending.toolDefinitionHash)
    || !pending.toolTitle.trim() || !Number.isFinite(requested) || !Number.isFinite(expires)
    || expires <= requested || expires - requested > MAX_LIFETIME_MS
    || pending.backup?.required !== true || !pending.backup.target.trim()
    || pending.rollback?.required !== true || !pending.rollback.strategy.trim()) {
    throw new Error("pending Agent write approval authority is invalid");
  }
  return structuredClone(pending);
}

function validateArtifact(value: unknown): ApprovalArtifact {
  if (!ownRecord(value) || typeof value.schemaVersion !== "string") throw new Error("Agent write approval artifact is invalid");
  if (value.schemaVersion === "agent-write-approval-pending-v1") {
    if (!exactKeys(value, ["schemaVersion", "pending"])) throw new Error("pending Agent write approval artifact shape is invalid");
    return { schemaVersion: value.schemaVersion, pending: validatePending(value.pending) };
  }
  if (value.schemaVersion === "agent-write-approval-confirmed-v1") {
    if (!exactKeys(value, ["schemaVersion", "pendingRef", "pending", "envelope"]) || !REF.test(String(value.pendingRef ?? ""))) {
      throw new Error("confirmed Agent write approval artifact shape is invalid");
    }
    const pending = validatePending(value.pending);
    const envelope = structuredClone(value.envelope) as AgentWriteApprovalEnvelope;
    const structuralErrors = validateWriteApprovalEnvelope(envelope, new Date(envelope.issuedAt));
    if (structuralErrors.length || envelope.approvalId !== pending.approvalId || envelope.toolName !== pending.call.name
      || envelope.toolDefinitionHash !== pending.toolDefinitionHash || envelope.sessionId !== pending.sessionId
      || envelope.runId !== pending.runId || envelope.inputHash !== pending.inputHash
      || envelope.idempotencyKey !== pending.idempotencyKey || envelope.expiresAt !== pending.expiresAt
      || stableAgentJson(envelope.backup) !== stableAgentJson(pending.backup)
      || stableAgentJson(envelope.rollback) !== stableAgentJson(pending.rollback)) {
      throw new Error("confirmed Agent write approval binding is invalid");
    }
    return { schemaVersion: value.schemaVersion, pendingRef: String(value.pendingRef), pending, envelope };
  }
  if (value.schemaVersion === "agent-write-approval-consumed-v1") {
    if (!exactKeys(value, ["schemaVersion", "confirmedRef", "pending", "envelope", "resultHash", "consumedAt"])
      || !REF.test(String(value.confirmedRef ?? "")) || !HASH.test(String(value.resultHash ?? ""))
      || !Number.isFinite(Date.parse(String(value.consumedAt ?? "")))) {
      throw new Error("consumed Agent write approval artifact shape is invalid");
    }
    const confirmed = validateArtifact({
      schemaVersion: "agent-write-approval-confirmed-v1",
      pendingRef: value.confirmedRef,
      pending: value.pending,
      envelope: value.envelope,
    }) as ConfirmedArtifact;
    return {
      schemaVersion: value.schemaVersion,
      confirmedRef: String(value.confirmedRef),
      pending: confirmed.pending,
      envelope: confirmed.envelope,
      resultHash: String(value.resultHash),
      consumedAt: String(value.consumedAt),
    };
  }
  throw new Error("Agent write approval artifact schema is unsupported");
}

function bytes(value: ApprovalArtifact): Buffer {
  return Buffer.from(stableAgentJson(value), "utf8");
}

function artifactOptions(fence?: AgentApprovalWriteFence) {
  return fence ? {
    expectedRuntimeGeneration: fence.runtimeGeneration,
    expectedJobLease: { jobId: fence.jobId, expectedRevision: fence.expectedRevision, leaseToken: fence.leaseToken },
  } : undefined;
}

function approvalJobId(runId: string): string {
  return `job-${createHash("sha256").update(`agent-run:${runId}`, "utf8").digest("hex")}`;
}

function sameReferences(
  left: ReadonlyArray<{ ref: string; necessity: string }>,
  right: ReadonlyArray<{ ref: string; necessity: string }>,
): boolean {
  return stableAgentJson([...left].sort((a, b) => `${a.ref}\0${a.necessity}`.localeCompare(`${b.ref}\0${b.necessity}`)))
    === stableAgentJson([...right].sort((a, b) => `${a.ref}\0${a.necessity}`.localeCompare(`${b.ref}\0${b.necessity}`)));
}

async function readApprovalArtifact(
  artifacts: ApprovalArtifactStore,
  authorityRef: string,
  seen = new Set<string>(),
): Promise<ReadApprovalArtifact> {
  if (!REF.test(authorityRef)) throw new Error("Agent write approval artifact ref is invalid");
  if (seen.has(authorityRef)) throw new Error("Agent write approval artifact reference cycle is invalid");
  seen.add(authorityRef);
  const stored = await artifacts.get(authorityRef);
  if (!stored?.record) throw new Error("Agent write approval artifact or governed metadata is missing");
  const hash = authorityRef.slice("sha256:".length);
  if (stored.record.schemaVersion !== "artifact-record-v1" || stored.record.ref !== authorityRef
    || stored.record.sha256 !== hash || stored.record.byteLength !== stored.bytes.byteLength
    || createHash("sha256").update(stored.bytes).digest("hex") !== hash) {
    throw new Error("Agent write approval artifact content-addressed metadata is invalid");
  }
  let value: unknown;
  try { value = JSON.parse(stored.bytes.toString("utf8")); }
  catch { throw new Error("Agent write approval artifact JSON is invalid"); }
  const runtimeErrors = validateAgentWriteApprovalArtifactRuntime(value);
  if (runtimeErrors.length) throw new Error(`Agent write approval artifact is invalid: ${runtimeErrors.join("; ")}`);
  const artifact = validateArtifact(value);
  const expectedMetadata = agentWriteApprovalArtifactMetadataRuntime(artifact);
  const expectedReferences = agentWriteApprovalArtifactReferencesRuntime(artifact);
  if (!expectedMetadata || !expectedReferences || stored.record.kind !== expectedMetadata.kind
    || stored.record.mediaType !== expectedMetadata.mediaType || stored.record.privacyClass !== expectedMetadata.privacyClass
    || !sameReferences(stored.record.references, expectedReferences)) {
    throw new Error("Agent write approval artifact governed metadata or references are invalid");
  }
  if (artifact.schemaVersion !== "agent-write-approval-pending-v1") {
    const referencedRef = artifact.schemaVersion === "agent-write-approval-confirmed-v1"
      ? artifact.pendingRef : artifact.confirmedRef;
    const referenced = await readApprovalArtifact(artifacts, referencedRef, seen);
    const closureErrors = validateAgentWriteApprovalArtifactClosureRuntime(artifact, referenced.artifact);
    if (closureErrors.length) throw new Error(`Agent write approval artifact closure is invalid: ${closureErrors.join("; ")}`);
  }
  seen.delete(authorityRef);
  return { artifact, authorityRef };
}

function assertApprovalJobIdentity(job: BackgroundJob, authorityRef: string, pending: AgentPendingWriteApproval): void {
  const errors = validateBackgroundJob(job);
  if (errors.length || job.jobId !== approvalJobId(pending.runId) || job.type !== "agent.run" || job.handlerVersion !== "1"
    || job.idempotencyKey !== `agent-run:${pending.runId}` || !HASH.test(job.inputHash) || !REF.test(job.payloadRef)
    || job.checkpointRef !== authorityRef) {
    throw new Error("Agent write approval is not anchored to its exact durable run checkpoint");
  }
}

/**
 * Writer-side verifier. It deliberately reopens the authority closure and the
 * job checkpoint underneath the same active runtime root as the write itself.
 */
export async function assertValidatedAgentWriteApprovalProofAtRoot(
  activeRoot: string,
  proof: unknown,
  expected: AgentWriteApprovalExecution,
  options: { now?: string; runtimeGeneration?: number } = {},
): Promise<ValidatedAgentWriteApprovalDurableMaterial> {
  assertValidatedAgentWriteApprovalProof(proof, expected);
  const branded = proof as ValidatedAgentWriteApprovalProof;
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") }) as ApprovalArtifactStore;
  const { artifact } = await readApprovalArtifact(artifacts, branded.authorityRef);
  if (artifact.schemaVersion === "agent-write-approval-pending-v1"
    || stableAgentJson(executionFor(artifact.pending)) !== stableAgentJson(expected)) {
    throw new Error("Agent write approval root authority does not bind the exact execution");
  }
  const now = options.now ?? new Date().toISOString();
  const envelopeErrors = validateWriteApprovalEnvelope(artifact.envelope, new Date(now));
  if (envelopeErrors.length) throw new Error(`Agent write approval root authority is expired or invalid: ${envelopeErrors.join("; ")}`);
  const jobFile = confined(activeRoot, "jobs", "records", `${approvalJobId(expected.runId)}.json`);
  const envelope = await readJson(jobFile).catch(() => null) as { schemaVersion?: string; kind?: string; checksum?: string; payload?: BackgroundJob } | null;
  if (!envelope || envelope.schemaVersion !== "job-store-envelope-v1" || envelope.kind !== "background-job"
    || envelope.checksum !== sha256Json(envelope.payload) || !envelope.payload) {
    throw new Error("Agent write approval durable job checkpoint is missing or corrupt");
  }
  assertApprovalJobIdentity(envelope.payload, branded.authorityRef, artifact.pending);
  if (envelope.payload.status !== "running" || !envelope.payload.leaseToken
    || Date.parse(envelope.payload.leaseExpiresAt ?? "") <= Date.parse(now)
    || (options.runtimeGeneration !== undefined && envelope.payload.runtimeGeneration !== options.runtimeGeneration)) {
    throw new Error("Agent write approval durable job lease/generation is stale");
  }
  const confirmedAuthorityRef = artifact.schemaVersion === "agent-write-approval-confirmed-v1"
    ? branded.authorityRef : artifact.confirmedRef;
  const confirmed = artifact.schemaVersion === "agent-write-approval-confirmed-v1"
    ? artifact : (await readApprovalArtifact(artifacts, artifact.confirmedRef)).artifact;
  if (confirmed.schemaVersion !== "agent-write-approval-confirmed-v1") {
    throw new Error("Agent write approval confirmed authority closure is invalid");
  }
  const material = Object.freeze({
    schemaVersion: "agent-write-approval-durable-material-v1" as const,
    authorityRef: branded.authorityRef,
    confirmedAuthorityRef,
    pendingRef: confirmed.pendingRef,
    approvalId: artifact.envelope.approvalId,
    approvedBy: artifact.envelope.approvedBy,
    idempotencyKey: artifact.envelope.idempotencyKey,
    execution: Object.freeze(structuredClone(expected)),
    issuedAt: artifact.envelope.issuedAt,
    expiresAt: artifact.envelope.expiresAt,
    runtimeGeneration: envelope.payload.runtimeGeneration,
    jobId: envelope.payload.jobId,
    checkpointRef: envelope.payload.checkpointRef!,
  });
  validatedDurableMaterials.add(material);
  return material;
}

export class AgentWriteApprovalAuthority {
  private readonly issuedRefs = new Set<string>();

  constructor(
    private readonly artifacts: ApprovalArtifactStore,
    private readonly options: { now?: () => string; token?: () => string; jobs?: ApprovalJobStore } = {},
  ) {}

  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private token(): string { return (this.options.token ?? (() => randomBytes(32).toString("hex")))(); }

  private async assertAuthorityAnchor(
    authorityRef: string,
    pending: AgentPendingWriteApproval,
    statuses: readonly BackgroundJobStatus[],
    fence?: AgentApprovalWriteFence,
  ): Promise<BackgroundJob | null> {
    if (!this.options.jobs) {
      if (!this.issuedRefs.has(authorityRef)) {
        throw new Error("Agent write approval authority was not issued by this server instance");
      }
      return null;
    }
    const job = await this.options.jobs.get(approvalJobId(pending.runId));
    assertApprovalJobIdentity(job, authorityRef, pending);
    if (!statuses.includes(job.status)) throw new Error("Agent write approval durable job is in the wrong lifecycle state");
    if (fence && (job.status !== "running" || job.runtimeGeneration !== fence.runtimeGeneration
      || job.jobId !== fence.jobId || job.revision !== fence.expectedRevision || job.leaseToken !== fence.leaseToken
      || Date.parse(job.leaseExpiresAt ?? "") <= Date.parse(this.now()))) {
      throw new Error("Agent write approval durable job fence is stale");
    }
    return job;
  }

  async request(input: {
    runId: string;
    sessionId: string;
    call: AgentToolCall;
    toolTitle: string;
    toolDefinitionHash: string;
  }, fence?: AgentApprovalWriteFence): Promise<{ pending: AgentPendingWriteApproval; authorityRef: string }> {
    if (this.options.jobs && (!fence || fence.jobId !== approvalJobId(input.runId))) {
      throw new Error("durable Agent write approval request requires the exact running job fence");
    }
    const requestedAt = this.now();
    const execution: AgentWriteApprovalExecution = {
      toolName: input.call.name,
      toolDefinitionHash: input.toolDefinitionHash,
      sessionId: input.sessionId,
      runId: input.runId,
      inputHash: agentAuditHash(input.call.input),
      callId: input.call.id,
    };
    const identity = executionIdentity(execution);
    const pending = validatePending({
      contractVersion: AGENT_CONTRACT_VERSION,
      status: "pending",
      approvalId: `approval-${identity}`,
      nonce: `nonce-${this.token()}`,
      runId: input.runId,
      sessionId: input.sessionId,
      call: structuredClone(input.call),
      toolTitle: input.toolTitle,
      toolDefinitionHash: input.toolDefinitionHash,
      inputHash: execution.inputHash,
      idempotencyKey: `agent-write-${identity}`,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + MAX_LIFETIME_MS).toISOString(),
      backup: { required: true, target: "active-runtime-generation" },
      rollback: { required: true, strategy: "governed content-addressed idempotent replay and repository rollback authority" },
    });
    const artifact: PendingArtifact = { schemaVersion: "agent-write-approval-pending-v1", pending };
    const stored = await this.artifacts.put({
      bytes: bytes(artifact),
      mediaType: "application/vnd.buildsim.agent-write-approval+json",
      privacyClass: "runtime_internal",
      kind: "agent-write-approval-pending",
      references: [],
    }, artifactOptions(fence));
    this.issuedRefs.add(stored.record.ref);
    return { pending, authorityRef: stored.record.ref };
  }

  async read(authorityRef: string): Promise<ApprovalArtifact> {
    return (await readApprovalArtifact(this.artifacts, authorityRef)).artifact;
  }

  async pending(authorityRef: string): Promise<AgentPendingWriteApproval> {
    const artifact = await this.read(authorityRef);
    return structuredClone(artifact.pending);
  }

  async confirm(input: {
    authorityRef: string;
    runId: string;
    approvalId: string;
    nonce: string;
    approvedBy: string;
  }): Promise<{ pending: AgentPendingWriteApproval; envelope: AgentWriteApprovalEnvelope; authorityRef: string; alreadyConfirmed: boolean }> {
    if (!REVIEWER.test(input.approvedBy)) throw new Error("approval reviewer identity is invalid");
    const current = await this.read(input.authorityRef);
    const pending = current.pending;
    if (pending.runId !== input.runId || pending.approvalId !== input.approvalId || pending.nonce !== input.nonce) {
      throw new Error("approval confirmation does not match the exact pending execution");
    }
    if (current.schemaVersion !== "agent-write-approval-pending-v1") {
      await this.assertAuthorityAnchor(input.authorityRef, pending, ["queued", "running", "waiting_user", "succeeded"]);
      if (current.envelope.approvedBy !== input.approvedBy) throw new Error("approval was already confirmed by a different reviewer");
      return { pending, envelope: structuredClone(current.envelope), authorityRef: input.authorityRef, alreadyConfirmed: true };
    }
    const job = await this.assertAuthorityAnchor(input.authorityRef, pending, ["waiting_user"]);
    if (Date.parse(pending.expiresAt) <= Date.parse(this.now())) throw new Error("pending Agent write approval expired");
    // Bind issuance bytes to the pending authority so a crash after artifact
    // creation but before the job CAS can recreate the identical confirmation.
    const issuedAt = pending.requestedAt;
    const envelope: AgentWriteApprovalEnvelope = {
      contractVersion: AGENT_CONTRACT_VERSION,
      approvalId: pending.approvalId,
      toolName: pending.call.name,
      toolDefinitionHash: pending.toolDefinitionHash,
      sessionId: pending.sessionId,
      runId: pending.runId,
      inputHash: pending.inputHash,
      idempotencyKey: pending.idempotencyKey,
      issuedAt,
      expiresAt: pending.expiresAt,
      approvedBy: input.approvedBy,
      approvalToken: `server-${agentAuditHash({ pendingRef: input.authorityRef, nonce: pending.nonce, approvedBy: input.approvedBy })}`,
      backup: structuredClone(pending.backup),
      rollback: structuredClone(pending.rollback),
    };
    const errors = validateWriteApprovalEnvelope(envelope, new Date(issuedAt));
    if (errors.length) throw new Error(`server-issued Agent approval is invalid: ${errors.join("; ")}`);
    const artifact: ConfirmedArtifact = {
      schemaVersion: "agent-write-approval-confirmed-v1",
      pendingRef: input.authorityRef,
      pending,
      envelope,
    };
    const stored = await this.artifacts.put({
      bytes: bytes(artifact),
      mediaType: "application/vnd.buildsim.agent-write-approval+json",
      privacyClass: "runtime_internal",
      kind: "agent-write-approval-confirmed",
      references: [{ ref: input.authorityRef, necessity: "required_for_replay" }],
    }, job ? { expectedRuntimeGeneration: job.runtimeGeneration } : undefined);
    this.issuedRefs.add(stored.record.ref);
    return { pending, envelope: structuredClone(envelope), authorityRef: stored.record.ref, alreadyConfirmed: false };
  }

  async authorize(authorityRef: string, expected: AgentWriteApprovalExecution): Promise<{
    pending: AgentPendingWriteApproval;
    envelope: AgentWriteApprovalEnvelope;
    proof: ValidatedAgentWriteApprovalProof;
  } | null> {
    const artifact = await this.read(authorityRef);
    if (artifact.schemaVersion === "agent-write-approval-pending-v1") {
      await this.assertAuthorityAnchor(authorityRef, artifact.pending, ["waiting_user"]);
      return null;
    }
    await this.assertAuthorityAnchor(authorityRef, artifact.pending, ["running"]);
    if (stableAgentJson(executionFor(artifact.pending)) !== stableAgentJson(expected)) {
      throw new Error("durable Agent write approval does not match the exact execution");
    }
    const errors = validateWriteApprovalEnvelope(artifact.envelope, new Date(this.now()));
    if (errors.length) throw new Error(`durable Agent write approval is invalid: ${errors.join("; ")}`);
    const proof = Object.freeze({
      schemaVersion: "agent-write-approval-proof-v1" as const,
      authorityRef,
      approvalId: artifact.envelope.approvalId,
      approvedBy: artifact.envelope.approvedBy,
      idempotencyKey: artifact.envelope.idempotencyKey,
      execution: Object.freeze(structuredClone(expected)),
    });
    validatedProofs.add(proof);
    return { pending: structuredClone(artifact.pending), envelope: structuredClone(artifact.envelope), proof };
  }

  async consume(
    authorityRef: string,
    proof: ValidatedAgentWriteApprovalProof,
    resultHash: string,
    fence?: AgentApprovalWriteFence,
  ): Promise<{ authorityRef: string; alreadyConsumed: boolean }> {
    assertValidatedAgentWriteApprovalProof(proof, proof.execution);
    if (proof.authorityRef !== authorityRef || !HASH.test(resultHash)) throw new Error("Agent write approval consumption binding is invalid");
    const current = await this.read(authorityRef);
    if (current.schemaVersion === "agent-write-approval-pending-v1") throw new Error("pending Agent write approval cannot be consumed");
    await this.assertAuthorityAnchor(authorityRef, current.pending, ["running"], fence);
    if (current.schemaVersion === "agent-write-approval-consumed-v1") {
      if (current.resultHash !== resultHash) throw new Error("Agent write approval was consumed for a different result");
      return { authorityRef, alreadyConsumed: true };
    }
    const artifact: ConsumedArtifact = {
      schemaVersion: "agent-write-approval-consumed-v1",
      confirmedRef: authorityRef,
      pending: current.pending,
      envelope: current.envelope,
      resultHash,
      // Deterministic bytes make a crash after Artifact.put but before the job
      // checkpoint safe to retry without accumulating distinct authority refs.
      consumedAt: current.envelope.issuedAt,
    };
    const stored = await this.artifacts.put({
      bytes: bytes(artifact),
      mediaType: "application/vnd.buildsim.agent-write-approval+json",
      privacyClass: "runtime_internal",
      kind: "agent-write-approval-consumed",
      references: [{ ref: authorityRef, necessity: "required_for_replay" }],
    }, artifactOptions(fence));
    this.issuedRefs.add(stored.record.ref);
    return { authorityRef: stored.record.ref, alreadyConsumed: false };
  }
}
