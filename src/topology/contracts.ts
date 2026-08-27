import type {
  MachineIntent,
  RequirementDraftField,
  RequirementSpec,
} from "../requirements/contracts";
import { validateRequirementDraftField, validateRequirementSpec } from "../requirements/contracts";
import {
  isComponentKindId,
  isSystemProfileId,
  validateFirmwareSettingValue,
  type ComponentKindId,
  type FirmwareSettingId,
  type SystemProfileId,
} from "../contracts/registries";

export interface ComponentInstance {
  instanceId: string;
  kind: ComponentKindId;
  role: string;
  state: "planned" | "ordered";
  identity:
    | { status: "unresolved"; userText: string; candidateIds?: string[] }
    | { status: "resolved"; skuId: string; identityClaimIds: string[] };
  source: "user" | "agent" | "migration";
}

export interface RoleDecision {
  roleDecisionId: string;
  role: string;
  decision: "not_needed";
  source: "user" | "migration";
  confirmedAt: string;
}

export interface SystemSelection {
  profileId: SystemProfileId;
  versionFactId: string;
  source: "defaulted" | "user";
  lockedByUser: boolean;
}

export interface FirmwareTarget {
  instanceId: string;
  targetReleaseFactId: string;
  requestedSettings: Array<{ settingId: FirmwareSettingId; desiredValue: string }>;
  source: "user" | "system_requirement";
}

export type VdevTopology = "mirror" | "raidz1" | "raidz2" | "raidz3" | "stripe";

export interface LogicalLayoutSelection {
  layoutId: string;
  bootPoolDiskIds: string[];
  vdevs: Array<{ vdevId: string; topology: VdevTopology; diskInstanceIds: string[] }>;
  spareDiskIds: string[];
}

export interface PlacementEdge {
  placementId: string;
  componentInstanceId: string;
  mountOwnerInstanceId: string;
  mountId: string;
}

export interface ConnectionEndpoint {
  instanceId: string;
  portId: string;
}

export interface ConnectionEdge {
  connectionId: string;
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  cableInstanceId?: string;
  status: "required" | "planned" | "satisfied" | "blocked";
}

/** Canonical installed/planned instance topology. It contains no derived evaluation objects. */
export interface BuildConfigV3 {
  schemaVersion: "3.0.0";
  id: string;
  name: string;
  updatedAt: string;
  intent: RequirementDraftField<MachineIntent> | null;
  requirementSpec: RequirementSpec | null;
  system: SystemSelection | null;
  components: ComponentInstance[];
  roleDecisions: RoleDecision[];
  placements: PlacementEdge[];
  connections: ConnectionEdge[];
  logicalLayouts: LogicalLayoutSelection[];
  firmwareTargets: FirmwareTarget[];
  notes?: string[];
}

const TOP_LEVEL_FIELDS = [
  "schemaVersion", "id", "name", "updatedAt", "intent", "requirementSpec", "system",
  "components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets", "notes",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function duplicateIds(records: readonly unknown[], field: string): boolean {
  const values = records.filter(isRecord).map((record) => record[field]).filter(nonEmpty);
  return new Set(values).size !== values.length;
}

function hasUnknownFields(record: Record<string, unknown>, allowedFields: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowedFields.includes(key));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}

function hasDuplicateStrings(value: readonly string[]): boolean {
  return new Set(value).size !== value.length;
}

export function createEmptyBuildConfigV3(id: string, name: string, updatedAt: string): BuildConfigV3 {
  return {
    schemaVersion: "3.0.0",
    id,
    name,
    updatedAt,
    intent: null,
    requirementSpec: null,
    system: null,
    components: [],
    roleDecisions: [],
    placements: [],
    connections: [],
    logicalLayouts: [],
    firmwareTargets: [],
  };
}

