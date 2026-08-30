import path from "node:path";
import { canonicalize } from "../hash";
import { agentAuditHash } from "../agent/audit";
import { stableAgentJson } from "../agent/evaluation-contract";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import {
  assertValidatedAgentWriteApprovalProofAtRoot,
  createAgentWriteApprovalBinding,
  type AgentWriteApprovalBinding,
  type AgentWriteApprovalExecution,
} from "../agent/write-approval-authority";
import {
  validateAgentWriteApprovalArtifactClosureRuntime,
  validateAgentWriteApprovalArtifactRuntime,
  validateAgentWriteApprovalBindingClosureRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "../agent/write-approval-runtime.mjs";
import { validatePlanAgentRunContextAuditEnvelopeRuntime } from "../plans/agent-context-audit-runtime.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { confined, listRegularFiles, pathExists, readJson, sha256Json } from "../runtime/fs.mjs";
import {
  compareCanonical,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isSha256,
  safeRecord,
} from "../capabilities/validation";
import { verifyCaseAdapterManifest, type CaseAdapterIdentity, type CaseAdapterManifest } from "./contracts";
import {
  readProvisionalCaseAdapterCandidateAtRoot,
  replayProvisionalCaseAdapterCandidate,
  provisionalCaseAdapterCandidateArtifactRef,
  verifyProvisionalCaseAdapterCandidate,
  type ProvisionalCaseAdapterAuthorityRefs,
  type ProvisionalCaseAdapterCandidate,
  type ProvisionalCaseAdapterPlanContext,
  type RootBoundProvisionalCaseAdapterAuthority,
} from "./provisional";
import {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_CONTRACT,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
} from "./provisional-tool-runtime.mjs";
export {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_CONTRACT,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
} from "./provisional-tool-runtime.mjs";

const REGISTRY_HASH_DOMAIN = "buildsim.runtime-case-adapter-registry-v1";
const ENTRY_HASH_DOMAIN = "buildsim.runtime-case-adapter-registration-v1";
const ENTRY_ID = /^runtime-case-adapter-registration-sha256-([a-f0-9]{64})$/;
const SHA_REF = /^sha256:([a-f0-9]{64})$/;
const REGISTRY_MEDIA_TYPE = "application/vnd.buildsim.runtime-case-adapter-registry+json";


export interface ProvisionalCaseAdapterApprovalInput {
  candidateId: ProvisionalCaseAdapterCandidate["candidateId"];
  planId: string;
  caseComponentInstanceId: string;
  planRevision: number;
  configHash: string;
  manifestHash: string;
  factSnapshotHash: string;
  expectedPriorRegistrationHash: string | null;
  expectedPriorRegistryRef: `sha256:${string}` | null;
}

export interface RuntimeCaseAdapterRegistryEntry {
  schemaVersion: "runtime-case-adapter-registration-v1";
  entryId: `runtime-case-adapter-registration-sha256-${string}`;
  identity: CaseAdapterIdentity;
  manifest: CaseAdapterManifest;
  manifestHash: string;
  candidateId: ProvisionalCaseAdapterCandidate["candidateId"];
  previousEntryHash: string | null;
  planContext: ProvisionalCaseAdapterPlanContext;
  factSnapshotRef: ProvisionalCaseAdapterCandidate["factSnapshotRef"];
  authorityRefs: ProvisionalCaseAdapterAuthorityRefs;
  approval: AgentWriteApprovalBinding;
  registeredAt: string;
  contentHash: string;
}

export interface RuntimeCaseAdapterRegistryState {
  schemaVersion: "runtime-case-adapter-registry-v1";
  runtimeGeneration: number;
  registryGeneration: number;
  previousRegistryRef: `sha256:${string}` | null;
  entries: RuntimeCaseAdapterRegistryEntry[];
  registryRef: `sha256:${string}`;
  contentHash: string;
}

export interface RuntimeCaseAdapterResolution {
  manifest: CaseAdapterManifest;
  registration: RuntimeCaseAdapterRegistryEntry;
  registryGeneration: number;
  registryRef: `sha256:${string}`;
}

export interface RuntimeCaseAdapterRegistrationResult extends RuntimeCaseAdapterResolution {
  alreadyRegistered: boolean;
  runtimeGeneration: number;
  runtimeRevision: number;
}

interface RuntimeStateView {
  runtimeGeneration: number;
  revision: number;
}

interface RuntimeOperationContext {
  state: RuntimeStateView;
  activeRoot: string;
}

function identityKey(identity: Pick<CaseAdapterIdentity, "skuId" | "region" | "revision">): string {
  if (![identity.skuId, identity.region, identity.revision].every(isPortableId)) throw new TypeError("runtime case adapter exact identity invalid");
  return `${identity.skuId}\0${identity.region}\0${identity.revision}`;
}

function assertCandidateRegistryCas(
  candidate: ProvisionalCaseAdapterCandidate,
  registry: RuntimeCaseAdapterRegistryState,
): RuntimeCaseAdapterRegistryEntry | undefined {
  const existing = registry.entries.find((entry) => identityKey(entry.identity) === identityKey(candidate.identity));
  if (existing?.candidateId === candidate.candidateId) return existing;
  const expectedRegistryRef = registry.registryGeneration === 0 ? null : registry.registryRef;
  if (candidate.registryGuard.expectedPriorRegistrationHash !== (existing?.contentHash ?? null)
    || candidate.registryGuard.expectedPriorRegistryRef !== expectedRegistryRef) {
    throw new Error("provisional adapter registry supersession CAS guard is stale");
  }
  return existing;
}

function entryUnsigned(entry: RuntimeCaseAdapterRegistryEntry): Omit<RuntimeCaseAdapterRegistryEntry, "entryId" | "contentHash"> {
  const { entryId: _entryId, contentHash: _contentHash, ...unsigned } = entry;
  return unsigned;
}

function entryHash(unsigned: Omit<RuntimeCaseAdapterRegistryEntry, "entryId" | "contentHash">): string {
  return agentAuditHash({ domain: ENTRY_HASH_DOMAIN, entry: unsigned });
}

function registryUnsigned(state: RuntimeCaseAdapterRegistryState): Omit<RuntimeCaseAdapterRegistryState, "registryRef" | "contentHash"> {
  const { registryRef: _registryRef, contentHash: _contentHash, ...unsigned } = state;
  return unsigned;
}

function registryHash(unsigned: Omit<RuntimeCaseAdapterRegistryState, "registryRef" | "contentHash">): string {
  return agentAuditHash({ domain: REGISTRY_HASH_DOMAIN, registry: unsigned });
}

function createEmptyState(runtimeGeneration: number): RuntimeCaseAdapterRegistryState {
  const unsigned = {
    schemaVersion: "runtime-case-adapter-registry-v1" as const,
    runtimeGeneration,
    registryGeneration: 0,
    previousRegistryRef: null,
    entries: [] as RuntimeCaseAdapterRegistryEntry[],
  };
  const contentHash = registryHash(unsigned);
  return { ...unsigned, registryRef: `sha256:${contentHash}`, contentHash };
}

function approvalBindingLooksValid(value: unknown): value is AgentWriteApprovalBinding {
  const binding = safeRecord(value);
  if (!binding || binding.schemaVersion !== "agent-write-approval-binding-v1" || !isSha256(binding.contentHash)
    || validateAgentWriteApprovalBindingRuntime(binding).length) return false;
  const { contentHash: _contentHash, ...unsigned } = binding;
  return binding.contentHash === agentAuditHash(unsigned);
}

function exactIdentity(value: unknown): value is CaseAdapterIdentity {
  const identity = safeRecord(value);
  return Boolean(identity && hasExactKeys(identity, ["skuId", "region", "revision", "identityFactIds"])
    && isPortableId(identity.skuId) && isPortableId(identity.region) && isPortableId(identity.revision)
    && Array.isArray(identity.identityFactIds) && identity.identityFactIds.length > 0
    && identity.identityFactIds.every(isPortableId) && new Set(identity.identityFactIds).size === identity.identityFactIds.length);
}

function authorityRefsLookValid(value: unknown): value is ProvisionalCaseAdapterAuthorityRefs {
  const refs = safeRecord(value);
  if (!refs || !hasExactKeys(refs, ["generationJobId", "generationJobResultRef", "planContextArtifactRef", "evidenceClaimIds", "evidenceDocumentIds", "evidenceCaptureIds", "evidenceLocatorArtifactRefs"])
    || typeof refs.generationJobId !== "string" || !/^job-[a-f0-9]{64}$/u.test(refs.generationJobId)
    || typeof refs.generationJobResultRef !== "string" || !SHA_REF.test(refs.generationJobResultRef)
    || typeof refs.planContextArtifactRef !== "string" || !SHA_REF.test(refs.planContextArtifactRef)) return false;
  const contracts: Array<[unknown, RegExp]> = [
    [refs.evidenceClaimIds, /^claim-sha256-[a-f0-9]{64}$/u],
    [refs.evidenceDocumentIds, /^doc-sha256-[a-f0-9]{64}$/u],
    [refs.evidenceCaptureIds, /^capture-sha256-[a-f0-9]{64}$/u],
    [refs.evidenceLocatorArtifactRefs, /^sha256:[a-f0-9]{64}$/u],
  ];
  return contracts.every(([values, contract]) => Array.isArray(values) && values.length > 0
    && values.every((item) => typeof item === "string" && contract.test(item))
    && new Set(values).size === values.length && canonicalize(values) === canonicalize([...values].sort(compareCanonical)));
}

function validateEntryShape(value: unknown): string[] {
  const entry = safeRecord(value);
  if (!entry || !hasExactKeys(entry, [
    "schemaVersion", "entryId", "identity", "manifest", "manifestHash", "candidateId", "planContext",
    "factSnapshotRef", "authorityRefs", "approval", "previousEntryHash", "registeredAt", "contentHash",
  ])) return ["runtime case adapter registration shape invalid"];
  const errors: string[] = [];
  if (entry.schemaVersion !== "runtime-case-adapter-registration-v1") errors.push("runtime case adapter registration schemaVersion invalid");
  if (typeof entry.entryId !== "string" || !ENTRY_ID.test(entry.entryId)) errors.push("runtime case adapter registration ID invalid");
  if (!isSha256(entry.contentHash) || (typeof entry.entryId === "string" && ENTRY_ID.exec(entry.entryId)?.[1] !== entry.contentHash)) errors.push("runtime case adapter registration content identity mismatch");
  if (!exactIdentity(entry.identity)) errors.push("runtime case adapter registration exact identity invalid");
  if (!isSha256(entry.manifestHash) || safeRecord(entry.manifest)?.contentHash !== entry.manifestHash) errors.push("runtime case adapter manifest hash mismatch");
  if (typeof entry.candidateId !== "string" || !/^provisional-case-adapter-sha256-[a-f0-9]{64}$/u.test(entry.candidateId)) errors.push("runtime case adapter candidate ref invalid");
  if (entry.previousEntryHash !== null && !isSha256(entry.previousEntryHash)) errors.push("runtime case adapter previous entry CAS hash invalid");
  const plan = safeRecord(entry.planContext);
  if (!plan || !hasExactKeys(plan, ["planId", "caseComponentInstanceId", "planRevision", "configHash"])
    || !isPortableId(plan.planId) || !isPortableId(plan.caseComponentInstanceId)
    || !Number.isSafeInteger(plan.planRevision) || Number(plan.planRevision) < 0 || !isSha256(plan.configHash)) errors.push("runtime case adapter plan guard invalid");
  const snapshot = safeRecord(entry.factSnapshotRef);
  if (!snapshot || !hasExactKeys(snapshot, ["snapshotId", "contentHash"]) || !isPortableId(snapshot.snapshotId) || !isSha256(snapshot.contentHash)) errors.push("runtime case adapter FactSnapshot ref invalid");
  if (!approvalBindingLooksValid(entry.approval)) errors.push("runtime case adapter durable approval binding invalid");
  else if (entry.approval.toolName !== REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME
    || entry.approval.toolDefinitionHash !== REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH) errors.push("runtime case adapter approval execution contract invalid");
  if (!authorityRefsLookValid(entry.authorityRefs)) errors.push("runtime case adapter authority refs invalid");
  const manifestSources = safeRecord(entry.manifest)?.sourceRefs;
  if (authorityRefsLookValid(entry.authorityRefs)) {
    const expectedSources = [...new Set([
      ...entry.authorityRefs.evidenceDocumentIds,
      ...entry.authorityRefs.evidenceCaptureIds,
      ...entry.authorityRefs.evidenceLocatorArtifactRefs,
    ])].sort(compareCanonical);
    if (canonicalize(manifestSources) !== canonicalize(expectedSources)) errors.push("runtime case adapter manifest evidence authority refs mismatch");
  }
  if (typeof entry.registeredAt !== "string" || !Number.isFinite(Date.parse(entry.registeredAt))) errors.push("runtime case adapter registeredAt invalid");
  return errors;
}

export async function verifyRuntimeCaseAdapterRegistryState(value: unknown, expectedRuntimeGeneration?: number): Promise<boolean> {
  try {
    const state = safeRecord(value);
    if (!state || !hasExactKeys(state, ["schemaVersion", "runtimeGeneration", "registryGeneration", "previousRegistryRef", "entries", "registryRef", "contentHash"])
      || state.schemaVersion !== "runtime-case-adapter-registry-v1"
      || !Number.isSafeInteger(state.runtimeGeneration) || Number(state.runtimeGeneration) <= 0
      || (expectedRuntimeGeneration !== undefined && state.runtimeGeneration !== expectedRuntimeGeneration)
      || !Number.isSafeInteger(state.registryGeneration) || Number(state.registryGeneration) < 0
      || (state.previousRegistryRef !== null && (typeof state.previousRegistryRef !== "string" || !SHA_REF.test(state.previousRegistryRef)))
      || !Array.isArray(state.entries) || state.entries.length < 1 || state.entries.length > Number(state.registryGeneration)
      || !isSha256(state.contentHash) || typeof state.registryRef !== "string" || SHA_REF.exec(state.registryRef)?.[1] !== state.contentHash) return false;
    const entries = state.entries as RuntimeCaseAdapterRegistryEntry[];
    if (entries.some((entry) => validateEntryShape(entry).length)) return false;
    for (const entry of entries) {
      if (!await verifyCaseAdapterManifest(entry.manifest)) return false;
      if (canonicalize(entry.identity) !== canonicalize(entry.manifest.identity)) return false;
      if (entry.contentHash !== entryHash(entryUnsigned(entry))) return false;
    }
    if (new Set(entries.map((entry) => identityKey(entry.identity))).size !== entries.length
      || new Set(entries.map((entry) => entry.candidateId)).size !== entries.length) return false;
    return state.contentHash === registryHash(registryUnsigned(state as unknown as RuntimeCaseAdapterRegistryState));
  } catch {
    return false;
  }
}

function registryArtifactBytes(state: RuntimeCaseAdapterRegistryState): Buffer {
  return Buffer.from(stableAgentJson({ domain: REGISTRY_HASH_DOMAIN, registry: registryUnsigned(state) }), "utf8");
}

/** Hydrate any immutable old registry version by its exact artifact ref. */
export async function loadRuntimeCaseAdapterRegistrySnapshotAtRoot(
  activeRoot: string,
  registryRef: string,
): Promise<RuntimeCaseAdapterRegistryState | null> {
  if (!SHA_REF.test(registryRef)) throw new TypeError("runtime case adapter registry artifact ref invalid");
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
  const stored = await artifacts.get(registryRef);
  if (!stored) return null;
  if (stored.record.kind !== "runtime-case-adapter-registry-snapshot" || stored.record.mediaType !== REGISTRY_MEDIA_TYPE
    || stored.record.privacyClass !== "runtime_internal") throw new Error("runtime case adapter registry artifact metadata is invalid");
  let material: unknown;
  try { material = JSON.parse(stored.bytes.toString("utf8")); }
  catch { throw new Error("runtime case adapter registry artifact JSON is invalid"); }
  const record = safeRecord(material);
  if (!record || !hasExactKeys(record, ["domain", "registry"]) || record.domain !== REGISTRY_HASH_DOMAIN || !safeRecord(record.registry)) {
    throw new Error("runtime case adapter registry artifact material is invalid");
  }
  const contentHash = registryRef.slice("sha256:".length);
  const state = { ...(record.registry as unknown as Omit<RuntimeCaseAdapterRegistryState, "registryRef" | "contentHash">), registryRef, contentHash } as RuntimeCaseAdapterRegistryState;
  if (!await verifyRuntimeCaseAdapterRegistryState(state)) throw new Error("runtime case adapter registry artifact content is invalid");
  return deepFreeze(state) as RuntimeCaseAdapterRegistryState;
}

async function listRegistrySnapshotsAtRoot(activeRoot: string): Promise<RuntimeCaseAdapterRegistryState[]> {
  const artifactRoot = confined(activeRoot, "artifacts");
  if (!await pathExists(confined(artifactRoot, "repository-manifest.json"))) return [];
  const artifacts = new FileArtifactRepository({ root: artifactRoot });
  const listing = await artifacts.list();
  const refs = listing.records
    .filter((record: { kind: string }) => record.kind === "runtime-case-adapter-registry-snapshot")
    .map((record: { ref: string }) => record.ref)
    .sort(compareCanonical);
  const snapshots: RuntimeCaseAdapterRegistryState[] = [];
  for (const ref of refs) {
    const state = await loadRuntimeCaseAdapterRegistrySnapshotAtRoot(activeRoot, ref);
    if (!state) throw new Error("runtime case adapter registry artifact disappeared during snapshot read");
    snapshots.push(state);
  }
  return snapshots;
}

async function readRegistryAtRoot(activeRoot: string, runtimeGeneration: number): Promise<RuntimeCaseAdapterRegistryState> {
  const snapshots = await listRegistrySnapshotsAtRoot(activeRoot);
  if (!snapshots.length) return createEmptyState(runtimeGeneration);
  const byRef = new Map(snapshots.map((snapshot) => [snapshot.registryRef, snapshot]));
  const referenced = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.previousRegistryRef === null) {
      if (snapshot.registryGeneration !== 1 || snapshot.entries.length !== 1 || snapshot.entries[0]?.previousEntryHash !== null) {
        throw new Error("runtime case adapter registry chain root generation invalid");
      }
      continue;
    }
    referenced.add(snapshot.previousRegistryRef);
    const previous = byRef.get(snapshot.previousRegistryRef);
    if (!previous || snapshot.registryGeneration !== previous.registryGeneration + 1) {
      throw new Error("runtime case adapter registry immutable version chain is incomplete or forked");
    }
    const priorByIdentity = new Map(previous.entries.map((entry) => [identityKey(entry.identity), entry]));
    const nextByIdentity = new Map(snapshot.entries.map((entry) => [identityKey(entry.identity), entry]));
    const changed = [...nextByIdentity].filter(([key, entry]) => {
      const prior = priorByIdentity.get(key);
      return !prior || canonicalize(prior) !== canonicalize(entry);
    });
    if (changed.length !== 1 || [...priorByIdentity.keys()].some((key) => !nextByIdentity.has(key))) {
      throw new Error("runtime case adapter registry transition must add or supersede exactly one identity");
    }
    const [changedKey, changedEntry] = changed[0]!;
    const prior = priorByIdentity.get(changedKey);
    if ((prior && changedEntry.previousEntryHash !== prior.contentHash)
      || (!prior && changedEntry.previousEntryHash !== null)
      || [...priorByIdentity].some(([key, entry]) => key !== changedKey
        && canonicalize(nextByIdentity.get(key)) !== canonicalize(entry))) {
      throw new Error("runtime case adapter registry supersession CAS/history closure is invalid");
    }
  }
  const tips = snapshots.filter((snapshot) => !referenced.has(snapshot.registryRef));
  if (tips.length !== 1) throw new Error("runtime case adapter registry has ambiguous immutable heads");
  const visited = new Set<string>();
  for (let cursor: RuntimeCaseAdapterRegistryState | undefined = tips[0]; cursor; cursor = cursor.previousRegistryRef ? byRef.get(cursor.previousRegistryRef) : undefined) {
    if (visited.has(cursor.registryRef)) throw new Error("runtime case adapter registry version chain contains a cycle");
    visited.add(cursor.registryRef);
  }
  if (visited.size !== snapshots.length) throw new Error("runtime case adapter registry contains an orphan immutable history");
  return tips[0]!;
}

