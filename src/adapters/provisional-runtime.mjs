import { createHash } from "node:crypto";
import {
  agentWriteApprovalBindingReferencesRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "../agent/write-approval-runtime.mjs";
import { validateCaseAdapterManifestRuntime } from "./case-manifest-runtime.mjs";

const HASH = /^[a-f0-9]{64}$/;
const REF = /^sha256:([a-f0-9]{64})$/;
const CANDIDATE_ID = /^provisional-case-adapter-sha256-([a-f0-9]{64})$/;
const ENTRY_ID = /^runtime-case-adapter-registration-sha256-([a-f0-9]{64})$/;
const CANDIDATE_DOMAIN = "buildsim.provisional-case-adapter-candidate-v1";
const ENTRY_DOMAIN = "buildsim.runtime-case-adapter-registration-v1";
const REGISTRY_DOMAIN = "buildsim.runtime-case-adapter-registry-v1";
const MISSING_FIELDS = new Set(["physical.width", "physical.height", "physical.depth", "mount.point_ids", "case.motherboard_form_factors", "io.port_topology"]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite runtime value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) throw new TypeError("non-canonical runtime value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function hash(value) { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function same(left, right) { try { return canonical(left) === canonical(right); } catch { return false; } }
function sortedUnique(values, pattern) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && pattern.test(value))
    && new Set(values).size === values.length && same(values, [...values].sort((a, b) => a.localeCompare(b)));
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function portable(value) { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s|[\u0000-\u001f\u007f]/u.test(value) && value === value.normalize("NFC"); }

function identity(value) {
  return exact(value, ["skuId", "region", "revision", "identityFactIds"])
    && portable(value.skuId) && portable(value.region) && portable(value.revision)
    && sortedUnique(value.identityFactIds, /^[^\s\u0000-\u001f\u007f]{1,256}$/u);
}

function planContext(value) {
  return exact(value, ["planId", "caseComponentInstanceId", "planRevision", "configHash"])
    && portable(value.planId) && portable(value.caseComponentInstanceId)
    && Number.isSafeInteger(value.planRevision) && value.planRevision >= 0 && HASH.test(String(value.configHash ?? ""));
}

function planComponent(value, context, catalog) {
  return exact(value, ["instanceId", "kind", "role", "state", "identity", "source"])
    && value.instanceId === context.caseComponentInstanceId && value.kind === "case" && portable(value.role)
    && ["planned", "ordered"].includes(value.state) && ["user", "agent", "migration"].includes(value.source)
    && exact(value.identity, ["status", "skuId", "identityClaimIds"])
    && value.identity.status === "resolved" && value.identity.skuId === catalog.skuId
    && sortedUnique(value.identity.identityClaimIds, /^[^\s\u0000-\u001f\u007f]{1,256}$/u);
}

export function validateProvisionalCaseAdapterPlanAuthorityRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "planContext", "planComponent", "catalogIdentity", "identity"])) {
      return ["provisional case adapter plan authority fields invalid"];
    }
    const errors = [];
    if (value.schemaVersion !== "provisional-case-adapter-plan-authority-v1" || !planContext(value.planContext)
      || !identity(value.identity) || !catalogIdentity(value.catalogIdentity, value.identity)
      || !planComponent(value.planComponent, value.planContext, value.catalogIdentity)) {
      errors.push("provisional case adapter plan/component/catalog authority invalid");
    }
    return errors;
  } catch { return ["provisional case adapter plan authority runtime validation failed closed"]; }
}

