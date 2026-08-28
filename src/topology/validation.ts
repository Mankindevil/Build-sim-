import {
  isComponentKindId,
  isSystemProfileId,
  validateFirmwareSettingValue,
  type ComponentKindId,
} from "../contracts/registries";
import {
  validateRequirementDraftField,
  validateRequirementSpec,
  type MachineIntent,
} from "../requirements/contracts";
import type { BuildConfigV3, VdevTopology } from "./contracts";

const TOP_LEVEL_FIELDS = [
  "schemaVersion", "id", "name", "updatedAt", "intent", "requirementSpec", "system",
  "components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets", "notes",
] as const;
const ARRAY_FIELDS = ["components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets"] as const;
const VDEV_MINIMUM_DISKS: Readonly<Record<VdevTopology, number>> = Object.freeze({
  stripe: 1,
  mirror: 2,
  raidz1: 2,
  raidz2: 3,
  raidz3: 4,
});
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalString(value: string): string {
  // Keep validation total for hostile input. The recursive scalar check emits
  // the contract error; comparisons must still not throw while collecting the
  // remaining diagnostics.
  return isWellFormedUnicode(value) ? value.normalize("NFC") : value;
}

function containsIllFormedUnicode(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return !isWellFormedUnicode(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsIllFormedUnicode(item, seen));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => !isWellFormedUnicode(key) || containsIllFormedUnicode(child, seen),
  );
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function hasUnknownFields(record: Record<string, unknown>, allowedFields: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowedFields.includes(key));
}

function isUniqueNonEmptyStringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every(nonEmpty)
    && new Set(value.map(canonicalString)).size === value.length;
}

function duplicateIds(records: readonly unknown[], field: string): boolean {
  const ids = records.flatMap((record) => isRecord(record) && nonEmpty(record[field]) ? [canonicalString(record[field])] : []);
  return new Set(ids).size !== ids.length;
}

function validateSystem(value: unknown): string[] {
  if (value === null) return [];
  if (!isRecord(value)) return ["system selection invalid"];
  const errors: string[] = [];
  if (!isSystemProfileId(value.profileId) || !nonEmpty(value.versionFactId)
    || (value.source !== "defaulted" && value.source !== "user")
    || typeof value.lockedByUser !== "boolean") errors.push("system selection invalid");
  if (hasUnknownFields(value, ["profileId", "versionFactId", "source", "lockedByUser"])) errors.push("system selection contains unknown fields");
  return errors;
}

function validateComponents(value: unknown[], errors: string[]): { ids: Set<string>; kinds: Map<string, ComponentKindId>; roles: Set<string> } {
  const ids = new Set<string>();
  const kinds = new Map<string, ComponentKindId>();
  const roles = new Set<string>();
  if (duplicateIds(value, "instanceId")) errors.push("component instanceId must be unique");
  value.forEach((component, index) => {
    if (!isRecord(component)) { errors.push(`components.${index} invalid`); return; }
    if (hasUnknownFields(component, ["instanceId", "kind", "role", "state", "identity", "source"])) errors.push(`components.${index} contains unknown fields`);
    const identityFieldsValid = nonEmpty(component.instanceId) && isComponentKindId(component.kind) && nonEmpty(component.role);
    if (!identityFieldsValid) errors.push(`components.${index} identity fields missing or kind is not registered`);
    if (nonEmpty(component.instanceId)) ids.add(canonicalString(component.instanceId));
    if (identityFieldsValid) {
      kinds.set(canonicalString(component.instanceId as string), component.kind as ComponentKindId);
      roles.add(canonicalString(component.role as string));
    }
    if (component.state !== "planned" && component.state !== "ordered") errors.push(`components.${index}.state invalid`);
    if (component.source !== "user" && component.source !== "agent" && component.source !== "migration") errors.push(`components.${index}.source invalid`);
    if (!isRecord(component.identity)) { errors.push(`components.${index}.identity invalid`); return; }
    if (component.identity.status === "unresolved") {
      if (!nonEmpty(component.identity.userText)) errors.push(`components.${index}.identity.userText missing`);
      if (hasUnknownFields(component.identity, ["status", "userText", "candidateIds"])) errors.push(`components.${index}.identity contains unknown fields`);
      if (component.identity.candidateIds !== undefined && !isUniqueNonEmptyStringArray(component.identity.candidateIds)) errors.push(`components.${index}.identity.candidateIds invalid`);
      return;
    }
    if (component.identity.status === "resolved") {
      if (!nonEmpty(component.identity.skuId) || !isUniqueNonEmptyStringArray(component.identity.identityClaimIds, true)) errors.push(`components.${index} resolved identity requires unique skuId and identity claims`);
      if (hasUnknownFields(component.identity, ["status", "skuId", "identityClaimIds"])) errors.push(`components.${index}.identity contains unknown fields`);
      return;
    }
    errors.push(`components.${index}.identity.status invalid`);
  });
  return { ids, kinds, roles };
}

