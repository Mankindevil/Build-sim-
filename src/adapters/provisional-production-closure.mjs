import { createHash } from "node:crypto";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import {
  agentWriteApprovalArtifactMetadataRuntime,
  agentWriteApprovalArtifactReferencesRuntime,
  validateAgentWriteApprovalArtifactClosureRuntime,
  validateAgentWriteApprovalArtifactRuntime,
  validateAgentWriteApprovalBindingClosureRuntime,
} from "../agent/write-approval-runtime.mjs";
import { validatePlanAgentRunContextAuditEnvelopeRuntime } from "../plans/agent-context-audit-runtime.mjs";
import { hashPlanConfigRuntime } from "../plans/canonical-runtime.mjs";
import {
  factsRuntimeSubjectMatchesClaim,
  validateFactRecordRuntime,
  validateFactSnapshotRuntime,
  verifyFactRecordRuntime,
  verifyFactSnapshotRuntime,
} from "../facts/canonical-runtime.mjs";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
  validateEvidenceClaimRuntime,
  verifyEvidenceClaimRuntime,
} from "../evidence/claim-runtime.mjs";
import { canonicalJson, confined, sha256Bytes, sha256Json } from "../runtime/fs.mjs";
import {
  hydrateProvisionalCaseAdapterCandidateArtifactRuntime,
  hydrateRuntimeCaseAdapterRegistryArtifactRuntime,
  provisionalCaseAdapterCandidateReferencesRuntime,
  runtimeCaseAdapterRegistryReferencesRuntime,
  validateCaseAdapterEvidenceLocatorArtifactRuntime,
  validateProvisionalCaseAdapterPlanAuthorityRuntime,
} from "./provisional-runtime.mjs";
import {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH as APPROVAL_TOOL_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME as APPROVAL_TOOL,
} from "./provisional-tool-runtime.mjs";

