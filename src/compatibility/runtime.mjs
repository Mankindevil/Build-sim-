import {
  FACT_FIELD_POLICY_RUNTIME,
  verifyConflictSetRuntime,
  verifyFactRecordRuntime,
  verifyFactSnapshotRuntime,
  verifyUpdateDecisionRuntime,
} from "../facts/canonical-runtime.mjs";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import {
  evaluateFirmwarePathRuntime,
  firmwarePathReferencesRuntime,
  projectFirmwareCandidateRequirementsRuntime,
  validateFirmwarePathRequirementClosureRuntime,
  validateFirmwareCapabilityRuntime,
  validateFirmwarePathEvaluationRuntime,
} from "../firmware/runtime.mjs";
import { validateFirmwareRequirementBatchFixedPointReplayRuntime } from "../firmware/fixed-point-runtime.mjs";
import {
  hashPlanConfigRuntime,
  validatePlanConfigRuntime,
  validatePlanEvaluationLockRuntime,
} from "../plans/canonical-runtime.mjs";
import {
  validateArtifactLockfileRuntime,
  validateEvaluationArtifactInputRuntime,
} from "../plans/evaluation-lock-runtime.mjs";
import {
  requirementAllocationReferencesRuntime,
  validateRequirementAllocationReplayRuntime,
  validateRequirementAllocationCheckpointClosureRuntime,
  validateRequirementAllocationResultRuntime,
  validateRequirementClosureReplayRuntime,
  validateRequirementClosureRuntime,
  validateRequirementNodeRuntime,
  validateRequirementReadinessRuntime,
} from "../requirements/runtime.mjs";
import { validateCaseAdapterManifestRuntime } from "../adapters/case-manifest-runtime.mjs";
import {
  assemblyCheckAssertionHashRuntime,
  assemblyResourceAssertionHashRuntime,
  assemblySafetyReferencesRuntime,
  evaluateAssemblySafetyRuntime,
  projectVerifiedAssemblySuppliesRuntime,
  validateRequirementAllocationGeneratedSupplyClosureRuntime,
  validateAssemblySafetyEvaluationRuntime,
  validateAssemblySafetyInput,
} from "../requirements/assembly-safety-runtime.mjs";
import {
  verifyUserObservationRuntime,
  verifyUserObservationSnapshotRuntime,
} from "../observations/canonical-runtime.mjs";