function activeRuntimeGenerationFromRoot(activeRoot: string): number {
  const resolved = path.resolve(activeRoot);
  if (path.basename(path.dirname(resolved)) !== "generations" || !/^[1-9][0-9]*$/.test(path.basename(resolved))) {
    throw new TypeError("runtime case adapter loader requires an exact active generation root");
  }
  const generation = Number.parseInt(path.basename(resolved), 10);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("active runtime generation is invalid");
  return generation;
}

async function writeRegistryAtRoot(activeRoot: string, state: RuntimeCaseAdapterRegistryState): Promise<void> {
  if (!await verifyRuntimeCaseAdapterRegistryState(state, state.runtimeGeneration) || state.registryGeneration < 1) {
    throw new TypeError("refusing to persist invalid runtime case adapter registry authority");
  }
  const latest = state.entries[state.entries.length - 1]!;
  const references = [...new Set([
    ...(state.previousRegistryRef ? [state.previousRegistryRef] : []),
    ...state.entries.map((entry) => provisionalCaseAdapterCandidateArtifactRef(entry.candidateId)),
    ...state.entries.flatMap((entry) => [entry.approval.confirmedAuthorityRef, entry.approval.pendingRef, entry.approval.checkpointRef]),
  ])].sort(compareCanonical).map((ref) => ({ ref, necessity: "required_for_replay" as const }));
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts"), now: () => latest.registeredAt });
  const stored = await artifacts.put({
    bytes: registryArtifactBytes(state),
    mediaType: REGISTRY_MEDIA_TYPE,
    privacyClass: "runtime_internal",
    kind: "runtime-case-adapter-registry-snapshot",
    references,
    createdAt: latest.registeredAt,
  });
  if (stored.record.ref !== state.registryRef) throw new Error("runtime case adapter registry artifact/content identity mismatch");
}