const SHA_REF = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^job-[a-f0-9]{64}$/;
const PIPELINE_ID = /^evidence-pipeline-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-[a-f0-9]{64}$/;

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function same(left, right) { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function unique(values) { return [...new Set(values)].sort(compare); }
function reference(ref, necessity = "required_for_replay") { return { ref, necessity }; }
function graphEdge(fromRef, toRef, necessity = "required_for_replay") { return { fromRef, toRef, necessity }; }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function identityKey(value) { return `${value.skuId}\0${value.region}\0${value.revision}`; }
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function exactMetadata(record, expected, references) {
  invariant(record.kind === expected.kind && record.mediaType === expected.mediaType
    && record.privacyClass === expected.privacyClass,
  `${expected.kind} governed artifact metadata is invalid`);
  const normalized = unique(references.map((item) => `${item.ref}\0${item.necessity}`))
    .map((key) => { const [ref, necessity] = key.split("\0"); return { ref, necessity }; });
  invariant(same(record.references, normalized), `${expected.kind} governed artifact references are incomplete or forged`);
}

function artifactRequestHash(candidate) {
  const material = {
    schemaVersion: "artifact-payload-v1",
    artifactId: "evidence-pipeline-request",
    mediaType: "application/vnd.buildsim.evidence-job+json",
    payload: candidate,
  };
  return sha256Bytes(Buffer.from(`buildsim\0hash-spec-v1\0artifact\0artifact-payload-v1\0${canonicalJson(material)}`.normalize("NFC"), "utf8"));
}

function validatePipelineRequest(value, candidate) {
  const allowed = ["schemaVersion", "pipelineId", "requestHash", "planId", "subject", "requestedFieldIds", "entry", "allowThirdPartyFallback", "requestedAt"];
  invariant(object(value) && Object.keys(value).every((key) => allowed.includes(key))
    && value.schemaVersion === "evidence-pipeline-v1" && PIPELINE_ID.test(String(value.pipelineId ?? ""))
    && /^[a-f0-9]{64}$/.test(String(value.requestHash ?? "")) && value.pipelineId === `evidence-pipeline-sha256-${value.requestHash}`
    && value.planId === candidate.planContext.planId && same(value.subject, candidate.catalogIdentity)
    && Array.isArray(value.requestedFieldIds) && value.requestedFieldIds.length > 0
    && value.requestedFieldIds.every((field) => typeof field === "string" && field.length > 0)
    && new Set(value.requestedFieldIds).size === value.requestedFieldIds.length
    && same(value.requestedFieldIds, [...value.requestedFieldIds].sort(compare))
    && typeof value.allowThirdPartyFallback === "boolean" && iso(value.requestedAt)
    && object(value.entry) && ["official_url", "search_query"].includes(value.entry.kind),
  "provisional adapter evidence pipeline request is invalid, cross-plan, or cross-product");
  const { pipelineId: _pipelineId, requestHash: _requestHash, ...unsigned } = value;
  invariant(artifactRequestHash(unsigned) === value.requestHash,
    "provisional adapter evidence pipeline request content hash is invalid");
}

function validateAttempt(value, candidate, item, artifacts, jobs) {
  invariant(exact(value, ["schemaVersion", "pipelineId", "stage", "jobId", "attemptStartedAt", "inputRefs"])
    && value.schemaVersion === "evidence-stage-attempt-v1" && PIPELINE_ID.test(String(value.pipelineId ?? ""))
    && value.stage === "adapter_generation" && value.jobId === candidate.authorityRefs.generationJobId
    && JOB_ID.test(value.jobId) && value.attemptStartedAt === candidate.createdAt && iso(value.attemptStartedAt)
    && Array.isArray(value.inputRefs) && value.inputRefs.length > 0 && value.inputRefs.every((ref) => SHA_REF.test(String(ref)))
    && new Set(value.inputRefs).size === value.inputRefs.length,
  "provisional adapter generation attempt authority is invalid or mismatched");
  exactMetadata(item.record, {
    kind: "evidence-stage-attempt", mediaType: "application/vnd.buildsim.evidence-job+json", privacyClass: "runtime_internal",
  }, value.inputRefs.map((ref) => reference(ref)));
  const requestArtifact = artifacts.get(value.inputRefs[0]);
  invariant(requestArtifact, "provisional adapter generation request artifact is missing");
  exactMetadata(requestArtifact.record, {
    kind: "evidence-pipeline-request", mediaType: "application/vnd.buildsim.evidence-job+json", privacyClass: "runtime_internal",
  }, []);
  const request = parseJson(requestArtifact.bytes, "provisional adapter evidence pipeline request");
  validatePipelineRequest(request, candidate);
  invariant(request.pipelineId === value.pipelineId, "provisional adapter generation attempt crosses its evidence pipeline request");
  const expectedJobId = `job-${createHash("sha256").update(`${value.pipelineId}:adapter_generation:1`, "utf8").digest("hex")}`;
  invariant(value.jobId === expectedJobId, "provisional adapter generation attempt job identity is invalid");
  const versions = jobs.get(value.jobId) ?? [];
  invariant(versions.some((job) => object(job) && job.type === "evidence.adapter.generate" && job.handlerVersion === "1"
    && job.idempotencyKey === `${value.pipelineId}:adapter_generation:1` && job.payloadRef === value.inputRefs[0]
    && (job.runtimeGeneration === candidate.runtimeGeneration
      || job.status === "paused_restore_review" && job.runtimeGeneration > candidate.runtimeGeneration)
    && job.checkpointRef === item.record.ref),
  "provisional adapter generation attempt lacks its exact durable job checkpoint");
}

function planEnvelope(record) {
  if (record.value !== undefined) return record.value;
  if (!record.rootLogicalPath.endsWith(".bak")) return null;
  try { return JSON.parse(record.bytes.toString("utf8")); } catch { return null; }
}

function projectedComponent(component) {
  if (!object(component)) return null;
  return {
    instanceId: component.instanceId,
    kind: component.kind,
    role: component.role,
    state: component.state,
    identity: component.identity,
    source: component.source,
  };
}

function planAuthorityInHistory(authority, planRecords) {
  for (const record of planRecords) {
    const envelope = planEnvelope(record);
    if (!envelope || envelope.schemaVersion !== "1.0.0" || envelope.kind !== "plan"
      || envelope.checksum !== sha256Json(envelope.payload)) continue;
    const plan = envelope.payload;
    if (plan?.id !== authority.planContext.planId || plan.draftRevision !== authority.planContext.planRevision
      || !object(plan.draft) || hashPlanConfigRuntime(plan.draft.config) !== authority.planContext.configHash
      || plan.draft.config?.schemaVersion !== "3.0.0" || !Array.isArray(plan.draft.config.components)) continue;
    const component = plan.draft.config.components.find((item) => item?.instanceId === authority.planContext.caseComponentInstanceId);
    if (same(projectedComponent(component), authority.planComponent)) return true;
  }
  return false;
}

function exactCandidateSubject(candidate) {
  const value = candidate.catalogIdentity;
  return {
    skuId: value.skuId,
    familyId: value.familyId,
    modelId: value.modelId,
    variantId: value.variantId,
    revision: value.revision,
    region: value.region,
  };
}

function activeAt(value, timestamp) {
  const at = Date.parse(timestamp); const retrieved = Date.parse(value?.retrievedAt);
  const from = value?.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value.validFrom);
  const until = value?.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(value.validUntil);
  return Number.isFinite(at) && Number.isFinite(retrieved) && retrieved <= at
    && !Number.isNaN(from) && !Number.isNaN(until) && from <= at && at <= until;
}