const DOMAINS = Object.freeze([
  "identity", "mechanical", "electrical", "firmware", "system", "storage",
  "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement",
]);
const DOMAIN_SET = new Set(DOMAINS);
const COMPONENT_KINDS = new Set([
  "case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio",
  "radiator", "pump", "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller",
  "storage_expander", "backplane", "nic", "capture_card", "expansion_board", "pcie_card",
  "cable", "adapter", "bracket",
]);
const SYSTEM_PROFILES = new Set([
  "system.windows-11", "system.linux-desktop", "system.truenas-scale", "system.proxmox-ve",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const RULE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const RULE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const PRICE_PLATFORMS = new Set(["jd", "taobao", "pdd", "amazon", "official", "other"]);

/**
 * Release-pinned digest of the executable compatibility manifest. Both the
 * TypeScript rule registry and the JS-only closure validator assert this
 * value, so a checksum-correct alternate manifest cannot become authority.
 */
export const BUILTIN_COMPATIBILITY_RULE_MANIFEST_HASH_RUNTIME = "114329b0355f7ac7f5f4fb61017aaccef1d75634fbb680ba676d1908eb3eeeeb";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function scalarString(value, max = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > max
    || value !== value.normalize("NFC") || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
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

function identifier(value, max = 512) {
  return scalarString(value, max) && !/\s/u.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+~=-]*$/u.test(value);
}

function ruleIdentifier(value) { return identifier(value, 256) && RULE_ID.test(value); }
function ruleVersion(value) { return identifier(value, 128) && RULE_VERSION.test(value); }
function sourceBytes(value) {
  // Implementation source is an opaque UTF-8 byte projection, not a user or
  // identity string. Requiring NFC here changes the identity of a production
  // bundle that legitimately contains decomposed literals and makes its exact
  // executing bytes impossible to lock. A JavaScript bundle may also contain
  // a literal U+0000 inside a regular-expression character class, so source
  // validation must preserve that byte too. Only malformed UTF-16 is rejected.
  // The engine's transitive closure intentionally embeds the exact locked
  // rule/standard/adapter payloads. A fully governed generic adapter bundle is
  // currently about 18 MiB, so the previous 16 MiB ceiling rejected the
  // production artifact that this validator is meant to replay. Keep a hard
  // bound, but size it for the complete portable closure rather than a partial
  // fixture.
  if (typeof value !== "string" || value.length === 0 || value.length > 67_108_864) return false;
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

function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function finiteNumber(value) { return typeof value === "number" && Number.isFinite(value); }
function nonNegativeFinite(value) { return finiteNumber(value) && value >= 0; }
function numericRange(value, { nonnegative = false } = {}) {
  return exact(value, ["lo", "hi"])
    && finiteNumber(value.lo) && finiteNumber(value.hi) && value.lo <= value.hi
    && (!nonnegative || value.lo >= 0);
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function strings(value, { allowEmpty = true, sorted = true, ids = true } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((entry) => ids ? identifier(entry, 512) : scalarString(entry, 4096))
    && new Set(value).size === value.length
    && (!sorted || value.every((entry, index) => index === 0 || compare(value[index - 1], entry) < 0));
}

function arraySortedBy(value, key) {
  return Array.isArray(value) && value.every((entry, index) => index === 0 || compare(key(value[index - 1]), key(entry)) < 0);
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!scalarString(value, Number.MAX_SAFE_INTEGER)) throw new TypeError("non-canonical string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-canonical number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError("non-canonical value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse array");
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("non-plain object");
    return `{${Object.entries(value).sort(([left], [right]) => compare(left, right))
      .map(([key, entry]) => {
        if (!scalarString(key, 256)) throw new TypeError("non-canonical key");
        return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`;
      }).join(",")}}`;
  } finally { ancestors.delete(value); }
}

/** Collision-free canonical identity for firmware capability scope tuples. */
export function firmwareCapabilityTupleKeyRuntime(value) {
  try {
    if (!record(value) || ![value.subjectSkuId, value.subjectRevision, value.region]
      .every((entry) => identifier(entry, 256))) return null;
    return canonicalJson([value.subjectSkuId, value.subjectRevision, value.region]);
  } catch { return null; }
}

/**
 * Facts that make one passing firmware result executable. Unselected alternate
 * routes and broad capability provenance intentionally remain outside this
 * gate so historical facts can stay in a capability without granting action.
 */
function firmwareExecutableFactRequirementsRuntime(evaluation, capability) {
  try {
    if (!record(evaluation) || !record(capability)) return null;
    if (evaluation.verdict !== "pass") return [];
    const rolesById = new Map();
    const add = (values, role = "capability") => {
      for (const value of values ?? []) {
        if (!identifier(value, 256)) throw new TypeError("firmware executable fact ID invalid");
        const roles = rolesById.get(value) ?? new Set();
        roles.add(role);
        rolesById.set(value, roles);
      }
    };
    const releaseIds = new Set();
    const addRelease = (releaseFactId) => {
      if (releaseFactId === null || releaseFactId === undefined) return;
      if (!identifier(releaseFactId, 256)) throw new TypeError("firmware executable release ID invalid");
      releaseIds.add(releaseFactId);
      add([releaseFactId], "release");
    };

    add(capability.versionIdentification?.sourceFactIds);
    addRelease(evaluation.currentObservation?.releaseFactId);
    addRelease(evaluation.targetReleaseFactId);
    addRelease(evaluation.minimumReleaseFactId);
    for (const releaseFactId of evaluation.bridgeReleaseFactIds ?? []) addRelease(releaseFactId);

    if (evaluation.cpuSkuId !== null && evaluation.cpuSkuId !== undefined) {
      const support = (capability.cpuSupport ?? []).find((entry) => entry?.cpuSkuId === evaluation.cpuSkuId);
      if (support === undefined) throw new TypeError("passing firmware evaluation lacks CPU support authority");
      add(support.sourceFactIds, "cpu_support");
      addRelease(support.minimumReleaseFactId);
    }

    const selectedIds = new Set([
      ...(evaluation.selectedTransitions ?? []).map((transition) => transition?.transitionId),
      ...(evaluation.recovery?.transitionIds ?? []),
    ]);
    const selectedById = new Map((capability.transitions ?? []).map((transition) => [transition?.transitionId, transition]));
    for (const transitionId of selectedIds) {
      if (!identifier(transitionId, 256)) throw new TypeError("firmware selected transition ID invalid");
      const transition = selectedById.get(transitionId);
      if (transition === undefined) throw new TypeError("firmware selected transition authority missing");
      const powerFactIds = new Set(transition.powerPrerequisiteFactIds ?? []);
      add((transition.sourceFactIds ?? []).filter((factId) => !powerFactIds.has(factId)));
      add(transition.releaseFactIds, "release");
      add(transition.powerPrerequisiteFactIds, "power");
      add([transition.firmwareFileFactId], "firmware_file");
      add([transition.checksumFactId], "checksum");
      addRelease(transition.fromReleaseFactId);
      addRelease(transition.toReleaseFactId);
      for (const releaseFactId of transition.releaseFactIds ?? []) addRelease(releaseFactId);
    }

    const requestedSettingIds = new Set((evaluation.searchAuthority?.requestedSettings ?? [])
      .map((setting) => setting?.settingId));
    for (const settingId of requestedSettingIds) {
      const setting = (capability.settings ?? []).find((candidate) => candidate?.settingId === settingId);
      if (setting === undefined) throw new TypeError("firmware requested setting authority missing");
      add(setting.sourceFactIds);
    }

    for (const releaseFactId of releaseIds) {
      const release = (capability.releases ?? []).find((entry) => entry?.releaseFactId === releaseFactId);
      if (release === undefined) throw new TypeError("firmware executable release authority missing");
      add(release.sourceFactIds);
    }
    return [...rolesById.entries()].map(([factId, roles]) => ({
      factId,
      roles: [...roles].sort(compare),
    })).sort((left, right) => compare(left.factId, right.factId));
  } catch { return null; }
}

export function firmwareExecutableFactIdsRuntime(evaluation, capability) {
  const requirements = firmwareExecutableFactRequirementsRuntime(evaluation, capability);
  return requirements === null ? null : requirements.map(({ factId }) => factId);
}

/**
 * Replays the subject/value authority for facts which make a selected firmware
 * route executable. Board firmware evidence is scoped to the exact capability
 * tuple, CPU-support evidence also names the selected CPU and minimum release,
 * while explicit power prerequisites may intentionally come from another
 * component in the same locked fact closure.
 */
export function firmwareExecutableFactAuthorityErrorsRuntime(evaluation, capability, facts) {
  const requirements = firmwareExecutableFactRequirementsRuntime(evaluation, capability);
  if (requirements === null) return ["executable fact authority cannot be derived"];
  if (!Array.isArray(facts)) return ["executable fact closure is unavailable"];
  const factsById = new Map(facts.filter(record).map((fact) => [fact.factId, fact]));
  const support = evaluation?.cpuSkuId === null || evaluation?.cpuSkuId === undefined
    ? null
    : (capability?.cpuSupport ?? []).find((entry) => entry?.cpuSkuId === evaluation.cpuSkuId) ?? null;
  const exactCapabilitySubject = (fact) => fact?.subject?.kind === "product"
    && fact.subject.skuId === capability?.subjectSkuId
    && fact.subject.revision === capability?.subjectRevision
    && fact.subject.region === capability?.region;
  const errors = [];
  for (const { factId, roles } of requirements) {
    const fact = factsById.get(factId);
    if (!fact || fact.status !== "active" || fact.authority !== "official") {
      errors.push(`executable fact ${factId} lacks active official authority`);
      continue;
    }
    if (roles.some((role) => role !== "power") && !exactCapabilitySubject(fact)) {
      errors.push(`executable fact ${factId} subject differs from firmware capability subject`);
      continue;
    }
    if (roles.includes("release")
      && (fact.field !== "firmware.bridge_version" || typeof fact.value !== "string")) {
      errors.push(`executable release fact ${factId} is not a governed firmware release assertion`);
    }
    if ((roles.includes("firmware_file") || roles.includes("checksum"))
      && fact.field !== "firmware.file_hash") {
      errors.push(`executable firmware file/checksum fact ${factId} is not a governed firmware file hash`);
    }
    if (roles.includes("cpu_support")) {
      const value = record(fact.value) ? fact.value : null;
      if (support === null || fact.field !== "firmware.cpu_support"
        || value?.cpuSkuId !== evaluation.cpuSkuId
        || value?.boardRevision !== capability.subjectRevision
        || value?.region !== capability.region
        || value?.sinceVersion !== support.minimumReleaseFactId) {
        errors.push(`executable CPU support fact ${factId} does not bind CPU ${evaluation.cpuSkuId ?? "unknown"} and capability scope`);
      }
    }
  }
  return errors;
}

export function compatibilityRuleDefinitionHashRuntime(value) {
  try {
    if (validateCompatibilityRuleDefinitionRuntime(value).length) return null;
    return sha256Utf8Runtime(`buildsim\0compatibility-rule-definition-v1\0${canonicalJson(value)}`);
  } catch { return null; }
}

function aggregateVerdicts(verdicts) {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("blocked")) return "blocked";
  if (verdicts.includes("unknown")) return "unknown";
  return verdicts.length > 0 ? "pass" : "unknown";
}

function validateRequirement(value, path, errors) {
  errors.push(...validateRequirementNodeRuntime(value).map((error) => `${path}: ${error}`));
}

function validateDecision(value, path, errors) {
  if (!exact(value, ["decisionId", "verdict", "domain", "message", "instanceIds", "factIds", "ruleId", "ruleVersion", "assumptions", "remediation"])) {
    errors.push(`${path} shape invalid`);
    return;
  }
  if (!identifier(value.decisionId, 512) || !["pass", "fail", "blocked"].includes(value.verdict)
    || !DOMAIN_SET.has(value.domain) || !scalarString(value.message, 4096)
    || !strings(value.instanceIds) || !strings(value.factIds)
    || !ruleIdentifier(value.ruleId) || !ruleVersion(value.ruleVersion)
    || !strings(value.assumptions, { ids: false })) errors.push(`${path} fields invalid`);
  if (!Array.isArray(value.remediation) || !arraySortedBy(value.remediation, (item) => item?.requirementId ?? "")) errors.push(`${path} remediation order invalid`);
  else value.remediation.forEach((item, index) => validateRequirement(item, `${path}.remediation.${index}`, errors));
}

function validateBomLine(value, path, errors) {
  if (!record(value)) { errors.push(`${path} invalid`); return; }
  const base = ["instanceId", "kind", "role", "state", "quantity", "identityStatus"];
  const expected = value.identityStatus === "resolved"
    ? [...base, "skuId", "identityClaimIds"]
    : value.identityStatus === "unresolved" ? [...base, "userText"] : base;
  const optional = value.identityStatus === "unresolved" ? ["candidateIds"] : [];
  if (!exact(value, expected, optional)) errors.push(`${path} shape invalid`);
  if (!identifier(value.instanceId, 256) || !COMPONENT_KINDS.has(value.kind) || !scalarString(value.role, 256)
    || !["planned", "ordered"].includes(value.state) || value.quantity !== 1) errors.push(`${path} base fields invalid`);
  if (value.identityStatus === "resolved") {
    if (!identifier(value.skuId, 256) || !strings(value.identityClaimIds, { allowEmpty: false })) errors.push(`${path} resolved identity invalid`);
  } else if (value.identityStatus === "unresolved") {
    if (!scalarString(value.userText, 1024) || (value.candidateIds !== undefined && !strings(value.candidateIds))) errors.push(`${path} unresolved identity invalid`);
  } else errors.push(`${path} identityStatus invalid`);
}

function governedPriceSnapshot(external) {
  if (!exact(external, ["ref", "payload"])) return null;
  const ref = external.ref;
  const artifact = external.payload;
  if (!exact(ref, ["ref", "hashSpecVersion", "algorithm", "contentHash", "domain", "schemaVersion", "canonicalizationPolicyId"])
    || ref.ref !== `sha256:${ref.contentHash}` || !SHA256.test(ref.contentHash)
    || ref.algorithm !== "sha256" || ref.domain !== "artifact" || ref.schemaVersion !== "artifact-payload-v1"
    || !exact(artifact, ["schemaVersion", "artifactId", "mediaType", "payload", "contentHash"])
    || artifact.schemaVersion !== "artifact-payload-v1"
    || artifact.mediaType !== "application/vnd.buildsim.price-snapshot+json"
    || artifact.contentHash !== ref.contentHash) return null;
  const snapshot = artifact.payload;
  const snapshotFields = ["schemaVersion", "asOf", "snapshotId", "generatedAt", "inputHash", "contentHash", "priceVersion", "quotes"];
  const optionalSnapshotFields = ["note", "catalogVersion"];
  if (!exact(snapshot, snapshotFields, optionalSnapshotFields)
    || snapshot.schemaVersion !== "1.1.0" || snapshot.priceVersion !== "price-snapshot-v2"
    || typeof snapshot.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(snapshot.asOf)
    || !identifier(snapshot.snapshotId, 256) || !/^price-snapshot-[a-f0-9]{20}$/u.test(snapshot.snapshotId)
    || !SHA256.test(snapshot.inputHash) || snapshot.snapshotId !== `price-snapshot-${snapshot.inputHash.slice(0, 20)}`
    || typeof snapshot.generatedAt !== "string" || !Number.isFinite(Date.parse(snapshot.generatedAt))
    || !SHA256.test(snapshot.contentHash) || !Array.isArray(snapshot.quotes)) return null;
  // Reconstruct the producer's schema order. Artifact repositories canonicalize
  // object keys, so hashing the parsed object's incidental insertion order
  // would make an otherwise immutable snapshot fail after restart.
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
  if (sha256Utf8Runtime(JSON.stringify(material)) !== snapshot.contentHash) return null;
  const quoteFields = [
    "skuId", "platform", "priceCny", "currency", "listingUrl", "match", "evidence", "priceKind", "variantLabel",
    "priceAmount", "priceCurrency", "fetchedAt", "provenanceId", "sourceHash", "provenance", "note", "title",
  ];
  for (const quote of snapshot.quotes) {
    if (!record(quote) || Object.keys(quote).some((key) => !quoteFields.includes(key))
      || !identifier(quote.skuId, 512) || !PRICE_PLATFORMS.has(quote.platform)
      || typeof quote.priceCny !== "number" || !Number.isFinite(quote.priceCny) || quote.priceCny <= 0
      || quote.currency !== "CNY" || quote.evidence !== "audited" || quote.priceKind !== "variant"
      || !scalarString(quote.variantLabel, 1024) || !scalarString(quote.listingUrl, 4096)
      || !/^https:\/\//iu.test(quote.listingUrl)) return null;
  }
  return { ref, snapshot };
}

/** Project exact, audited per-instance prices without claiming a complete purchasable build. */
export function projectProgressivePriceRuntime(topologyBom, priceSnapshot) {
  try {
    if (!Array.isArray(topologyBom) || !arraySortedBy(topologyBom, (line) => line?.instanceId ?? "")) return null;
    const governed = governedPriceSnapshot(priceSnapshot);
    if (governed === null) return null;
    const bySku = new Map();
    for (const quote of governed.snapshot.quotes) {
      const quoteContentHash = sha256Utf8Runtime(canonicalJson(quote));
      const candidate = { quote, quoteContentHash };
      const entries = bySku.get(quote.skuId) ?? [];
      entries.push(candidate);
      bySku.set(quote.skuId, entries);
    }
    for (const entries of bySku.values()) entries.sort((left, right) => (
      left.quote.priceCny - right.quote.priceCny
      || compare(left.quote.platform, right.quote.platform)
      || compare(left.quoteContentHash, right.quoteContentHash)
    ));
    const lines = topologyBom.map((line) => {
      if (line?.identityStatus !== "resolved") {
        return { instanceId: line?.instanceId, quantity: 1, status: "unknown", reason: "identity_unresolved" };
      }
      const selected = bySku.get(line.skuId)?.[0];
      if (selected === undefined) {
        return {
          instanceId: line.instanceId,
          skuId: line.skuId,
          quantity: 1,
          status: "unknown",
          reason: "no_audited_exact_variant_quote",
        };
      }
      return {
        instanceId: line.instanceId,
        skuId: line.skuId,
        quantity: 1,
        status: "known",
        priceCny: selected.quote.priceCny,
        currency: "CNY",
        platform: selected.quote.platform,
        quoteContentHash: selected.quoteContentHash,
        provenanceId: typeof selected.quote.provenanceId === "string" ? selected.quote.provenanceId : null,
        listingUrl: selected.quote.listingUrl,
      };
    });
    const unknownInstanceIds = lines.filter((line) => line.status === "unknown").map((line) => line.instanceId);
    return {
      schemaVersion: "progressive-price-projection-v1",
      priceSnapshotRef: governed.ref.ref,
      priceSnapshotHash: governed.ref.contentHash,
      snapshotId: governed.snapshot.snapshotId,
      asOf: governed.snapshot.asOf,
      lines,
      knownSubtotalCny: lines.reduce((sum, line) => sum + (line.status === "known" ? line.priceCny : 0), 0),
      unknownInstanceIds,
      complete: lines.length > 0 && unknownInstanceIds.length === 0,
    };
  } catch { return null; }
}

function validatePriceProjection(value, topologyBom, errors) {
  if (!exact(value, ["schemaVersion", "priceSnapshotRef", "priceSnapshotHash", "snapshotId", "asOf", "lines", "knownSubtotalCny", "unknownInstanceIds", "complete"])) {
    errors.push("priceProjection shape invalid");
    return;
  }
  if (value.schemaVersion !== "progressive-price-projection-v1"
    || value.priceSnapshotRef !== `sha256:${value.priceSnapshotHash}` || !SHA256.test(value.priceSnapshotHash)
    || !identifier(value.snapshotId, 256) || typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.asOf)
    || typeof value.knownSubtotalCny !== "number" || !Number.isFinite(value.knownSubtotalCny) || value.knownSubtotalCny < 0
    || typeof value.complete !== "boolean" || !strings(value.unknownInstanceIds)) errors.push("priceProjection fields invalid");
  if (!Array.isArray(value.lines) || !arraySortedBy(value.lines, (line) => line?.instanceId ?? "")) {
    errors.push("priceProjection line order invalid");
    return;
  }
  for (const [index, line] of value.lines.entries()) {
    const prefix = `priceProjection.lines.${index}`;
    if (line?.status === "known") {
      if (!exact(line, ["instanceId", "skuId", "quantity", "status", "priceCny", "currency", "platform", "quoteContentHash", "provenanceId", "listingUrl"])
        || !identifier(line.instanceId, 256) || !identifier(line.skuId, 512) || line.quantity !== 1
        || typeof line.priceCny !== "number" || !Number.isFinite(line.priceCny) || line.priceCny <= 0
        || line.currency !== "CNY" || !PRICE_PLATFORMS.has(line.platform) || !SHA256.test(line.quoteContentHash)
        || (line.provenanceId !== null && !scalarString(line.provenanceId, 512))
        || !scalarString(line.listingUrl, 4096) || !/^https:\/\//iu.test(line.listingUrl)) errors.push(`${prefix} known price invalid`);
    } else if (line?.status === "unknown" && line.reason === "no_audited_exact_variant_quote") {
      if (!exact(line, ["instanceId", "skuId", "quantity", "status", "reason"])
        || !identifier(line.instanceId, 256) || !identifier(line.skuId, 512) || line.quantity !== 1) errors.push(`${prefix} resolved unknown price invalid`);
    } else if (line?.status === "unknown" && line.reason === "identity_unresolved") {
      if (!exact(line, ["instanceId", "quantity", "status", "reason"])
        || !identifier(line.instanceId, 256) || line.quantity !== 1) errors.push(`${prefix} unresolved identity price invalid`);
    } else errors.push(`${prefix} status invalid`);
  }
  const bomIds = Array.isArray(topologyBom) ? topologyBom.map((line) => line?.instanceId) : [];
  if (!sameStrings(value.lines.map((line) => line.instanceId), bomIds)) errors.push("priceProjection lines do not cover the exact topology BOM");
  const unknownIds = value.lines.filter((line) => line.status === "unknown").map((line) => line.instanceId);
  const knownSubtotal = value.lines.reduce((sum, line) => sum + (line.status === "known" ? line.priceCny : 0), 0);
  if (!sameStrings(value.unknownInstanceIds, unknownIds) || value.knownSubtotalCny !== knownSubtotal
    || value.complete !== (value.lines.length > 0 && unknownIds.length === 0)) errors.push("priceProjection summary is self-reported incorrectly");
}

function validateAuthority(value, errors) {
  if (!exact(value, ["schemaVersion", "evaluationLockHash", "artifactLockfileHash", "configHash", "snapshotHashes", "ruleSet", "engine", "adapterSnapshot"])) {
    errors.push("authority shape invalid");
    return;
  }
  if (value.schemaVersion !== "progressive-evaluation-authority-v1"
    || !SHA256.test(value.evaluationLockHash) || !SHA256.test(value.artifactLockfileHash) || !SHA256.test(value.configHash)) errors.push("authority identity invalid");
  const hashFields = [
    "configHash", "requirementSpecHash", "factSnapshotHash", "userObservationSnapshotHash", "priceSnapshotHash",
    "ruleSetHash", "systemProfileHash", "adapterSnapshotHash", "engineHash", "simulationModelHash", "simulationInputHash",
  ];
  if (!exact(value.snapshotHashes, hashFields) || hashFields.some((field) => !SHA256.test(value.snapshotHashes?.[field]))) errors.push("authority snapshotHashes invalid");
  for (const role of ["ruleSet", "engine", "adapterSnapshot"]) {
    if (!exact(value[role], ["ref", "contentHash"]) || !SHA256.test(value[role]?.contentHash)
      || value[role]?.ref !== `sha256:${value[role]?.contentHash}`) errors.push(`authority ${role} invalid`);
  }
  if (record(value.snapshotHashes)) {
    if (value.configHash !== value.snapshotHashes.configHash) errors.push("authority configHash binding mismatch");
    if (value.ruleSet?.contentHash !== value.snapshotHashes.ruleSetHash) errors.push("authority ruleSet hash binding mismatch");
    if (value.engine?.contentHash !== value.snapshotHashes.engineHash) errors.push("authority engine hash binding mismatch");
    if (value.adapterSnapshot?.contentHash !== value.snapshotHashes.adapterSnapshotHash) errors.push("authority adapterSnapshot hash binding mismatch");
  }
}

function validateMissingInput(value, path, errors) {
  if (!exact(value, ["kind", "ref", "instanceIds", "safetyClass"])) { errors.push(`${path} shape invalid`); return; }
  if (!["component", "fact", "placement", "connection", "system_profile"].includes(value.kind)
    || !identifier(value.ref, 512) || !strings(value.instanceIds)
    || !["normal", "boot", "electrical_safety"].includes(value.safetyClass)) errors.push(`${path} invalid`);
}

function validateRuleEvaluation(value, path, errors) {
  if (!exact(value, ["ruleId", "ruleVersion", "domain", "applicability", "verdict", "inputStatus", "decisionIds", "requirementIds", "conflictSetIds", "missingInputs"])) {
    errors.push(`${path} shape invalid`);
    return;
  }
  if (!ruleIdentifier(value.ruleId) || !ruleVersion(value.ruleVersion) || !DOMAIN_SET.has(value.domain)
    || !["applicable", "not_applicable"].includes(value.applicability)
    || !["pass", "fail", "blocked", "unknown", "not_applicable"].includes(value.verdict)
    || !["complete", "missing", "conflicted"].includes(value.inputStatus)
    || !strings(value.decisionIds) || !strings(value.requirementIds) || !strings(value.conflictSetIds)) errors.push(`${path} fields invalid`);
  if (!Array.isArray(value.missingInputs)) errors.push(`${path} missingInputs invalid`);
  else {
    if (!arraySortedBy(value.missingInputs, (item) => `${item?.kind ?? ""}:${item?.ref ?? ""}:${Array.isArray(item?.instanceIds) ? item.instanceIds.join("+") : ""}`)) {
      errors.push(`${path} missingInputs order/uniqueness invalid`);
    }
    value.missingInputs.forEach((item, index) => validateMissingInput(item, `${path}.missingInputs.${index}`, errors));
  }
  if (value.inputStatus === "complete" && ((value.missingInputs?.length ?? 0) !== 0 || (value.conflictSetIds?.length ?? 0) !== 0)) errors.push(`${path} complete input carries gaps`);
  if (value.inputStatus === "conflicted" && (value.conflictSetIds?.length ?? 0) === 0) errors.push(`${path} conflicted input lacks conflicts`);
  if (value.inputStatus === "missing" && (value.missingInputs?.length ?? 0) === 0) errors.push(`${path} missing input lacks gaps`);
  if (value.applicability === "not_applicable" && (value.verdict !== "not_applicable" || value.inputStatus !== "complete"
    || value.decisionIds?.length !== 0 || value.requirementIds?.length !== 0 || value.conflictSetIds?.length !== 0
    || value.missingInputs?.length !== 0)) errors.push(`${path} not-applicable rule carries evaluation output`);
  if (value.applicability === "applicable" && value.verdict === "not_applicable") errors.push(`${path} applicable rule has not_applicable verdict`);
}

function validateDomainEvaluation(value, expectedDomain, path, errors) {
  if (!exact(value, ["domain", "verdict", "registeredRuleIds", "applicableRuleIds", "evaluatedRuleIds", "blockedRuleIds", "unknownRuleIds", "decisionIds", "requirementIds", "conflictSetIds", "evaluatedCoverage"])) {
    errors.push(`${path} shape invalid`);
    return;
  }
  if (value.domain !== expectedDomain || !["pass", "fail", "blocked", "unknown"].includes(value.verdict)) errors.push(`${path} domain/verdict invalid`);
  for (const field of ["registeredRuleIds", "applicableRuleIds", "evaluatedRuleIds", "blockedRuleIds", "unknownRuleIds", "decisionIds", "requirementIds", "conflictSetIds"]) {
    if (!strings(value[field])) errors.push(`${path}.${field} invalid`);
  }
  if (!exact(value.evaluatedCoverage, ["registeredRuleCount", "applicableRuleCount", "evaluatedRuleCount", "blockedRuleCount", "unknownRuleCount"])
    || Object.values(value.evaluatedCoverage ?? {}).some((count) => !nonNegativeInteger(count))) errors.push(`${path}.evaluatedCoverage invalid`);
}

export function validateCompatibilityRuleDefinitionRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "ruleId", "ruleVersion", "domain", "description", "safetyClass", "activation", "requiredInputs"])) return ["rule definition shape invalid"];
    const errors = [];
    if (value.schemaVersion !== "compatibility-rule-definition-v1" || !ruleIdentifier(value.ruleId)
      || !ruleVersion(value.ruleVersion) || !DOMAIN_SET.has(value.domain) || !scalarString(value.description, 2048)
      || !["normal", "boot", "electrical_safety"].includes(value.safetyClass)) errors.push("rule definition identity invalid");
    if (!exact(value.activation, ["topology", "anyComponentKinds"])
      || !["always", "non_empty"].includes(value.activation?.topology)
      || !strings(value.activation?.anyComponentKinds)
      || value.activation.anyComponentKinds.some((kind) => !COMPONENT_KINDS.has(kind))) errors.push("rule activation invalid");
    const inputs = value.requiredInputs;
    if (!exact(inputs, ["componentKinds", "facts", "placements", "connections", "systemProfile", "identityClosure", "nestedEvaluations", "adapterResources", "logicalLayouts"])) return [...errors, "rule requiredInputs shape invalid"];
    if (!Array.isArray(inputs.componentKinds)
      || !arraySortedBy(inputs.componentKinds, (item) => item?.componentKind ?? "")) errors.push("rule componentKinds invalid or non-canonical");
    else inputs.componentKinds.forEach((item, index) => {
      if (!exact(item, ["componentKind", "minCount", "missing"]) || !COMPONENT_KINDS.has(item.componentKind) || !positiveInteger(item.minCount)
        || !exact(item.missing, ["kind", "criticality"], ["requiredBefore"]) || item.missing.kind !== "component"
        || !["normal", "boot", "safety"].includes(item.missing.criticality)
        || (item.missing.requiredBefore !== undefined && !["assembly", "pre_power", "first_boot", "os_install"].includes(item.missing.requiredBefore))) errors.push(`rule componentKinds.${index} invalid`);
    });
    if (!Array.isArray(inputs.facts)
      || !arraySortedBy(inputs.facts, (item) => `${item?.componentKind ?? ""}:${item?.field ?? ""}`)) errors.push("rule facts invalid or non-canonical");
    else inputs.facts.forEach((item, index) => {
      if (!exact(item, ["componentKind", "field", "cardinality", "safetyClass", "requiredAuthority", "minimumScope", "missingRequirementKind"])
        || !COMPONENT_KINDS.has(item.componentKind) || !identifier(item.field, 256)
        || !Object.prototype.hasOwnProperty.call(FACT_FIELD_POLICY_RUNTIME, item.field)
        || !["single", "many"].includes(item.cardinality)
        || !["normal", "boot", "electrical_safety"].includes(item.safetyClass)
        || !["governed", "official"].includes(item.requiredAuthority)
        || !["family", "model", "variant", "revision", "plan_subject"].includes(item.minimumScope)
        || !["evidence", "measurement"].includes(item.missingRequirementKind)) errors.push(`rule facts.${index} invalid`);
    });
    if (!Array.isArray(inputs.placements)
      || !arraySortedBy(inputs.placements, (item) => `${item?.componentKind ?? ""}:${item?.mountOwnerKind ?? ""}`)) errors.push("rule placements invalid or non-canonical");
    else inputs.placements.forEach((item, index) => {
      if (!exact(item, ["componentKind", "mountOwnerKind", "minCount"]) || !COMPONENT_KINDS.has(item.componentKind)
        || !COMPONENT_KINDS.has(item.mountOwnerKind) || !nonNegativeInteger(item.minCount)) errors.push(`rule placements.${index} invalid`);
    });
    if (!Array.isArray(inputs.connections)
      || !arraySortedBy(inputs.connections, (item) => `${item?.fromKind ?? ""}:${item?.toKind ?? ""}`)) errors.push("rule connections invalid or non-canonical");
    else inputs.connections.forEach((item, index) => {
      if (!exact(item, ["fromKind", "toKind", "minCount", "cableRequired"]) || !COMPONENT_KINDS.has(item.fromKind)
        || !COMPONENT_KINDS.has(item.toKind) || !nonNegativeInteger(item.minCount) || typeof item.cableRequired !== "boolean") errors.push(`rule connections.${index} invalid`);
    });
    if (inputs.systemProfile !== null && (!exact(inputs.systemProfile, ["required", "allowedProfileIds"])
      || typeof inputs.systemProfile.required !== "boolean" || !strings(inputs.systemProfile.allowedProfileIds)
      || inputs.systemProfile.allowedProfileIds.some((id) => !SYSTEM_PROFILES.has(id)))) errors.push("rule systemProfile invalid");
    if (inputs.identityClosure !== null && (!exact(inputs.identityClosure, ["allPresentComponents", "safetyClass", "missingRequirementKind"])
      || inputs.identityClosure.allPresentComponents !== true
      || !["normal", "boot", "electrical_safety"].includes(inputs.identityClosure.safetyClass)
      || inputs.identityClosure.missingRequirementKind !== "evidence")) errors.push("rule identityClosure invalid");
    if (!exact(inputs.nestedEvaluations, ["assemblySafety", "firmwarePaths", "systemProfileChecks", "thermalAcoustic"])
      || typeof inputs.nestedEvaluations.assemblySafety !== "boolean"
      || typeof inputs.nestedEvaluations.firmwarePaths !== "boolean"
      || typeof inputs.nestedEvaluations.systemProfileChecks !== "boolean"
      || typeof inputs.nestedEvaluations.thermalAcoustic !== "boolean") errors.push("rule nestedEvaluations invalid");
    if (!exact(inputs.adapterResources, ["resourcePatterns", "bundleItems"])
      || typeof inputs.adapterResources.resourcePatterns !== "boolean"
      || typeof inputs.adapterResources.bundleItems !== "boolean") errors.push("rule adapterResources invalid");
    if (typeof inputs.logicalLayouts !== "boolean") errors.push("rule logicalLayouts invalid");
    return errors;
  } catch {
    return ["rule definition validation failed closed"];
  }
}

function evidenceLevel(value) {
  return ["official", "standard", "inferred", "unknown"].includes(value);
}

function validateThermalAcousticEvaluation(value, authority, errors) {
  if (!exact(value, ["schemaVersion", "simulationInputHash", "simulationInputClosureHash", "workloadId", "calibration", "thermal", "acoustic"])) {
    errors.push("thermalAcousticEvaluation shape invalid");
    return;
  }
  if (value.schemaVersion !== "production-thermal-acoustic-evaluation-v1"
    || !SHA256.test(value.simulationInputHash)
    || (value.simulationInputClosureHash !== null && !SHA256.test(value.simulationInputClosureHash))
    || !identifier(value.workloadId, 512)
    || value.simulationInputHash !== authority?.snapshotHashes?.simulationInputHash) {
    errors.push("thermalAcousticEvaluation authority invalid");
  }
  if (!exact(value.calibration, ["appliedThermalObservationIds", "rejectedThermalObservationIds", "appliedAcousticObservationIds", "rejectedAcousticObservationIds"])
    || !strings(value.calibration?.appliedThermalObservationIds)
    || !strings(value.calibration?.rejectedThermalObservationIds)
    || !strings(value.calibration?.appliedAcousticObservationIds)
    || !strings(value.calibration?.rejectedAcousticObservationIds)) {
    errors.push("thermalAcousticEvaluation calibration closure invalid");
  }

  const thermal = value.thermal;
  if (!exact(thermal, ["schemaVersion", "ambientC", "airflow", "chambers", "components", "peakTemperatureC", "verdict", "energyBalanceToleranceW", "energyBalanceResidualW", "blockedReasonCodes", "assumptions", "evidence", "displayNotice"])) {
    errors.push("thermal evaluation shape invalid");
  } else {
    if (thermal.schemaVersion !== "thermal-network-evaluation-v1" || !numericRange(thermal.ambientC)
      || !["pass", "fail", "blocked"].includes(thermal.verdict)
      || !nonNegativeFinite(thermal.energyBalanceToleranceW) || !nonNegativeFinite(thermal.energyBalanceResidualW)
      || !strings(thermal.blockedReasonCodes) || !strings(thermal.assumptions, { ids: false, sorted: false })
      || !evidenceLevel(thermal.evidence) || thermal.displayNotice !== "规划热场插值，非 CFD、非实测") {
      errors.push("thermal evaluation fields invalid");
    }
    const airflow = thermal.airflow;
    if (!exact(airflow, ["schemaVersion", "fanOperatingPoints", "chambers", "blockedReasonCodes", "assumptions"])) {
      errors.push("thermal airflow result shape invalid");
    } else {
      if (airflow.schemaVersion !== "airflow-network-result-v1" || !strings(airflow.blockedReasonCodes)
        || !strings(airflow.assumptions, { ids: false, sorted: false })) errors.push("thermal airflow result fields invalid");
      if (!Array.isArray(airflow.fanOperatingPoints) || !arraySortedBy(airflow.fanOperatingPoints, (entry) => entry?.edgeId ?? "")) {
        errors.push("thermal fan operating points invalid");
      } else airflow.fanOperatingPoints.forEach((entry, index) => {
        if (!exact(entry, ["schemaVersion", "edgeId", "airflowCfm", "staticPressurePa", "rpm", "evidence", "sourceRefs", "assumptions"])
          || entry.schemaVersion !== "fan-operating-point-v1" || !identifier(entry.edgeId, 512)
          || !numericRange(entry.airflowCfm, { nonnegative: true }) || !numericRange(entry.staticPressurePa, { nonnegative: true })
          || !numericRange(entry.rpm, { nonnegative: true }) || !evidenceLevel(entry.evidence)
          || !strings(entry.sourceRefs) || !strings(entry.assumptions, { ids: false, sorted: false })) errors.push(`thermal fan operating point ${index} invalid`);
      });
      if (!Array.isArray(airflow.chambers) || !arraySortedBy(airflow.chambers, (entry) => entry?.chamberId ?? "")) {
        errors.push("thermal airflow chambers invalid");
      } else airflow.chambers.forEach((entry, index) => {
        if (!exact(entry, ["chamberId", "airflowCfm", "evidence", "fanEdgeIds"])
          || !identifier(entry.chamberId, 512) || !numericRange(entry.airflowCfm, { nonnegative: true })
          || !evidenceLevel(entry.evidence) || !strings(entry.fanEdgeIds)) errors.push(`thermal airflow chamber ${index} invalid`);
      });
    }
    if (!Array.isArray(thermal.chambers) || !arraySortedBy(thermal.chambers, (entry) => entry?.chamberId ?? "")) {
      errors.push("thermal chambers invalid");
    } else thermal.chambers.forEach((entry, index) => {
      if (!exact(entry, ["chamberId", "heatW", "airflowCfm", "outletTemperatureC", "verdict", "sourceRefs", "assumptions"])
        || !identifier(entry.chamberId, 512) || !numericRange(entry.heatW, { nonnegative: true })
        || !numericRange(entry.airflowCfm, { nonnegative: true })
        || (entry.outletTemperatureC !== null && !numericRange(entry.outletTemperatureC))
        || !["pass", "fail", "blocked"].includes(entry.verdict) || !strings(entry.sourceRefs)
        || !strings(entry.assumptions, { ids: false, sorted: false })) errors.push(`thermal chamber ${index} invalid`);
    });
    if (!Array.isArray(thermal.components) || !arraySortedBy(thermal.components, (entry) => entry?.sourceId ?? "")) {
      errors.push("thermal components invalid");
    } else thermal.components.forEach((entry, index) => {
      if (!exact(entry, ["sourceId", "componentInstanceId", "chamberId", "temperatureC", "maximumTemperatureC", "verdict", "evidence", "sourceRefs"])
        || !identifier(entry.sourceId, 512) || !identifier(entry.componentInstanceId, 512) || !identifier(entry.chamberId, 512)
        || (entry.temperatureC !== null && !numericRange(entry.temperatureC))
        || (entry.maximumTemperatureC !== null && !finiteNumber(entry.maximumTemperatureC))
        || !["pass", "fail", "blocked"].includes(entry.verdict) || !evidenceLevel(entry.evidence)
        || !strings(entry.sourceRefs)) errors.push(`thermal component ${index} invalid`);
    });
    if (thermal.peakTemperatureC !== null && !numericRange(thermal.peakTemperatureC)) errors.push("thermal peak interval invalid");
    const expectedThermalVerdict = thermal.components?.some((entry) => entry?.verdict === "fail") ? "fail"
      : (thermal.blockedReasonCodes?.length > 0 || thermal.components?.some((entry) => entry?.verdict === "blocked")
        || thermal.chambers?.some((entry) => entry?.verdict === "blocked")) ? "blocked" : "pass";
    if (thermal.verdict !== expectedThermalVerdict) errors.push("thermal verdict is self-reported incorrectly");
  }

  const acoustic = value.acoustic;
  if (!exact(acoustic, ["schemaVersion", "referenceDistanceM", "loadId", "testMethodId", "totalDba", "level", "verdict", "blockedReasonCodes", "contributions", "excludedSourceIds", "coilWhineRisks", "assumptions", "displayNotice"])) {
    errors.push("acoustic evaluation shape invalid");
  } else {
    if (acoustic.schemaVersion !== "acoustic-evaluation-v1" || acoustic.referenceDistanceM !== 1
      || acoustic.loadId !== value.workloadId || !identifier(acoustic.testMethodId, 512)
      || (acoustic.totalDba !== null && !numericRange(acoustic.totalDba))
      || !["quiet", "normal", "audible", "loud", "unknown"].includes(acoustic.level)
      || !["pass", "fail", "blocked"].includes(acoustic.verdict)
      || !strings(acoustic.blockedReasonCodes) || !strings(acoustic.excludedSourceIds)
      || !strings(acoustic.assumptions, { ids: false, sorted: false })
      || acoustic.displayNotice !== "标准化硬件声源结果，不代表房间或用户位置的实际噪音") {
      errors.push("acoustic evaluation fields invalid");
    }
    if (!Array.isArray(acoustic.contributions)) errors.push("acoustic contributions invalid");
    else acoustic.contributions.forEach((entry, index) => {
      if (!exact(entry, ["sourceId", "componentInstanceId", "soundPressureDbaAt1M", "shareOfUpperEnergy", "evidence", "sourceRefs"])
        || !identifier(entry.sourceId, 512) || !identifier(entry.componentInstanceId, 512)
        || !numericRange(entry.soundPressureDbaAt1M) || !finiteNumber(entry.shareOfUpperEnergy)
        || entry.shareOfUpperEnergy < 0 || entry.shareOfUpperEnergy > 1 || !evidenceLevel(entry.evidence)
        || !strings(entry.sourceRefs)) errors.push(`acoustic contribution ${index} invalid`);
    });
    if (!Array.isArray(acoustic.coilWhineRisks)) errors.push("acoustic coil-whine risks invalid");
    else acoustic.coilWhineRisks.forEach((entry, index) => {
      if (!exact(entry, ["componentInstanceId", "risk", "sourceRefs", "note"])
        || !identifier(entry.componentInstanceId, 512) || !["unknown", "reported", "observed"].includes(entry.risk)
        || !strings(entry.sourceRefs) || !scalarString(entry.note, 4096)) errors.push(`acoustic coil-whine risk ${index} invalid`);
    });
    const expectedAcousticBlocked = acoustic.blockedReasonCodes?.length > 0 || acoustic.totalDba === null
      || acoustic.contributions?.some((entry) => entry?.evidence === "unknown");
    if (expectedAcousticBlocked && acoustic.verdict !== "blocked") errors.push("acoustic verdict is fail-open");
    if (!expectedAcousticBlocked && acoustic.verdict === "blocked") errors.push("acoustic blocked verdict lacks a declared gap");
    if ((acoustic.totalDba === null) !== (acoustic.level === "unknown")) errors.push("acoustic level/interval mismatch");
  }
}

export function validateProgressiveBuildEvaluationRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "kind", "configSchemaVersion", "authority", "topologyBom", "priceProjection", "decisions", "requirements", "requirementClosure", "requirementAllocation", "requirementReadiness", "firmwareCapabilities", "firmwareEvaluations", "assemblySafetyEvaluations", "thermalAcousticEvaluation", "ruleEvaluations", "domainEvaluations", "coverage", "readiness"])) {
      return ["progressive evaluation shape invalid"];
    }
    const errors = [];
    if (value.schemaVersion !== "progressive-build-evaluation-v1" || value.kind !== "topology-v3-progressive" || value.configSchemaVersion !== "3.0.0") errors.push("progressive evaluation identity invalid");
    validateAuthority(value.authority, errors);

    if (!Array.isArray(value.topologyBom) || !arraySortedBy(value.topologyBom, (line) => line?.instanceId ?? "")) errors.push("topologyBom order invalid");
    else value.topologyBom.forEach((line, index) => validateBomLine(line, `topologyBom.${index}`, errors));
    validatePriceProjection(value.priceProjection, value.topologyBom, errors);
    if (!Array.isArray(value.decisions) || !arraySortedBy(value.decisions, (item) => item?.decisionId ?? "")) errors.push("decisions order invalid");
    else value.decisions.forEach((item, index) => validateDecision(item, `decisions.${index}`, errors));
    if (!Array.isArray(value.requirements) || !arraySortedBy(value.requirements, (item) => item?.requirementId ?? "")) errors.push("requirements order invalid");
    else value.requirements.forEach((item, index) => validateRequirement(item, `requirements.${index}`, errors));
    errors.push(...validateRequirementClosureRuntime(value.requirementClosure).map((error) => `requirementClosure: ${error}`));
    errors.push(...validateRequirementAllocationResultRuntime(value.requirementAllocation).map((error) => `requirementAllocation: ${error}`));
    errors.push(...validateRequirementReadinessRuntime(value.requirementReadiness, value.requirementAllocation).map((error) => `requirementReadiness: ${error}`));
    if (!Array.isArray(value.firmwareCapabilities)
      || !arraySortedBy(value.firmwareCapabilities, (item) => firmwareCapabilityTupleKeyRuntime(item) ?? "")) {
      errors.push("firmwareCapabilities order/uniqueness invalid");
    } else value.firmwareCapabilities.forEach((item, index) => {
      errors.push(...validateFirmwareCapabilityRuntime(item).map((error) => `firmwareCapabilities.${index}: ${error}`));
    });
    const structuralCapabilities = new Map((Array.isArray(value.firmwareCapabilities) ? value.firmwareCapabilities : [])
      .map((capability) => [capability.contentHash, capability]));
    if (!Array.isArray(value.firmwareEvaluations)
      || !arraySortedBy(value.firmwareEvaluations, (item) => item?.instanceId ?? "")) errors.push("firmwareEvaluations order/uniqueness invalid");
    else value.firmwareEvaluations.forEach((item, index) => {
      const capability = structuralCapabilities.get(item?.capabilityRef?.contentHash);
      if (capability === undefined) errors.push(`firmwareEvaluations.${index} capability missing`);
      else errors.push(...validateFirmwarePathEvaluationRuntime(item, capability).map((error) => `firmwareEvaluations.${index}: ${error}`));
      errors.push(...validateFirmwarePathRequirementClosureRuntime(item, value.requirementAllocation)
        .map((error) => `firmwareEvaluations.${index} requirement closure: ${error}`));
    });
    const usedCapabilityHashes = new Set((Array.isArray(value.firmwareEvaluations) ? value.firmwareEvaluations : [])
      .map((evaluation) => evaluation?.capabilityRef?.contentHash));
    if (structuralCapabilities.size !== (value.firmwareCapabilities?.length ?? 0)
      || [...structuralCapabilities.keys()].some((contentHash) => !usedCapabilityHashes.has(contentHash))) {
      errors.push("firmwareCapabilities must be the exact content-hash set used by firmware evaluations");
    }
    if (!Array.isArray(value.assemblySafetyEvaluations)
      || !arraySortedBy(value.assemblySafetyEvaluations, (item) => item?.assemblyId ?? "")) errors.push("assemblySafetyEvaluations order/uniqueness invalid");
    else value.assemblySafetyEvaluations.forEach((item, index) => {
      errors.push(...validateAssemblySafetyEvaluationRuntime(item).map((error) => `assemblySafetyEvaluations.${index}: ${error}`));
    });
    validateThermalAcousticEvaluation(value.thermalAcousticEvaluation, value.authority, errors);
    if (!Array.isArray(value.ruleEvaluations) || !arraySortedBy(value.ruleEvaluations, (item) => `${item?.ruleId ?? ""}@${item?.ruleVersion ?? ""}`)) errors.push("ruleEvaluations order invalid");
    else value.ruleEvaluations.forEach((item, index) => validateRuleEvaluation(item, `ruleEvaluations.${index}`, errors));
    if (!Array.isArray(value.domainEvaluations) || value.domainEvaluations.length !== DOMAINS.length) errors.push("domainEvaluations must cover every domain exactly once");
    else value.domainEvaluations.forEach((item, index) => validateDomainEvaluation(item, DOMAINS[index], `domainEvaluations.${index}`, errors));

    const decisions = Array.isArray(value.decisions) ? value.decisions : [];
    const requirements = Array.isArray(value.requirements) ? value.requirements : [];
    const rules = Array.isArray(value.ruleEvaluations) ? value.ruleEvaluations : [];
    const domains = Array.isArray(value.domainEvaluations) ? value.domainEvaluations : [];
    const firmwareEvaluations = Array.isArray(value.firmwareEvaluations) ? value.firmwareEvaluations : [];
    const assemblyEvaluations = Array.isArray(value.assemblySafetyEvaluations) ? value.assemblySafetyEvaluations : [];
    const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
    const requirementById = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
    if (decisionById.size !== decisions.length) errors.push("decision IDs are not unique");
    if (requirementById.size !== requirements.length) errors.push("requirement IDs are not unique");
    if (canonicalJson(requirements) !== canonicalJson(value.requirementClosure?.requirements)) errors.push("top-level requirements do not match requirement closure");
    if (canonicalJson(requirements) !== canonicalJson(value.requirementAllocation?.requirements)) errors.push("requirement allocation does not consume the exact closure");
    if (!sameStrings(value.requirementAllocation?.blockedRequirementIds, value.requirementClosure?.blockedRequirementIds)) {
      errors.push("requirement allocation blocked authority does not match requirement closure");
    }

    const ruleKeys = rules.map((rule) => `${rule.ruleId}@${rule.ruleVersion}`);
    if (new Set(ruleKeys).size !== ruleKeys.length) errors.push("rule evaluation identities are not unique");
    const ruleByKey = new Map(rules.map((rule) => [`${rule.ruleId}@${rule.ruleVersion}`, rule]));
    const rootIds = new Set(Array.isArray(value.requirementClosure?.rootRequirementIds) ? value.requirementClosure.rootRequirementIds : []);
    const closureRuleKeys = new Set(Array.isArray(value.requirementClosure?.ruleRefs)
      ? value.requirementClosure.ruleRefs.map((rule) => `${rule.ruleId}@${rule.ruleVersion}`) : []);
    const firmwareRequirements = firmwareEvaluations.flatMap((evaluation) => Array.isArray(evaluation.derivedRequirements) ? evaluation.derivedRequirements : []);
    const firmwareRuleKeys = new Set(firmwareRequirements.map((requirement) => `${requirement.producedBy?.ruleId}@${requirement.producedBy?.ruleVersion}`));
    const assemblyRequirements = assemblyEvaluations.flatMap((evaluation) => Array.isArray(evaluation.requirements) ? evaluation.requirements : []);
    const assemblyRuleKeys = new Set(assemblyRequirements.map((requirement) => `${requirement.producedBy?.ruleId}@${requirement.producedBy?.ruleVersion}`));
    for (const rule of rules) {
      const ownDecisions = decisions.filter((decision) => decision.ruleId === rule.ruleId && decision.ruleVersion === rule.ruleVersion);
      const ownRequirements = requirements.filter((requirement) => rootIds.has(requirement.requirementId)
        && requirement.producedBy?.ruleId === rule.ruleId && requirement.producedBy?.ruleVersion === rule.ruleVersion);
      const expectedDecisionIds = ownDecisions.map((item) => item.decisionId).sort(compare);
      const expectedRequirementIds = ownRequirements.map((item) => item.requirementId).sort(compare);
      if (!sameStrings(rule.decisionIds, expectedDecisionIds) || !sameStrings(rule.requirementIds, expectedRequirementIds)) errors.push(`rule ${rule.ruleId} output references do not close`);
      if (ownDecisions.some((decision) => decision.domain !== rule.domain)) errors.push(`rule ${rule.ruleId} decision domain mismatch`);
      const computedVerdict = aggregateVerdicts(ownDecisions.map((decision) => decision.verdict));
      if (rule.applicability === "applicable" && rule.verdict !== computedVerdict) errors.push(`rule ${rule.ruleId} verdict is self-reported incorrectly`);
      if (rule.applicability === "not_applicable" && rule.verdict !== "not_applicable") errors.push(`rule ${rule.ruleId} applicability/verdict mismatch`);
      if ((rule.verdict === "pass" || rule.verdict === "fail") && rule.inputStatus !== "complete") errors.push(`rule ${rule.ruleId} evaluated without complete inputs`);
      if (rule.verdict === "unknown" && rule.inputStatus !== "missing") errors.push(`rule ${rule.ruleId} unknown verdict lacks a declared gap`);
      if (rule.verdict === "blocked" && ownDecisions.every((decision) => decision.verdict !== "blocked")) errors.push(`rule ${rule.ruleId} blocked verdict lacks a blocked decision`);
    }
    const thermalRule = ruleByKey.get("compat.thermal-simulation@1.0.0");
    const acousticRule = ruleByKey.get("compat.acoustic-simulation@1.0.0");
    if (thermalRule?.applicability === "applicable"
      && thermalRule.verdict !== value.thermalAcousticEvaluation?.thermal?.verdict) {
      errors.push("thermal rule verdict differs from the governed thermal evaluation");
    }
    if (acousticRule?.applicability === "applicable"
      && acousticRule.verdict !== value.thermalAcousticEvaluation?.acoustic?.verdict) {
      errors.push("acoustic rule verdict differs from the governed acoustic evaluation");
    }
    for (const decision of decisions) {
      const rule = ruleByKey.get(`${decision.ruleId}@${decision.ruleVersion}`);
      if (!rule || rule.domain !== decision.domain) errors.push(`decision ${decision.decisionId} references an absent rule`);
      for (const remediation of decision.remediation ?? []) {
        const canonical = requirementById.get(remediation.requirementId);
        if (!canonical || canonicalJson(canonical) !== canonicalJson(remediation)) errors.push(`decision ${decision.decisionId} remediation is not the canonical top-level requirement`);
      }
    }
    for (const requirement of requirements) {
      const producer = `${requirement.producedBy?.ruleId}@${requirement.producedBy?.ruleVersion}`;
      if (!ruleByKey.has(producer) && !closureRuleKeys.has(producer) && !firmwareRuleKeys.has(producer) && !assemblyRuleKeys.has(producer)) {
        errors.push(`requirement ${requirement.requirementId} references an absent rule authority`);
      }
    }
    for (const firmwareRequirement of firmwareRequirements) {
      const canonical = requirementById.get(firmwareRequirement.requirementId);
      if (!canonical || canonicalJson(canonical) !== canonicalJson(firmwareRequirement)) {
        errors.push(`firmware requirement ${firmwareRequirement.requirementId} is absent from the shared closure`);
      }
    }
    for (const assemblyRequirement of assemblyRequirements) {
      const canonical = requirementById.get(assemblyRequirement.requirementId);
      if (!canonical || canonicalJson(canonical) !== canonicalJson(assemblyRequirement)) {
        errors.push(`assembly requirement ${assemblyRequirement.requirementId} is absent from the shared closure`);
      }
    }

    for (const domain of domains) {
      const registeredRules = rules.filter((rule) => rule.domain === domain.domain);
      const registered = registeredRules.map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort(compare);
      const domainRules = registeredRules.filter((rule) => rule.applicability === "applicable");
      const applicable = domainRules.map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort(compare);
      const evaluated = domainRules.filter((rule) => rule.verdict === "pass" || rule.verdict === "fail").map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort(compare);
      const blocked = domainRules.filter((rule) => rule.verdict === "blocked").map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort(compare);
      const unknown = domainRules.filter((rule) => rule.verdict === "unknown").map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort(compare);
      const domainDecisionIds = domainRules.flatMap((rule) => rule.decisionIds).sort(compare);
      const domainRequirementIds = domainRules.flatMap((rule) => rule.requirementIds).sort(compare);
      const conflictIds = [...new Set(domainRules.flatMap((rule) => rule.conflictSetIds))].sort(compare);
      if (!sameStrings(domain.registeredRuleIds, registered) || !sameStrings(domain.applicableRuleIds, applicable) || !sameStrings(domain.evaluatedRuleIds, evaluated)
        || !sameStrings(domain.blockedRuleIds, blocked) || !sameStrings(domain.unknownRuleIds, unknown)
        || !sameStrings(domain.decisionIds, domainDecisionIds) || !sameStrings(domain.requirementIds, domainRequirementIds)
        || !sameStrings(domain.conflictSetIds, conflictIds)) errors.push(`domain ${domain.domain} coverage references are self-reported incorrectly`);
      const expectedCounts = [registeredRules.length, applicable.length, evaluated.length, blocked.length, unknown.length];
      const actualCounts = [domain.evaluatedCoverage?.registeredRuleCount, domain.evaluatedCoverage?.applicableRuleCount, domain.evaluatedCoverage?.evaluatedRuleCount, domain.evaluatedCoverage?.blockedRuleCount, domain.evaluatedCoverage?.unknownRuleCount];
      if (expectedCounts.some((count, index) => actualCounts[index] !== count)) errors.push(`domain ${domain.domain} coverage counts are self-reported incorrectly`);
      const verdict = aggregateVerdicts(domainRules.map((rule) => rule.verdict));
      if (domain.verdict !== verdict) errors.push(`domain ${domain.domain} verdict is self-reported incorrectly`);
    }

    const expectedCoverage = {
      totalDomainCount: DOMAINS.length,
      registeredRuleCount: rules.length,
      evaluatedDomainCount: domains.filter((domain) => domain.verdict === "pass" || domain.verdict === "fail").length,
      applicableRuleCount: rules.filter((rule) => rule.applicability === "applicable").length,
      evaluatedRuleCount: rules.filter((rule) => rule.verdict === "pass" || rule.verdict === "fail").length,
      blockedRuleCount: rules.filter((rule) => rule.verdict === "blocked").length,
      unknownRuleCount: rules.filter((rule) => rule.verdict === "unknown").length,
    };
    if (!exact(value.coverage, Object.keys(expectedCoverage)) || Object.entries(expectedCoverage).some(([key, count]) => value.coverage?.[key] !== count)) errors.push("evaluation coverage is self-reported incorrectly");

    if (!exact(value.readiness, ["profileCompleteness", "identityCompleteness", "compatibilityVerdict", "systemAvailabilityVerdict", "assemblyReady", "powerReady", "firstBootReady", "osInstallReady"])) errors.push("readiness shape invalid");
    else {
      const bom = Array.isArray(value.topologyBom) ? value.topologyBom : [];
      const satisfactionByRequirementId = new Map((value.requirementAllocation?.satisfactions ?? [])
        .map((satisfaction) => [satisfaction.requirementId, satisfaction.status]));
      const profileGap = requirements.some((requirement) => ["component", "system_action", "user_decision"].includes(requirement.kind)
        && satisfactionByRequirementId.get(requirement.requirementId) !== "satisfied");
      const expectedProfile = bom.length === 0 ? "empty" : profileGap ? "partial" : "complete";
      const unresolved = bom.filter((line) => line.identityStatus === "unresolved").length;
      const expectedIdentity = bom.length === 0 ? "empty" : unresolved === 0 ? "complete" : "partial";
      const domainVerdict = (name) => domains.find((domain) => domain.domain === name)?.verdict ?? "unknown";
      const expectedCompatibility = aggregateVerdicts(["mechanical", "electrical", "firmware", "storage", "assembly", "routing"].map(domainVerdict));
      const expectedSystem = aggregateVerdicts(["firmware", "system", "storage", "commissioning"].map(domainVerdict));
      const allPass = (names) => names.every((name) => domainVerdict(name) === "pass");
      const expectedAssemblyReady = value.requirementReadiness?.assemblyReady === true
        && expectedProfile === "complete" && expectedIdentity === "complete"
        && allPass(["identity", "mechanical", "assembly"]);
      const expectedPowerReady = value.requirementReadiness?.powerReady === true
        && expectedProfile === "complete" && expectedIdentity === "complete"
        && allPass(["identity", "mechanical", "electrical", "assembly"]);
      const expectedFirstBootReady = value.requirementReadiness?.firstBootReady === true
        && expectedProfile === "complete" && expectedIdentity === "complete"
        && allPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage"]);
      const expectedOsInstallReady = value.requirementReadiness?.osInstallReady === true
        && expectedProfile === "complete" && expectedIdentity === "complete"
        && allPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage", "system", "commissioning"]);
      if (value.readiness.profileCompleteness !== expectedProfile || value.readiness.identityCompleteness !== expectedIdentity
        || value.readiness.compatibilityVerdict !== expectedCompatibility || value.readiness.systemAvailabilityVerdict !== expectedSystem
        || value.readiness.assemblyReady !== expectedAssemblyReady
        || value.readiness.powerReady !== expectedPowerReady
        || value.readiness.firstBootReady !== expectedFirstBootReady
        || value.readiness.osInstallReady !== expectedOsInstallReady) errors.push("readiness is self-reported incorrectly");
      if (value.readiness.assemblyReady && (expectedProfile !== "complete" || expectedIdentity !== "complete"
        || !allPass(["identity", "mechanical", "assembly"]))) errors.push("assemblyReady is fail-open");
      if (value.readiness.powerReady && (expectedProfile !== "complete" || expectedIdentity !== "complete"
        || !allPass(["identity", "mechanical", "electrical", "assembly"]))) errors.push("powerReady is fail-open");
      if (value.readiness.firstBootReady && (expectedProfile !== "complete" || expectedIdentity !== "complete"
        || !allPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage"]))) errors.push("firstBootReady is fail-open");
      if (value.readiness.osInstallReady && (expectedProfile !== "complete" || expectedIdentity !== "complete"
        || !allPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage", "system", "commissioning"]))) errors.push("osInstallReady is fail-open");
    }
    return errors;
  } catch {
    return ["progressive evaluation validation failed closed"];
  }
}

export function isProgressiveBuildEvaluationRuntime(value) {
  return validateProgressiveBuildEvaluationRuntime(value).length === 0;
}

function assemblyObservationEntryValid(entry, planId, configHash) {
  const observation = entry?.observation;
  return exact(entry, ["recordHash", "observation", "projectionContext", "attachmentClosureVerified"])
    && SHA256.test(String(entry.recordHash ?? ""))
    && verifyUserObservationRuntime(observation)
    && entry.recordHash === sha256Utf8Runtime(canonicalJson(observation))
    && entry.attachmentClosureVerified === true
    && observation.planId === planId
    && observation.status === "active"
    && observation.confirmedByUser === true
    && observation.validatedAt !== undefined
    && observation.invalidatedAt === undefined
    && exact(entry.projectionContext, ["planId", "subjectExists", "currentConfigHash", "currentSubjectRevisionHash"])
    && entry.projectionContext.planId === planId
    && entry.projectionContext.subjectExists === true
    && entry.projectionContext.currentConfigHash === configHash
    && entry.projectionContext.currentSubjectRevisionHash === observation.subjectRevisionHash;
}

function connectionObservationScope(check, observation, config) {
  if (observation?.subjectRef?.kind !== "connection") return false;
  const connection = config.connections.find((entry) => entry?.connectionId === observation.subjectRef.connectionId);
  return connection !== undefined
    && check.instanceIds.includes(connection.from?.instanceId)
    && check.instanceIds.includes(connection.to?.instanceId);
}

function assemblyCheckClaimsObservedState(check) {
  if (check?.checkType === "standoff_layout") return check.observed !== null;
  if (check?.checkType === "connection") return check.state !== "unknown";
  if (check?.checkType === "12v2x6") {
    return check.state !== "unknown" || check.fullySeated !== null || check.bendDistanceMm !== null;
  }
  if (check?.checkType === "protective_film" || check?.checkType === "loose_metal") {
    return check.state !== "unknown";
  }
  return false;
}

function assemblyCheckObservationErrors(check, entries, config, prefix) {
  const errors = [];
  const observations = entries.map((entry) => entry.observation);
  if (check.checkType === "resource") {
    const assertionHash = assemblyResourceAssertionHashRuntime(check);
    for (const observation of observations) {
      const scoped = observation?.subjectRef?.kind === "instance"
        && observation.subjectRef.instanceId === check.ownerInstanceId;
      if (!scoped || assertionHash === null
        || observation.fieldId !== "assembly.resource_assertion_hash"
        || observation.value !== assertionHash) {
        errors.push(`${prefix} resource observation is not bound to the exact owner/resource assertion`);
      }
    }
    return errors;
  }
  const assertionHash = assemblyCheckAssertionHashRuntime(check);
  const assertionObservations = observations.filter((observation) => observation?.subjectRef?.kind === "instance"
    && observation.subjectRef.instanceId === check.ownerInstanceId
    && observation.fieldId === "assembly.check_assertion_hash"
    && observation.value === assertionHash);
  if (assertionHash === null || (assemblyCheckClaimsObservedState(check) && assertionObservations.length === 0)) {
    errors.push(`${prefix} lacks an exact owner/check assertion`);
  }
  const supplemental = observations.filter((observation) => !assertionObservations.includes(observation));
  if (check.checkType === "standoff_layout") {
    const expectedPositions = new Set(check.expectedPositionIds);
    const observedPositions = new Set((check.observed ?? []).map((item) => item.positionId));
    const relevantPositions = new Set([...expectedPositions, ...observedPositions]);
    const referencedPositions = new Set();
    for (const observation of supplemental) {
      const subject = observation?.subjectRef;
      if (subject?.kind !== "mount" || subject.ownerInstanceId !== check.ownerInstanceId
        || !relevantPositions.has(subject.mountId) || observation.fieldId !== "mount.standoff_present"
        || typeof observation.value !== "boolean"
        || (check.observed !== null && observation.value !== observedPositions.has(subject.mountId))) {
        errors.push(`${prefix} standoff observation is not bound to the governed owner/position/presence`);
      } else referencedPositions.add(subject.mountId);
    }
    if (supplemental.length > 0 && check.observed !== null
      && [...relevantPositions].some((positionId) => !referencedPositions.has(positionId))) {
      errors.push(`${prefix} observed standoff layout lacks per-position observation authority`);
    }
  } else if (check.checkType === "connection" || check.checkType === "12v2x6") {
    const expectedConnected = check.state === "connected_verified" ? true
      : check.state === "disconnected_verified" || check.state === "wrong_connector_verified" ? false : null;
    for (const observation of supplemental) {
      if (!connectionObservationScope(check, observation, config)) {
        errors.push(`${prefix} connection observation is not bound to a locked edge between target instances`);
        continue;
      }
      if (observation.fieldId === "connection.connected" && typeof observation.value === "boolean") {
        if (expectedConnected !== null && observation.value !== expectedConnected) errors.push(`${prefix} connection observation value differs from the evaluated state`);
      } else if (check.checkType === "12v2x6" && observation.fieldId === "physical.clearance"
        && typeof observation.value === "number" && observation.value === check.bendDistanceMm) {
        // Exact check authority above binds seating/standard/state; this optional
        // measurement adds independent bend-distance evidence.
      } else errors.push(`${prefix} connection observation field/value is unrelated to the evaluated check`);
    }
  } else {
    for (const observation of supplemental) {
      const subject = observation?.subjectRef;
      const scoped = subject?.kind === "plan"
        || (subject?.kind === "instance" && check.instanceIds.includes(subject.instanceId));
      if (!scoped || !["photo", "visual_confirmation"].includes(String(observation?.method))) {
        errors.push(`${prefix} visual assembly observation is not bound to the plan/target instances`);
      }
    }
  }
  return errors;
}

/**
 * Bind persisted assembly check state to current, plan-scoped observations.
 * The existing observation registry cannot encode film/loose-metal fields, so
 * those checks are conservatively limited to visual evidence on this plan or
 * one of the exact target instances; representable checks also bind field and
 * value.
 */
export function validateAssemblyObservationBindingsRuntime(evaluations, observationClosure, config, configHash) {
  try {
    if (!Array.isArray(evaluations) || !record(observationClosure) || !Array.isArray(observationClosure.observations)
      || !record(config) || config.schemaVersion !== "3.0.0" || !Array.isArray(config.components)
      || !Array.isArray(config.connections) || !SHA256.test(String(configHash ?? ""))) {
      return ["assembly observation binding context invalid"];
    }
    const errors = [];
    const byId = new Map(observationClosure.observations.map((entry) => [entry?.observation?.observationId, entry]));
    const resourceKeys = new Set();
    const resourceObservationIds = new Set();
    const standoffPositionKeys = new Set();
    const nonResourceSemanticKeys = new Set();
    const nonResourceAssertionObservationIds = new Set();
    if (byId.size !== observationClosure.observations.length) errors.push("assembly observation closure identities repeat");
    for (const [evaluationIndex, evaluation] of evaluations.entries()) {
      const evaluationErrors = validateAssemblySafetyEvaluationRuntime(evaluation);
      if (evaluationErrors.length) {
        errors.push(...evaluationErrors.map((error) => `assemblySafetyEvaluations.${evaluationIndex}: ${error}`));
        continue;
      }
      for (const [checkIndex, check] of evaluation.checks.entries()) {
        const prefix = `assemblySafetyEvaluations.${evaluationIndex}.checks.${checkIndex}`;
        if (check.checkType === "resource") {
          const resourceKey = `${check.ownerInstanceId}\0${check.resourceId}`;
          if (resourceKeys.has(resourceKey)) errors.push(`${prefix} repeats a physical owner/resource assertion`);
          else resourceKeys.add(resourceKey);
          for (const observationId of check.observationIds) {
            if (resourceObservationIds.has(observationId)) {
              errors.push(`${prefix} reuses a resource observation across assembly checks`);
            } else resourceObservationIds.add(observationId);
          }
        } else {
          const semanticHash = assemblyCheckAssertionHashRuntime(check);
          if (semanticHash !== null) {
            const semanticKey = `${check.ownerInstanceId}\0${semanticHash}`;
            if (nonResourceSemanticKeys.has(semanticKey)) {
              errors.push(`${prefix} repeats an owner/semantic assembly check`);
            } else nonResourceSemanticKeys.add(semanticKey);
          }
          if (check.checkType === "standoff_layout") {
            const positions = new Set([
              ...check.expectedPositionIds,
              ...(check.observed ?? []).map((entry) => entry.positionId),
            ]);
            for (const positionId of positions) {
              const positionKey = `${check.ownerInstanceId}\0${positionId}`;
              if (standoffPositionKeys.has(positionKey)) {
                errors.push(`${prefix} repeats a physical owner/standoff position`);
              } else standoffPositionKeys.add(positionKey);
            }
          }
        }
        const entries = [];
        for (const observationId of check.observationIds) {
          const entry = byId.get(observationId);
          if (!entry || !assemblyObservationEntryValid(entry, config.id, configHash)) {
            errors.push(`${prefix} observation ${observationId} lacks current locked authority`);
          } else entries.push(entry);
        }
        if (check.checkType !== "resource") {
          const semanticHash = assemblyCheckAssertionHashRuntime(check);
          for (const entry of entries) {
            const observation = entry.observation;
            if (semanticHash !== null && observation?.subjectRef?.kind === "instance"
              && observation.subjectRef.instanceId === check.ownerInstanceId
              && observation.fieldId === "assembly.check_assertion_hash"
              && observation.value === semanticHash) {
              if (nonResourceAssertionObservationIds.has(observation.observationId)) {
                errors.push(`${prefix} reuses an exact check assertion observation`);
              } else nonResourceAssertionObservationIds.add(observation.observationId);
            }
          }
        }
        errors.push(...assemblyCheckObservationErrors(check, entries, config, prefix));
      }
    }
    return [...new Set(errors)];
  } catch {
    return ["assembly observation binding validation failed closed"];
  }
}

function projectBomRuntime(config) {
  if (!record(config) || !Array.isArray(config.components)) return null;
  return [...config.components].sort((left, right) => compare(left?.instanceId ?? "", right?.instanceId ?? ""))
    .map((component) => {
      const base = {
        instanceId: component.instanceId,
        kind: component.kind,
        role: component.role,
        state: component.state,
        quantity: 1,
      };
      if (component.identity?.status === "resolved") return {
        ...base,
        identityStatus: "resolved",
        skuId: component.identity.skuId,
        identityClaimIds: [...component.identity.identityClaimIds].sort(compare),
      };
      return {
        ...base,
        identityStatus: "unresolved",
        userText: component.identity?.userText,
        ...(component.identity?.candidateIds !== undefined
          ? { candidateIds: [...component.identity.candidateIds].sort(compare) } : {}),
      };
    });
}

function firmwareCpuBindingRuntime(config, targetInstanceId) {
  const cpus = (config?.components ?? []).filter((component) => component?.kind === "cpu");
  const cpuById = new Map(cpus.map((component) => [component.instanceId, component]));
  const placed = (config?.placements ?? [])
    .filter((placement) => placement?.mountOwnerInstanceId === targetInstanceId && cpuById.has(placement.componentInstanceId))
    .map((placement) => cpuById.get(placement.componentInstanceId));
  const candidates = placed.length > 0 ? placed : cpus;
  if (candidates.some((component) => component?.identity?.status !== "resolved")) {
    return { skuId: null, ambiguous: candidates.length > 0 };
  }
  const skuIds = [...new Set(candidates.map((component) => component.identity.skuId))];
  return skuIds.length <= 1 ? { skuId: skuIds[0] ?? null, ambiguous: false } : { skuId: null, ambiguous: true };
}

function derivedFirmwareAvailableFactIdsRuntime(factClosure, capability) {
  const required = new Set((capability?.transitions ?? [])
    .flatMap((transition) => transition?.powerPrerequisiteFactIds ?? []));
  return sortedUnique((Array.isArray(factClosure?.facts) ? factClosure.facts : [])
    .filter((fact) => required.has(fact?.factId) && fact?.status === "active" && fact?.authority === "official")
    .map((fact) => fact.factId));
}

function derivedFirmwarePreflightRuntime(targetInstanceId, assemblyEvaluations) {
  const supplies = (Array.isArray(assemblyEvaluations) ? assemblyEvaluations : [])
    .flatMap((evaluation) => projectVerifiedAssemblySuppliesRuntime(evaluation) ?? []);
  const hasVerifiedComponent = (category) => supplies.some((supply) => supply?.source === "user_resource"
    && supply.ownerInstanceId === targetInstanceId && supply.kind === "component"
    && supply.availability === "present_verified" && supply.verificationStatus === "verified"
    && supply.facets?.some((facet) => facet?.facetId === "identity.category" && facet?.value === category));
  return {
    workingCpuAvailable: hasVerifiedComponent("cpu") ? true : null,
    workingMemoryAvailable: hasVerifiedComponent("memory_module") ? true : null,
    displayPathAvailable: hasVerifiedComponent("gpu") ? true : null,
  };
}

function derivedFirmwareRequestedSettingsRuntime(target, capability) {
  const evidenceBySetting = new Map((capability?.settings ?? [])
    .map((setting) => [setting?.settingId, setting?.sourceFactIds ?? []]));
  return [...(target?.requestedSettings ?? [])].map((setting) => ({
    settingId: setting.settingId,
    desiredValue: setting.desiredValue,
    evidenceRefs: sortedUnique(evidenceBySetting.get(setting.settingId) ?? []),
  })).sort((left, right) => compare(left.settingId, right.settingId));
}

function derivedFirmwareCurrentObservationRuntime(
  observationClosure,
  targetInstanceId,
  capability,
  planId,
  configHash,
  errors,
  prefix,
) {
  const matches = (Array.isArray(observationClosure?.observations) ? observationClosure.observations : [])
    .filter((entry) => entry?.observation?.planId === planId && entry?.observation?.status === "active"
      && entry?.observation?.subjectRef?.kind === "firmware_instance"
      && entry.observation.subjectRef.instanceId === targetInstanceId
      && entry.observation.fieldId === "firmware.bios_version");
  if (matches.length > 1) {
    errors.push(`${prefix} current observation is not unique in the locked closure`);
    return null;
  }
  const entry = matches[0];
  if (entry === undefined) return null;
  const observation = entry.observation;
  const method = capability?.versionIdentification?.method;
  const allowedMethods = method === "label_observation"
    ? ["label", "photo", "visual_confirmation"] : ["photo", "visual_confirmation", "user_assertion"];
  if (!assemblyObservationEntryValid(entry, planId, configHash) || typeof observation.value !== "string"
    || !allowedMethods.includes(observation.method)) {
    errors.push(`${prefix} current observation lacks locked plan/subject/method authority`);
    return null;
  }
  return {
    observationId: observation.observationId,
    releaseFactId: observation.value,
    method,
    evidenceRefs: sortedUnique([
      ...(observation.attachmentRefs ?? []),
      `observation:${observation.observationId}@sha256:${entry.recordHash}`,
    ]),
  };
}

function compatibilityManifestEntries(payload, errors) {
  if (!exact(payload, ["schemaVersion", "ruleIds", "sources"])
    || payload.schemaVersion !== "workspace-rule-set-v1" || !strings(payload.ruleIds)) {
    errors.push("locked ruleSet payload shape/IDs invalid");
    return [];
  }
  if (!Array.isArray(payload.sources)
    || !arraySortedBy(payload.sources, (source) => source?.moduleId ?? "")) errors.push("locked ruleSet sources order/uniqueness invalid");
  else payload.sources.forEach((source, index) => {
    if (!exact(source, ["moduleId", "bytes"]) || !identifier(source.moduleId, 256) || !sourceBytes(source.bytes)) {
      errors.push(`locked ruleSet source ${index} invalid`);
    }
  });
  const manifestSource = Array.isArray(payload.sources)
    ? payload.sources.find((source) => source?.moduleId === "compatibility/rule-manifest") : undefined;
  let manifest;
  try { manifest = manifestSource === undefined ? null : JSON.parse(manifestSource.bytes); }
  catch { manifest = null; }
  if (!Array.isArray(manifest)
    || !arraySortedBy(manifest, (entry) => `${entry?.ruleId ?? ""}@${entry?.ruleVersion ?? ""}`)) {
    errors.push("locked compatibility manifest order/uniqueness invalid");
    return [];
  }
  for (const [index, entry] of manifest.entries()) {
    if (!exact(entry, ["ruleId", "ruleVersion", "domain", "implementationModuleIds", "definitionHash"])
      || !ruleIdentifier(entry.ruleId) || !ruleVersion(entry.ruleVersion) || !DOMAIN_SET.has(entry.domain)
      || !strings(entry.implementationModuleIds, { allowEmpty: false }) || !SHA256.test(entry.definitionHash)) {
      errors.push(`locked compatibility manifest entry ${index} invalid`);
    }
    if (!payload.ruleIds.includes(`${entry.ruleId}@${entry.ruleVersion}`)) errors.push(`locked compatibility manifest entry ${index} absent from ruleIds`);
  }
  if (compatibilityRuleManifestHashRuntime(manifest) !== BUILTIN_COMPATIBILITY_RULE_MANIFEST_HASH_RUNTIME) {
    errors.push("locked compatibility manifest differs from the executable builtin manifest");
  }
  const compatRuleIds = payload.ruleIds.filter((id) => id.startsWith("compat.")).sort(compare);
  const manifestRuleIds = manifest.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`);
  if (!sameStrings(compatRuleIds, manifestRuleIds)) errors.push("locked compatibility manifest does not close compatibility ruleIds");
  return manifest;
}

