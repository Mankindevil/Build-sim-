import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import {
  validateRequirementAllocationResultRuntime,
  validateRequirementNodeRuntime,
} from "../requirements/runtime.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const METHODS = new Set(["uefi", "usb_flashback", "bmc", "os_tool"]);
const PURPOSES = new Set(["upgrade", "rollback", "recovery"]);
const IDENTIFICATION_METHODS = new Set(["uefi_screen", "bmc_inventory", "os_probe", "label_observation"]);
const MEDIA_FORMATS = new Set(["fat32", "vendor_tool", "os_managed"]);
const FIRMWARE_SETTINGS = Object.freeze({
  iommu: new Set(["enabled", "disabled"]),
  virtualization: new Set(["enabled", "disabled"]),
  secure_boot: new Set(["enabled", "disabled"]),
  tpm: new Set(["enabled", "disabled"]),
  csm: new Set(["enabled", "disabled"]),
  storage_controller_mode: new Set(["ahci", "raid", "hba_it"]),
  memory_profile: new Set(["jedec", "xmp", "expo"]),
  resizable_bar: new Set(["enabled", "disabled"]),
  above_4g_decoding: new Set(["enabled", "disabled"]),
  ecc: new Set(["enabled", "disabled", "auto"]),
});

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value) && unicodeScalar(value);
}
function unicodeScalar(value) {
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
function nfcText(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value) && unicodeScalar(value);
}
function id(value) { return nfcText(value) && value.length <= 256 && !/\s/u.test(value); }
function strings(value, allowEmpty = true) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(text) && new Set(value).size === value.length;
}
function ordered(value, key = (candidate) => candidate) {
  if (!Array.isArray(value)) return false;
  const keys = value.map(key);
  return keys.every((candidate, index) => index === 0 || keys[index - 1] < candidate);
}
function sortedStrings(value, allowEmpty = true) { return strings(value, allowEmpty) && ordered(value); }
function portableIds(value, requireNonEmpty = true) {
  return Array.isArray(value) && (!requireNonEmpty || value.length > 0)
    && value.every(id) && new Set(value).size === value.length;
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value, root = true, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite firmware evaluation number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) throw new TypeError("non-canonical firmware evaluation value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse firmware evaluation array");
      return `[${value.map((entry) => canonical(entry, false, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("firmware evaluation object must be plain");
    return `{${Object.entries(value).filter(([key, child]) => child !== undefined && !(root && key === "contentHash"))
      .map(([key, child]) => [key.normalize("NFC"), child]).sort(([left], [right]) => compare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, false, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function contentHash(value) {
  const body = canonical(value);
  return sha256Utf8Runtime(`buildsim\0hash-spec-v1\0firmware-path-evaluation\0firmware-path-evaluation-v1\0${body}`);
}
export function firmwarePathEvaluationContentHashRuntime(value) {
  try { return contentHash(value); }
  catch { return null; }
}
export function firmwareCapabilityContentHashRuntime(value) {
  try {
    const body = canonical(value);
    return sha256Utf8Runtime(`buildsim\u0000hash-spec-v1\u0000artifact.adapter-snapshot\u00001.0.0\u0000${body}`);
  } catch { return null; }
}
function normalizeStrings(value) { return [...new Set(value.map((item) => item.normalize("NFC")))].sort(compare); }
function shortHash(value) { return sha256Utf8Runtime(value)?.slice(0, 16) ?? "unhashable"; }

/** Instantiate capability-local prerequisite template IDs for one board. */
export function firmwareRequirementIdRuntime(instanceId, sourceRequirementId) {
  try {
    if (!id(instanceId) || !id(sourceRequirementId)) return null;
    const digest = sha256Utf8Runtime(`firmware-requirement\0${sourceRequirementId.normalize("NFC")}`);
    return digest === null ? null : `requirement.firmware.${instanceId}.transition.sha256-${digest}`;
  } catch { return null; }
}

function firmwareSourceRequirementIds(input) {
  return new Set([
    ...input.capability.transitions.flatMap((transition) => transition.requirementIds),
    ...input.transitionTemporaryHardwareRequirements.flatMap((entry) => entry.requirementIds),
  ]);
}

function scopedFirmwareRequirementId(input, requirementId, sourceIds = firmwareSourceRequirementIds(input)) {
  if (!sourceIds.has(requirementId)) return requirementId;
  const scoped = firmwareRequirementIdRuntime(input.instanceId, requirementId);
  if (scoped === null) throw new TypeError(`firmware requirement cannot be instance-scoped: ${requirementId}`);
  return scoped;
}

function factSnapshotRef(value) {
  return exact(value, ["snapshotId", "contentHash"])
    && HASH.test(String(value.contentHash ?? ""))
    && value.snapshotId === `fact-snapshot-sha256-${value.contentHash}`;
}

function firmwareRelease(value) {
  return exact(value, ["releaseFactId", "label", "sourceFactIds"])
    && id(value.releaseFactId) && nfcText(value.label) && portableIds(value.sourceFactIds)
    && ordered(value.sourceFactIds);
}

function firmwareCpuSupport(value) {
  return exact(value, ["cpuSkuId", "minimumReleaseFactId", "sourceFactIds"])
    && id(value.cpuSkuId) && id(value.minimumReleaseFactId) && portableIds(value.sourceFactIds)
    && ordered(value.sourceFactIds);
}

function firmwareTransition(value) {
  const fields = [
    "transitionId", "fromReleaseFactId", "toReleaseFactId", "purpose", "method", "requiresWorkingCpu", "requirementIds",
    "firmwareFileFactId", "mediaFormat", "requiredFilename", "checksumFactId", "powerPrerequisiteFactIds",
    "recoveryTransitionIds", "resetsSettings", "releaseFactIds", "sourceFactIds",
  ];
  return exact(value, fields)
    && [value.transitionId, value.fromReleaseFactId, value.toReleaseFactId, value.firmwareFileFactId, value.checksumFactId].every(id)
    && value.fromReleaseFactId !== value.toReleaseFactId
    && PURPOSES.has(value.purpose) && METHODS.has(value.method)
    && typeof value.requiresWorkingCpu === "boolean" && typeof value.resetsSettings === "boolean"
    && portableIds(value.requirementIds, false) && ordered(value.requirementIds)
    && portableIds(value.powerPrerequisiteFactIds) && ordered(value.powerPrerequisiteFactIds)
    && portableIds(value.recoveryTransitionIds, false) && ordered(value.recoveryTransitionIds)
    && portableIds(value.releaseFactIds) && ordered(value.releaseFactIds)
    && portableIds(value.sourceFactIds) && ordered(value.sourceFactIds)
    && value.releaseFactIds.length === 2 && value.releaseFactIds.includes(value.fromReleaseFactId)
    && value.releaseFactIds.includes(value.toReleaseFactId) && MEDIA_FORMATS.has(value.mediaFormat)
    && nfcText(value.requiredFilename)
    && !(value.method === "usb_flashback" && value.requiresWorkingCpu !== false)
    && !(value.requiresWorkingCpu === true && value.requirementIds.length === 0);
}

function firmwareSetting(value) {
  return exact(value, ["settingId", "supportedValues", "sourceFactIds"])
    && Object.prototype.hasOwnProperty.call(FIRMWARE_SETTINGS, value.settingId)
    && portableIds(value.supportedValues) && ordered(value.supportedValues)
    && value.supportedValues.every((candidate) => FIRMWARE_SETTINGS[value.settingId].has(candidate))
    && value.supportedValues.length <= FIRMWARE_SETTINGS[value.settingId].size
    && portableIds(value.sourceFactIds) && ordered(value.sourceFactIds);
}

function validateFirmwareCapabilityUnsafe(value) {
  const fields = [
    "schemaVersion", "subjectSkuId", "subjectRevision", "region", "factSnapshotRef", "versionIdentification",
    "releases", "cpuSupport", "transitions", "settings", "rollbackSupported", "recoveryMethod", "sourceFactIds", "contentHash",
  ];
  if (!exact(value, fields)) return ["firmware capability contains unknown or missing fields"];
  const errors = [];
  if (value.schemaVersion !== "firmware-capability-v1") errors.push("firmware capability schemaVersion invalid");
  if (![value.subjectSkuId, value.subjectRevision, value.region].every(id)) errors.push("firmware capability subject scope invalid");
  if (!factSnapshotRef(value.factSnapshotRef)) errors.push("firmware capability factSnapshotRef invalid");
  if (!exact(value.versionIdentification, ["method", "sourceFactIds"])
    || !IDENTIFICATION_METHODS.has(value.versionIdentification?.method)
    || !portableIds(value.versionIdentification?.sourceFactIds)
    || !ordered(value.versionIdentification?.sourceFactIds)) errors.push("firmware versionIdentification invalid");
  if (!Array.isArray(value.releases) || value.releases.length === 0 || value.releases.some((entry) => !firmwareRelease(entry))) {
    errors.push("firmware releases invalid");
  } else if (!ordered(value.releases, (entry) => entry.releaseFactId)) errors.push("firmware releases order invalid");
  if (!Array.isArray(value.cpuSupport) || value.cpuSupport.length === 0 || value.cpuSupport.some((entry) => !firmwareCpuSupport(entry))) {
    errors.push("firmware cpuSupport invalid");
  } else if (!ordered(value.cpuSupport, (entry) => entry.cpuSkuId)) errors.push("firmware cpuSupport order invalid");
  if (!Array.isArray(value.transitions) || value.transitions.some((entry) => !firmwareTransition(entry))) errors.push("firmware transitions invalid");
  else if (!ordered(value.transitions, (entry) => entry.transitionId)) errors.push("firmware transitions order invalid");
  if (!Array.isArray(value.settings) || value.settings.some((entry) => !firmwareSetting(entry))) errors.push("firmware settings invalid");
  else if (!ordered(value.settings, (entry) => entry.settingId)) errors.push("firmware settings order invalid");
  if (typeof value.rollbackSupported !== "boolean" || (value.recoveryMethod !== "none" && !METHODS.has(value.recoveryMethod))) {
    errors.push("firmware rollback/recovery flags invalid");
  }
  if (!portableIds(value.sourceFactIds) || !ordered(value.sourceFactIds)) errors.push("firmware capability sourceFactIds invalid");
  if (!HASH.test(String(value.contentHash ?? ""))) errors.push("firmware capability contentHash invalid");

  const releases = Array.isArray(value.releases) ? value.releases.filter(record) : [];
  const releaseIds = releases.map((entry) => entry.releaseFactId).filter((entry) => typeof entry === "string");
  if (new Set(releaseIds).size !== releaseIds.length) errors.push("firmware release IDs must be unique");
  const support = Array.isArray(value.cpuSupport) ? value.cpuSupport.filter(record) : [];
  const cpuIds = support.map((entry) => entry.cpuSkuId).filter((entry) => typeof entry === "string");
  if (new Set(cpuIds).size !== cpuIds.length) errors.push("firmware CPU support entries must be unique");
  if (support.some((entry) => typeof entry.minimumReleaseFactId !== "string" || !releaseIds.includes(entry.minimumReleaseFactId))) {
    errors.push("firmware CPU support release reference missing");
  }
  const transitions = Array.isArray(value.transitions) ? value.transitions.filter(record) : [];
  const transitionIds = transitions.map((entry) => entry.transitionId).filter((entry) => typeof entry === "string");
  if (new Set(transitionIds).size !== transitionIds.length) errors.push("firmware transition IDs must be unique");
  for (const transition of transitions) {
    if (typeof transition.fromReleaseFactId !== "string" || !releaseIds.includes(transition.fromReleaseFactId)
      || typeof transition.toReleaseFactId !== "string" || !releaseIds.includes(transition.toReleaseFactId)) {
      errors.push("firmware transition release reference missing");
    }
    if (Array.isArray(transition.recoveryTransitionIds)) {
      for (const recoveryId of transition.recoveryTransitionIds) {
        const recovery = transitions.find((candidate) => candidate.transitionId === recoveryId);
        if (!recovery) errors.push("firmware transition recovery reference missing");
        else if ((recovery.purpose !== "rollback" && recovery.purpose !== "recovery")
          || recovery.fromReleaseFactId !== transition.toReleaseFactId || recovery.toReleaseFactId !== transition.fromReleaseFactId) {
          errors.push("firmware recovery transition must reverse its protected edge");
        }
      }
    }
  }
  const settingIds = Array.isArray(value.settings)
    ? value.settings.map((entry) => record(entry) ? entry.settingId : undefined).filter((entry) => typeof entry === "string") : [];
  if (new Set(settingIds).size !== settingIds.length) errors.push("firmware setting IDs must be unique");
  if (value.rollbackSupported === true && transitions.every((transition) => transition.purpose !== "rollback")) {
    errors.push("firmware rollbackSupported requires an explicit rollback transition");
  }
  if (value.recoveryMethod !== "none"
    && transitions.every((transition) => transition.method !== value.recoveryMethod || transition.purpose === "upgrade")) {
    errors.push("firmware recoveryMethod has no executable transition");
  }
  if (transitions.some((transition) => transition.purpose === "upgrade" && transition.recoveryTransitionIds?.length > 0)
    && value.rollbackSupported !== true && value.recoveryMethod === "none") {
    errors.push("firmware transition recovery references require an enabled recovery policy");
  }
  const expectedHash = firmwareCapabilityContentHashRuntime(value);
  if (expectedHash === null || value.contentHash !== expectedHash) errors.push("firmware capability content hash mismatch");
  return errors;
}

/** Strict, total, browser/Node-neutral FirmwareCapability authority validation. */
export function validateFirmwareCapabilityRuntime(value) {
  try { return validateFirmwareCapabilityUnsafe(value); }
  catch { return ["firmware capability is inaccessible or invalid"]; }
}

export function verifyFirmwareCapabilityRuntime(value) {
  return validateFirmwareCapabilityRuntime(value).length === 0;
}

function observation(value) {
  return exact(value, ["observationId", "releaseFactId", "method", "evidenceRefs"])
    && id(value.observationId) && id(value.releaseFactId) && IDENTIFICATION_METHODS.has(value.method)
    && sortedStrings(value.evidenceRefs, false);
}

function requestedSetting(value) {
  return exact(value, ["settingId", "desiredValue", "evidenceRefs"])
    && id(value.settingId) && id(value.desiredValue) && sortedStrings(value.evidenceRefs, false);
}

function temporaryRequirements(value) {
  return exact(value, ["transitionId", "requirementIds"])
    && id(value.transitionId) && sortedStrings(value.requirementIds);
}

function preflight(value) {
  return exact(value, ["workingCpuAvailable", "workingMemoryAvailable", "displayPathAvailable"])
    && [value.workingCpuAvailable, value.workingMemoryAvailable, value.displayPathAvailable]
      .every((candidate) => candidate === null || typeof candidate === "boolean");
}

function validateInput(value) {
  const fields = [
    "capability", "instanceId", "currentObservation", "cpuSkuId", "targetReleaseFactId", "availableRequirementIds",
    "availableFactIds", "preflight", "transitionTemporaryHardwareRequirements", "requestedSettings", "requireRecovery",
  ];
  if (!exact(value, fields)) return ["firmware path input shape invalid"];
  const errors = [];
  errors.push(...validateFirmwareCapabilityRuntime(value.capability).map((error) => `firmware capability authority invalid: ${error}`));
  if (!id(value.instanceId) || (value.cpuSkuId !== null && !id(value.cpuSkuId)) || (value.targetReleaseFactId !== null && !id(value.targetReleaseFactId))) errors.push("firmware path input identity invalid");
  if (value.currentObservation !== null && !observation(value.currentObservation)) errors.push("firmware current observation invalid");
  if (!strings(value.availableRequirementIds) || !strings(value.availableFactIds) || !preflight(value.preflight)) errors.push("firmware path available authority invalid");
  if (!Array.isArray(value.transitionTemporaryHardwareRequirements) || value.transitionTemporaryHardwareRequirements.some((candidate) => !temporaryRequirements(candidate))) {
    errors.push("firmware temporary hardware requirements invalid");
  } else {
    const transitionIds = value.transitionTemporaryHardwareRequirements.map((candidate) => candidate.transitionId);
    if (new Set(transitionIds).size !== transitionIds.length) errors.push("firmware temporary hardware transition IDs must be unique");
    const knownTransitions = new Set(Array.isArray(value.capability?.transitions)
      ? value.capability.transitions.map((transition) => transition.transitionId) : []);
    if (transitionIds.some((transitionId) => !knownTransitions.has(transitionId))) errors.push("firmware temporary hardware transition reference missing");
  }
  if (!Array.isArray(value.requestedSettings) || value.requestedSettings.some((candidate) => !requestedSetting(candidate))) {
    errors.push("firmware requested settings invalid");
  } else {
    const settingIds = value.requestedSettings.map((candidate) => candidate.settingId);
    if (new Set(settingIds).size !== settingIds.length) errors.push("firmware requested setting IDs must be unique");
    const settings = new Map(Array.isArray(value.capability?.settings)
      ? value.capability.settings.map((setting) => [setting.settingId, setting.supportedValues]) : []);
    if (value.requestedSettings.some((setting) => !settings.get(setting.settingId)?.includes(setting.desiredValue))) {
      errors.push("firmware requested setting is unsupported by locked capability");
    }
  }
  if (typeof value.requireRecovery !== "boolean") errors.push("firmware requireRecovery invalid");
  return errors;
}

function requirement(input, requirementId, kind, predicates, criticality, requiredBefore, producedByRule, evidenceRefs) {
  return {
    requirementId,
    kind,
    predicates,
    quantity: 1,
    criticality,
    ...(requiredBefore === undefined ? {} : { requiredBefore }),
    producedBy: { ruleId: producedByRule, ruleVersion: "1.0.0", instanceIds: [input.instanceId] },
    evidenceRefs: normalizeStrings(evidenceRefs),
  };
}

function genericTransitionRequirement(input, requirementId, sourceRequirementId, sourceFactIds) {
  return requirement(input, requirementId, "firmware_action", [
    { facetId: "firmware.upgrade_path_refs", operator: "includes", value: sourceRequirementId },
  ], "boot", "first_boot", "firmware.transition-prerequisite", sourceFactIds);
}

function settingsRequirement(input) {
  const settings = [...input.requestedSettings]
    .sort((left, right) => compare(left.settingId, right.settingId));
  return requirement(
    input,
    `requirement.firmware.${input.instanceId}.restore-settings`,
    "firmware_action",
    settings.map((setting) => ({
      facetId: "firmware.upgrade_path_refs",
      operator: "includes",
      value: `setting:${setting.settingId}=${setting.desiredValue}`,
    })),
    "boot",
    "first_boot",
    "firmware.restore-settings",
    settings.flatMap((setting) => setting.evidenceRefs),
  );
}

function preflightRequirements(input, transition) {
  if (!transition.requiresWorkingCpu) return [];
  const values = [
    ["workingCpuAvailable", "temporary-cpu", "cpu"],
    ["workingMemoryAvailable", "temporary-memory", "memory_module"],
    ["displayPathAvailable", "display-path", "gpu"],
  ];
  return values.map(([field, suffix, category]) => ({
    field,
    requirement: requirement(
      input,
      `requirement.firmware.${input.instanceId}.${suffix}`,
      "component",
      [{ facetId: "identity.category", operator: "eq", value: category }],
      "boot",
      "first_boot",
      "firmware.working-platform-prerequisite",
      transition.sourceFactIds,
    ),
  }));
}

function transitionDetailMap(input) {
  return new Map(input.transitionTemporaryHardwareRequirements.map((entry) => [entry.transitionId, entry.requirementIds]));
}

function evaluateTransition(input, transition, availableRequirements, availableFacts, detailMap) {
  const tempIds = detailMap.get(transition.transitionId) ?? [];
  const preflightEntries = preflightRequirements(input, transition);
  const preflightNodes = preflightEntries.map((entry) => entry.requirement);
  const sourceIds = firmwareSourceRequirementIds(input);
  const sourceRequirementIds = normalizeStrings([...transition.requirementIds, ...tempIds]);
  const scopedBySource = new Map(sourceRequirementIds.map((sourceRequirementId) => [
    sourceRequirementId,
    scopedFirmwareRequirementId(input, sourceRequirementId, sourceIds),
  ]));
  const requirementIds = normalizeStrings([...scopedBySource.values(), ...preflightNodes.map((node) => node.requirementId)]);
  const missingRequirementIds = normalizeStrings([
    ...[...scopedBySource.values()].filter((requirementId) => !availableRequirements.has(requirementId)),
    ...preflightEntries.filter(({ field, requirement: node }) => (
      input.preflight[field] !== true || !availableRequirements.has(node.requirementId)
    )).map(({ requirement: node }) => node.requirementId),
  ]);
  const missingPowerPrerequisiteFactIds = normalizeStrings(transition.powerPrerequisiteFactIds.filter((factId) => !availableFacts.has(factId)));
  return {
    transitionId: transition.transitionId,
    fromReleaseFactId: transition.fromReleaseFactId,
    toReleaseFactId: transition.toReleaseFactId,
    purpose: transition.purpose,
    method: transition.method,
    requiresWorkingCpu: transition.requiresWorkingCpu,
    requirementIds,
    temporaryHardwareRequirementIds: normalizeStrings([
      ...tempIds.map((requirementId) => scopedFirmwareRequirementId(input, requirementId, sourceIds)),
      ...preflightNodes.map((node) => node.requirementId),
    ]),
    missingRequirementIds,
    firmwareFileFactId: transition.firmwareFileFactId,
    mediaFormat: transition.mediaFormat,
    requiredFilename: transition.requiredFilename,
    checksumFactId: transition.checksumFactId,
    powerPrerequisiteFactIds: normalizeStrings(transition.powerPrerequisiteFactIds),
    missingPowerPrerequisiteFactIds,
    recoveryTransitionIds: normalizeStrings(transition.recoveryTransitionIds),
    resetsSettings: transition.resetsSettings,
    releaseFactIds: normalizeStrings(transition.releaseFactIds),
    sourceFactIds: normalizeStrings(transition.sourceFactIds),
    preflightRequirements: preflightNodes,
    sourceRequirements: [...scopedBySource].map(([sourceRequirementId, requirementId]) => ({ sourceRequirementId, requirementId })),
  };
}

function addTransitionRequirementNodes(input, derived, detail) {
  const preflightById = new Map(detail.preflightRequirements.map((node) => [node.requirementId, node]));
  for (const node of detail.preflightRequirements) addDerivedWithEvidenceMerge(derived, node);
  for (const { sourceRequirementId, requirementId } of detail.sourceRequirements) {
    if (!preflightById.has(requirementId)) addDerivedWithEvidenceMerge(
      derived,
      genericTransitionRequirement(input, requirementId, sourceRequirementId, detail.sourceFactIds),
    );
  }
}

function enumeratePaths(capability, from, to, allowRollback = true) {
  if (from === to) return { paths: [[]], truncated: false };
  const transitions = capability.transitions.filter((transition) => transition.purpose === "upgrade"
      || (allowRollback && capability.rollbackSupported && transition.purpose === "rollback"))
    .sort((left, right) => compare(left.transitionId, right.transitionId));
  const outgoing = new Map();
  for (const transition of transitions) outgoing.set(transition.fromReleaseFactId, [...(outgoing.get(transition.fromReleaseFactId) ?? []), transition]);
  const paths = []; let truncated = false; let examinedEdges = 0;
  const visit = (release, path, visited) => {
    if (paths.length >= 4_096) { truncated = true; return; }
    for (const transition of outgoing.get(release) ?? []) {
      examinedEdges += 1;
      if (examinedEdges > 4_096) { truncated = true; return; }
      if (visited.has(transition.toReleaseFactId)) continue;
      const nextPath = [...path, transition];
      if (transition.toReleaseFactId === to) {
        if (paths.length >= 4_096) { truncated = true; return; }
        paths.push(nextPath);
        continue;
      }
      const nextVisited = new Set(visited); nextVisited.add(transition.toReleaseFactId);
      visit(transition.toReleaseFactId, nextPath, nextVisited);
      if (truncated) return;
    }
  };
  visit(from, [], new Set([from]));
  return { paths, truncated };
}

function compareScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    return typeof left[index] === "number" && typeof right[index] === "number"
      ? left[index] - right[index] : compare(String(left[index]), String(right[index]));
  }
  return 0;
}

/**
 * Evaluate the whole executable route before ranking it. Recovery and settings
 * restore are path properties, so they must participate in selection rather
 * than being checked only after a shortest upgrade path has won.
 */
function analyzeCandidatePath(input, details, availableRequirements, availableFacts, detailMap) {
  const missingRequirementIds = new Set(details.flatMap((detail) => detail.missingRequirementIds));
  const missingPowerPrerequisiteFactIds = new Set(details.flatMap((detail) => detail.missingPowerPrerequisiteFactIds));
  let settingsReset = details.some((detail) => detail.resetsSettings);
  const settingsRequirementId = `requirement.firmware.${input.instanceId}.restore-settings`;

  const recoveryDetails = [];
  let recoveryUnavailable = false;
  if (input.requireRecovery) {
    // Recovery executes from the final flashed release back toward the
    // observed start, so inverse edges must be selected in reverse order.
    for (const detail of [...details].reverse()) {
      const alternatives = detail.recoveryTransitionIds.flatMap((recoveryId) => {
        const transition = input.capability.transitions.find((candidate) => candidate.transitionId === recoveryId);
        return transition === undefined ? [] : [evaluateTransition(input, transition, availableRequirements, availableFacts, detailMap)];
      });
      if (alternatives.length === 0) {
        recoveryUnavailable = true;
        continue;
      }
      alternatives.sort((left, right) => compareScore([
        left.missingRequirementIds.length + left.missingPowerPrerequisiteFactIds.length === 0 ? 0 : 1,
        left.missingRequirementIds.length + left.missingPowerPrerequisiteFactIds.length,
        left.transitionId,
      ], [
        right.missingRequirementIds.length + right.missingPowerPrerequisiteFactIds.length === 0 ? 0 : 1,
        right.missingRequirementIds.length + right.missingPowerPrerequisiteFactIds.length,
        right.transitionId,
      ]));
      recoveryDetails.push(alternatives[0]);
    }
    for (const detail of recoveryDetails) {
      detail.missingRequirementIds.forEach((requirementId) => missingRequirementIds.add(requirementId));
      detail.missingPowerPrerequisiteFactIds.forEach((factId) => missingPowerPrerequisiteFactIds.add(factId));
    }
    settingsReset = settingsReset || recoveryDetails.some((detail) => detail.resetsSettings);
  }
  if (input.requestedSettings.length > 0 && !availableRequirements.has(settingsRequirementId)) {
    missingRequirementIds.add(settingsRequirementId);
  }
  return {
    details,
    settingsReset,
    settingsRequirementId,
    recoveryDetails,
    recoveryUnavailable,
    missingRequirementIds,
    missingPowerPrerequisiteFactIds,
  };
}

function scorePath(analysis) {
  const missingCount = analysis.missingRequirementIds.size + analysis.missingPowerPrerequisiteFactIds.size;
  const blocked = analysis.recoveryUnavailable || missingCount > 0;
  return [
    blocked ? 1 : 0,
    missingCount + (analysis.recoveryUnavailable ? 1 : 0),
    analysis.details.length,
    analysis.details.map((detail) => detail.transitionId).join("\0"),
  ];
}

function directedReachable(capability, from, to, allowRollback = true) {
  if (from === to) return true;
  const outgoing = new Map();
  for (const transition of capability.transitions.filter((candidate) => candidate.purpose === "upgrade"
    || (allowRollback && capability.rollbackSupported && candidate.purpose === "rollback"))
    .sort((left, right) => compare(left.transitionId, right.transitionId))) {
    outgoing.set(transition.fromReleaseFactId, [...(outgoing.get(transition.fromReleaseFactId) ?? []), transition]);
  }
  const queue = [from]; const visited = new Set(queue); let examinedEdges = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const transition of outgoing.get(queue[cursor]) ?? []) {
      examinedEdges += 1;
      if (examinedEdges > 4_096) throw new Error("firmware directed-path search exceeded the complete-search limit");
      if (transition.toReleaseFactId === to) return true;
      if (!visited.has(transition.toReleaseFactId)) {
        visited.add(transition.toReleaseFactId); queue.push(transition.toReleaseFactId);
      }
    }
  }
  return false;
}

