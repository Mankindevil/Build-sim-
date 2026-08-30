import { createHash } from "node:crypto";
import { hashPlanConfigRuntime, validatePlanConfigRuntime } from "../plans/canonical-runtime.mjs";
import { applyScenarioTopologyPatchRuntime, validateScenarioPatchAuthority } from "../scenarios/runtime-validation.mjs";
import {
  validateGovernedFacetPredicateRuntime,
  validateGovernedFacetValueRuntime,
  governedFacetSatisfiesRuntime,
} from "../contracts/governed-facet-runtime.mjs";
import { validateAgentWriteApprovalBindingRuntime } from "../agent/write-approval-runtime.mjs";
import { verifyFactRecordRuntime, verifyFactSnapshotRuntime } from "../facts/canonical-runtime.mjs";
import { verifyEvidenceClaimRuntime } from "../evidence/claim-runtime.mjs";
import {
  validateProgressiveBuildEvaluationClosureRuntime,
} from "../compatibility/runtime.mjs";
import { legacySha256Runtime } from "../facts/canonical-runtime.mjs";
import { validatePlanEvaluationLockRuntime, validatePlanVersionRuntime } from "../plans/canonical-runtime.mjs";
import { validateRequirementClosureRuntime } from "../requirements/runtime.mjs";