export function compatibilityRuleManifestHashRuntime(value) {
  try {
    if (!Array.isArray(value)
      || !arraySortedBy(value, (entry) => `${entry?.ruleId ?? ""}@${entry?.ruleVersion ?? ""}`)) return null;
    for (const entry of value) {
      if (!exact(entry, ["ruleId", "ruleVersion", "domain", "implementationModuleIds", "definitionHash"])
        || !ruleIdentifier(entry.ruleId) || !ruleVersion(entry.ruleVersion) || !DOMAIN_SET.has(entry.domain)
        || !strings(entry.implementationModuleIds, { allowEmpty: false }) || !SHA256.test(entry.definitionHash)) return null;
    }
    return sha256Utf8Runtime(canonicalJson(value));
  } catch { return null; }
}

function engineSourceIds(payload, errors) {
  if (!record(payload) || payload.schemaVersion !== "workspace-engine-v1" || !Array.isArray(payload.sources)
    || !arraySortedBy(payload.sources, (source) => source?.moduleId ?? "")) {
    errors.push("locked engine payload sources invalid");
    return new Set();
  }
  const ids = new Set();
  const sourcesById = new Map(payload.sources.map((source) => [source?.moduleId, source]));
  for (const [index, source] of payload.sources.entries()) {
    if (!exact(source, ["moduleId", "bytes"]) || !identifier(source.moduleId, 256) || !sourceBytes(source.bytes)) {
      errors.push(`locked engine source ${index} invalid`);
    } else {
      ids.add(source.moduleId);
      let binding = null;
      try { binding = JSON.parse(source.bytes); } catch { binding = null; }
      if (record(binding) && binding.schemaVersion === "workspace-bundled-module-source-v1") {
        const bundle = sourcesById.get(binding.bundleModuleId);
        if (!exact(binding, ["schemaVersion", "moduleId", "bundleModuleId", "bundleHash"])
          || binding.moduleId !== source.moduleId
          || binding.bundleModuleId !== "workspace-server-runtime-bundle"
          || !SHA256.test(binding.bundleHash)
          || !exact(bundle, ["moduleId", "bytes"])
          || !sourceBytes(bundle.bytes)
          || sha256Utf8Runtime(bundle.bytes) !== binding.bundleHash) {
          errors.push(`locked engine bundled source ${index} closure invalid`);
        }
      }
    }
  }
  return ids;
}