function addDerived(byId, node) {
  const errors = validateRequirementNodeRuntime(node);
  if (errors.length) throw new TypeError(`generated firmware requirement invalid: ${errors.join("; ")}`);
  const existing = byId.get(node.requirementId);
  if (existing !== undefined && canonical(existing, false) !== canonical(node, false)) throw new Error(`conflicting firmware requirement ${node.requirementId}`);
  byId.set(node.requirementId, node);
}

function addDerivedWithEvidenceMerge(byId, node) {
  const existing = byId.get(node.requirementId);
  if (existing === undefined) { addDerived(byId, node); return; }
  if (canonical({ ...existing, evidenceRefs: [] }, false) !== canonical({ ...node, evidenceRefs: [] }, false)) {
    throw new Error(`conflicting firmware requirement ${node.requirementId}`);
  }
  const merged = { ...existing, evidenceRefs: normalizeStrings([...existing.evidenceRefs, ...node.evidenceRefs]) };
  const errors = validateRequirementNodeRuntime(merged);
  if (errors.length) throw new TypeError(`generated firmware requirement invalid: ${errors.join("; ")}`);
  byId.set(merged.requirementId, merged);
}

function capabilityRef(capability) {
  return {
    subjectSkuId: capability.subjectSkuId,
    subjectRevision: capability.subjectRevision,
    region: capability.region,
    contentHash: capability.contentHash,
    factSnapshotRef: structuredClone(capability.factSnapshotRef),
  };
}