function factSemanticallyPresent(facts, field) {
  const matches = facts.filter((fact) => fact.field === field);
  if (matches.length !== 1) return false;
  const fact = matches[0];
  if (["physical.width", "physical.height", "physical.depth"].includes(field)) {
    return fact.unit === "mm" && typeof fact.value === "number" && Number.isFinite(fact.value) && fact.value > 20;
  }
  if (field === "mount.point_ids") return Array.isArray(fact.value) && fact.value.length > 0
    && fact.value.every((item) => typeof item === "string" && item.length > 0) && new Set(fact.value).size === fact.value.length;
  if (field === "case.motherboard_form_factors") return Array.isArray(fact.value) && fact.value.some((item) => ["atx", "micro-atx", "matx", "mini-itx", "itx"].includes(String(item).toLowerCase()));
  if (field === "io.port_topology") {
    const values = Array.isArray(fact.value) ? fact.value : [fact.value];
    return values.some((item) => object(item) && typeof item.endpointId === "string" && item.endpointId.length > 0
      && typeof item.connectorType === "string" && item.connectorType.length > 0
      && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 4096);
  }
  return false;
}

function manifestFactIds(manifest) {
  const ids = new Set(manifest?.identity?.identityFactIds ?? []);
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!object(value)) return;
    if (Array.isArray(value.sourceFactIds)) for (const id of value.sourceFactIds) ids.add(id);
    if (Array.isArray(value.evidenceFactIds)) for (const id of value.evidenceFactIds) ids.add(id);
    if (Array.isArray(value.variantScopeFactIds)) for (const id of value.variantScopeFactIds) ids.add(id);
    for (const child of Object.values(value)) visit(child);
  };
  visit(manifest);
  return [...ids].sort(compare);
}