/**
 * Validates the portable evaluation together with the immutable evaluation
 * lock and the three executable artifact roles that define its semantics.
 * This deliberately excludes repository-specific fact/observation replay;
 * callers that have those inputs should use the full closure validator below.
 */
export function validateProgressiveBuildEvaluationAuthorityRuntime(value, context) {
  try {
    const errors = validateProgressiveBuildEvaluationRuntime(value);
    const required = ["evaluationLock", "artifactLockfile", "ruleSetPayload", "enginePayload", "adapterSnapshotPayload"];
    if (!record(context) || !exact(context, required)) {
      return [...errors, "progressive evaluation authority context shape invalid"];
    }
    errors.push(...validatePlanEvaluationLockRuntime(context.evaluationLock)
      .map((error) => `evaluationLock: ${error}`));
    errors.push(...validateArtifactLockfileRuntime(context.artifactLockfile)
      .map((error) => `artifactLockfile: ${error}`));
    const lock = context.evaluationLock;
    const lockfile = context.artifactLockfile;
    const ruleRef = lockfile?.artifacts?.ruleSet;
    const engineRef = lockfile?.artifacts?.engine;
    const adapterRef = lockfile?.artifacts?.adapterSnapshot;
    if (ruleRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: ruleRef, payload: context.ruleSetPayload })
      .map((error) => `ruleSet: ${error}`));
    if (engineRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: engineRef, payload: context.enginePayload })
      .map((error) => `engine: ${error}`));
    if (adapterRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: adapterRef, payload: context.adapterSnapshotPayload })
      .map((error) => `adapterSnapshot: ${error}`));
    if (lock?.contentHash !== value?.authority?.evaluationLockHash
      || lock?.artifactLockfileHash !== lockfile?.lockfileHash
      || lockfile?.lockfileHash !== value?.authority?.artifactLockfileHash
      || canonicalJson(lock?.snapshotHashes) !== canonicalJson(value?.authority?.snapshotHashes)) {
      errors.push("evaluation lock/authority closure mismatch");
    }
    if (ruleRef?.ref !== value?.authority?.ruleSet?.ref || ruleRef?.contentHash !== value?.authority?.ruleSet?.contentHash
      || engineRef?.ref !== value?.authority?.engine?.ref || engineRef?.contentHash !== value?.authority?.engine?.contentHash
      || adapterRef?.ref !== value?.authority?.adapterSnapshot?.ref || adapterRef?.contentHash !== value?.authority?.adapterSnapshot?.contentHash) {
      errors.push("artifact lock/authority role binding mismatch");
    }
    const manifest = compatibilityManifestEntries(context.ruleSetPayload, errors);
    const manifestKeys = manifest.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`);
    const evaluatedKeys = Array.isArray(value?.ruleEvaluations)
      ? value.ruleEvaluations.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`) : [];
    if (!sameStrings(manifestKeys, evaluatedKeys)) errors.push("executed compatibility rule set differs from locked manifest");
    const manifestByKey = new Map(manifest.map((entry) => [`${entry.ruleId}@${entry.ruleVersion}`, entry]));
    for (const evaluation of value?.ruleEvaluations ?? []) {
      const entry = manifestByKey.get(`${evaluation.ruleId}@${evaluation.ruleVersion}`);
      if (!entry || entry.domain !== evaluation.domain) errors.push(`rule evaluation ${evaluation.ruleId} differs from locked manifest`);
    }
    const engineSources = engineSourceIds(context.enginePayload, errors);
    for (const entry of manifest) {
      for (const moduleId of entry.implementationModuleIds ?? []) {
        if (!engineSources.has(moduleId)) errors.push(`locked engine omits compatibility implementation source ${moduleId}`);
      }
    }
    return errors;
  } catch {
    return ["progressive evaluation authority validation failed closed"];
  }
}

