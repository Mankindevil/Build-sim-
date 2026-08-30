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
import {
  governedAgentProposalReferencesRuntime,
  stagedUploadReferencesRuntime,
  validateGovernedAgentProposalEnvelopeRuntime,
  validateStagedUploadEnvelopeRuntime,
} from "../attachments/runtime-validation.mjs";
import { validateRuntimeBackgroundJob } from "../jobs/runtime-validation.mjs";
import {
  thirdPartyClaimCandidateReferencesRuntime,
  validateThirdPartyClaimCandidateEnvelopeRuntime,
  validateThirdPartyClaimCandidateRuntime,
} from "../evidence/third-party-claim-candidate-runtime.mjs";
import {
  thirdPartyClaimPromotionReferencesRuntime,
  validateThirdPartyClaimPromotionRuntime,
} from "../evidence/third-party-promotion-runtime.mjs";
import {
  officialClaimPromotionReferencesRuntime,
  validateOfficialClaimPromotionRuntime,
} from "../evidence/official-promotion-runtime.mjs";
import {
  evidenceBindingProposalReferencesRuntime,
  validateEvidenceBindingProposalEnvelopeRuntime,
  validateEvidenceBindingProposalRecordRuntime,
} from "../evidence/binding-proposal-runtime.mjs";
import { validateScenarioRuntimeRecords } from "../scenarios/runtime-validation.mjs";
import {
  validateImmutableListingCaptureRuntime,
  validateJobScheduleRuntime,
  validatePriceHistoryClosureRuntime,
  validatePriceHistoryPointRuntime,
  validatePriceObservationClosureRuntime,
  validatePriceObservationRuntime,
  validatePriceTargetEventRuntime,
  validatePriceTargetRuntime,
} from "../price/runtime.mjs";
import {
  hashPlanConfigRuntime,
  migrationCatalogProjectionRuntime,
  validatePlanEvidenceBindingRuntime,
  validatePlanIdempotencyRuntime,
  validatePlanEvaluationLockRuntime,
  validatePlanRuntime,
  validatePlanVersionRuntime,
} from "../plans/canonical-runtime.mjs";
import {
  planAgentRunContextAuditReferencesRuntime,
  validatePlanAgentRunContextAuditEnvelopeRuntime,
} from "../plans/agent-context-audit-runtime.mjs";
import {
  validateAgentWriteApprovalArtifactClosureRuntime,
  validateAgentWriteApprovalArtifactRuntime,
  validateAgentWriteApprovalBindingClosureRuntime,
} from "../agent/write-approval-runtime.mjs";
import {
  hydrateProvisionalCaseAdapterCandidateArtifactRuntime,
  hydrateRuntimeCaseAdapterRegistryArtifactRuntime,
  provisionalCaseAdapterCandidateReferencesRuntime,
  runtimeCaseAdapterRegistryReferencesRuntime,
} from "../adapters/provisional-runtime.mjs";
import { validateProvisionalCaseAdapterProductionClosureAtRoot } from "../adapters/provisional-production-closure.mjs";
import { validateSolverProductionClosureAtRoot } from "../solver/production-closure.mjs";
import { validateRecommendationProductionClosureAtRoot } from "../recommendation/production-closure.mjs";
import {
  validateWorkspaceCaseAdapterSnapshotRuntime,
  workspaceCaseAdapterSnapshotReferencesRuntime,
} from "../adapters/artifact-runtime.mjs";
import {
  projectProgressivePriceRuntime,
  validateProgressiveBuildEvaluationAuthorityRuntime,
} from "../compatibility/runtime.mjs";
import { validateWorkspaceSystemProfilePayloadRuntime } from "../system-profiles/runtime.mjs";
import {
  destructiveActionPlanReferencesRuntime,
  validateDestructiveActionPlanShapeRuntime,
} from "../storage/destructive-action-runtime.mjs";
import {
  evaluationSnapshotLockClosureRuntime,
  evaluationTargetKeyRuntime,
  validateArtifactLockfileRuntime,
  validateAuthoritativeEvaluationReceiptRuntime,
  validateEvaluationArtifactInputRuntime,
  validateEvaluationCurrentPointerRuntime,
  validateEvaluationExternalRuntime,
  validateEvaluationLockEnvelopeRuntime,
} from "../plans/evaluation-lock-runtime.mjs";
import { validateResolvedPlanCatalogBindingsRuntime } from "../config/v3-catalog-runtime.mjs";
import {
  factsRuntimeSubjectMatchesClaim,
  factsRuntimeSubjectMatchesObservation,
  legacySha256Runtime,
  parseObservationReferenceRuntime,
  runtimeRecord as factRuntimeRecord,
  validateConflictSetRuntime,
  validateFactRecordRuntime,
  validateFactSnapshotRuntime,
  validateReplayableInferenceTraceRuntime,
  validateUpdateDecisionMemoryRuntime,
  validateUpdateDecisionRuntime,
  verifyConflictSetRuntime,
  verifyFactRecordRuntime,
  verifyFactSnapshotRuntime,
  verifyReplayableInferenceTraceRuntime,
  verifyUpdateDecisionRuntime,
  selectedFactSnapshotRefRuntime,
} from "../facts/canonical-runtime.mjs";
import {
  validateFactUpdateEvaluationDiffRuntime,
  validateFactUpdateConflictPointerRuntime,
  validateFactUpdateDecisionTransactionRuntime,
  validateFactUpdatePlanPointerClosureRuntime,
  validateFactUpdatePlanPointerRuntime,
  validateUpdateDecisionFactClosureRuntime,
  verifyFactUpdateEvaluationDiffRuntime,
  verifyFactUpdateDecisionTransactionRuntime,
} from "../facts/update-evaluation-runtime.mjs";
import {
  validateFactUpdateNoticeClosureRuntime,
  validateFactUpdateNoticeRuntime,
  verifyFactUpdateNoticeRuntime,
} from "../facts/update-notice-runtime.mjs";
import {
  inferenceCandidateReferencesRuntime,
  validateFactInferenceCandidateEnvelopeRuntime,
  validateInferenceApprovalEnvelopeRuntime,
} from "../facts/inference-candidate-runtime.mjs";
import { inspectGovernedInferenceArtifactAtRoot } from "../facts/inference-artifact-authority.mjs";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
  validateEvidenceCaptureRuntime,
  validateEvidenceClaimRuntime,
  validateEvidenceDocumentRuntime,
  validateEvidenceRepositoryEnvelopeRuntime,
  validateEvidenceUrlIndexRuntime,
  verifyEvidenceClaimRuntime,
} from "../evidence/claim-runtime.mjs";
import {
  officialClaimCandidateReferencesRuntime,
  validateOfficialClaimCandidateEnvelopeRuntime,
  validateOfficialClaimCandidateRuntime,
} from "../evidence/claim-candidate-runtime.mjs";
import {
  currentObservationIdsRuntime,
  validateObservationSupersessionRuntime,
  validateUserObservationRuntime,
  validateUserObservationSnapshotRuntime,
  verifyUserObservationRuntime,
  verifyUserObservationSnapshotRuntime,
} from "../observations/canonical-runtime.mjs";
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
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FACT_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const ATTACHMENT_PLAN_ID = /^[-a-zA-Z0-9._]{1,160}$/;
const PROVIDER_PREFIX = "runtime/";

export const PRODUCTION_REFERENCE_COMPOSITION_ID = "buildsim-runtime-reference-composition-v1";
export const PRODUCTION_REFERENCE_PROVIDER_IDS = Object.freeze(RUNTIME_REQUIRED_ROOTS.map((root) => `${PROVIDER_PREFIX}${root}`));

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
const GENERIC_ADAPTER_SNAPSHOT_FIELDS = Object.freeze([
  "caseManifests", "runtimeModels", "runtimeAdapters", "capabilityProviderManifests",
  "capabilityProviderRuntimes", "runtimeRegistry",
]);
function claimsGenericAdapterSnapshot(value) {
  return object(value) && GENERIC_ADAPTER_SNAPSHOT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}
function exactObjectFields(value, fields) {
  return object(value) && Object.keys(value).length === fields.length
    && Object.keys(value).every((field) => fields.includes(field));
}
function validLegacyWorkspaceAdapterSnapshot(value) {
  if (!exactObjectFields(value, ["schemaVersion", "catalog", "sources"])
    || value.schemaVersion !== "workspace-adapter-snapshot-v1"
    || !object(value.catalog) || typeof value.catalog.schemaVersion !== "string" || !value.catalog.schemaVersion
    || !Array.isArray(value.catalog.skus)
    || value.catalog.skus.some((sku) => !object(sku) || typeof sku.id !== "string" || !sku.id
      || typeof sku.category !== "string" || !sku.category || typeof sku.name !== "string" || !sku.name)
    || !Array.isArray(value.sources) || value.sources.length < 1
    || value.sources.some((source) => !exactObjectFields(source, ["moduleId", "bytes"])
      || typeof source.moduleId !== "string" || !source.moduleId || typeof source.bytes !== "string" || !source.bytes)) return false;
  return new Set(value.sources.map((source) => source.moduleId)).size === value.sources.length;
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function unique(values) { return [...new Set(values)].sort(compare); }
function edge(fromRef, toRef, necessity = "required_for_replay") { return { fromRef, toRef, necessity }; }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function validEnvelope(value, schemaVersion, kind) {
  return object(value) && value.schemaVersion === schemaVersion && value.kind === kind
    && Object.prototype.hasOwnProperty.call(value, "payload") && value.checksum === sha256Json(value.payload);
}
/** ObservationRepository predates domain hashes and intentionally uses legacy canonical JSON. */
function validLegacyEnvelope(value, schemaVersion, kind) {
  return object(value) && value.schemaVersion === schemaVersion && value.kind === kind
    && Object.prototype.hasOwnProperty.call(value, "payload") && value.checksum === legacySha256Runtime(value.payload);
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
    if (versionId !== projection.sourceVersionId || !projection.migratedCoolerComponent) return issues;
    return issues.filter((issue) => {
      if (issue.path === "selection.coolerId") return false;
      const bom = /^bom\.(\d+)\.skuId$/.exec(issue.path);
      return !bom || config.bom?.[Number(bom[1])]?.skuId !== projection.sourceCoolerSkuId;
    });
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
    const document = /^documents\/([a-f0-9]{2})\/(doc-sha256-([a-f0-9]{64}))\.json$/.exec(record.rootLogicalPath);
    if (document && validateEvidenceRepositoryEnvelopeRuntime(record.value, "evidence-document").length === 0
      && validateEvidenceDocumentRuntime(record.value.payload).length === 0
      && record.value.payload.id === document[2] && document[1] === document[3].slice(0, 2)) documents.set(document[2], record.value.payload);
    const capture = /^captures\/([a-f0-9]{2})\/(capture-sha256-([a-f0-9]{64}))\.json$/.exec(record.rootLogicalPath);
    if (capture && validateEvidenceRepositoryEnvelopeRuntime(record.value, "evidence-capture").length === 0
      && validateEvidenceCaptureRuntime(record.value.payload).length === 0
      && record.value.payload.id === capture[2] && capture[1] === capture[3].slice(0, 2)) captures.set(capture[2], record.value.payload);
  }
  return { documents, captures };
}

function evidenceClaimAuthorityIndex(records) {
  const claims = new Map();
  for (const record of records) {
    const match = /^claims\/[a-f0-9]{2}\/(claim-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match || !validEnvelope(record.value, "evidence-claim-envelope-v1", "evidence-claim")) continue;
    const claim = record.value.payload;
    const keys = Object.keys(record.value).sort().join(",");
    const thirdPartyAuthorityValid = claim?.authority === "third_party" && (
      keys === "authorityChecksum,checksum,kind,payload,schemaVersion,thirdPartyPromotion"
      && validateThirdPartyClaimPromotionRuntime(record.value.thirdPartyPromotion).length === 0
      && record.value.authorityChecksum === sha256Json({ claim, promotion: record.value.thirdPartyPromotion })
    );
    const officialAuthorityValid = claim?.authority === "official" && (
      (keys === "authorityChecksum,checksum,kind,officialPromotion,payload,schemaVersion"
        && validateOfficialClaimPromotionRuntime(record.value.officialPromotion).length === 0
        && record.value.authorityChecksum === sha256Json({ claim, promotion: record.value.officialPromotion }))
      || keys === "checksum,kind,payload,schemaVersion"
    );
    if ((thirdPartyAuthorityValid || officialAuthorityValid) && claim?.claimId === match[1]
      && validateEvidenceClaimRuntime(claim).length === 0 && verifyEvidenceClaimRuntime(claim)) claims.set(match[1], claim);
  }
  return claims;
}

function thirdPartyPromotionForClaim(records, claimId) {
  const record = records.find((candidate) => candidate.rootLogicalPath.endsWith(`/${claimId}.json`));
  return record?.value?.thirdPartyPromotion ?? null;
}

function officialPromotionForClaim(records, claimId) {
  const record = records.find((candidate) => candidate.rootLogicalPath.endsWith(`/${claimId}.json`));
  return record?.value?.officialPromotion ?? null;
}

function evidenceClaimCandidateAuthorityIndex(records) {
  const candidates = new Map();
  for (const record of records) {
    const match = /^claim-candidates\/[a-f0-9]{2}\/(claim-candidate-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match || validateOfficialClaimCandidateEnvelopeRuntime(record.value, match[1]).length) continue;
    const candidate = record.value.payload;
    if (validateOfficialClaimCandidateRuntime(candidate).length === 0) candidates.set(match[1], candidate);
  }
  return candidates;
}

function thirdPartyClaimCandidateAuthorityIndex(records) {
  const candidates = new Map();
  for (const record of records) {
    const match = /^third-party-claim-candidates\/[a-f0-9]{2}\/(third-party-claim-candidate-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match || validateThirdPartyClaimCandidateEnvelopeRuntime(record.value, match[1]).length) continue;
    const candidate = record.value.payload;
    if (validateThirdPartyClaimCandidateRuntime(candidate).length === 0) candidates.set(match[1], candidate);
  }
  return candidates;
}

function evidenceBindingProposalAuthorityIndex(records) {
  const proposals = new Map();
  for (const record of records) {
    const match = /^binding-proposals\/[a-f0-9]{2}\/(evidence-binding-proposal-sha256-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match || validateEvidenceBindingProposalEnvelopeRuntime(record.value, match[1]).length) continue;
    const proposal = record.value.payload;
    if (validateEvidenceBindingProposalRecordRuntime(proposal).length === 0) proposals.set(match[1], proposal);
  }
  return proposals;
}

function planAgentContextAuditAuthorityIndex(records) {
  const audits = new Map();
  for (const record of records) {
    const match = /^plan-agent-context\/([A-Za-z0-9][A-Za-z0-9._:-]{7,119})\.json$/.exec(record.rootLogicalPath);
    if (!match || validatePlanAgentRunContextAuditEnvelopeRuntime(record.value, match[1]).length) continue;
    audits.set(match[1], record.value.payload);
  }
  return audits;
}

