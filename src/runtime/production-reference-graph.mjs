import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertProductCatalogRuntimeAuthority, loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import {
  OFFICIAL_DOMAIN_REGISTRY,
  assertOfficialDomainOverlayDocument,
  assertOfficialDomainRegistryDocument,
  mergeOfficialRegistry,
  officialRegistryDocument,
} from "../../scripts/price-server/catalog/registry.mjs";
import {
  assertDomainApprovalManifest,
  assertDomainMigrationMarker,
  assertDomainProposalDocument,
} from "../../scripts/price-server/catalog/domain-proposals.mjs";
import { assertPriceRuntimeAuthority } from "../../scripts/price-server/store.mjs";
import { sanitizeTransactionRecordForPersistence } from "../../scripts/price-server/transactions/archive.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { validateRuntimeBackgroundJob } from "../jobs/runtime-validation.mjs";
import { validateScenarioRuntimeRecords } from "../scenarios/runtime-validation.mjs";
import {
  hashPlanConfigRuntime,
  migrationCatalogProjectionRuntime,
  validatePlanEvidenceBindingRuntime,
  validatePlanIdempotencyRuntime,
  validatePlanRuntime,
  validatePlanVersionRuntime,
} from "../plans/canonical-runtime.mjs";
import { validateResolvedPlanCatalogBindingsRuntime } from "../config/v3-catalog-runtime.mjs";
import { RUNTIME_REQUIRED_ROOTS } from "./coordinator.mjs";
import {
  canonicalJson,
  confined,
  atomicWriteJson,
  listRegularFiles,
  sha256Bytes,
  sha256Json,
} from "./fs.mjs";
import { createReferenceGraphAtSnapshot, portableReferenceGraphHash, verifyReferenceGraph } from "./reference-graph.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const PROVIDER_PREFIX = "runtime/";

export const PRODUCTION_REFERENCE_COMPOSITION_ID = "buildsim-runtime-reference-composition-v1";
export const PRODUCTION_REFERENCE_PROVIDER_IDS = Object.freeze(RUNTIME_REQUIRED_ROOTS.map((root) => `${PROVIDER_PREFIX}${root}`));

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function unique(values) { return [...new Set(values)].sort(compare); }
function edge(fromRef, toRef, necessity = "required_for_replay") { return { fromRef, toRef, necessity }; }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function validEnvelope(value, schemaVersion, kind) {
  return object(value) && value.schemaVersion === schemaVersion && value.kind === kind
    && Object.prototype.hasOwnProperty.call(value, "payload") && value.checksum === sha256Json(value.payload);
}
function without(value, key) { const result = { ...value }; delete result[key]; return result; }
function providerRootRef(root) { return `runtime-repository:${root}`; }
function pathId(logicalPath) { return path.posix.basename(logicalPath, ".json"); }

function ownedPlanVersion(records, planId, versionId) {
  if (typeof versionId !== "string") return undefined;
  const record = records.find((candidate) => candidate.rootLogicalPath === `${planId}/versions/${versionId}.json`);
  if (!record || !validEnvelope(record.value, "1.0.0", "version")) return undefined;
  return record.value.payload?.id === versionId && record.value.payload?.planId === planId ? record.value.payload : undefined;
}

function planMigrationProjection(records, planId) {
  const planRecord = records.find((candidate) => candidate.rootLogicalPath === `${planId}/plan.json`);
  if (!planRecord || !validEnvelope(planRecord.value, "1.0.0", "plan")) return null;
  const plan = planRecord.value.payload;
  const migration = plan?.draft?.configMigration;
  const sourceVersion = ownedPlanVersion(records, planId, migration?.sourceVersionId);
  if (!migration || !sourceVersion) return null;
  return migrationCatalogProjectionRuntime(migration, { planId, config: plan.draft.config, sourceVersion });
}