const HASH = /^[a-f0-9]{64}$/;
const REF = /^sha256:[a-f0-9]{64}$/;
const JOB = /^job-[a-f0-9]{64}$/;
const CLAIM = /^claim-sha256-([a-f0-9]{64})$/;
const SNAPSHOT_ID = /^fact-snapshot-sha256-([a-f0-9]{64})$/;
const COMPONENT_KINDS = new Set([
  "case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio", "radiator", "pump",
  "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller", "storage_expander", "backplane", "nic",
  "capture_card", "expansion_board", "pcie_card", "cable", "adapter", "bracket",
]);
const CANDIDATE_FACETS = new Set([
  "identity.category", "physical.width", "physical.height", "physical.depth", "mount.standard", "mount.point_ids",
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type", "motherboard.memory_slot_count",
  "motherboard.memory_population_rules", "motherboard.form_factor", "motherboard.bios_version", "motherboard.bios_upgrade_methods",
  "motherboard.display_outputs", "motherboard.supported_operating_systems", "memory.type", "memory.capacity", "io.port_types",
  "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "case.side_panel", "case.gpu_max_length",
  "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width", "gpu.power_connectors", "psu.capacity", "psu.connectors",
  "power.source_type", "power.load", "power.cable_families", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "storage.recording_technology", "hba.mode", "cooling.fan_mounts",
  "cooling.radiator_support", "cooling.pump_header", "firmware.version", "firmware.upgrade_path_refs",
  "driver.supported_operating_systems", "driver.package_versions", "thermal.curve_refs", "acoustic.curve_refs", "acoustic.noise_class",
]);
const SAFETY_CLASSES = new Set(["informational", "compatibility", "boot", "electrical_safety", "destructive_action"]);
const DOMAINS = new Set(["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement"]);
const SNAPSHOT_FIELDS = [
  "configHash", "requirementSpecHash", "factSnapshotHash", "userObservationSnapshotHash", "priceSnapshotHash",
  "ruleSetHash", "systemProfileHash", "adapterSnapshotHash", "engineHash", "simulationModelHash", "simulationInputHash",
];

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function canonicalText(value, nonempty = true) {
  if (typeof value !== "string" || (nonempty && value.length === 0) || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function portable(value) {
  return canonicalText(value) && value.length <= 256 && !/\s/u.test(value);
}
function ordered(values) {
  return values.every((item, index) => index === 0 || values[index - 1] < item);
}
function strings(value, nonempty = false) {
  return Array.isArray(value) && value.every((item) => canonicalText(item, nonempty))
    && new Set(value).size === value.length && ordered(value);
}
function sequenceStrings(value, nonempty = false) {
  return Array.isArray(value) && value.every((item) => canonicalText(item, nonempty)) && new Set(value).size === value.length;
}
function snapshots(value) { return exact(value, SNAPSHOT_FIELDS) && SNAPSHOT_FIELDS.every((key) => HASH.test(value[key])); }
function limits(value) {
  return exact(value, ["maxEvaluations", "maxDurationMs", "maxCandidatesPerRequirement"])
    && [value.maxEvaluations, value.maxDurationMs, value.maxCandidatesPerRequirement].every((item) => Number.isSafeInteger(item) && item > 0);
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function ranges(value) {
  return Array.isArray(value) && value.every((range, index) => exact(range, ["start", "end"])
    && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start
    && (index === 0 || range.start > value[index - 1].end));
}
function coverage(value, evaluationHash) {
  return exact(value, ["domain", "verdict", "domainHash", "evaluationHash", "requiredForPurchase"])
    && DOMAINS.has(value.domain) && ["pass", "fail", "blocked"].includes(value.verdict)
    && HASH.test(value.domainHash) && value.evaluationHash === evaluationHash && typeof value.requiredForPurchase === "boolean";
}

function progressiveEvaluationInput(value) {
  return exact(value, [
    "config", "evaluationLock", "artifactLockfile", "ruleSetPayload", "enginePayload", "adapterSnapshotPayload",
    "priceSnapshot",
    "factClosure", "observationClosure", "firmwareCapabilities", "firmwarePathInputs",
    "firmwareFixedPointRootRequirements", "assemblySafetyInputs", "requirementRoots",
  ]) && Array.isArray(value.firmwareCapabilities) && Array.isArray(value.firmwarePathInputs)
    && Array.isArray(value.firmwareFixedPointRootRequirements) && Array.isArray(value.assemblySafetyInputs)
    && Array.isArray(value.requirementRoots);
}

function progressiveEvaluationReceipt(value) {
  if (!exact(value, [
    "schemaVersion", "planId", "basePlanVersionId", "buildConfigHash", "inputHashes", "evaluationHash",
    "evaluation", "replayInput", "coverageArtifactRef", "evaluatedAt",
  ]) || value.schemaVersion !== "solver-progressive-evaluation-receipt-v1"
    || !portable(value.planId) || !portable(value.basePlanVersionId) || !HASH.test(value.buildConfigHash)
    || !snapshots(value.inputHashes) || value.inputHashes.configHash !== value.buildConfigHash
    || !HASH.test(value.evaluationHash) || !progressiveEvaluationInput(value.replayInput)
    || !REF.test(value.coverageArtifactRef) || !iso(value.evaluatedAt)) return false;
  const closureErrors = validateProgressiveBuildEvaluationClosureRuntime(value.evaluation, value.replayInput);
  const computedEvaluationHash = legacySha256Runtime({
    domain: "authoritative-evaluation-identity",
    schemaVersion: "authoritative-evaluation-identity-v1",
    evaluationLockHash: value.replayInput.evaluationLock?.contentHash,
    evaluation: value.evaluation,
  });
  return closureErrors.length === 0 && computedEvaluationHash === value.evaluationHash
    && value.evaluation?.authority?.configHash === value.buildConfigHash
    && canonical(value.inputHashes) === canonical(value.replayInput.evaluationLock?.snapshotHashes);
}

function progressiveEvaluationCoverage(value) {
  return exact(value, ["schemaVersion", "evaluationHash", "domainCoverage"])
    && value.schemaVersion === "solver-progressive-evaluation-coverage-v1" && HASH.test(value.evaluationHash)
    && Array.isArray(value.domainCoverage) && value.domainCoverage.length === DOMAINS.size
    && value.domainCoverage.every((item) => coverage(item, value.evaluationHash))
    && ordered(value.domainCoverage.map((item) => item.domain));
}

/** Replays the solver receipt and exact separately persisted domain coverage. */
export function validateSolverProgressiveEvaluationClosureRuntime(receipt, coverageArtifact) {
  return total(() => {
    if (!progressiveEvaluationReceipt(receipt) || !progressiveEvaluationCoverage(coverageArtifact)) {
      return ["solver progressive evaluation receipt/coverage is invalid"];
    }
    const expected = receipt.evaluation.domainEvaluations.map((domain) => ({
      domain: domain.domain,
      verdict: domain.verdict === "unknown" ? "blocked" : domain.verdict,
      domainHash: legacySha256Runtime({
        schemaVersion: "solver-progressive-domain-coverage-v1",
        evaluationHash: receipt.evaluationHash,
        domain: domain.domain,
        verdict: domain.verdict === "unknown" ? "blocked" : domain.verdict,
        domainEvaluation: domain,
      }),
      evaluationHash: receipt.evaluationHash,
      requiredForPurchase: false,
    })).sort((left, right) => left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0);
    return coverageArtifact.evaluationHash === receipt.evaluationHash
      && canonical(coverageArtifact.domainCoverage) === canonical(expected)
      ? [] : ["solver progressive evaluation coverage is not recomputable from its receipt"];
  }, ["solver progressive evaluation closure validation failed"]);
}
function dedupeReferences(refs) {
  const seen = new Set();
  return refs.filter((item) => {
    if (!REF.test(String(item?.ref ?? "")) || !["required_for_replay", "optional_for_audit"].includes(item.necessity)) return false;
    const key = `${item.ref}\0${item.necessity}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((left, right) => `${left.ref}\0${left.necessity}`.localeCompare(`${right.ref}\0${right.necessity}`));
}
function required(refs) { return dedupeReferences(refs.map((ref) => ({ ref, necessity: "required_for_replay" }))); }
function total(run, fallback) { try { return run(); } catch { return fallback; } }

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!canonicalText(value, false)) throw new TypeError("non-canonical solver text");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite solver number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!record(value) && !Array.isArray(value) || ancestors.has(value)) throw new TypeError("solver value is not canonical JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse solver array");
      return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
      || Object.getOwnPropertySymbols(value).length) throw new TypeError("non-plain solver object");
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => {
        if (item === undefined || !canonicalText(key, false)) throw new TypeError("undefined/non-canonical solver member");
        return `${JSON.stringify(key)}:${canonical(item, ancestors)}`;
      }).join(",")}}`;
  } finally { ancestors.delete(value); }
}

function solverCandidateIndexHash(value) {
  const material = { ...value }; delete material.contentHash;
  const preimage = `buildsim\u0000hash-spec-v1\u0000artifact.rule-set\u00001.0.0\u0000${canonical(material)}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function capabilityRecordHash(value) {
  const material = { ...value }; delete material.contentHash;
  const preimage = `buildsim\u0000hash-spec-v1\u0000artifact.adapter-snapshot\u00001.0.0\u0000${canonical(material)}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function requirementCapabilityIndexHash(records, snapshotRef) {
  const entries = records.map((recordValue) => ({
    subjectSkuId: recordValue.subjectSkuId,
    componentKindId: recordValue.componentKindId,
    capabilityRecordHash: recordValue.contentHash,
    facets: recordValue.facets.filter((facet) => CANDIDATE_FACETS.has(facet.facetId)),
  })).sort((left, right) => {
    const leftKey = `${left.componentKindId}\u0000${left.subjectSkuId}`;
    const rightKey = `${right.componentKindId}\u0000${right.subjectSkuId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (entries.some((entry) => entry.facets.length === 0)) return null;
  const material = { schemaVersion: "requirement-capability-index-v1", factSnapshotRef: snapshotRef, entries };
  const preimage = `buildsim\u0000hash-spec-v1\u0000artifact.rule-set\u00001.0.0\u0000${canonical(material)}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function agentContextHash(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function contentRef(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function validateSolverApprovalPlanContext(value, approval) {
  return exact(value, [
    "schemaVersion", "jobId", "expectedRevision", "runtimeGeneration", "candidateId", "requestRef", "resultRef", "basePlanVersionId",
    "baseConfigHash", "candidateBuildConfigHash",
  ]) && value.schemaVersion === "solver-approval-plan-context-v1" && value.jobId === approval.jobId
    && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && Number.isSafeInteger(value.runtimeGeneration) && value.runtimeGeneration >= 1 && portable(value.candidateId)
    && value.candidateId === approval.candidateId && value.requestRef === approval.requestRef && value.resultRef === approval.resultRef
    && portable(value.basePlanVersionId) && HASH.test(value.baseConfigHash)
    && value.candidateBuildConfigHash === approval.candidateBuildConfigHash;
}

export function validatePersistedSolverCandidateRuntime(value, options = {}) {
  return total(() => {
    const fields = [
      "candidateId", "requirementSpecId", "basePlanVersionId", "baseConfigHash", "candidateConfigRef", "operationsRef",
      "buildConfigHash", "inputHashes", "evaluationHash", "evaluationReceiptRef", "coverageArtifactRef", "candidateKind",
      "domainCoverage", "residualRequirementIds", "excludedReasonIds",
    ];
    const optional = options.artifactMaterial === true ? [] : ["candidateArtifactRef"];
    if (!exact(value, fields, optional) || !portable(value.candidateId)
      || !portable(value.requirementSpecId) || !portable(value.basePlanVersionId)
      || !HASH.test(value.baseConfigHash) || !REF.test(value.candidateConfigRef) || !REF.test(value.operationsRef)
      || !HASH.test(value.buildConfigHash) || !snapshots(value.inputHashes) || value.inputHashes.configHash !== value.buildConfigHash
      || !HASH.test(value.evaluationHash) || !REF.test(value.evaluationReceiptRef) || !REF.test(value.coverageArtifactRef)
      || value.candidateKind !== "feasibility_candidate" || !Array.isArray(value.domainCoverage) || value.domainCoverage.length === 0
      || !value.domainCoverage.every((item) => coverage(item, value.evaluationHash))
      || new Set(value.domainCoverage.map((item) => item.domain)).size !== value.domainCoverage.length
      || !ordered(value.domainCoverage.map((item) => item.domain))
      || !strings(value.residualRequirementIds, true) || !strings(value.excludedReasonIds, true)
      || value.domainCoverage.some((item) => item.requiredForPurchase && item.verdict !== "pass") && value.excludedReasonIds.length === 0
      || (options.artifactMaterial !== true && !REF.test(value.candidateArtifactRef))) {
      return ["persisted solver candidate structure/authority binding is invalid"];
    }
    return [];
  }, ["persisted solver candidate runtime validation failed"]);
}

export function solverCandidateReferencesRuntime(value) {
  return validatePersistedSolverCandidateRuntime(value, { artifactMaterial: true }).length ? []
    : required([value.candidateConfigRef, value.operationsRef, value.evaluationReceiptRef, value.coverageArtifactRef]);
}

/** Replays candidate config/operations against its exact durable request. */
export function validateSolverCandidateClosureRuntime(
  candidateEntry,
  request,
  baseConfigEntry,
  candidateConfigEntry,
  operationsEntry,
) {
  return total(() => {
    if (!exact(candidateEntry, ["ref", "value"]) || !REF.test(candidateEntry.ref)
      || validatePersistedSolverCandidateRuntime(candidateEntry.value, { artifactMaterial: true }).length
      || candidateEntry.ref !== contentRef(candidateEntry.value)
      || validateSolverRequestArtifactRuntime(request).length
      || !exact(baseConfigEntry, ["ref", "value"]) || !REF.test(baseConfigEntry.ref)
      || !exact(candidateConfigEntry, ["ref", "value"]) || !REF.test(candidateConfigEntry.ref)
      || !exact(operationsEntry, ["ref", "value"]) || !REF.test(operationsEntry.ref)
      || validatePlanConfigRuntime(baseConfigEntry.value, { topologyV3Enabled: true }).length
      || validatePlanConfigRuntime(candidateConfigEntry.value, { topologyV3Enabled: true }).length
      || validateSolverArtifactRuntime("solver-candidate-operations", operationsEntry.value).length) {
      return ["solver candidate closure structure invalid"];
    }
    const candidate = candidateEntry.value;
    if (request.baseConfigRef !== baseConfigEntry.ref || baseConfigEntry.ref !== contentRef(baseConfigEntry.value)
      || candidate.candidateConfigRef !== candidateConfigEntry.ref || candidateConfigEntry.ref !== contentRef(candidateConfigEntry.value)
      || candidate.operationsRef !== operationsEntry.ref || operationsEntry.ref !== contentRef(operationsEntry.value)
      || hashPlanConfigRuntime(baseConfigEntry.value) !== request.request.baseConfigHash
      || hashPlanConfigRuntime(candidateConfigEntry.value) !== candidate.buildConfigHash
      || candidate.basePlanVersionId !== request.request.basePlanVersionId
      || candidate.baseConfigHash !== request.request.baseConfigHash
      || candidate.requirementSpecId !== request.request.requirementSpecId) {
      return ["solver candidate durable request/config binding invalid"];
    }
    const snapshotFields = SNAPSHOT_FIELDS.filter((field) => field !== "configHash");
    if (snapshotFields.some((field) => candidate.inputHashes[field] !== request.request.baseSnapshotHashes[field])) {
      return ["solver candidate crossed the request snapshot authority"];
    }
    const materialized = applyScenarioTopologyPatchRuntime(baseConfigEntry.value, operationsEntry.value);
    return hashPlanConfigRuntime(materialized) === candidate.buildConfigHash
      && canonical(materialized) === canonical(candidateConfigEntry.value)
      ? [] : ["solver candidate operations do not materialize its evaluated config"];
  }, ["solver candidate closure runtime validation failed"]);
}

function factSnapshotRef(value) {
  const match = record(value) && exact(value, ["snapshotId", "contentHash"])
    && typeof value.snapshotId === "string" ? SNAPSHOT_ID.exec(value.snapshotId) : null;
  return Boolean(match && HASH.test(value.contentHash) && match[1] === value.contentHash);
}

function validateSolverRequirement(value) {
  if (!exact(value, ["requirementId", "componentKindId", "role", "predicates", "quantity", "hardConstraintIds"], ["satisfiedByInstanceIds"])
    || !portable(value.requirementId) || !COMPONENT_KINDS.has(value.componentKindId) || !canonicalText(value.role)
    || !Number.isSafeInteger(value.quantity) || value.quantity < 0 || !Array.isArray(value.predicates)
    || value.predicates.some((predicate) => validateGovernedFacetPredicateRuntime(predicate).length)
    || new Set(value.predicates.map((predicate) => predicate.facetId)).size !== value.predicates.length
    || !ordered(value.predicates.map((predicate) => canonical(predicate))) || !strings(value.hardConstraintIds, true)) return false;
  return value.satisfiedByInstanceIds === undefined || strings(value.satisfiedByInstanceIds, true);
}

function validateCapabilityFacetProjection(value) {
  return CANDIDATE_FACETS.has(value?.facetId) && validateCapabilityFacetAuthority(value);
}

function validateCapabilityFacetAuthority(value) {
  if (!exact(value, ["facetId", "value", "sourceFactIds", "safetyClass"], ["unitId"])
    || !SAFETY_CLASSES.has(value.safetyClass)
    || !strings(value.sourceFactIds, true)) return false;
  const projected = { facetId: value.facetId, value: value.value, ...(value.unitId === undefined ? {} : { unitId: value.unitId }) };
  return validateGovernedFacetValueRuntime(projected).length === 0;
}

function validateIndexedCandidate(value, pool, outer) {
  if (!exact(value, [
    "subjectSkuId", "componentKindId", "capabilityRecordHash", "facets", "requirementId", "indexHash",
    "factSnapshotRef", "sourceFactRefs", "identityClaimRefs", "identityClaimIds",
  ]) || !portable(value.subjectSkuId) || value.componentKindId !== pool.requirement.componentKindId
    || value.requirementId !== pool.requirement.requirementId || !HASH.test(value.capabilityRecordHash)
    || !pool.source.capabilityRecordHashes.includes(value.capabilityRecordHash)
    || value.indexHash !== pool.source.indexHash
    || !factSnapshotRef(value.factSnapshotRef) || canonical(value.factSnapshotRef) !== canonical(outer.factSnapshotRef)
    || !Array.isArray(value.facets) || value.facets.length === 0 || value.facets.some((facet) => !validateCapabilityFacetProjection(facet))
    || new Set(value.facets.map((facet) => facet.facetId)).size !== value.facets.length
    || !ordered(value.facets.map((facet) => facet.facetId))) return false;
  if (!pool.requirement.predicates.every((predicate) => {
    const facet = value.facets.find((item) => item.facetId === predicate.facetId);
    if (!facet) return false;
    return governedFacetSatisfiesRuntime({
      facetId: facet.facetId, value: facet.value, ...(facet.unitId === undefined ? {} : { unitId: facet.unitId }),
    }, predicate);
  })) return false;
  const requiredFactIds = [...new Set(value.facets.flatMap((facet) => facet.sourceFactIds))].sort();
  if (!Array.isArray(value.sourceFactRefs) || value.sourceFactRefs.length !== requiredFactIds.length
    || value.sourceFactRefs.some((ref) => !exact(ref, ["factId", "contentHash"]) || !portable(ref.factId) || !HASH.test(ref.contentHash))
    || !ordered(value.sourceFactRefs.map((ref) => ref.factId))
    || canonical(value.sourceFactRefs.map((ref) => ref.factId)) !== canonical(requiredFactIds)) return false;
  const sourceById = new Map(value.sourceFactRefs.map((ref) => [ref.factId, ref]));
  if (!Array.isArray(value.identityClaimRefs) || value.identityClaimRefs.length === 0
    || value.identityClaimRefs.some((ref) => {
      const match = exact(ref, ["claimId", "contentHash", "sourceFactId", "sourceFactHash"])
        && typeof ref.claimId === "string" ? CLAIM.exec(ref.claimId) : null;
      const source = sourceById.get(ref?.sourceFactId);
      return !match || match[1] !== ref.contentHash || !HASH.test(ref.contentHash) || !source || source.contentHash !== ref.sourceFactHash;
    }) || !ordered(value.identityClaimRefs.map((ref) => ref.claimId)) || !strings(value.identityClaimIds, true)
    || canonical(value.identityClaimIds) !== canonical(value.identityClaimRefs.map((ref) => ref.claimId))) return false;
  return true;
}

function validateCandidatePool(pool, outer) {
  if (!exact(pool, ["requirement", "candidates", "source", "truncated", "blockedIdentitySkuIds"])
    || !validateSolverRequirement(pool.requirement) || !Array.isArray(pool.candidates)
    || !exact(pool.source, ["indexHash", "factSnapshotRef", "runtimeGeneration", "capabilityRecordHashes"])
    || !HASH.test(pool.source.indexHash) || !factSnapshotRef(pool.source.factSnapshotRef)
    || canonical(pool.source.factSnapshotRef) !== canonical(outer.factSnapshotRef)
    || !Number.isSafeInteger(pool.source.runtimeGeneration) || pool.source.runtimeGeneration < 1
    || !strings(pool.source.capabilityRecordHashes, true) || pool.source.capabilityRecordHashes.some((hash) => !HASH.test(hash))
    || typeof pool.truncated !== "boolean" || !strings(pool.blockedIdentitySkuIds, true)) return false;
  if (pool.candidates.some((candidate) => !validateIndexedCandidate(candidate, pool, outer))
    || !ordered(pool.candidates.map((candidate) => `${candidate.subjectSkuId}\u0000${candidate.capabilityRecordHash}`))
    || new Set(pool.candidates.map((candidate) => candidate.subjectSkuId)).size !== pool.candidates.length) return false;
  const candidateSkus = new Set(pool.candidates.map((candidate) => candidate.subjectSkuId));
  return pool.blockedIdentitySkuIds.every((sku) => portable(sku) && !candidateSkus.has(sku));
}

function validateEmbeddedCapabilityRecord(recordValue, expectedSnapshotRef) {
  return exact(recordValue, ["schemaVersion", "subjectSkuId", "componentKindId", "factSnapshotRef", "facets", "providerRefs", "contentHash"])
    && recordValue.schemaVersion === "capability-record-v1" && portable(recordValue.subjectSkuId)
    && COMPONENT_KINDS.has(recordValue.componentKindId) && factSnapshotRef(recordValue.factSnapshotRef)
    && canonical(recordValue.factSnapshotRef) === canonical(expectedSnapshotRef)
    && Array.isArray(recordValue.facets) && recordValue.facets.length > 0
    && recordValue.facets.every((facet) => validateCapabilityFacetAuthority(facet))
    && ordered(recordValue.facets.map((facet) => facet.facetId)) && strings(recordValue.providerRefs, true)
    && HASH.test(recordValue.contentHash) && recordValue.contentHash === capabilityRecordHash(recordValue);
}

function validateCandidateIndex(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "planId", "factSnapshotRef", "capabilityRecords", "pools", "contentHash"])
      || value.schemaVersion !== "solver-candidate-index-v1" || !portable(value.planId) || !factSnapshotRef(value.factSnapshotRef)
      || !Array.isArray(value.capabilityRecords)
      || value.capabilityRecords.some((recordValue) => !validateEmbeddedCapabilityRecord(recordValue, value.factSnapshotRef))
      || !ordered(value.capabilityRecords.map((recordValue) => recordValue.contentHash))
      || new Set(value.capabilityRecords.map((recordValue) => recordValue.contentHash)).size !== value.capabilityRecords.length
      || !Array.isArray(value.pools) || !HASH.test(value.contentHash) || value.pools.some((pool) => !validateCandidatePool(pool, value))
      || !ordered(value.pools.map((pool) => pool.requirement.requirementId))
      || value.pools.some((pool) => pool.source.runtimeGeneration !== value.pools[0]?.source.runtimeGeneration)
      || value.pools.some((pool) => pool.source.indexHash !== value.pools[0]?.source.indexHash
        || canonical(pool.source.capabilityRecordHashes) !== canonical(value.pools[0]?.source.capabilityRecordHashes)
        || canonical(pool.source.capabilityRecordHashes) !== canonical(value.capabilityRecords.map((recordValue) => recordValue.contentHash)))
      || value.contentHash !== solverCandidateIndexHash(value)) return false;
    return true;
  }, false);
}

/** Domain graph/Doctor authority edges, separate from ArtifactRepository sha256 edges. */
export function solverCandidateIndexAuthorityReferencesRuntime(value) {
  if (!validateCandidateIndex(value)) return [];
  const refs = [{ ref: `fact-snapshot:${value.factSnapshotRef.snapshotId}`, necessity: "required_for_replay" }];
  for (const pool of value.pools) {
    for (const hash of pool.source.capabilityRecordHashes) {
      refs.push({ ref: `capability-record:sha256:${hash}`, necessity: "required_for_replay" });
    }
    for (const candidate of pool.candidates) {
    for (const fact of candidate.sourceFactRefs) refs.push({ ref: `fact:${fact.factId}`, necessity: "required_for_replay" });
    for (const claim of candidate.identityClaimRefs) refs.push({ ref: `evidence-claim:${claim.claimId}`, necessity: "required_for_replay" });
    }
  }
  const byKey = new Map(refs.map((entry) => [`${entry.ref}\u0000${entry.necessity}`, entry]));
  return [...byKey.values()].sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
}

/**
 * Replays a candidate index against authorities opened by the production
 * graph. No caller-supplied hash or facet projection is accepted on its own.
 */
export function validateSolverCandidateIndexAuthorityClosureRuntime(value, closure) {
  return total(() => {
    if (!validateCandidateIndex(value) || !exact(closure, ["factSnapshot", "capabilityRecords", "facts", "evidenceClaims"])
      || !verifyFactSnapshotRuntime(closure.factSnapshot)
      || closure.factSnapshot.snapshotId !== value.factSnapshotRef.snapshotId
      || closure.factSnapshot.contentHash !== value.factSnapshotRef.contentHash
      || !Array.isArray(closure.capabilityRecords) || !Array.isArray(closure.facts) || !Array.isArray(closure.evidenceClaims)) {
      return ["solver candidate index authority closure structure invalid"];
    }
    const snapshotFactById = new Map(closure.factSnapshot.factRefs.map((ref) => [ref.factId, ref]));
    const facts = new Map();
    for (const fact of closure.facts) {
      if (!verifyFactRecordRuntime(fact) || facts.has(fact.factId)) return ["solver candidate index fact closure invalid"];
      facts.set(fact.factId, fact);
    }
    const claims = new Map();
    for (const claim of closure.evidenceClaims) {
      if (!verifyEvidenceClaimRuntime(claim) || claims.has(claim.claimId)) return ["solver candidate index EvidenceClaim closure invalid"];
      claims.set(claim.claimId, claim);
    }
    const records = new Map();
    for (const recordValue of closure.capabilityRecords) {
      if (!exact(recordValue, ["schemaVersion", "subjectSkuId", "componentKindId", "factSnapshotRef", "facets", "providerRefs", "contentHash"])
        || recordValue.schemaVersion !== "capability-record-v1" || !portable(recordValue.subjectSkuId)
        || !COMPONENT_KINDS.has(recordValue.componentKindId) || !factSnapshotRef(recordValue.factSnapshotRef)
        || canonical(recordValue.factSnapshotRef) !== canonical(value.factSnapshotRef)
        || !Array.isArray(recordValue.facets) || recordValue.facets.length === 0
        || recordValue.facets.some((facet) => !validateCapabilityFacetAuthority(facet))
        || !ordered(recordValue.facets.map((facet) => facet.facetId)) || !strings(recordValue.providerRefs, true)
        || !HASH.test(recordValue.contentHash) || recordValue.contentHash !== capabilityRecordHash(recordValue)
        || records.has(recordValue.contentHash)) return ["solver candidate index capability record closure invalid"];
      records.set(recordValue.contentHash, recordValue);
    }
    const orderedClosureRecords = [...closure.capabilityRecords]
      .sort((left, right) => left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0);
    if (canonical(value.capabilityRecords) !== canonical(orderedClosureRecords)) {
      return ["solver candidate index embedded capability records changed"];
    }
    const expectedRecordHashes = new Set(value.pools.flatMap((pool) => pool.source.capabilityRecordHashes));
    const expectedFactIds = new Set([...records.values()].flatMap((recordValue) => (
      recordValue.facets.flatMap((facet) => facet.sourceFactIds)
    )));
    const expectedClaimIds = new Set(value.pools.flatMap((pool) => pool.candidates.flatMap((candidate) => candidate.identityClaimRefs.map((ref) => ref.claimId))));
    if (records.size !== expectedRecordHashes.size || [...records.keys()].some((hash) => !expectedRecordHashes.has(hash))
      || facts.size !== expectedFactIds.size || [...facts.keys()].some((factId) => !expectedFactIds.has(factId))
      || claims.size !== expectedClaimIds.size || [...claims.keys()].some((claimId) => !expectedClaimIds.has(claimId))) {
      return ["solver candidate index authority closure contains missing or unreferenced records"];
    }
    const recomputedIndexHash = requirementCapabilityIndexHash([...records.values()], value.factSnapshotRef);
    if (!recomputedIndexHash || value.pools.some((pool) => pool.source.indexHash !== recomputedIndexHash)) {
      return ["solver candidate index does not bind the complete authoritative capability index"];
    }
    for (const capability of records.values()) {
      for (const facet of capability.facets) for (const factId of facet.sourceFactIds) {
        const snapshotRef = snapshotFactById.get(factId); const fact = facts.get(factId);
        if (!snapshotRef || !fact || fact.contentHash !== snapshotRef.contentHash
          || fact.subject?.kind !== "product" || fact.subject.skuId !== capability.subjectSkuId) {
          return ["solver capability index source fact closure mismatch"];
        }
      }
    }
    for (const pool of value.pools) {
      const matching = [...records.values()].filter((capability) => capability.componentKindId === pool.requirement.componentKindId
        && pool.requirement.predicates.every((predicate) => {
          const facet = capability.facets.find((item) => item.facetId === predicate.facetId);
          return facet && governedFacetSatisfiesRuntime({
            facetId: facet.facetId, value: facet.value, ...(facet.unitId === undefined ? {} : { unitId: facet.unitId }),
          }, predicate);
        }));
      const matchingSkus = matching.map((capability) => capability.subjectSkuId).sort();
      if (pool.blockedIdentitySkuIds.some((sku) => !matchingSkus.includes(sku))) {
        return ["solver candidate pool claims a blocked SKU outside its authoritative query"];
      }
      if (!pool.truncated) {
        const representedSkus = [...pool.candidates.map((candidate) => candidate.subjectSkuId), ...pool.blockedIdentitySkuIds].sort();
        if (canonical(representedSkus) !== canonical(matchingSkus)) {
          return ["solver candidate pool omitted an authoritative query match without truncation/blocking"];
        }
      }
    }
    const evaluatedAt = Date.parse(closure.factSnapshot.createdAt);
    for (const pool of value.pools) for (const candidate of pool.candidates) {
      const capability = records.get(candidate.capabilityRecordHash);
      if (!capability || capability.subjectSkuId !== candidate.subjectSkuId || capability.componentKindId !== candidate.componentKindId) {
        return ["solver candidate index capability identity closure mismatch"];
      }
      const projected = capability.facets.filter((facet) => CANDIDATE_FACETS.has(facet.facetId));
      if (canonical(projected) !== canonical(candidate.facets)) return ["solver candidate index facet projection mismatch"];
      for (const ref of candidate.sourceFactRefs) {
        const snapshotRef = snapshotFactById.get(ref.factId);
        const fact = facts.get(ref.factId);
        if (!snapshotRef || snapshotRef.contentHash !== ref.contentHash || !fact || fact.contentHash !== ref.contentHash
          || fact.subject?.kind !== "product" || fact.subject.skuId !== candidate.subjectSkuId) {
          return ["solver candidate index source fact closure mismatch"];
        }
      }
      for (const ref of candidate.identityClaimRefs) {
        const fact = facts.get(ref.sourceFactId); const claim = claims.get(ref.claimId);
        if (!fact || fact.contentHash !== ref.sourceFactHash || !claim || claim.contentHash !== ref.contentHash
          || !fact.evidenceRefs.includes(claim.claimId) || claim.status !== "active" || claim.subject.skuId !== candidate.subjectSkuId
          || claim.fieldId !== fact.field || claim.scope !== fact.scope || claim.authority !== fact.authority
          || canonical(claim.subject) !== canonical((({ kind: _kind, ...subject }) => subject)(fact.subject))
          || canonical(claim.value) !== canonical(fact.value) || claim.unit !== fact.unit
          || Date.parse(claim.retrievedAt) > evaluatedAt
          || (claim.validFrom !== undefined && Date.parse(claim.validFrom) > evaluatedAt)
          || (claim.validUntil !== undefined && Date.parse(claim.validUntil) < evaluatedAt)) {
          return ["solver candidate index identity EvidenceClaim closure mismatch"];
        }
      }
    }
    return [];
  }, ["solver candidate index authority closure runtime validation failed"]);
}

export function validateSolverSearchCheckpointRuntime(value) {
  return total(() => {
    if (!exact(value, [
      "schemaVersion", "solverVersion", "seed", "basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "limits",
      "candidateIndexHash", "candidateIndexRef", "nextAssignment", "totalAssignments", "exploredAssignmentHashes", "pruned", "candidates", "rejections",
      "elapsedDurationMs",
    ]) || value.schemaVersion !== "whole-build-solver-checkpoint-v1" || !portable(value.solverVersion)
      || !portable(value.seed) || !portable(value.basePlanVersionId)
      || !HASH.test(value.baseConfigHash) || !snapshots(value.baseSnapshotHashes) || value.baseSnapshotHashes.configHash !== value.baseConfigHash
      || !limits(value.limits) || !HASH.test(value.candidateIndexHash) || !REF.test(value.candidateIndexRef) || !Number.isSafeInteger(value.nextAssignment)
      || !Number.isSafeInteger(value.totalAssignments) || value.nextAssignment < 0 || value.totalAssignments < value.nextAssignment
      || !Number.isSafeInteger(value.elapsedDurationMs) || value.elapsedDurationMs < 0
      || !sequenceStrings(value.exploredAssignmentHashes) || value.exploredAssignmentHashes.some((hash) => !HASH.test(hash))
      || value.exploredAssignmentHashes.length !== value.nextAssignment || !Number.isSafeInteger(value.pruned) || value.pruned < 0
      || !Array.isArray(value.candidates) || value.candidates.some((candidate) => validatePersistedSolverCandidateRuntime(candidate).length)
      || !Array.isArray(value.rejections) || value.rejections.some((item) => !exact(item, ["assignmentHash", "hardConstraintIds"], ["evaluationReceiptRef"])
        || !HASH.test(item.assignmentHash) || !strings(item.hardConstraintIds, true)
        || item.evaluationReceiptRef !== undefined && !REF.test(item.evaluationReceiptRef))) {
      return ["solver search checkpoint structure/closure is invalid"];
    }
    const candidateIds = value.candidates.map((candidate) => candidate.candidateId);
    const rejectionHashes = value.rejections.map((rejection) => rejection.assignmentHash);
    const explored = new Set(value.exploredAssignmentHashes);
    if (!ordered(candidateIds) || new Set(candidateIds).size !== candidateIds.length
      || !ordered(rejectionHashes) || new Set(rejectionHashes).size !== rejectionHashes.length
      || rejectionHashes.some((hash) => !explored.has(hash)) || value.pruned !== value.rejections.length
      || value.candidates.length + value.rejections.length !== value.nextAssignment) {
      return ["solver search checkpoint counts/order are not recomputable"];
    }
    return [];
  }, ["solver search checkpoint runtime validation failed"]);
}

export function validateSolverRequestArtifactRuntime(value) {
  return total(() => {
    if (!exact(value, [
      "schemaVersion", "planId", "request", "baseConfigRef", "requirementClosureRef", "requirements", "solverVersion", "seed",
      "runtimeGeneration", "basePlanVersionRef", "evaluationLockRef",
    ])
      || value.schemaVersion !== "whole-build-solver-request-v1" || !portable(value.planId)
      || !REF.test(value.baseConfigRef) || !REF.test(value.requirementClosureRef) || !REF.test(value.basePlanVersionRef) || !REF.test(value.evaluationLockRef)
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !portable(value.solverVersion) || !portable(value.seed)
      || !record(value.request) || !exact(value.request, ["basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "lockedInstanceIds", "requirementSpecId", "limits"])
      || !portable(value.request.basePlanVersionId) || !HASH.test(value.request.baseConfigHash)
      || !snapshots(value.request.baseSnapshotHashes) || value.request.baseSnapshotHashes.configHash !== value.request.baseConfigHash
      || !strings(value.request.lockedInstanceIds, true) || !portable(value.request.requirementSpecId)
      || !limits(value.request.limits) || !Array.isArray(value.requirements)
      || value.requirements.some((requirement) => !validateSolverRequirement(requirement))
      || !ordered(value.requirements.map((requirement) => requirement.requirementId))) return ["solver request artifact structure/binding is invalid"];
    return [];
  }, ["solver request artifact runtime validation failed"]);
}

export function solverRequestReferencesRuntime(value) {
  return validateSolverRequestArtifactRuntime(value).length ? []
    : required([value.baseConfigRef, value.requirementClosureRef, value.basePlanVersionRef, value.evaluationLockRef]);
}

export function validateSolverJobCheckpointRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "jobId", "requestRef", "runtimeGeneration", "phase", "search", "resultRef", "approvalRef"])
      || value.schemaVersion !== "solver-job-checkpoint-v1" || !JOB.test(value.jobId) || !REF.test(value.requestRef)
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !["searching", "result_ready", "pending_approval", "committed", "aborted", "stale"].includes(value.phase)
      || validateSolverSearchCheckpointRuntime(value.search).length
      || !(value.resultRef === null || REF.test(value.resultRef)) || !(value.approvalRef === null || REF.test(value.approvalRef))) {
      return ["solver job checkpoint structure/binding is invalid"];
    }
    if (value.phase === "searching" && (value.resultRef !== null || value.approvalRef !== null)) return ["searching solver checkpoint cannot claim result/approval"];
    if (["pending_approval", "committed", "aborted", "stale"].includes(value.phase) && (!REF.test(value.resultRef) || !REF.test(value.approvalRef))) {
      return ["terminal/review solver checkpoint requires result and approval refs"];
    }
    return [];
  }, ["solver job checkpoint runtime validation failed"]);
}

export function solverJobCheckpointReferencesRuntime(value) {
  if (validateSolverJobCheckpointRuntime(value).length) return [];
  return required([
    value.requestRef, value.search.candidateIndexRef,
    ...(value.resultRef ? [value.resultRef] : []),
    ...(value.approvalRef ? [value.approvalRef] : []),
    ...value.search.candidates.map((candidate) => candidate.candidateArtifactRef),
    ...value.search.rejections.flatMap((rejection) => rejection.evaluationReceiptRef ? [rejection.evaluationReceiptRef] : []),
  ]);
}

function validateSolveResultRuntime(value) {
  if (!exact(value, [
    "status", "solverVersion", "seed", "effectiveLimits", "explored", "pruned", "candidates",
    "unsatisfiedHardConstraintIds", "irreducibleConflictSets", "searchSummaryRef",
  ], ["unexploredRanges"]) || !["feasible_complete", "feasible_partial", "unsat_proven", "blocked_inputs"].includes(value.status)
    || !portable(value.solverVersion) || !portable(value.seed)
    || !limits(value.effectiveLimits) || !Number.isSafeInteger(value.explored) || value.explored < 0 || !Number.isSafeInteger(value.pruned) || value.pruned < 0
    || !Array.isArray(value.candidates) || value.candidates.some((candidate) => validatePersistedSolverCandidateRuntime(candidate).length)
    || !strings(value.unsatisfiedHardConstraintIds, true) || !Array.isArray(value.irreducibleConflictSets)
    || value.irreducibleConflictSets.some((set) => !strings(set, true) || set.length === 0) || !REF.test(value.searchSummaryRef)
    || value.unexploredRanges !== undefined && !ranges(value.unexploredRanges)) return false;
  const candidateIds = value.candidates.map((candidate) => candidate.candidateId);
  const conflictKeys = value.irreducibleConflictSets.map((set) => canonical(set));
  if (!ordered(candidateIds) || new Set(candidateIds).size !== candidateIds.length
    || !ordered(conflictKeys) || new Set(conflictKeys).size !== conflictKeys.length) return false;
  if (["feasible_complete", "feasible_partial"].includes(value.status) && value.candidates.length === 0) return false;
  if (value.status === "unsat_proven" && (value.candidates.length || !value.unsatisfiedHardConstraintIds.length)) return false;
  if (value.status === "blocked_inputs" && (!value.unsatisfiedHardConstraintIds.length || value.candidates.length)) return false;
  if (value.pruned > value.explored || value.candidates.length + value.pruned !== value.explored) return false;
  if (["feasible_complete", "feasible_partial"].includes(value.status) && value.unsatisfiedHardConstraintIds.length) return false;
  if (value.status !== "unsat_proven" && value.irreducibleConflictSets.length) return false;
  if (value.status === "feasible_complete") {
    if (value.unexploredRanges?.length || value.candidates.some((candidate) => candidate.residualRequirementIds.length
      || candidate.excludedReasonIds.length
      || [...DOMAINS].some((domain) => !candidate.domainCoverage.some((item) => item.domain === domain && item.verdict === "pass")))) return false;
  }
  return true;
}

export function validateSolverResultArtifactRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "jobId", "requestRef", "checkpointRef", "result", "unsatProof"])
      || value.schemaVersion !== "whole-build-solver-result-v1" || !JOB.test(value.jobId) || !REF.test(value.requestRef) || !REF.test(value.checkpointRef)
      || !validateSolveResultRuntime(value.result)) return ["solver result artifact structure/binding is invalid"];
    if (value.result.status === "unsat_proven") {
      if (!exact(value.unsatProof, ["kind", "exploredSearchSpaceHash"]) || value.unsatProof.kind !== "exhaustive" || !HASH.test(value.unsatProof.exploredSearchSpaceHash)) {
        return ["unsat_proven solver result lacks exhaustive proof"];
      }
    } else if (value.unsatProof !== null) return ["non-unsat solver result cannot carry an unsat proof"];
    return [];
  }, ["solver result artifact runtime validation failed"]);
}

