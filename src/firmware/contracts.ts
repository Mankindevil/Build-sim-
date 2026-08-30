import type { FirmwareUpgradeMethod, FirmwareVersionIdentificationMethod, FirmwareCapability } from "../capabilities/firmware";
import type { FirmwareSettingId } from "../contracts/registries";
import type { RequirementNode } from "../requirements/contracts";
import type {
  AllocatableRequirementSupply,
  RequirementAllocationOptions,
  RequirementAllocationResult,
} from "../requirements/allocation";

export interface FirmwareCurrentReleaseObservation {
  observationId: string;
  releaseFactId: string;
  method: FirmwareVersionIdentificationMethod;
  evidenceRefs: string[];
}

export interface FirmwarePreflightAvailability {
  /**
   * A true value is only an observation hint. For an executable working-CPU
   * path it must also have the matching canonical temporary-hardware
   * requirement in availableRequirementIds, which graph replay binds to a
   * satisfied RequirementSatisfaction.
   */
  workingCpuAvailable: boolean | null;
  workingMemoryAvailable: boolean | null;
  displayPathAvailable: boolean | null;
}

export interface FirmwareTransitionTemporaryHardwareRequirements {
  transitionId: string;
  requirementIds: string[];
}

export interface FirmwareRequestedSetting {
  settingId: FirmwareSettingId;
  desiredValue: string;
  evidenceRefs: string[];
}

export interface FirmwarePathEvaluationInput {
  capability: FirmwareCapability;
  instanceId: string;
  currentObservation?: FirmwareCurrentReleaseObservation | null;
  cpuSkuId?: string | null;
  targetReleaseFactId?: string | null;
  availableRequirementIds?: ReadonlySet<string> | readonly string[];
  availableFactIds?: ReadonlySet<string> | readonly string[];
  preflight?: Partial<FirmwarePreflightAvailability>;
  transitionTemporaryHardwareRequirements?: readonly FirmwareTransitionTemporaryHardwareRequirements[];
  requestedSettings?: readonly FirmwareRequestedSetting[];
  requireRecovery?: boolean;
}

/** Canonical replay input consumed by the JS-safe path evaluator. */
export interface NormalizedFirmwarePathEvaluationInput {
  capability: FirmwareCapability;
  instanceId: string;
  currentObservation: FirmwareCurrentReleaseObservation | null;
  cpuSkuId: string | null;
  targetReleaseFactId: string | null;
  availableRequirementIds: string[];
  availableFactIds: string[];
  preflight: FirmwarePreflightAvailability;
  transitionTemporaryHardwareRequirements: FirmwareTransitionTemporaryHardwareRequirements[];
  requestedSettings: FirmwareRequestedSetting[];
  requireRecovery: boolean;
}

export interface FirmwareCapabilityEvaluationRef {
  subjectSkuId: string;
  subjectRevision: string;
  region: string;
  contentHash: string;
  factSnapshotRef: FirmwareCapability["factSnapshotRef"];
}

export interface FirmwareSelectedTransition {
  transitionId: string;
  fromReleaseFactId: string;
  toReleaseFactId: string;
  purpose: "upgrade" | "rollback" | "recovery";
  method: FirmwareUpgradeMethod;
  requiresWorkingCpu: boolean;
  requirementIds: string[];
  temporaryHardwareRequirementIds: string[];
  missingRequirementIds: string[];
  firmwareFileFactId: string;
  mediaFormat: "fat32" | "vendor_tool" | "os_managed";
  requiredFilename: string;
  checksumFactId: string;
  powerPrerequisiteFactIds: string[];
  missingPowerPrerequisiteFactIds: string[];
  recoveryTransitionIds: string[];
  resetsSettings: boolean;
  releaseFactIds: string[];
  sourceFactIds: string[];
}

export interface FirmwarePathSearchAuthority {
  requestedTargetReleaseFactId: string | null;
  availableRequirementIds: string[];
  availableFactIds: string[];
  preflight: FirmwarePreflightAvailability;
  transitionTemporaryHardwareRequirements: FirmwareTransitionTemporaryHardwareRequirements[];
  requestedSettings: FirmwareRequestedSetting[];
  requireRecovery: boolean;
}

export type FirmwarePathReason =
  | "already_at_target"
  | "path_available"
  | "requirements_missing"
  | "recovery_unavailable"
  | "cpu_support_unknown"
  | "target_release_unknown"
  | "target_does_not_support_cpu"
  | "current_release_observation_missing"
  | "current_release_observation_method_invalid"
  | "current_release_unknown"
  | "no_directed_path";

export interface FirmwareRecoveryEvaluation {
  status: "not_required" | "available" | "blocked" | "unavailable";
  transitionIds: string[];
  missingRequirementIds: string[];
  missingPowerPrerequisiteFactIds: string[];
}

export interface FirmwarePathEvaluation {
  schemaVersion: "firmware-path-evaluation-v1";
  instanceId: string;
  capabilityRef: FirmwareCapabilityEvaluationRef;
  currentObservation: FirmwareCurrentReleaseObservation | null;
  cpuSkuId: string | null;
  minimumReleaseFactId: string | null;
  targetReleaseFactId: string | null;
  searchAuthority: FirmwarePathSearchAuthority;
  verdict: "pass" | "blocked";
  reason: FirmwarePathReason;
  selectedTransitions: FirmwareSelectedTransition[];
  bridgeReleaseFactIds: string[];
  missingRequirementIds: string[];
  missingPowerPrerequisiteFactIds: string[];
  derivedRequirements: RequirementNode[];
  settingsReset: boolean;
  recovery: FirmwareRecoveryEvaluation;
  pathAlternativesExamined: number;
  searchTruncated: boolean;
  assumptions: string[];
  contentHash: string;
}

export interface FirmwareRequirementFixedPointInput {
  /** Path input without caller-authored availableRequirementIds authority. */
  baseInput: FirmwarePathEvaluationInput;
  rootRequirements: readonly RequirementNode[];
  supplies: readonly AllocatableRequirementSupply[];
  allocationOptions?: RequirementAllocationOptions;
  /** Complete global route-combination budget; exceeding it fails closed. */
  maxIterations?: number;
}

/** Ephemeral composition result; evaluation and allocation remain the persisted authorities. */
export interface FirmwareRequirementFixedPointResult {
  evaluation: FirmwarePathEvaluation;
  requirementAllocation: RequirementAllocationResult;
  candidateRequirements: RequirementNode[];
  availableRequirementIds: string[];
  iterations: number;
  reachedFixedPoint: true;
}

export interface FirmwareRequirementBatchFixedPointInput {
  /** One input per firmware target; instanceId values must be unique. */
  baseInputs: readonly FirmwarePathEvaluationInput[];
  rootRequirements: readonly RequirementNode[];
  supplies: readonly AllocatableRequirementSupply[];
  allocationOptions?: RequirementAllocationOptions;
  /** Complete global route-combination budget; exceeding it fails closed. */
  maxIterations?: number;
}

export interface FirmwareRequirementAvailability {
  instanceId: string;
  requirementIds: string[];
}

export interface FirmwareRequirementBatchFixedPointResult {
  evaluations: FirmwarePathEvaluation[];
  requirementAllocation: RequirementAllocationResult;
  candidateRequirements: RequirementNode[];
  availabilityByInstance: FirmwareRequirementAvailability[];
  iterations: number;
  reachedFixedPoint: true;
}