export function validateCaseAdapterEvidenceLocatorArtifactRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "documentId", "documentSha256", "sourceByteLength", "pages"])) {
      return ["case adapter evidence locator fields invalid"];
    }
    const errors = [];
    if (value.schemaVersion !== "case-adapter-locator-artifact-v1"
      || !/^doc-sha256-[a-f0-9]{64}$/.test(String(value.documentId ?? ""))
      || !HASH.test(String(value.documentSha256 ?? ""))
      || value.documentId !== `doc-sha256-${value.documentSha256}`
      || !Number.isSafeInteger(value.sourceByteLength) || value.sourceByteLength < 1
      || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 2_048
      || value.pages.some((page) => !exact(page, ["page", "text"]) || !Number.isSafeInteger(page.page) || page.page < 1
        || typeof page.text !== "string" || !page.text.length || page.text !== page.text.normalize("NFC")
        || Buffer.byteLength(page.text, "utf8") > 256 * 1024)
      || new Set(value.pages.map((page) => page.page)).size !== value.pages.length) {
      errors.push("case adapter evidence locator source/page closure invalid");
    }
    return errors;
  } catch { return ["case adapter evidence locator runtime validation failed closed"]; }
}

function registryGuard(value) {
  return exact(value, ["expectedPriorRegistrationHash", "expectedPriorRegistryRef"])
    && (value.expectedPriorRegistrationHash === null || HASH.test(String(value.expectedPriorRegistrationHash ?? "")))
    && (value.expectedPriorRegistryRef === null ? value.expectedPriorRegistrationHash === null : REF.test(String(value.expectedPriorRegistryRef ?? "")));
}