function migrationCatalogIdentity(component) {
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

function catalogIssuesWithMigrationAuthority(config, catalog, projection, versionId = null) {
  const issues = validateResolvedPlanCatalogBindingsRuntime(config, catalog);
  if (!projection || !issues.length) return issues;
  if (config?.schemaVersion === "2.0.0") {
    return versionId === projection.sourceVersionId
      ? issues.filter((issue) => issue.path !== "selection.coolerId")
      : issues;
  }
  if (config?.schemaVersion !== "3.0.0" || !projection.migratedCoolerComponent || !Array.isArray(config.components)) return issues;
  const expectedIdentityHash = sha256Json(migrationCatalogIdentity(projection.migratedCoolerComponent));
  const coolerIndex = config.components.findIndex((component) => sha256Json(migrationCatalogIdentity(component)) === expectedIdentityHash);
  if (coolerIndex < 0) return issues;
  return issues.filter((issue) => !issue.path.startsWith(`components.${coolerIndex}.`));
}

function validatePlanRepositoryClosure(records) {
  const owners = new Map();
  const parentByVersion = new Map();
  for (const record of records) {
    const match = /^([^/]+)\/versions\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (!match || !validEnvelope(record.value, "1.0.0", "version")) continue;
    const [planId, versionId] = match.slice(1);
    invariant(!owners.has(versionId), "plan version IDs must be globally unique across plans");
    owners.set(versionId, planId);
    parentByVersion.set(versionId, record.value.payload?.parentVersionId ?? null);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (versionId) => {
    if (visited.has(versionId)) return;
    invariant(!visiting.has(versionId), "plan version parent graph contains a cycle");
    visiting.add(versionId);
    const parentId = parentByVersion.get(versionId);
    if (parentId !== null && parentId !== undefined) visit(parentId);
    visiting.delete(versionId); visited.add(versionId);
  };
  for (const versionId of parentByVersion.keys()) visit(versionId);
}

function evidenceAuthorityIndex(records) {
  const documents = new Map(); const captures = new Map();
  for (const record of records) {
    const document = /^documents\/[a-f0-9]{2}\/(doc-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (document && validEnvelope(record.value, "1.0.0", "evidence-document")) documents.set(document[1], record.value.payload);
    const capture = /^captures\/[a-f0-9]{2}\/(capture-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (capture && validEnvelope(record.value, "1.0.0", "evidence-capture")) captures.set(capture[1], record.value.payload);
  }
  return { documents, captures };
}

async function recordsFor(activeRoot, root) {
  const repositoryRoot = confined(activeRoot, root);
  const files = await listRegularFiles(repositoryRoot);
  const records = [];
  for (const file of files) {
    // This file describes the backup currently being assembled. It is not an
    // authority record in the source runtime and therefore is deliberately
    // outside the production graph inventory.
    if (root === "audit" && ["backup-runtime-snapshot.json", "runtime-reference-graph.json"].includes(file.logicalPath)) continue;
    if (file.symlink) throw new Error(`${root} repository contains a symbolic link`);
    const bytes = await readFile(file.absolutePath);
    const logicalPath = `${root}/${file.logicalPath}`;
    let value;
    if (file.logicalPath.endsWith(".json")) {
      try { value = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error(`${root} repository contains malformed JSON`); }
    }
    records.push({ ...file, logicalPath, rootLogicalPath: file.logicalPath, bytes, value, sha256: sha256Bytes(bytes) });
  }
  return records.sort((left, right) => compare(left.rootLogicalPath, right.rootLogicalPath));
}

function validatePlanRecord(record, context, records, catalog, evidence) {
  const relative = record.rootLogicalPath;
  if (!relative.endsWith(".json")) return;
  const plan = /^([^/]+)\/plan\.json$/.exec(relative);
  if (plan) {
    invariant(PLAN_ID.test(plan[1]) && validEnvelope(record.value, "1.0.0", "plan"), "plan authority envelope is invalid");
    const value = record.value.payload;
    const sourceVersionId = value?.draft?.configMigration?.sourceVersionId;
    const sourceVersion = ownedPlanVersion(records, plan[1], sourceVersionId);
    const migrationProjection = value?.draft?.configMigration
      ? migrationCatalogProjectionRuntime(value.draft.configMigration, { planId: plan[1], config: value.draft.config, sourceVersion })
      : null;
    const activeVersion = value?.activeVersionId === null ? null : ownedPlanVersion(records, plan[1], value?.activeVersionId);
    const baseVersion = value?.draft?.baseVersionId === null ? null : ownedPlanVersion(records, plan[1], value?.draft?.baseVersionId);
    invariant(value?.id === plan[1] && validatePlanRuntime(value, { topologyV3Enabled: true, sourceVersion, catalog }).length === 0
      && catalogIssuesWithMigrationAuthority(value?.draft?.config, catalog, migrationProjection).length === 0
      && (value.activeVersionId === null || PLAN_ID.test(value.activeVersionId) && activeVersion)
      && (value.draft.baseVersionId === null || PLAN_ID.test(value.draft.baseVersionId) && baseVersion), "plan authority payload is invalid");
    const ref = `plan:${value.id}`; context.nodes.push(ref); context.pointers.push(ref);
    if (value.activeVersionId) context.edges.push(edge(ref, `plan-version:${value.activeVersionId}`));
    if (value.draft.baseVersionId) context.edges.push(edge(ref, `plan-version:${value.draft.baseVersionId}`));
    if (sourceVersionId) context.edges.push(edge(ref, `plan-version:${sourceVersionId}`));
    for (const binding of value.draft.evidenceBindings ?? []) addEvidenceEdges(context, ref, binding, evidence, { planId: value.id }, "optional_for_audit");
    return;
  }
  const version = /^([^/]+)\/versions\/([^/]+)\.json$/.exec(relative);
  if (version) {
    invariant(PLAN_ID.test(version[1]) && PLAN_ID.test(version[2]) && validEnvelope(record.value, "1.0.0", "version"), "plan version envelope is invalid");
    const value = record.value.payload;
    const migrationProjection = planMigrationProjection(records, version[1]);
    const parentVersion = value?.parentVersionId === null ? null : ownedPlanVersion(records, version[1], value?.parentVersionId);
    invariant(value?.id === version[2] && value.planId === version[1] && validatePlanVersionRuntime(value, { topologyV3Enabled: true }).length === 0
      && catalogIssuesWithMigrationAuthority(value?.config, catalog, migrationProjection, value?.id).length === 0
      && SHA256.test(String(value.configHash ?? "")) && value.configHash === hashPlanConfigRuntime(value.config)
      && (value.parentVersionId === null || PLAN_ID.test(value.parentVersionId) && value.parentVersionId !== value.id
        && parentVersion && parentVersion.versionNumber < value.versionNumber)
      && (value.evaluationHash === undefined || SHA256.test(value.evaluationHash))
      && (value.evidenceHash === undefined || value.evidenceHash === sha256Json(value.evidenceBindings ?? [])), "plan version payload/hash is invalid");
    const ref = `plan-version:${value.id}`; context.nodes.push(ref); context.pointers.push(ref); context.edges.push(edge(ref, `plan:${value.planId}`, "optional_for_audit"));
    if (value.parentVersionId) context.edges.push(edge(ref, `plan-version:${value.parentVersionId}`));
    if (value.evaluationHash) { context.nodes.push(`evaluation:${value.evaluationHash}`); context.edges.push(edge(ref, `evaluation:${value.evaluationHash}`)); }
    for (const binding of value.evidenceBindings ?? []) addEvidenceEdges(context, ref, binding, evidence, { planId: value.planId, versionId: value.id });
    return;
  }
  if (/^\.idempotency\/[a-f0-9]{64}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "1.0.0", "idempotency") && validatePlanIdempotencyRuntime(record.value.payload).length === 0, "plan idempotency record is invalid");
    const result = record.value.payload.result;
    const planPayload = records.find((candidate) => candidate.rootLogicalPath === `${result.planId}/plan.json`)?.value?.payload;
    invariant(planPayload?.id === result.planId, "plan idempotency result plan reference is unavailable");
    if (result.kind === "version") {
      const versionPayload = records.find((candidate) => candidate.rootLogicalPath === `${result.planId}/versions/${result.versionId}.json`)?.value?.payload;
      invariant(versionPayload?.id === result.versionId && versionPayload.planId === result.planId, "plan idempotency result version reference is unavailable or cross-plan");
    } else if (result.kind === "evidence-binding") {
      const binding = planPayload?.draft?.evidenceBindings?.find((candidate) => candidate.id === result.bindingId);
      invariant(binding && validatePlanEvidenceBindingRuntime(binding, { planId: result.planId }).length === 0, "plan idempotency result evidence reference is unavailable or invalid");
    }
    return;
  }
  if (relative === ".rollback/manifest.json") {
    invariant(record.value?.schemaVersion === "plan-rollback-manifest-v1" && Array.isArray(record.value.entries)
      && record.value.entries.every((entry) => ["committed", "moved"].includes(entry?.status)), "plan rollback manifest is incomplete or invalid");
    return;
  }
  throw new Error("plans repository contains an unrecognized JSON authority");
}

function addEvidenceEdges(context, fromRef, binding, evidence, owner, necessity = "required_for_replay") {
  invariant(validatePlanEvidenceBindingRuntime(binding, owner).length === 0, "plan evidence binding is invalid");
  const document = evidence.documents.get(binding.documentId);
  invariant(document?.id === binding.documentId && document.sha256 === binding.contentHash,
    "plan evidence binding document content hash is missing or mismatched");
  context.edges.push(edge(fromRef, `evidence-document:${binding.documentId}`, necessity));
  if (binding.captureId !== undefined) {
    const capture = evidence.captures.get(binding.captureId);
    invariant(capture?.id === binding.captureId && capture.documentId === binding.documentId,
      "plan evidence capture binding is missing or mismatched");
    context.edges.push(edge(fromRef, `evidence-capture:${binding.captureId}`, necessity));
  }
}

async function validateEvidenceRecord(record, context, activeRoot) {
  const relative = record.rootLogicalPath;
  const document = /^documents\/([a-f0-9]{2})\/(doc-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (document) {
    invariant(validEnvelope(record.value, "1.0.0", "evidence-document"), "evidence document envelope is invalid");
    const value = record.value.payload;
    invariant(value?.id === document[2] && value.sha256 === document[3] && document[1] === document[3].slice(0, 2)
      && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && iso(value.createdAt), "evidence document identity is invalid");
    const blob = confined(activeRoot, "evidence", "blobs", "sha256", value.sha256.slice(0, 2), value.sha256);
    const bytes = await readFile(blob).catch(() => null);
    invariant(bytes && bytes.length === value.byteLength && sha256Bytes(bytes) === value.sha256, "evidence document blob is missing or corrupt");
    context.nodes.push(`evidence-document:${value.id}`, `evidence-blob:sha256:${value.sha256}`);
    context.edges.push(edge(`evidence-document:${value.id}`, `evidence-blob:sha256:${value.sha256}`));
    return;
  }
  const capture = /^captures\/([a-f0-9]{2})\/(capture-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (capture) {
    invariant(validEnvelope(record.value, "1.0.0", "evidence-capture"), "evidence capture envelope is invalid");
    const value = record.value.payload; const unsigned = without(value ?? {}, "id");
    invariant(value?.id === capture[2] && capture[1] === capture[3].slice(0, 2)
      && /^doc-sha256-[a-f0-9]{64}$/.test(String(value.documentId ?? "")) && iso(value.retrievedAt)
      && value.id === `capture-sha256-${sha256Bytes(Buffer.from(canonicalJson(unsigned), "utf8"))}`, "evidence capture identity is invalid");
    context.nodes.push(`evidence-capture:${value.id}`); context.pointers.push(`evidence-capture:${value.id}`);
    context.edges.push(edge(`evidence-capture:${value.id}`, `evidence-document:${value.documentId}`));
    return;
  }
  if (/^source-index\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "1.0.0", "evidence-url-index")
      && /^capture-sha256-[a-f0-9]{64}$/.test(String(record.value.payload?.captureId ?? ""))
      && /^doc-sha256-[a-f0-9]{64}$/.test(String(record.value.payload?.documentId ?? "")), "evidence source index is invalid");
    return;
  }
  if (relative === ".rollback/manifest.json") {
    invariant(record.value?.schemaVersion === "evidence-rollback-manifest-v1" && Array.isArray(record.value.entries)
      && record.value.entries.every((entry) => entry?.status === "committed"), "evidence rollback manifest is incomplete or invalid");
    return;
  }
  if (relative.startsWith("blobs/")) return;
  if (relative.endsWith(".json")) throw new Error("evidence repository contains an unrecognized JSON authority");
}

function validateAttachmentRecord(record, context) {
  const metadata = /^metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  if (!metadata) {
    if (record.rootLogicalPath === "rollback/manifest.json") {
      const body = without(record.value ?? {}, "checksum");
      invariant(record.value?.schemaVersion === "attachment-rollback-manifest-v1" && Array.isArray(record.value.entries)
        && record.value.checksum === sha256Json(body), "attachment rollback manifest is invalid");
    } else if (record.rootLogicalPath.endsWith(".json")) {
      invariant(validEnvelope(record.value, "attachment-rollback-v1", "attachment-rollback"), "attachment rollback record is invalid");
    }
    return;
  }
  invariant(validEnvelope(record.value, "attachment-repository-v1", "attachment"), "attachment envelope is invalid");
  const value = record.value.payload; const base = without(value ?? {}, "metadataHash");
  invariant(value?.attachmentId === metadata[1] && SAFE_ID.test(value.attachmentId) && SHA256.test(String(value.contentHash ?? ""))
    && value.metadataHash === sha256Json(base) && Number.isInteger(value.revision) && value.revision >= 0
    && ["available", "deleted_tombstone"].includes(value.status), "attachment metadata/hash is invalid");
  if (value.status === "available") {
    context.nodes.push(`attachment:${value.attachmentId}`, `attachment-blob:sha256:${value.contentHash}`);
    context.pointers.push(`attachment:${value.attachmentId}`);
    context.edges.push(edge(`attachment:${value.attachmentId}`, `attachment-blob:sha256:${value.contentHash}`));
  }
}

function validateObservationRecord(record, context) {
  const observation = /^plans\/([^/]+)\/records\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  const snapshot = /^plans\/([^/]+)\/snapshots\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  if (observation) {
    invariant(validEnvelope(record.value, "observation-repository-v1", "observation"), "observation envelope is invalid");
    const stored = record.value.payload;
    invariant(stored?.schemaVersion === "observation-repository-v1" && stored.observation?.observationId === observation[2]
      && stored.observation.planId === observation[1] && stored.recordHash === sha256Json(stored.observation), "observation identity/hash is invalid");
    const ref = `observation:${observation[2]}`; context.nodes.push(ref);
    for (const attachmentId of stored.observation.attachmentRefs ?? []) context.edges.push(edge(ref, `attachment:${attachmentId}`));
    return;
  }
  if (snapshot) {
    invariant(validEnvelope(record.value, "observation-repository-v1", "snapshot"), "observation snapshot envelope is invalid");
    const value = record.value.payload;
    invariant(value?.snapshotId === snapshot[2] && value.planId === snapshot[1] && Array.isArray(value.observationIds)
      && SHA256.test(String(value.contentHash ?? "")), "observation snapshot is invalid");
    const ref = `observation-snapshot:${value.snapshotId}`; context.nodes.push(ref); context.pointers.push(ref);
    for (const id of value.observationIds) context.edges.push(edge(ref, `observation:${id}`));
    return;
  }
  if (record.rootLogicalPath.startsWith("journal/") && record.rootLogicalPath.endsWith(".json")) {
    invariant(validEnvelope(record.value, "observation-journal-v1", "transaction") && ["prepared", "committed"].includes(record.value.payload?.state), "observation journal is invalid");
    invariant(record.value.payload.state === "committed", "observation journal has an incomplete prepared transaction");
    return;
  }
  if (record.rootLogicalPath.endsWith(".json")) throw new Error("observations repository contains an unrecognized JSON authority");
}

function validateExecutionRecord(record, context, generation) {
  const sessionMatch = /^sessions\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  if (sessionMatch) {
    invariant(validEnvelope(record.value, "execution-repository-v1", "execution-session"), "execution session envelope is invalid");
    const stored = record.value.payload; const base = without(stored ?? {}, "recordHash"); const session = stored?.session;
    invariant(stored?.schemaVersion === "execution-repository-v1" && stored.recordHash === sha256Json(base)
      && stored.runtimeGeneration === generation && Number.isInteger(stored.revision) && stored.revision >= 0
      && session?.executionSessionId === sessionMatch[1] && ["active", "completed", "stale", "abandoned"].includes(session.status)
      && Array.isArray(session.results) && object(stored.replayContext?.references), "execution session identity/hash/generation is invalid");
    const refs = stored.replayContext.references;
    const required = [refs.planVersionRef, refs.evaluationRef, refs.procedureRef, refs.procedureSafetyRef, refs.evaluatorArtifactRef];
    invariant(required.every((ref) => typeof ref === "string" && ref)
      && refs.planVersionRef === `plan-version:${session.planVersionId}` && refs.evaluationRef === `evaluation:${session.evaluationHash}`
      && refs.procedureRef === `execution-procedure:sha256:${sha256Json(stored.replayContext.procedure)}`
      && refs.procedureSafetyRef === `procedure-safety:${session.procedureSafetyHash}`
      && refs.evaluatorArtifactRef === `sha256:${stored.replayContext.dependencyContext?.evaluatorArtifactHash}`
      && stored.replayContext.procedure?.procedureId === session.procedureId
      && stored.replayContext.procedure?.inputEvaluationHash === session.evaluationHash
      && stored.replayContext.procedure?.procedureSafetyHash === session.procedureSafetyHash, "execution replay closure is invalid");
    const fromRef = `execution-session:${session.executionSessionId}`;
    context.nodes.push(fromRef, refs.procedureRef, refs.procedureSafetyRef); context.pointers.push(fromRef);
    for (const ref of required) context.edges.push(edge(fromRef, ref));
    for (const result of session.results) for (const id of result.observationIds ?? []) context.edges.push(edge(fromRef, `observation:${id}`));
    return;
  }
  if (record.rootLogicalPath === "rollback/manifest.json") {
    const body = without(record.value ?? {}, "checksum");
    invariant(record.value?.schemaVersion === "execution-rollback-manifest-v1" && Array.isArray(record.value.entries)
      && record.value.checksum === sha256Json(body), "execution rollback manifest is invalid");
    return;
  }
  if (record.rootLogicalPath.startsWith("rollback/") && record.rootLogicalPath.endsWith(".json")) {
    invariant(validEnvelope(record.value, "execution-rollback-v1", "execution-rollback"), "execution rollback record is invalid"); return;
  }
  if (record.rootLogicalPath.endsWith(".json")) throw new Error("execution repository contains an unrecognized JSON authority");
}

function validatePriceRecord(record, context) {
  const relative = record.rootLogicalPath;
  const domain = /^domain\/(captures|observations|history|targets|events|event-idempotency)\/([^/]+)\.json$/.exec(relative);
  if (domain) {
    const kind = ({ captures: "capture", observations: "observation", history: "history", targets: "target", events: "event", "event-idempotency": "event-idempotency" })[domain[1]];
    const value = record.value;
    invariant(object(value) && value.schemaVersion === "price-repository-v1" && value.kind === kind
      && Number.isInteger(value.revision) && value.revision >= 0 && value.payloadHash === sha256Json(value.payload)
      && value.checksum === sha256Json({ schemaVersion: value.schemaVersion, kind: value.kind, revision: value.revision, payloadHash: value.payloadHash, payload: value.payload }), "price domain envelope/hash is invalid");
    const payload = value.payload; const idField = ({ capture: "listingCaptureId", observation: "observationId", history: "historyPointId", target: "targetId", event: "eventId" })[kind];
    if (idField) invariant(payload?.[idField] === domain[2], "price domain path identity is invalid");
    if (kind === "capture") {
      invariant(payload.schemaVersion === "listing-capture-v1" && typeof payload.skuId === "string" && payload.skuId
        && Array.isArray(payload.variantIdentityFactIds) && payload.variantIdentityFactIds.length > 0
        && ["jd", "tmall", "taobao", "pdd", "official", "other_cn"].includes(payload.platform)
        && ["S1", "S2", "S3", "S4", "unknown"].includes(payload.sellerTier) && payload.condition === "new"
        && ["in_stock", "seller_claimed", "unknown"].includes(payload.stockStatus)
        && Number.isFinite(payload.priceCny) && payload.priceCny >= 0 && Number.isFinite(payload.comparableTotalCny)
        && payload.comparableTotalCny === payload.priceCny + (payload.shippingCny ?? 0)
        && /^https:\/\//.test(String(payload.canonicalUrl ?? "")) && iso(payload.capturedAt)
        && SHA256.test(String(payload.contentHash ?? "")), "price listing capture semantics are invalid");
    } else if (kind === "observation") {
      invariant(typeof payload.skuId === "string" && payload.skuId && Array.isArray(payload.variantIdentityFactIds) && payload.variantIdentityFactIds.length > 0
        && typeof payload.listingCaptureId === "string" && payload.condition === "new"
        && Number.isFinite(payload.priceCny) && payload.priceCny >= 0 && payload.comparableTotalCny === payload.priceCny + (payload.shippingCny ?? 0)
        && /^https:\/\//.test(String(payload.canonicalUrl ?? "")) && iso(payload.capturedAt), "price observation semantics are invalid");
    } else if (kind === "history") {
      invariant(typeof payload.skuId === "string" && payload.skuId && Array.isArray(payload.observationIds) && payload.observationIds.length > 0
        && payload.timeZone === "Asia/Shanghai" && payload.priceBasis === "comparable_total_cny" && payload.condition === "new"
        && payload.region === "CN" && payload.currency === "CNY" && SHA256.test(String(payload.policyHash ?? ""))
        && iso(payload.bucketStart) && iso(payload.bucketEnd) && Date.parse(payload.bucketStart) < Date.parse(payload.bucketEnd)
        && Number.isInteger(payload.sampleCount) && payload.sampleCount === payload.observationIds.length
        && Number.isFinite(payload.minCny) && Number.isFinite(payload.maxCny) && payload.maxCny >= payload.minCny, "price history semantics are invalid");
    } else if (kind === "target") {
      invariant(typeof payload.planId === "string" && payload.planId && typeof payload.skuId === "string" && payload.skuId
        && Array.isArray(payload.variantIdentityFactIds) && payload.variantIdentityFactIds.length > 0
        && Number.isFinite(payload.targetTotalCny) && payload.targetTotalCny >= 0 && typeof payload.enabled === "boolean"
        && ["watching", "met", "paused", "unavailable"].includes(payload.status)
        && (payload.enabled ? payload.status !== "paused" : payload.status === "paused")
        && SHA256.test(String(payload.revisionHash ?? "")) && iso(payload.updatedAt), "price target semantics are invalid");
    } else if (kind === "event") {
      const expectedKey = [payload.targetId, payload.targetRevisionHash, payload.priceSnapshotId, payload.transition]
        .map((part) => `${String(part).length}:${part}`).join("|");
      invariant(typeof payload.targetId === "string" && payload.targetId && SHA256.test(String(payload.targetRevisionHash ?? ""))
        && typeof payload.priceSnapshotId === "string" && payload.priceSnapshotId && iso(payload.occurredAt)
        && payload.idempotencyKey === expectedKey, "price target event semantics are invalid");
    } else if (kind === "event-idempotency") {
      invariant(payload?.schemaVersion === "price-event-idempotency-v1" && SHA256.test(String(payload.idempotencyHash ?? ""))
        && payload.idempotencyHash === domain[2] && typeof payload.eventId === "string" && SHA256.test(String(payload.eventHash ?? "")), "price event idempotency semantics are invalid");
    }
    const refs = { capture: `price-capture:${domain[2]}`, observation: `price-observation:${domain[2]}`, history: `price-history:${domain[2]}`, target: `price-target:${domain[2]}`, event: `price-target-event:${domain[2]}` };
    if (refs[kind]) context.nodes.push(refs[kind]);
    if (kind === "observation") context.edges.push(edge(refs.observation, `price-capture:${payload.listingCaptureId}`));
    if (kind === "history") for (const id of payload.observationIds ?? []) context.edges.push(edge(refs.history, `price-observation:${id}`));
    if (kind === "event") context.edges.push(edge(refs.event, `price-target:${payload.targetId}`));
    if (["history", "target"].includes(kind)) context.pointers.push(refs[kind]);
    return;
  }
  if (relative === "domain/rollback/manifest.json") {
    const value = record.value;
    invariant(value?.schemaVersion === "price-repository-v1" && value.kind === "rollback-manifest"
      && value.payloadHash === sha256Json(value.payload)
      && value.checksum === sha256Json({ schemaVersion: value.schemaVersion, kind: value.kind, revision: value.revision, payloadHash: value.payloadHash, payload: value.payload }), "price rollback manifest is invalid");
    return;
  }
  if (relative.startsWith("domain/rollback/") && relative.endsWith(".json")) {
    invariant(record.value?.schemaVersion === "price-repository-v1" && record.value.kind === "rollback"
      && record.value.payloadHash === sha256Json(record.value.payload), "price rollback record is invalid"); return;
  }
  if (relative.startsWith("domain/")) throw new Error("prices repository contains an unrecognized domain authority");
  const authority = assertPriceRuntimeAuthority(relative, record.value);
  if (authority.kind === "snapshot") {
    const ref = `price-snapshot:${authority.snapshotId}`;
    context.nodes.push(ref);
    if (authority.current) context.pointers.push(ref);
  } else if (authority.kind === "listing-capture") {
    context.nodes.push(`legacy-price-capture:${authority.listingCaptureId}`);
  } else if (authority.kind === "candidates") {
    for (const candidate of authority.candidates) {
      const ref = `price-candidate:${candidate.candidateId}`;
      context.nodes.push(ref);
      context.edges.push(edge(ref, `legacy-price-capture:${candidate.listingCaptureId}`));
    }
  }
}

function validatePriceRepositoryClosure(records, context) {
  const byPath = new Map(records.map((record) => [record.rootLogicalPath, record]));
  for (const record of records.filter((item) => /^candidates\/\d{4}-\d{2}-\d{2}\.json$/.test(item.rootLogicalPath))) {
    for (const candidate of record.value.candidates) {
      const capture = byPath.get(`listing-captures/${candidate.listingCaptureId}.json`);
      invariant(capture?.value?.contentHash === candidate.captureContentHash
        && capture.value.candidateId === candidate.candidateId,
      "runtime price candidate references a missing or hash-mismatched listing capture");
    }
  }
  const transactionsByTarget = new Map();
  for (const record of records.filter((item) => (item.rootLogicalPath.startsWith("rollback/")
    && item.rootLogicalPath.endsWith("-manifest.json")) || item.rootLogicalPath === "rollback/manifest.json")) {
    if (record.value?.schemaVersion !== "price-rollback-manifest-v2") continue;
    for (const entry of record.value.entries) {
      const entries = transactionsByTarget.get(entry.target) ?? [];
      entries.push(entry); transactionsByTarget.set(entry.target, entries);
      if (entry.backup === null) continue;
      const backup = byPath.get(entry.backup);
      invariant(backup && backup.sha256 === entry.previousHash, "runtime price rollback backup is missing or hash-mismatched");
      const manifestRef = `price-rollback-manifest:${record.rootLogicalPath}`;
      const backupRef = `price-rollback-bytes:${entry.backup}`;
      context.nodes.push(manifestRef, backupRef);
      context.edges.push(edge(manifestRef, backupRef, "optional_for_audit"));
    }
  }
  for (const [target, entries] of transactionsByTarget) {
    const current = byPath.get(target);
    if (!current) {
      invariant(entries.some((entry) => entry.previousHash === null), "runtime price rollback target is missing");
      continue;
    }
    const governedHashes = new Set(entries.flatMap((entry) => [entry.previousHash, entry.nextHash]).filter(Boolean));
    invariant(governedHashes.has(current.sha256), "runtime price rollback target diverges from its transactions");
  }
}

function validateCatalogOverlayRecord(record, context) {
  const authority = assertProductCatalogRuntimeAuthority(record.rootLogicalPath, record.value);
  if (authority.kind === "product-catalog") {
    const ref = `product-catalog:${authority.id}`;
    context.nodes.push(ref); context.pointers.push(ref);
  } else if (authority.kind === "catalog-drafts") {
    for (const id of authority.ids) context.nodes.push(`catalog-draft:${id}`);
  }
}

function validateDomainOverlayRecord(record, context) {
  if (record.rootLogicalPath === "official-domains.overlay.json") {
    assertOfficialDomainOverlayDocument(record.value, { label: "runtime official domain overlay" });
    context.nodes.push("official-domain-overlay:active");
    context.pointers.push("official-domain-overlay:active");
    return;
  }
  if (record.rootLogicalPath === "official-domains.json") {
    const registry = assertOfficialDomainRegistryDocument(record.value, "runtime materialized official domain registry");
    context.nodes.push(`official-domain-registry:${registry.version}`);
    context.pointers.push(`official-domain-registry:${registry.version}`);
    return;
  }
  if (record.rootLogicalPath === "proposals.json") {
    const document = assertDomainProposalDocument(record.value, "runtime domain proposal repository", { requirePortableTransactions: true });
    for (const proposal of document.proposals) {
      const ref = `official-domain-proposal:${proposal.proposalId}`;
      context.nodes.push(ref);
      if (proposal.trustStatus === "trusted") context.edges.push(edge(ref, "official-domain-overlay:active"));
    }
    return;
  }
  throw new Error("domain-overlays repository contains an unrecognized authority path");
}

function validateDomainOverlayClosure(records) {
  const byPath = new Map(records.map((record) => [record.rootLogicalPath, record]));
  const overlay = byPath.get("official-domains.overlay.json")?.value ?? null;
  const materialized = byPath.get("official-domains.json")?.value ?? null;
  const seedDocument = officialRegistryDocument(OFFICIAL_DOMAIN_REGISTRY);
  const merged = mergeOfficialRegistry(seedDocument, overlay);
  if (!materialized) {
    invariant((overlay?.brands?.length ?? 0) === 0, "runtime official domain registry materialization is missing for a non-empty overlay");
  } else {
    const persisted = assertOfficialDomainRegistryDocument(materialized, "runtime materialized official domain registry");
    invariant(persisted.version === merged.version, "runtime official domain registry diverges from seed + overlay");
  }
  const proposalFile = byPath.get("proposals.json")?.value;
  if (proposalFile) {
    const registry = materialized ? assertOfficialDomainRegistryDocument(materialized) : merged;
    for (const proposal of proposalFile.proposals.filter((entry) => entry.trustStatus === "trusted")) {
      invariant(registry.brands.some((brand) => [brand.brand, ...(brand.aliases ?? [])]
        .some((name) => name.toLocaleLowerCase() === proposal.brand.toLocaleLowerCase()) && brand.domains.includes(proposal.domain)),
      "trusted official-domain proposal is absent from the materialized registry");
    }
  }
}

function validateDomainAuditRecord(record, context) {
  const relative = record.rootLogicalPath;
  if (!relative.startsWith("rollback/domain/")) return false;
  const domainPath = relative.slice("rollback/domain/".length);
  if (domainPath === "official-registry-manifest.json") {
    const manifest = assertDomainApprovalManifest(record.value, { requirePortableTransactions: true });
    for (const transaction of manifest.transactions) context.nodes.push(`official-domain-approval:${transaction.transactionId}`);
    return true;
  }
  if (domainPath === "legacy-domain-migration.json") {
    assertDomainMigrationMarker(record.value);
    context.nodes.push("official-domain-migration:legacy-v1");
    return true;
  }
  if (/^domain-approval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/official-domains(?:\.overlay)?\.json\.bak$/.test(domainPath)) return true;
  throw new Error("domain rollback repository contains an unrecognized authority path");
}

async function validateDomainAuditClosure(records, context, activeRoot) {
  const manifestRecord = records.find((record) => record.rootLogicalPath === "rollback/domain/official-registry-manifest.json");
  if (!manifestRecord) return;
  const manifest = assertDomainApprovalManifest(manifestRecord.value, { requirePortableTransactions: true });
  const proposalPath = confined(activeRoot, "domain-overlays", "proposals.json");
  const proposalDocument = await readFile(proposalPath, "utf8").then((text) => JSON.parse(text)).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  invariant(proposalDocument, "official domain approval transaction has no proposal repository");
  assertDomainProposalDocument(proposalDocument, "runtime domain proposal repository", { requirePortableTransactions: true });
  const byPath = new Map(records.map((record) => [record.rootLogicalPath, record]));
  const outcomeByTarget = new Map();
  for (const transaction of manifest.transactions) {
    const proposal = proposalDocument.proposals.find((entry) => entry.proposalId === transaction.proposalId && entry.inputHash === transaction.proposalInputHash);
    invariant(proposal, "official domain approval transaction references a missing or changed proposal");
    if (transaction.status === "applied") {
      invariant(proposalDocument.events.some((event) => event.operation === "approved" && event.registryTransactionId === transaction.transactionId),
      "official domain approval transaction is missing its approval audit event");
    } else {
      invariant(proposalDocument.events.some((event) => event.operation === "rollback" && event.registryTransactionId === transaction.transactionId),
      "rolled-back official domain approval is missing its rollback audit event");
    }
    const transactionRef = `official-domain-approval:${transaction.transactionId}`;
    context.edges.push(edge(transactionRef, `official-domain-proposal:${transaction.proposalId}`));
    for (const file of transaction.files) {
      const backupPath = file.backup.slice("audit/".length);
      const backup = byPath.get(backupPath);
      invariant(backup && backup.sha256 === file.previousHash, "official domain approval backup is missing or hash-mismatched");
      const priorOutcome = outcomeByTarget.get(file.target);
      if (priorOutcome !== undefined) invariant(priorOutcome === file.previousHash, "official domain approval transaction hash chain is broken");
      outcomeByTarget.set(file.target, transaction.status === "applied" ? file.nextHash : file.previousHash);
      const backupRef = `official-domain-rollback-bytes:${file.backup}`;
      context.nodes.push(backupRef);
      context.edges.push(edge(transactionRef, backupRef, "optional_for_audit"));
    }
  }
  for (const [target, expectedHash] of outcomeByTarget) {
    const bytes = await readFile(confined(activeRoot, ...target.split("/"))).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    invariant(bytes && sha256Bytes(bytes) === expectedHash, "official domain approval target diverges from settled transaction history");
  }
}

function validateJobRecord(record, context, generation) {
  const relative = record.rootLogicalPath;
  if (/^records\/job-[a-f0-9]{64}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "job-store-envelope-v1", "background-job"), "job envelope is invalid");
    const job = record.value.payload;
    invariant(job.jobId === pathId(relative) && validateRuntimeBackgroundJob(job, { expectedRuntimeGeneration: generation }).length === 0, "job record is invalid");
    const fromRef = `job:${job.jobId}`; context.nodes.push(fromRef); context.pointers.push(fromRef);
    const necessity = ["succeeded", "failed", "cancelled", "dead_letter"].includes(job.status) ? "optional_for_audit" : "required_for_replay";
    context.edges.push(edge(fromRef, job.payloadRef, necessity));
    for (const id of job.dependencyJobIds) context.edges.push(edge(fromRef, `job:${id}`));
    if (job.checkpointRef) context.edges.push(edge(fromRef, job.checkpointRef, necessity));
    for (const ref of job.resultRefs) context.edges.push(edge(fromRef, ref, "optional_for_audit"));
    return;
  }
  if (/^idempotency\/[a-f0-9]{64}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "job-store-envelope-v1", "job-idempotency")
      && record.value.payload?.schemaVersion === "job-idempotency-v1", "job idempotency record is invalid"); return;
  }
  if (/^rollback\/job-[a-f0-9]{64}\/[0-9]{12}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "job-store-envelope-v1", "job-rollback"), "job rollback envelope is invalid");
    const value = record.value.payload;
    invariant(value?.schemaVersion === "job-rollback-v1" && value.toRevision === value.fromRevision + 1
      && value.previousChecksum === sha256Json(value.previous), "job rollback record is invalid"); return;
  }
  if (relative.startsWith("catalog-search/")) {
    validateCatalogJobRecord(record, context, generation); return;
  }
  if (relative.endsWith(".json")) throw new Error("jobs repository contains an unrecognized JSON authority");
}