function validateFactEvidenceClosure(candidate, factSnapshots, factsById, claimsById, documents, captures, locators) {
  const snapshot = factSnapshots.get(candidate.factSnapshotRef.snapshotId);
  invariant(snapshot && snapshot.contentHash === candidate.factSnapshotRef.contentHash
    && validateFactSnapshotRuntime(snapshot).length === 0 && verifyFactSnapshotRuntime(snapshot)
    && Array.isArray(snapshot.conflictRefs) && snapshot.conflictRefs.length === 0,
  "provisional adapter FactSnapshot authority is missing, hash-mismatched, or conflicted");
  const facts = snapshot.factRefs.map((ref) => factsById.get(ref.factId));
  invariant(facts.every(Boolean) && facts.every((fact, index) => fact.contentHash === snapshot.factRefs[index].contentHash
    && validateFactRecordRuntime(fact).length === 0 && verifyFactRecordRuntime(fact)
    && fact.status === "active" && ["official", "third_party"].includes(fact.authority)
    && activeAt(fact, snapshot.createdAt)),
  "provisional adapter snapshot contains a missing, stale, or non-governed fact");
  const expectedSubject = exactCandidateSubject(candidate);
  const claimIds = candidate.authorityRefs.evidenceClaimIds;
  const usedClaims = new Set();
  for (const fact of facts) {
    invariant(same({ ...fact.subject, kind: undefined }, expectedSubject) && fact.evidenceRefs.length > 0,
      "provisional adapter fact identity/evidence closure is mismatched");
    for (const claimId of fact.evidenceRefs) {
      const claim = claimsById.get(claimId);
      invariant(claimIds.includes(claimId) && claim && CLAIM_ID.test(claimId)
        && validateEvidenceClaimRuntime(claim).length === 0 && verifyEvidenceClaimRuntime(claim)
        && claim.status === "active" && claim.authority === fact.authority && claim.fieldId === fact.field
        && claim.scope === fact.scope && factsRuntimeSubjectMatchesClaim(fact.subject, claim)
        && same(claim.value, fact.value) && claim.unit === fact.unit && activeAt(claim, snapshot.createdAt)
        && same(claim.subject, expectedSubject),
      "provisional adapter EvidenceClaim does not close its exact fact/product identity");
      usedClaims.add(claimId);
    }
  }
  invariant(same([...usedClaims].sort(compare), claimIds), "provisional adapter EvidenceClaim inventory is not exact");
  invariant(candidate.identity.identityFactIds.every((id) => factsById.get(id)?.field === "identity.revision")
    && candidate.identity.identityFactIds.some((id) => factsById.get(id)?.value === candidate.identity.revision),
  "provisional adapter exact revision identity lacks governed fact authority");

  const documentIds = new Set(); const captureIds = new Set(); const authorities = new Set(); const usedLocators = new Set();
  for (const claimId of claimIds) {
    const claim = claimsById.get(claimId); const document = documents.get(claim.source.documentId); const capture = captures.get(claim.source.captureId);
    invariant(document?.sha256 === claim.source.documentSha256 && capture?.documentId === document?.id,
      "provisional adapter claim document/capture closure is missing or mismatched");
    const governedIdentity = capture.productIdentities?.find((identity) => evidenceIdentityMatchesClaimSubjectRuntime(identity, claim.subject, claim.scope)
      && identity.brand === candidate.catalogIdentity.brand && identity.category === "case"
      && identity.basis === (claim.authority === "official" ? "official-document-explicit" : "third-party-document-explicit"));
    invariant(governedIdentity, "provisional adapter claim lacks exact governed capture product identity");
    const matchingLocators = [...locators].filter(([, locator]) => locator.documentId === document.id
      && locator.documentSha256 === document.sha256 && locator.sourceByteLength === document.byteLength
      && locator.pages.some((page) => (claim.source.locator.page === undefined || page.page === claim.source.locator.page)
        && page.text.includes(claim.source.locator.snippet)));
    invariant(matchingLocators.length === 1, "provisional adapter claim locator/source byte closure is missing or ambiguous");
    usedLocators.add(matchingLocators[0][0]); documentIds.add(document.id); captureIds.add(capture.id); authorities.add(claim.authority);
  }
  invariant(same([...documentIds].sort(compare), candidate.authorityRefs.evidenceDocumentIds)
    && same([...captureIds].sort(compare), candidate.authorityRefs.evidenceCaptureIds)
    && same([...usedLocators].sort(compare), candidate.authorityRefs.evidenceLocatorArtifactRefs)
    && same([...authorities].sort(compare), candidate.sourceAuthorities),
  "provisional adapter evidence source authority inventory is incomplete or forged");

  const required = ["physical.width", "physical.height", "physical.depth", "mount.point_ids", "case.motherboard_form_factors", "io.port_topology"];
  const missing = required.filter((field) => !factSemanticallyPresent(facts, field)).sort(compare);
  invariant(same(missing, candidate.missingFields), "provisional adapter missing-field semantics do not replay from its FactSnapshot");
  if (candidate.manifest) invariant(same(manifestFactIds(candidate.manifest), facts.map((fact) => fact.factId).sort(compare)),
    "provisional adapter manifest anchors do not bind its exact FactSnapshot");
}