function compatibilityTokenRuntime(value) {
  const token = String(value).normalize("NFC").toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return token || "item";
}

function runtimePatternRequirement(pattern, ownerInstanceId, targetInstanceId, placement, need) {
  const kind = ["standoff", "bracket", "adapter"].includes(need.kind) ? "accessory" : need.kind;
  const predicates = need.specification.map((predicate) => ({
    facetId: predicate.facetId,
    operator: predicate.operator,
    value: structuredClone(predicate.value),
    ...(predicate.facetId === "fastener.length_mm" ? { unitId: "mm" } : {}),
  })).sort((left, right) => compare(
    `${left.facetId}\0${left.operator}\0${JSON.stringify(left.value)}\0${left.unitId ?? ""}`,
    `${right.facetId}\0${right.operator}\0${JSON.stringify(right.value)}\0${right.unitId ?? ""}`,
  ));
  return {
    requirementId: `requirement.pattern.${ownerInstanceId}.${placement.placementId}.${pattern.patternId}.${need.needTemplateId}`,
    kind,
    predicates,
    quantity: need.quantity,
    criticality: need.criticality,
    requiredBefore: need.requiredBefore,
    producedBy: {
      ruleId: `assembly.resource-pattern.${pattern.patternId}`,
      ruleVersion: pattern.contentHash,
      instanceIds: sortedUnique([ownerInstanceId, targetInstanceId]),
    },
    evidenceRefs: sortedUnique(pattern.evidenceFactIds),
  };
}