function validateCatalogJobRecord(record, context, generation) {
  const relative = record.rootLogicalPath.slice("catalog-search/".length);
  const jobMatch = /^records\/(catalog-search-[a-f0-9]{20})\.json$/.exec(relative);
  const candidateMatch = /^candidates\/(catalog-candidate-[a-f0-9]{16})\.json$/.exec(relative);
  const expectedKind = jobMatch ? "catalog-search-job" : candidateMatch ? "catalog-search-candidate"
    : relative.startsWith("idempotency/") ? "catalog-search-idempotency"
      : relative.startsWith("rollback/candidates/") ? "catalog-search-candidate-rollback"
        : relative.startsWith("rollback/") ? "catalog-search-job-rollback" : null;
  invariant(expectedKind && validEnvelope(record.value, "catalog-search-store-envelope-v1", expectedKind), "catalog job record is invalid");
  if (jobMatch) {
    const job = record.value.payload?.job;
    invariant(job?.jobId === jobMatch[1] && validateRuntimeBackgroundJob(job, { expectedRuntimeGeneration: generation, jobIdPattern: /^catalog-search-[a-f0-9]{20}$/ }).length === 0, "catalog job payload is invalid");
    const fromRef = `job:${job.jobId}`; context.nodes.push(fromRef); context.pointers.push(fromRef);
    context.nodes.push(job.payloadRef);
    if (job.checkpointRef) context.nodes.push(job.checkpointRef);
    const necessity = ["succeeded", "failed", "cancelled", "dead_letter"].includes(job.status) ? "optional_for_audit" : "required_for_replay";
    context.edges.push(edge(fromRef, job.payloadRef, necessity));
    for (const id of job.dependencyJobIds) context.edges.push(edge(fromRef, `job:${id}`));
    if (job.checkpointRef) context.edges.push(edge(fromRef, job.checkpointRef, necessity));
    for (const ref of job.resultRefs) context.edges.push(edge(fromRef, ref, "optional_for_audit"));
    for (const id of record.value.payload.catalog?.candidateIds ?? []) context.edges.push(edge(fromRef, `catalog-candidate:${id}`, necessity));
  } else if (candidateMatch) {
    invariant(record.value.payload?.candidateId === candidateMatch[1], "catalog candidate path identity is invalid");
    context.nodes.push(`catalog-candidate:${candidateMatch[1]}`);
  } else if (expectedKind.endsWith("rollback")) {
    const value = record.value.payload;
    invariant(value?.toRevision === value.fromRevision + 1 && value.previousChecksum === sha256Json(value.previous), "catalog rollback record is invalid");
  }
}