function artifactJsonAuthorityIndex(records) {
  const blobs = new Map(); const values = new Map();
  for (const record of records) {
    const match = /^blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
    if (match && match[1] === match[2].slice(0, 2) && record.sha256 === match[2]) blobs.set(match[2], record);
  }
  for (const record of records) {
    const match = /^metadata\/([a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match) continue;
    const envelope = record.value; const artifact = envelope?.record; const blob = blobs.get(match[1]);
    if (!blob || envelope?.schemaVersion !== "artifact-metadata-envelope-v1"
      || envelope.checksum !== sha256Json(artifact) || artifact?.schemaVersion !== "artifact-record-v1"
      || artifact.ref !== `sha256:${match[1]}` || artifact.sha256 !== match[1]
      || artifact.byteLength !== blob.bytes.length) continue;
    try { values.set(artifact.ref, JSON.parse(blob.bytes.toString("utf8"))); } catch { /* non-JSON artifact */ }
  }
  return values;
}

function hasApprovalJobCheckpoint(records, approval) {
  const jobs = [];
  for (const record of records) {
    if (/^records\/job-[a-f0-9]{64}\.json$/.test(record.rootLogicalPath)
      && validEnvelope(record.value, "job-store-envelope-v1", "background-job")) jobs.push(record.value.payload);
    if (/^rollback\/job-[a-f0-9]{64}\/[0-9]{12}\.json$/.test(record.rootLogicalPath)
      && validEnvelope(record.value, "job-store-envelope-v1", "job-rollback")) jobs.push(record.value.payload?.previous);
  }
  return jobs.some((job) => object(job) && job.jobId === approval.jobId
    && job.type === "agent.run" && job.handlerVersion === "1"
    && job.idempotencyKey === `agent-run:${approval.runId}`
    && job.runtimeGeneration === approval.runtimeGeneration
    && job.status === "running" && job.checkpointRef === approval.confirmedAuthorityRef
    && typeof job.leaseToken === "string" && job.leaseToken.length > 0
    && iso(job.leaseExpiresAt));
}

function validPromotionApprovalInput(promotion, pending) {
  const input = pending?.pending?.call?.input;
  if (!object(input)) return false;
  const keys = Object.keys(input).sort().join(",");
  if (promotion.approval.toolName === "archive_official_evidence") {
    return keys === "candidateId" && input.candidateId === promotion.candidateId;
  }
  if (promotion.approval.toolName !== "propose_fact_update"
    || !["claimCandidateId,intent", "claimCandidateId,intent,targetFactId"].includes(keys)
    || input.claimCandidateId !== promotion.candidateId
    || !["create", "replace", "withdraw"].includes(input.intent)) return false;
  return input.targetFactId === undefined || FACT_STORAGE_ID.test(String(input.targetFactId));
}

function validatePromotionApprovalPlanContext(promotion, candidate, planContextAudits, artifactValues, jobRecords) {
  const approval = promotion.approval;
  const audit = planContextAudits.get(approval.runId);
  const confirmed = artifactValues.get(approval.confirmedAuthorityRef);
  const pending = artifactValues.get(approval.pendingRef);
  invariant(audit
    && audit.runId === approval.runId
    && audit.sessionId === approval.sessionId
    && audit.planId === promotion.planId
    && audit.contextHash === approval.planContextHash
    && audit.configHash === candidate.planConfigHash
    && audit.draftRevision === candidate.planDraftRevision
    && Date.parse(audit.recordedAt) <= Date.parse(approval.issuedAt),
  "evidence claim promotion reviewed approval plan context is missing, cross-plan, or stale");
  invariant(validateAgentWriteApprovalBindingClosureRuntime(approval, confirmed, pending).length === 0
    && validPromotionApprovalInput(promotion, pending)
    && hasApprovalJobCheckpoint(jobRecords, approval),
  "evidence claim promotion reviewed approval artifact/input closure is invalid");
}

/** Immutable fact records are indexed here for migration closure checks. */
function factAuthorityIndex(records) {
  const facts = new Map();
  for (const record of records) {
    const match = /^records\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\.json$/.exec(record.rootLogicalPath);
    if (!match || !validEnvelope(record.value, "fact-repository-envelope-v1", "fact")) continue;
    const stored = record.value.payload;
    if (stored?.schemaVersion !== "fact-repository-v1" || stored.revision !== 0 || stored.fact?.factId !== match[1]
      || stored.recordHash !== sha256Json(stored.fact) || validateFactRecordRuntime(stored.fact).length || !verifyFactRecordRuntime(stored.fact)) continue;
    facts.set(match[1], stored.fact);
  }
  return facts;
}

function catalogMigrationClaimIds(records) {
  const record = records.find((candidate) => candidate.rootLogicalPath === "catalog-facts-v1/manifest.json");
  if (!record) return new Set();
  const manifest = record.value;
  invariant(object(manifest) && manifest.schemaVersion === "catalog-facts-v1-manifest"
    && manifest.migrationId === "catalog-facts-v1" && ["applied", "rolled_back"].includes(manifest.status)
    && SHA256.test(String(manifest.manifestHash ?? ""))
    && manifest.manifestHash === sha256Json(without(manifest, "manifestHash"))
    && Array.isArray(manifest.claims)
    && manifest.claims.every((entry) => object(entry) && /^claim-sha256-[a-f0-9]{64}$/.test(String(entry.claimId ?? ""))
      && SHA256.test(String(entry.contentHash ?? "")) && entry.claimId === `claim-sha256-${entry.contentHash}`),
  "catalog facts migration claim inventory is invalid");
  return new Set(manifest.claims.map((entry) => entry.claimId));
}

function validateEvidenceRepositoryClosure(records, context, migrationRecords = [], auditRecords = [], artifactRecords = [], jobRecords = []) {
  const { documents, captures } = evidenceAuthorityIndex(records);
  const claims = evidenceClaimAuthorityIndex(records);
  const candidates = evidenceClaimCandidateAuthorityIndex(records);
  const thirdPartyCandidates = thirdPartyClaimCandidateAuthorityIndex(records);
  const planContextAudits = planAgentContextAuditAuthorityIndex(auditRecords);
  const artifactValues = artifactJsonAuthorityIndex(artifactRecords);
  const legacyMigrationClaimIds = catalogMigrationClaimIds(migrationRecords);
  const bindingProposals = evidenceBindingProposalAuthorityIndex(records);
  const byPath = new Map(records.map((record) => [record.rootLogicalPath, record]));
  const replacements = new Set();
  for (const capture of captures.values()) {
    invariant(documents.get(capture.documentId)?.id === capture.documentId,
      "evidence capture document closure is missing or cross-document");
  }
  for (const record of records) {
    const match = /^source-index\/([a-f0-9]{2})\/([a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match) continue;
    const index = record.value?.payload;
    const capture = captures.get(index?.captureId);
    invariant(capture && capture.documentId === index.documentId && capture.retrievedAt === index.retrievedAt
      && [capture.requestedUrl, capture.finalUrl, capture.canonicalUrl].includes(index.url)
      && sha256Bytes(Buffer.from(index.url, "utf8")) === match[2] && match[1] === match[2].slice(0, 2),
    "evidence URL index closure is missing, stale, or mismatched");
    context.edges.push(edge(`evidence-url-index:${match[2]}`, `evidence-capture:${capture.id}`, "optional_for_audit"));
  }
  // Source-index replacement is the one mutable EvidenceRepository write.
  // Its rollback journal is not an authority source, but it must faithfully
  // account for every replaced index byte stream: otherwise a checksum-valid
  // forged backup could conceal an interrupted or truncated replacement.
  for (const manifestRecord of records.filter((record) => record.rootLogicalPath === ".rollback/manifest.json")) {
    const seenEvents = new Set(); const latestByTarget = new Map();
    for (const entry of manifestRecord.value.entries) {
      invariant(!seenEvents.has(entry.eventId), "evidence rollback manifest contains duplicate event IDs");
      seenEvents.add(entry.eventId); latestByTarget.set(entry.target, entry);
      if (entry.previousHash === null) {
        invariant(entry.backup === null, "evidence rollback manifest initial replacement unexpectedly has a backup");
      } else {
        const backup = byPath.get(entry.backup);
        invariant(backup && backup.sha256 === entry.previousHash,
          "evidence rollback backup is missing or hash-mismatched");
        context.edges.push(edge(`evidence-rollback:${entry.eventId}`, `evidence-rollback-bytes:${entry.backup}`, "optional_for_audit"));
      }
      context.nodes.push(`evidence-rollback:${entry.eventId}`);
    }
    for (const [target, entry] of latestByTarget) {
      const current = byPath.get(target);
      invariant(current && current.sha256 === entry.nextHash,
        "evidence rollback manifest current source index is missing or hash-mismatched");
      context.edges.push(edge(`evidence-rollback:${entry.eventId}`, `evidence-url-index:${pathId(target)}`, "optional_for_audit"));
    }
  }
  for (const claim of claims.values()) {
    const document = documents.get(claim.source.documentId);
    const capture = captures.get(claim.source.captureId);
    invariant(document?.id === claim.source.documentId && document.sha256 === claim.source.documentSha256,
      "evidence claim document closure is missing or hash-mismatched");
    invariant(capture?.id === claim.source.captureId && capture.documentId === document?.id,
      "evidence claim capture closure is missing or cross-document");
    const identity = Array.isArray(capture.productIdentities)
      ? capture.productIdentities.find((candidate) => evidenceIdentityMatchesClaimSubjectRuntime(candidate, claim.subject, claim.scope)) : null;
    invariant(identity, "evidence claim exact governed product identity is unavailable");
    if (claim.authority === "official") invariant(identity.basis === "official-document-explicit",
      "official evidence claim lacks explicit official product identity");
    if (claim.authority === "third_party") invariant(identity.basis === "third-party-document-explicit",
      "third-party evidence claim lacks an approved explicit third-party product identity");
    if (claim.authority === "third_party") {
      const promotion = thirdPartyPromotionForClaim(records, claim.claimId);
      const candidate = thirdPartyCandidates.get(promotion?.candidateId);
      const candidateClaimMaterial = candidate ? { ...candidate.claim, source: { ...candidate.claim.source, captureId: claim.source.captureId } } : null;
      if (candidateClaimMaterial) { delete candidateClaimMaterial.claimId; delete candidateClaimMaterial.contentHash; }
      const activeClaimMaterial = { ...claim }; delete activeClaimMaterial.claimId; delete activeClaimMaterial.contentHash;
      invariant(promotion && validateThirdPartyClaimPromotionRuntime(promotion).length === 0
        && promotion.activeClaimId === claim.claimId && promotion.activeClaimHash === claim.contentHash
        && promotion.promotedCaptureId === claim.source.captureId
        && candidate && candidate.contentHash === promotion.candidateHash && candidate.planId === promotion.planId
        && candidate.originalCaptureId === promotion.originalCaptureId
        && candidate.assessment.assessmentId === promotion.assessmentId
        && candidate.assessment.contentHash === promotion.assessmentHash
        && canonicalJson(candidateClaimMaterial) === canonicalJson(activeClaimMaterial),
      "third-party evidence claim lacks immutable candidate/assessment promotion authority");
      validatePromotionApprovalPlanContext(promotion, candidate, planContextAudits, artifactValues, jobRecords);
      const promotionRef = `evidence-third-party-promotion:${promotion.promotionId}`;
      context.nodes.push(promotionRef); context.pointers.push(promotionRef);
      const references = thirdPartyClaimPromotionReferencesRuntime(promotion);
      invariant(references, "third-party claim promotion references are invalid");
      for (const reference of references) context.edges.push(edge(promotionRef, reference.ref, reference.necessity));
    }
    if (claim.authority === "official") {
      const promotion = officialPromotionForClaim(records, claim.claimId);
      if (promotion) {
        const candidate = candidates.get(promotion.candidateId);
        const candidateClaimMaterial = candidate ? { ...candidate.claim, source: { ...candidate.claim.source, captureId: claim.source.captureId } } : null;
        if (candidateClaimMaterial) { delete candidateClaimMaterial.claimId; delete candidateClaimMaterial.contentHash; }
        const activeClaimMaterial = { ...claim }; delete activeClaimMaterial.claimId; delete activeClaimMaterial.contentHash;
        invariant(validateOfficialClaimPromotionRuntime(promotion).length === 0
          && promotion.activeClaimId === claim.claimId && promotion.activeClaimHash === claim.contentHash
          && promotion.promotedCaptureId === claim.source.captureId
          && candidate && candidate.contentHash === promotion.candidateHash && candidate.planId === promotion.planId
          && candidate.originalCaptureId === promotion.originalCaptureId
          && candidate.promotion.confirmationId === promotion.confirmationId
          && candidate.promotionInput.confirmation.confirmationId === promotion.confirmationId
          && candidate.promotionInput.confirmation.contentHash === promotion.confirmationHash
          && canonicalJson(candidateClaimMaterial) === canonicalJson(activeClaimMaterial),
        "official evidence claim lacks immutable candidate/confirmation promotion authority");
        validatePromotionApprovalPlanContext(promotion, candidate, planContextAudits, artifactValues, jobRecords);
        const promotionRef = `evidence-official-promotion:${promotion.promotionId}`;
        context.nodes.push(promotionRef); context.pointers.push(promotionRef);
        const references = officialClaimPromotionReferencesRuntime(promotion);
        invariant(references, "official claim promotion references are invalid");
        for (const reference of references) context.edges.push(edge(promotionRef, reference.ref, reference.necessity));
      } else invariant(legacyMigrationClaimIds.has(claim.claimId),
        "official evidence claim lacks reviewed candidate promotion or governed migration authority");
    }
    if (claim.supersedesClaimId !== undefined) {
      const old = claims.get(claim.supersedesClaimId);
      invariant(old && old.contentHash === claim.supersededClaimHash && old.status === "active"
        && old.fieldId === claim.fieldId && old.scope === claim.scope && sha256Json(old.subject) === sha256Json(claim.subject),
      "evidence claim supersession closure is invalid");
      invariant(!replacements.has(old.claimId), "evidence claim has multiple immutable replacements");
      replacements.add(old.claimId);
      context.edges.push(edge(`evidence-claim:${claim.claimId}`, `evidence-claim:${old.claimId}`));
    }
    context.edges.push(edge(`evidence-claim:${claim.claimId}`, `evidence-document:${claim.source.documentId}`));
    context.edges.push(edge(`evidence-claim:${claim.claimId}`, `evidence-capture:${claim.source.captureId}`));
  }
  for (const candidate of candidates.values()) {
    const document = documents.get(candidate.claim.source.documentId);
    const capture = captures.get(candidate.originalCaptureId);
    invariant(document?.sha256 === candidate.claim.source.documentSha256
      && capture?.id === candidate.originalCaptureId && capture.documentId === document?.id,
    "official claim candidate source document/capture closure is missing or mismatched");
    const asserted = Array.isArray(capture.productIdentities)
      ? capture.productIdentities.find((identity) => identity.basis === "governed-sku-user-asserted"
        && evidenceIdentityMatchesClaimSubjectRuntime(identity, candidate.claim.subject, candidate.claim.scope)) : null;
    invariant(asserted, "official claim candidate does not retain its governed acquisition identity");
    const fromRef = `evidence-claim-candidate:${candidate.candidateId}`;
    const references = officialClaimCandidateReferencesRuntime(candidate);
    invariant(references, "official claim candidate references are invalid");
    for (const reference of references) context.edges.push(edge(fromRef, reference.ref, reference.necessity));
  }
  for (const candidate of thirdPartyCandidates.values()) {
    const document = documents.get(candidate.claim.source.documentId);
    const capture = captures.get(candidate.originalCaptureId);
    invariant(document?.sha256 === candidate.claim.source.documentSha256
      && candidate.source.sourceContentHash === document.sha256
      && capture?.id === candidate.originalCaptureId && capture.documentId === document.id
      && capture.acquisitionMethod === "third-party-fetch" && capture.canonicalUrl === candidate.source.canonicalUrl,
    "third-party claim candidate source document/capture closure is missing or mismatched");
    const asserted = Array.isArray(capture.productIdentities)
      ? capture.productIdentities.find((identity) => identity.basis === "governed-sku-user-asserted"
        && evidenceIdentityMatchesClaimSubjectRuntime(identity, candidate.claim.subject, candidate.claim.scope)) : null;
    invariant(asserted, "third-party claim candidate does not retain its governed acquisition identity");
    const fromRef = `evidence-third-party-claim-candidate:${candidate.candidateId}`;
    const references = thirdPartyClaimCandidateReferencesRuntime(candidate);
    invariant(references, "third-party claim candidate references are invalid");
    for (const reference of references) context.edges.push(edge(fromRef, reference.ref, reference.necessity));
  }
  for (const binding of bindingProposals.values()) {
    for (const candidateId of binding.proposal.claimCandidateIds) {
      const candidate = candidateId.startsWith("third-party-")
        ? thirdPartyCandidates.get(candidateId) : candidates.get(candidateId);
      invariant(candidate && candidate.planId === binding.proposal.planId,
        "evidence binding proposal contains a missing or cross-plan claim candidate");
    }
    const fromRef = `evidence-binding-proposal:${binding.proposal.bindingProposalId}`;
    const references = evidenceBindingProposalReferencesRuntime(binding);
    invariant(references, "evidence binding proposal references are invalid");
    for (const reference of references) context.edges.push(edge(fromRef, reference.ref, reference.necessity));
  }
  return claims;
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
    if (value.evaluationLock) {
      invariant(value.evaluationLock.planId === value.planId && value.evaluationLock.snapshotHashes.configHash === value.configHash,
        "plan version evaluation lock does not match its owner/config");
      context.edges.push(edge(ref, `evaluation-lock:${value.evaluationLock.contentHash}`));
    }
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
    invariant(validateEvidenceRepositoryEnvelopeRuntime(record.value, "evidence-document").length === 0,
      "evidence document envelope is invalid");
    const value = record.value.payload;
    invariant(value?.id === document[2] && value.sha256 === document[3] && document[1] === document[3].slice(0, 2)
      && validateEvidenceDocumentRuntime(value).length === 0, "evidence document authority payload is invalid");
    const blob = confined(activeRoot, "evidence", "blobs", "sha256", value.sha256.slice(0, 2), value.sha256);
    const bytes = await readFile(blob).catch(() => null);
    invariant(bytes && bytes.length === value.byteLength && sha256Bytes(bytes) === value.sha256, "evidence document blob is missing or corrupt");
    context.nodes.push(`evidence-document:${value.id}`, `evidence-blob:sha256:${value.sha256}`);
    context.edges.push(edge(`evidence-document:${value.id}`, `evidence-blob:sha256:${value.sha256}`));
    return;
  }
  const capture = /^captures\/([a-f0-9]{2})\/(capture-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (capture) {
    invariant(validateEvidenceRepositoryEnvelopeRuntime(record.value, "evidence-capture").length === 0,
      "evidence capture envelope is invalid");
    const value = record.value.payload;
    invariant(value?.id === capture[2] && capture[1] === capture[3].slice(0, 2)
      && validateEvidenceCaptureRuntime(value).length === 0, "evidence capture authority payload is invalid");
    context.nodes.push(`evidence-capture:${value.id}`); context.pointers.push(`evidence-capture:${value.id}`);
    context.edges.push(edge(`evidence-capture:${value.id}`, `evidence-document:${value.documentId}`));
    return;
  }
  const candidate = /^claim-candidates\/([a-f0-9]{2})\/(claim-candidate-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (candidate) {
    const errors = validateOfficialClaimCandidateEnvelopeRuntime(record.value, candidate[2]);
    invariant(errors.length === 0 && candidate[1] === candidate[3].slice(0, 2),
      `official claim candidate authority is invalid: ${errors.join(", ")}`);
    const value = record.value.payload;
    const artifactRoot = confined(activeRoot, "artifacts");
    const artifacts = new FileArtifactRepository({ root: artifactRoot });
    const resultArtifact = await artifacts.getAt(artifactRoot, value.resultArtifactRef, { initialize: false }).catch(() => null);
    invariant(resultArtifact?.record?.kind === "evidence-stage-result"
      && resultArtifact.record.mediaType === "application/vnd.buildsim.evidence-job+json",
    "official claim candidate result artifact authority is missing");
    let result;
    try { result = JSON.parse(Buffer.from(resultArtifact.bytes).toString("utf8")); } catch { result = null; }
    const expectedJobId = `job-${sha256Bytes(Buffer.from(`${value.pipelineId}:claim_extraction:1`, "utf8"))}`;
    invariant(object(result) && result.schemaVersion === "evidence-stage-result-v1" && result.stage === "claim_extraction"
      && result.status === "completed" && result.pipelineId === value.pipelineId && result.jobId === value.jobId
      && result.jobId === expectedJobId && result.idempotencyKey === `${value.pipelineId}:claim_extraction:1`
      && result.completedAt === value.createdAt && Array.isArray(result.inputRefs) && result.inputRefs.length > 0
      && Array.isArray(result.output?.claimCandidates) && Array.isArray(result.output?.claimCandidateIds)
      && result.output.claimCandidateIds[value.candidateIndex] === value.candidateId,
    "official claim candidate stage result provenance is invalid");
    const claimMaterial = { ...value.claim }; delete claimMaterial.claimId; delete claimMaterial.contentHash;
    invariant(canonicalJson(result.output.claimCandidates[value.candidateIndex]) === canonicalJson(claimMaterial)
      && canonicalJson(result.output.officialPromotionInput) === canonicalJson(value.promotionInput)
      && canonicalJson(result.output.officialPromotion) === canonicalJson(value.promotion),
    "official claim candidate differs from its immutable stage result");
    const requestArtifact = await artifacts.getAt(artifactRoot, result.inputRefs[0], { initialize: false }).catch(() => null);
    invariant(requestArtifact?.record?.kind === "evidence-pipeline-request"
      && requestArtifact.record.mediaType === "application/vnd.buildsim.evidence-job+json",
    "official claim candidate request artifact authority is missing");
    let request;
    try { request = JSON.parse(Buffer.from(requestArtifact.bytes).toString("utf8")); } catch { request = null; }
    const expectedSubject = {
      brand: value.catalogIdentity.brand,
      category: value.catalogIdentity.category,
      skuId: value.claim.subject.skuId,
      familyId: value.claim.subject.familyId,
      ...(value.claim.subject.modelId === undefined ? {} : { modelId: value.claim.subject.modelId }),
      ...(value.claim.subject.variantId === undefined ? {} : { variantId: value.claim.subject.variantId }),
      ...(value.claim.subject.revision === undefined ? {} : { revision: value.claim.subject.revision }),
      ...(value.claim.subject.region === undefined ? {} : { region: value.claim.subject.region }),
    };
    invariant(object(request) && request.schemaVersion === "evidence-pipeline-v1" && request.planId === value.planId
      && request.pipelineId === value.pipelineId && request.pipelineId === `evidence-pipeline-sha256-${request.requestHash}`
      && canonicalJson(request.subject) === canonicalJson(expectedSubject),
    "official claim candidate request/plan/subject closure is invalid");
    const ref = `evidence-claim-candidate:${value.candidateId}`;
    context.nodes.push(ref); context.pointers.push(ref);
    return;
  }
  const thirdPartyCandidate = /^third-party-claim-candidates\/([a-f0-9]{2})\/(third-party-claim-candidate-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (thirdPartyCandidate) {
    const errors = validateThirdPartyClaimCandidateEnvelopeRuntime(record.value, thirdPartyCandidate[2]);
    invariant(errors.length === 0 && thirdPartyCandidate[1] === thirdPartyCandidate[3].slice(0, 2),
      `third-party claim candidate authority is invalid: ${errors.join(", ")}`);
    const value = record.value.payload;
    const artifactRoot = confined(activeRoot, "artifacts");
    const artifacts = new FileArtifactRepository({ root: artifactRoot });
    const resultArtifact = await artifacts.getAt(artifactRoot, value.resultArtifactRef, { initialize: false }).catch(() => null);
    invariant(resultArtifact?.record?.kind === "evidence-stage-result"
      && resultArtifact.record.mediaType === "application/vnd.buildsim.evidence-job+json",
    "third-party claim candidate result artifact authority is missing");
    let result;
    try { result = JSON.parse(Buffer.from(resultArtifact.bytes).toString("utf8")); } catch { result = null; }
    const expectedJobId = `job-${sha256Bytes(Buffer.from(`${value.pipelineId}:third_party_fallback:1`, "utf8"))}`;
    invariant(object(result) && result.schemaVersion === "evidence-stage-result-v1" && result.stage === "third_party_fallback"
      && result.status === "completed" && result.pipelineId === value.pipelineId && result.jobId === value.jobId
      && result.jobId === expectedJobId && result.idempotencyKey === `${value.pipelineId}:third_party_fallback:1`
      && result.completedAt === value.createdAt && Array.isArray(result.inputRefs) && result.inputRefs.length > 0
      && Array.isArray(result.output?.claimCandidates) && Array.isArray(result.output?.claimCandidateIds)
      && Array.isArray(result.output?.thirdPartySources) && result.output.claimCandidateIds[value.candidateIndex] === value.candidateId,
    "third-party claim candidate stage result provenance is invalid");
    const claimMaterial = { ...value.claim }; delete claimMaterial.claimId; delete claimMaterial.contentHash;
    invariant(canonicalJson(result.output.claimCandidates[value.candidateIndex]) === canonicalJson(claimMaterial)
      && result.output.thirdPartySources.some((source) => canonicalJson(source) === canonicalJson(value.source))
      && canonicalJson(result.output.independenceAssessment) === canonicalJson(value.assessment),
    "third-party claim candidate differs from its immutable stage result");
    const requestArtifact = await artifacts.getAt(artifactRoot, result.inputRefs[0], { initialize: false }).catch(() => null);
    invariant(requestArtifact?.record?.kind === "evidence-pipeline-request"
      && requestArtifact.record.mediaType === "application/vnd.buildsim.evidence-job+json",
    "third-party claim candidate request artifact authority is missing");
    let request;
    try { request = JSON.parse(Buffer.from(requestArtifact.bytes).toString("utf8")); } catch { request = null; }
    const expectedSubject = {
      brand: value.catalogIdentity.brand,
      category: value.catalogIdentity.category,
      skuId: value.claim.subject.skuId,
      familyId: value.claim.subject.familyId,
      ...(value.claim.subject.modelId === undefined ? {} : { modelId: value.claim.subject.modelId }),
      ...(value.claim.subject.variantId === undefined ? {} : { variantId: value.claim.subject.variantId }),
      ...(value.claim.subject.revision === undefined ? {} : { revision: value.claim.subject.revision }),
      ...(value.claim.subject.region === undefined ? {} : { region: value.claim.subject.region }),
    };
    invariant(object(request) && request.schemaVersion === "evidence-pipeline-v1" && request.planId === value.planId
      && request.pipelineId === value.pipelineId && request.pipelineId === `evidence-pipeline-sha256-${request.requestHash}`
      && canonicalJson(request.subject) === canonicalJson(expectedSubject),
    "third-party claim candidate request/plan/subject closure is invalid");
    const ref = `evidence-third-party-claim-candidate:${value.candidateId}`;
    context.nodes.push(ref); context.pointers.push(ref);
    return;
  }
  const bindingProposal = /^binding-proposals\/([a-f0-9]{2})\/(evidence-binding-proposal-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (bindingProposal) {
    const errors = validateEvidenceBindingProposalEnvelopeRuntime(record.value, bindingProposal[2]);
    invariant(errors.length === 0 && bindingProposal[1] === bindingProposal[3].slice(0, 2),
      `evidence binding proposal authority is invalid: ${errors.join(", ")}`);
    const value = record.value.payload;
    const artifactRoot = confined(activeRoot, "artifacts");
    const artifacts = new FileArtifactRepository({ root: artifactRoot });
    const readResult = async (ref) => {
      const artifact = await artifacts.getAt(artifactRoot, ref, { initialize: false }).catch(() => null);
      invariant(artifact?.record?.kind === "evidence-stage-result"
        && artifact.record.mediaType === "application/vnd.buildsim.evidence-job+json",
      "evidence binding proposal result artifact authority is missing");
      try { return JSON.parse(Buffer.from(artifact.bytes).toString("utf8")); }
      catch { throw new Error("evidence binding proposal result artifact is malformed"); }
    };
    const result = await readResult(value.resultArtifactRef);
    const claimResult = await readResult(value.claimResultArtifactRef);
    const adapterResult = await readResult(value.adapterResultArtifactRef);
    const expectedJobId = `job-${sha256Bytes(Buffer.from(`${value.proposal.pipelineId}:binding_proposal:1`, "utf8"))}`;
    invariant(result?.schemaVersion === "evidence-stage-result-v1" && result.stage === "binding_proposal" && result.status === "completed"
      && result.pipelineId === value.proposal.pipelineId && result.jobId === value.jobId && result.jobId === expectedJobId
      && result.idempotencyKey === `${value.proposal.pipelineId}:binding_proposal:1`
      && canonicalJson(result.output) === canonicalJson(value.proposal)
      && Array.isArray(result.inputRefs) && result.inputRefs.includes(value.claimResultArtifactRef)
      && result.inputRefs.includes(value.adapterResultArtifactRef),
    "evidence binding proposal stage result provenance is invalid");
    invariant(["claim_extraction", "third_party_fallback"].includes(claimResult?.stage) && claimResult.status === "completed"
      && Array.isArray(claimResult.output?.claimCandidateIds)
      && canonicalJson([...claimResult.output.claimCandidateIds].sort()) === canonicalJson([...value.proposal.claimCandidateIds].sort()),
    "evidence binding proposal claim candidate result closure is invalid");
    invariant(adapterResult?.stage === "adapter_generation" && adapterResult.status === "completed"
      && adapterResult.output?.candidateId === value.proposal.adapterCandidateId
      && adapterResult.output?.contentHash === value.proposal.adapterCandidateHash
      && adapterResult.output.candidateId === `evidence-adapter-candidate-sha256-${adapterResult.output.contentHash}`,
    "evidence binding proposal adapter candidate result closure is invalid");
    const requestRef = result.inputRefs[0];
    const requestArtifact = await artifacts.getAt(artifactRoot, requestRef, { initialize: false }).catch(() => null);
    let request;
    try { request = requestArtifact ? JSON.parse(Buffer.from(requestArtifact.bytes).toString("utf8")) : null; } catch { request = null; }
    invariant(requestArtifact?.record?.kind === "evidence-pipeline-request"
      && requestArtifact.record.mediaType === "application/vnd.buildsim.evidence-job+json"
      && request?.planId === value.proposal.planId && request.pipelineId === value.proposal.pipelineId
      && canonicalJson(request.subject) === canonicalJson(value.proposal.subject),
    "evidence binding proposal request/plan/subject closure is invalid");
    const ref = `evidence-binding-proposal:${value.proposal.bindingProposalId}`;
    context.nodes.push(ref); context.pointers.push(ref);
    return;
  }
  const claim = /^claims\/([a-f0-9]{2})\/(claim-sha256-([a-f0-9]{64}))\.json$/.exec(relative);
  if (claim) {
    invariant(validEnvelope(record.value, "evidence-claim-envelope-v1", "evidence-claim"), "evidence claim envelope is invalid");
    const value = record.value.payload;
    const envelopeKeys = Object.keys(record.value).sort().join(",");
    const promotionValid = value?.authority === "third_party" ? envelopeKeys === "authorityChecksum,checksum,kind,payload,schemaVersion,thirdPartyPromotion"
        && validateThirdPartyClaimPromotionRuntime(record.value.thirdPartyPromotion).length === 0
        && record.value.authorityChecksum === sha256Json({ claim: value, promotion: record.value.thirdPartyPromotion })
      : value?.authority === "official" && (
        envelopeKeys === "checksum,kind,payload,schemaVersion"
        || (envelopeKeys === "authorityChecksum,checksum,kind,officialPromotion,payload,schemaVersion"
          && validateOfficialClaimPromotionRuntime(record.value.officialPromotion).length === 0
          && record.value.authorityChecksum === sha256Json({ claim: value, promotion: record.value.officialPromotion }))
      );
    invariant(value?.claimId === claim[2] && claim[1] === claim[3].slice(0, 2)
      && value.contentHash === claim[3] && validateEvidenceClaimRuntime(value).length === 0
      && verifyEvidenceClaimRuntime(value) && promotionValid, "evidence claim authority payload is invalid");
    context.nodes.push(`evidence-claim:${value.claimId}`);
    return;
  }
  const sourceIndex = /^source-index\/([a-f0-9]{2})\/([a-f0-9]{64})\.json$/.exec(relative);
  if (sourceIndex) {
    invariant(validateEvidenceRepositoryEnvelopeRuntime(record.value, "evidence-url-index").length === 0
      && validateEvidenceUrlIndexRuntime(record.value.payload).length === 0
      && sha256Bytes(Buffer.from(record.value.payload.url, "utf8")) === sourceIndex[2]
      && sourceIndex[1] === sourceIndex[2].slice(0, 2), "evidence source index is invalid");
    context.nodes.push(`evidence-url-index:${sourceIndex[2]}`);
    return;
  }
  if (relative === ".rollback/manifest.json") {
    const entries = record.value?.entries;
    const validEntry = (entry) => object(entry)
      && Object.keys(entry).sort(compare).join(",") === "backup,committedAt,createdAt,eventId,nextHash,operation,previousHash,status,target"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.eventId)
      && entry.operation === "replace-index" && entry.status === "committed"
      && /^source-index\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(entry.target)
      && (entry.backup === null || /^\.rollback\/[0-9]{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-f0-9]{64}\.json\.bak$/.test(entry.backup))
      && (entry.previousHash === null || SHA256.test(entry.previousHash)) && SHA256.test(entry.nextHash)
      && iso(entry.createdAt) && iso(entry.committedAt);
    invariant(record.value?.schemaVersion === "evidence-rollback-manifest-v1" && Array.isArray(entries)
      && entries.every(validEntry), "evidence rollback manifest is incomplete or invalid");
    return;
  }
  // Every evidence subtree is governed.  A checksum-valid record must not be
  // able to hide behind an extension that the ordinary JSON parser ignores.
  if (relative.startsWith("claims/")) throw new Error("evidence claims contain an unrecognized authority path");
  if (relative.startsWith("claim-candidates/")) throw new Error("official claim candidates contain an unrecognized authority path");
  if (relative.startsWith("third-party-claim-candidates/")) throw new Error("third-party claim candidates contain an unrecognized authority path");
  if (relative.startsWith("binding-proposals/")) throw new Error("evidence binding proposals contain an unrecognized authority path");
  const blob = /^blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(relative);
  if (blob) {
    invariant(blob[1] === blob[2].slice(0, 2) && record.sha256 === blob[2], "evidence blob path or content hash is invalid");
    return;
  }
  // FileEvidenceRepository retains previous source-index bytes under this
  // exact randomUUID path while its manifest commit is made durable.  These
  // are audit-only recovery leaves, never current evidence authority.
  if (/^\.rollback\/[0-9]{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-f0-9]{64}\.json\.bak$/.test(relative)) {
    context.nodes.push(`evidence-rollback-bytes:${relative}`);
    return;
  }
  if (relative.startsWith("documents/") || relative.startsWith("captures/") || relative.startsWith("source-index/")
    || relative.startsWith("blobs/") || relative.startsWith("claim-candidates/") || relative.startsWith("third-party-claim-candidates/")
    || relative.startsWith("binding-proposals/")) {
    throw new Error("evidence repository contains an unrecognized authority path");
  }
  if (relative.endsWith(".json")) throw new Error("evidence repository contains an unrecognized JSON authority");
  throw new Error("evidence repository contains an unrecognized authority path");
}

function attachmentMetadataValue(record) {
  const metadata = /^metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  if (!metadata || !validLegacyEnvelope(record.value, "attachment-repository-v1", "attachment")) return null;
  const value = record.value.payload;
  const base = without(value ?? {}, "metadataHash");
  const available = ["attachmentId", "planId", "contentHash", "mediaType", "privacyClass", "deletionPolicy", "status", "revision", "createdAt", "metadataHash"];
  const deleted = [...available, "deletedAt"];
  const allowed = value?.status === "deleted_tombstone" ? deleted : available;
  if (value?.attachmentId !== metadata[1] || !SAFE_ID.test(value.attachmentId) || !ATTACHMENT_PLAN_ID.test(String(value.planId ?? ""))
    || !SHA256.test(String(value.contentHash ?? "")) || typeof value.mediaType !== "string" || !value.mediaType
    || value.privacyClass !== "private_user" || !["retain_until_user_deletes", "delete_after_extraction"].includes(value.deletionPolicy)
    || !["available", "deleted_tombstone"].includes(value.status) || !Number.isInteger(value.revision) || value.revision < 0
    || !iso(value.createdAt) || (value.status === "deleted_tombstone" && !iso(value.deletedAt))
    || Object.keys(value).some((key) => !allowed.includes(key)) || value.metadataHash !== legacySha256Runtime(base)) return null;
  return value;
}

function attachmentAuthorityIndex(records) {
  const attachments = new Map(); const blobs = new Map();
  for (const record of records) {
    const blob = /^blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
    if (!blob) continue;
    invariant(blob[1] === blob[2].slice(0, 2) && record.sha256 === blob[2], "attachment blob path or content hash is invalid");
    invariant(!blobs.has(blob[2]), "attachment blob authority is duplicated");
    blobs.set(blob[2], record);
  }
  for (const record of records) {
    const metadata = /^metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (!metadata) continue;
    const value = attachmentMetadataValue(record);
    invariant(value, "attachment metadata/hash is invalid");
    invariant(!attachments.has(value.attachmentId), "attachment authority is duplicated");
    const blob = blobs.get(value.contentHash);
    if (value.status === "available") invariant(blob && blob.sha256 === value.contentHash,
      "attachment blob is missing or corrupt");
    else invariant(!blob || blob.sha256 === value.contentHash, "attachment tombstone content authority is invalid");
    attachments.set(value.attachmentId, value);
  }
  return attachments;
}

function validateAttachmentRecord(record, context) {
  const metadata = /^metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
  if (!metadata) {
    const stagedMetadata = /^staged\/metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (stagedMetadata) {
      const errors = validateStagedUploadEnvelopeRuntime(record.value, { uploadId: stagedMetadata[1] });
      invariant(errors.length === 0, `staged attachment metadata is invalid: ${errors.join(", ")}`);
      const value = record.value.payload;
      const ref = `staged-attachment:${value.uploadId}`;
      context.nodes.push(ref); context.pointers.push(ref);
      const references = stagedUploadReferencesRuntime(value);
      invariant(references, "staged attachment reference contract is invalid");
      for (const reference of references) context.edges.push(edge(ref, reference.ref, reference.necessity));
      return;
    }
    const stagedBlob = /^staged\/blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
    if (stagedBlob) {
      invariant(stagedBlob[1] === stagedBlob[2].slice(0, 2) && record.sha256 === stagedBlob[2],
        "staged attachment blob path or content hash is invalid");
      context.nodes.push(`staged-attachment-blob:sha256:${stagedBlob[2]}`);
      return;
    }
    if (record.rootLogicalPath === "rollback/manifest.json") {
      const body = without(record.value ?? {}, "checksum");
      invariant(record.value?.schemaVersion === "attachment-rollback-manifest-v1" && Array.isArray(record.value.entries)
        && record.value.checksum === sha256Json(body), "attachment rollback manifest is invalid");
      return;
    }
    const rollback = /^rollback\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/([0-9]{12})\.json$/.exec(record.rootLogicalPath);
    if (rollback) {
      invariant(validEnvelope(record.value, "attachment-rollback-v1", "attachment-rollback")
        && record.value.payload?.attachmentId === rollback[1]
        && record.value.payload?.fromRevision === Number(rollback[2]), "attachment rollback record is invalid");
      return;
    }
    const blob = /^blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
    if (blob) {
      invariant(blob[1] === blob[2].slice(0, 2) && record.sha256 === blob[2], "attachment blob path or content hash is invalid");
      return;
    }
    if (record.rootLogicalPath.startsWith("metadata/") || record.rootLogicalPath.startsWith("rollback/")
      || record.rootLogicalPath.startsWith("blobs/") || record.rootLogicalPath.startsWith("staged/")) {
      throw new Error("attachments repository contains an unrecognized authority path");
    }
    if (record.rootLogicalPath.endsWith(".json")) throw new Error("attachments repository contains an unrecognized JSON authority");
    throw new Error("attachments repository contains an unrecognized authority path");
  }
  const value = attachmentMetadataValue(record);
  invariant(value, "attachment metadata/hash is invalid");
  if (value.status === "available") {
    context.nodes.push(`attachment:${value.attachmentId}`, `attachment-blob:sha256:${value.contentHash}`);
    context.pointers.push(`attachment:${value.attachmentId}`);
    context.edges.push(edge(`attachment:${value.attachmentId}`, `attachment-blob:sha256:${value.contentHash}`));
    context.edges.push(edge(`attachment:${value.attachmentId}`, `plan:${value.planId}`));
  }
}

function validateStagedAttachmentRepository(records) {
  const uploads = new Map(); const blobs = new Map();
  for (const record of records) {
    const metadata = /^staged\/metadata\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (metadata) {
      const errors = validateStagedUploadEnvelopeRuntime(record.value, { uploadId: metadata[1] });
      invariant(errors.length === 0, `staged attachment metadata is invalid: ${errors.join(", ")}`);
      invariant(!uploads.has(metadata[1]), "staged attachment authority is duplicated");
      uploads.set(metadata[1], record.value.payload);
      continue;
    }
    const blob = /^staged\/blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(record.rootLogicalPath);
    if (!blob) continue;
    invariant(blob[1] === blob[2].slice(0, 2) && record.sha256 === blob[2],
      "staged attachment blob path or content hash is invalid");
    invariant(!blobs.has(blob[2]), "staged attachment blob authority is duplicated");
    blobs.set(blob[2], record);
  }
  const referenced = new Set();
  for (const upload of uploads.values()) {
    const blob = blobs.get(upload.contentHash);
    invariant(blob && blob.sha256 === upload.contentHash && blob.bytes.length === upload.byteLength,
      "staged attachment body is missing, truncated, or hash-mismatched");
    referenced.add(upload.contentHash);
  }
  // A process can stop after the immutable blob rename but before its metadata
  // commit. Such bytes have no upload/session/consumer authority and therefore
  // cannot be resolved or claimed. Keep the valid content-addressed blob as an
  // optional audit/GC leaf; a later identical upload may safely reuse it only
  // after committing fresh metadata authority.
  return uploads;
}

function observationStoredIndex(records) {
  const observations = new Map();
  for (const record of records) {
    const match = /^plans\/([^/]+)\/records\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (!match || !validLegacyEnvelope(record.value, "observation-repository-v1", "observation")) continue;
    const stored = record.value.payload;
    if (stored?.schemaVersion !== "observation-repository-v1" || stored.revision !== 0 || stored.observation?.planId !== match[1]
      || stored.observation?.observationId !== match[2] || stored.recordHash !== legacySha256Runtime(stored.observation)
      || validateUserObservationRuntime(stored.observation).length || !verifyUserObservationRuntime(stored.observation)) continue;
    observations.set(`${match[1]}\u0000${match[2]}`, { planId: match[1], observationId: match[2], stored, record });
  }
  return observations;
}

function validateObservationRepository(records, context, attachments = new Map()) {
  const observations = new Map(); const snapshots = []; const supersessions = new Map();
  for (const record of records) {
    const relative = record.rootLogicalPath;
    const observation = /^plans\/([^/]+)\/records\/([^/]+)\.json$/.exec(relative);
    if (observation) {
      invariant(SAFE_ID.test(observation[1]) && SAFE_ID.test(observation[2])
        && validLegacyEnvelope(record.value, "observation-repository-v1", "observation"), "observation envelope is invalid");
      const stored = record.value.payload;
      invariant(stored?.schemaVersion === "observation-repository-v1" && stored.revision === 0
        && stored.observation?.observationId === observation[2] && stored.observation.planId === observation[1]
        && stored.recordHash === legacySha256Runtime(stored.observation)
        && validateUserObservationRuntime(stored.observation).length === 0 && verifyUserObservationRuntime(stored.observation),
      "observation authority payload is invalid");
      const key = `${observation[1]}\u0000${observation[2]}`;
      invariant(!observations.has(key), "observation repository contains duplicate plan observation authority");
      observations.set(key, { planId: observation[1], observationId: observation[2], stored });
      context.nodes.push(`observation:${observation[2]}`);
      context.edges.push(edge(`observation:${observation[2]}`, `plan:${observation[1]}`));
      continue;
    }
    const snapshot = /^plans\/([^/]+)\/snapshots\/([^/]+)\.json$/.exec(relative);
    if (snapshot) {
      invariant(SAFE_ID.test(snapshot[1]) && SAFE_ID.test(snapshot[2])
        && validLegacyEnvelope(record.value, "observation-repository-v1", "snapshot"), "observation snapshot envelope is invalid");
      const value = record.value.payload;
      invariant(value?.snapshotId === snapshot[2] && value.planId === snapshot[1]
        && validateUserObservationSnapshotRuntime(value).length === 0 && verifyUserObservationSnapshotRuntime(value),
      "observation snapshot authority payload is invalid");
      snapshots.push(value); const ref = `observation-snapshot:${value.snapshotId}`;
      context.nodes.push(ref); context.pointers.push(ref);
      continue;
    }
    const supersession = /^plans\/([^/]+)\/supersessions\/([^/]+)\.json$/.exec(relative);
    if (supersession) {
      invariant(SAFE_ID.test(supersession[1]) && SAFE_ID.test(supersession[2])
        && validLegacyEnvelope(record.value, "observation-repository-v1", "supersession"), "observation supersession envelope is invalid");
      const value = record.value.payload;
      invariant(validateObservationSupersessionRuntime(value, { planId: supersession[1], replacementObservationId: supersession[2] }).length === 0,
        "observation supersession authority payload is invalid");
      const key = `${supersession[1]}\u0000${supersession[2]}`;
      invariant(!supersessions.has(key), "observation supersession authority is duplicated");
      supersessions.set(key, value);
      continue;
    }
    const journal = /^journal\/([^/]+)\/([^/]+)\.json$/.exec(relative);
    if (journal) {
      invariant(SAFE_ID.test(journal[1]) && validLegacyEnvelope(record.value, "observation-journal-v1", "transaction"), "observation journal is invalid");
      const value = record.value.payload;
      invariant(value?.planId === journal[1] && ["observation-create", "snapshot-create"].includes(value.operation)
        && typeof value.transactionId === "string" && value.transactionId.length > 0 && typeof value.authorityId === "string" && value.authorityId.length > 0
        && Number.isFinite(Date.parse(value.createdAt)) && value.state === "committed", "observation journal is invalid or incomplete");
      continue;
    }
    if (relative.endsWith(".json")) throw new Error("observations repository contains an unrecognized JSON authority");
    throw new Error("observations repository contains an unrecognized authority path");
  }

  const ownerByObservation = new Map(); const byPlan = new Map();
  for (const entry of observations.values()) {
    const owner = ownerByObservation.get(entry.observationId);
    invariant(owner === undefined || owner === entry.planId, "observation identity is reused across plans");
    ownerByObservation.set(entry.observationId, entry.planId);
    const values = byPlan.get(entry.planId) ?? []; values.push(entry); byPlan.set(entry.planId, values);
  }
  const activeCurrent = new Set(); const expectedSupersessions = new Set();
  for (const [planId, entries] of byPlan) {
    const result = currentObservationIdsRuntime(entries.map((entry) => entry.stored.observation));
    invariant(result.errors.length === 0, `observation lifecycle closure is invalid: ${result.errors.join(", ")}`);
    for (const entry of entries) {
      const observation = entry.stored.observation;
      if (observation.supersedesObservationId) {
        const event = supersessions.get(`${planId}\u0000${observation.observationId}`);
        invariant(event?.supersededObservationId === observation.supersedesObservationId,
          "observation supersession index does not match immutable replacement");
        expectedSupersessions.add(`${planId}\u0000${observation.observationId}`);
        context.edges.push(edge(`observation:${observation.observationId}`, `observation:${observation.supersedesObservationId}`));
      }
      if (result.currentIds.has(observation.observationId) && observation.status === "active" && observation.invalidatedAt === undefined) {
        activeCurrent.add(`${planId}\u0000${observation.observationId}`);
      }
    }
  }
  for (const key of supersessions.keys()) invariant(expectedSupersessions.has(key), "observation supersession index is orphaned");

  const snapshotOwners = new Map(); const replayable = new Set(activeCurrent);
  for (const snapshot of snapshots) {
    const owner = snapshotOwners.get(snapshot.snapshotId);
    invariant(owner === undefined || owner === snapshot.planId, "observation snapshot identity is reused across plans");
    snapshotOwners.set(snapshot.snapshotId, snapshot.planId);
    for (const id of snapshot.observationIds) {
      const stored = observations.get(`${snapshot.planId}\u0000${id}`);
      invariant(stored, "observation snapshot member is missing or cross-plan");
      if (snapshot.observationRecordHashes !== undefined) invariant(snapshot.observationRecordHashes[id] === stored.stored.recordHash,
        "observation snapshot member hash no longer matches its immutable record");
      context.edges.push(edge(`observation-snapshot:${snapshot.snapshotId}`, `observation:${id}`));
      replayable.add(`${snapshot.planId}\u0000${id}`);
    }
  }
  for (const entry of observations.values()) {
    if (!replayable.has(`${entry.planId}\u0000${entry.observationId}`)) continue;
    for (const attachmentId of entry.stored.observation.attachmentRefs) {
      const attachment = attachments.get(attachmentId);
      invariant(attachment && attachment.planId === entry.planId && attachment.status === "available",
        "observation attachment closure is missing, tombstoned, or cross-plan");
      context.edges.push(edge(`observation:${entry.observationId}`, `attachment:${attachmentId}`));
    }
  }
  return observations;
}

/** Read-only indexes used to close EvaluationLockRepository inputs at this generation. */
function factSnapshotAuthorityIndex(records) {
  const snapshots = new Map();
  for (const record of records) {
    const match = /^snapshots\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\.json$/.exec(record.rootLogicalPath);
    if (!match || !validEnvelope(record.value, "fact-repository-envelope-v1", "snapshot")) continue;
    const snapshot = record.value.payload;
    if (snapshot?.snapshotId === match[1] && validateFactSnapshotRuntime(snapshot).length === 0 && verifyFactSnapshotRuntime(snapshot)) {
      snapshots.set(snapshot.snapshotId, snapshot);
    }
  }
  return snapshots;
}

function observationSnapshotAuthorityIndex(records) {
  const snapshots = new Map();
  for (const record of records) {
    const match = /^plans\/([^/]+)\/snapshots\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    if (!match || !validLegacyEnvelope(record.value, "observation-repository-v1", "snapshot")) continue;
    const snapshot = record.value.payload;
    if (snapshot?.planId === match[1] && snapshot.snapshotId === match[2]
      && validateUserObservationSnapshotRuntime(snapshot).length === 0 && verifyUserObservationSnapshotRuntime(snapshot)) {
      snapshots.set(`${snapshot.planId}\u0000${snapshot.snapshotId}`, snapshot);
    }
  }
  return snapshots;
}

function evaluationSnapshotAuthorityIndex(records) {
  const payloads = new Map(); const lockfiles = new Map(); const externals = new Map();
  const locks = new Map(); const receipts = new Map(); const currents = new Map();
  for (const record of records) {
    const relative = record.rootLogicalPath;
    const artifact = /^evaluation-artifacts\/([a-f0-9]{64})\.json$/.exec(relative);
    if (artifact) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "evaluation-artifact").length === 0
        && validateEvaluationArtifactInputRuntime(record.value.payload).length === 0
        && record.value.payload.ref.contentHash === artifact[1], "evaluation artifact authority payload is invalid");
      if (record.value.payload.ref.role === "adapterSnapshot") {
        invariant(record.value.payload.ref.mediaType === "application/vnd.buildsim.adapter-snapshot+json",
          "workspace case adapter snapshot media contract is invalid");
        const adapterPayload = record.value.payload.payload;
        // U3 used opaque, differently-versioned adapter fixtures.  For the
        // workspace schema, however, only the exact three-field rollback
        // payload is legacy; every other shape is a U5 authority claim.
        if (adapterPayload?.schemaVersion === "workspace-adapter-snapshot-v1"
          && !validLegacyWorkspaceAdapterSnapshot(adapterPayload)) {
          const errors = validateWorkspaceCaseAdapterSnapshotRuntime(adapterPayload);
          invariant(errors.length === 0, `workspace case adapter snapshot semantic authority is invalid: ${errors.join(", ")}`);
        } else if (claimsGenericAdapterSnapshot(adapterPayload)) {
          const errors = validateWorkspaceCaseAdapterSnapshotRuntime(adapterPayload);
          invariant(errors.length === 0, `workspace case adapter snapshot semantic authority is invalid: ${errors.join(", ")}`);
        }
      }
      if (record.value.payload.ref.role === "systemProfile"
        && record.value.payload.payload?.schemaVersion === "workspace-system-profile-v2") {
        const systemErrors = validateWorkspaceSystemProfilePayloadRuntime(record.value.payload.payload);
        invariant(systemErrors.length === 0,
          `workspace system profile semantic authority is invalid: ${systemErrors.join(", ")}`);
      }
      invariant(!payloads.has(artifact[1]), "evaluation artifact authority is duplicated");
      payloads.set(artifact[1], record.value.payload); continue;
    }
    const lockfile = /^artifact-lockfiles\/([a-f0-9]{64})\.json$/.exec(relative);
    if (lockfile) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "artifact-lockfile").length === 0
        && validateArtifactLockfileRuntime(record.value.payload).length === 0
        && record.value.payload.lockfileHash === lockfile[1], "evaluation artifact lockfile authority is invalid");
      invariant(!lockfiles.has(lockfile[1]), "evaluation artifact lockfile authority is duplicated");
      lockfiles.set(lockfile[1], record.value.payload); continue;
    }
    const external = /^evaluation-external\/(requirementSpec|priceSnapshot|simulationInput)\/([a-f0-9]{64})\.json$/.exec(relative);
    if (external) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "evaluation-external").length === 0
        && validateEvaluationExternalRuntime(record.value.payload).length === 0
        && record.value.payload.role === external[1] && record.value.payload.snapshot.ref.contentHash === external[2],
      "evaluation external snapshot authority is invalid");
      const key = `${external[1]}\u0000${external[2]}`;
      invariant(!externals.has(key), "evaluation external snapshot authority is duplicated");
      externals.set(key, record.value.payload); continue;
    }
    const lock = /^evaluation-locks\/([a-f0-9]{64})\.json$/.exec(relative);
    if (lock) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "evaluation-lock").length === 0
        && validatePlanEvaluationLockRuntime(record.value.payload).length === 0 && record.value.payload.contentHash === lock[1],
      "evaluation lock authority payload is invalid");
      invariant(!locks.has(lock[1]), "evaluation lock authority is duplicated");
      locks.set(lock[1], record.value.payload); continue;
    }
    const receipt = /^evaluation-receipts\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\/(draft-[0-9]+|version-[A-Za-z0-9][A-Za-z0-9._-]{0,255})\/([a-f0-9]{64})\.json$/.exec(relative);
    if (receipt) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "evaluation-receipt").length === 0
        && validateAuthoritativeEvaluationReceiptRuntime(record.value.payload).length === 0
        && record.value.payload.planId === receipt[1] && evaluationTargetKeyRuntime(record.value.payload.target) === receipt[2]
        && sha256Json(record.value.payload) === receipt[3], "authoritative evaluation receipt payload is invalid");
      const key = `${receipt[1]}\u0000${receipt[2]}\u0000${receipt[3]}`;
      invariant(!receipts.has(key), "authoritative evaluation receipt authority is duplicated");
      receipts.set(key, record.value.payload); continue;
    }
    const current = /^evaluation-current\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\/(draft-[0-9]+|version-[A-Za-z0-9][A-Za-z0-9._-]{0,255})\.json$/.exec(relative);
    if (current) {
      invariant(validateEvaluationLockEnvelopeRuntime(record.value, "evaluation-current").length === 0
        && validateEvaluationCurrentPointerRuntime(record.value.payload).length === 0
        && record.value.payload.planId === current[1] && evaluationTargetKeyRuntime(record.value.payload.target) === current[2],
      "evaluation current pointer authority is invalid");
      const key = `${current[1]}\u0000${current[2]}`;
      invariant(!currents.has(key), "evaluation current pointer authority is duplicated");
      currents.set(key, record.value.payload); continue;
    }
    if (relative.endsWith(".json")) throw new Error("evaluation snapshot repository contains an unrecognized JSON authority");
    throw new Error("evaluation snapshot repository contains an unrecognized authority path");
  }
  return { payloads, lockfiles, externals, locks, receipts, currents };
}