export function solverResultReferencesRuntime(value) {
  if (validateSolverResultArtifactRuntime(value).length) return [];
  return required([
    value.requestRef, value.checkpointRef, value.result.searchSummaryRef,
    ...value.result.candidates.map((candidate) => candidate.candidateArtifactRef),
  ]);
}

function candidateIndexAssignmentSlots(index) {
  return index.pools.flatMap((pool) => Array.from({
    length: Math.max(0, pool.requirement.quantity - (pool.requirement.satisfiedByInstanceIds?.length ?? 0)),
  }, (_, ordinal) => ({ requirement: pool.requirement, ordinal, choices: pool.candidates })));
}

function candidateIndexTotalAssignments(index) {
  const slots = candidateIndexAssignmentSlots(index);
  if (slots.some((slot) => slot.choices.length === 0)) return 0;
  let totalAssignments = 1n;
  for (const slot of slots) totalAssignments *= BigInt(slot.choices.length);
  return totalAssignments > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(totalAssignments);
}

function assignmentHashAt(index, assignmentIndex) {
  const slots = candidateIndexAssignmentSlots(index);
  let remainder = assignmentIndex;
  const choices = new Array(slots.length);
  for (let position = slots.length - 1; position >= 0; position -= 1) {
    const slot = slots[position]; const radix = slot.choices.length;
    const choice = remainder % radix; remainder = Math.floor(remainder / radix);
    choices[position] = { slot, candidate: slot.choices[choice] };
  }
  const material = choices.map(({ slot, candidate }) => ({
    requirementId: slot.requirement.requirementId,
    ordinal: slot.ordinal,
    componentKindId: slot.requirement.componentKindId,
    subjectSkuId: candidate.subjectSkuId,
    capabilityRecordHash: candidate.capabilityRecordHash,
  }));
  return createHash("sha256").update(`buildsim\u0000solver-assignment-v1\u0000${canonical(material)}`, "utf8").digest("hex");
}