/** Rebuild adapter fixed-point rules from the exact locked manifests/config. */
function lockedAdapterClosureReplayMaterial(config, manifests, authoritativeRoots, errors) {
  const roots = Array.isArray(authoritativeRoots) ? authoritativeRoots : [];
  if (!Array.isArray(authoritativeRoots)) errors.push("authoritative requirement roots are unavailable");
  const groups = new Map();
  for (const owner of config?.components ?? []) {
    if (owner?.kind !== "case" || owner?.identity?.status !== "resolved") continue;
    const candidates = manifests.filter((manifest) => manifest?.identity?.skuId === owner.identity.skuId);
    if (candidates.length !== 1) continue;
    const manifest = candidates[0];
    const manifestErrors = validateCaseAdapterManifestRuntime(manifest);
    if (manifestErrors.length) {
      errors.push(...manifestErrors.map((error) => `adapter closure manifest ${owner.instanceId}: ${error}`));
      continue;
    }
    const placements = (config.placements ?? []).filter((placement) => placement?.mountOwnerInstanceId === owner.instanceId);
    for (const placement of placements) for (const pattern of manifest.resourcePatterns) {
      const triggerId = `requirement-${compatibilityTokenRuntime("compat.adapter-resource-closure")}-${compatibilityTokenRuntime(`${owner.instanceId}-${placement.placementId}-${pattern.patternId}`)}`;
      const trigger = {
        requirementId: triggerId,
        kind: "evidence",
        predicates: [],
        quantity: 1,
        criticality: "normal",
        producedBy: { ruleId: "compat.adapter-resource-closure", ruleVersion: "1.0.0", instanceIds: [owner.instanceId] },
        evidenceRefs: sortedUnique([...pattern.evidenceFactIds, pattern.contentHash]),
      };
      const actualTrigger = roots.find((requirement) => requirement?.requirementId === triggerId);
      if (actualTrigger === undefined || canonicalJson(actualTrigger) !== canonicalJson(trigger)) {
        errors.push(`adapter closure trigger differs from locked manifest/config: ${triggerId}`);
      }
      const ruleId = `assembly.resource-pattern.${pattern.patternId}`;
      const ruleVersion = pattern.contentHash;
      const key = `${ruleId}\0${ruleVersion}`;
      const group = groups.get(key) ?? { ruleId, ruleVersion, byTrigger: new Map() };
      const projected = pattern.mountStandardIds.includes(placement.mountId)
        ? pattern.needs.map((need) => runtimePatternRequirement(pattern, owner.instanceId, placement.componentInstanceId, placement, need))
          .sort((left, right) => compare(left.requirementId, right.requirementId)) : [];
      if (group.byTrigger.has(triggerId)) errors.push(`adapter closure trigger is duplicated: ${triggerId}`);
      else group.byTrigger.set(triggerId, projected);
      groups.set(key, group);
    }
  }
  const rules = [...groups.values()].sort((left, right) => compare(`${left.ruleId}\0${left.ruleVersion}`, `${right.ruleId}\0${right.ruleVersion}`))
    .map((group) => ({
      ruleId: group.ruleId,
      ruleVersion: group.ruleVersion,
      expand(requirement) {
        const projected = group.byTrigger.get(requirement.requirementId) ?? [];
        return projected.map((node) => ({ requirement: structuredClone(node), parentRequirementIds: [requirement.requirementId] }));
      },
    }));
  return { roots, rules };
}

/**
 * Replay/authority validation against exact repository-resolved inputs. This is
 * deliberately separate from the portable structural validator so backup and
 * production graph callers can fail closed when any locked byte is absent.
 */