export async function loadCurrentRuntimeCaseAdapterManifestsAtRoot(
  activeRoot: string,
  activeRuntimeGeneration: number,
): Promise<{
  registryRef: `sha256:${string}` | null;
  /** Exact immutable artifact bytes, suitable for direct lockfile hashing. */
  registryBytes: string | null;
  /** Generation containing this active root; participates in workspace lock/cache identity. */
  activeRuntimeGeneration: number;
  /** Generation recorded by immutable registry bytes, or null for an empty registry. */
  registrySourceRuntimeGeneration: number | null;
  registryGeneration: number;
  manifests: CaseAdapterManifest[];
}> {
  if (!Number.isSafeInteger(activeRuntimeGeneration) || activeRuntimeGeneration < 1
    || activeRuntimeGenerationFromRoot(activeRoot) !== activeRuntimeGeneration) {
    throw new TypeError("runtime case adapter loader active generation/root guard is stale");
  }
  const state = await readRegistryAtRoot(activeRoot, activeRuntimeGeneration);
  for (const entry of state.entries) await assertRegistrationEntryAuthorityAtRoot(activeRoot, entry);
  let registryBytes: string | null = null;
  if (state.registryGeneration > 0) {
    const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
    const stored = await artifacts.get(state.registryRef);
    if (!stored || stored.record.kind !== "runtime-case-adapter-registry-snapshot"
      || stored.record.mediaType !== REGISTRY_MEDIA_TYPE || stored.record.privacyClass !== "runtime_internal"
      || stored.record.ref !== state.registryRef) {
      throw new Error("current runtime case adapter registry artifact is missing or mismatched");
    }
    registryBytes = stored.bytes.toString("utf8");
    if (!stored.bytes.equals(registryArtifactBytes(state))) {
      throw new Error("current runtime case adapter registry bytes do not close the validated snapshot");
    }
  }
  return deepFreeze({
    registryRef: state.registryGeneration === 0 ? null : state.registryRef,
    registryBytes,
    activeRuntimeGeneration,
    registrySourceRuntimeGeneration: state.registryGeneration === 0 ? null : state.runtimeGeneration,
    registryGeneration: state.registryGeneration,
    manifests: state.entries.map((entry) => structuredClone(entry.manifest)),
  });
}