function validateAgentRecord(record, context) {
  const relative = record.rootLogicalPath;
  const session = /^sessions\/([A-Za-z0-9._:-]{8,120})\.json$/.exec(relative);
  if (session) {
    const payload = record.value?.payload;
    invariant(record.value?.schemaVersion === "agent-session-v1" && record.value.contentHash === sha256Bytes(Buffer.from(JSON.stringify(payload), "utf8"))
      && payload?.id === session[1] && payload.contractVersion === "1.0.0" && Array.isArray(payload.messages), "Agent session envelope is invalid");
    const ref = `agent-session:${payload.id}`; context.nodes.push(ref); context.pointers.push(ref); return;
  }
  const audit = /^audit\/([A-Za-z0-9._:-]{8,120})\.json$/.exec(relative);
  if (audit) {
    invariant(record.value?.runId === audit[1] && record.value.recordHash === sha256Bytes(Buffer.from(canonicalJson(without(record.value, "recordHash")), "utf8")), "Agent audit record is invalid");
    context.nodes.push(`agent-audit:${audit[1]}`); return;
  }
  if (/^rollback\/(?:sessions|audit)-manifest\.json$/.test(relative)) {
    const unsigned = { schemaVersion: record.value?.schemaVersion, entries: record.value?.entries };
    invariant(record.value?.schemaVersion === "agent-rollback-v1" && Array.isArray(record.value.entries)
      && record.value.checksum === sha256Bytes(Buffer.from(JSON.stringify(unsigned), "utf8"))
      && record.value.entries.every((entry) => entry?.state === "committed"), "Agent rollback manifest is incomplete or invalid"); return;
  }
  if (relative.endsWith(".json")) throw new Error("Agent repository contains an unrecognized JSON authority");
}