function planAuthorityForEvaluation(records, planId, target) {
  const plan = records.find((record) => record.rootLogicalPath === `${planId}/plan.json` && validEnvelope(record.value, "1.0.0", "plan"))?.value?.payload;
  if (!plan || plan.id !== planId) return null;
  if (target.kind === "draft") return { ref: `plan:${planId}`, plan };
  const version = ownedPlanVersion(records, planId, target.versionId);
  return version ? { ref: `plan-version:${version.id}`, plan, version } : null;
}

function lockedEvaluationArtifact(authority, lockfile, role) {
  const ref = lockfile?.artifacts?.[role];
  const stored = ref && authority.payloads.get(ref.contentHash);
  invariant(stored && sameAuthorityJson(stored.ref, ref), `evaluation ${role} artifact authority is missing or mismatched`);
  return stored.payload;
}

function parsedUniqueArtifactSource(payload, moduleId) {
  const matches = Array.isArray(payload?.sources)
    ? payload.sources.filter((source) => source?.moduleId === moduleId && typeof source.bytes === "string")
    : [];
  invariant(matches.length === 1, `evaluation artifact source ${moduleId} is missing or duplicated`);
  try { return JSON.parse(matches[0].bytes); }
  catch { throw new Error(`evaluation artifact source ${moduleId} is not JSON`); }
}