export function provisionalCaseAdapterApprovalInput(candidate: ProvisionalCaseAdapterCandidate): ProvisionalCaseAdapterApprovalInput {
  if (candidate.status !== "ready_for_review" || !candidate.manifest) throw new TypeError("partial provisional adapter candidate cannot be approved");
  return {
    candidateId: candidate.candidateId,
    planId: candidate.planContext.planId,
    caseComponentInstanceId: candidate.planContext.caseComponentInstanceId,
    planRevision: candidate.planContext.planRevision,
    configHash: candidate.planContext.configHash,
    manifestHash: candidate.manifest.contentHash,
    factSnapshotHash: candidate.factSnapshotRef.contentHash,
    expectedPriorRegistrationHash: candidate.registryGuard.expectedPriorRegistrationHash,
    expectedPriorRegistryRef: candidate.registryGuard.expectedPriorRegistryRef,
  };
}

function proofExecution(proof: unknown, candidate: ProvisionalCaseAdapterCandidate): AgentWriteApprovalExecution {
  const proofRecord = safeRecord(proof);
  const supplied = safeRecord(proofRecord?.execution);
  if (!supplied || ![supplied.sessionId, supplied.runId, supplied.callId].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("server-issued Agent write approval proof is required for provisional adapter registration");
  }
  const input = provisionalCaseAdapterApprovalInput(candidate);
  const expected: AgentWriteApprovalExecution = {
    toolName: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
    toolDefinitionHash: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
    sessionId: supplied.sessionId as string,
    runId: supplied.runId as string,
    inputHash: agentAuditHash(input),
    callId: supplied.callId as string,
  };
  if (supplied.toolName !== expected.toolName || supplied.toolDefinitionHash !== expected.toolDefinitionHash
    || supplied.inputHash !== expected.inputHash) throw new Error("Agent approval does not bind the exact provisional adapter registration input");
  return expected;
}