function validateMigrationRecord(record) {
  if (!record.rootLogicalPath.endsWith(".json")) return;
  const value = record.value;
  invariant(object(value), "migration record is invalid");
  if (record.rootLogicalPath === "legacy-runtime-v1/manifest.json") {
    invariant(value.schemaVersion === "legacy-runtime-migration-v1" && value.migrationId === "legacy-runtime-v1" && value.status === "committed"
      && SHA256.test(String(value.manifestHash ?? "")) && value.manifestHash === sha256Json(without(value, "manifestHash")), "legacy runtime migration marker/hash is invalid");
    for (const field of ["sourceManifestHash", "sourceInventoryHash", "baseInventoryHash", "stagedInventoryHash"]) invariant(SHA256.test(String(value[field] ?? "")), "legacy runtime migration inventory binding is invalid");
    for (const collection of [value.copied, value.baseCopied]) invariant(Array.isArray(collection)
      && collection.every((entry) => typeof entry?.destinationLogicalPath === "string" && entry.destinationLogicalPath && SHA256.test(String(entry.sha256 ?? ""))), "legacy runtime migration copied inventory is invalid");
    return;
  }
  if (record.rootLogicalPath === "catalog-user-data-v1/quarantine/catalog-user-data.json") {
    invariant(validEnvelope(value, "catalog-user-data-quarantine-envelope-v1", "catalog-user-data-quarantine")
      && value.payload?.schemaVersion === "catalog-user-data-quarantine-v1"
      && value.payload.migrationId === "catalog-user-data-v1" && SHA256.test(String(value.payload.sourceCatalogHash ?? ""))
      && SHA256.test(String(value.payload.sanitizedOutputHash ?? "")) && value.payload.removedFieldCount === 23
      && Array.isArray(value.payload.entries) && value.payload.entries.length === 10, "catalog migration quarantine envelope is invalid");
    return;
  }
  // Quarantined legacy files are private leaves, never active authorities.
  // Their bytes remain covered by the provider manifest without being
  // reinterpreted under a current repository schema.
  if (record.rootLogicalPath.startsWith("quarantine/legacy-runtime-v1/")) return;
  throw new Error("migrations repository contains an unrecognized JSON record");
}