function baseMaterial(input, targetReleaseFactId, minimumReleaseFactId, searchAuthority) {
  return {
    schemaVersion: "firmware-path-evaluation-v1",
    instanceId: input.instanceId,
    capabilityRef: capabilityRef(input.capability),
    currentObservation: input.currentObservation === null ? null : {
      ...structuredClone(input.currentObservation),
      evidenceRefs: normalizeStrings(input.currentObservation.evidenceRefs),
    },
    cpuSkuId: input.cpuSkuId,
    minimumReleaseFactId,
    targetReleaseFactId,
    searchAuthority,
  };
}

function finish(input, common, result) {
  const material = { ...common, ...result };
  const hash = contentHash(material);
  if (hash === null) throw new TypeError("firmware evaluation content hash could not be computed");
  return { ...material, contentHash: hash };
}

function buildEvaluation(input) {
  const capability = input.capability;
  const sourceRequirementIds = firmwareSourceRequirementIds(input);
  const normalizedAvailableRequirementIds = normalizeStrings(input.availableRequirementIds.map((requirementId) => (
    scopedFirmwareRequirementId(input, requirementId, sourceRequirementIds)
  )));
  const availableRequirements = new Set(normalizedAvailableRequirementIds);
  const availableFacts = new Set(input.availableFactIds);
  const detailMap = transitionDetailMap(input);
  const searchAuthority = {
    requestedTargetReleaseFactId: input.targetReleaseFactId,
    availableRequirementIds: normalizedAvailableRequirementIds,
    availableFactIds: normalizeStrings(input.availableFactIds),
    preflight: structuredClone(input.preflight),
    transitionTemporaryHardwareRequirements: input.transitionTemporaryHardwareRequirements.map((entry) => ({
      transitionId: entry.transitionId, requirementIds: normalizeStrings(entry.requirementIds),
    })).sort((left, right) => compare(left.transitionId, right.transitionId)),
    requestedSettings: input.requestedSettings.map((setting) => ({
      settingId: setting.settingId, desiredValue: setting.desiredValue, evidenceRefs: normalizeStrings(setting.evidenceRefs),
    })).sort((left, right) => compare(left.settingId, right.settingId)),
    requireRecovery: input.requireRecovery,
  };
  const support = input.cpuSkuId === null ? null : capability.cpuSupport.find((entry) => entry.cpuSkuId === input.cpuSkuId) ?? null;
  const minimum = support?.minimumReleaseFactId ?? null;
  let target = input.targetReleaseFactId ?? minimum;
  const common = baseMaterial(input, target, minimum, searchAuthority);
  const empty = {
    selectedTransitions: [], bridgeReleaseFactIds: [], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [],
    derivedRequirements: [], settingsReset: false,
    recovery: { status: input.requireRecovery ? "unavailable" : "not_required", transitionIds: [], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [] },
    pathAlternativesExamined: 0, searchTruncated: false, assumptions: [],
  };
  const block = (reason, requirements = [], assumptions = []) => {
    const byId = new Map(); requirements.forEach((node) => addDerived(byId, node));
    return finish(input, common, { ...empty, verdict: "blocked", reason, derivedRequirements: [...byId.values()].sort((left, right) => compare(left.requirementId, right.requirementId)), assumptions });
  };

  if (input.cpuSkuId !== null && support === null) return block("cpu_support_unknown", [requirement(
    input, `requirement.firmware.${input.instanceId}.cpu-support-evidence`, "evidence", [], "boot", "first_boot",
    "firmware.cpu-support", capability.sourceFactIds,
  )]);
  const releases = new Set(capability.releases.map((release) => release.releaseFactId));
  if (target === null || !releases.has(target)) return block("target_release_unknown", [requirement(
    input, `requirement.firmware.${input.instanceId}.target-release`, "user_decision", [], "boot", "first_boot",
    "firmware.target-release", capability.sourceFactIds,
  )]);
  if (minimum !== null && target !== minimum && !directedReachable(capability, minimum, target, false)) return block("target_does_not_support_cpu");
  if (input.currentObservation === null) return block("current_release_observation_missing", [requirement(
    input, `requirement.firmware.${input.instanceId}.current-release-observation`, "measurement", [], "boot", "first_boot",
    "firmware.current-release-observation", capability.versionIdentification.sourceFactIds,
  )]);
  if (input.currentObservation.method !== capability.versionIdentification.method) return block("current_release_observation_method_invalid");
  const current = input.currentObservation.releaseFactId;
  if (!releases.has(current)) return block("current_release_unknown", [requirement(
    input, `requirement.firmware.${input.instanceId}.known-current-release`, "evidence", [], "boot", "first_boot",
    "firmware.current-release-resolution", input.currentObservation.evidenceRefs,
  )]);
  if (input.targetReleaseFactId === null && minimum !== null && (current === minimum || directedReachable(capability, minimum, current, false))) target = current;
  common.targetReleaseFactId = target;
  if (current === target) {
    if (searchAuthority.requestedSettings.length === 0) return finish(input, common, {
      ...empty, verdict: "pass", reason: "already_at_target",
      recovery: { status: "not_required", transitionIds: [], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [] },
    });
    const node = settingsRequirement(input);
    const satisfied = availableRequirements.has(node.requirementId);
    return finish(input, common, {
      ...empty,
      verdict: satisfied ? "pass" : "blocked",
      reason: satisfied ? "already_at_target" : "requirements_missing",
      missingRequirementIds: satisfied ? [] : [node.requirementId],
      derivedRequirements: [node],
      recovery: { status: "not_required", transitionIds: [], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [] },
    });
  }

  const enumerated = enumeratePaths(capability, current, target);
  if (enumerated.truncated) {
    throw new Error("firmware directed-path search exceeded the complete-search limit");
  }
  if (enumerated.paths.length === 0) return block("no_directed_path");
  const candidates = enumerated.paths.map((path) => analyzeCandidatePath(
    input,
    path.map((transition) => evaluateTransition(input, transition, availableRequirements, availableFacts, detailMap)),
    availableRequirements,
    availableFacts,
    detailMap,
  ));
  candidates.sort((left, right) => compareScore(scorePath(left), scorePath(right)));
  const selectedAnalysis = candidates[0];
  const selected = selectedAnalysis.details;
  const derived = new Map();
  for (const detail of selected) {
    addTransitionRequirementNodes(input, derived, detail);
    for (const factId of detail.missingPowerPrerequisiteFactIds) addDerived(derived, requirement(
      input, `requirement.firmware.${input.instanceId}.power-fact.${shortHash(factId)}`, "evidence", [], "safety", "pre_power",
      "firmware.power-prerequisite", [factId],
    ));
  }
  const missingRequirementIds = new Set(selectedAnalysis.missingRequirementIds);
  const missingPowerPrerequisiteFactIds = new Set(selectedAnalysis.missingPowerPrerequisiteFactIds);
  const settingsReset = selectedAnalysis.settingsReset;
  if (searchAuthority.requestedSettings.length > 0) {
    const settingsRequirementId = selectedAnalysis.settingsRequirementId;
    addDerived(derived, settingsRequirement(input));
    if (!availableRequirements.has(settingsRequirementId)) {
      missingRequirementIds.add(settingsRequirementId);
    }
  }

  const recoveryDetails = selectedAnalysis.recoveryDetails;
  const recoveryUnavailable = selectedAnalysis.recoveryUnavailable;
  if (input.requireRecovery) {
    if (recoveryUnavailable) {
      const recoveryRequirementId = `requirement.firmware.${input.instanceId}.recovery-plan`;
      addDerived(derived, requirement(input, recoveryRequirementId, "user_decision", [], "safety", "pre_power",
        "firmware.recovery-plan", capability.sourceFactIds));
      if (!availableRequirements.has(recoveryRequirementId)) {
        missingRequirementIds.add(recoveryRequirementId);
      }
    }
    for (const detail of recoveryDetails) {
      addTransitionRequirementNodes(input, derived, detail);
      for (const factId of detail.missingPowerPrerequisiteFactIds) addDerived(derived, requirement(
        input, `requirement.firmware.${input.instanceId}.power-fact.${shortHash(factId)}`, "evidence", [], "safety", "pre_power",
        "firmware.power-prerequisite", [factId],
      ));
    }
  }
  const recoveryMissingRequirementIds = normalizeStrings(recoveryDetails.flatMap((detail) => detail.missingRequirementIds));
  const recoveryMissingFactIds = normalizeStrings(recoveryDetails.flatMap((detail) => detail.missingPowerPrerequisiteFactIds));
  const recovery = {
    status: !input.requireRecovery ? "not_required" : recoveryUnavailable ? "unavailable"
      : recoveryMissingRequirementIds.length > 0 || recoveryMissingFactIds.length > 0 ? "blocked" : "available",
    transitionIds: recoveryDetails.map((detail) => detail.transitionId),
    missingRequirementIds: recoveryMissingRequirementIds,
    missingPowerPrerequisiteFactIds: recoveryMissingFactIds,
  };
  const missingIds = normalizeStrings([...missingRequirementIds]);
  const missingFacts = normalizeStrings([...missingPowerPrerequisiteFactIds]);
  const verdict = !recoveryUnavailable && missingIds.length === 0 && missingFacts.length === 0 ? "pass" : "blocked";
  return finish(input, common, {
    verdict,
    reason: verdict === "pass" ? "path_available" : recoveryUnavailable ? "recovery_unavailable" : "requirements_missing",
    selectedTransitions: selected.map(({ preflightRequirements: _ignored, sourceRequirements: _sources, ...detail }) => detail),
    bridgeReleaseFactIds: selected.slice(0, -1).map((detail) => detail.toReleaseFactId),
    missingRequirementIds: missingIds,
    missingPowerPrerequisiteFactIds: missingFacts,
    derivedRequirements: [...derived.values()].sort((left, right) => compare(left.requirementId, right.requirementId)),
    settingsReset,
    recovery,
    pathAlternativesExamined: candidates.length,
    searchTruncated: enumerated.truncated,
    assumptions: [
      ...(selected.some((detail) => detail.requiresWorkingCpu) && input.preflight.workingCpuAvailable === null ? ["working CPU availability is unknown"] : []),
      ...(selected.some((detail) => detail.requiresWorkingCpu) && input.preflight.workingMemoryAvailable === null ? ["working memory availability is unknown"] : []),
      ...(selected.some((detail) => detail.requiresWorkingCpu) && input.preflight.displayPathAvailable === null ? ["display path availability is unknown"] : []),
    ],
  });
}