async function approvedAgentPlanContextAtRoot(
  activeRoot: string,
  candidate: ProvisionalCaseAdapterCandidate,
  approval: Pick<AgentWriteApprovalBinding, "runId" | "sessionId" | "issuedAt">,
): Promise<{ contextHash: string }> {
  const envelope = await readJson(confined(activeRoot, "audit", "plan-agent-context", `${approval.runId}.json`)).catch(() => null);
  if (validatePlanAgentRunContextAuditEnvelopeRuntime(envelope, approval.runId).length) {
    throw new Error("runtime case adapter approval Plan Agent context audit is missing or invalid");
  }
  const audit = (envelope as { payload: {
    runId: string; sessionId: string; planId: string; draftRevision: number; configHash: string;
    contextHash: string; recordedAt: string;
  } }).payload;
  if (audit.sessionId !== approval.sessionId || audit.planId !== candidate.planContext.planId
    || audit.draftRevision !== candidate.planContext.planRevision || audit.configHash !== candidate.planContext.configHash
    || Date.parse(audit.recordedAt) > Date.parse(approval.issuedAt)) {
    throw new Error("runtime case adapter approval Plan Agent context is stale, cross-plan, or mismatched");
  }
  return { contextHash: audit.contextHash };
}

async function parseApprovalArtifactAtRoot(activeRoot: string, ref: string, expectedKind: string): Promise<unknown> {
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
  const stored = await artifacts.get(ref);
  if (!stored || stored.record.kind !== expectedKind || stored.record.privacyClass !== "runtime_internal") {
    throw new Error("runtime case adapter approval artifact authority is missing or mismatched");
  }
  let value: unknown;
  try { value = JSON.parse(stored.bytes.toString("utf8")); }
  catch { throw new Error("runtime case adapter approval artifact JSON is invalid"); }
  if (validateAgentWriteApprovalArtifactRuntime(value).length) throw new Error("runtime case adapter approval artifact is invalid");
  return value;
}