export function validateProgressiveBuildEvaluationClosureRuntime(value, context) {
  try {
    const errors = validateProgressiveBuildEvaluationRuntime(value);
    const required = ["config", "evaluationLock", "artifactLockfile", "ruleSetPayload", "enginePayload", "adapterSnapshotPayload", "priceSnapshot"];
    if (!record(context) || required.some((key) => !Object.prototype.hasOwnProperty.call(context, key))
      || Object.keys(context).some((key) => ![...required, "factClosure", "observationClosure", "firmwareCapabilities", "firmwarePathInputs", "firmwareFixedPointRootRequirements", "assemblySafetyInputs", "requirementRoots", "checkpointBindings"].includes(key))) {
      return [...errors, "progressive evaluation closure context shape invalid"];
    }
    errors.push(...validatePlanConfigRuntime(context.config, { topologyV3Enabled: true }).map((error) => `config: ${error}`));
    errors.push(...validatePlanEvaluationLockRuntime(context.evaluationLock).map((error) => `evaluationLock: ${error}`));
    errors.push(...validateArtifactLockfileRuntime(context.artifactLockfile).map((error) => `artifactLockfile: ${error}`));
    const lockfile = context.artifactLockfile;
    const lock = context.evaluationLock;
    const ruleRef = lockfile?.artifacts?.ruleSet;
    const engineRef = lockfile?.artifacts?.engine;
    const adapterRef = lockfile?.artifacts?.adapterSnapshot;
    if (ruleRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: ruleRef, payload: context.ruleSetPayload }).map((error) => `ruleSet: ${error}`));
    if (engineRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: engineRef, payload: context.enginePayload }).map((error) => `engine: ${error}`));
    if (adapterRef) errors.push(...validateEvaluationArtifactInputRuntime({ ref: adapterRef, payload: context.adapterSnapshotPayload }).map((error) => `adapterSnapshot: ${error}`));
    const computedConfigHash = hashPlanConfigRuntime(context.config);
    if (computedConfigHash === null || computedConfigHash !== value?.authority?.configHash
      || computedConfigHash !== lock?.snapshotHashes?.configHash) errors.push("config hash/evaluation authority closure mismatch");
    if (lock?.contentHash !== value?.authority?.evaluationLockHash
      || lock?.artifactLockfileHash !== lockfile?.lockfileHash
      || lockfile?.lockfileHash !== value?.authority?.artifactLockfileHash
      || canonicalJson(lock?.snapshotHashes) !== canonicalJson(value?.authority?.snapshotHashes)) {
      errors.push("evaluation lock/authority closure mismatch");
    }
    if (ruleRef?.ref !== value?.authority?.ruleSet?.ref || ruleRef?.contentHash !== value?.authority?.ruleSet?.contentHash
      || engineRef?.ref !== value?.authority?.engine?.ref || engineRef?.contentHash !== value?.authority?.engine?.contentHash
      || adapterRef?.ref !== value?.authority?.adapterSnapshot?.ref || adapterRef?.contentHash !== value?.authority?.adapterSnapshot?.contentHash) {
      errors.push("artifact lock/authority role binding mismatch");
    }
    const projected = projectBomRuntime(context.config);
    if (projected === null || canonicalJson(projected) !== canonicalJson(value?.topologyBom)) errors.push("topologyBom differs from locked BuildConfig V3 projection");
    const priceProjection = projectProgressivePriceRuntime(value?.topologyBom, context.priceSnapshot);
    if (priceProjection === null || canonicalJson(priceProjection) !== canonicalJson(value?.priceProjection)) {
      errors.push("priceProjection differs from the locked governed price snapshot");
    }
    if (context.priceSnapshot?.ref?.contentHash !== lock?.snapshotHashes?.priceSnapshotHash
      || value?.priceProjection?.priceSnapshotHash !== lock?.snapshotHashes?.priceSnapshotHash) {
      errors.push("priceProjection snapshot hash binding mismatch");
    }
    const adapterManifests = Array.isArray(context.adapterSnapshotPayload?.caseManifests)
      ? context.adapterSnapshotPayload.caseManifests : [];
    const packageBindings = [];
    for (const component of context.config?.components ?? []) {
      if (component?.kind !== "case" || component?.identity?.status !== "resolved") continue;
      const matching = adapterManifests.filter((manifest) => manifest?.identity?.skuId === component.identity.skuId);
      if (matching.length === 1) packageBindings.push({ ownerInstanceId: component.instanceId, manifest: matching[0] });
    }
    errors.push(...validateRequirementAllocationGeneratedSupplyClosureRuntime(value?.requirementAllocation, {
      packageBindings,
      assemblyEvaluations: value?.assemblySafetyEvaluations ?? [],
    }).map((error) => `generated allocation closure: ${error}`));
    errors.push(...validateRequirementAllocationCheckpointClosureRuntime(value?.requirementAllocation, context.checkpointBindings ?? [])
      .map((error) => `checkpoint allocation closure: ${error}`));
    errors.push(...validateRequirementAllocationReplayRuntime(value?.requirementAllocation, {
      blockedRequirementIds: value?.requirementClosure?.blockedRequirementIds ?? [],
      checkpointBindings: context.checkpointBindings ?? [],
    }).map((error) => `requirement allocation replay: ${error}`));
    const requirementReplay = lockedAdapterClosureReplayMaterial(
      context.config,
      adapterManifests,
      context.requirementRoots,
      errors,
    );
    errors.push(...validateRequirementClosureReplayRuntime(value?.requirementClosure, requirementReplay)
      .map((error) => `requirement fixed-point closure: ${error}`));

    const manifest = compatibilityManifestEntries(context.ruleSetPayload, errors);
    const manifestKeys = manifest.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`);
    const evaluatedKeys = Array.isArray(value?.ruleEvaluations)
      ? value.ruleEvaluations.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`) : [];
    if (!sameStrings(manifestKeys, evaluatedKeys)) errors.push("executed compatibility rule set differs from locked manifest");
    const manifestByKey = new Map(manifest.map((entry) => [`${entry.ruleId}@${entry.ruleVersion}`, entry]));
    for (const evaluation of value?.ruleEvaluations ?? []) {
      const entry = manifestByKey.get(`${evaluation.ruleId}@${evaluation.ruleVersion}`);
      if (!entry || entry.domain !== evaluation.domain) errors.push(`rule evaluation ${evaluation.ruleId} differs from locked manifest`);
    }
    const engineSources = engineSourceIds(context.enginePayload, errors);
    for (const entry of manifest) {
      for (const moduleId of entry.implementationModuleIds ?? []) {
        if (!engineSources.has(moduleId)) errors.push(`locked engine omits compatibility implementation source ${moduleId}`);
      }
    }

    const instanceIds = new Set(Array.isArray(context.config?.components)
      ? context.config.components.map((component) => component.instanceId) : []);
    const refs = progressiveEvaluationReferencesRuntime(value, context.firmwareCapabilities);
    if (refs === null) errors.push("progressive evaluation references cannot be derived");
    else if (refs.instanceIds.some((instanceId) => !instanceIds.has(instanceId))) errors.push("progressive evaluation references a non-existent component instance");

    if (context.factClosure === undefined && refs !== null && (refs.factIds.length > 0 || refs.conflictSetIds.length > 0)) {
      errors.push("referenced fact/conflict closure is unavailable");
    } else if (context.factClosure !== undefined) {
      if (!exact(context.factClosure, ["snapshot", "facts", "conflicts", "decisions"])
        || !Array.isArray(context.factClosure.facts) || !Array.isArray(context.factClosure.conflicts)
        || !Array.isArray(context.factClosure.decisions) || !verifyFactSnapshotRuntime(context.factClosure.snapshot)) {
        errors.push("factClosure shape invalid");
      } else if (refs !== null) {
        const facts = context.factClosure.facts;
        const conflicts = context.factClosure.conflicts;
        const decisions = context.factClosure.decisions;
        const factById = new Map(facts.map((fact) => [fact?.factId, fact]));
        const conflictById = new Map(conflicts.map((conflict) => [conflict?.conflictSetId, conflict]));
        const decisionById = new Map(decisions.map((decision) => [decision?.updateDecisionId, decision]));
        const snapshotFactRefs = context.factClosure.snapshot?.factRefs ?? [];
        const snapshotConflictRefs = context.factClosure.snapshot?.conflictRefs ?? [];
        if (context.factClosure.snapshot?.snapshotId !== lock?.factSnapshotId
          || context.factClosure.snapshot?.contentHash !== lock?.snapshotHashes?.factSnapshotHash
          || factById.size !== facts.length || conflictById.size !== conflicts.length || decisionById.size !== decisions.length
          || snapshotFactRefs.length !== facts.length || snapshotConflictRefs.length !== conflicts.length
          || snapshotFactRefs.some((ref) => factById.get(ref.factId)?.contentHash !== ref.contentHash)
          || snapshotConflictRefs.some((ref) => conflictById.get(ref.conflictSetId)?.contentHash !== ref.contentHash)) {
          errors.push("factClosure snapshot membership/lock binding invalid");
        }
        for (const fact of facts) if (!verifyFactRecordRuntime(fact)) errors.push(`factClosure fact ${String(fact?.factId)} authority invalid`);
        for (const conflict of conflicts) {
          if (!verifyConflictSetRuntime(conflict)) errors.push(`factClosure conflict ${String(conflict?.conflictSetId)} authority invalid`);
          const memberIds = [...(conflict?.factIds ?? []), ...(conflict?.resolutionFactIds ?? [])];
          if (memberIds.some((factId) => {
            const fact = factById.get(factId);
            return !fact || fact.field !== conflict.field || canonicalJson(fact.subject) !== canonicalJson(conflict.subject);
          }) || (conflict?.decisionIds ?? []).some((decisionId) => !decisionById.has(decisionId))) {
            errors.push(`factClosure conflict ${String(conflict?.conflictSetId)} member authority invalid`);
          }
        }
        for (const decision of decisions) {
          if (!verifyUpdateDecisionRuntime(decision)
            || !conflicts.some((conflict) => conflict.decisionIds.includes(decision.updateDecisionId))) {
            errors.push(`factClosure decision ${String(decision?.updateDecisionId)} authority invalid`);
          }
        }
        if (refs.factIds.some((factId) => !factById.has(factId))) errors.push("progressive evaluation references a fact outside the locked closure");
        if (refs.conflictSetIds.some((conflictId) => !conflictById.has(conflictId))) errors.push("progressive evaluation references a conflict outside the locked closure");
      }
    }
    if (context.observationClosure === undefined && refs !== null && refs.observationRefs.length > 0) {
      errors.push("referenced observation closure is unavailable");
    } else if (context.observationClosure !== undefined && refs !== null) {
      if (!exact(context.observationClosure, ["snapshot", "observations"])
        || !verifyUserObservationSnapshotRuntime(context.observationClosure.snapshot)
        || !Array.isArray(context.observationClosure.observations)) {
        errors.push("observationClosure shape invalid");
      } else {
        const entries = context.observationClosure.observations;
        const byId = new Map(entries.map((entry) => [entry?.observation?.observationId, entry]));
        const snapshotIds = context.observationClosure.snapshot?.observationIds ?? [];
        if (byId.size !== entries.length || byId.size !== snapshotIds.length
          || snapshotIds.some((id) => !byId.has(id))
          || context.observationClosure.snapshot?.planId !== context.config?.id) {
          errors.push("observationClosure snapshot membership invalid");
        }
        for (const [id, entry] of byId.entries()) {
          if (!identifier(id, 256) || !exact(entry, ["recordHash", "observation", "projectionContext", "attachmentClosureVerified"])
            || !SHA256.test(entry?.recordHash) || !verifyUserObservationRuntime(entry?.observation)
            || entry?.recordHash !== sha256Utf8Runtime(canonicalJson(entry.observation))
            || context.observationClosure.snapshot?.observationRecordHashes?.[id] !== entry.recordHash
            || entry?.attachmentClosureVerified !== true || entry?.observation?.planId !== context.config?.id
            || entry?.observation?.status !== "active" || entry?.observation?.confirmedByUser !== true
            || entry?.observation?.validatedAt === undefined || entry?.observation?.invalidatedAt !== undefined
            || !exact(entry?.projectionContext, ["planId", "subjectExists", "currentConfigHash", "currentSubjectRevisionHash"])
            || entry?.projectionContext?.planId !== context.config?.id || entry?.projectionContext?.subjectExists !== true
            || entry?.projectionContext?.currentConfigHash !== computedConfigHash
            || entry?.projectionContext?.currentSubjectRevisionHash !== entry?.observation?.subjectRevisionHash) {
            errors.push(`observationClosure record ${String(id)} authority invalid`);
          }
        }
        const referenced = refs.observationRefs.map((ref) => ref.startsWith("observation:") ? ref.slice("observation:".length).split("@")[0] : ref);
        if (referenced.some((id) => !byId.has(id))) errors.push("progressive evaluation references an observation outside the locked closure");
        for (const firmwareEntry of value?.firmwareEvaluations ?? []) {
          const current = firmwareEntry?.currentObservation;
          if (current === null || current === undefined) continue;
          const locked = byId.get(current.observationId);
          const observation = locked?.observation;
          const allowedMethods = current.method === "label_observation"
            ? ["label", "photo", "visual_confirmation"] : ["photo", "visual_confirmation", "user_assertion"];
          const authorityRef = locked ? `observation:${current.observationId}@sha256:${locked.recordHash}` : "";
          const allowedEvidence = new Set([...(observation?.attachmentRefs ?? []), authorityRef]);
          if (!observation || observation.subjectRef?.kind !== "firmware_instance"
            || observation.subjectRef.instanceId !== firmwareEntry.instanceId
            || observation.fieldId !== "firmware.bios_version" || observation.value !== current.releaseFactId
            || !allowedMethods.includes(observation.method)
            || current.evidenceRefs.length === 0 || current.evidenceRefs.some((ref) => !allowedEvidence.has(ref))) {
            errors.push(`firmware observation ${current.observationId} differs from the locked plan/subject/release evidence`);
          }
        }
      }
    }
    const lockedFactsById = new Map((Array.isArray(context.factClosure?.facts) ? context.factClosure.facts : [])
      .map((fact) => [fact?.factId, fact]));
    for (const firmwareEntry of value?.firmwareEvaluations ?? []) {
      for (const factId of firmwareEntry?.searchAuthority?.availableFactIds ?? []) {
        const fact = lockedFactsById.get(factId);
        if (!fact || fact.status !== "active" || fact.authority !== "official") {
          errors.push(`firmware available fact ${String(factId)} lacks active official authority`);
        }
      }
    }
    errors.push(...validateAssemblyObservationBindingsRuntime(
      value?.assemblySafetyEvaluations ?? [],
      context.observationClosure ?? { observations: [] },
      context.config,
      computedConfigHash ?? "",
    ).map((error) => `assembly observation closure: ${error}`));
    const assemblyInputs = context.assemblySafetyInputs;
    const assemblyEvaluations = Array.isArray(value?.assemblySafetyEvaluations) ? value.assemblySafetyEvaluations : [];
    if (assemblyInputs === undefined && assemblyEvaluations.length > 0) {
      errors.push("assembly safety input replay authority is unavailable");
    } else if (assemblyInputs !== undefined) {
      if (!Array.isArray(assemblyInputs)) errors.push("assemblySafetyInputs closure invalid");
      else {
        const replayed = [];
        for (const [index, assemblyInput] of assemblyInputs.entries()) {
          const inputErrors = validateAssemblySafetyInput(assemblyInput);
          if (inputErrors.length) errors.push(...inputErrors.map((error) => `assemblySafetyInputs.${index}: ${error}`));
          else replayed.push(evaluateAssemblySafetyRuntime(assemblyInput));
        }
        replayed.sort((left, right) => compare(left?.assemblyId ?? "", right?.assemblyId ?? ""));
        if (new Set(replayed.map((entry) => entry?.assemblyId)).size !== replayed.length
          || canonicalJson(replayed) !== canonicalJson(assemblyEvaluations)) {
          errors.push("assembly safety evaluations differ from locked resolver inputs");
        }
      }
    }

    const embeddedCapabilities = Array.isArray(value?.firmwareCapabilities) ? value.firmwareCapabilities : [];
    if (context.firmwareCapabilities === undefined && embeddedCapabilities.length > 0) {
      errors.push("locked firmware capability replay authority is unavailable");
    }
    const capabilities = Array.isArray(context.firmwareCapabilities) ? context.firmwareCapabilities : [];
    if (canonicalJson(capabilities) !== canonicalJson(embeddedCapabilities)) {
      errors.push("embedded firmware capabilities differ from locked closure context");
    }
    const capabilityByHash = new Map(capabilities.map((capability) => [capability?.contentHash, capability]));
    for (const [index, firmware] of (value?.firmwareEvaluations ?? []).entries()) {
      const capability = capabilityByHash.get(firmware?.capabilityRef?.contentHash);
      if (!capability) errors.push(`firmwareEvaluations.${index} locked capability missing`);
      else {
        errors.push(...validateFirmwarePathEvaluationRuntime(firmware, capability).map((error) => `firmwareEvaluations.${index}: ${error}`));
        const component = (context.config?.components ?? []).find((candidate) => candidate?.instanceId === firmware.instanceId);
        if (component?.identity?.status !== "resolved" || capability.subjectSkuId !== component.identity.skuId) {
          errors.push(`firmwareEvaluations.${index} capability subject differs from locked target identity`);
        }
        if (capability.factSnapshotRef?.snapshotId !== lock?.factSnapshotId
          || capability.factSnapshotRef?.contentHash !== lock?.snapshotHashes?.factSnapshotHash) {
          errors.push(`firmwareEvaluations.${index} capability fact snapshot binding mismatch`);
        }
        errors.push(...firmwareExecutableFactAuthorityErrorsRuntime(
          firmware,
          capability,
          Array.isArray(context.factClosure?.facts) ? context.factClosure.facts : [],
        ).map((error) => `firmwareEvaluations.${index} ${error}`));
      }
      if (firmware?.capabilityRef?.factSnapshotRef?.snapshotId !== lock?.factSnapshotId
        || firmware?.capabilityRef?.factSnapshotRef?.contentHash !== lock?.snapshotHashes?.factSnapshotHash) {
        errors.push(`firmwareEvaluations.${index} fact snapshot binding mismatch`);
      }
    }
    const firmwareFixedPointBaseInputs = [];
    const firmwarePathInputs = context.firmwarePathInputs;
    if (firmwarePathInputs === undefined && (value?.firmwareEvaluations?.length ?? 0) > 0) {
      errors.push("locked firmware path input replay authority is unavailable");
    } else if (firmwarePathInputs !== undefined) {
      if (!Array.isArray(firmwarePathInputs)
        || !arraySortedBy(firmwarePathInputs, (entry) => entry?.instanceId ?? "")
        || firmwarePathInputs.some((entry) => Array.isArray(entry?.availableRequirementIds)
          ? entry.availableRequirementIds.length > 0 : entry?.availableRequirementIds instanceof Set
            ? entry.availableRequirementIds.size > 0 : entry?.availableRequirementIds !== undefined)) {
        errors.push("firmwarePathInputs closure invalid or carries caller-authored availability");
      } else {
        const evaluationByInstance = new Map((value?.firmwareEvaluations ?? []).map((entry) => [entry.instanceId, entry]));
        const targetByInputInstance = new Map((context.config?.firmwareTargets ?? [])
          .map((target) => [target?.instanceId, target]));
        if (evaluationByInstance.size !== firmwarePathInputs.length
          || firmwarePathInputs.some((entry) => !evaluationByInstance.has(entry?.instanceId))) {
          errors.push("firmware path inputs/evaluations identity closure mismatch");
        }
        for (const [index, raw] of firmwarePathInputs.entries()) {
          const evaluation = evaluationByInstance.get(raw?.instanceId);
          if (!evaluation) continue;
          const normalizeValues = (candidate) => [...(candidate ?? [])].sort(compare);
          const lockedCapability = capabilityByHash.get(evaluation.capabilityRef.contentHash);
          const target = targetByInputInstance.get(raw?.instanceId);
          if (target === undefined) {
            errors.push(`firmwarePathInputs.${index} target is absent from locked config`);
            continue;
          }
          const targetComponent = (context.config?.components ?? []).find((component) => component?.instanceId === raw.instanceId);
          if (targetComponent?.identity?.status !== "resolved"
            || lockedCapability?.subjectSkuId !== targetComponent.identity.skuId
            || lockedCapability?.factSnapshotRef?.snapshotId !== lock?.factSnapshotId
            || lockedCapability?.factSnapshotRef?.contentHash !== lock?.snapshotHashes?.factSnapshotHash) {
            errors.push(`firmwarePathInputs.${index} capability differs from locked target identity/snapshot`);
          }
          const availableFactIds = derivedFirmwareAvailableFactIdsRuntime(context.factClosure, lockedCapability);
          if (raw.availableFactIds !== undefined
            && canonicalJson(normalizeValues(raw.availableFactIds)) !== canonicalJson(availableFactIds)) {
            errors.push(`firmwarePathInputs.${index} available facts differ from locked exact projection`);
          }
          const preflight = derivedFirmwarePreflightRuntime(raw.instanceId, value?.assemblySafetyEvaluations ?? []);
          for (const key of ["workingCpuAvailable", "workingMemoryAvailable", "displayPathAvailable"]) {
            if (raw.preflight?.[key] !== undefined && raw.preflight[key] !== preflight[key]) {
              errors.push(`firmwarePathInputs.${index} preflight differs from verified assembly supplies`);
            }
          }
          if ((raw.transitionTemporaryHardwareRequirements?.length ?? 0) > 0) {
            errors.push(`firmwarePathInputs.${index} carries caller-authored transition hardware requirements`);
          }
          const requestedSettings = derivedFirmwareRequestedSettingsRuntime(target, lockedCapability);
          const suppliedSettings = [...(raw.requestedSettings ?? [])].map((entry) => ({
            settingId: entry.settingId,
            desiredValue: entry.desiredValue,
          })).sort((left, right) => compare(left.settingId, right.settingId));
          if (raw.requestedSettings !== undefined
            && canonicalJson(suppliedSettings) !== canonicalJson((target.requestedSettings ?? []).map((entry) => ({
              settingId: entry.settingId,
              desiredValue: entry.desiredValue,
            })).sort((left, right) => compare(left.settingId, right.settingId)))) {
            errors.push(`firmwarePathInputs.${index} requested settings differ from locked config`);
          }
          const requireRecovery = lockedCapability?.rollbackSupported === true || lockedCapability?.recoveryMethod !== "none";
          if (raw.requireRecovery !== undefined && raw.requireRecovery !== requireRecovery) {
            errors.push(`firmwarePathInputs.${index} recovery policy differs from locked capability`);
          }
          const cpuBinding = firmwareCpuBindingRuntime(context.config, raw.instanceId);
          if (raw.cpuSkuId !== undefined && (raw.cpuSkuId ?? null) !== cpuBinding.skuId) {
            errors.push(`firmwarePathInputs.${index} CPU differs from locked topology`);
          }
          if (raw.targetReleaseFactId !== undefined && (raw.targetReleaseFactId ?? null) !== target.targetReleaseFactId) {
            errors.push(`firmwarePathInputs.${index} target release differs from locked config`);
          }
          const currentObservation = derivedFirmwareCurrentObservationRuntime(
            context.observationClosure,
            raw.instanceId,
            lockedCapability,
            context.config?.id,
            computedConfigHash,
            errors,
            `firmwarePathInputs.${index}`,
          );
          if (raw.currentObservation !== undefined
            && canonicalJson(raw.currentObservation ?? null) !== canonicalJson(currentObservation)) {
            errors.push(`firmwarePathInputs.${index} current observation differs from locked unique projection`);
          }
          const normalized = {
            capability: lockedCapability,
            instanceId: raw.instanceId,
            currentObservation,
            cpuSkuId: cpuBinding.skuId,
            targetReleaseFactId: target.targetReleaseFactId,
            availableRequirementIds: [],
            availableFactIds,
            preflight,
            transitionTemporaryHardwareRequirements: [],
            requestedSettings,
            requireRecovery,
          };
          if (canonicalJson(raw.capability) !== canonicalJson(lockedCapability)) {
            errors.push(`firmwarePathInputs.${index} capability differs from locked authority`);
            continue;
          }
          firmwareFixedPointBaseInputs.push(structuredClone(normalized));
          let replayed;
          try { replayed = evaluateFirmwarePathRuntime({
            ...normalized,
            availableRequirementIds: [...evaluation.searchAuthority.availableRequirementIds],
          }); }
          catch { replayed = null; }
          if (replayed === null || canonicalJson(replayed) !== canonicalJson(evaluation)) {
            errors.push(`firmwarePathInputs.${index} evaluation differs from locked raw input replay`);
          }
        }
      }
    }
    if ((value?.firmwareEvaluations?.length ?? 0) > 0) {
      if (!Array.isArray(context.firmwareFixedPointRootRequirements)) {
        errors.push("firmware fixed-point root requirement authority is unavailable");
      } else if (firmwareFixedPointBaseInputs.length === (value?.firmwareEvaluations?.length ?? 0)) {
        const finalRequirementById = new Map((value?.requirements ?? [])
          .map((requirement) => [requirement?.requirementId, requirement]));
        const candidateRequirementIds = new Set(firmwareFixedPointBaseInputs
          .flatMap((baseInput) => (projectFirmwareCandidateRequirementsRuntime(baseInput) ?? [])
            .map((requirement) => requirement?.requirementId)));
        for (const requirement of context.firmwareFixedPointRootRequirements) {
          const canonical = finalRequirementById.get(requirement?.requirementId);
          if (canonical === undefined || canonicalJson(canonical) !== canonicalJson(requirement)) {
            errors.push(`firmware fixed-point root ${String(requirement?.requirementId)} differs from final locked closure`);
          }
          if (candidateRequirementIds.has(requirement?.requirementId)) {
            errors.push(`firmware fixed-point root ${String(requirement?.requirementId)} overlaps a derived candidate`);
          }
        }
        errors.push(...validateFirmwareRequirementBatchFixedPointReplayRuntime({
          evaluations: value.firmwareEvaluations,
          requirementAllocation: value.requirementAllocation,
        }, {
          baseInputs: firmwareFixedPointBaseInputs,
          rootRequirements: context.firmwareFixedPointRootRequirements,
          supplies: value.requirementAllocation?.supplies ?? [],
          allocationOptions: {
            blockedRequirementIds: value.requirementClosure?.blockedRequirementIds ?? [],
            safetyCheckpoints: context.checkpointBindings ?? [],
          },
        }).map((error) => `firmware fixed-point replay: ${error}`));
      }
    }
    const targets = Array.isArray(context.config?.firmwareTargets) ? [...context.config.firmwareTargets].sort((left, right) => compare(left.instanceId, right.instanceId)) : [];
    const firmware = Array.isArray(value?.firmwareEvaluations) ? value.firmwareEvaluations : [];
    const targetByInstance = new Map(targets.map((target) => [target.instanceId, target]));
    if (firmware.some((entry) => !targetByInstance.has(entry.instanceId))) errors.push("firmware evaluation references a non-target instance");
    firmware.forEach((evaluation) => {
      const target = targetByInstance.get(evaluation.instanceId);
      if (!target) return;
      const cpuBinding = firmwareCpuBindingRuntime(context.config, target.instanceId);
      if (cpuBinding.ambiguous || evaluation.cpuSkuId !== cpuBinding.skuId) {
        errors.push(`firmware target ${target.instanceId} CPU binding mismatch`);
      }
      const evaluatedSettings = (evaluation?.searchAuthority?.requestedSettings ?? [])
        .map((setting) => ({ settingId: setting.settingId, desiredValue: setting.desiredValue }))
        .sort((left, right) => compare(left.settingId, right.settingId));
      const targetSettings = [...(target.requestedSettings ?? [])]
        .map((setting) => ({ settingId: setting.settingId, desiredValue: setting.desiredValue }))
        .sort((left, right) => compare(left.settingId, right.settingId));
      if (evaluation?.searchAuthority?.requestedTargetReleaseFactId !== target.targetReleaseFactId
        || canonicalJson(evaluatedSettings) !== canonicalJson(targetSettings)) {
        errors.push(`firmware target ${target.instanceId} replay binding mismatch`);
      }
    });
    const missingTargets = targets.filter((target) => !firmware.some((entry) => entry.instanceId === target.instanceId));
    if (missingTargets.length > 0) {
      const gate = value?.ruleEvaluations?.find((entry) => entry.ruleId === "compat.firmware-path" && entry.ruleVersion === "1.0.0");
      if (gate?.verdict !== "blocked" || gate?.requirementIds?.length === 0) {
        errors.push("missing firmware targets are not represented by the locked firmware gate");
      }
    }
    return errors;
  } catch {
    return ["progressive evaluation closure validation failed closed"];
  }
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort(compare);
}