/** Pure exhaustive-proof replay after result/checkpoint/index refs are opened. */
export function validateSolverUnsatClosureRuntime(value, checkpointEntry, candidateIndexEntry) {
  return total(() => {
    if (validateSolverResultArtifactRuntime(value).length || value.result.status !== "unsat_proven"
      || !exact(checkpointEntry, ["ref", "value"]) || !REF.test(checkpointEntry.ref)
      || !exact(candidateIndexEntry, ["ref", "value"]) || !REF.test(candidateIndexEntry.ref)
      || validateSolverJobCheckpointRuntime(checkpointEntry.value).length
      || !validateCandidateIndex(candidateIndexEntry.value)) return ["solver unsat closure structure invalid"];
    const checkpoint = checkpointEntry.value; const search = checkpoint.search; const candidateIndex = candidateIndexEntry.value;
    if (value.checkpointRef !== checkpointEntry.ref || checkpointEntry.ref !== contentRef(checkpoint)
      || search.candidateIndexRef !== candidateIndexEntry.ref || candidateIndexEntry.ref !== contentRef(candidateIndex)
      || value.jobId !== checkpoint.jobId || value.requestRef !== checkpoint.requestRef || checkpoint.phase !== "result_ready"
      || search.candidateIndexHash !== candidateIndex.contentHash
      || search.solverVersion !== value.result.solverVersion || search.seed !== value.result.seed
      || search.exploredAssignmentHashes.length !== value.result.explored || search.pruned !== value.result.pruned
      || search.candidates.length !== 0 || value.result.unexploredRanges?.length
      || candidateIndex.pools.some((pool) => pool.truncated || pool.blockedIdentitySkuIds.length)) {
      return ["solver unsat result/checkpoint/index binding invalid"];
    }
    const totalAssignments = candidateIndexTotalAssignments(candidateIndex);
    if (search.totalAssignments !== totalAssignments || search.nextAssignment !== totalAssignments
      || search.exploredAssignmentHashes.some((hash, index) => hash !== assignmentHashAt(candidateIndex, index))) {
      return ["solver unsat checkpoint does not enumerate the complete deterministic search space"];
    }
    const rejected = [...search.rejections].map((item) => ({
      ...item, hardConstraintIds: [...item.hardConstraintIds].sort(),
    })).sort((left, right) => left.assignmentHash < right.assignmentHash ? -1 : left.assignmentHash > right.assignmentHash ? 1 : 0);
    const exploredAssignmentHashes = [...search.exploredAssignmentHashes].sort();
    const proofMaterial = {
      schemaVersion: "solver-exhaustive-unsat-material-v1",
      solverVersion: search.solverVersion,
      seed: search.seed,
      basePlanVersionId: search.basePlanVersionId,
      baseSnapshotHashes: search.baseSnapshotHashes,
      candidateIndex,
      totalAssignments,
      exploredAssignmentHashes,
      rejections: rejected,
    };
    const expectedProofHash = createHash("sha256")
      .update(`buildsim\u0000solver-exhaustive-unsat-v1\u0000${canonical(proofMaterial)}`, "utf8").digest("hex");
    return value.unsatProof.exploredSearchSpaceHash === expectedProofHash
      ? [] : ["solver exhaustive unsat proof hash is not recomputable"];
  }, ["solver unsat closure runtime validation failed"]);
}