async function assertStoredApprovalBindingAtRoot(activeRoot: string, binding: AgentWriteApprovalBinding): Promise<void> {
  if (!approvalBindingLooksValid(binding)) throw new Error("runtime case adapter approval binding is invalid");
  const confirmed = await parseApprovalArtifactAtRoot(activeRoot, binding.confirmedAuthorityRef, "agent-write-approval-confirmed");
  const pending = await parseApprovalArtifactAtRoot(activeRoot, binding.pendingRef, "agent-write-approval-pending");
  if (validateAgentWriteApprovalArtifactClosureRuntime(confirmed, pending).length
    || validateAgentWriteApprovalBindingClosureRuntime(binding, confirmed, pending).length) {
    throw new Error("runtime case adapter approval confirmed/pending/binding closure is invalid");
  }
  const jobsRoot = confined(activeRoot, "jobs");
  const values: unknown[] = [];
  const current = await readJson(confined(jobsRoot, "records", `${binding.jobId}.json`)).catch(() => null);
  if (current) values.push(current);
  for (const file of await listRegularFiles(confined(jobsRoot, "rollback", binding.jobId)).catch(() => [])) {
    if (!/^\d{12}\.json$/u.test(file.logicalPath)) continue;
    const rollback = await readJson(file.absolutePath).catch(() => null) as { payload?: { previous?: unknown } } | null;
    if (rollback?.payload?.previous) values.push({
      schemaVersion: "job-store-envelope-v1",
      kind: "background-job",
      checksum: sha256Json(rollback.payload.previous),
      payload: rollback.payload.previous,
    });
  }
  const closesApproval = values.some((value) => {
    const envelope = safeRecord(value);
    const job = safeRecord(envelope?.payload);
    return envelope?.schemaVersion === "job-store-envelope-v1" && envelope.kind === "background-job"
      && envelope.checksum === sha256Json(job) && job?.jobId === binding.jobId && job.type === "agent.run"
      && job.idempotencyKey === `agent-run:${binding.runId}`
      && (job.runtimeGeneration === binding.runtimeGeneration && job.status === "running"
        && typeof job.leaseToken === "string" && job.leaseToken.length > 0
        && typeof job.leaseExpiresAt === "string" && Number.isFinite(Date.parse(job.leaseExpiresAt))
        || job.status === "paused_restore_review" && typeof job.runtimeGeneration === "number"
          && job.runtimeGeneration > binding.runtimeGeneration)
      && job.checkpointRef === binding.confirmedAuthorityRef;
  });
  if (!closesApproval || binding.checkpointRef !== binding.confirmedAuthorityRef) {
    throw new Error("runtime case adapter approval durable job closure is missing or corrupt");
  }
}