function artifactSourcesNamed(payload, moduleId) {
  return Array.isArray(payload?.sources)
    ? payload.sources.filter((source) => source?.moduleId === moduleId && typeof source.bytes === "string")
    : [];
}

/**
 * Resolves the immutable adapter authority selected by a receipt.  Generic
 * adapter snapshots additionally bind their engine's exact transitive input
 * tuple; re-locking an adapter while retaining an old engine is not replay.
 */
function receiptAdapterAuthority(authority, receipt) {
  const lock = authority.locks.get(receipt.evaluationLock.contentHash);
  invariant(lock && sameAuthorityJson(lock, receipt.evaluationLock), "authoritative evaluation receipt lock closure is missing or mismatched");
  const lockfile = authority.lockfiles.get(lock.artifactLockfileHash);
  invariant(lockfile, "authoritative evaluation receipt artifact lockfile is missing");
  const adapterSnapshot = lockedEvaluationArtifact(authority, lockfile, "adapterSnapshot");
  const engine = lockedEvaluationArtifact(authority, lockfile, "engine");
  const engineClaimsGenericClosure = artifactSourcesNamed(engine, "artifact/evaluation-transitive-closure").length > 0;
  if (claimsGenericAdapterSnapshot(adapterSnapshot) || engineClaimsGenericClosure) {
    const adapterErrors = validateWorkspaceCaseAdapterSnapshotRuntime(adapterSnapshot);
    invariant(adapterErrors.length === 0,
      `evaluation generic adapter semantic authority is invalid: ${adapterErrors.join(", ")}`);
    const ruleSet = lockedEvaluationArtifact(authority, lockfile, "ruleSet");
    const standardSet = lockedEvaluationArtifact(authority, lockfile, "standardSet");
    const engineClosure = parsedUniqueArtifactSource(engine, "artifact/evaluation-transitive-closure");
    invariant(sameAuthorityJson(engineClosure, { ruleSet, standardSet, adapterSnapshot }),
      "evaluation engine transitive closure does not bind the locked adapter authority");
  }
  return adapterSnapshot;
}

function validateEvaluationSnapshotRepository(records, context, factRecords, observationRecords, planRecords, runtimeGeneration) {
  const authority = evaluationSnapshotAuthorityIndex(records);
  const facts = factSnapshotAuthorityIndex(factRecords);
  const observations = observationSnapshotAuthorityIndex(observationRecords);
  for (const [hash, payload] of authority.payloads) {
    const fromRef = `evaluation-artifact:${hash}`;
    context.nodes.push(fromRef);
    if (payload.ref.role === "adapterSnapshot" && claimsGenericAdapterSnapshot(payload.payload)) {
      const references = workspaceCaseAdapterSnapshotReferencesRuntime(payload.payload);
      invariant(references, "workspace case adapter snapshot reference contract is invalid");
      for (const item of references) context.edges.push(edge(fromRef, item.ref, item.necessity));
    }
  }
  for (const [hash, lockfile] of authority.lockfiles) {
    const fromRef = `artifact-lockfile:${hash}`; context.nodes.push(fromRef);
    for (const role of Object.keys(lockfile.artifacts)) context.edges.push(edge(fromRef, `evaluation-artifact:${lockfile.artifacts[role].contentHash}`));
  }
  for (const [key] of authority.externals) {
    const [role, hash] = key.split("\u0000"); context.nodes.push(`evaluation-external:${role}:${hash}`);
  }
  for (const [hash, lock] of authority.locks) {
    const closure = evaluationSnapshotLockClosureRuntime(lock, facts, observations, authority, authority.externals);
    invariant(closure.length === 0, `evaluation lock closure is invalid: ${closure.join(", ")}`);
    const fromRef = `evaluation-lock:${hash}`;
    context.nodes.push(fromRef); context.pointers.push(fromRef);
    context.edges.push(edge(fromRef, `fact-snapshot:${lock.factSnapshotId}`));
    context.edges.push(edge(fromRef, `observation-snapshot:${lock.userObservationSnapshotId}`));
    context.edges.push(edge(fromRef, `artifact-lockfile:${lock.artifactLockfileHash}`));
    for (const [role, field] of [["requirementSpec", "requirementSpecHash"], ["priceSnapshot", "priceSnapshotHash"], ["simulationInput", "simulationInputHash"]]) {
      context.edges.push(edge(fromRef, `evaluation-external:${role}:${lock.snapshotHashes[field]}`));
    }
  }
  for (const [key, receipt] of authority.receipts) {
    const [planId, targetKey, receiptHash] = key.split("\u0000");
    const adapterSnapshot = receiptAdapterAuthority(authority, receipt);
    const adapterRuntimeGeneration = adapterSnapshot?.runtimeRegistry?.activeRuntimeGeneration;
    if (adapterSnapshot?.runtimeRegistry?.schemaVersion === "runtime-case-adapter-registry-binding-v2") {
      invariant(Number.isSafeInteger(adapterRuntimeGeneration) && adapterRuntimeGeneration >= 1
        && adapterRuntimeGeneration <= receipt.runtimeGeneration && receipt.runtimeGeneration <= runtimeGeneration,
      "authoritative evaluation receipt runtime generation is outside its adapter/current generation closure");
      if (receipt.target.kind === "draft") invariant(adapterRuntimeGeneration === receipt.runtimeGeneration,
        "authoritative draft evaluation receipt does not bind its active adapter generation");
    }
    if (receipt.evaluation?.kind === "topology-v3-progressive") {
      const evaluationLock = authority.locks.get(receipt.evaluationLock.contentHash);
      invariant(evaluationLock, "progressive evaluation lock authority is missing");
      const artifactLockfile = authority.lockfiles.get(evaluationLock.artifactLockfileHash);
      invariant(artifactLockfile, "progressive evaluation artifact lockfile authority is missing");
      const authorityErrors = validateProgressiveBuildEvaluationAuthorityRuntime(receipt.evaluation, {
        evaluationLock,
        artifactLockfile,
        ruleSetPayload: lockedEvaluationArtifact(authority, artifactLockfile, "ruleSet"),
        enginePayload: lockedEvaluationArtifact(authority, artifactLockfile, "engine"),
        adapterSnapshotPayload: lockedEvaluationArtifact(authority, artifactLockfile, "adapterSnapshot"),
      });
      invariant(authorityErrors.length === 0,
        `progressive evaluation executable authority is invalid: ${authorityErrors.join(", ")}`);
      invariant(receipt.configHash === receipt.evaluation.authority.configHash,
        "progressive evaluation config authority differs from its receipt");
      const priceExternal = authority.externals.get(`priceSnapshot\u0000${evaluationLock.snapshotHashes.priceSnapshotHash}`);
      invariant(priceExternal, "progressive evaluation price snapshot authority is missing");
      const priceProjection = projectProgressivePriceRuntime(receipt.evaluation.topologyBom, priceExternal.snapshot);
      invariant(priceProjection && sameAuthorityJson(priceProjection, receipt.evaluation.priceProjection),
        "progressive evaluation price projection differs from its locked snapshot");
    }
    const target = planAuthorityForEvaluation(planRecords, planId, receipt.target);
    invariant(target, "authoritative evaluation receipt plan target is missing or cross-plan");
    if (receipt.target.kind === "version") {
      invariant(receipt.configHash === target.version.configHash,
        "authoritative version evaluation receipt config does not match its immutable version");
      invariant(target.version.evaluationLock && typeof target.version.evaluationHash === "string"
        && typeof target.version.evaluatedAt === "string",
      "authoritative version evaluation receipt target lacks governed evaluation authority");
      // A replay may issue a later receipt, so its evaluatedAt is the replay
      // event time.  The immutable result identity and all replay inputs must
      // still be byte-for-byte the version's governed tuple.
      invariant(sameAuthorityJson(receipt.evaluationLock, target.version.evaluationLock)
        && receipt.evaluationHash === target.version.evaluationHash,
      "authoritative version evaluation receipt tuple does not match its immutable version");
    }
    const fromRef = `evaluation-receipt:${receiptHash}`;
    context.nodes.push(fromRef, `evaluation:${receipt.evaluationHash}`); context.pointers.push(fromRef);
    context.edges.push(edge(fromRef, `evaluation-lock:${receipt.evaluationLock.contentHash}`), edge(fromRef, target.ref), edge(fromRef, `evaluation:${receipt.evaluationHash}`));
    invariant(evaluationTargetKeyRuntime(receipt.target) === targetKey, "authoritative evaluation receipt target identity is invalid");
  }
  for (const [key, pointer] of authority.currents) {
    const [planId, targetKey] = key.split("\u0000");
    const receipt = authority.receipts.get(`${planId}\u0000${targetKey}\u0000${pointer.receiptHash}`);
    invariant(receipt && receipt.evaluationLock.contentHash === pointer.evaluationLockHash && receipt.evaluationHash === pointer.evaluationHash,
      "evaluation current pointer receipt/lock closure is missing or mismatched");
    const target = planAuthorityForEvaluation(planRecords, planId, pointer.target);
    invariant(target, "evaluation current pointer plan target is missing or cross-plan");
    const fromRef = `evaluation-current:${planId}:${targetKey}`;
    context.nodes.push(fromRef); context.pointers.push(fromRef);
    context.edges.push(edge(fromRef, `evaluation-receipt:${pointer.receiptHash}`), edge(fromRef, `evaluation-lock:${pointer.evaluationLockHash}`), edge(fromRef, target.ref));
  }
  for (const record of planRecords) {
    const match = /^([^/]+)\/versions\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    const version = match && validEnvelope(record.value, "1.0.0", "version") ? record.value.payload : null;
    if (!version?.evaluationLock) continue;
    const lock = authority.locks.get(version.evaluationLock.contentHash);
    invariant(lock && sameAuthorityJson(lock, version.evaluationLock) && lock.planId === version.planId
      && lock.snapshotHashes.configHash === version.configHash, "plan version evaluation lock authority is missing or mismatched");
    const issued = [...authority.receipts.values()].some((receipt) => receipt.planId === version.planId
      && receipt.configHash === version.configHash && receipt.evaluationHash === version.evaluationHash && receipt.evaluatedAt === version.evaluatedAt
      && sameAuthorityJson(receipt.evaluationLock, version.evaluationLock));
    invariant(issued, "plan version evaluation receipt authority is missing or mismatched");
  }
  return authority;
}

function sameAuthorityJson(left, right) {
  return sha256Json(left) === sha256Json(right);
}

/** Mirrors FactRepository's historical-snapshot validity interval check. */
function authorityEffectiveAt(value, timestamp) {
  try {
    const at = Date.parse(timestamp);
    const retrieved = Date.parse(value?.retrievedAt);
    const validFrom = value?.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value.validFrom);
    const validUntil = value?.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(value.validUntil);
    return Number.isFinite(at) && Number.isFinite(retrieved) && retrieved <= at
      && !Number.isNaN(validFrom) && !Number.isNaN(validUntil) && validFrom <= at && at <= validUntil;
  } catch { return false; }
}

