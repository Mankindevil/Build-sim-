import {
  FIRMWARE_SETTING_REGISTRY,
  isFirmwareSettingId,
  validateFirmwareSettingValue,
  type FirmwareSettingId,
} from "../contracts/registries";
import { hashContent } from "../hash";
import type { CapabilityFactSnapshotRef } from "./facets";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isNfcText,
  isPortableId,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
  validateFactSnapshotRef,
} from "./validation";

export type FirmwareUpgradeMethod = "uefi" | "usb_flashback" | "bmc" | "os_tool";
export type FirmwareTransitionPurpose = "upgrade" | "rollback" | "recovery";
export type FirmwareVersionIdentificationMethod = "uefi_screen" | "bmc_inventory" | "os_probe" | "label_observation";

export interface FirmwareReleaseFacet {
  releaseFactId: string;
  label: string;
  sourceFactIds: string[];
}

export interface FirmwareCpuSupportFacet {
  cpuSkuId: string;
  minimumReleaseFactId: string;
  sourceFactIds: string[];
}

export interface FirmwareTransitionFacet {
  transitionId: string;
  fromReleaseFactId: string;
  toReleaseFactId: string;
  purpose: FirmwareTransitionPurpose;
  method: FirmwareUpgradeMethod;
  requiresWorkingCpu: boolean;
  requirementIds: string[];
  firmwareFileFactId: string;
  mediaFormat: "fat32" | "vendor_tool" | "os_managed";
  requiredFilename: string;
  checksumFactId: string;
  powerPrerequisiteFactIds: string[];
  recoveryTransitionIds: string[];
  resetsSettings: boolean;
  releaseFactIds: string[];
  sourceFactIds: string[];
}

export interface FirmwareSettingFacet {
  settingId: FirmwareSettingId;
  supportedValues: string[];
  sourceFactIds: string[];
}

export interface FirmwareCapabilityInput {
  schemaVersion: "firmware-capability-v1";
  subjectSkuId: string;
  subjectRevision: string;
  region: string;
  factSnapshotRef: CapabilityFactSnapshotRef;
  versionIdentification: { method: FirmwareVersionIdentificationMethod; sourceFactIds: string[] };
  releases: FirmwareReleaseFacet[];
  cpuSupport: FirmwareCpuSupportFacet[];
  transitions: FirmwareTransitionFacet[];
  settings: FirmwareSettingFacet[];
  rollbackSupported: boolean;
  recoveryMethod: FirmwareUpgradeMethod | "none";
  sourceFactIds: string[];
}

export interface FirmwareCapability extends FirmwareCapabilityInput {
  contentHash: string;
}

export interface FirmwarePathResult {
  status: "pass" | "blocked";
  reason: "already_at_target" | "path_available" | "requirements_missing" | "release_unknown" | "no_directed_path";
  transitionIds: string[];
  missingRequirementIds: string[];
}

export type CpuFirmwareSupportResult =
  | { status: "supported"; minimumReleaseFactId: string; targetReleaseFactId: string; transitionIds: [] }
  | { status: "upgrade_required"; minimumReleaseFactId: string; targetReleaseFactId: string; transitionIds: string[]; missingRequirementIds: string[]; pathStatus: "pass" | "blocked" }
  | { status: "blocked"; reason: "cpu_support_unknown" | "current_release_unknown" | "no_executable_upgrade_path"; targetReleaseFactId?: string };

const CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);
const METHODS = new Set<FirmwareUpgradeMethod>(["uefi", "usb_flashback", "bmc", "os_tool"]);
const PURPOSES = new Set<FirmwareTransitionPurpose>(["upgrade", "rollback", "recovery"]);
const IDENTIFICATION_METHODS = new Set<FirmwareVersionIdentificationMethod>(["uefi_screen", "bmc_inventory", "os_probe", "label_observation"]);

function strictlySorted<T>(values: readonly T[], key: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || compareCanonical(key(values[index - 1]!), key(value)) < 0);
}

function sortedIds(value: unknown, requireNonEmpty = true): value is string[] {
  return isUniquePortableIdArray(value, requireNonEmpty)
    && strictlySorted(value, (candidate) => candidate);
}