function candidateApprovalInput(candidate) {
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

function jobVersions(records) {
  const result = new Map();
  const add = (job) => {
    if (!object(job) || !JOB_ID.test(String(job.jobId ?? ""))) return;
    result.set(job.jobId, [...(result.get(job.jobId) ?? []), job]);
  };
  for (const record of records) {
    if (/^records\/job-[a-f0-9]{64}\.json$/.test(record.rootLogicalPath)) add(record.value?.payload);
    if (/^rollback\/job-[a-f0-9]{64}\/[0-9]{12}\.json$/.test(record.rootLogicalPath)) add(record.value?.payload?.previous);
  }
  return result;
}

function authorityIndexes(records) {
  const values = new Map();
  for (const record of records) {
    const match = /^([^/]+)\/(.+)$/.exec(record.rootLogicalPath);
    if (match) values.set(record.rootLogicalPath, record.value);
  }
  return values;
}

function validateApproval(entry, candidate, artifacts, audits, jobs) {
  const approval = entry.approval;
  const confirmedItem = artifacts.get(approval.confirmedAuthorityRef); const pendingItem = artifacts.get(approval.pendingRef);
  invariant(confirmedItem && pendingItem, "runtime case adapter approval artifacts are missing");
  const confirmed = parseJson(confirmedItem.bytes, "runtime case adapter confirmed approval");
  const pending = parseJson(pendingItem.bytes, "runtime case adapter pending approval");
  invariant(validateAgentWriteApprovalBindingClosureRuntime(approval, confirmed, pending).length === 0
    && validateAgentWriteApprovalArtifactClosureRuntime(confirmed, pending).length === 0,
  "runtime case adapter approval artifact/binding closure is invalid");
  const expectedInput = candidateApprovalInput(candidate);
  invariant(approval.toolName === APPROVAL_TOOL && approval.toolDefinitionHash === APPROVAL_TOOL_HASH
    && approval.inputHash === sha256Json(expectedInput)
    && pending.pending?.call?.name === APPROVAL_TOOL && same(pending.pending.call.input, expectedInput),
  "runtime case adapter approval does not bind the exact server-resolved registration input");
  const auditEnvelope = audits.get(`plan-agent-context/${approval.runId}.json`);
  invariant(validatePlanAgentRunContextAuditEnvelopeRuntime(auditEnvelope, approval.runId).length === 0,
    "runtime case adapter approval Plan Agent context audit is missing or invalid");
  const audit = auditEnvelope.payload;
  invariant(audit.sessionId === approval.sessionId && audit.planId === candidate.planContext.planId
    && audit.draftRevision === candidate.planContext.planRevision && audit.configHash === candidate.planContext.configHash
    && audit.contextHash === approval.planContextHash && Date.parse(audit.recordedAt) <= Date.parse(approval.issuedAt),
  "runtime case adapter approval Plan Agent context is stale or cross-plan");
  const closesCheckpoint = (jobs.get(approval.jobId) ?? []).some((job) => job.type === "agent.run" && job.handlerVersion === "1"
    && job.idempotencyKey === `agent-run:${approval.runId}`
    && (job.status === "running" && job.runtimeGeneration === approval.runtimeGeneration
      && typeof job.leaseToken === "string" && job.leaseToken.length > 0 && iso(job.leaseExpiresAt)
      || job.status === "paused_restore_review" && job.runtimeGeneration > approval.runtimeGeneration)
    && job.checkpointRef === approval.confirmedAuthorityRef);
  invariant(closesCheckpoint && approval.checkpointRef === approval.confirmedAuthorityRef,
    "runtime case adapter approval durable job checkpoint is missing");
  invariant(Date.parse(entry.registeredAt) >= Date.parse(approval.issuedAt)
    && Date.parse(entry.registeredAt) <= Date.parse(approval.expiresAt),
  "runtime case adapter registration falls outside its approved lifetime");
}

function validateRegistryChain(registries, candidates, artifacts, audits, jobs, context) {
  if (!registries.size) return;
  const referenced = new Set();
  for (const [ref, registry] of registries) {
    if (registry.previousRegistryRef) referenced.add(registry.previousRegistryRef);
    const item = artifacts.get(ref);
    const expectedMetadataRefs = unique([
      ...(registry.previousRegistryRef ? [registry.previousRegistryRef] : []),
      ...registry.entries.map((entry) => `sha256:${entry.candidateId.slice("provisional-case-adapter-sha256-".length)}`),
      ...registry.entries.flatMap((entry) => [entry.approval.confirmedAuthorityRef, entry.approval.pendingRef, entry.approval.checkpointRef]),
    ]).map((value) => reference(value));
    exactMetadata(item.record, {
      kind: "runtime-case-adapter-registry-snapshot", mediaType: "application/vnd.buildsim.runtime-case-adapter-registry+json", privacyClass: "runtime_internal",
    }, expectedMetadataRefs);
    const registryNode = `runtime-case-adapter-registry:${ref}`;
    context.nodes.push(registryNode);
    for (const itemRef of runtimeCaseAdapterRegistryReferencesRuntime(registry) ?? []) context.edges.push(graphEdge(registryNode, itemRef.ref, itemRef.necessity));
    for (const entry of registry.entries) {
      const entryNode = entry.entryId;
      context.nodes.push(entryNode, `case-adapter-manifest-sha256-${entry.manifestHash}`);
      const candidateRef = `sha256:${entry.candidateId.slice("provisional-case-adapter-sha256-".length)}`;
      const candidate = candidates.get(candidateRef);
      invariant(candidate && candidate.status === "ready_for_review" && candidate.manifest
        && same(entry.identity, candidate.identity) && same(entry.manifest, candidate.manifest)
        && entry.manifestHash === candidate.manifest.contentHash && entry.candidateId === candidate.candidateId
        && same(entry.planContext, candidate.planContext) && same(entry.factSnapshotRef, candidate.factSnapshotRef)
        && same(entry.authorityRefs, candidate.authorityRefs)
        && entry.previousEntryHash === candidate.registryGuard.expectedPriorRegistrationHash,
      "runtime case adapter registration does not close its exact candidate authority");
      validateApproval(entry, candidate, artifacts, audits, jobs);
      context.edges.push(graphEdge(entryNode, candidateRef), graphEdge(entryNode, `case-adapter-manifest-sha256-${entry.manifestHash}`));
      if (entry.previousEntryHash) context.edges.push(graphEdge(entryNode, `runtime-case-adapter-registration-sha256-${entry.previousEntryHash}`));
    }
  }
  for (const [ref, registry] of registries) {
    if (registry.previousRegistryRef === null) {
      invariant(registry.registryGeneration === 1 && registry.entries.length === 1 && registry.entries[0].previousEntryHash === null,
        "runtime case adapter registry chain root is invalid");
      const rootEntry = registry.entries[0]; const rootCandidate = candidates.get(`sha256:${rootEntry.candidateId.slice("provisional-case-adapter-sha256-".length)}`);
      invariant(rootCandidate?.registryGuard.expectedPriorRegistryRef === null,
        "runtime case adapter registry root candidate CAS authority is invalid");
      continue;
    }
    const previous = registries.get(registry.previousRegistryRef);
    invariant(previous && registry.registryGeneration === previous.registryGeneration + 1,
      "runtime case adapter registry immutable parent/generation closure is invalid");
    const before = new Map(previous.entries.map((entry) => [identityKey(entry.identity), entry]));
    const after = new Map(registry.entries.map((entry) => [identityKey(entry.identity), entry]));
    const changed = [...after].filter(([key, entry]) => !before.has(key) || !same(before.get(key), entry));
    invariant(changed.length === 1 && [...before.keys()].every((key) => after.has(key)),
      "runtime case adapter registry transition must add or supersede exactly one identity");
    const [changedKey, changedEntry] = changed[0]; const prior = before.get(changedKey);
    const changedCandidate = candidates.get(`sha256:${changedEntry.candidateId.slice("provisional-case-adapter-sha256-".length)}`);
    invariant(changedEntry.previousEntryHash === (prior?.contentHash ?? null)
      && changedCandidate?.registryGuard.expectedPriorRegistryRef === registry.previousRegistryRef
      && [...before].every(([key, entry]) => key === changedKey || same(after.get(key), entry)),
    "runtime case adapter registry supersession CAS/history closure is invalid");
  }
  const tips = [...registries].filter(([ref]) => !referenced.has(ref));
  invariant(tips.length === 1, "runtime case adapter registry has ambiguous immutable heads");
  const visited = new Set();
  for (let cursor = tips[0][1]; cursor; cursor = cursor.previousRegistryRef ? registries.get(cursor.previousRegistryRef) : null) {
    invariant(!visited.has(cursor.registryRef), "runtime case adapter registry chain contains a cycle");
    visited.add(cursor.registryRef);
  }
  invariant(visited.size === registries.size, "runtime case adapter registry contains orphan immutable history");
  context.pointers.push(`runtime-case-adapter-registry:${tips[0][0]}`);
}

/**
 * Validates the U5 artifact kinds against their external plan/job/fact/evidence/
 * Agent authorities.  The returned nodes/edges are merged into the production
 * graph, so backup, Doctor and restore all execute this exact closure.
 */
export async function validateProvisionalCaseAdapterProductionClosureAtRoot(options) {
  const { activeRoot, artifactRecords, planRecords, factRecords, evidenceRecords, jobRecords, auditRecords } = options;
  const context = { nodes: [], edges: [], pointers: [] };
  if (!artifactRecords.length) return context;
  const repositoryRoot = confined(activeRoot, "artifacts");
  const repository = new FileArtifactRepository({ root: repositoryRoot });
  const listing = await repository.listAt(repositoryRoot, { initialize: false });
  const artifacts = new Map();
  for (const record of listing.records) {
    const stored = await repository.getAt(repositoryRoot, record.ref, { initialize: false });
    artifacts.set(record.ref, stored);
  }

  const plans = planRecords;
  const factsById = new Map(); const factSnapshots = new Map();
  for (const record of factRecords) {
    if (/^records\/[^/]+\.json$/.test(record.rootLogicalPath)) {
      const fact = record.value?.payload?.fact;
      if (fact?.factId) factsById.set(fact.factId, fact);
    }
    if (/^snapshots\/[^/]+\.json$/.test(record.rootLogicalPath)) {
      const snapshot = record.value?.payload;
      if (snapshot?.snapshotId) factSnapshots.set(snapshot.snapshotId, snapshot);
    }
  }
  const documents = new Map(); const captures = new Map(); const claims = new Map();
  for (const record of evidenceRecords) {
    if (/^documents\/.+\.json$/.test(record.rootLogicalPath) && record.value?.payload?.id) documents.set(record.value.payload.id, record.value.payload);
    if (/^captures\/.+\.json$/.test(record.rootLogicalPath) && record.value?.payload?.id) captures.set(record.value.payload.id, record.value.payload);
    if (/^claims\/.+\.json$/.test(record.rootLogicalPath) && record.value?.payload?.claimId) claims.set(record.value.payload.claimId, record.value.payload);
  }
  const jobs = jobVersions(jobRecords);
  const audits = authorityIndexes(auditRecords);
  const locators = new Map(); const candidates = new Map(); const registries = new Map();

  for (const [ref, item] of artifacts) {
    const { record, bytes } = item;
    if (record.kind === "case-adapter-evidence-locator") {
      const value = parseJson(bytes, "case adapter evidence locator");
      invariant(validateCaseAdapterEvidenceLocatorArtifactRuntime(value).length === 0,
        "case adapter evidence locator semantic authority is invalid");
      exactMetadata(record, {
        kind: "case-adapter-evidence-locator", mediaType: "application/vnd.buildsim.case-adapter-locator+json", privacyClass: "runtime_internal",
      }, []);
      locators.set(ref, value);
      continue;
    }
    if (record.kind === "provisional-case-adapter-plan-authority") {
      const value = parseJson(bytes, "provisional case adapter plan authority");
      invariant(validateProvisionalCaseAdapterPlanAuthorityRuntime(value).length === 0 && planAuthorityInHistory(value, plans),
        "provisional case adapter immutable plan authority lacks exact current/historical PlanRepository closure");
      exactMetadata(record, {
        kind: "provisional-case-adapter-plan-authority", mediaType: "application/vnd.buildsim.provisional-case-adapter-plan-authority+json", privacyClass: "runtime_internal",
      }, []);
      continue;
    }
    if (record.kind === "agent-write-approval-pending" || record.kind === "agent-write-approval-confirmed" || record.kind === "agent-write-approval-consumed") {
      const value = parseJson(bytes, "Agent write approval artifact");
      const metadata = agentWriteApprovalArtifactMetadataRuntime(value);
      invariant(validateAgentWriteApprovalArtifactRuntime(value).length === 0 && metadata,
        "Agent write approval artifact semantic authority is invalid");
      exactMetadata(record, metadata, agentWriteApprovalArtifactReferencesRuntime(value) ?? []);
      const referenced = (agentWriteApprovalArtifactReferencesRuntime(value) ?? [])[0];
      if (referenced) {
        const target = artifacts.get(referenced.ref);
        invariant(target && validateAgentWriteApprovalArtifactClosureRuntime(value, parseJson(target.bytes, "referenced Agent write approval artifact")).length === 0,
          "Agent write approval artifact reference closure is invalid");
      }
      continue;
    }
    if (record.kind === "provisional-case-adapter-candidate") {
      const value = parseJson(bytes, "provisional case adapter candidate");
      const candidate = hydrateProvisionalCaseAdapterCandidateArtifactRuntime(value, ref);
      invariant(candidate, "provisional case adapter candidate semantic authority is invalid");
      const expectedRefs = unique([
        candidate.authorityRefs.generationJobResultRef,
        candidate.authorityRefs.planContextArtifactRef,
        ...(candidate.registryGuard.expectedPriorRegistryRef ? [candidate.registryGuard.expectedPriorRegistryRef] : []),
        ...candidate.authorityRefs.evidenceLocatorArtifactRefs,
      ]).map((valueRef) => reference(valueRef));
      exactMetadata(record, {
        kind: "provisional-case-adapter-candidate", mediaType: "application/vnd.buildsim.provisional-case-adapter+json", privacyClass: "runtime_internal",
      }, expectedRefs);
      candidates.set(ref, candidate);
      continue;
    }
    if (record.kind === "runtime-case-adapter-registry-snapshot") {
      const value = parseJson(bytes, "runtime case adapter registry snapshot");
      const registry = hydrateRuntimeCaseAdapterRegistryArtifactRuntime(value, ref);
      invariant(registry, "runtime case adapter registry snapshot semantic authority is invalid");
      registries.set(ref, registry);
    }
  }

  for (const [ref, candidate] of candidates) {
    const planItem = artifacts.get(candidate.authorityRefs.planContextArtifactRef);
    invariant(planItem, "provisional adapter candidate immutable plan authority is missing");
    const planAuthority = parseJson(planItem.bytes, "provisional adapter candidate plan authority");
    invariant(validateProvisionalCaseAdapterPlanAuthorityRuntime(planAuthority).length === 0
      && same(planAuthority.planContext, candidate.planContext) && same(planAuthority.catalogIdentity, candidate.catalogIdentity)
      && same(planAuthority.identity, candidate.identity),
    "provisional adapter candidate immutable plan projection is mismatched");
    const attemptItem = artifacts.get(candidate.authorityRefs.generationJobResultRef);
    invariant(attemptItem, "provisional adapter generation attempt artifact is missing");
    validateAttempt(parseJson(attemptItem.bytes, "provisional adapter generation attempt"), candidate, attemptItem, artifacts, jobs);
    for (const locatorRef of candidate.authorityRefs.evidenceLocatorArtifactRefs) {
      invariant(locators.has(locatorRef), "provisional adapter candidate evidence locator is missing or wrong-kind");
    }
    validateFactEvidenceClosure(candidate, factSnapshots, factsById, claims, documents, captures,
      new Map(candidate.authorityRefs.evidenceLocatorArtifactRefs.map((locatorRef) => [locatorRef, locators.get(locatorRef)])));
    const candidateNode = `provisional-case-adapter-candidate:${candidate.candidateId}`;
    context.nodes.push(candidateNode);
    if (candidate.manifest) context.nodes.push(`case-adapter-manifest-sha256-${candidate.manifest.contentHash}`);
    for (const itemRef of provisionalCaseAdapterCandidateReferencesRuntime(candidate) ?? []) {
      context.edges.push(graphEdge(candidateNode, itemRef.ref, itemRef.necessity));
    }
  }
  validateRegistryChain(registries, candidates, artifacts, audits, jobs, context);
  return context;
}
