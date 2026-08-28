import { hashContent } from "../hash";
import { normalizeRequirementSpec } from "../requirements/normalize";
import type {
  BuildConfigV3,
  ComponentInstance,
  ConnectionEdge,
  FirmwareTarget,
  LogicalLayoutSelection,
  PlacementEdge,
  RoleDecision,
} from "./contracts";
import { assertValidBuildConfigV3 } from "./validation";

const CONFIG_HASH_CONTRACT = Object.freeze({ domain: "build-config", schemaVersion: "3.0.0" } as const);
const ID_NAMESPACE = /^[a-z][a-z0-9_-]{0,63}$/;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings(values: readonly string[]): string[] {
  return values.map((value) => value.normalize("NFC")).sort(compare);
}

function normalizeJsonText(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeJsonText);
  if (value !== null && typeof value === "object") {
    const normalized = new Map<string, unknown>();
    for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue;
      const key = rawKey.normalize("NFC");
      if (normalized.has(key)) throw new TypeError(`topology object keys collide after NFC normalization: ${key}`);
      normalized.set(key, normalizeJsonText(child));
    }
    return Object.fromEntries(normalized);
  }
  return value;
}

function normalizeComponent(component: ComponentInstance): ComponentInstance {
  const identity = structuredClone(component.identity);
  return {
    ...structuredClone(component),
    identity: identity.status === "resolved"
      ? { ...identity, identityClaimIds: sortedStrings(identity.identityClaimIds) }
      : {
          status: identity.status,
          userText: identity.userText,
          ...(identity.candidateIds !== undefined ? { candidateIds: sortedStrings(identity.candidateIds) } : {}),
        },
  };
}

function normalizeConnection(connection: ConnectionEdge): ConnectionEdge {
  return {
    connectionId: connection.connectionId,
    from: structuredClone(connection.from),
    to: structuredClone(connection.to),
    ...(connection.cableInstanceId !== undefined ? { cableInstanceId: connection.cableInstanceId } : {}),
    status: connection.status,
  };
}

function normalizeLayout(layout: LogicalLayoutSelection): LogicalLayoutSelection {
  return {
    ...structuredClone(layout),
    bootPoolDiskIds: sortedStrings(layout.bootPoolDiskIds),
    spareDiskIds: sortedStrings(layout.spareDiskIds),
    vdevs: layout.vdevs
      .map((vdev) => ({ ...structuredClone(vdev), diskInstanceIds: sortedStrings(vdev.diskInstanceIds) }))
      .sort((left, right) => compare(left.vdevId, right.vdevId)),
  };
}

function normalizeFirmwareTarget(target: FirmwareTarget): FirmwareTarget {
  return {
    ...structuredClone(target),
    requestedSettings: target.requestedSettings
      .map((setting) => structuredClone(setting))
      .sort((left, right) => compare(left.settingId, right.settingId)),
  };
}

/**
 * Canonical persisted order. Only governed set-like collections are sorted;
 * human-authored notes retain their order.
 */
export function normalizeBuildConfigV3(value: BuildConfigV3): BuildConfigV3 {
  assertValidBuildConfigV3(value);
  const input = normalizeJsonText(value) as BuildConfigV3;
  assertValidBuildConfigV3(input);
  const { notes: _notes, ...base } = structuredClone(input);
  const normalized: BuildConfigV3 = {
    ...base,
    intent: input.intent ? structuredClone(input.intent) : null,
    requirementSpec: input.requirementSpec ? normalizeRequirementSpec(input.requirementSpec) : null,
    system: input.system ? structuredClone(input.system) : null,
    components: input.components.map(normalizeComponent).sort((left, right) => compare(left.instanceId, right.instanceId)),
    roleDecisions: input.roleDecisions.map((item: RoleDecision) => structuredClone(item)).sort((left, right) => compare(left.roleDecisionId, right.roleDecisionId)),
    placements: input.placements.map((item: PlacementEdge) => structuredClone(item)).sort((left, right) => compare(left.placementId, right.placementId)),
    connections: input.connections.map(normalizeConnection).sort((left, right) => compare(left.connectionId, right.connectionId)),
    logicalLayouts: input.logicalLayouts.map(normalizeLayout).sort((left, right) => compare(left.layoutId, right.layoutId)),
    firmwareTargets: input.firmwareTargets.map(normalizeFirmwareTarget).sort((left, right) => compare(left.instanceId, right.instanceId)),
    ...(input.notes ? { notes: [...input.notes] } : {}),
  };
  assertValidBuildConfigV3(normalized);
  return normalized;
}

async function createStableTopologyId(namespace: string, identity: unknown): Promise<string> {
  if (!ID_NAMESPACE.test(namespace)) throw new TypeError("topology ID namespace is invalid");
  const digest = await hashContent({
    schemaVersion: "3.0.0",
    idPurpose: `topology-id:${namespace}`,
    identity,
  }, CONFIG_HASH_CONTRACT);
  return `${namespace.replaceAll("_", "-")}-${digest.slice(0, 24)}`;
}

export interface StableComponentInstanceIdInput {
  planId: string;
  kind: ComponentInstance["kind"];
  /** Stable source identity, for example a V2 field path or proposal node ID. */
  sourceKey: string;
  /** Zero-based position among repeated instances from the same source identity. */
  ordinal: number;
}

/** Deterministic 96-bit ID; source text is hashed and never embedded in the ID. */
export async function createStableComponentInstanceId(input: StableComponentInstanceIdInput): Promise<string> {
  if (!input.planId.trim() || !input.sourceKey.trim() || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new TypeError("stable component instance identity is invalid");
  }
  return createStableTopologyId(input.kind, {
    planId: input.planId.normalize("NFC"),
    kind: input.kind,
    sourceKey: input.sourceKey.normalize("NFC"),
    ordinal: input.ordinal,
  });
}

/** Stable ID for placements, connections, role decisions and logical edges. */
export async function createStableTopologyEdgeId(namespace: "placement" | "connection" | "role-decision" | "layout" | "vdev" | "firmware-target", identityParts: readonly string[]): Promise<string> {
  if (!identityParts.length || identityParts.some((part) => !part.trim())) throw new TypeError("stable topology edge identity is invalid");
  // Edge identity parts are positional (from/to, owner/mount, parent/child),
  // not a set. Preserve their order while normalizing Unicode.
  return createStableTopologyId(namespace, identityParts.map((part) => part.normalize("NFC")));
}
