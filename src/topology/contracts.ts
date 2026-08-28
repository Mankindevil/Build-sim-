import type {
  MachineIntent,
  RequirementDraftField,
  RequirementSpec,
} from "../requirements/contracts";
import type { ComponentKindId, FirmwareSettingId, SystemProfileId } from "../contracts/registries";

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

// Compatibility export for U0 callers. New code should import validation from
// `./validation` directly so contracts remain declarative.
export { assertValidBuildConfigV3, validateBuildConfigV3 } from "./validation";