/**
 * Project every requirement template that could participate in path search.
 * This is intentionally broader than one selected route: allocation must be
 * able to prove an alternative executable route before route ranking occurs.
 */
export function projectFirmwareCandidateRequirementsRuntime(input) {
  const errors = validateInput(input);
  if (errors.length) throw new TypeError(errors.join("; "));
  const derived = new Map();
  const availableRequirements = new Set();
  const availableFacts = new Set(input.availableFactIds);
  const detailMap = transitionDetailMap(input);
  for (const transition of [...input.capability.transitions]
    .sort((left, right) => compare(left.transitionId, right.transitionId))) {
    const detail = evaluateTransition(input, transition, availableRequirements, availableFacts, detailMap);
    addTransitionRequirementNodes(input, derived, detail);
  }
  if (input.requestedSettings.length > 0) addDerivedWithEvidenceMerge(derived, settingsRequirement(input));
  return [...derived.values()].sort((left, right) => compare(left.requirementId, right.requirementId));
}

export function evaluateFirmwarePathRuntime(input) {
  try {
    const errors = validateInput(input);
    if (errors.length) throw new TypeError(errors.join("; "));
    return buildEvaluation(input);
  } catch (error) {
    throw error instanceof Error ? error : new TypeError("firmware path input invalid");
  }
}