function validateTransactionRecord(record, context) {
  if (!record.rootLogicalPath.endsWith(".json")) throw new Error("transactions repository contains an unrecognized non-JSON authority");
  if (record.rootLogicalPath === "rollback/transactions-manifest.json") {
    const unsigned = { schemaVersion: record.value?.schemaVersion, entries: record.value?.entries };
    invariant(record.value?.schemaVersion === "transactions-rollback-v2" && Array.isArray(record.value.entries)
      && record.value.checksum === sha256Bytes(Buffer.from(JSON.stringify(unsigned), "utf8"))
      && record.value.entries.every((entry) => {
        if (!object(entry)) return false;
        const allowed = new Set(["id", "operation", "target", "previousHash", "nextHash", "state", "createdAt", "committedAt", "recoveredAt", "rolledBackAt"]);
        const safePath = (value) => typeof value === "string" && value && !path.posix.isAbsolute(value)
          && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
        return Object.keys(entry).every((key) => allowed.has(key))
          && typeof entry.id === "string" && entry.id && ["transaction-archive", "transaction-update", "transaction-image-delete", "transaction-delete"].includes(entry.operation)
          && safePath(entry.target)
          && (entry.previousHash === null || SHA256.test(String(entry.previousHash ?? ""))) && SHA256.test(String(entry.nextHash ?? ""))
          && ["committed", "rolled_back"].includes(entry.state) && iso(entry.createdAt)
          && (entry.committedAt === undefined || iso(entry.committedAt))
          && (entry.recoveredAt === undefined || iso(entry.recoveredAt))
          && (entry.rolledBackAt === undefined || iso(entry.rolledBackAt));
      }), "transaction rollback manifest is incomplete, private, or invalid"); return;
  }
  const receiptId = pathId(record.rootLogicalPath);
  let sanitized;
  try { sanitized = sanitizeTransactionRecordForPersistence(record.value, { legacy: false }); }
  catch { throw new Error("transaction archive strict persistence semantics are invalid"); }
  invariant(record.value?.schemaVersion === 2 && record.value.receiptId === receiptId
    && canonicalJson(record.value) === canonicalJson(sanitized), "transaction archive is not canonical or contains private/unknown fields");
  const ref = `transaction:${receiptId}`; context.nodes.push(ref);
  if (record.value.link?.linkStatus === "linked" && record.value.link.planId) context.edges.push(edge(ref, `plan:${record.value.link.planId}`, "optional_for_audit"));
}