function validateRelease(value: unknown): string[] {
  const release = safeRecord(value);
  if (!release || !hasExactKeys(release, ["releaseFactId", "label", "sourceFactIds"])) return ["firmware release shape invalid"];
  const errors: string[] = [];
  if (!isPortableId(release.releaseFactId) || !isNfcText(release.label)) errors.push("firmware release identity invalid");
  if (!sortedIds(release.sourceFactIds)) errors.push("firmware release sourceFactIds invalid");
  return errors;
}

function validateCpuSupport(value: unknown): string[] {
  const support = safeRecord(value);
  if (!support || !hasExactKeys(support, ["cpuSkuId", "minimumReleaseFactId", "sourceFactIds"])) return ["firmware CPU support shape invalid"];
  const errors: string[] = [];
  if (!isPortableId(support.cpuSkuId) || !isPortableId(support.minimumReleaseFactId)) errors.push("firmware CPU support identity invalid");
  if (!sortedIds(support.sourceFactIds)) errors.push("firmware CPU support sourceFactIds invalid");
  return errors;
}

function validateTransition(value: unknown): string[] {
  const transition = safeRecord(value);
  const fields = [
    "transitionId", "fromReleaseFactId", "toReleaseFactId", "purpose", "method", "requiresWorkingCpu", "requirementIds",
    "firmwareFileFactId", "mediaFormat", "requiredFilename", "checksumFactId", "powerPrerequisiteFactIds",
    "recoveryTransitionIds", "resetsSettings", "releaseFactIds", "sourceFactIds",
  ];
  if (!transition || !hasExactKeys(transition, fields)) return ["firmware transition shape invalid"];
  const errors: string[] = [];
  if (![transition.transitionId, transition.fromReleaseFactId, transition.toReleaseFactId, transition.firmwareFileFactId, transition.checksumFactId].every(isPortableId)
    || !isNfcText(transition.requiredFilename)) errors.push("firmware transition identity/file invalid");
  if (transition.fromReleaseFactId === transition.toReleaseFactId) errors.push("firmware transition must change release");
  if (!PURPOSES.has(transition.purpose as FirmwareTransitionPurpose)) errors.push("firmware transition purpose invalid");
  if (!METHODS.has(transition.method as FirmwareUpgradeMethod)) errors.push("firmware transition method invalid");
  if (typeof transition.requiresWorkingCpu !== "boolean" || typeof transition.resetsSettings !== "boolean") errors.push("firmware transition boolean fields invalid");
  if (!sortedIds(transition.requirementIds, false)
    || !sortedIds(transition.powerPrerequisiteFactIds)
    || !sortedIds(transition.recoveryTransitionIds, false)
    || !sortedIds(transition.releaseFactIds)
    || !sortedIds(transition.sourceFactIds)) errors.push("firmware transition reference arrays invalid");
  if (!Array.isArray(transition.releaseFactIds)
    || transition.releaseFactIds.length !== 2
    || !transition.releaseFactIds.includes(transition.fromReleaseFactId)
    || !transition.releaseFactIds.includes(transition.toReleaseFactId)) errors.push("firmware transition releaseFactIds must bind both endpoints");
  if (!["fat32", "vendor_tool", "os_managed"].includes(String(transition.mediaFormat))) errors.push("firmware transition mediaFormat invalid");
  if (transition.method === "usb_flashback" && transition.requiresWorkingCpu !== false) errors.push("USB flashback transition cannot require a working CPU");
  if (transition.requiresWorkingCpu === true && Array.isArray(transition.requirementIds) && transition.requirementIds.length === 0) errors.push("working-CPU transition requires explicit requirements");
  return errors;
}