function structuralEvaluation(value) {
  const fields = [
    "schemaVersion", "instanceId", "capabilityRef", "currentObservation", "cpuSkuId", "minimumReleaseFactId", "targetReleaseFactId",
    "searchAuthority", "verdict", "reason", "selectedTransitions", "bridgeReleaseFactIds", "missingRequirementIds",
    "missingPowerPrerequisiteFactIds", "derivedRequirements", "settingsReset", "recovery", "pathAlternativesExamined",
    "searchTruncated", "assumptions", "contentHash",
  ];
  if (!exact(value, fields) || value.schemaVersion !== "firmware-path-evaluation-v1") return ["firmware path evaluation shape/schema invalid"];
  const errors = [];
  if (!id(value.instanceId) || !exact(value.capabilityRef, ["subjectSkuId", "subjectRevision", "region", "contentHash", "factSnapshotRef"])
    || ![value.capabilityRef.subjectSkuId, value.capabilityRef.subjectRevision, value.capabilityRef.region].every(id)
    || !HASH.test(String(value.capabilityRef.contentHash ?? "")) || !record(value.capabilityRef.factSnapshotRef)) errors.push("firmware path capability reference invalid");
  if (value.currentObservation !== null && !observation(value.currentObservation)) errors.push("firmware path current observation invalid");
  if (value.cpuSkuId !== null && !id(value.cpuSkuId) || value.minimumReleaseFactId !== null && !id(value.minimumReleaseFactId)
    || value.targetReleaseFactId !== null && !id(value.targetReleaseFactId)) errors.push("firmware path release identity invalid");
  if (!exact(value.searchAuthority, ["requestedTargetReleaseFactId", "availableRequirementIds", "availableFactIds", "preflight", "transitionTemporaryHardwareRequirements", "requestedSettings", "requireRecovery"])
    || value.searchAuthority.requestedTargetReleaseFactId !== null && !id(value.searchAuthority.requestedTargetReleaseFactId)
    || !strings(value.searchAuthority?.availableRequirementIds) || !strings(value.searchAuthority?.availableFactIds)
    || !preflight(value.searchAuthority?.preflight) || !Array.isArray(value.searchAuthority?.transitionTemporaryHardwareRequirements)
    || value.searchAuthority.transitionTemporaryHardwareRequirements.some((candidate) => !temporaryRequirements(candidate))
    || !Array.isArray(value.searchAuthority?.requestedSettings) || value.searchAuthority.requestedSettings.some((candidate) => !requestedSetting(candidate))
    || typeof value.searchAuthority?.requireRecovery !== "boolean") errors.push("firmware path search authority invalid");
  if (Array.isArray(value.searchAuthority?.transitionTemporaryHardwareRequirements)) {
    const transitionIds = value.searchAuthority.transitionTemporaryHardwareRequirements.map((candidate) => candidate?.transitionId);
    if (new Set(transitionIds).size !== transitionIds.length) errors.push("firmware path temporary hardware transition IDs must be unique");
  }
  if (Array.isArray(value.searchAuthority?.requestedSettings)) {
    const settingIds = value.searchAuthority.requestedSettings.map((candidate) => candidate?.settingId);
    if (new Set(settingIds).size !== settingIds.length) errors.push("firmware path requested setting IDs must be unique");
  }
  if (!["pass", "blocked"].includes(value.verdict) || !id(value.reason) || !Array.isArray(value.selectedTransitions)) errors.push("firmware path verdict/transitions invalid");
  if (![value.bridgeReleaseFactIds, value.missingRequirementIds, value.missingPowerPrerequisiteFactIds, value.assumptions].every((candidate) => strings(candidate))) errors.push("firmware path result collections invalid");
  if (!Array.isArray(value.derivedRequirements)) errors.push("firmware path derivedRequirements invalid");
  else value.derivedRequirements.forEach((node, index) => errors.push(...validateRequirementNodeRuntime(node).map((error) => `derivedRequirements.${index}: ${error}`)));
  if (typeof value.settingsReset !== "boolean" || !Number.isSafeInteger(value.pathAlternativesExamined) || value.pathAlternativesExamined < 0
    || typeof value.searchTruncated !== "boolean") errors.push("firmware path search result invalid");
  if (!exact(value.recovery, ["status", "transitionIds", "missingRequirementIds", "missingPowerPrerequisiteFactIds"])
    || !["not_required", "available", "blocked", "unavailable"].includes(value.recovery?.status)
    || !strings(value.recovery?.transitionIds) || !strings(value.recovery?.missingRequirementIds)
    || !strings(value.recovery?.missingPowerPrerequisiteFactIds)) errors.push("firmware path recovery invalid");
  const expectedHash = contentHash(value);
  if (!HASH.test(String(value.contentHash ?? "")) || expectedHash === null || value.contentHash !== expectedHash) errors.push("firmware path content hash mismatch");
  return errors;
}