function catalogIdentity(value, adapterIdentity) {
  return exact(value, ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"])
    && typeof value.brand === "string" && value.brand.length > 0 && value.brand === value.brand.normalize("NFC") && value.category === "case"
    && [value.skuId, value.familyId, value.modelId, value.variantId, value.revision, value.region].every(portable)
    && value.skuId === adapterIdentity.skuId && value.revision === adapterIdentity.revision && value.region === adapterIdentity.region;
}

function authorityRefs(value) {
  return exact(value, ["generationJobId", "generationJobResultRef", "planContextArtifactRef", "evidenceClaimIds", "evidenceDocumentIds", "evidenceCaptureIds", "evidenceLocatorArtifactRefs"])
    && /^job-[a-f0-9]{64}$/.test(String(value.generationJobId ?? "")) && REF.test(String(value.generationJobResultRef ?? ""))
    && REF.test(String(value.planContextArtifactRef ?? ""))
    && sortedUnique(value.evidenceClaimIds, /^claim-sha256-[a-f0-9]{64}$/)
    && sortedUnique(value.evidenceDocumentIds, /^doc-sha256-[a-f0-9]{64}$/)
    && sortedUnique(value.evidenceCaptureIds, /^capture-sha256-[a-f0-9]{64}$/)
    && sortedUnique(value.evidenceLocatorArtifactRefs, /^sha256:[a-f0-9]{64}$/);
}

function missingAction(fieldId) {
  if (["physical.width", "physical.height", "physical.depth"].includes(fieldId)) return {
    fieldId, preferredAuthority: "official", action: "acquire_dimensioned_drawing", reason: "exact case envelope dimension is required for spatial closure",
  };
  if (fieldId === "io.port_topology") return {
    fieldId, preferredAuthority: "official", action: "acquire_port_or_routing_view", reason: "a documented connector and route endpoint are required for routing closure",
  };
  return { fieldId, preferredAuthority: "official", action: "acquire_product_page_or_manual", reason: "an exact revision installation fact is required for mount closure" };
}

function domains(missing) {
  const geometryMissing = missing.filter((field) => field !== "io.port_topology");
  return {
    electronics: { status: "ready", reason: "exact governed capability facts remain usable independently of spatial evidence" },
    geometry: geometryMissing.length
      ? { status: "blocked", reason: `missing exact spatial fields: ${geometryMissing.join(", ")}` }
      : { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel spatial authority" },
    routing: missing.length
      ? { status: "blocked", reason: `missing exact route fields: ${missing.join(", ")}` }
      : { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel routing authority" },
    assembly: { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel assembly authority" },
  };
}

function candidateUnsigned(value) {
  if (!object(value)) return null;
  const { candidateId: _candidateId, contentHash: _contentHash, ...unsigned } = value;
  return unsigned;
}

export function provisionalCaseAdapterCandidateContentHashRuntime(value) {
  try {
    const unsigned = candidateUnsigned(value);
    return unsigned ? hash({ domain: CANDIDATE_DOMAIN, candidate: unsigned }) : null;
  } catch { return null; }
}

export function validateProvisionalCaseAdapterCandidateRuntime(value) {
  try {
    const keys = ["schemaVersion", "candidateId", "status", "runtimeGeneration", "planContext", "registryGuard", "authorityRefs", "catalogIdentity", "identity", "factSnapshotRef", "sourceAuthorities", "domains", "missingFields", "nextEvidenceActions", "manifest", "createdAt", "contentHash"];
    if (!exact(value, keys)) return ["provisional case adapter candidate fields invalid"];
    const errors = [];
    const id = CANDIDATE_ID.exec(String(value.candidateId ?? ""));
    const computed = provisionalCaseAdapterCandidateContentHashRuntime(value);
    if (value.schemaVersion !== "provisional-case-adapter-candidate-v1" || !id || !HASH.test(String(value.contentHash ?? ""))
      || id[1] !== value.contentHash || computed !== value.contentHash) errors.push("candidate content identity invalid");
    if (!Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1) errors.push("candidate runtime generation invalid");
    if (!planContext(value.planContext) || !registryGuard(value.registryGuard) || !identity(value.identity) || !catalogIdentity(value.catalogIdentity, value.identity)) errors.push("candidate plan/catalog/registry identity invalid");
    if (!authorityRefs(value.authorityRefs)) errors.push("candidate authority refs invalid");
    if (!exact(value.factSnapshotRef, ["snapshotId", "contentHash"]) || !portable(value.factSnapshotRef.snapshotId) || !HASH.test(String(value.factSnapshotRef.contentHash ?? ""))) errors.push("candidate FactSnapshot ref invalid");
    if (!sortedUnique(value.sourceAuthorities, /^(official|third_party)$/)) errors.push("candidate source authorities invalid");
    if (!Array.isArray(value.missingFields) || value.missingFields.some((field) => !MISSING_FIELDS.has(field))
      || new Set(value.missingFields).size !== value.missingFields.length || !same(value.missingFields, [...value.missingFields].sort((a, b) => a.localeCompare(b)))) errors.push("candidate missing fields invalid");
    const expectedDomains = domains(Array.isArray(value.missingFields) ? value.missingFields : []);
    if (!same(value.domains, expectedDomains) || !same(value.nextEvidenceActions, (value.missingFields ?? []).map(missingAction))) errors.push("candidate partial-domain semantics invalid");
    if (value.status === "ready_for_review") {
      if (value.missingFields.length || validateCaseAdapterManifestRuntime(value.manifest).length
        || !same(value.manifest.identity, value.identity) || value.manifest.adapterId !== `adapter.provisional.${value.identity.skuId}`
        || value.manifest.adapterVersion !== "provisional-v1") errors.push("reviewable candidate manifest invalid");
      const expectedSources = authorityRefs(value.authorityRefs) ? [...new Set([...value.authorityRefs.evidenceDocumentIds, ...value.authorityRefs.evidenceCaptureIds, ...value.authorityRefs.evidenceLocatorArtifactRefs])].sort((a, b) => a.localeCompare(b)) : [];
      if (!same(value.manifest?.sourceRefs, expectedSources)) errors.push("candidate manifest evidence sources invalid");
    } else if (value.status === "partial") {
      if (!value.missingFields.length || value.manifest !== null) errors.push("partial candidate closure invalid");
    } else errors.push("candidate status invalid");
    if (!iso(value.createdAt)) errors.push("candidate stable issuedAt invalid");
    return errors;
  } catch { return ["provisional case adapter candidate runtime validation failed closed"]; }
}

export function provisionalCaseAdapterCandidateReferencesRuntime(value) {
  if (validateProvisionalCaseAdapterCandidateRuntime(value).length) return null;
  const refs = [
    { ref: `job:${value.authorityRefs.generationJobId}`, necessity: "required_for_replay" },
    { ref: value.authorityRefs.generationJobResultRef, necessity: "required_for_replay" },
    { ref: value.authorityRefs.planContextArtifactRef, necessity: "required_for_replay" },
    ...(value.registryGuard.expectedPriorRegistryRef ? [{ ref: value.registryGuard.expectedPriorRegistryRef, necessity: "required_for_replay" }] : []),
    { ref: `fact-snapshot:${value.factSnapshotRef.snapshotId}`, necessity: "required_for_replay" },
    ...value.authorityRefs.evidenceClaimIds.map((ref) => ({ ref: `evidence-claim:${ref}`, necessity: "required_for_replay" })),
    ...value.authorityRefs.evidenceDocumentIds.map((ref) => ({ ref: `evidence-document:${ref}`, necessity: "required_for_replay" })),
    ...value.authorityRefs.evidenceCaptureIds.map((ref) => ({ ref: `evidence-capture:${ref}`, necessity: "required_for_replay" })),
    ...value.authorityRefs.evidenceLocatorArtifactRefs.map((ref) => ({ ref, necessity: "required_for_replay" })),
    ...(value.manifest ? [{ ref: `case-adapter-manifest-sha256-${value.manifest.contentHash}`, necessity: "required_for_replay" }] : []),
  ];
  return refs.sort((a, b) => a.ref.localeCompare(b.ref));
}

export function hydrateProvisionalCaseAdapterCandidateArtifactRuntime(value, ref) {
  try {
    const match = REF.exec(String(ref ?? ""));
    if (!match || !exact(value, ["domain", "candidate"]) || value.domain !== CANDIDATE_DOMAIN || !object(value.candidate)) return null;
    const candidate = { ...value.candidate, candidateId: `provisional-case-adapter-sha256-${match[1]}`, contentHash: match[1] };
    return validateProvisionalCaseAdapterCandidateRuntime(candidate).length ? null : candidate;
  } catch { return null; }
}

function entryUnsigned(value) { const { entryId: _entryId, contentHash: _contentHash, ...unsigned } = value; return unsigned; }
function registryUnsigned(value) { const { registryRef: _registryRef, contentHash: _contentHash, ...unsigned } = value; return unsigned; }

export function runtimeCaseAdapterRegistrationContentHashRuntime(value) {
  try { return object(value) ? hash({ domain: ENTRY_DOMAIN, entry: entryUnsigned(value) }) : null; } catch { return null; }
}

export function validateRuntimeCaseAdapterRegistrationRuntime(value) {
  try {
    const keys = ["schemaVersion", "entryId", "identity", "manifest", "manifestHash", "candidateId", "previousEntryHash", "planContext", "factSnapshotRef", "authorityRefs", "approval", "registeredAt", "contentHash"];
    if (!exact(value, keys)) return ["runtime case adapter registration fields invalid"];
    const errors = [];
    const id = ENTRY_ID.exec(String(value.entryId ?? ""));
    if (value.schemaVersion !== "runtime-case-adapter-registration-v1" || !id || id[1] !== value.contentHash
      || runtimeCaseAdapterRegistrationContentHashRuntime(value) !== value.contentHash) errors.push("registration content identity invalid");
    if (!identity(value.identity) || validateCaseAdapterManifestRuntime(value.manifest).length
      || !same(value.manifest.identity, value.identity) || value.manifest.contentHash !== value.manifestHash || !HASH.test(String(value.manifestHash ?? ""))) errors.push("registration manifest identity invalid");
    if (!CANDIDATE_ID.test(String(value.candidateId ?? "")) || !planContext(value.planContext) || !authorityRefs(value.authorityRefs)) errors.push("registration candidate/plan authority invalid");
    if (value.previousEntryHash !== null && !HASH.test(String(value.previousEntryHash ?? ""))) errors.push("registration previous entry CAS hash invalid");
    if (!exact(value.factSnapshotRef, ["snapshotId", "contentHash"]) || !portable(value.factSnapshotRef.snapshotId) || !HASH.test(String(value.factSnapshotRef.contentHash ?? ""))) errors.push("registration snapshot ref invalid");
    if (validateAgentWriteApprovalBindingRuntime(value.approval).length || value.approval.toolName !== "register_provisional_case_adapter") errors.push("registration approval invalid");
    if (!iso(value.registeredAt)) errors.push("registration timestamp invalid");
    return errors;
  } catch { return ["runtime case adapter registration runtime validation failed closed"]; }
}

export function runtimeCaseAdapterRegistryContentHashRuntime(value) {
  try { return object(value) ? hash({ domain: REGISTRY_DOMAIN, registry: registryUnsigned(value) }) : null; } catch { return null; }
}

export function validateRuntimeCaseAdapterRegistryRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "runtimeGeneration", "registryGeneration", "previousRegistryRef", "entries", "registryRef", "contentHash"])) return ["runtime case adapter registry fields invalid"];
    const errors = [];
    const ref = REF.exec(String(value.registryRef ?? ""));
    if (value.schemaVersion !== "runtime-case-adapter-registry-v1" || !ref || ref[1] !== value.contentHash
      || runtimeCaseAdapterRegistryContentHashRuntime(value) !== value.contentHash) errors.push("registry content identity invalid");
    if (!Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1 || !Number.isSafeInteger(value.registryGeneration) || value.registryGeneration < 1
      || (value.previousRegistryRef !== null && !REF.test(String(value.previousRegistryRef)))) errors.push("registry generation/parent invalid");
    if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > value.registryGeneration
      || value.entries.some((entry) => validateRuntimeCaseAdapterRegistrationRuntime(entry).length)) errors.push("registry entries invalid");
    if (Array.isArray(value.entries) && (new Set(value.entries.map((entry) => `${entry.identity?.skuId}\0${entry.identity?.region}\0${entry.identity?.revision}`)).size !== value.entries.length
      || new Set(value.entries.map((entry) => entry.candidateId)).size !== value.entries.length)) errors.push("registry exact identities/candidates duplicated");
    return errors;
  } catch { return ["runtime case adapter registry runtime validation failed closed"]; }
}