export function validateSolverApprovalArtifactRuntime(value) {
  return total(() => {
    if (!exact(value, [
      "schemaVersion", "status", "jobId", "requestRef", "checkpointRef", "resultRef", "candidateArtifactRefs", "candidateId",
      "candidateBuildConfigHash", "proposalRef", "previousApprovalRef", "approvedBy", "writeApprovalBinding", "approvalPlanContext", "createdAt",
    ]) || value.schemaVersion !== "solver-candidate-approval-v1" || !["pending", "committed", "aborted", "stale"].includes(value.status)
      || !JOB.test(value.jobId) || !REF.test(value.requestRef) || !REF.test(value.checkpointRef) || !REF.test(value.resultRef)
      || !strings(value.candidateArtifactRefs, true) || value.candidateArtifactRefs.some((ref) => !REF.test(ref)) || !iso(value.createdAt)) {
      return ["solver approval artifact structure/binding is invalid"];
    }
    const nullableRef = value.proposalRef === null || REF.test(value.proposalRef);
    const nullablePrevious = value.previousApprovalRef === null || REF.test(value.previousApprovalRef);
    if (!nullableRef || !nullablePrevious) return ["solver approval artifact refs are invalid"];
    if (value.status === "pending") {
      if (!value.candidateArtifactRefs.length || value.candidateId !== null || value.candidateBuildConfigHash !== null || value.proposalRef !== null
        || value.previousApprovalRef !== null || value.approvedBy !== null || value.writeApprovalBinding !== null
        || value.approvalPlanContext !== null) return ["pending solver approval claims unapproved authority"];
    } else {
      if (!REF.test(value.previousApprovalRef) || !portable(value.approvedBy)) return ["solver approval transition lacks actor/parent"];
      if (value.status === "committed" && (!portable(value.candidateId) || !HASH.test(value.candidateBuildConfigHash)
        || !REF.test(value.proposalRef) || validateAgentWriteApprovalBindingRuntime(value.writeApprovalBinding).length
        || value.writeApprovalBinding.approvedBy !== value.approvedBy || !validateSolverApprovalPlanContext(value.approvalPlanContext, value)
        || value.writeApprovalBinding.planContextHash !== agentContextHash(value.approvalPlanContext))) {
        return ["committed solver approval lacks exact candidate/proposal/write-approval binding"];
      }
      if (value.status !== "committed" && (value.proposalRef !== null || value.writeApprovalBinding !== null || value.approvalPlanContext !== null)) {
        return ["uncommitted solver approval cannot carry a proposal/write approval"];
      }
      if (value.status !== "committed" && (value.candidateId !== null || value.candidateBuildConfigHash !== null)) {
        return ["uncommitted solver approval cannot select a candidate"];
      }
    }
    return [];
  }, ["solver approval artifact runtime validation failed"]);
}