function validateAuditRecord(record, context) {
  const relative = record.rootLogicalPath;
  if (relative === "runtime-reference-graph.json" || relative === "backup-runtime-snapshot.json") return;
  if (/^plan-agent-context\/[A-Za-z0-9._-]{1,180}\.json$/.test(relative)) {
    invariant(validEnvelope(record.value, "plan-agent-context-audit-envelope-v1", "plan-agent-context-audit")
      && record.value.payload?.runId === pathId(relative) && SHA256.test(String(record.value.payload?.contextHash ?? "")), "plan Agent context audit is invalid");
    const ref = `plan-agent-context:${record.value.payload.runId}`; context.nodes.push(ref);
    if (record.value.payload.planVersionId) context.edges.push(edge(ref, `plan-version:${record.value.payload.planVersionId}`, "optional_for_audit"));
    else if (record.value.payload.planId) context.edges.push(edge(ref, `plan:${record.value.payload.planId}`, "optional_for_audit"));
    if (record.value.payload.evaluationHash) { context.nodes.push(`evaluation:${record.value.payload.evaluationHash}`); context.edges.push(edge(ref, `evaluation:${record.value.payload.evaluationHash}`, "optional_for_audit")); }
    return;
  }
  if (/^advice-events\/\d{4}-\d{2}-\d{2}\.json$/.test(relative)) {
    invariant(record.value?.schemaVersion === "1.0.0" && Array.isArray(record.value.events), "advice audit event store is invalid");
    for (const event of record.value.events) {
      invariant(object(event) && event.eventType === "advice" && /^[A-Za-z0-9._:-]{8,120}$/.test(String(event.requestId ?? ""))
        && event.eventId === `advice-${sha256Json({ requestId: event.requestId })}` && event.provider === "deepseek"
        && typeof event.promptVersion === "string" && event.promptVersion && SHA256.test(String(event.inputHash ?? ""))
        && SHA256.test(String(event.engineHash ?? "")) && (event.responseHash === null || SHA256.test(String(event.responseHash ?? "")))
        && ["queued", "running", "completed", "disabled", "advice-unavailable", "paused_restore_review"].includes(event.status)
        && Array.isArray(event.validationErrors) && Array.isArray(event.calls) && iso(event.generatedAt), "advice audit event semantics are invalid");
      context.nodes.push(`advice-audit:${event.eventId}`);
    }
    return;
  }
  const adviceJob = /^advice-jobs\/([A-Za-z0-9._:-]{8,120})\.json$/.exec(relative);
  if (adviceJob) {
    const value = record.value;
    invariant(object(value) && value.requestId === adviceJob[1]
      && ["queued", "running", "completed", "disabled", "advice-unavailable", "paused_restore_review"].includes(value.status)
      && value.provider === "deepseek" && typeof value.promptVersion === "string" && value.promptVersion
      && SHA256.test(String(value.inputHash ?? "")) && SHA256.test(String(value.engineHash ?? ""))
      && object(value.deterministic) && Array.isArray(value.calls) && iso(value.generatedAt), "legacy advice job record is invalid");
    context.nodes.push(`advice-job:${value.requestId}`); return;
  }
  if (relative === "rollback/advice-manifest.json") {
    const unsigned = { schemaVersion: record.value?.schemaVersion, entries: record.value?.entries };
    invariant(record.value?.schemaVersion === "advice-rollback-v2" && Array.isArray(record.value.entries)
      && record.value.checksum === sha256Json(unsigned)
      && record.value.entries.every((entry) => entry?.state === "committed"), "advice rollback manifest is incomplete or invalid");
  }
}