function validateRoleDecisions(value: unknown[], componentRoles: Set<string>, errors: string[]): void {
  if (duplicateIds(value, "roleDecisionId")) errors.push("roleDecisionId must be unique");
  const roles = new Set<string>();
  value.forEach((decision, index) => {
    if (!isRecord(decision)) { errors.push(`roleDecisions.${index} invalid`); return; }
    if (!nonEmpty(decision.roleDecisionId) || !nonEmpty(decision.role) || decision.decision !== "not_needed"
      || (decision.source !== "user" && decision.source !== "migration")) errors.push(`roleDecisions.${index} invalid`);
    if (!isIsoUtc(decision.confirmedAt)) errors.push(`roleDecisions.${index}.confirmedAt must be an ISO UTC timestamp`);
    if (hasUnknownFields(decision, ["roleDecisionId", "role", "decision", "source", "confirmedAt"])) errors.push(`roleDecisions.${index} contains unknown fields`);
    if (nonEmpty(decision.role)) {
      const role = canonicalString(decision.role);
      if (roles.has(role)) errors.push(`roleDecisions.${index} duplicates an existing role decision`);
      roles.add(role);
      if (componentRoles.has(role)) errors.push(`roleDecisions.${index} conflicts with an existing component role`);
    }
  });
}

function validatePlacements(value: unknown[], componentIds: Set<string>, errors: string[]): void {
  if (duplicateIds(value, "placementId")) errors.push("placementId must be unique");
  const componentMounts = new Set<string>();
  value.forEach((placement, index) => {
    if (!isRecord(placement)) { errors.push(`placements.${index} invalid or references a missing instance`); return; }
    if (!nonEmpty(placement.placementId) || !nonEmpty(placement.componentInstanceId) || !componentIds.has(canonicalString(placement.componentInstanceId))
      || !nonEmpty(placement.mountOwnerInstanceId) || !componentIds.has(canonicalString(placement.mountOwnerInstanceId))
      || !nonEmpty(placement.mountId)) errors.push(`placements.${index} invalid or references a missing instance`);
    if (hasUnknownFields(placement, ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"])) errors.push(`placements.${index} contains unknown fields`);
    if (nonEmpty(placement.mountOwnerInstanceId) && nonEmpty(placement.mountId)) {
      const mountKey = JSON.stringify([canonicalString(placement.mountOwnerInstanceId), canonicalString(placement.mountId)]);
      if (componentMounts.has(mountKey)) errors.push(`placements.${index} reuses an occupied mount`);
      componentMounts.add(mountKey);
    }
  });
}

function validateEndpoint(value: unknown, componentIds: Set<string>, label: string, errors: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) { errors.push(`${label} invalid`); return false; }
  if (hasUnknownFields(value, ["instanceId", "portId"])) errors.push(`${label} contains unknown fields`);
  if (!nonEmpty(value.instanceId) || !componentIds.has(canonicalString(value.instanceId)) || !nonEmpty(value.portId)) {
    errors.push(`${label} invalid or references a missing instance`);
    return false;
  }
  return true;
}

function validateConnections(value: unknown[], componentIds: Set<string>, componentKinds: Map<string, ComponentKindId>, errors: string[]): void {
  if (duplicateIds(value, "connectionId")) errors.push("connectionId must be unique");
  const usedCables = new Set<string>();
  value.forEach((connection, index) => {
    if (!isRecord(connection)) { errors.push(`connections.${index} invalid or references a missing instance`); return; }
    if (!nonEmpty(connection.connectionId) || !["required", "planned", "satisfied", "blocked"].includes(String(connection.status))) errors.push(`connections.${index} invalid or references a missing instance`);
    if (hasUnknownFields(connection, ["connectionId", "from", "to", "cableInstanceId", "status"])) errors.push(`connections.${index} contains unknown fields`);
    const from = connection.from;
    const to = connection.to;
    const fromValid = validateEndpoint(from, componentIds, `connections.${index}.from`, errors);
    const toValid = validateEndpoint(to, componentIds, `connections.${index}.to`, errors);
    if (fromValid && toValid
      && canonicalString(from.instanceId as string) === canonicalString(to.instanceId as string)
      && canonicalString(from.portId as string) === canonicalString(to.portId as string)) errors.push(`connections.${index} cannot connect an endpoint to itself`);
    if (connection.cableInstanceId !== undefined) {
      if (!nonEmpty(connection.cableInstanceId) || !componentIds.has(canonicalString(connection.cableInstanceId))) errors.push(`connections.${index} invalid or references a missing instance`);
      else if (componentKinds.get(canonicalString(connection.cableInstanceId)) !== "cable") errors.push(`connections.${index}.cableInstanceId must reference a cable component`);
      else {
        const cableId = canonicalString(connection.cableInstanceId);
        if (usedCables.has(cableId)) errors.push(`connections.${index}.cableInstanceId is already assigned to another connection`);
        usedCables.add(cableId);
      }
    }
  });
}

function validateLogicalLayouts(value: unknown[], componentIds: Set<string>, componentKinds: Map<string, ComponentKindId>, errors: string[]): void {
  if (duplicateIds(value, "layoutId")) errors.push("layoutId must be unique");
  const globallyAssignedDisks = new Set<string>();
  value.forEach((layout, index) => {
    if (!isRecord(layout)) { errors.push(`logicalLayouts.${index} invalid`); return; }
    if (hasUnknownFields(layout, ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"])) errors.push(`logicalLayouts.${index} contains derived evaluation fields`);
    const bootPoolDiskIds = layout.bootPoolDiskIds;
    const vdevs = layout.vdevs;
    const spareDiskIds = layout.spareDiskIds;
    const baseValid = nonEmpty(layout.layoutId)
      && isUniqueNonEmptyStringArray(bootPoolDiskIds)
      && Array.isArray(vdevs)
      && isUniqueNonEmptyStringArray(spareDiskIds);
    if (!baseValid) { errors.push(`logicalLayouts.${index} invalid`); return; }
    // The explicit guards above establish the persisted collection shapes.
    const diskIds = [...(bootPoolDiskIds as string[]), ...(spareDiskIds as string[])];
    const vdevIds = new Set<string>();
    (vdevs as unknown[]).forEach((vdev, vdevIndex) => {
      if (!isRecord(vdev)) { errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} invalid`); return; }
      if (hasUnknownFields(vdev, ["vdevId", "topology", "diskInstanceIds"])) errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} contains unknown fields`);
      const topology = vdev.topology;
      const topologyValid = typeof topology === "string" && Object.hasOwn(VDEV_MINIMUM_DISKS, topology);
      if (!nonEmpty(vdev.vdevId) || !topologyValid || !isUniqueNonEmptyStringArray(vdev.diskInstanceIds, true)) {
        errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} invalid`);
        return;
      }
      const vdevId = canonicalString(vdev.vdevId);
      if (vdevIds.has(vdevId)) errors.push(`logicalLayouts.${index} has duplicate vdevId`);
      vdevIds.add(vdevId);
      const minimum = VDEV_MINIMUM_DISKS[topology as VdevTopology];
      if (vdev.diskInstanceIds.length < minimum) errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} topology ${topology} requires at least ${minimum} disks`);
      diskIds.push(...vdev.diskInstanceIds);
    });
    const canonicalDiskIds = diskIds.map(canonicalString);
    if (canonicalDiskIds.some((id) => !componentIds.has(id))) errors.push(`logicalLayouts.${index} references a missing disk instance`);
    if (canonicalDiskIds.some((id) => componentKinds.get(id) !== "storage_drive")) errors.push(`logicalLayouts.${index} references a non-storage-drive component`);
    if (new Set(canonicalDiskIds).size !== canonicalDiskIds.length) errors.push(`logicalLayouts.${index} assigns a disk more than once`);
    if (canonicalDiskIds.some((id) => globallyAssignedDisks.has(id))) errors.push(`logicalLayouts.${index} reuses a disk assigned by another logical layout`);
    canonicalDiskIds.forEach((id) => globallyAssignedDisks.add(id));
  });
}

function validateFirmwareTargets(value: unknown[], componentIds: Set<string>, errors: string[]): void {
  if (duplicateIds(value, "instanceId")) errors.push("firmware target instanceId must be unique");
  value.forEach((target, index) => {
    if (!isRecord(target)) { errors.push(`firmwareTargets.${index} invalid or contains current firmware state`); return; }
    if (hasUnknownFields(target, ["instanceId", "targetReleaseFactId", "requestedSettings", "source"])) errors.push(`firmwareTargets.${index} contains unknown fields`);
    if (!nonEmpty(target.instanceId) || !componentIds.has(canonicalString(target.instanceId)) || !nonEmpty(target.targetReleaseFactId)
      || !Array.isArray(target.requestedSettings) || (target.source !== "user" && target.source !== "system_requirement")) {
      errors.push(`firmwareTargets.${index} invalid or contains current firmware state`);
    }
    if (!Array.isArray(target.requestedSettings)) return;
    const settingIds = new Set<string>();
    target.requestedSettings.forEach((setting, settingIndex) => {
      if (!isRecord(setting)) { errors.push(`firmwareTargets.${index}.requestedSettings.${settingIndex} invalid`); return; }
      if (hasUnknownFields(setting, ["settingId", "desiredValue"])) errors.push(`firmwareTargets.${index}.requestedSettings.${settingIndex} contains unknown fields`);
      if (!nonEmpty(setting.settingId) || validateFirmwareSettingValue(setting.settingId, setting.desiredValue).length > 0) errors.push(`firmwareTargets.${index}.requestedSettings.${settingIndex} invalid`);
      if (nonEmpty(setting.settingId)) {
        const settingId = canonicalString(setting.settingId);
        if (settingIds.has(settingId)) errors.push(`firmwareTargets.${index} has duplicate requested settingId`);
        settingIds.add(settingId);
      }
    });
  });
}

/**
 * Total, strict validation for persisted V3 input. The function does not
 * normalize, infer defaults, resolve catalog facts, or mutate its argument.
 */
export function validateBuildConfigV3(value: unknown): string[] {
  if (!isRecord(value)) return ["build config must be an object"];
  const errors: string[] = [];
  if (containsIllFormedUnicode(value)) errors.push("build config contains ill-formed Unicode text");
  if (hasUnknownFields(value, TOP_LEVEL_FIELDS)) errors.push("build config contains derived or unknown fields");
  if (value.schemaVersion !== "3.0.0") errors.push("build config schemaVersion invalid");
  if (!nonEmpty(value.id)) errors.push("id missing");
  if (!nonEmpty(value.name)) errors.push("name missing");
  if (!isIsoUtc(value.updatedAt)) errors.push("updatedAt must be an ISO UTC timestamp");
  if (value.intent !== null) errors.push(...validateRequirementDraftField(value.intent, (input): input is MachineIntent => input === "pc" || input === "workstation" || input === "nas").map((error) => `intent: ${error}`));
  if (value.requirementSpec !== null) errors.push(...validateRequirementSpec(value.requirementSpec).map((error) => `requirementSpec: ${error}`));
  errors.push(...validateSystem(value.system));
  ARRAY_FIELDS.forEach((field) => { if (!Array.isArray(value[field])) errors.push(`${field} must be an array`); });
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== "string"))) errors.push("notes invalid");

  // Continue validating every collection that is present. A malformed sibling
  // never suppresses diagnostics for the remaining graph.
  const components = Array.isArray(value.components) ? value.components : [];
  const { ids: componentIds, kinds: componentKinds, roles: componentRoles } = validateComponents(components, errors);
  validateRoleDecisions(Array.isArray(value.roleDecisions) ? value.roleDecisions : [], componentRoles, errors);
  validatePlacements(Array.isArray(value.placements) ? value.placements : [], componentIds, errors);
  validateConnections(Array.isArray(value.connections) ? value.connections : [], componentIds, componentKinds, errors);
  validateLogicalLayouts(Array.isArray(value.logicalLayouts) ? value.logicalLayouts : [], componentIds, componentKinds, errors);
  validateFirmwareTargets(Array.isArray(value.firmwareTargets) ? value.firmwareTargets : [], componentIds, errors);
  return errors;
}

export function assertValidBuildConfigV3(value: unknown): asserts value is BuildConfigV3 {
  const errors = validateBuildConfigV3(value);
  if (errors.length) throw new TypeError(`Invalid BuildConfigV3: ${errors.join("; ")}`);
}