export function solverApprovalReferencesRuntime(value) {
  if (validateSolverApprovalArtifactRuntime(value).length) return [];
  return required([
    value.requestRef, value.checkpointRef, value.resultRef, ...value.candidateArtifactRefs,
    ...(value.proposalRef ? [value.proposalRef] : []), ...(value.previousApprovalRef ? [value.previousApprovalRef] : []),
    ...(value.writeApprovalBinding ? [value.writeApprovalBinding.confirmedAuthorityRef, value.writeApprovalBinding.pendingRef] : []),
  ]);
}

/** Pure replay closure used by production graph/Doctor after refs are opened. */
export function validateSolverApprovalClosureRuntime(value, pending, request, result, proposal, candidateEntry, operationsEntry) {
  return total(() => {
    if (validateSolverApprovalArtifactRuntime(value).length || value.status !== "committed"
      || validateSolverApprovalArtifactRuntime(pending).length || pending.status !== "pending"
      || validateSolverRequestArtifactRuntime(request).length || validateSolverResultArtifactRuntime(result).length
      || !record(proposal) || validateSolverArtifactRuntime("solver-acceptance-proposal", proposal).length
      || !exact(candidateEntry, ["ref", "value"]) || !REF.test(candidateEntry.ref)
      || !exact(operationsEntry, ["ref", "value"]) || !REF.test(operationsEntry.ref)
      || validatePersistedSolverCandidateRuntime(candidateEntry.value, { artifactMaterial: true }).length
      || validateSolverArtifactRuntime("solver-candidate-operations", operationsEntry.value).length) {
      return ["solver approval closure authority is invalid"];
    }
    const stablePendingFields = ["jobId", "requestRef", "checkpointRef", "resultRef", "candidateArtifactRefs"];
    if (stablePendingFields.some((field) => canonical(value[field]) !== canonical(pending[field]))) {
      return ["solver approval transition changed pending authority"];
    }
    const resultCandidateRefs = result.result.candidates.map((candidate) => candidate.candidateArtifactRef).sort();
    if (canonical(pending.candidateArtifactRefs) !== canonical(resultCandidateRefs)) {
      return ["solver pending approval candidate set is not recomputable from its result"];
    }
    const candidate = result.result.candidates.find((item) => item.candidateId === value.candidateId);
    const { candidateArtifactRef: _candidateArtifactRef, ...candidateMaterial } = candidate ?? {};
    if (!candidate || candidate.buildConfigHash !== value.candidateBuildConfigHash
      || !pending.candidateArtifactRefs.includes(candidate.candidateArtifactRef)
      || candidate.candidateArtifactRef !== candidateEntry.ref || candidateEntry.ref !== contentRef(candidateEntry.value)
      || canonical(candidateMaterial) !== canonical(candidateEntry.value)
      || candidate.operationsRef !== operationsEntry.ref || operationsEntry.ref !== contentRef(operationsEntry.value)
      || canonical(proposal.operations) !== canonical(operationsEntry.value)
      || request.planId === undefined || request.request.basePlanVersionId !== value.approvalPlanContext.basePlanVersionId
      || request.request.baseConfigHash !== value.approvalPlanContext.baseConfigHash
      || request.runtimeGeneration !== value.approvalPlanContext.runtimeGeneration
      || value.writeApprovalBinding.runtimeGeneration !== request.runtimeGeneration
      || value.approvalPlanContext.candidateBuildConfigHash !== candidate.buildConfigHash
      || proposal.jobId !== value.jobId || proposal.requestRef !== value.requestRef || proposal.resultRef !== value.resultRef
      || proposal.candidateId !== value.candidateId || proposal.candidateArtifactRef !== candidate.candidateArtifactRef
      || proposal.expectedPlanVersionId !== request.request.basePlanVersionId
      || proposal.expectedConfigHash !== request.request.baseConfigHash) {
      return ["solver approval candidate/base/proposal closure mismatch"];
    }
    return [];
  }, ["solver approval closure runtime validation failed"]);
}

