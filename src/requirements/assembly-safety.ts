import type { GovernedFacetPredicate } from "../contracts/registries";
import type { EvaluationDecision, RequirementKind, RequirementNode } from "./contracts";
import type { AllocatableRequirementSupply } from "./allocation";
import {
  assemblySafetyReferencesRuntime as assemblySafetyReferencesPureRuntime,
  evaluateAssemblySafetyRuntime as evaluateAssemblySafetyPureRuntime,
  projectVerifiedAssemblySuppliesRuntime as projectVerifiedAssemblySuppliesPureRuntime,
  validateRequirementAllocationGeneratedSupplyClosureRuntime as validateRequirementAllocationGeneratedSupplyClosurePureRuntime,
  validateAssemblySafetyEvaluationRuntime as validateAssemblySafetyEvaluationPureRuntime,
  validateAssemblySafetyInput as validateAssemblySafetyInputPureRuntime,
} from "./assembly-safety-runtime.mjs";

export { assemblyResourceAssertionHashRuntime } from "./assembly-safety-runtime.mjs";
export { assemblyCheckAssertionHashRuntime } from "./assembly-safety-runtime.mjs";

export type VerifiedResourceState = "present_verified" | "absent_verified" | "mismatch_verified" | "unknown";
export type VerifiedConnectionState = "connected_verified" | "disconnected_verified" | "wrong_connector_verified" | "unknown";

interface AssemblyCheckAuthority {
  checkId: string;
  /** Target/owning instance used to prevent cross-build observation allocation. */
  ownerInstanceId: string;
  instanceIds: string[];
  factIds: string[];
  observationIds: string[];
}

/** A physical item which must later be quantity-allocated from package/user supply. */
export interface AssemblyResourceSafetyCheck extends AssemblyCheckAuthority {
  checkType: "resource";
  /** Stable inventory/action identity bound into its observation assertion. */
  resourceId: string;
  role: "motherboard_screw" | "cooler_backplate" | "cooler_retention" | "thermal_material" | "tool"
    | "temporary_component" | "firmware_medium" | "firmware_action" | "other";
  kind: Extract<RequirementKind,
    "component" | "accessory" | "fastener" | "cable" | "consumable" | "tool" | "firmware_action">;
  predicates: GovernedFacetPredicate[];
  quantity: number;
  criticality: RequirementNode["criticality"];
  requiredBefore: NonNullable<RequirementNode["requiredBefore"]>;
  state: VerifiedResourceState;
}

export interface ObservedStandoff {
  positionId: string;
  thread: string;
  heightMm: number;
}

/** Expected positions are authority; observed=null is unknown, never an empty/safe layout. */
export interface AssemblyStandoffSafetyCheck extends AssemblyCheckAuthority {
  checkType: "standoff_layout";
  expectedPositionIds: string[];
  expectedThread: string;
  expectedHeightMm: number;
  heightToleranceMm: number;
  observed: ObservedStandoff[] | null;
}

export type AssemblyConnectionKind = "atx24" | "eps" | "gpu_power" | "cpu_fan" | "pump";

export interface AssemblyConnectionSafetyCheck extends AssemblyCheckAuthority {
  checkType: "connection";
  connectionKind: AssemblyConnectionKind;
  connectorStandard: string;
  state: VerifiedConnectionState;
}

export interface AssemblyHighPowerSafetyCheck extends AssemblyCheckAuthority {
  checkType: "12v2x6";
  connectorStandard: "12v2x6";
  state: VerifiedConnectionState;
  fullySeated: boolean | null;
  bendDistanceMm: number | null;
  minimumBendDistanceMm: number;
}

export interface AssemblyProtectiveFilmSafetyCheck extends AssemblyCheckAuthority {
  checkType: "protective_film";
  state: "removed_verified" | "present_verified" | "unknown";
}

export interface AssemblyLooseMetalSafetyCheck extends AssemblyCheckAuthority {
  checkType: "loose_metal";
  state: "clear_verified" | "found_verified" | "unknown";
}

export type AssemblySafetyCheck =
  | AssemblyResourceSafetyCheck
  | AssemblyStandoffSafetyCheck
  | AssemblyConnectionSafetyCheck
  | AssemblyHighPowerSafetyCheck
  | AssemblyProtectiveFilmSafetyCheck
  | AssemblyLooseMetalSafetyCheck;

export interface AssemblySafetyInput {
  assemblyId: string;
  checks: readonly AssemblySafetyCheck[];
}

export interface AssemblySafetyEvaluation {
  schemaVersion: "assembly-safety-evaluation-v1";
  assemblyId: string;
  checks: AssemblySafetyCheck[];
  decisions: EvaluationDecision[];
  requirements: RequirementNode[];
  contentHash: string;
}

export function evaluateAssemblySafety(input: AssemblySafetyInput): AssemblySafetyEvaluation {
  const errors = validateAssemblySafetyInputPureRuntime(input);
  if (errors.length) throw new TypeError(`Invalid assembly safety input: ${errors.join("; ")}`);
  return evaluateAssemblySafetyPureRuntime(input) as AssemblySafetyEvaluation;
}

export function validateAssemblySafetyInput(value: unknown): string[] {
  return validateAssemblySafetyInputPureRuntime(value);
}

/** Strict total replay validator; checksum-correct semantic mutations still fail. */
export function validateAssemblySafetyEvaluationRuntime(value: unknown): string[] {
  return validateAssemblySafetyEvaluationPureRuntime(value);
}

export function assemblySafetyReferencesRuntime(value: unknown): {
  instanceIds: readonly string[];
  factIds: readonly string[];
  observationIds: readonly string[];
  requirementIds: readonly string[];
} | null {
  return assemblySafetyReferencesPureRuntime(value);
}

/** Only strict-replayed pass observations become plan-scoped present supplies. */
export function projectVerifiedAssemblySupplies(
  value: AssemblySafetyEvaluation,
): readonly AllocatableRequirementSupply[] {
  const projected = projectVerifiedAssemblySuppliesPureRuntime(value);
  if (projected === null) throw new TypeError("assembly safety evaluation is invalid or cannot project verified supplies");
  return projected as readonly AllocatableRequirementSupply[];
}

export function validateRequirementAllocationGeneratedSupplyClosureRuntime(
  value: unknown,
  context: { packageBindings: readonly unknown[]; assemblyEvaluations: readonly unknown[] },
): string[] {
  return validateRequirementAllocationGeneratedSupplyClosurePureRuntime(value, context);
}