export function validateFirmwarePathEvaluationRuntime(value, capability) {
  try {
    const errors = structuralEvaluation(value);
    if (errors.length) return errors;
    if (capability === undefined) return ["firmware path locked capability authority is required for replay"];
    const capabilityErrors = validateFirmwareCapabilityRuntime(capability);
    if (capabilityErrors.length) return [...errors, ...capabilityErrors.map((error) => `firmware path capability authority invalid: ${error}`)];
    if (capability.contentHash !== value.capabilityRef.contentHash
      || capability.subjectSkuId !== value.capabilityRef.subjectSkuId
      || capability.subjectRevision !== value.capabilityRef.subjectRevision
      || capability.region !== value.capabilityRef.region
      || canonical(capability.factSnapshotRef, false) !== canonical(value.capabilityRef.factSnapshotRef, false)) {
      return [...errors, "firmware path capability closure mismatch"];
    }
    const input = {
      capability,
      instanceId: value.instanceId,
      currentObservation: value.currentObservation,
      cpuSkuId: value.cpuSkuId,
      targetReleaseFactId: value.searchAuthority.requestedTargetReleaseFactId,
      availableRequirementIds: value.searchAuthority.availableRequirementIds,
      availableFactIds: value.searchAuthority.availableFactIds,
      preflight: value.searchAuthority.preflight,
      transitionTemporaryHardwareRequirements: value.searchAuthority.transitionTemporaryHardwareRequirements,
      requestedSettings: value.searchAuthority.requestedSettings,
      requireRecovery: value.searchAuthority.requireRecovery,
    };
    const inputErrors = validateInput(input);
    if (inputErrors.length) return [...errors, ...inputErrors.map((error) => `firmware path replay input invalid: ${error}`)];
    const replay = buildEvaluation(input);
    if (canonical(replay) !== canonical(value)) errors.push("firmware path evaluation differs from authoritative graph replay");
    return errors;
  } catch { return ["firmware path evaluation is inaccessible or invalid"]; }
}