export function validateSolverWhatIfArtifactRuntime(value) {
  return total(() => {
    if (!exact(value, [
      "schemaVersion", "scenarioId", "familyId", "basePlanVersionId", "baseConfigHash", "afterConfigHash", "baseSnapshotHashes",
      "beforeInputHashes", "afterInputHashes", "snapshotChangedFields",
      "beforeEvaluationHash", "afterEvaluationHash", "beforeReceiptRef", "afterReceiptRef", "beforeCoverageRef", "afterCoverageRef",
      "decisionDiffRef", "domainDiffRefs", "snapshotAttribution", "proposalOnly", "createdAt",
    ]) || value.schemaVersion !== "solver-what-if-result-v1" || !portable(value.scenarioId)
      || !portable(value.familyId) || !portable(value.basePlanVersionId)
      || !HASH.test(value.baseConfigHash) || !HASH.test(value.afterConfigHash) || !snapshots(value.baseSnapshotHashes)
      || !snapshots(value.beforeInputHashes) || !snapshots(value.afterInputHashes) || !strings(value.snapshotChangedFields, true)
      || value.snapshotChangedFields.some((field) => !SNAPSHOT_FIELDS.includes(field))
      || value.baseSnapshotHashes.configHash !== value.baseConfigHash || value.beforeInputHashes.configHash !== value.baseConfigHash
      || value.afterInputHashes.configHash !== value.afterConfigHash || !HASH.test(value.beforeEvaluationHash) || !HASH.test(value.afterEvaluationHash)
      || ![value.beforeReceiptRef, value.afterReceiptRef, value.beforeCoverageRef, value.afterCoverageRef, value.decisionDiffRef].every((ref) => REF.test(ref))
      || !strings(value.domainDiffRefs) || value.domainDiffRefs.some((ref) => !REF.test(ref))
      || !["same_snapshots", "refreshed"].includes(value.snapshotAttribution) || value.proposalOnly !== true || !iso(value.createdAt)) {
      return ["solver what-if artifact structure/binding is invalid"];
    }
    const changed = SNAPSHOT_FIELDS.filter((field) => value.beforeInputHashes[field] !== value.afterInputHashes[field]).sort();
    if (canonical(changed) !== canonical(value.snapshotChangedFields)) return ["solver what-if snapshotChangedFields is not recomputable"];
    const nonConfig = SNAPSHOT_FIELDS.filter((field) => field !== "configHash");
    if (value.snapshotAttribution === "same_snapshots") {
      if (canonical(value.beforeInputHashes) !== canonical(value.baseSnapshotHashes)
        || nonConfig.some((field) => value.afterInputHashes[field] !== value.baseSnapshotHashes[field])) {
        return ["same_snapshots what-if changed governed snapshot authority"];
      }
    } else if (!nonConfig.some((field) => value.beforeInputHashes[field] !== value.baseSnapshotHashes[field]
      || value.afterInputHashes[field] !== value.baseSnapshotHashes[field])) {
      return ["refreshed what-if does not identify a refreshed non-config snapshot"];
    }
    return [];
  }, ["solver what-if artifact runtime validation failed"]);
}

function validateWhatIfDomainDiff(value) {
  return exact(value, ["schemaVersion", "scenarioId", "domain", "beforeEvaluationHash", "afterEvaluationHash", "beforeReceiptRef", "afterReceiptRef", "before", "after", "changed"])
    && value.schemaVersion === "solver-what-if-domain-diff-v1" && portable(value.scenarioId)
    && DOMAINS.has(value.domain) && HASH.test(value.beforeEvaluationHash) && HASH.test(value.afterEvaluationHash)
    && REF.test(value.beforeReceiptRef) && REF.test(value.afterReceiptRef) && typeof value.changed === "boolean"
    && [value.before, value.after].every((item) => item === null || exact(item, ["verdict", "domainHash"])
      && ["pass", "fail", "blocked"].includes(item.verdict) && HASH.test(item.domainHash))
    && value.changed === (canonical(value.before) !== canonical(value.after));
}

function validateWhatIfDecisionDiff(value) {
  return exact(value, ["schemaVersion", "scenarioId", "beforeEvaluationHash", "afterEvaluationHash", "beforeReceiptRef", "afterReceiptRef", "changedDomains", "unchangedDomains"])
    && value.schemaVersion === "solver-what-if-decision-diff-v1" && portable(value.scenarioId)
    && HASH.test(value.beforeEvaluationHash) && HASH.test(value.afterEvaluationHash) && REF.test(value.beforeReceiptRef) && REF.test(value.afterReceiptRef)
    && strings(value.changedDomains) && strings(value.unchangedDomains)
    && [...value.changedDomains, ...value.unchangedDomains].every((domain) => DOMAINS.has(domain))
    && new Set([...value.changedDomains, ...value.unchangedDomains]).size === value.changedDomains.length + value.unchangedDomains.length;
}

/** Replays decision-domain membership from the exact persisted domain diffs. */
export function validateSolverWhatIfDiffClosureRuntime(decision, domainDiffs) {
  return total(() => {
    if (!validateWhatIfDecisionDiff(decision) || !Array.isArray(domainDiffs) || domainDiffs.length === 0
      || domainDiffs.some((diff) => !validateWhatIfDomainDiff(diff))
      || new Set(domainDiffs.map((diff) => diff.domain)).size !== domainDiffs.length) return ["what-if diff closure structure invalid"];
    if (domainDiffs.some((diff) => diff.scenarioId !== decision.scenarioId
      || diff.beforeEvaluationHash !== decision.beforeEvaluationHash || diff.afterEvaluationHash !== decision.afterEvaluationHash
      || diff.beforeReceiptRef !== decision.beforeReceiptRef || diff.afterReceiptRef !== decision.afterReceiptRef)) {
      return ["what-if diff closure evaluation/receipt binding invalid"];
    }
    const changedDomains = domainDiffs.filter((diff) => diff.changed).map((diff) => diff.domain).sort();
    const unchangedDomains = domainDiffs.filter((diff) => !diff.changed).map((diff) => diff.domain).sort();
    return canonical(changedDomains) === canonical(decision.changedDomains)
      && canonical(unchangedDomains) === canonical(decision.unchangedDomains) ? [] : ["what-if changedDomains is not recomputable"];
  }, ["what-if diff closure runtime validation failed"]);
}