export function runtimeCaseAdapterRegistryReferencesRuntime(value) {
  if (validateRuntimeCaseAdapterRegistryRuntime(value).length) return null;
  const refs = [
    ...(value.previousRegistryRef ? [{ ref: value.previousRegistryRef, necessity: "required_for_replay" }] : []),
    ...value.entries.flatMap((entry) => [
      { ref: `sha256:${CANDIDATE_ID.exec(entry.candidateId)[1]}`, necessity: "required_for_replay" },
      { ref: `case-adapter-manifest-sha256-${entry.manifestHash}`, necessity: "required_for_replay" },
      ...(agentWriteApprovalBindingReferencesRuntime(entry.approval) ?? []),
      { ref: `fact-snapshot:${entry.factSnapshotRef.snapshotId}`, necessity: "required_for_replay" },
      ...(entry.previousEntryHash ? [{ ref: `runtime-case-adapter-registration-sha256-${entry.previousEntryHash}`, necessity: "required_for_replay" }] : []),
    ]),
  ];
  const byKey = new Map(refs.map((item) => [`${item.ref}\0${item.necessity}`, item]));
  return [...byKey.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

export function hydrateRuntimeCaseAdapterRegistryArtifactRuntime(value, ref) {
  try {
    const match = REF.exec(String(ref ?? ""));
    if (!match || !exact(value, ["domain", "registry"]) || value.domain !== REGISTRY_DOMAIN || !object(value.registry)) return null;
    const registry = { ...value.registry, registryRef: ref, contentHash: match[1] };
    return validateRuntimeCaseAdapterRegistryRuntime(registry).length ? null : registry;
  } catch { return null; }
}