async function assertRegistrationEntryAuthorityAtRoot(
  activeRoot: string,
  entry: RuntimeCaseAdapterRegistryEntry,
): Promise<ProvisionalCaseAdapterCandidate> {
  const candidate = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, entry.candidateId);
  if (!candidate || candidate.status !== "ready_for_review" || !candidate.manifest
    || canonicalize(entry.identity) !== canonicalize(candidate.identity)
    || canonicalize(entry.manifest) !== canonicalize(candidate.manifest)
    || entry.manifestHash !== candidate.manifest.contentHash
    || canonicalize(entry.planContext) !== canonicalize(candidate.planContext)
    || canonicalize(entry.factSnapshotRef) !== canonicalize(candidate.factSnapshotRef)
    || canonicalize(entry.authorityRefs) !== canonicalize(candidate.authorityRefs)
    || entry.previousEntryHash !== candidate.registryGuard.expectedPriorRegistrationHash
    || entry.approval.inputHash !== agentAuditHash(provisionalCaseAdapterApprovalInput(candidate))) {
    throw new Error("runtime case adapter registration does not close its exact candidate/plan/evidence authority");
  }
  await assertStoredApprovalBindingAtRoot(activeRoot, entry.approval);
  const agentContext = await approvedAgentPlanContextAtRoot(activeRoot, candidate, entry.approval);
  if (entry.approval.planContextHash !== agentContext.contextHash) {
    throw new Error("runtime case adapter registration approval does not bind its reviewed Plan Agent context");
  }
  return candidate;
}

async function assertCurrentPlanAndEvidenceGuard(
  activeRoot: string,
  state: RuntimeStateView,
  candidate: ProvisionalCaseAdapterCandidate,
  authority: RootBoundProvisionalCaseAdapterAuthority,
): Promise<void> {
  const context = await authority.resolveProvisionalCaseAdapterContextAtRoot(activeRoot, {
    planId: candidate.planContext.planId,
    caseComponentInstanceId: candidate.planContext.caseComponentInstanceId,
    runtimeGeneration: state.runtimeGeneration,
    runtimeRevision: state.revision,
  });
  const replayed = await replayProvisionalCaseAdapterCandidate(context, {
    planId: candidate.planContext.planId,
    caseComponentInstanceId: candidate.planContext.caseComponentInstanceId,
    expectedRuntimeGeneration: state.runtimeGeneration,
    expectedRuntimeRevision: state.revision,
  }, state.runtimeGeneration);
  if (canonicalize(replayed) !== canonicalize(candidate)) {
    throw new Error("provisional adapter plan revision/config/identity/evidence replay guard is stale or crossed");
  }
}

function registrationFor(
  candidate: ProvisionalCaseAdapterCandidate,
  approval: AgentWriteApprovalBinding,
  registeredAt: string,
): RuntimeCaseAdapterRegistryEntry {
  if (!candidate.manifest) throw new TypeError("partial provisional adapter candidate cannot be registered");
  const unsigned: Omit<RuntimeCaseAdapterRegistryEntry, "entryId" | "contentHash"> = {
    schemaVersion: "runtime-case-adapter-registration-v1",
    identity: structuredClone(candidate.identity),
    manifest: structuredClone(candidate.manifest),
    manifestHash: candidate.manifest.contentHash,
    candidateId: candidate.candidateId,
    previousEntryHash: candidate.registryGuard.expectedPriorRegistrationHash,
    planContext: structuredClone(candidate.planContext),
    factSnapshotRef: structuredClone(candidate.factSnapshotRef),
    authorityRefs: structuredClone(candidate.authorityRefs),
    approval: structuredClone(approval),
    registeredAt,
  };
  const contentHash = entryHash(unsigned);
  return { ...unsigned, entryId: `runtime-case-adapter-registration-sha256-${contentHash}`, contentHash };
}

function stateWithEntry(
  current: RuntimeCaseAdapterRegistryState,
  entry: RuntimeCaseAdapterRegistryEntry,
  runtimeGeneration: number,
): RuntimeCaseAdapterRegistryState {
  const key = identityKey(entry.identity);
  const entries = [...current.entries.filter((candidate) => identityKey(candidate.identity) !== key), entry]
    .sort((left, right) => compareCanonical(identityKey(left.identity), identityKey(right.identity)));
  const unsigned = {
    schemaVersion: "runtime-case-adapter-registry-v1" as const,
    runtimeGeneration,
    registryGeneration: current.registryGeneration + 1,
    previousRegistryRef: current.registryGeneration === 0 ? null : current.registryRef,
    entries,
  };
  const contentHash = registryHash(unsigned);
  return { ...unsigned, registryRef: `sha256:${contentHash}`, contentHash };
}