function validateSetting(value: unknown): string[] {
  const setting = safeRecord(value);
  if (!setting || !hasExactKeys(setting, ["settingId", "supportedValues", "sourceFactIds"])) return ["firmware setting shape invalid"];
  const errors: string[] = [];
  const supportedValues = sortedIds(setting.supportedValues) ? setting.supportedValues : null;
  if (!isFirmwareSettingId(setting.settingId)
    || supportedValues === null
    || supportedValues.some((candidate) => validateFirmwareSettingValue(setting.settingId, candidate).length > 0)) errors.push("firmware settingId/value invalid");
  if (isFirmwareSettingId(setting.settingId) && supportedValues !== null) {
    const all = FIRMWARE_SETTING_REGISTRY[setting.settingId].allowedValues;
    if (supportedValues.length > all.length) errors.push("firmware setting values exceed registry");
  }
  if (!sortedIds(setting.sourceFactIds)) errors.push("firmware setting sourceFactIds invalid");
  return errors;
}

function validateFirmwareCapabilityUnsafe(value: unknown, requireHash: boolean): string[] {
  const capability = safeRecord(value);
  if (!capability) return ["firmware capability must be an object"];
  const required = [
    "schemaVersion", "subjectSkuId", "subjectRevision", "region", "factSnapshotRef", "versionIdentification",
    "releases", "cpuSupport", "transitions", "settings", "rollbackSupported", "recoveryMethod", "sourceFactIds",
  ];
  const errors: string[] = [];
  if (!hasExactKeys(capability, required, requireHash ? ["contentHash"] : []) || (requireHash && !("contentHash" in capability))) {
    errors.push("firmware capability contains unknown fields");
  }
  if (containsNonNfcText(capability)) errors.push("firmware capability contains non-NFC text");
  if (capability.schemaVersion !== "firmware-capability-v1") errors.push("firmware capability schemaVersion invalid");
  if (!isPortableId(capability.subjectSkuId) || !isPortableId(capability.subjectRevision) || !isPortableId(capability.region)) errors.push("firmware capability subject scope invalid");
  errors.push(...validateFactSnapshotRef(capability.factSnapshotRef).map((error) => `firmware capability ${error}`));
  const identification = safeRecord(capability.versionIdentification);
  if (!identification || !hasExactKeys(identification, ["method", "sourceFactIds"])
    || !IDENTIFICATION_METHODS.has(identification.method as FirmwareVersionIdentificationMethod)
    || !sortedIds(identification.sourceFactIds)) errors.push("firmware versionIdentification invalid");
  if (!Array.isArray(capability.releases) || capability.releases.length === 0) errors.push("firmware releases invalid");
  else {
    capability.releases.forEach((release, index) => errors.push(...validateRelease(release).map((error) => `firmware releases.${index} ${error}`)));
    if (!strictlySorted(capability.releases, (release) => String(safeRecord(release)?.releaseFactId ?? ""))) errors.push("firmware releases order invalid");
  }
  if (!Array.isArray(capability.cpuSupport) || capability.cpuSupport.length === 0) errors.push("firmware cpuSupport invalid");
  else {
    capability.cpuSupport.forEach((entry, index) => errors.push(...validateCpuSupport(entry).map((error) => `firmware cpuSupport.${index} ${error}`)));
    if (!strictlySorted(capability.cpuSupport, (entry) => String(safeRecord(entry)?.cpuSkuId ?? ""))) errors.push("firmware cpuSupport order invalid");
  }
  if (!Array.isArray(capability.transitions)) errors.push("firmware transitions invalid");
  else {
    capability.transitions.forEach((transition, index) => errors.push(...validateTransition(transition).map((error) => `firmware transitions.${index} ${error}`)));
    if (!strictlySorted(capability.transitions, (transition) => String(safeRecord(transition)?.transitionId ?? ""))) errors.push("firmware transitions order invalid");
  }
  if (!Array.isArray(capability.settings)) errors.push("firmware settings invalid");
  else {
    capability.settings.forEach((setting, index) => errors.push(...validateSetting(setting).map((error) => `firmware settings.${index} ${error}`)));
    if (!strictlySorted(capability.settings, (setting) => String(safeRecord(setting)?.settingId ?? ""))) errors.push("firmware settings order invalid");
  }
  if (typeof capability.rollbackSupported !== "boolean" || (capability.recoveryMethod !== "none" && !METHODS.has(capability.recoveryMethod as FirmwareUpgradeMethod))) {
    errors.push("firmware rollback/recovery flags invalid");
  }
  if (!sortedIds(capability.sourceFactIds)) errors.push("firmware capability sourceFactIds invalid");
  if (requireHash && !isSha256(capability.contentHash)) errors.push("firmware capability contentHash invalid");

  const releases = Array.isArray(capability.releases) ? capability.releases.map(safeRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
  const releaseIds = releases.map((release) => release.releaseFactId).filter((id): id is string => typeof id === "string");
  if (new Set(releaseIds).size !== releaseIds.length) errors.push("firmware release IDs must be unique");
  const support = Array.isArray(capability.cpuSupport) ? capability.cpuSupport.map(safeRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
  const cpuIds = support.map((entry) => entry.cpuSkuId).filter((id): id is string => typeof id === "string");
  if (new Set(cpuIds).size !== cpuIds.length) errors.push("firmware CPU support entries must be unique");
  if (support.some((entry) => typeof entry.minimumReleaseFactId !== "string" || !releaseIds.includes(entry.minimumReleaseFactId))) errors.push("firmware CPU support release reference missing");
  const transitions = Array.isArray(capability.transitions) ? capability.transitions.map(safeRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
  const transitionIds = transitions.map((transition) => transition.transitionId).filter((id): id is string => typeof id === "string");
  if (new Set(transitionIds).size !== transitionIds.length) errors.push("firmware transition IDs must be unique");
  for (const transition of transitions) {
    if (typeof transition.fromReleaseFactId !== "string" || !releaseIds.includes(transition.fromReleaseFactId)
      || typeof transition.toReleaseFactId !== "string" || !releaseIds.includes(transition.toReleaseFactId)) errors.push("firmware transition release reference missing");
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
  const settingIds = Array.isArray(capability.settings)
    ? capability.settings.map((setting) => safeRecord(setting)?.settingId).filter((id): id is string => typeof id === "string") : [];
  if (new Set(settingIds).size !== settingIds.length) errors.push("firmware setting IDs must be unique");
  if (capability.rollbackSupported === true && transitions.every((transition) => transition.purpose !== "rollback")) {
    errors.push("firmware rollbackSupported requires an explicit rollback transition");
  }
  if (capability.recoveryMethod !== "none" && transitions.every((transition) => transition.method !== capability.recoveryMethod || transition.purpose === "upgrade")) {
    errors.push("firmware recoveryMethod has no executable transition");
  }
  if (transitions.some((transition) => transition.purpose === "upgrade"
      && Array.isArray(transition.recoveryTransitionIds) && transition.recoveryTransitionIds.length > 0)
    && capability.rollbackSupported !== true && capability.recoveryMethod === "none") {
    errors.push("firmware transition recovery references require an enabled recovery policy");
  }
  return errors;
}

export function validateFirmwareCapabilityInput(value: unknown): string[] {
  try { return validateFirmwareCapabilityUnsafe(value, false); }
  catch { return ["firmware capability input is inaccessible or invalid"]; }
}

export function validateFirmwareCapability(value: unknown): string[] {
  try { return validateFirmwareCapabilityUnsafe(value, true); }
  catch { return ["firmware capability is inaccessible or invalid"]; }
}

function normalizeCapability(input: FirmwareCapabilityInput): FirmwareCapabilityInput {
  const normalized = normalizeNfcJson(input);
  const sortRefs = <T extends { sourceFactIds: string[] }>(value: T): T => ({ ...value, sourceFactIds: [...value.sourceFactIds].sort(compareCanonical) });
  normalized.releases = normalized.releases.map(sortRefs).sort((left, right) => compareCanonical(left.releaseFactId, right.releaseFactId));
  normalized.cpuSupport = normalized.cpuSupport.map(sortRefs).sort((left, right) => compareCanonical(left.cpuSkuId, right.cpuSkuId));
  normalized.transitions = normalized.transitions.map((transition) => ({
    ...sortRefs(transition),
    requirementIds: [...transition.requirementIds].sort(compareCanonical),
    powerPrerequisiteFactIds: [...transition.powerPrerequisiteFactIds].sort(compareCanonical),
    recoveryTransitionIds: [...transition.recoveryTransitionIds].sort(compareCanonical),
    releaseFactIds: [...transition.releaseFactIds].sort(compareCanonical),
  })).sort((left, right) => compareCanonical(left.transitionId, right.transitionId));
  normalized.settings = normalized.settings.map((setting) => ({
    ...sortRefs(setting), supportedValues: [...setting.supportedValues].sort(compareCanonical),
  })).sort((left, right) => compareCanonical(left.settingId, right.settingId));
  normalized.versionIdentification.sourceFactIds.sort(compareCanonical);
  normalized.sourceFactIds.sort(compareCanonical);
  return normalized;
}

export async function firmwareCapabilityContentHash(value: FirmwareCapabilityInput | FirmwareCapability): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createFirmwareCapability(input: FirmwareCapabilityInput): Promise<FirmwareCapability> {
  const normalized = normalizeCapability(input);
  const errors = validateFirmwareCapabilityInput(normalized);
  if (errors.length) throw new TypeError(`Invalid firmware capability: ${errors.join("; ")}`);
  const capability: FirmwareCapability = { ...normalized, contentHash: await firmwareCapabilityContentHash(normalized) };
  return deepFreeze(capability) as FirmwareCapability;
}

export async function verifyFirmwareCapability(value: unknown): Promise<boolean> {
  if (validateFirmwareCapability(value).length) return false;
  const capability = value as FirmwareCapability;
  return capability.contentHash === await firmwareCapabilityContentHash(capability);
}

function directedPath(capability: FirmwareCapability, from: string, to: string): FirmwareTransitionFacet[] | null {
  const known = new Set(capability.releases.map((release) => release.releaseFactId));
  if (!known.has(from) || !known.has(to)) return null;
  if (from === to) return [];
  const queue: Array<{ release: string; path: FirmwareTransitionFacet[] }> = [{ release: from, path: [] }];
  const visited = new Set([from]);
  const transitions = capability.transitions.filter((transition) => transition.purpose === "upgrade")
    .sort((left, right) => compareCanonical(left.transitionId, right.transitionId));
  while (queue.length) {
    const current = queue.shift()!;
    for (const transition of transitions.filter((candidate) => candidate.fromReleaseFactId === current.release)) {
      if (visited.has(transition.toReleaseFactId)) continue;
      const path = [...current.path, transition];
      if (transition.toReleaseFactId === to) return path;
      visited.add(transition.toReleaseFactId);
      queue.push({ release: transition.toReleaseFactId, path });
    }
  }
  return null;
}

/** Enumerate bounded simple paths so prerequisite availability participates in selection. */
function directedPaths(
  capability: FirmwareCapability,
  from: string,
  to: string,
  allowRollback = true,
): { paths: FirmwareTransitionFacet[][]; truncated: boolean } {
  const known = new Set(capability.releases.map((release) => release.releaseFactId));
  if (!known.has(from) || !known.has(to)) return { paths: [], truncated: false };
  if (from === to) return { paths: [[]], truncated: false };
  const transitions = capability.transitions.filter((transition) => transition.purpose === "upgrade"
      || (allowRollback && capability.rollbackSupported && transition.purpose === "rollback"))
    .sort((left, right) => compareCanonical(left.transitionId, right.transitionId));
  const outgoing = new Map<string, FirmwareTransitionFacet[]>();
  for (const transition of transitions) outgoing.set(transition.fromReleaseFactId, [...(outgoing.get(transition.fromReleaseFactId) ?? []), transition]);
  const paths: FirmwareTransitionFacet[][] = [];
  let examinedEdges = 0;
  let truncated = false;
  const visit = (release: string, path: FirmwareTransitionFacet[], visited: ReadonlySet<string>): void => {
    if (paths.length >= 4_096) { truncated = true; return; }
    for (const transition of outgoing.get(release) ?? []) {
      examinedEdges += 1;
      if (examinedEdges > 4_096) { truncated = true; return; }
      if (visited.has(transition.toReleaseFactId)) continue;
      const next = [...path, transition];
      if (transition.toReleaseFactId === to) {
        if (paths.length >= 4_096) { truncated = true; return; }
        paths.push(next);
      }
      else visit(transition.toReleaseFactId, next, new Set([...visited, transition.toReleaseFactId]));
      if (truncated) return;
    }
  };
  visit(from, [], new Set([from]));
  return { paths, truncated };
}

function deriveFirmwareUpgradePath(
  capability: FirmwareCapability,
  currentReleaseFactId: string,
  targetReleaseFactId: string,
  availableRequirementIds: ReadonlySet<string>,
  allowRollback = true,
): FirmwarePathResult {
  const releases = new Set(capability.releases.map((release) => release.releaseFactId));
  if (!releases.has(currentReleaseFactId) || !releases.has(targetReleaseFactId)) {
    return { status: "blocked", reason: "release_unknown", transitionIds: [], missingRequirementIds: [] };
  }
  const enumerated = directedPaths(capability, currentReleaseFactId, targetReleaseFactId, allowRollback);
  if (enumerated.truncated) throw new Error("firmware directed-path search exceeded the complete-search limit");
  const paths = enumerated.paths;
  if (paths.length === 0) return { status: "blocked", reason: "no_directed_path", transitionIds: [], missingRequirementIds: [] };
  const ranked = paths.map((path) => ({
    path,
    missing: [...new Set(path.flatMap((transition) => transition.requirementIds).filter((id) => !availableRequirementIds.has(id)))].sort(compareCanonical),
  })).sort((left, right) => Number(left.missing.length > 0) - Number(right.missing.length > 0)
    || left.missing.length - right.missing.length
    || left.path.length - right.path.length
    || compareCanonical(left.path.map(({ transitionId }) => transitionId).join("\0"), right.path.map(({ transitionId }) => transitionId).join("\0")));
  const { path, missing } = ranked[0]!;
  if (path.length === 0) return { status: "pass", reason: "already_at_target", transitionIds: [], missingRequirementIds: [] };
  return {
    status: missing.length ? "blocked" : "pass",
    reason: missing.length ? "requirements_missing" : "path_available",
    transitionIds: path.map((transition) => transition.transitionId),
    missingRequirementIds: missing,
  };
}

export async function findFirmwareUpgradePath(
  capability: FirmwareCapability,
  currentReleaseFactId: string,
  targetReleaseFactId: string,
  availableRequirementIds: ReadonlySet<string>,
): Promise<FirmwarePathResult> {
  if (!await verifyFirmwareCapability(capability)) throw new TypeError("firmware capability invalid or content hash mismatch");
  return deriveFirmwareUpgradePath(capability, currentReleaseFactId, targetReleaseFactId, availableRequirementIds);
}

export async function evaluateCpuFirmwareSupport(
  capability: FirmwareCapability,
  cpuSkuId: string,
  currentReleaseFactId: string,
  availableRequirementIds: ReadonlySet<string>,
): Promise<CpuFirmwareSupportResult> {
  if (!await verifyFirmwareCapability(capability)) throw new TypeError("firmware capability invalid or content hash mismatch");
  const support = capability.cpuSupport.find((entry) => entry.cpuSkuId === cpuSkuId);
  if (!support) return { status: "blocked", reason: "cpu_support_unknown" };
  if (!capability.releases.some((release) => release.releaseFactId === currentReleaseFactId)) return { status: "blocked", reason: "current_release_unknown", targetReleaseFactId: support.minimumReleaseFactId };
  if (currentReleaseFactId === support.minimumReleaseFactId || directedPath(capability, support.minimumReleaseFactId, currentReleaseFactId) !== null) {
    return { status: "supported", minimumReleaseFactId: support.minimumReleaseFactId, targetReleaseFactId: currentReleaseFactId, transitionIds: [] };
  }
  const path = deriveFirmwareUpgradePath(capability, currentReleaseFactId, support.minimumReleaseFactId, availableRequirementIds, false);
  if (path.reason === "no_directed_path" || path.reason === "release_unknown") {
    return { status: "blocked", reason: "no_executable_upgrade_path", targetReleaseFactId: support.minimumReleaseFactId };
  }
  return {
    status: "upgrade_required",
    minimumReleaseFactId: support.minimumReleaseFactId,
    targetReleaseFactId: support.minimumReleaseFactId,
    transitionIds: path.transitionIds,
    missingRequirementIds: path.missingRequirementIds,
    pathStatus: path.status,
  };
}