/**
 * Close every caller-claimed firmware prerequisite against the canonical
 * RequirementSatisfaction allocation shared by the enclosing evaluation.
 *
 * The path replay above proves that the claimed IDs affect route selection;
 * this replay proves that the IDs are not self-authored availability flags.
 * It also rejects a stale blocked path after one of its missing requirements
 * has become satisfied, forcing the enclosing evaluator to rerun path search.
 */
export function validateFirmwarePathRequirementClosureRuntime(value, allocation) {
  try {
    const errors = structuralEvaluation(value);
    const allocationErrors = validateRequirementAllocationResultRuntime(allocation);
    if (allocationErrors.length > 0) {
      return [
        ...errors,
        "firmware path requirement allocation authority invalid",
        ...allocationErrors.map((error) => `firmware path requirement allocation: ${error}`),
      ];
    }
    if (errors.length > 0) return errors;

    const requirementById = new Map(allocation.requirements.map((requirement) => [requirement.requirementId, requirement]));
    const satisfactionById = new Map(allocation.satisfactions.map((satisfaction) => [satisfaction.requirementId, satisfaction]));
    const available = new Set(value.searchAuthority.availableRequirementIds);
    for (const requirementId of available) {
      const satisfaction = satisfactionById.get(requirementId);
      if (satisfaction === undefined || satisfaction.status !== "satisfied" || satisfaction.residualQuantity !== 0) {
        errors.push(`firmware available requirement lacks satisfied allocation authority: ${requirementId}`);
      }
    }

    const missing = normalizeStrings([
      ...value.missingRequirementIds,
      ...value.recovery.missingRequirementIds,
      ...value.selectedTransitions.flatMap((transition) => transition.missingRequirementIds),
    ]);
    for (const requirementId of missing) {
      if (available.has(requirementId)) {
        errors.push(`firmware requirement is both available and missing: ${requirementId}`);
      }
      const satisfaction = satisfactionById.get(requirementId);
      if (satisfaction?.status === "satisfied" && satisfaction.residualQuantity === 0) {
        errors.push(`firmware path is stale after requirement became satisfied: ${requirementId}`);
      }
    }

    for (const derived of value.derivedRequirements) {
      const canonicalRequirement = requirementById.get(derived.requirementId);
      if (canonicalRequirement === undefined || canonical(canonicalRequirement, false) !== canonical(derived, false)) {
        errors.push(`firmware derived requirement is absent from canonical allocation: ${derived.requirementId}`);
      }
    }
    return errors;
  } catch {
    return ["firmware path requirement closure is inaccessible or invalid"];
  }
}