export class RuntimeCaseAdapterRegistryRepository {
  constructor(
    private readonly coordinator: RuntimeCoordinator,
    private readonly authority: RootBoundProvisionalCaseAdapterAuthority,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!authority || authority.authorityKind !== "case-adapter-generation-root-bound-v1"
      || typeof authority.resolveProvisionalCaseAdapterContextAtRoot !== "function") {
      throw new TypeError("root-bound provisional adapter authority is required by the runtime registry writer");
    }
  }

  /** Resolve only an exact governed SKU + region + revision tuple. */
  async resolve(identity: unknown): Promise<RuntimeCaseAdapterResolution | null> {
    const lookup = safeRecord(identity);
    if (!lookup || !hasExactKeys(lookup, ["skuId", "region", "revision"])
      || !isPortableId(lookup.skuId) || !isPortableId(lookup.region) || !isPortableId(lookup.revision)) {
      throw new TypeError("runtime case adapter lookup requires exact skuId, region and revision");
    }
    const key = identityKey(lookup as unknown as Pick<CaseAdapterIdentity, "skuId" | "region" | "revision">);
    const snapshot = await this.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const registry = await readRegistryAtRoot(activeRoot, state.runtimeGeneration);
      const registration = registry.entries.find((entry) => identityKey(entry.identity) === key);
      if (registration) await assertRegistrationEntryAuthorityAtRoot(activeRoot, registration);
      return registration ? {
        manifest: structuredClone(registration.manifest),
        registration: structuredClone(registration),
        registryGeneration: registry.registryGeneration,
        registryRef: registry.registryRef,
      } : null;
    });
    return snapshot.result ? deepFreeze(snapshot.result) as RuntimeCaseAdapterResolution : null;
  }

  /**
   * Narrow production approval hook. The route supplies only a candidate ID
   * and the server-branded proof; manifest, identity, plan guards and evidence
   * are reopened from the active root under the coordinator barrier.
   */
  async approve(candidateId: string, proof: unknown): Promise<RuntimeCaseAdapterRegistrationResult> {
    if (!/^provisional-case-adapter-sha256-[a-f0-9]{64}$/u.test(candidateId)) throw new TypeError("provisional adapter candidate ID invalid");

    const preflight = await this.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const candidate = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, candidateId);
      if (!candidate || !await verifyProvisionalCaseAdapterCandidate(candidate)) throw new Error("provisional adapter candidate is missing or invalid at the active root");
      if (candidate.runtimeGeneration !== state.runtimeGeneration) throw new Error("provisional adapter candidate belongs to a stale runtime generation");
      if (candidate.status !== "ready_for_review" || !candidate.manifest) throw new Error("partial provisional adapter candidate cannot be approved");
      const registry = await readRegistryAtRoot(activeRoot, state.runtimeGeneration);
      const existing = assertCandidateRegistryCas(candidate, registry);
      if (!existing || existing.candidateId !== candidate.candidateId) return { idempotent: null };
      await assertRegistrationEntryAuthorityAtRoot(activeRoot, existing);
      const expected = proofExecution(proof, candidate);
      const material = await assertValidatedAgentWriteApprovalProofAtRoot(activeRoot, proof, expected, { runtimeGeneration: state.runtimeGeneration, now: this.now() });
      const agentContext = await approvedAgentPlanContextAtRoot(activeRoot, candidate, {
        runId: material.execution.runId, sessionId: material.execution.sessionId, issuedAt: material.issuedAt,
      });
      if (material.confirmedAuthorityRef !== existing.approval.confirmedAuthorityRef
        || existing.approval.planContextHash !== agentContext.contextHash) {
        throw new Error("idempotent provisional adapter registration approval authority mismatch");
      }
      return { idempotent: deepFreeze({
        manifest: structuredClone(existing.manifest),
        registration: structuredClone(existing),
        registryGeneration: registry.registryGeneration,
        registryRef: registry.registryRef,
        alreadyRegistered: true,
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
      }) as RuntimeCaseAdapterRegistrationResult };
    });
    if (preflight.result.idempotent) return preflight.result.idempotent;

    const committed = await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const candidate = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, candidateId);
      if (!candidate || candidate.runtimeGeneration !== state.runtimeGeneration || candidate.status !== "ready_for_review" || !candidate.manifest) {
        throw new Error("provisional adapter candidate is missing, partial or stale inside the registry writer");
      }
      await assertCurrentPlanAndEvidenceGuard(activeRoot, state, candidate, this.authority);
      const current = await readRegistryAtRoot(activeRoot, state.runtimeGeneration);
      const existing = assertCandidateRegistryCas(candidate, current);
      const expected = proofExecution(proof, candidate);
      const material = await assertValidatedAgentWriteApprovalProofAtRoot(activeRoot, proof, expected, { runtimeGeneration: state.runtimeGeneration, now: this.now() });
      const agentContext = await approvedAgentPlanContextAtRoot(activeRoot, candidate, {
        runId: material.execution.runId, sessionId: material.execution.sessionId, issuedAt: material.issuedAt,
      });
      const approval = createAgentWriteApprovalBinding(material, agentContext.contextHash);
      if (existing?.candidateId === candidate.candidateId) {
        return { registry: current, entry: existing, alreadyRegistered: true };
      }
      const entry = registrationFor(candidate, approval, this.now());
      const registry = stateWithEntry(current, entry, state.runtimeGeneration);
      await writeRegistryAtRoot(activeRoot, registry);
      return { registry, entry, alreadyRegistered: false };
    });
    return deepFreeze({
      manifest: structuredClone(committed.result.entry.manifest),
      registration: structuredClone(committed.result.entry),
      registryGeneration: committed.result.registry.registryGeneration,
      registryRef: committed.result.registry.registryRef,
      alreadyRegistered: committed.result.alreadyRegistered,
      runtimeGeneration: committed.state.runtimeGeneration,
      runtimeRevision: committed.state.revision,
    }) as RuntimeCaseAdapterRegistrationResult;
  }
}