/** Strict contract validator; unknown fields prevent derived objects masquerading as config. */
export function validateBuildConfigV3(value: unknown): string[] {
  if (!isRecord(value)) return ["build config must be an object"];
  const errors: string[] = [];
  if (Object.keys(value).some((key) => !(TOP_LEVEL_FIELDS as readonly string[]).includes(key))) errors.push("build config contains derived or unknown fields");
  if (value.schemaVersion !== "3.0.0") errors.push("build config schemaVersion invalid");
  for (const field of ["id", "name", "updatedAt"] as const) if (!nonEmpty(value[field])) errors.push(`${field} missing`);
  if (value.intent !== null) errors.push(...validateRequirementDraftField(value.intent, (input): input is MachineIntent => input === "pc" || input === "workstation" || input === "nas").map((error) => `intent: ${error}`));
  if (value.requirementSpec !== null) errors.push(...validateRequirementSpec(value.requirementSpec).map((error) => `requirementSpec: ${error}`));
  if (value.system !== null) {
    if (!isRecord(value.system) || !isSystemProfileId(value.system.profileId) || !nonEmpty(value.system.versionFactId)
      || (value.system.source !== "defaulted" && value.system.source !== "user") || typeof value.system.lockedByUser !== "boolean") errors.push("system selection invalid");
    else if (hasUnknownFields(value.system, ["profileId", "versionFactId", "source", "lockedByUser"])) errors.push("system selection contains unknown fields");
  }
  const arrayFields = ["components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets"] as const;
  for (const field of arrayFields) if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
  if (errors.some((error) => error.endsWith("must be an array"))) return errors;

  const components = value.components as unknown[];
  const componentIds = new Set<string>();
  const componentKindById = new Map<string, ComponentKindId>();
  if (duplicateIds(components, "instanceId")) errors.push("component instanceId must be unique");
  for (const [index, component] of components.entries()) {
    if (!isRecord(component)) { errors.push(`components.${index} invalid`); continue; }
    if (hasUnknownFields(component, ["instanceId", "kind", "role", "state", "identity", "source"])) errors.push(`components.${index} contains unknown fields`);
    if (nonEmpty(component.instanceId)) componentIds.add(component.instanceId);
    if (!nonEmpty(component.instanceId) || !isComponentKindId(component.kind) || !nonEmpty(component.role)) errors.push(`components.${index} identity fields missing or kind is not registered`);
    else componentKindById.set(component.instanceId, component.kind);
    if (component.state !== "planned" && component.state !== "ordered") errors.push(`components.${index}.state invalid`);
    if (component.source !== "user" && component.source !== "agent" && component.source !== "migration") errors.push(`components.${index}.source invalid`);
    if (!isRecord(component.identity)) errors.push(`components.${index}.identity invalid`);
    else if (component.identity.status === "unresolved") {
      if (!nonEmpty(component.identity.userText)) errors.push(`components.${index}.identity.userText missing`);
      if (hasUnknownFields(component.identity, ["status", "userText", "candidateIds"])) errors.push(`components.${index}.identity contains unknown fields`);
      if (component.identity.candidateIds !== undefined && (!isNonEmptyStringArray(component.identity.candidateIds) || hasDuplicateStrings(component.identity.candidateIds))) errors.push(`components.${index}.identity.candidateIds invalid`);
    } else if (component.identity.status === "resolved") {
      if (!nonEmpty(component.identity.skuId) || !isNonEmptyStringArray(component.identity.identityClaimIds) || component.identity.identityClaimIds.length === 0 || hasDuplicateStrings(component.identity.identityClaimIds)) errors.push(`components.${index} resolved identity requires unique skuId and identity claims`);
      if (hasUnknownFields(component.identity, ["status", "skuId", "identityClaimIds"])) errors.push(`components.${index}.identity contains unknown fields`);
    } else errors.push(`components.${index}.identity.status invalid`);
  }

  const roleDecisions = value.roleDecisions as unknown[];
  if (duplicateIds(roleDecisions, "roleDecisionId")) errors.push("roleDecisionId must be unique");
  for (const [index, decision] of roleDecisions.entries()) {
    if (!isRecord(decision) || !nonEmpty(decision.roleDecisionId) || !nonEmpty(decision.role) || decision.decision !== "not_needed"
      || (decision.source !== "user" && decision.source !== "migration") || !nonEmpty(decision.confirmedAt)) errors.push(`roleDecisions.${index} invalid`);
    if (isRecord(decision) && hasUnknownFields(decision, ["roleDecisionId", "role", "decision", "source", "confirmedAt"])) errors.push(`roleDecisions.${index} contains unknown fields`);
    if (isRecord(decision) && components.some((component) => isRecord(component) && component.role === decision.role)) errors.push(`roleDecisions.${index} conflicts with an existing component role`);
  }

  const placements = value.placements as unknown[];
  if (duplicateIds(placements, "placementId")) errors.push("placementId must be unique");
  for (const [index, placement] of placements.entries()) {
    if (!isRecord(placement) || !nonEmpty(placement.placementId) || !componentIds.has(String(placement.componentInstanceId))
      || !componentIds.has(String(placement.mountOwnerInstanceId)) || !nonEmpty(placement.mountId)) errors.push(`placements.${index} invalid or references a missing instance`);
    if (isRecord(placement) && hasUnknownFields(placement, ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"])) errors.push(`placements.${index} contains unknown fields`);
  }

  const connections = value.connections as unknown[];
  if (duplicateIds(connections, "connectionId")) errors.push("connectionId must be unique");
  for (const [index, connection] of connections.entries()) {
    if (!isRecord(connection) || !nonEmpty(connection.connectionId) || !isRecord(connection.from) || !isRecord(connection.to)
      || !componentIds.has(String(connection.from.instanceId)) || !componentIds.has(String(connection.to.instanceId))
      || !nonEmpty(connection.from.portId) || !nonEmpty(connection.to.portId)
      || (connection.cableInstanceId !== undefined && !componentIds.has(String(connection.cableInstanceId)))
      || !["required", "planned", "satisfied", "blocked"].includes(String(connection.status))) errors.push(`connections.${index} invalid or references a missing instance`);
    if (isRecord(connection) && hasUnknownFields(connection, ["connectionId", "from", "to", "cableInstanceId", "status"])) errors.push(`connections.${index} contains unknown fields`);
    if (isRecord(connection) && isRecord(connection.from) && hasUnknownFields(connection.from, ["instanceId", "portId"])) errors.push(`connections.${index}.from contains unknown fields`);
    if (isRecord(connection) && isRecord(connection.to) && hasUnknownFields(connection.to, ["instanceId", "portId"])) errors.push(`connections.${index}.to contains unknown fields`);
    if (isRecord(connection) && connection.cableInstanceId !== undefined
      && componentKindById.get(String(connection.cableInstanceId)) !== "cable") errors.push(`connections.${index}.cableInstanceId must reference a cable component`);
  }

  const layouts = value.logicalLayouts as unknown[];
  const assignedDiskIds = new Set<string>();
  if (duplicateIds(layouts, "layoutId")) errors.push("layoutId must be unique");
  for (const [index, layout] of layouts.entries()) {
    if (!isRecord(layout) || !nonEmpty(layout.layoutId) || !Array.isArray(layout.bootPoolDiskIds) || !Array.isArray(layout.vdevs) || !Array.isArray(layout.spareDiskIds)) {
      errors.push(`logicalLayouts.${index} invalid`); continue;
    }
    if (!isNonEmptyStringArray(layout.bootPoolDiskIds) || !isNonEmptyStringArray(layout.spareDiskIds)) errors.push(`logicalLayouts.${index} disk ID lists invalid`);
    const diskIds = [...layout.bootPoolDiskIds, ...layout.spareDiskIds, ...layout.vdevs.flatMap((vdev) => isRecord(vdev) && Array.isArray(vdev.diskInstanceIds) ? vdev.diskInstanceIds : [])];
    const vdevIds: string[] = [];
    for (const [vdevIndex, vdev] of layout.vdevs.entries()) {
      if (!isRecord(vdev) || !nonEmpty(vdev.vdevId) || !["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(String(vdev.topology)) || !isNonEmptyStringArray(vdev.diskInstanceIds) || vdev.diskInstanceIds.length === 0 || hasDuplicateStrings(vdev.diskInstanceIds)) errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} invalid`);
      else {
        vdevIds.push(vdev.vdevId);
        if (hasUnknownFields(vdev, ["vdevId", "topology", "diskInstanceIds"])) errors.push(`logicalLayouts.${index}.vdevs.${vdevIndex} contains unknown fields`);
      }
    }
    if (new Set(vdevIds).size !== vdevIds.length) errors.push(`logicalLayouts.${index} has duplicate vdevId`);
    if (diskIds.some((id) => !componentIds.has(String(id)))) errors.push(`logicalLayouts.${index} references a missing disk instance`);
    if (diskIds.some((id) => componentKindById.get(String(id)) !== "storage_drive")) errors.push(`logicalLayouts.${index} references a non-storage-drive component`);
    if (new Set(diskIds.map(String)).size !== diskIds.length) errors.push(`logicalLayouts.${index} assigns a disk more than once`);
    if (diskIds.some((id) => assignedDiskIds.has(String(id)))) errors.push(`logicalLayouts.${index} reuses a disk assigned by another logical layout`);
    diskIds.forEach((id) => assignedDiskIds.add(String(id)));
    if (Object.keys(layout).some((key) => !["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"].includes(key))) errors.push(`logicalLayouts.${index} contains derived evaluation fields`);
  }

  const firmwareTargets = value.firmwareTargets as unknown[];
  if (duplicateIds(firmwareTargets, "instanceId")) errors.push("firmware target instanceId must be unique");
  for (const [index, target] of firmwareTargets.entries()) {
    if (!isRecord(target) || !componentIds.has(String(target.instanceId)) || !nonEmpty(target.targetReleaseFactId)
      || !Array.isArray(target.requestedSettings) || (target.source !== "user" && target.source !== "system_requirement")
      || "currentVersionObservationId" in target) errors.push(`firmwareTargets.${index} invalid or contains current firmware state`);
    if (!isRecord(target)) continue;
    if (hasUnknownFields(target, ["instanceId", "targetReleaseFactId", "requestedSettings", "source"])) errors.push(`firmwareTargets.${index} contains unknown fields`);
    if (Array.isArray(target.requestedSettings)) {
      const settingIds: string[] = [];
      for (const [settingIndex, setting] of target.requestedSettings.entries()) {
        if (!isRecord(setting) || !nonEmpty(setting.settingId)
          || validateFirmwareSettingValue(setting.settingId, setting.desiredValue).length > 0) {
          errors.push(`firmwareTargets.${index}.requestedSettings.${settingIndex} invalid`);
          continue;
        }
        settingIds.push(setting.settingId);
        if (hasUnknownFields(setting, ["settingId", "desiredValue"])) errors.push(`firmwareTargets.${index}.requestedSettings.${settingIndex} contains unknown fields`);
      }
      if (hasDuplicateStrings(settingIds)) errors.push(`firmwareTargets.${index} has duplicate requested settingId`);
    }
  }
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== "string"))) errors.push("notes invalid");
  return errors;
}