async function validateFactRepository(records, context, evidenceRecords, observationRecords, evaluationSnapshotRecords = [], activeRoot) {
  const facts = new Map(); const conflicts = new Map(); const snapshots = [];
  const conflictHeadRevisions = new Map(); const conflictVersions = new Map(); const conflictPointers = new Map();
  const inferences = new Map(); const decisions = new Map(); const decisionMemories = new Map();
  const evaluationDiffs = new Map(); const transactions = new Map(); const planPointers = new Map(); const notices = new Map();
  const inferenceCandidates = new Map(); const inferenceApprovals = new Map();
  // A fact-update receipt is only a detached projection.  Its evaluator result
  // becomes authority solely when the immutable EvaluationLockRepository has
  // issued a matching receipt at this generation.
  const issuedEvaluations = evaluationSnapshotAuthorityIndex(evaluationSnapshotRecords).receipts;
  for (const record of records) {
    const relative = record.rootLogicalPath;
    const fact = /^records\/([^/]+)\.json$/.exec(relative);
    if (fact) {
      invariant(FACT_STORAGE_ID.test(fact[1]) && validEnvelope(record.value, "fact-repository-envelope-v1", "fact"), "fact envelope is invalid");
      const stored = record.value.payload;
      invariant(stored?.schemaVersion === "fact-repository-v1" && stored.revision === 0 && stored.fact?.factId === fact[1]
        && stored.recordHash === sha256Json(stored.fact) && validateFactRecordRuntime(stored.fact).length === 0 && verifyFactRecordRuntime(stored.fact),
      "fact authority payload is invalid");
      invariant(!facts.has(fact[1]), "fact repository contains duplicate fact authority");
      facts.set(fact[1], stored.fact); context.nodes.push(`fact:${fact[1]}`);
      continue;
    }
    const conflict = /^conflicts\/([^/]+)\.json$/.exec(relative);
    if (conflict) {
      invariant(FACT_STORAGE_ID.test(conflict[1]) && validEnvelope(record.value, "fact-repository-envelope-v1", "conflict"), "fact conflict envelope is invalid");
      const stored = record.value.payload;
      invariant(stored?.schemaVersion === "fact-repository-v1" && Number.isInteger(stored.revision) && stored.revision >= 0
        && stored.conflict?.conflictSetId === conflict[1] && stored.recordHash === sha256Json(stored.conflict)
        && validateConflictSetRuntime(stored.conflict).length === 0 && verifyConflictSetRuntime(stored.conflict),
      "fact conflict authority payload is invalid");
      // FactRepository only permits an initial open record.  The mutable
      // storage revision is the durable evidence that a resolved payload was
      // reached through that open-to-resolved CAS transition.
      invariant(stored.conflict.status !== "resolved" || stored.revision > 0,
        "fact conflict resolution lacks required open-to-resolved history");
      invariant(!conflicts.has(conflict[1]), "fact repository contains duplicate conflict authority");
      conflicts.set(conflict[1], stored.conflict); conflictHeadRevisions.set(conflict[1], stored.revision);
      context.nodes.push(`fact-conflict:${conflict[1]}`);
      continue;
    }
    const conflictVersion = /^conflict-versions\/([a-f0-9]{64})\.json$/.exec(relative);
    if (conflictVersion) {
      invariant(validEnvelope(record.value, "fact-repository-envelope-v1", "conflict"), "fact conflict version envelope is invalid");
      const stored = record.value.payload; const value = stored?.conflict;
      invariant(stored?.schemaVersion === "fact-repository-v1" && Number.isInteger(stored.revision) && stored.revision >= 0
        && value?.contentHash === conflictVersion[1] && stored.recordHash === sha256Json(value)
        && validateConflictSetRuntime(value).length === 0 && verifyConflictSetRuntime(value),
      "fact conflict version authority payload is invalid");
      invariant(!conflictVersions.has(conflictVersion[1]), "fact repository contains duplicate conflict version authority");
      conflictVersions.set(conflictVersion[1], { revision: stored.revision, conflict: value });
      context.nodes.push(`fact-conflict-version:${value.conflictSetId}@sha256:${value.contentHash}`);
      continue;
    }
    const conflictPointer = /^conflict-pointers\/([a-f0-9]{64})\.json$/.exec(relative);
    if (conflictPointer) {
      invariant(validEnvelope(record.value, "fact-repository-envelope-v1", "conflict-pointer"),
        "fact update conflict pointer envelope is invalid");
      const value = record.value.payload;
      invariant(validateFactUpdateConflictPointerRuntime(value, conflictPointer[1]).length === 0,
        "fact update conflict pointer authority payload is invalid");
      invariant(!conflictPointers.has(value.conflictSetId), "fact update conflict pointer is duplicated for one conflict");
      conflictPointers.set(value.conflictSetId, value);
      context.nodes.push(`fact-update-conflict-pointer:${value.conflictSetId}`);
      context.pointers.push(`fact-update-conflict-pointer:${value.conflictSetId}`);
      continue;
    }
    const snapshot = /^snapshots\/([^/]+)\.json$/.exec(relative);
    if (snapshot) {
      invariant(FACT_STORAGE_ID.test(snapshot[1]) && validEnvelope(record.value, "fact-repository-envelope-v1", "snapshot"), "fact snapshot envelope is invalid");
      const value = record.value.payload;
      invariant(value?.snapshotId === snapshot[1] && validateFactSnapshotRuntime(value).length === 0 && verifyFactSnapshotRuntime(value),
        "fact snapshot authority payload is invalid");
      snapshots.push(value); const ref = `fact-snapshot:${value.snapshotId}`;
      context.nodes.push(ref); context.pointers.push(ref);
      continue;
    }
    const inference = /^inferences\/(inference-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (inference) {
      invariant(validEnvelope(record.value, "fact-repository-envelope-v1", "inference"), "fact inference envelope is invalid");
      const value = record.value.payload;
      invariant(value?.inferenceTraceId === inference[1] && validateReplayableInferenceTraceRuntime(value).length === 0
        && verifyReplayableInferenceTraceRuntime(value), "fact inference authority payload is invalid");
      invariant(!inferences.has(inference[1]), "fact repository contains duplicate inference authority");
      inferences.set(inference[1], value); context.nodes.push(`fact-inference:${inference[1]}`);
      continue;
    }
    const inferenceCandidate = /^inference-candidates\/(fact-inference-candidate-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (inferenceCandidate) {
      const errors = validateFactInferenceCandidateEnvelopeRuntime(record.value, inferenceCandidate[1]);
      invariant(errors.length === 0, `fact inference candidate authority is invalid: ${errors.join(", ")}`);
      const value = record.value.payload;
      invariant(!inferenceCandidates.has(value.candidateId), "fact repository contains duplicate inference candidate authority");
      inferenceCandidates.set(value.candidateId, value);
      context.nodes.push(`fact-inference-candidate:${value.candidateId}`);
      context.pointers.push(`fact-inference-candidate:${value.candidateId}`);
      continue;
    }
    const inferenceApproval = /^inference-approval-transactions\/(inference-approval-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (inferenceApproval) {
      const errors = validateInferenceApprovalEnvelopeRuntime(record.value, inferenceApproval[1]);
      invariant(errors.length === 0, `fact inference approval authority is invalid: ${errors.join(", ")}`);
      const value = record.value.payload;
      invariant(!inferenceApprovals.has(value.transactionId), "fact repository contains duplicate inference approval authority");
      inferenceApprovals.set(value.transactionId, value);
      context.nodes.push(`fact-inference-approval:${value.transactionId}`);
      context.pointers.push(`fact-inference-approval:${value.transactionId}`);
      continue;
    }
    const decision = /^update-decisions\/records\/(update-decision-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (decision) {
      invariant(validEnvelope(record.value, "fact-update-decision-envelope-v1", "decision"), "fact update decision envelope is invalid");
      const value = record.value.payload;
      invariant(value?.updateDecisionId === decision[1] && validateUpdateDecisionRuntime(value).length === 0
        && verifyUpdateDecisionRuntime(value), "fact update decision authority payload is invalid");
      invariant(!decisions.has(decision[1]), "fact repository contains duplicate update decision authority");
      decisions.set(decision[1], value); context.nodes.push(`fact-update-decision:${decision[1]}`);
      continue;
    }
    const notice = /^update-decisions\/notices\/(fact-update-notice-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (notice) {
      invariant(validEnvelope(record.value, "fact-update-notice-envelope-v1", "notice"), "fact update notice envelope is invalid");
      const value = record.value.payload;
      invariant(value?.updateNoticeId === notice[1] && validateFactUpdateNoticeRuntime(value).length === 0
        && verifyFactUpdateNoticeRuntime(value), "fact update notice authority payload is invalid");
      invariant(!notices.has(notice[1]), "fact repository contains duplicate update notice authority");
      notices.set(notice[1], value); context.nodes.push(`fact-update-notice:${notice[1]}`);
      continue;
    }
    const decisionMemory = /^update-decisions\/memory\/([a-f0-9]{64})\.json$/.exec(relative);
    if (decisionMemory) {
      invariant(validEnvelope(record.value, "fact-update-decision-envelope-v1", "memory"), "fact update decision memory envelope is invalid");
      const value = record.value.payload;
      invariant(validateUpdateDecisionMemoryRuntime(value, decisionMemory[1]).length === 0,
        "fact update decision memory authority payload is invalid");
      invariant(!decisionMemories.has(decisionMemory[1]), "fact repository contains duplicate update decision memory authority");
      decisionMemories.set(decisionMemory[1], value); context.nodes.push(`fact-update-memory:${decisionMemory[1]}`); context.pointers.push(`fact-update-memory:${decisionMemory[1]}`);
      continue;
    }
    const evaluationDiff = /^update-decisions\/evaluation-diffs\/(fact-update-evaluation-diff-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (evaluationDiff) {
      invariant(validEnvelope(record.value, "fact-update-evaluation-diff-envelope-v1", "evaluation-diff"), "fact update evaluation diff envelope is invalid");
      const value = record.value.payload;
      invariant(value?.evaluationDiffId === evaluationDiff[1] && validateFactUpdateEvaluationDiffRuntime(value).length === 0
        && verifyFactUpdateEvaluationDiffRuntime(value), "fact update evaluation diff authority payload is invalid");
      invariant(!evaluationDiffs.has(evaluationDiff[1]), "fact repository contains duplicate update evaluation diff authority");
      evaluationDiffs.set(evaluationDiff[1], value); context.nodes.push(`fact-update-evaluation-diff:${evaluationDiff[1]}`);
      continue;
    }
    const planPointer = /^update-decisions\/plan-pointers\/([a-f0-9]{64})\.json$/.exec(relative);
    if (planPointer) {
      invariant(validEnvelope(record.value, "fact-update-plan-pointer-envelope-v1", "plan-pointer"), "fact update plan pointer envelope is invalid");
      const value = record.value.payload;
      invariant(validateFactUpdatePlanPointerRuntime(value, planPointer[1]).length === 0,
        "fact update plan pointer authority payload is invalid");
      invariant(!planPointers.has(value.planId), "fact update plan pointer is duplicated for one plan");
      planPointers.set(value.planId, value);
      context.nodes.push(`fact-update-plan-pointer:${value.planId}`); context.pointers.push(`fact-update-plan-pointer:${value.planId}`);
      continue;
    }
    const transaction = /^update-decisions\/transactions\/(update-decision-sha256-[a-f0-9]{64})\.json$/.exec(relative);
    if (transaction) {
      invariant(validEnvelope(record.value, "fact-update-decision-transaction-envelope-v1", "transaction"), "fact update decision transaction envelope is invalid");
      const value = record.value.payload;
      invariant(value?.decision?.updateDecisionId === transaction[1] && validateFactUpdateDecisionTransactionRuntime(value).length === 0
        && verifyFactUpdateDecisionTransactionRuntime(value), "fact update decision transaction authority payload is invalid");
      invariant(!transactions.has(transaction[1]), "fact repository contains duplicate update decision transaction authority");
      transactions.set(transaction[1], value);
      context.nodes.push(`fact-update-transaction:${value.transactionId}`, `fact-update-decision:${transaction[1]}`);
      continue;
    }
    if (relative.endsWith(".json")) throw new Error("facts repository contains an unrecognized JSON authority");
    throw new Error("facts repository contains an unrecognized authority path");
  }

  const conflictStaticAuthority = (value) => {
    const material = { ...value };
    delete material.status; delete material.resolutionFactIds; delete material.decisionIds;
    delete material.resolvedAt; delete material.contentHash;
    return material;
  };
  for (const [conflictSetId, head] of conflicts) {
    let physical = conflictVersions.get(head.contentHash);
    if (!physical) {
      // Legacy read compatibility is safe only for an unmodified open head.
      invariant(head.status === "open" && conflictHeadRevisions.get(conflictSetId) === 0,
        "resolved fact conflict is missing immutable version history");
      physical = { revision: 0, conflict: head };
      conflictVersions.set(head.contentHash, physical);
      context.nodes.push(`fact-conflict-version:${conflictSetId}@sha256:${head.contentHash}`);
    }
    invariant(physical.revision === conflictHeadRevisions.get(conflictSetId) && sameAuthorityJson(physical.conflict, head),
      "fact conflict physical head does not match its immutable version");
    const ownedVersions = [...conflictVersions.values()].filter((entry) => entry.conflict.conflictSetId === conflictSetId);
    const revisions = ownedVersions.map((entry) => entry.revision);
    invariant(ownedVersions.every((entry) => (entry.revision === 0 ? entry.conflict.status === "open" : entry.conflict.status === "resolved")
      && sameAuthorityJson(conflictStaticAuthority(entry.conflict), conflictStaticAuthority(head))),
    "fact conflict immutable version ownership or revision is invalid");
    invariant(new Set(revisions).size === revisions.length
      && ownedVersions.filter((entry) => entry.revision === 0 && entry.conflict.status === "open").length === 1,
    "fact conflict immutable history lacks one unique open predecessor");
  }
  for (const entry of conflictVersions.values()) {
    invariant(conflicts.has(entry.conflict.conflictSetId), "fact conflict version is orphaned from its current head");
  }
  for (const conflictSetId of conflictPointers.keys()) {
    invariant(conflicts.has(conflictSetId), "fact update conflict pointer is orphaned from its conflict authority");
  }

  const claims = evidenceClaimAuthorityIndex(evidenceRecords);
  const observations = observationStoredIndex(observationRecords);
  const artifactRepository = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
  for (const candidate of inferenceCandidates.values()) {
    const fromRef = `fact-inference-candidate:${candidate.candidateId}`;
    const references = inferenceCandidateReferencesRuntime(candidate);
    invariant(references, "fact inference candidate reference contract is invalid");
    for (const reference of candidate.trace.inputFactRefs) {
      invariant(facts.get(reference.factId)?.contentHash === reference.contentHash,
        "fact inference candidate input closure is missing or hash-mismatched");
    }
    const inspected = await inspectGovernedInferenceArtifactAtRoot({
      artifacts: artifactRepository,
      activeRoot,
      artifactRef: candidate.ruleArtifactRef,
      trace: candidate.trace,
    });
    invariant(inspected.ok && sameAuthorityJson(inspected.rule, candidate.rule),
      `fact inference candidate governed artifact closure is invalid${inspected.ok ? "" : `: ${inspected.reason}`}`);
    for (const reference of references) context.edges.push(edge(fromRef, reference.ref, reference.necessity));
    context.edges.push(edge(fromRef, inspected.implementationRef));
  }

  const deferredInferenceOutputs = new Set();
  const inferenceApprovalKeys = new Set();
  for (const transaction of inferenceApprovals.values()) {
    const candidate = inferenceCandidates.get(transaction.candidateId);
    invariant(candidate && candidate.contentHash === transaction.candidateHash
      && sameAuthorityJson(candidate.trace, transaction.trace)
      && sameAuthorityJson(candidate.proposedFact, transaction.fact),
    "fact inference approval candidate identity/hash/trace/fact closure is invalid");
    const authorityKey = `${transaction.candidateId}\u0000${transaction.candidateHash}`;
    invariant(!inferenceApprovalKeys.has(authorityKey), "fact inference trace/fact pair has duplicate approval transactions");
    inferenceApprovalKeys.add(authorityKey);
    const storedTrace = inferences.get(transaction.trace.inferenceTraceId);
    const storedFact = facts.get(transaction.fact.factId);
    if (transaction.status === "committed") {
      invariant(storedTrace && sameAuthorityJson(storedTrace, transaction.trace)
        && storedFact && sameAuthorityJson(storedFact, transaction.fact),
      "committed fact inference approval trace/fact closure is missing or mismatched");
    } else {
      invariant(!storedFact && (!storedTrace || sameAuthorityJson(storedTrace, transaction.trace)),
        "non-committed fact inference approval exposed an active fact or mismatched trace");
      deferredInferenceOutputs.add(transaction.trace.inferenceTraceId);
    }
    const fromRef = `fact-inference-approval:${transaction.transactionId}`;
    context.edges.push(edge(fromRef, `fact-inference-candidate:${transaction.candidateId}`));
    if (transaction.approvalAuthorityRef) {
      context.edges.push(edge(fromRef, transaction.approvalAuthorityRef, "required_for_replay"));
    }
    if (storedTrace) context.edges.push(edge(fromRef, `fact-inference:${storedTrace.inferenceTraceId}`));
    if (storedFact) context.edges.push(edge(fromRef, `fact:${storedFact.factId}`));
  }
  const factReplacements = new Set();
  for (const fact of facts.values()) {
    const fromRef = `fact:${fact.factId}`;
    if (fact.authority === "official" || fact.authority === "third_party") {
      for (const claimId of fact.evidenceRefs) {
        const claim = claims.get(claimId);
        invariant(claim && claim.authority === fact.authority && claim.fieldId === fact.field && claim.scope === fact.scope
          && factsRuntimeSubjectMatchesClaim(fact.subject, claim) && sameAuthorityJson(claim.value, fact.value) && claim.unit === fact.unit,
        "fact evidence claim closure is missing or semantically mismatched");
        context.edges.push(edge(fromRef, `evidence-claim:${claimId}`));
      }
    } else if (fact.authority === "user_observation") {
      for (const reference of fact.evidenceRefs) {
        const parsed = parseObservationReferenceRuntime(reference);
        const planId = factRuntimeRecord(fact.subject) && fact.subject.kind === "plan_subject" ? fact.subject.planId : null;
        const entry = parsed && planId ? observations.get(`${planId}\u0000${parsed.observationId}`) : null;
        const observation = entry?.stored.observation;
        invariant(parsed && observation && observation.contentHash === parsed.contentHash
          && factsRuntimeSubjectMatchesObservation(fact.subject, observation, sameAuthorityJson)
          && fact.field === observation.fieldId && sameAuthorityJson(fact.value, observation.value) && fact.unit === observation.unit,
        "fact user observation closure is missing or semantically mismatched");
        context.edges.push(edge(fromRef, `observation:${parsed.observationId}`));
      }
    } else {
      const trace = inferences.get(fact.inferenceTraceId);
      invariant(trace && trace.outputFactIds.includes(fact.factId)
        && trace.ruleOrModelVersion === fact.extractorOrRuleVersion
        && sameAuthorityJson(trace.assumptions, fact.assumptions ?? [])
        && sameAuthorityJson(trace.inputFactRefs.map((reference) => reference.factId).sort(), [...fact.derivedFromFactIds].sort()),
      "agent inference fact trace closure is missing or semantically mismatched");
      context.edges.push(edge(fromRef, `fact-inference:${fact.inferenceTraceId}`));
      for (const inputId of fact.derivedFromFactIds) {
        invariant(inputId !== fact.factId && facts.has(inputId), "agent inference fact dependency is missing or self-referential");
        context.edges.push(edge(fromRef, `fact:${inputId}`));
      }
    }
    if (fact.supersedesFactId !== undefined) {
      const old = facts.get(fact.supersedesFactId);
      invariant(old && old.contentHash === fact.supersededFactHash && old.status === "active"
        && sameAuthorityJson(old.subject, fact.subject) && old.field === fact.field && old.scope === fact.scope,
      "fact replacement closure is invalid");
      invariant(!factReplacements.has(old.factId), "fact has multiple immutable replacements");
      factReplacements.add(old.factId);
      context.edges.push(edge(fromRef, `fact:${old.factId}`));
    }
  }
  for (const trace of inferences.values()) {
    const fromRef = `fact-inference:${trace.inferenceTraceId}`;
    // Trace artifacts are replay authority. The artifacts provider validates
    // its manifest, metadata, blob length, and bytes; this required edge
    // makes an absent or swapped artifact fail the composed graph.
    context.edges.push(edge(fromRef, `sha256:${trace.ruleOrModelArtifactHash}`));
    for (const reference of trace.inputFactRefs) {
      const input = facts.get(reference.factId);
      invariant(input?.contentHash === reference.contentHash, "fact inference input closure is missing or hash-mismatched");
      context.edges.push(edge(fromRef, `fact:${reference.factId}`));
    }
    for (const factId of trace.outputFactIds) {
      const output = facts.get(factId);
      if (deferredInferenceOutputs.has(trace.inferenceTraceId)) {
        invariant(!output, "non-committed fact inference approval trace unexpectedly has an active output");
      } else {
        invariant(output?.authority === "agent_inference" && output.inferenceTraceId === trace.inferenceTraceId,
          "fact inference output closure is missing or semantically mismatched");
        context.edges.push(edge(fromRef, `fact:${factId}`));
      }
    }
  }
  for (const { conflict } of conflictVersions.values()) {
    const fromRef = `fact-conflict-version:${conflict.conflictSetId}@sha256:${conflict.contentHash}`;
    for (const factId of conflict.factIds) {
      const member = facts.get(factId);
      invariant(member && sameAuthorityJson(member.subject, conflict.subject) && member.field === conflict.field,
        "fact conflict member closure is missing or mismatched");
      context.edges.push(edge(fromRef, `fact:${factId}`));
    }
    for (const factId of conflict.resolutionFactIds) {
      const resolution = facts.get(factId);
      invariant(resolution && sameAuthorityJson(resolution.subject, conflict.subject) && resolution.field === conflict.field,
        "fact conflict resolution fact is missing or does not share subject and field ownership");
      context.edges.push(edge(fromRef, `fact:${factId}`));
    }
    const coveredResolutionFactIds = new Set();
    for (const decisionId of conflict.decisionIds) {
      const decision = decisions.get(decisionId);
      const ownedResolutionIds = decision
        ? conflict.resolutionFactIds.filter((factId) => decision.newFactIds.includes(factId)) : [];
      invariant(decision?.decision === "accept" && decision.subjectKey === sha256Json(conflict.subject)
        && decision.claimKey === conflict.field && ownedResolutionIds.length > 0
        && Date.parse(decision.decidedAt) >= Date.parse(conflict.createdAt)
        && Date.parse(decision.decidedAt) <= Date.parse(conflict.resolvedAt),
      "fact conflict update decision is missing or does not own the resolved subject/field closure");
      for (const factId of ownedResolutionIds) coveredResolutionFactIds.add(factId);
      context.edges.push(edge(fromRef, `fact-update-decision:${decisionId}`));
    }
    invariant(coveredResolutionFactIds.size === conflict.resolutionFactIds.length,
      "fact conflict resolution facts are not covered by accepted update decisions");
  }
  for (const snapshot of snapshots) {
    const fromRef = `fact-snapshot:${snapshot.snapshotId}`;
    const snapshotFacts = new Map();
    for (const reference of snapshot.factRefs) {
      const fact = facts.get(reference.factId);
      invariant(fact?.contentHash === reference.contentHash, "fact snapshot record closure is missing or hash-mismatched");
      invariant(authorityEffectiveAt(fact, snapshot.createdAt), "fact snapshot contains a fact outside its effective interval");
      if (fact.authority === "official" || fact.authority === "third_party") {
        for (const claimId of fact.evidenceRefs) {
          const claim = claims.get(claimId);
          invariant(claim && authorityEffectiveAt(claim, snapshot.createdAt),
            "fact snapshot contains an evidence claim outside its effective interval");
        }
      }
      snapshotFacts.set(reference.factId, fact);
      context.edges.push(edge(fromRef, `fact:${reference.factId}`));
    }
    for (const reference of snapshot.conflictRefs) {
      const conflict = conflictVersions.get(reference.contentHash)?.conflict;
      invariant(conflict?.conflictSetId === reference.conflictSetId, "fact snapshot conflict closure is missing or hash-mismatched");
      invariant(conflict.status === "open" && conflict.factIds.every((factId) => snapshotFacts.has(factId)),
        "fact snapshot conflict is not open over the complete selected fact closure");
      context.edges.push(edge(fromRef, `fact-conflict-version:${reference.conflictSetId}@sha256:${reference.contentHash}`));
    }
    // A selected active set cannot silently contain competing assertions for
    // one exact subject/field.  The repository historically allowed callers
    // to omit a ConflictSet; backup/Doctor/restore must not turn that omission
    // into an apparently replayable snapshot.  Duplicate facts carrying the
    // same value are harmless, but every distinct value+unit in the group must
    // be represented by one open conflict pinned by this snapshot.
    const groups = new Map();
    for (const fact of snapshotFacts.values()) {
      const key = sha256Json({ subject: fact.subject, field: fact.field });
      const group = groups.get(key) ?? { facts: [], values: new Set() };
      group.facts.push(fact);
      group.values.add(sha256Json({ value: fact.value, unit: fact.unit === undefined ? null : fact.unit }));
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.values.size < 2) continue;
      const groupFactIds = group.facts.map((fact) => fact.factId).sort(compare);
      const covered = snapshot.conflictRefs.some((reference) => {
        const conflict = conflictVersions.get(reference.contentHash)?.conflict;
        if (!conflict || conflict.conflictSetId !== reference.conflictSetId || conflict.status !== "open"
          || !sameAuthorityJson(conflict.subject, group.facts[0].subject)
          || conflict.field !== group.facts[0].field || conflict.factIds.some((factId) => !snapshotFacts.has(factId))) return false;
        const conflictFactIds = [...conflict.factIds].sort(compare);
        // Match FactRepository.ensureSnapshotConflictClosure exactly: a
        // conflict that only covers the distinct values but omits a selected
        // same-value assertion is not a complete authority closure.
        if (conflictFactIds.length !== groupFactIds.length
          || conflictFactIds.some((factId, index) => factId !== groupFactIds[index])) return false;
        const conflictValues = new Set(conflict.factIds.map((factId) => {
          const fact = snapshotFacts.get(factId);
          return fact && sha256Json({ value: fact.value, unit: fact.unit === undefined ? null : fact.unit });
        }));
        return [...group.values].every((value) => conflictValues.has(value));
      });
      invariant(covered, "fact snapshot contains conflicting selected values without a complete open ConflictSet closure");
    }
  }
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const decisionReplacements = new Set();
  const decisionMemoryKey = (decision) => sha256Json({
    subjectKey: decision.subjectKey, claimKey: decision.claimKey, revision: decision.revision, planIds: [...decision.planIds].sort(),
  });
  const decisionSnapshot = (reference, label) => {
    const snapshot = snapshotsById.get(reference.snapshotId);
    invariant(snapshot?.contentHash === reference.contentHash, `fact update decision ${label} snapshot closure is missing or hash-mismatched`);
    return snapshot;
  };
  for (const notice of notices.values()) {
    const fromRef = `fact-update-notice:${notice.updateNoticeId}`;
    const oldSnapshot = decisionSnapshot(notice.oldSnapshotRef, "notice old");
    const newSnapshot = decisionSnapshot(notice.newSnapshotRef, "notice new");
    invariant(validateFactUpdateNoticeClosureRuntime(notice, oldSnapshot, newSnapshot, facts).length === 0,
      "fact update notice fact/snapshot authority closure is invalid");
    context.edges.push(edge(fromRef, `plan:${notice.planId}`),
      edge(fromRef, `fact-snapshot:${oldSnapshot.snapshotId}`), edge(fromRef, `fact-snapshot:${newSnapshot.snapshotId}`));
    for (const reference of [...notice.oldFactRefs, ...notice.newFactRefs]) {
      context.edges.push(edge(fromRef, `fact:${reference.factId}`));
    }
    if (notice.previousDecisionRef) {
      const previous = decisions.get(notice.previousDecisionRef.updateDecisionId);
      invariant(previous?.contentHash === notice.previousDecisionRef.contentHash,
        "fact update notice previous decision closure is missing or hash-mismatched");
      context.edges.push(edge(fromRef, `fact-update-decision:${previous.updateDecisionId}`));
    }
  }
  const transactionByDiffId = new Map(); const conflictTransitionByDecision = new Map();
  const addDecisionTransactionEdges = (transaction) => {
    const decision = transaction.decision;
    const transactionRef = `fact-update-transaction:${transaction.transactionId}`;
    const decisionRef = `fact-update-decision:${decision.updateDecisionId}`;
    const oldSnapshot = decisionSnapshot(decision.oldSnapshotRef, "transaction old");
    const newSnapshot = decisionSnapshot(decision.newSnapshotRef, "transaction new");
    invariant(validateUpdateDecisionFactClosureRuntime(decision, oldSnapshot, newSnapshot, facts).length === 0,
      "fact update decision fact/snapshot authority closure is invalid");
    context.edges.push(edge(transactionRef, decisionRef), edge(transactionRef, `fact-snapshot:${oldSnapshot.snapshotId}`), edge(transactionRef, `fact-snapshot:${newSnapshot.snapshotId}`));
    for (const planId of decision.planIds) context.edges.push(edge(transactionRef, `plan:${planId}`));
    for (const transition of transaction.conflictTransitions) {
      const conflictSetId = transition.pointer.conflictSetId;
      const transitionKey = `${decision.updateDecisionId}\u0000${conflictSetId}`;
      invariant(!conflictTransitionByDecision.has(transitionKey), "fact conflict transition is duplicated across transactions");
      const before = conflictVersions.get(transition.before.contentHash);
      const after = conflictVersions.get(transition.after.contentHash);
      invariant(before && after && sameAuthorityJson(before.conflict, transition.before)
        && sameAuthorityJson(after.conflict, transition.after),
      "fact update transaction conflict versions are missing or hash-mismatched");
      conflictTransitionByDecision.set(transitionKey, transition);
      context.nodes.push(`fact-update-conflict-pointer:${conflictSetId}`);
      context.edges.push(
        edge(transactionRef, `fact-update-conflict-pointer:${conflictSetId}`),
        edge(transactionRef, `fact-conflict-version:${conflictSetId}@sha256:${transition.before.contentHash}`),
        edge(transactionRef, `fact-conflict-version:${conflictSetId}@sha256:${transition.after.contentHash}`),
      );
    }
    for (const diff of transaction.evaluationDiffs) {
      const persisted = evaluationDiffs.get(diff.evaluationDiffId);
      invariant(persisted && sameAuthorityJson(persisted, diff), "fact update transaction diff authority is missing or hash-mismatched");
      invariant(!transactionByDiffId.has(diff.evaluationDiffId), "fact update evaluation diff is referenced by multiple transactions");
      transactionByDiffId.set(diff.evaluationDiffId, transaction);
      const diffRef = `fact-update-evaluation-diff:${diff.evaluationDiffId}`;
      context.edges.push(edge(transactionRef, diffRef), edge(diffRef, decisionRef), edge(diffRef, `plan:${diff.planId}`));
      for (const receipt of [diff.before, diff.after]) {
        // Evaluation locks are only supplied by the persisted snapshots
        // authority.  Do not manufacture their nodes here: that would let a
        // checksum-correct update receipt mask a missing lock/artifact root.
        const issued = [...issuedEvaluations.entries()].find(([, candidate]) => candidate.planId === receipt.planId
          && sameAuthorityJson(candidate.target, receipt.target) && candidate.configHash === receipt.configHash
          && candidate.evaluationHash === receipt.evaluationHash && sameAuthorityJson(candidate.evaluationLock, receipt.evaluationLock));
        invariant(issued, "fact update evaluation diff has no matching issued evaluation receipt authority");
        const receiptHash = issued[0].split("\u0000")[2];
        context.nodes.push(`evaluation:${receipt.evaluationHash}`);
        context.edges.push(
          edge(diffRef, `fact-snapshot:${receipt.factSnapshotId}`), edge(diffRef, `evaluation-lock:${receipt.evaluationLock.contentHash}`),
          edge(diffRef, `evaluation:${receipt.evaluationHash}`), edge(diffRef, `evaluation-receipt:${receiptHash}`),
        );
      }
    }
  };
  for (const transaction of transactions.values()) addDecisionTransactionEdges(transaction);
  for (const diffId of evaluationDiffs.keys()) invariant(transactionByDiffId.has(diffId), "fact update evaluation diff is orphaned from a prepared transaction");
  for (const [decisionId, decision] of decisions) {
    const transaction = transactions.get(decisionId);
    invariant(transaction && sameAuthorityJson(transaction.decision, decision), "published fact update decision has no matching recovery transaction");
  }
  for (const decision of decisions.values()) {
    const fromRef = `fact-update-decision:${decision.updateDecisionId}`;
    const oldSnapshot = decisionSnapshot(decision.oldSnapshotRef, "old");
    const newSnapshot = decisionSnapshot(decision.newSnapshotRef, "new");
    invariant(validateUpdateDecisionFactClosureRuntime(decision, oldSnapshot, newSnapshot, facts).length === 0,
      "fact update decision fact/snapshot authority closure is invalid");
    context.edges.push(edge(fromRef, `fact-snapshot:${oldSnapshot.snapshotId}`), edge(fromRef, `fact-snapshot:${newSnapshot.snapshotId}`));
    const transaction = transactions.get(decision.updateDecisionId);
    invariant(transaction && sameAuthorityJson(transaction.decision, decision), "published fact update decision has no matching recovery transaction");
    context.edges.push(edge(fromRef, `fact-update-transaction:${transaction.transactionId}`));
    for (const diff of transaction.evaluationDiffs) context.edges.push(edge(fromRef, `fact-update-evaluation-diff:${diff.evaluationDiffId}`));
    if (decision.supersedesDecisionId !== undefined) {
      const old = decisions.get(decision.supersedesDecisionId);
      invariant(old && old.contentHash === decision.supersedesDecisionHash && old.memoryRevision === decision.memoryRevision - 1
        && decisionMemoryKey(old) === decisionMemoryKey(decision), "fact update decision supersession closure is invalid");
      invariant(!decisionReplacements.has(old.updateDecisionId), "fact update decision has multiple immutable replacements");
      decisionReplacements.add(old.updateDecisionId);
      context.edges.push(edge(fromRef, `fact-update-decision:${old.updateDecisionId}`));
    }
  }
  const reachedDecisions = new Set();
  for (const [memoryKey, memory] of decisionMemories) {
    const decision = decisions.get(memory.decisionId);
    invariant(decision && decision.contentHash === memory.decisionHash && decision.memoryRevision === memory.revision
      && decisionMemoryKey(decision) === memoryKey, "fact update decision memory closure is invalid");
    const selected = selectedFactSnapshotRefRuntime(decision);
    invariant(selected && sameAuthorityJson(selected, memory.selectedSnapshotRef), "fact update decision selected snapshot closure is invalid");
    decisionSnapshot(memory.selectedSnapshotRef, "selected");
    context.edges.push(edge(`fact-update-memory:${memoryKey}`, `fact-update-decision:${decision.updateDecisionId}`));
    context.edges.push(edge(`fact-update-memory:${memoryKey}`, `fact-snapshot:${memory.selectedSnapshotRef.snapshotId}`));
    const chain = new Set(); let current = decision;
    while (current) {
      invariant(!chain.has(current.updateDecisionId), "fact update decision supersession contains a cycle");
      chain.add(current.updateDecisionId); reachedDecisions.add(current.updateDecisionId);
      current = current.supersedesDecisionId === undefined ? null : decisions.get(current.supersedesDecisionId);
      if (current) invariant(decisionMemoryKey(current) === memoryKey, "fact update decision chain crosses memory identities");
    }
  }
  const activeDecision = (decisionId, decisionHash, memoryKey) => {
    const memory = decisionMemories.get(memoryKey);
    return memory?.decisionId === decisionId && memory.decisionHash === decisionHash;
  };
  const currentConflictTransitionKeys = new Set();
  const effectiveConflictHeads = new Map();
  for (const [conflictSetId, physicalHead] of conflicts) {
    const pointer = conflictPointers.get(conflictSetId);
    if (!pointer) {
      effectiveConflictHeads.set(conflictSetId, physicalHead);
      if (physicalHead.status === "resolved") {
        invariant(physicalHead.decisionIds.every((decisionId) => {
          const decision = decisions.get(decisionId);
          return decision && activeDecision(decisionId, decision.contentHash, decisionMemoryKey(decision));
        }), "fact conflict resolution decision is not an active committed memory head");
      }
      context.edges.push(edge(`fact-conflict:${conflictSetId}`,
        `fact-conflict-version:${conflictSetId}@sha256:${physicalHead.contentHash}`));
      continue;
    }
    const decision = decisions.get(pointer.decisionId);
    const transitionKey = `${pointer.decisionId}\u0000${conflictSetId}`;
    const transition = conflictTransitionByDecision.get(transitionKey);
    const selected = conflictVersions.get(pointer.selectedConflictRef.contentHash)?.conflict;
    const previousState = conflictVersions.get(pointer.previousConflictRef.contentHash)?.conflict;
    invariant(decision && decision.contentHash === pointer.decisionHash
      && decisionMemoryKey(decision) === pointer.decisionMemoryKey
      && transition && sameAuthorityJson(transition.pointer, pointer)
      && selected?.conflictSetId === conflictSetId && previousState?.conflictSetId === conflictSetId,
    "fact update conflict pointer transaction/decision/version closure is invalid");
    const previousDecision = pointer.previousDecisionId === undefined ? undefined : decisions.get(pointer.previousDecisionId);
    if (pointer.revision > 0) {
      let cursor = transition;
      while (cursor.pointer.revision > 0) {
        const cursorKey = `${cursor.pointer.decisionId}\u0000${conflictSetId}`;
        currentConflictTransitionKeys.add(cursorKey);
        const predecessorKey = `${cursor.pointer.previousDecisionId}\u0000${conflictSetId}`;
        const predecessor = conflictTransitionByDecision.get(predecessorKey);
        const predecessorDecision = decisions.get(cursor.pointer.previousDecisionId);
        invariant(predecessorDecision?.contentHash === cursor.pointer.previousDecisionHash
          && predecessor && predecessor.pointer.revision === cursor.pointer.revision - 1
          && predecessor.pointer.selectedConflictRef.contentHash === cursor.pointer.previousConflictRef.contentHash,
        "fact update conflict pointer CAS predecessor closure is invalid");
        cursor = predecessor;
      }
      currentConflictTransitionKeys.add(`${cursor.pointer.decisionId}\u0000${conflictSetId}`);
    } else if (pointer.previousDecisionId !== undefined) {
      // Read compatibility for a conflict resolved by the former direct CAS
      // path: the first decision-bound pointer may be an undo of that active
      // accepted resolution.
      invariant(decision.decision === "undo" && previousDecision?.decision === "accept"
        && previousDecision.contentHash === pointer.previousDecisionHash
        && physicalHead.contentHash === pointer.previousConflictRef.contentHash,
      "initial undo conflict pointer has no exact legacy accepted predecessor");
    } else {
      invariant(decision.decision === "accept" && physicalHead.contentHash === pointer.previousConflictRef.contentHash,
        "initial accept conflict pointer has no exact open predecessor");
    }
    currentConflictTransitionKeys.add(transitionKey);
    const currentCommitted = activeDecision(pointer.decisionId, pointer.decisionHash, pointer.decisionMemoryKey);
    let effective;
    if (currentCommitted) {
      effective = selected;
    } else if (previousDecision) {
      invariant(activeDecision(previousDecision.updateDecisionId, previousDecision.contentHash, decisionMemoryKey(previousDecision)),
        "fact update conflict pointer has no active recovery predecessor");
      effective = previousState;
    } else {
      invariant(pointer.revision === 0 && previousState.status === "open",
        "fact update conflict pointer recovery revision is invalid");
      effective = previousState;
    }
    if (effective.status === "resolved") {
      invariant(effective.decisionIds.every((decisionId) => {
        const resolving = decisions.get(decisionId);
        return resolving && activeDecision(decisionId, resolving.contentHash, decisionMemoryKey(resolving));
      }), "effective fact conflict resolution is not owned by the active accepted decision");
    }
    effectiveConflictHeads.set(conflictSetId, effective);
    const pointerRef = `fact-update-conflict-pointer:${conflictSetId}`;
    context.edges.push(
      edge(pointerRef, `fact-update-decision:${pointer.decisionId}`),
      edge(pointerRef, `fact-conflict-version:${conflictSetId}@sha256:${pointer.selectedConflictRef.contentHash}`),
      edge(pointerRef, `fact-conflict-version:${conflictSetId}@sha256:${pointer.previousConflictRef.contentHash}`),
      edge(`fact-conflict:${conflictSetId}`, `fact-conflict-version:${conflictSetId}@sha256:${effective.contentHash}`),
    );
    if (previousDecision) context.edges.push(edge(pointerRef, `fact-update-decision:${previousDecision.updateDecisionId}`));
  }
  for (const [transitionKey, transition] of conflictTransitionByDecision) {
    const decision = decisions.get(transition.pointer.decisionId);
    if (decision && activeDecision(decision.updateDecisionId, decision.contentHash, decisionMemoryKey(decision))) {
      invariant(currentConflictTransitionKeys.has(transitionKey),
        "active fact conflict transition has no current recoverable pointer chain");
    }
  }
  for (const [planId, pointer] of planPointers) {
    const decision = decisions.get(pointer.decisionId);
    const previous = pointer.previousDecisionId === undefined ? undefined : decisions.get(pointer.previousDecisionId);
    invariant(decision && validateFactUpdatePlanPointerClosureRuntime(pointer, decision, previous).length === 0,
      "fact update plan pointer decision/snapshot closure is invalid");
    const selected = decisionSnapshot(pointer.selectedSnapshotRef, "plan pointer selected");
    const before = decisionSnapshot(pointer.previousSnapshotRef, "plan pointer previous");
    const fromRef = `fact-update-plan-pointer:${planId}`;
    context.edges.push(edge(fromRef, `plan:${planId}`), edge(fromRef, `fact-update-decision:${decision.updateDecisionId}`),
      edge(fromRef, `fact-snapshot:${selected.snapshotId}`), edge(fromRef, `fact-snapshot:${before.snapshotId}`));
    if (previous) context.edges.push(edge(fromRef, `fact-update-decision:${previous.updateDecisionId}`));
    // A pointer may be durably prepared before its decision memory commits.
    // In that recovery state it is read as the prior snapshot only; a
    // non-initial prepared pointer must therefore retain a committed prior
    // decision.  This mirrors getSelectedSnapshotForPlanAtRoot without
    // treating a crash window as repository corruption.
    if (!reachedDecisions.has(decision.updateDecisionId)) {
      if (previous) invariant(reachedDecisions.has(previous.updateDecisionId),
        "fact update plan pointer has no committed recovery predecessor");
      else invariant(pointer.revision === 0, "fact update plan pointer recovery revision is invalid");
    }
  }
  for (const decisionId of decisions.keys()) invariant(reachedDecisions.has(decisionId) || transactions.has(decisionId),
    "fact update decision authority is neither current nor recoverably prepared");
}

function validateExecutionRecord(record, context, generation, planRecords = [], observationRecords = []) {
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
      && [
        `sha256:${stored.replayContext.dependencyContext?.evaluatorArtifactHash}`,
        `evaluation-artifact:${stored.replayContext.dependencyContext?.evaluatorArtifactHash}`,
      ].includes(refs.evaluatorArtifactRef)
      && stored.replayContext.procedure?.procedureId === session.procedureId
      && stored.replayContext.procedure?.inputEvaluationHash === session.evaluationHash
      && stored.replayContext.procedure?.procedureSafetyHash === session.procedureSafetyHash, "execution replay closure is invalid");
    const destructiveActions = session.destructiveActionConfirmations ?? [];
    invariant(Array.isArray(destructiveActions), "execution destructive action confirmations are invalid");
    invariant(new Set(destructiveActions.map((action) => action?.actionId)).size === destructiveActions.length,
      "execution destructive action confirmation IDs are not unique");
    for (const action of destructiveActions) {
      invariant(validateDestructiveActionPlanShapeRuntime(action).length === 0 && action.confirmation === "confirmed"
        && action.inputPlanVersionId === session.planVersionId
        && action.inputProcedureSafetyHash === session.procedureSafetyHash,
      "execution destructive action confirmation closure is invalid");
      const version = ownedPlanVersion(planRecords, action.inputPlanId, action.inputPlanVersionId);
      const revisionHash = sha256Utf8Runtime(`buildsim:plan-version-revision-v1:${canonicalJson({
        planId: action.inputPlanId,
        planVersionId: action.inputPlanVersionId,
        configHash: action.inputConfigHash,
      })}`);
      invariant(version && version.configHash === action.inputConfigHash && revisionHash === action.inputPlanRevisionHash,
        "execution destructive action plan/version authority is invalid");
      const observations = observationStoredIndex(observationRecords);
      const observationSnapshot = version?.evaluationLock
        ? observationSnapshotAuthorityIndex(observationRecords).get(`${action.inputPlanId}\u0000${version.evaluationLock.userObservationSnapshotId}`)
        : null;
      invariant(observationSnapshot, "execution destructive action locked observation snapshot is missing");
      for (const [index, diskInstanceId] of action.diskInstanceIds.entries()) {
        const instance = version.config?.components?.find((component) => component?.instanceId === diskInstanceId && component.kind === "storage_drive");
        const observation = observations.get(`${action.inputPlanId}\u0000${action.locatorObservationIds[index]}`)?.stored?.observation;
        invariant(instance && observation?.status === "active" && observation.confirmedByUser === true
          && typeof observation.validatedAt === "string" && observation.invalidatedAt === undefined
          && observation.fieldId === "storage.disk_locator" && observation.subjectRef?.kind === "instance"
          && observation.subjectRef.instanceId === diskInstanceId
          && observation.observedAgainstConfigHash === action.inputConfigHash
          && observation.subjectRevisionHash === legacySha256Runtime(instance)
          && observationSnapshot.observationIds.includes(observation.observationId),
        "execution destructive action disk locator authority is invalid");
      }
    }
    const fromRef = `execution-session:${session.executionSessionId}`;
    context.nodes.push(fromRef, refs.procedureRef, refs.procedureSafetyRef); context.pointers.push(fromRef);
    for (const ref of required) context.edges.push(edge(fromRef, ref));
    for (const result of session.results) for (const id of result.observationIds ?? []) context.edges.push(edge(fromRef, `observation:${id}`));
    for (const action of destructiveActions) {
      const actionRefs = destructiveActionPlanReferencesRuntime(action);
      invariant(actionRefs, "execution destructive action references are invalid");
      for (const item of actionRefs) context.edges.push(edge(fromRef, item.ref, item.necessity));
    }
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
  const domain = /^domain\/(captures|observations|history|targets|events|schedules|event-idempotency)\/([^/]+)\.json$/.exec(relative);
  if (domain) {
    const kind = ({ captures: "capture", observations: "observation", history: "history", targets: "target", events: "event", schedules: "schedule", "event-idempotency": "event-idempotency" })[domain[1]];
    const value = record.value;
    invariant(exactObjectFields(value, ["schemaVersion", "kind", "revision", "payloadHash", "checksum", "payload"])
      && value.schemaVersion === "price-repository-v1" && value.kind === kind
      && Number.isInteger(value.revision) && value.revision >= 0 && value.payloadHash === sha256Json(value.payload)
      && value.checksum === sha256Json({ schemaVersion: value.schemaVersion, kind: value.kind, revision: value.revision, payloadHash: value.payloadHash, payload: value.payload }), "price domain envelope/hash is invalid");
    const payload = value.payload; const idField = ({ capture: "listingCaptureId", observation: "observationId", history: "historyPointId", target: "targetId", event: "eventId", schedule: "scheduleId" })[kind];
    if (idField) invariant(payload?.[idField] === domain[2], "price domain path identity is invalid");
    if (kind === "capture") invariant(validateImmutableListingCaptureRuntime(payload).length === 0, "price listing capture semantics are invalid");
    else if (kind === "observation") invariant(validatePriceObservationRuntime(payload).length === 0, "price observation semantics are invalid");
    else if (kind === "history") invariant(validatePriceHistoryPointRuntime(payload).length === 0, "price history semantics are invalid");
    else if (kind === "target") invariant(validatePriceTargetRuntime(payload).length === 0, "price target semantics are invalid");
    else if (kind === "event") invariant(validatePriceTargetEventRuntime(payload).length === 0, "price target event semantics are invalid");
    else if (kind === "schedule") invariant(validateJobScheduleRuntime(payload).length === 0, "price schedule semantics are invalid");
    else if (kind === "event-idempotency") {
      invariant(exactObjectFields(payload, ["schemaVersion", "idempotencyHash", "eventId", "eventHash", "createdAt"])
        && payload.schemaVersion === "price-event-idempotency-v1" && SHA256.test(String(payload.idempotencyHash ?? ""))
        && payload.idempotencyHash === domain[2] && SAFE_ID.test(String(payload.eventId ?? "")) && SHA256.test(String(payload.eventHash ?? ""))
        && iso(payload.createdAt), "price event idempotency semantics are invalid");
    }
    const refs = { capture: `price-capture:${domain[2]}`, observation: `price-observation:${domain[2]}`, history: `price-history:${domain[2]}`, target: `price-target:${domain[2]}`, event: `price-target-event:${domain[2]}`, schedule: `price-schedule:${domain[2]}`, "event-idempotency": `price-event-idempotency:${domain[2]}` };
    if (refs[kind]) context.nodes.push(refs[kind]);
    if (kind === "capture" && payload.sourceListingCaptureId) {
      context.edges.push(edge(refs.capture, `legacy-price-capture:${payload.sourceListingCaptureId}`));
    }
    if (kind === "observation") context.edges.push(edge(refs.observation, `price-capture:${payload.listingCaptureId}`));
    if (kind === "observation") for (const evidenceRef of payload.sellerTierEvidenceRefs) context.edges.push(edge(refs.observation, evidenceRef));
    if (kind === "history") {
      for (const id of payload.observationIds ?? []) context.edges.push(edge(refs.history, `price-observation:${id}`));
      context.edges.push(edge(refs.history, `price-snapshot:${payload.snapshotId}`));
    }
    if (kind === "target") context.edges.push(edge(refs.target, `plan:${payload.planId}`));
    if (kind === "event") {
      context.edges.push(edge(refs.event, `price-target:${payload.targetId}`));
      context.edges.push(edge(refs.event, `price-snapshot:${payload.priceSnapshotId}`));
    }
    if (kind === "schedule") context.edges.push(edge(refs.schedule, payload.subjectRef));
    if (kind === "event-idempotency") context.edges.push(edge(refs["event-idempotency"], `price-target-event:${payload.eventId}`));
    if (["target", "schedule"].includes(kind)) context.pointers.push(refs[kind]);
    return;
  }
  if (relative === "domain/rollback/manifest.json") {
    const value = record.value;
    invariant(exactObjectFields(value, ["schemaVersion", "kind", "revision", "payloadHash", "checksum", "payload"])
      && value.schemaVersion === "price-repository-v1" && value.kind === "rollback-manifest"
      && Number.isInteger(value.revision) && value.revision >= 0
      && value.payloadHash === sha256Json(value.payload)
      && value.checksum === sha256Json({ schemaVersion: value.schemaVersion, kind: value.kind, revision: value.revision, payloadHash: value.payloadHash, payload: value.payload })
      && exactObjectFields(value.payload, ["schemaVersion", "entries"])
      && value.payload.schemaVersion === "price-rollback-manifest-v1" && Array.isArray(value.payload.entries)
      && value.payload.entries.every((entry) => exactObjectFields(entry, ["targetId", "fromRevision", "toRevision", "previousHash", "createdAt"])
        && SAFE_ID.test(String(entry.targetId ?? "")) && Number.isInteger(entry.fromRevision) && entry.fromRevision >= 0
        && entry.toRevision === entry.fromRevision + 1 && SHA256.test(String(entry.previousHash ?? "")) && iso(entry.createdAt)), "price rollback manifest is invalid");
    context.nodes.push("price-domain-rollback-manifest");
    return;
  }
  const rollback = /^domain\/rollback\/targets\/([^/]+)\/(\d{12})\.json$/.exec(relative);
  if (rollback) {
    const value = record.value; const payload = value?.payload;
    invariant(exactObjectFields(value, ["schemaVersion", "kind", "revision", "payloadHash", "checksum", "payload"])
      && value.schemaVersion === "price-repository-v1" && value.kind === "rollback" && Number.isInteger(value.revision) && value.revision >= 0
      && value.payloadHash === sha256Json(payload)
      && value.checksum === sha256Json({ schemaVersion: value.schemaVersion, kind: value.kind, revision: value.revision, payloadHash: value.payloadHash, payload })
      && exactObjectFields(payload, ["schemaVersion", "targetId", "fromRevision", "toRevision", "previousHash", "previous", "createdAt"])
      && payload.schemaVersion === "price-target-rollback-v1" && payload.targetId === rollback[1]
      && Number(payload.fromRevision) === Number(rollback[2]) && Number.isInteger(payload.fromRevision) && payload.fromRevision >= 0
      && payload.toRevision === payload.fromRevision + 1 && SHA256.test(String(payload.previousHash ?? ""))
      && payload.previousHash === sha256Json(payload.previous) && validatePriceTargetRuntime(payload.previous).length === 0
      && payload.previous.targetId === payload.targetId && iso(payload.createdAt), "price rollback record is invalid");
    const ref = `price-target-rollback:${payload.targetId}:${payload.fromRevision}`;
    context.nodes.push(ref); context.edges.push(edge("price-domain-rollback-manifest", ref, "optional_for_audit"));
    return;
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
  const domainPayloads = (directory, kind) => records
    .filter((record) => record.rootLogicalPath.startsWith(`domain/${directory}/`) && record.rootLogicalPath.endsWith(".json") && record.value?.kind === kind)
    .map((record) => record.value.payload);
  const captures = domainPayloads("captures", "capture");
  const observations = domainPayloads("observations", "observation");
  const histories = domainPayloads("history", "history");
  const targets = domainPayloads("targets", "target");
  const events = domainPayloads("events", "event");
  const schedules = domainPayloads("schedules", "schedule");
  const eventIndices = domainPayloads("event-idempotency", "event-idempotency");
  const captureById = new Map(captures.map((capture) => [capture.listingCaptureId, capture]));
  const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const targetById = new Map(targets.map((target) => [target.targetId, target]));
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const runtimeSnapshotIds = new Set(records
    .filter((record) => record.rootLogicalPath === "latest.json" || record.rootLogicalPath === "current.json" || /^snapshots\/[^/]+\.json$/.test(record.rootLogicalPath))
    .map((record) => record.value?.snapshotId ?? (typeof record.value?.contentHash === "string" ? `legacy-${record.value.contentHash}` : null))
    .filter(Boolean));
  invariant(captureById.size === captures.length && observationById.size === observations.length
    && targetById.size === targets.length && eventById.size === events.length, "price domain identities are not unique");
  for (const capture of captures) {
    if (!capture.sourceListingCaptureId) continue;
    const source = byPath.get(`listing-captures/${capture.sourceListingCaptureId}.json`)?.value;
    invariant(source?.contentHash === capture.sourceListingCaptureContentHash,
      "price listing capture source closure is missing or changed");
  }
  for (const observation of observations) {
    invariant(validatePriceObservationClosureRuntime(observation, captureById.get(observation.listingCaptureId)).length === 0,
      "price observation/listing capture closure is invalid");
  }
  for (const history of histories) {
    invariant(validatePriceHistoryClosureRuntime(history, history.observationIds.map((id) => observationById.get(id))).length === 0,
      "price history/observation closure is invalid");
    invariant(runtimeSnapshotIds.has(history.snapshotId),
      "price history snapshot closure is missing");
  }
  const historyHeads = new Map();
  for (const history of histories) {
    const key = JSON.stringify([history.skuId, [...history.variantIdentityFactIds].sort(), history.condition, history.region, history.currency, history.priceBasis, history.bucketStart, history.bucketEnd]);
    const current = historyHeads.get(key);
    if (!current || history.observationIds.length > current.observationIds.length
      || (history.observationIds.length === current.observationIds.length && history.historyPointId > current.historyPointId)) historyHeads.set(key, history);
  }
  for (const history of historyHeads.values()) context.pointers.push(`price-history:${history.historyPointId}`);
  const rollbackRecords = records.filter((record) => /^domain\/rollback\/targets\/[^/]+\/\d{12}\.json$/.test(record.rootLogicalPath));
  const rollbacksByTarget = new Map();
  for (const record of rollbackRecords) {
    const rollback = record.value.payload; const list = rollbacksByTarget.get(rollback.targetId) ?? [];
    list.push(rollback); rollbacksByTarget.set(rollback.targetId, list);
  }
  const manifest = byPath.get("domain/rollback/manifest.json")?.value?.payload;
  const manifestEntries = manifest?.entries ?? [];
  invariant((rollbackRecords.length === 0) === (manifestEntries.length === 0), "price rollback manifest/record coverage is invalid");
  const manifestKeys = manifestEntries.map((entry) => `${entry.targetId}\0${entry.fromRevision}\0${entry.toRevision}\0${entry.previousHash}\0${entry.createdAt}`);
  const rollbackKeys = rollbackRecords.map(({ value }) => {
    const item = value.payload; return `${item.targetId}\0${item.fromRevision}\0${item.toRevision}\0${item.previousHash}\0${item.createdAt}`;
  });
  invariant(new Set(manifestKeys).size === manifestKeys.length && [...manifestKeys].sort().join("\n") === [...rollbackKeys].sort().join("\n"),
    "price rollback manifest does not exactly cover rollback records");
  const validTargetRevisionHashes = new Map();
  for (const target of targets) {
    const envelope = byPath.get(`domain/targets/${target.targetId}.json`)?.value;
    const rollbacks = [...(rollbacksByTarget.get(target.targetId) ?? [])].sort((left, right) => left.fromRevision - right.fromRevision);
    invariant(envelope && envelope.revision === rollbacks.length
      && rollbacks.every((item, index) => item.fromRevision === index && item.toRevision === index + 1)
      && rollbacks.every((item, index) => index === 0 || item.previousHash !== rollbacks[index - 1].previousHash)
      && (rollbacks.length === 0 || rollbacks.at(-1).toRevision === envelope.revision), "price target revision/rollback chain is invalid");
    validTargetRevisionHashes.set(target.targetId, new Set([target.revisionHash, ...rollbacks.map((item) => item.previous.revisionHash)]));
  }
  for (const event of events) {
    invariant(targetById.has(event.targetId) && validTargetRevisionHashes.get(event.targetId)?.has(event.targetRevisionHash),
      "price target event references an unknown target revision");
    invariant(runtimeSnapshotIds.has(event.priceSnapshotId),
      "price target event snapshot closure is missing");
  }
  const indexByEventId = new Map();
  for (const index of eventIndices) {
    const event = eventById.get(index.eventId);
    invariant(event && index.eventHash === sha256Json(event) && index.idempotencyHash === sha256Utf8Runtime(`buildsim-price-event\0${event.idempotencyKey.normalize("NFC")}`),
      "price event idempotency closure is invalid");
    invariant(!indexByEventId.has(index.eventId), "price event has duplicate idempotency indices"); indexByEventId.set(index.eventId, index);
  }
  invariant(events.every((event) => indexByEventId.has(event.eventId)), "price event is missing its idempotency index");
  for (const schedule of schedules) {
    if (schedule.jobType === "price_target_recheck") invariant(targetById.has(schedule.subjectRef.slice("price-target:".length)), "price schedule target closure is missing");
  }
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
  const rollback = /^rollback\/(job-[a-f0-9]{64})\/([0-9]{12})\.json$/.exec(relative);
  if (rollback) {
    invariant(validEnvelope(record.value, "job-store-envelope-v1", "job-rollback"), "job rollback envelope is invalid");
    const value = record.value.payload;
    invariant(value?.schemaVersion === "job-rollback-v1" && value.toRevision === value.fromRevision + 1
      && value.previous?.jobId === rollback[1] && value.previous?.revision === value.fromRevision
      && String(value.fromRevision).padStart(12, "0") === rollback[2]
      && value.previousChecksum === sha256Json(value.previous)
      && validateRuntimeBackgroundJob(value.previous, { maxRuntimeGenerationExclusive: generation + 1 }).length === 0,
    "job rollback record is invalid"); return;
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
  const proposal = /^governed-proposals\/(agent-proposal-[a-f0-9]{64})\.json$/.exec(relative);
  if (proposal) {
    const errors = validateGovernedAgentProposalEnvelopeRuntime(record.value, proposal[1]);
    invariant(errors.length === 0, `governed Agent proposal is invalid: ${errors.join(", ")}`);
    const value = record.value.payload;
    const ref = `agent-proposal:${value.proposalId}`;
    context.nodes.push(ref); context.pointers.push(ref);
    const references = governedAgentProposalReferencesRuntime(value);
    invariant(references, "governed Agent proposal reference contract is invalid");
    for (const reference of references) context.edges.push(edge(ref, reference.ref, reference.necessity));
    return;
  }
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
  throw new Error("Agent repository contains an unrecognized authority path");
}

function governedAgentProposalAuthorityIndex(records) {
  const proposals = new Map();
  for (const record of records) {
    const match = /^governed-proposals\/(agent-proposal-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (!match) continue;
    const errors = validateGovernedAgentProposalEnvelopeRuntime(record.value, match[1]);
    invariant(errors.length === 0, `governed Agent proposal is invalid: ${errors.join(", ")}`);
    invariant(!proposals.has(match[1]), "governed Agent proposal authority is duplicated");
    proposals.set(match[1], record.value.payload);
  }
  return proposals;
}

function factConflictVersionAuthorityIndex(records) {
  const conflicts = new Map();
  for (const record of records) {
    const head = /^conflicts\/([^/]+)\.json$/.exec(record.rootLogicalPath);
    const version = /^conflict-versions\/[a-f0-9]{64}\.json$/.exec(record.rootLogicalPath);
    if (!head && !version) continue;
    if (!validEnvelope(record.value, "fact-repository-envelope-v1", "conflict")) continue;
    const stored = record.value.payload; const conflict = stored?.conflict;
    if (stored?.schemaVersion !== "fact-repository-v1" || !Number.isInteger(stored.revision) || stored.revision < 0
      || !conflict || stored.recordHash !== sha256Json(conflict)
      || validateConflictSetRuntime(conflict).length || !verifyConflictSetRuntime(conflict)
      || (head && conflict.conflictSetId !== head[1])) continue;
    conflicts.set(`${conflict.conflictSetId}\0${conflict.contentHash}`, conflict);
  }
  return conflicts;
}

function productFactSubjectMatchesClaim(fact, claim) {
  if (fact?.subject?.kind !== "product") return false;
  const keys = ["skuId", "familyId", "modelId", "variantId", "revision", "region"];
  const factSubject = Object.fromEntries(keys.filter((key) => fact.subject[key] !== undefined).map((key) => [key, fact.subject[key]]));
  const claimSubject = Object.fromEntries(keys.filter((key) => claim.subject[key] !== undefined).map((key) => [key, claim.subject[key]]));
  return sha256Json(factSubject) === sha256Json(claimSubject);
}

function validateGovernedAgentProposalRepository(agentRecords, evidenceRecords, factRecords) {
  const proposals = governedAgentProposalAuthorityIndex(agentRecords);
  const claims = evidenceClaimAuthorityIndex(evidenceRecords);
  const candidates = evidenceClaimCandidateAuthorityIndex(evidenceRecords);
  const thirdPartyCandidates = thirdPartyClaimCandidateAuthorityIndex(evidenceRecords);
  const bindingProposals = evidenceBindingProposalAuthorityIndex(evidenceRecords);
  const evidence = evidenceAuthorityIndex(evidenceRecords);
  const facts = factAuthorityIndex(factRecords);
  const conflicts = factConflictVersionAuthorityIndex(factRecords);
  for (const proposal of proposals.values()) {
    const payload = proposal.payload;
    if (proposal.action === "archive_official_evidence") {
      const candidate = candidates.get(payload.candidateId);
      const claim = claims.get(payload.activeClaimId);
      const promotedCapture = evidence.captures.get(payload.captureId);
      const originalCapture = evidence.captures.get(payload.originalCaptureId);
      const promotedIdentity = promotedCapture?.productIdentities?.find((identity) => identity.basis === "official-document-explicit"
        && evidenceIdentityMatchesClaimSubjectRuntime(identity, claim?.subject, claim?.scope));
      const candidateClaimMaterial = candidate ? { ...candidate.claim, source: { ...candidate.claim.source, captureId: payload.captureId } } : null;
      if (candidateClaimMaterial) { delete candidateClaimMaterial.claimId; delete candidateClaimMaterial.contentHash; }
      const activeClaimMaterial = claim ? { ...claim } : null;
      if (activeClaimMaterial) { delete activeClaimMaterial.claimId; delete activeClaimMaterial.contentHash; }
      invariant(candidate && candidate.planId === proposal.planId && candidate.contentHash === payload.candidateHash
        && candidate.originalCaptureId === payload.originalCaptureId
        && candidate.promotion.confirmationId === payload.promotionConfirmationId
        && claim && claim.status === "active" && claim.authority === "official"
        && claim.contentHash === payload.activeClaimHash && claim.scope === payload.scope
        && sha256Json(claim.subject) === sha256Json(payload.subject)
        && claim.source.documentId === payload.documentId
        && claim.source.documentSha256 === payload.documentSha256
        && claim.source.captureId === payload.captureId
        && promotedCapture?.documentId === payload.documentId && promotedCapture.id !== originalCapture?.id
        && originalCapture?.id === candidate.originalCaptureId && originalCapture.documentId === payload.documentId
        && promotedIdentity && canonicalJson(candidateClaimMaterial) === canonicalJson(activeClaimMaterial),
      "official evidence proposal candidate/claim/capture identity/hash/authority closure is invalid");
      continue;
    }
    if (proposal.action === "propose_fact_update") {
      const claim = claims.get(payload.claimCandidateId);
      invariant(claim && claim.status === "active" && claim.contentHash === payload.claimCandidateHash
        && claim.authority === payload.claimAuthority && claim.fieldId === payload.claimFieldId
        && sha256Json(claim.subject) === sha256Json(payload.claimSubject),
      "fact update proposal claim identity/hash/subject closure is invalid");
      if (payload.sourceCandidateId) {
        const candidate = thirdPartyCandidates.get(payload.sourceCandidateId);
        const promotedCapture = evidence.captures.get(claim.source.captureId);
        const originalCapture = evidence.captures.get(candidate?.originalCaptureId);
        const explicitIdentity = promotedCapture?.productIdentities?.find((identity) => identity.basis === "third-party-document-explicit"
          && evidenceIdentityMatchesClaimSubjectRuntime(identity, claim.subject, claim.scope));
        const candidateClaimMaterial = candidate ? { ...candidate.claim, source: { ...candidate.claim.source, captureId: claim.source.captureId } } : null;
        if (candidateClaimMaterial) { delete candidateClaimMaterial.claimId; delete candidateClaimMaterial.contentHash; }
        const activeClaimMaterial = { ...claim }; delete activeClaimMaterial.claimId; delete activeClaimMaterial.contentHash;
        invariant(candidate && candidate.planId === proposal.planId && candidate.contentHash === payload.sourceCandidateHash
          && claim.authority === "third_party" && originalCapture?.id === candidate.originalCaptureId
          && originalCapture.documentId === claim.source.documentId && originalCapture.acquisitionMethod === "third-party-fetch"
          && promotedCapture?.id !== originalCapture.id && promotedCapture?.documentId === claim.source.documentId
          && promotedCapture.acquisitionMethod === "third-party-fetch" && promotedCapture.kindBasis === "content-verified"
          && explicitIdentity && canonicalJson(candidateClaimMaterial) === canonicalJson(activeClaimMaterial),
        "third-party fact update proposal candidate/claim/capture authority closure is invalid");
      }
      if (payload.targetFactId) {
        const target = facts.get(payload.targetFactId);
        invariant(target && target.contentHash === payload.targetFactHash && target.field === claim.fieldId
          && productFactSubjectMatchesClaim(target, claim),
        "fact update proposal target identity/hash/subject closure is invalid");
      }
      continue;
    }
    if (proposal.action === "bind_fact_evidence") {
      const source = proposals.get(payload.factUpdateProposalId);
      const claim = claims.get(payload.evidenceClaimId);
      const binding = bindingProposals.get(payload.bindingProposalId);
      let bindingOwnsClaim = false;
      if (source?.payload?.sourceCandidateId) {
        bindingOwnsClaim = binding?.proposal.claimCandidateIds.includes(source.payload.sourceCandidateId) === true;
      } else if (claim && binding) {
        const activeMaterial = { ...claim }; delete activeMaterial.claimId; delete activeMaterial.contentHash;
        for (const candidateId of binding.proposal.claimCandidateIds.filter((candidateId) => candidateId.startsWith("claim-candidate-sha256-"))) {
          const candidate = candidates.get(candidateId);
          const candidateMaterial = candidate ? { ...candidate.claim, source: { ...candidate.claim.source, captureId: claim.source.captureId } } : null;
          if (candidateMaterial) { delete candidateMaterial.claimId; delete candidateMaterial.contentHash; }
          if (candidateMaterial && canonicalJson(candidateMaterial) === canonicalJson(activeMaterial)) { bindingOwnsClaim = true; break; }
        }
      }
      invariant(source && source.action === "propose_fact_update" && source.planId === proposal.planId
        && source.contentHash === payload.factUpdateProposalHash
        && claim && claim.status === "active" && claim.contentHash === payload.evidenceClaimHash
        && source.payload.claimCandidateId === claim.claimId
        && binding && binding.proposal.planId === proposal.planId && binding.proposal.contentHash === payload.bindingProposalHash
        && bindingOwnsClaim,
      "fact evidence binding proposal authority closure is invalid");
      continue;
    }
    const conflict = conflicts.get(`${payload.conflictSetId}\0${payload.conflictSetHash}`);
    invariant(conflict && conflict.status === "open", "fact conflict resolution proposal authority closure is invalid");
    if (payload.resolution === "select_existing") {
      const selected = facts.get(payload.selectedFactId);
      invariant(selected && selected.contentHash === payload.selectedFactHash && conflict.factIds.includes(selected.factId),
        "fact conflict resolution selected fact closure is invalid");
    }
  }
  return proposals;
}

const CATALOG_FACTS_MIGRATION_ID = "catalog-facts-v1";
const CATALOG_FACTS_MANIFEST_PATH = `${CATALOG_FACTS_MIGRATION_ID}/manifest.json`;

function exactMigrationShape(value, allowed, required = allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function migrationText(value, maxLength = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value === value.normalize("NFC");
}

function migrationRelativePath(value) {
  return migrationText(value, 512) && !path.posix.isAbsolute(value)
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function catalogFactsPlanHash(manifest) {
  return sha256Json({
    schemaVersion: "catalog-facts-v1-plan", migrationId: manifest.migrationId, sourceHash: manifest.sourceHash,
    catalogHash: manifest.catalogHash, constraintsHash: manifest.constraintsHash, manuals: manifest.manuals,
    formal: manifest.formal, legacyUnverified: manifest.legacyUnverified,
  });
}

/**
 * Verifies the migration's internal source plan and every durable authority it
 * created.  The migration writer is intentionally not imported here: restore
 * and Doctor must validate hostile staged bytes with no source-tree trust.
 */
function validateCatalogFactsMigrationClosure(records, context, factRecords, evidenceRecords) {
  const record = records.find((candidate) => candidate.rootLogicalPath === CATALOG_FACTS_MANIFEST_PATH);
  if (!record) return;
  const manifest = record.value;
  const baseAllowed = ["schemaVersion", "migrationId", "status", "sourceHash", "planHash", "catalogHash", "constraintsHash", "manuals", "formal", "legacyUnverified", "claims", "facts", "appliedAt", "manifestHash"];
  const rolledBackAllowed = [...baseAllowed, "rolledBackAt", "previousManifestHash"];
  invariant(exactMigrationShape(manifest, manifest?.status === "rolled_back" ? rolledBackAllowed : baseAllowed), "catalog facts migration manifest has unknown or missing fields");
  invariant(manifest.schemaVersion === "catalog-facts-v1-manifest" && manifest.migrationId === CATALOG_FACTS_MIGRATION_ID
    && ["applied", "rolled_back"].includes(manifest.status), "catalog facts migration manifest identity/status is invalid");
  invariant(SHA256.test(String(manifest.sourceHash ?? "")) && SHA256.test(String(manifest.planHash ?? ""))
    && SHA256.test(String(manifest.catalogHash ?? "")) && SHA256.test(String(manifest.constraintsHash ?? ""))
    && SHA256.test(String(manifest.manifestHash ?? "")) && iso(manifest.appliedAt), "catalog facts migration manifest hash/time fields are invalid");
  invariant(manifest.manifestHash === sha256Json(without(manifest, "manifestHash")), "catalog facts migration manifest hash is invalid");
  if (manifest.status === "rolled_back") {
    invariant(iso(manifest.rolledBackAt) && SHA256.test(String(manifest.previousManifestHash ?? "")), "catalog facts migration rollback fields are invalid");
    const previous = { ...manifest, status: "applied" };
    delete previous.manifestHash; delete previous.rolledBackAt; delete previous.previousManifestHash;
    invariant(manifest.previousManifestHash === sha256Json(previous), "catalog facts migration previous manifest hash is invalid");
  }
  invariant(Array.isArray(manifest.manuals) && manifest.manuals.length > 0
    && manifest.manuals.every((manual) => exactMigrationShape(manual, ["file", "sha256"])
      && migrationRelativePath(manual.file) && SHA256.test(String(manual.sha256 ?? "")))
    && new Set(manifest.manuals.map((manual) => manual.file)).size === manifest.manuals.length, "catalog facts migration manuals are invalid");
  invariant(manifest.sourceHash === sha256Json({ catalogHash: manifest.catalogHash, constraintsHash: manifest.constraintsHash, manuals: manifest.manuals }),
    "catalog facts migration source hash is invalid");
  invariant(manifest.planHash === catalogFactsPlanHash(manifest), "catalog facts migration plan hash is invalid");

  const formalKeys = ["constraintId", "fieldId", "unit", "valueHash", "sourceFile", "page", "skuId"];
  invariant(Array.isArray(manifest.formal) && manifest.formal.length > 0 && manifest.formal.every((item) => exactMigrationShape(item, formalKeys, formalKeys.filter((key) => key !== "unit"))
    && migrationText(item.constraintId, 256) && migrationText(item.fieldId, 256) && (item.unit === undefined || migrationText(item.unit, 64))
    && SHA256.test(String(item.valueHash ?? "")) && migrationRelativePath(item.sourceFile) && Number.isSafeInteger(item.page) && item.page > 0 && migrationText(item.skuId, 256))
    // One source constraint may deliberately emit several governed fields
    // (for example width/depth/height).  The durable authority key is the
    // constraint/field pair, not constraintId alone.
    && new Set(manifest.formal.map((item) => `${item.constraintId}\u0000${item.fieldId}`)).size === manifest.formal.length,
  "catalog facts migration formal authority is invalid");
  const legacyKeys = ["skuId", "attrName", "valueHash", "classification", "reason"];
  invariant(Array.isArray(manifest.legacyUnverified) && manifest.legacyUnverified.every((item) => exactMigrationShape(item, legacyKeys)
    && migrationText(item.skuId, 256) && migrationText(item.attrName, 256) && SHA256.test(String(item.valueHash ?? ""))
    && ["legacy_unverified", "planning_or_inferred"].includes(item.classification) && migrationText(item.reason, 1024))
    && new Set(manifest.legacyUnverified.map((item) => `${item.skuId}\u0000${item.attrName}`)).size === manifest.legacyUnverified.length,
  "catalog facts migration legacy classification is invalid");
  const claimKeys = ["claimId", "contentHash", "documentId", "captureId"];
  const factKeys = ["factId", "contentHash", "claimId"];
  invariant(Array.isArray(manifest.claims) && manifest.claims.length === manifest.formal.length
    && manifest.claims.every((item) => exactMigrationShape(item, claimKeys)
      && /^claim-sha256-[a-f0-9]{64}$/.test(String(item.claimId ?? "")) && SHA256.test(String(item.contentHash ?? ""))
      && item.claimId === `claim-sha256-${item.contentHash}` && /^doc-sha256-[a-f0-9]{64}$/.test(String(item.documentId ?? ""))
      && /^capture-sha256-[a-f0-9]{64}$/.test(String(item.captureId ?? "")))
    && new Set(manifest.claims.map((item) => item.claimId)).size === manifest.claims.length, "catalog facts migration claim inventory is invalid");
  invariant(Array.isArray(manifest.facts) && manifest.facts.length === manifest.formal.length
    && manifest.facts.every((item) => exactMigrationShape(item, factKeys)
      && FACT_STORAGE_ID.test(String(item.factId ?? "")) && SHA256.test(String(item.contentHash ?? ""))
      && /^claim-sha256-[a-f0-9]{64}$/.test(String(item.claimId ?? "")))
    && new Set(manifest.facts.map((item) => item.factId)).size === manifest.facts.length
    && new Set(manifest.facts.map((item) => item.claimId)).size === manifest.facts.length, "catalog facts migration fact inventory is invalid");

  const documents = evidenceAuthorityIndex(evidenceRecords).documents;
  const captures = evidenceAuthorityIndex(evidenceRecords).captures;
  const claims = evidenceClaimAuthorityIndex(evidenceRecords);
  const facts = factAuthorityIndex(factRecords);
  const migrationRef = `migration:${CATALOG_FACTS_MIGRATION_ID}`;
  context.nodes.push(migrationRef);
  if (manifest.status === "applied") context.pointers.push(migrationRef);
  const necessity = manifest.status === "applied" ? "required_for_replay" : "optional_for_audit";
  const claimById = new Map(manifest.claims.map((item) => [item.claimId, item]));
  const factByClaim = new Map(manifest.facts.map((item) => [item.claimId, item]));
  const formalClaimIds = new Set();
  for (const formal of manifest.formal) {
    const matching = manifest.claims.filter((item) => {
      const claim = claims.get(item.claimId);
      return claim?.authority === "official" && claim.status === "active" && claim.subject.skuId === formal.skuId
        && claim.fieldId === formal.fieldId && claim.unit === formal.unit && sha256Json(claim.value) === formal.valueHash
        && claim.source.locator?.page === formal.page && claim.source.locator?.field === formal.constraintId;
    });
    invariant(matching.length === 1, "catalog facts migration formal claim closure is missing or ambiguous");
    formalClaimIds.add(matching[0].claimId);
  }
  invariant(formalClaimIds.size === manifest.formal.length,
    "catalog facts migration formal claims do not bind one-to-one to the source plan");
  for (const entry of manifest.claims) {
    const claim = claims.get(entry.claimId);
    const document = documents.get(entry.documentId);
    const capture = captures.get(entry.captureId);
    invariant(claim?.contentHash === entry.contentHash && claim.source.documentId === entry.documentId && claim.source.captureId === entry.captureId
      && document?.id === entry.documentId && document.sha256 === claim.source.documentSha256 && capture?.id === entry.captureId
      && capture.documentId === entry.documentId && manifest.manuals.some((manual) => manual.sha256 === document.sha256),
    "catalog facts migration claim/evidence closure is missing or hash-mismatched");
    context.edges.push(edge(migrationRef, `evidence-claim:${entry.claimId}`, necessity));
    context.edges.push(edge(migrationRef, `evidence-document:${entry.documentId}`, necessity));
    context.edges.push(edge(migrationRef, `evidence-capture:${entry.captureId}`, necessity));
  }
  for (const entry of manifest.facts) {
    const fact = facts.get(entry.factId); const claim = claims.get(entry.claimId);
    invariant(claimById.has(entry.claimId) && factByClaim.has(entry.claimId)
      && fact?.contentHash === entry.contentHash && fact.authority === "official" && fact.status === "active"
      && Array.isArray(fact.evidenceRefs) && fact.evidenceRefs.length === 1 && fact.evidenceRefs[0] === entry.claimId
      && claim && factsRuntimeSubjectMatchesClaim(fact.subject, claim) && fact.field === claim.fieldId && fact.scope === claim.scope
      && fact.unit === claim.unit && sameAuthorityJson(fact.value, claim.value), "catalog facts migration fact/claim closure is missing or semantically mismatched");
    context.edges.push(edge(migrationRef, `fact:${entry.factId}`, necessity));
  }
}

function validateMigrationRecord(record) {
  // The governed U3 marker is itself an authority.  Do not permit an
  // unvalidated sidecar to become a hidden source of migration state merely
  // because it does not end in `.json`.
  if (record.rootLogicalPath.startsWith(`${CATALOG_FACTS_MIGRATION_ID}/`)) {
    invariant(record.rootLogicalPath === CATALOG_FACTS_MANIFEST_PATH,
      "catalog facts migration contains an unrecognized authority path");
    return;
  }
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
  if (/^plan-agent-context\/[A-Za-z0-9][A-Za-z0-9._:-]{7,119}\.json$/.test(relative)) {
    const expectedRunId = pathId(relative);
    const errors = validatePlanAgentRunContextAuditEnvelopeRuntime(record.value, expectedRunId);
    invariant(errors.length === 0, `plan Agent context audit is invalid: ${errors.join(", ")}`);
    const ref = `plan-agent-context:${record.value.payload.runId}`; context.nodes.push(ref);
    const references = planAgentRunContextAuditReferencesRuntime(record.value.payload);
    invariant(references, "plan Agent context audit reference contract is invalid");
    for (const reference of references) {
      if (reference.ref.startsWith("evaluation:")) context.nodes.push(reference.ref);
      context.edges.push(edge(ref, reference.ref, reference.necessity));
    }
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
  if (root === "facts") {
    const [evidenceRecords, observationRecords, evaluationSnapshotRecords] = await Promise.all([
      recordsFor(activeRoot, "evidence"), recordsFor(activeRoot, "observations"),
      recordsFor(activeRoot, "snapshots"),
    ]);
    await validateFactRepository(records, context, evidenceRecords, observationRecords, evaluationSnapshotRecords, activeRoot);
    return;
  }
  if (root === "observations") {
    const attachmentRecords = await recordsFor(activeRoot, "attachments");
    validateObservationRepository(records, context, attachmentAuthorityIndex(attachmentRecords));
    return;
  }
  if (root === "snapshots") {
    const [factRecords, observationRecords, planRecords] = await Promise.all([
      recordsFor(activeRoot, "facts"), recordsFor(activeRoot, "observations"), recordsFor(activeRoot, "plans"),
    ]);
    validateEvaluationSnapshotRepository(records, context, factRecords, observationRecords, planRecords, generation);
    return;
  }
  if (root === "migrations") {
    for (const record of records) validateMigrationRecord(record);
    const [factRecords, evidenceRecords] = await Promise.all([
      recordsFor(activeRoot, "facts"), recordsFor(activeRoot, "evidence"),
    ]);
    validateCatalogFactsMigrationClosure(records, context, factRecords, evidenceRecords);
    return;
  }
  if (root === "agent") {
    const [evidenceRecords, factRecords] = await Promise.all([
      recordsFor(activeRoot, "evidence"), recordsFor(activeRoot, "facts"),
    ]);
    for (const record of records) validateAgentRecord(record, context);
    validateGovernedAgentProposalRepository(records, evidenceRecords, factRecords);
    return;
  }
  if (root === "artifacts") {
    if (!records.length) return;
    const [planRecords, factRecords, evidenceRecords, jobRecords, auditRecords] = await Promise.all([
      recordsFor(activeRoot, "plans"), recordsFor(activeRoot, "facts"), recordsFor(activeRoot, "evidence"),
      recordsFor(activeRoot, "jobs"), recordsFor(activeRoot, "audit"),
    ]);
    const closure = await validateProvisionalCaseAdapterProductionClosureAtRoot({
      activeRoot, artifactRecords: records, planRecords, factRecords, evidenceRecords, jobRecords, auditRecords,
      runtimeGeneration: generation,
    });
    context.nodes.push(...closure.nodes); context.edges.push(...closure.edges); context.pointers.push(...closure.pointers);
    const factSnapshots = factRecords.flatMap((record) => {
      const match = /^snapshots\/([^/]+)\.json$/.exec(record.rootLogicalPath);
      return match && validEnvelope(record.value, "fact-repository-envelope-v1", "snapshot")
        ? [record.value.payload] : [];
    });
    const solverClosure = await validateSolverProductionClosureAtRoot({
      activeRoot,
      factSnapshots,
      facts: [...factAuthorityIndex(factRecords).values()],
      evidenceClaims: [...evidenceClaimAuthorityIndex(evidenceRecords).values()],
    });
    context.nodes.push(...solverClosure.nodes); context.edges.push(...solverClosure.edges); context.pointers.push(...solverClosure.pointers);
    const recommendationClosure = await validateRecommendationProductionClosureAtRoot({
      activeRoot,
      runtimeGeneration: generation,
    });
    context.nodes.push(...recommendationClosure.nodes);
    context.edges.push(...recommendationClosure.edges);
    context.pointers.push(...recommendationClosure.pointers);
    return;
  }
  if (root === "execution-sessions") {
    const [planRecords, observationRecords] = await Promise.all([
      recordsFor(activeRoot, "plans"), recordsFor(activeRoot, "observations"),
    ]);
    for (const record of records) validateExecutionRecord(record, context, generation, planRecords, observationRecords);
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
    else if (root === "catalog-overlays") validateCatalogOverlayRecord(record, context);
    else if (root === "domain-overlays") validateDomainOverlayRecord(record, context);
    else if (root === "prices") validatePriceRecord(record, context);
    else if (root === "jobs") validateJobRecord(record, context, generation);
    else if (root === "transactions") validateTransactionRecord(record, context);
    else if (root === "audit") {
      if (!validateDomainAuditRecord(record, context)) validateAuditRecord(record, context);
    }
  }
  if (root === "attachments") {
    attachmentAuthorityIndex(records);
    validateStagedAttachmentRepository(records);
  }
  if (root === "evidence") {
    const [migrationRecords, auditRecords, artifactRecords, jobRecords] = await Promise.all([
      recordsFor(activeRoot, "migrations"), recordsFor(activeRoot, "audit"), recordsFor(activeRoot, "artifacts"),
      recordsFor(activeRoot, "jobs"),
    ]);
    validateEvidenceRepositoryClosure(records, context, migrationRecords, auditRecords, artifactRecords, jobRecords);
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