/**
 * Replays the complete what-if result -> decision/domain diff authority. Each
 * opened diff is paired with the ref that selected it, so a caller cannot pass
 * a different checksum-valid diff set than the result actually references.
 */
export function validateSolverWhatIfClosureRuntime(value, decisionEntry, domainEntries) {
  return total(() => {
    if (validateSolverWhatIfArtifactRuntime(value).length
      || !exact(decisionEntry, ["ref", "value"]) || !REF.test(decisionEntry.ref)
      || !Array.isArray(domainEntries) || domainEntries.some((entry) => !exact(entry, ["ref", "value"]) || !REF.test(entry.ref))) {
      return ["what-if result closure structure invalid"];
    }
    const refFor = (material) => `sha256:${createHash("sha256").update(canonical(material), "utf8").digest("hex")}`;
    if (decisionEntry.ref !== value.decisionDiffRef || decisionEntry.ref !== refFor(decisionEntry.value)
      || domainEntries.some((entry) => entry.ref !== refFor(entry.value))
      || canonical(domainEntries.map((entry) => entry.ref).sort()) !== canonical(value.domainDiffRefs)) {
      return ["what-if result diff refs do not bind the opened content"];
    }
    const decision = decisionEntry.value;
    if (!validateWhatIfDecisionDiff(decision)
      || decision.scenarioId !== value.scenarioId
      || decision.beforeEvaluationHash !== value.beforeEvaluationHash
      || decision.afterEvaluationHash !== value.afterEvaluationHash
      || decision.beforeReceiptRef !== value.beforeReceiptRef
      || decision.afterReceiptRef !== value.afterReceiptRef) {
      return ["what-if result/decision evaluation authority mismatch"];
    }
    return validateSolverWhatIfDiffClosureRuntime(decision, domainEntries.map((entry) => entry.value));
  }, ["what-if result closure runtime validation failed"]);
}

export function solverWhatIfReferencesRuntime(value) {
  return validateSolverWhatIfArtifactRuntime(value).length ? [] : required([
    value.beforeReceiptRef, value.afterReceiptRef, value.beforeCoverageRef, value.afterCoverageRef,
    value.decisionDiffRef, ...value.domainDiffRefs,
  ]);
}

export function validateSolverArtifactRuntime(kind, value) {
  return total(() => {
    if (kind === "solver-base-plan-version") {
      return validatePlanVersionRuntime(value, { topologyV3Enabled: true });
    }
    if (kind === "solver-base-evaluation-lock") return validatePlanEvaluationLockRuntime(value);
    if (kind === "solver-requirement-closure") return validateRequirementClosureRuntime(value);
    if (kind === "solver-base-config" || kind === "solver-candidate-config") return validatePlanConfigRuntime(value, { topologyV3Enabled: true });
    if (kind === "solver-candidate-operations") {
      return Array.isArray(value) && validateScenarioPatchAuthority(value, undefined, "solver").length === 0
        ? [] : ["solver operations authority is invalid"];
    }
    if (kind === "solver-acceptance-proposal") {
      const fields = ["schemaVersion", "kind", "source", "jobId", "requestRef", "resultRef", "candidateArtifactRef", "candidateId", "expectedPlanVersionId", "expectedConfigHash", "expectedDraftRevision", "operations"];
      return exact(value, fields) && value.schemaVersion === "solver-acceptance-proposal-v1" && value.kind === "v3-change"
        && value.source === "solver-feasibility-candidate" && JOB.test(value.jobId) && REF.test(value.requestRef)
        && REF.test(value.resultRef) && REF.test(value.candidateArtifactRef) && portable(value.candidateId)
        && portable(value.expectedPlanVersionId) && HASH.test(value.expectedConfigHash)
        && Number.isSafeInteger(value.expectedDraftRevision) && value.expectedDraftRevision >= 0 && Array.isArray(value.operations)
        && validateScenarioPatchAuthority(value.operations, undefined, "solver").length === 0 ? [] : ["solver acceptance proposal authority is invalid"];
    }
    if (kind === "solver-candidate") return validatePersistedSolverCandidateRuntime(value, { artifactMaterial: true });
    if (kind === "solver-candidate-index") return validateCandidateIndex(value) ? [] : ["solver candidate index is invalid"];
    if (kind === "solver-request") return validateSolverRequestArtifactRuntime(value);
    if (kind === "solver-job-checkpoint") return validateSolverJobCheckpointRuntime(value);
    if (kind === "solver-result") return validateSolverResultArtifactRuntime(value);
    if (kind === "solver-approval") return validateSolverApprovalArtifactRuntime(value);
    if (kind === "solver-what-if-result") return validateSolverWhatIfArtifactRuntime(value);
    if (kind === "solver-what-if-domain-diff") return validateWhatIfDomainDiff(value) ? [] : ["solver what-if domain diff is invalid"];
    if (kind === "solver-what-if-decision-diff") return validateWhatIfDecisionDiff(value) ? [] : ["solver what-if decision diff is invalid"];
    if (kind === "solver-progressive-evaluation-receipt") {
      if (progressiveEvaluationReceipt(value)) return [];
      const replayErrors = record(value) && record(value.replayInput)
        ? validateProgressiveBuildEvaluationClosureRuntime(value.evaluation, value.replayInput) : [];
      return ["solver progressive evaluation receipt is invalid", ...replayErrors.map((error) => `progressive replay: ${error}`)];
    }
    if (kind === "solver-progressive-evaluation-coverage") {
      return progressiveEvaluationCoverage(value) ? [] : ["solver progressive evaluation coverage is invalid"];
    }
    if (kind === "solver-search-summary") {
      return exact(value, ["schemaVersion", "solverVersion", "seed", "basePlanVersionId", "baseConfigHash", "candidateIndexHash", "candidateIndexRef", "totalAssignments", "nextAssignment", "elapsedDurationMs", "explored", "pruned", "unexploredRanges", "candidateIds", "candidateArtifactRefs"])
        && value.schemaVersion === "whole-build-search-summary-v1" && portable(value.solverVersion) && portable(value.seed)
        && portable(value.basePlanVersionId) && HASH.test(value.baseConfigHash) && HASH.test(value.candidateIndexHash)
        && REF.test(value.candidateIndexRef)
        && [value.totalAssignments, value.nextAssignment, value.elapsedDurationMs, value.explored, value.pruned].every((item) => Number.isSafeInteger(item) && item >= 0)
        && value.nextAssignment <= value.totalAssignments && value.explored === value.nextAssignment && value.pruned <= value.explored
        && ranges(value.unexploredRanges) && strings(value.candidateIds, true)
        && strings(value.candidateArtifactRefs, true) && value.candidateArtifactRefs.every((ref) => REF.test(ref))
        && value.candidateArtifactRefs.length === value.candidateIds.length
        && value.candidateIds.length + value.pruned === value.explored
        && (value.nextAssignment === value.totalAssignments
          ? value.unexploredRanges.length === 0
          : canonical(value.unexploredRanges) === canonical([{ start: value.nextAssignment, end: value.totalAssignments - 1 }]))
        ? [] : ["solver search summary is invalid"];
    }
    return ["unknown solver artifact kind"];
  }, ["solver artifact runtime validation failed"]);
}

export function solverArtifactReferencesRuntime(kind, value) {
  if (validateSolverArtifactRuntime(kind, value).length) return [];
  if (kind === "solver-candidate") return solverCandidateReferencesRuntime(value);
  if (kind === "solver-request") return solverRequestReferencesRuntime(value);
  if (kind === "solver-job-checkpoint") return solverJobCheckpointReferencesRuntime(value);
  if (kind === "solver-result") return solverResultReferencesRuntime(value);
  if (kind === "solver-approval") return solverApprovalReferencesRuntime(value);
  if (kind === "solver-what-if-result") return solverWhatIfReferencesRuntime(value);
  if (kind === "solver-what-if-domain-diff" || kind === "solver-what-if-decision-diff") return required([value.beforeReceiptRef, value.afterReceiptRef]);
  if (kind === "solver-progressive-evaluation-receipt") return required([value.coverageArtifactRef]);
  if (kind === "solver-search-summary") return required([value.candidateIndexRef, ...value.candidateArtifactRefs]);
  if (kind === "solver-acceptance-proposal") return required([value.requestRef, value.resultRef, value.candidateArtifactRef]);
  return [];
}

export { validateCandidateIndex as validateSolverCandidateIndexRuntime };
