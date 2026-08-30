import type { SystemProfileId } from "../contracts/registries";
import type { FirmwarePathEvaluation } from "../firmware/contracts";
import type { EvaluationDecision, MachineIntent, RequirementNode } from "../requirements/contracts";
import type { BuildConfigV3, SystemSelection } from "../topology/contracts";

export const SYSTEM_PROFILE_SCHEMA_VERSION = "system-profile-v1" as const;
export const SYSTEM_PROFILE_REGISTRY_SCHEMA_VERSION = "system-profile-registry-v1" as const;

export type SystemProfileFamily = "desktop" | "storage" | "hypervisor";
export type SystemCheckId =
  | "firmware_path"
  | "uefi"
  | "tpm"
  | "secure_boot"
  | "boot_device"
  | "display_path"
  | "network_driver"
  | "storage_driver"
  | "hba_it_mode"
  | "ecc"
  | "ipmi"
  | "boot_data_separation"
  | "disk_unique_locator";

export interface SystemProfileDefinition {
  readonly schemaVersion: typeof SYSTEM_PROFILE_SCHEMA_VERSION;
  readonly profileId: SystemProfileId;
  readonly releaseFactId: string;
  readonly label: string;
  readonly family: SystemProfileFamily;
  readonly machineIntents: readonly MachineIntent[];
  readonly helpRef: `help.system.${string}`;
  readonly alternativeProfileIds: readonly SystemProfileId[];
  readonly requiredChecks: readonly SystemCheckId[];
  readonly officialSourceRefs: readonly string[];
}

export interface SystemProfileRegistryDocument {
  readonly schemaVersion: typeof SYSTEM_PROFILE_REGISTRY_SCHEMA_VERSION;
  readonly profiles: readonly SystemProfileDefinition[];
}

export interface SystemSelectionRecommendation {
  readonly selection: SystemSelection;
  readonly reason: string;
  readonly alternativeProfileIds: readonly SystemProfileId[];
  readonly helpRef: SystemProfileDefinition["helpRef"];
}

export interface SystemCheckAuthority {
  readonly checkId: Exclude<SystemCheckId, "firmware_path">;
  readonly status: "pass" | "fail" | "unknown" | "not_applicable";
  readonly instanceIds: readonly string[];
  readonly factIds: readonly string[];
  readonly message: string;
}

export interface SystemProfileEvaluationInput {
  readonly config: BuildConfigV3;
  readonly profile: SystemProfileDefinition;
  readonly firmwareEvaluations: readonly FirmwarePathEvaluation[];
  readonly checks: readonly SystemCheckAuthority[];
}

export interface SystemProfileEvaluation {
  readonly schemaVersion: "system-profile-evaluation-v1";
  readonly profileId: SystemProfileId;
  readonly releaseFactId: string;
  readonly selectionSource: SystemSelection["source"];
  readonly verdict: "pass" | "fail" | "blocked";
  readonly decisions: readonly EvaluationDecision[];
  readonly requirements: readonly RequirementNode[];
  readonly helpRefs: readonly string[];
  readonly contentHash: string;
}

export interface SystemComparisonEntry {
  readonly profileId: SystemProfileId;
  readonly label: string;
  readonly family: SystemProfileFamily;
  readonly recommendedForIntent: boolean;
  readonly helpRef: SystemProfileDefinition["helpRef"];
  readonly facts: readonly { readonly key: string; readonly value: string; readonly sourceRefs: readonly string[] }[];
}