/** Extract every durable edge required to replay this evaluation. */
export function progressiveEvaluationReferencesRuntime(value, firmwareCapabilities = undefined) {
  try {
    if (validateProgressiveBuildEvaluationRuntime(value).length) return null;
    const capabilities = Array.isArray(firmwareCapabilities) ? firmwareCapabilities : value.firmwareCapabilities;
    const firmwareByHash = new Map((Array.isArray(capabilities) ? capabilities : [])
      .map((capability) => [capability?.contentHash, capability]));
    const firmwareRefs = value.firmwareEvaluations.map((evaluation) => {
      const capability = firmwareByHash.get(evaluation.capabilityRef.contentHash);
      return capability === undefined ? null : firmwarePathReferencesRuntime(evaluation, capability);
    });
    if (value.firmwareEvaluations.length > 0 && firmwareRefs.some((entry) => entry === null)) return null;
    const assemblyRefs = value.assemblySafetyEvaluations.map(assemblySafetyReferencesRuntime);
    if (assemblyRefs.some((entry) => entry === null)) return null;
    const allocationRefs = requirementAllocationReferencesRuntime(value.requirementAllocation);
    if (allocationRefs === null) return null;
    return Object.freeze({
      factIds: Object.freeze(sortedUnique([
        ...value.decisions.flatMap((decision) => decision.factIds),
        ...firmwareRefs.flatMap((entry) => entry?.factIds ?? []),
        ...assemblyRefs.flatMap((entry) => entry?.factIds ?? []),
        ...value.thermalAcousticEvaluation.thermal.airflow.fanOperatingPoints.flatMap((point) => point.sourceRefs).filter((ref) => !ref.startsWith("observation:")),
        ...value.thermalAcousticEvaluation.thermal.components.flatMap((component) => component.sourceRefs).filter((ref) => !ref.startsWith("observation:")),
        ...value.thermalAcousticEvaluation.acoustic.contributions.flatMap((contribution) => contribution.sourceRefs).filter((ref) => !ref.startsWith("observation:")),
        ...value.thermalAcousticEvaluation.acoustic.coilWhineRisks.flatMap((risk) => risk.sourceRefs).filter((ref) => !ref.startsWith("observation:")),
      ])),
      instanceIds: Object.freeze(sortedUnique([
        ...value.topologyBom.map((line) => line.instanceId),
        ...value.decisions.flatMap((decision) => decision.instanceIds),
        ...value.requirements.flatMap((requirement) => requirement.producedBy.instanceIds),
        ...allocationRefs.ownerInstanceIds,
        ...assemblyRefs.flatMap((entry) => entry?.instanceIds ?? []),
      ])),
      conflictSetIds: Object.freeze(sortedUnique(value.ruleEvaluations.flatMap((evaluation) => evaluation.conflictSetIds))),
      requirementIds: Object.freeze(sortedUnique([
        ...value.requirements.map((requirement) => requirement.requirementId),
        ...firmwareRefs.flatMap((entry) => entry?.requirementIds ?? []),
        ...assemblyRefs.flatMap((entry) => entry?.requirementIds ?? []),
      ])),
      evidenceRefs: Object.freeze(sortedUnique([
        ...value.requirements.flatMap((requirement) => requirement.evidenceRefs),
        ...allocationRefs.evidenceRefs,
      ])),
      observationRefs: Object.freeze(sortedUnique([
        ...allocationRefs.observationRefs,
        ...assemblyRefs.flatMap((entry) => entry?.observationIds ?? []),
        ...firmwareRefs.flatMap((entry) => entry?.observationIds ?? []),
        ...value.thermalAcousticEvaluation.calibration.appliedThermalObservationIds,
        ...value.thermalAcousticEvaluation.calibration.appliedAcousticObservationIds,
      ])),
      checkpointIds: Object.freeze(sortedUnique(allocationRefs.checkpointIds)),
      checkpointRefs: Object.freeze(allocationRefs.checkpointRefs.map((entry) => Object.freeze(structuredClone(entry)))),
      packageSupplyRefs: Object.freeze(allocationRefs.packageSupplyRefs.map((entry) => Object.freeze(structuredClone(entry)))),
      manifestHashes: Object.freeze(sortedUnique(allocationRefs.manifestHashes ?? allocationRefs.packageSupplyRefs.map((entry) => entry.manifestHash))),
      authorityRefs: Object.freeze(sortedUnique([
        value.authority.ruleSet.ref,
        value.authority.engine.ref,
        value.authority.adapterSnapshot.ref,
        value.priceProjection.priceSnapshotRef,
        `evaluation-lock:${value.authority.evaluationLockHash}`,
        `artifact-lockfile:${value.authority.artifactLockfileHash}`,
      ])),
      authorityHashes: Object.freeze(sortedUnique([
        value.authority.evaluationLockHash,
        value.authority.artifactLockfileHash,
        value.authority.configHash,
        ...Object.values(value.authority.snapshotHashes),
        value.authority.ruleSet.contentHash,
        value.authority.engine.contentHash,
        value.authority.adapterSnapshot.contentHash,
        value.priceProjection.priceSnapshotHash,
        value.requirementClosure.contentHash,
        value.requirementAllocation.contentHash,
        value.requirementReadiness.contentHash,
      ])),
      firmwareCapabilityHashes: Object.freeze(sortedUnique(firmwareRefs.flatMap((entry) => entry === null ? [] : [entry.capabilityHash]))),
      firmwareFactSnapshotRefs: Object.freeze(sortedUnique(firmwareRefs.flatMap((entry) => entry === null ? [] : [
        `${entry.factSnapshotRef.snapshotId}@sha256:${entry.factSnapshotRef.contentHash}`,
      ]))),
    });
  } catch { return null; }
}