export function firmwarePathReferencesRuntime(value, capability) {
  try {
    if (validateFirmwarePathEvaluationRuntime(value, capability).length) return null;
    return Object.freeze({
      capabilityHash: value.capabilityRef.contentHash,
      factSnapshotRef: Object.freeze(structuredClone(value.capabilityRef.factSnapshotRef)),
      observationIds: Object.freeze(value.currentObservation === null ? [] : [`observation:${value.currentObservation.observationId}`]),
      factIds: Object.freeze(normalizeStrings([
        ...capability.sourceFactIds,
        ...capability.versionIdentification.sourceFactIds,
        ...capability.releases.flatMap((release) => release.sourceFactIds),
        ...capability.cpuSupport.flatMap((support) => support.sourceFactIds),
        ...capability.transitions.flatMap((transition) => [
          transition.firmwareFileFactId, transition.checksumFactId, ...transition.powerPrerequisiteFactIds,
          ...transition.releaseFactIds, ...transition.sourceFactIds,
        ]),
        ...capability.settings.flatMap((setting) => setting.sourceFactIds),
        ...value.searchAuthority.availableFactIds,
        ...value.searchAuthority.requestedSettings.flatMap((setting) => setting.evidenceRefs),
        ...value.selectedTransitions.flatMap((transition) => [
          transition.firmwareFileFactId, transition.checksumFactId, ...transition.powerPrerequisiteFactIds,
          ...transition.releaseFactIds, ...transition.sourceFactIds,
        ]),
        ...value.recovery.transitionIds.flatMap((transitionId) => {
          const transition = capability.transitions.find((candidate) => candidate.transitionId === transitionId);
          return transition === undefined ? [] : [
            transition.firmwareFileFactId, transition.checksumFactId, ...transition.powerPrerequisiteFactIds,
            ...transition.releaseFactIds, ...transition.sourceFactIds,
          ];
        }),
        ...value.missingPowerPrerequisiteFactIds,
      ])),
      requirementIds: Object.freeze(normalizeStrings([
        ...value.searchAuthority.availableRequirementIds,
        ...value.searchAuthority.transitionTemporaryHardwareRequirements.flatMap((entry) => entry.requirementIds),
        ...value.selectedTransitions.flatMap((transition) => [
          ...transition.requirementIds, ...transition.temporaryHardwareRequirementIds,
        ]),
        ...value.recovery.transitionIds.flatMap((transitionId) => {
          const transition = capability.transitions.find((candidate) => candidate.transitionId === transitionId);
          return transition === undefined ? [] : transition.requirementIds.map((requirementId) => (
            firmwareRequirementIdRuntime(value.instanceId, requirementId) ?? requirementId
          ));
        }),
        ...value.derivedRequirements.map((node) => node.requirementId),
      ])),
    });
  } catch { return null; }
}