async function validateRoot(root, records, context, activeRoot, generation) {
  if (root === "scenarios") {
    let catalog;
    try { catalog = loadMergedCatalogSync({ activeRoot, generationAware: true }); }
    catch (error) {
      throw new Error(`runtime product catalog authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    await validateScenarioRuntimeRecords(records, context, activeRoot, catalog);
    return;
  }
  let catalog;
  let evidence;
  if (root === "plans") {
    try { catalog = loadMergedCatalogSync({ activeRoot, generationAware: true }); }
    catch (error) {
      throw new Error(`runtime product catalog authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    evidence = evidenceAuthorityIndex(await recordsFor(activeRoot, "evidence"));
  }
  for (const record of records) {
    if (root === "plans") validatePlanRecord(record, context, records, catalog, evidence);
    else if (root === "evidence") await validateEvidenceRecord(record, context, activeRoot);
    else if (root === "attachments") validateAttachmentRecord(record, context);
    else if (root === "observations") validateObservationRecord(record, context);
    else if (root === "execution-sessions") validateExecutionRecord(record, context, generation);
    else if (root === "catalog-overlays") validateCatalogOverlayRecord(record, context);
    else if (root === "domain-overlays") validateDomainOverlayRecord(record, context);
    else if (root === "prices") validatePriceRecord(record, context);
    else if (root === "jobs") validateJobRecord(record, context, generation);
    else if (root === "agent") validateAgentRecord(record, context);
    else if (root === "transactions") validateTransactionRecord(record, context);
    else if (root === "audit") {
      if (!validateDomainAuditRecord(record, context)) validateAuditRecord(record, context);
    }
    else if (root === "migrations") validateMigrationRecord(record);
  }
  if (root === "attachments") {
    for (const record of records.filter((item) => item.rootLogicalPath.startsWith("metadata/") && item.value?.payload?.status === "available")) {
      const hash = record.value.payload.contentHash;
      const blob = records.find((item) => item.rootLogicalPath === `blobs/sha256/${hash.slice(0, 2)}/${hash}`);
      invariant(blob && blob.sha256 === hash, "attachment blob is missing or corrupt");
    }
  }
  if (root === "domain-overlays") validateDomainOverlayClosure(records);
  if (root === "audit") await validateDomainAuditClosure(records, context, activeRoot);
  if (root === "prices") validatePriceRepositoryClosure(records, context);
  if (root === "plans") validatePlanRepositoryClosure(records);
}

function genericSnapshot(root, records, context) {
  const rootRef = providerRootRef(root);
  const nodes = unique([rootRef, ...context.nodes]);
  const edges = [...context.edges, ...context.nodes.filter((node) => node !== rootRef).map((node) => edge(rootRef, node, "optional_for_audit"))];
  return {
    providerId: `${PROVIDER_PREFIX}${root}`,
    revision: records.reduce((maximum, record) => Math.max(maximum, Number.isInteger(record.value?.revision) ? record.value.revision : 0, Number.isInteger(record.value?.payload?.revision) ? record.value.payload.revision : 0), 0),
    manifestHash: sha256Json(records.map((record) => ({ logicalPath: record.rootLogicalPath, byteLength: record.bytes.length, sha256: record.sha256 }))),
    snapshotPointers: unique([rootRef, ...context.pointers]),
    nodes,
    edges: [...new Map(edges.map((value) => [canonicalJson(value), value])).values()].sort((left, right) => compare(canonicalJson(left), canonicalJson(right))),
  };
}

/** Returns the complete production provider set. Providers never write. */
export function createProductionReferenceProviders({ runtimeGeneration }) {
  invariant(Number.isInteger(runtimeGeneration) && runtimeGeneration > 0, "production reference providers require a runtime generation");
  return RUNTIME_REQUIRED_ROOTS.map((root) => ({
    async snapshotReferences(activeRoot) {
      const records = await recordsFor(activeRoot, root);
      const context = { nodes: [], edges: [], pointers: [] };
      await validateRoot(root, records, context, activeRoot, runtimeGeneration);
      if (root === "artifacts" && records.length) {
        const artifactRoot = confined(activeRoot, "artifacts");
        const repository = new FileArtifactRepository({ root: artifactRoot });
        const inspection = await repository.inspectAt(artifactRoot);
        invariant(inspection.ok, `artifact repository integrity failed: ${inspection.code ?? "unknown"}`);
        const snapshot = await repository.snapshotReferences(activeRoot);
        context.nodes.push(...snapshot.nodes); context.edges.push(...snapshot.edges); context.pointers.push(...snapshot.snapshotPointers);
      }
      const authoritativeRecords = root === "config" ? [] : root === "attachments"
        ? records.filter((record) => {
          const blob = /^blobs\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
          if (!blob) return true;
          return records.some((metadata) => metadata.rootLogicalPath.startsWith("metadata/")
            && metadata.value?.payload?.status === "available" && metadata.value.payload.contentHash === blob[1]);
        }) : records;
      return genericSnapshot(root, authoritativeRecords, context);
    },
  }));
}

export function verifyProductionReferenceGraph(graph, state) {
  const errors = verifyReferenceGraph(graph);
  if (graph?.compositionId !== PRODUCTION_REFERENCE_COMPOSITION_ID) errors.push("reference graph production composition id invalid");
  const actual = (graph?.providerSnapshots ?? []).map((snapshot) => snapshot.providerId).sort(compare);
  const expected = [...PRODUCTION_REFERENCE_PROVIDER_IDS].sort(compare);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) errors.push("reference graph production provider coverage incomplete");
  if (state && (graph?.runtimeGeneration !== state.runtimeGeneration || graph?.runtimeRevision !== state.revision)) errors.push("reference graph generation/revision binding mismatch");
  return errors;
}

/** Builds the production graph while an outer coordinator barrier is held. */
export async function createProductionReferenceGraphAtSnapshot({ state, activeRoot, now = () => new Date().toISOString() }) {
  const providers = createProductionReferenceProviders({ runtimeGeneration: state.runtimeGeneration });
  const requiredRoots = RUNTIME_REQUIRED_ROOTS.map(providerRootRef);
  const graph = await createReferenceGraphAtSnapshot({ state, activeRoot, providers, requiredRoots, now });
  const base = { ...graph, compositionId: PRODUCTION_REFERENCE_COMPOSITION_ID, graphHash: undefined };
  const withComposition = { ...base, graphHash: portableReferenceGraphHash(base) };
  const errors = verifyProductionReferenceGraph(withComposition, state);
  if (errors.length) throw new Error(errors.join("; "));
  return withComposition;
}

export async function createProductionReferenceGraph({ coordinator, now }) {
  if (!coordinator) throw new TypeError("production reference graph requires a coordinator");
  return (await coordinator.withConsistentSnapshot(({ state, activeRoot }) => createProductionReferenceGraphAtSnapshot({ state, activeRoot, now }))).result;
}

/**
 * Persists an audit copy bound to the revision committed by this very write.
 * The graph file itself is excluded from the audit provider inventory, which
 * avoids a self-referential hash while preserving exact generation fencing.
 */
export async function persistProductionReferenceGraph({ coordinator, now }) {
  if (!coordinator) throw new TypeError("production reference graph persistence requires a coordinator");
  const written = await coordinator.withWrite(async ({ state, activeRoot }) => {
    const committedState = { ...state, revision: state.revision + 1 };
    const graph = await createProductionReferenceGraphAtSnapshot({ state: committedState, activeRoot, now });
    await atomicWriteJson(confined(activeRoot, "audit", "runtime-reference-graph.json"), graph);
    return graph;
  });
  invariant(written.result.runtimeGeneration === written.state.runtimeGeneration
    && written.result.runtimeRevision === written.state.revision, "persisted reference graph state binding failed");
  return written.result;
}

/** Validates a restored/staged runtime root without mutating or fencing jobs. */
export async function validateProductionRuntimeRoot({ state, activeRoot, now }) {
  const graph = await createProductionReferenceGraphAtSnapshot({ state, activeRoot, now });
  const errors = verifyProductionReferenceGraph(graph, state);
  if (errors.length) throw new Error(errors.join("; "));
  return graph;
}
