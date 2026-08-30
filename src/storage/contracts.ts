import { isSha256Hex } from "../hash";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";
import { canProjectUserObservation, type UserObservation } from "../observations/contracts";
import type { EvaluationDecision, FacetPredicate } from "../requirements/contracts";
import { validateDestructiveActionPlanShapeRuntime } from "./destructive-action-runtime.mjs";
export type { LogicalLayoutSelection } from "../topology/contracts";

export interface StorageLayoutEvaluation {
  layoutSelectionHash: string;
  systemProfileId: string;
  usableBytes: { min: number; max: number };
  vdevResults: Array<{
    vdevId: string;
    estimatedUsableBytes: { min: number; max: number };
    faultTolerance: { diskFailures: number; conditions: string[] };
    diskInstanceIds?: string[];
    mixedCapacityLossBytes?: number;
    controllerPaths?: Array<{ diskInstanceId: string; controllerInstanceId: string; controllerPortId: string; transport: string }>;
    resilverRisks?: string[];
  }>;
  hbaAndPathDecisionIds: string[];
  expansionOptions: Array<{
    optionId: string;
    operation: "add_vdev" | "replace_drives" | "add_spare";
    requiredInstanceCount: number;
    constraints: FacetPredicate[];
    riskDecisionIds: string[];
  }>;
  decisions: EvaluationDecision[];
  assumptions: string[];
  spareDiskIds?: string[];
  helpRefs?: string[];
}

export type DestructiveActionPlan =
  | {
      actionId: string;
      diskInstanceIds: string[];
      locatorObservationIds: string[];
      inputPlanId: string;
      inputPlanVersionId: string;
      inputConfigHash: string;
      inputPlanRevisionHash: string;
      inputProcedureSafetyHash: string;
      confirmation: "required";
      confirmationAt?: never;
    }
  | {
      actionId: string;
      diskInstanceIds: string[];
      locatorObservationIds: string[];
      inputPlanId: string;
      inputPlanVersionId: string;
      inputConfigHash: string;
      inputPlanRevisionHash: string;
      inputProcedureSafetyHash: string;
      confirmation: "confirmed";
      confirmationAt: string;
    };

export interface DestructiveActionValidationContext {
  currentPlanId: string;
  currentPlanVersionId: string;
  currentConfigHash: string;
  currentPlanRevisionHash: string;
  currentProcedureSafetyHash: string;
  diskRevisionHashes: Readonly<Record<string, string>>;
  diskLocatorObservations: ReadonlyMap<string, UserObservation>;
}

const SELECTION_FIELDS = ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLogicalLayoutSelection(value: unknown): string[] {
  if (!isRecord(value)) return ["layout selection must be an object"];
  const errors: string[] = [];
  if (Object.keys(value).some((key) => !SELECTION_FIELDS.includes(key))) errors.push("layout selection contains derived evaluation fields");
  if (typeof value.layoutId !== "string" || value.layoutId.length === 0) errors.push("layoutId missing");
  if (!Array.isArray(value.bootPoolDiskIds) || !Array.isArray(value.spareDiskIds) || !Array.isArray(value.vdevs)) return [...errors, "layout disk collections invalid"];
  const vdevIds: string[] = [];
  const allDiskIds = [...value.bootPoolDiskIds, ...value.spareDiskIds];
  for (const [index, vdev] of value.vdevs.entries()) {
    if (!isRecord(vdev) || typeof vdev.vdevId !== "string" || !["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(String(vdev.topology)) || !Array.isArray(vdev.diskInstanceIds)) {
      errors.push(`vdevs.${index} invalid`); continue;
    }
    if (Object.keys(vdev).some((key) => !["vdevId", "topology", "diskInstanceIds"].includes(key))) errors.push(`vdevs.${index} contains derived or unknown fields`);
    vdevIds.push(vdev.vdevId);
    allDiskIds.push(...vdev.diskInstanceIds);
  }
  if (new Set(vdevIds).size !== vdevIds.length) errors.push("vdevId must be unique");
  if (allDiskIds.some((id) => typeof id !== "string" || id.length === 0)) errors.push("disk instance IDs invalid");
  if (new Set(allDiskIds).size !== allDiskIds.length) errors.push("one disk cannot occupy multiple layout roles");
  return errors;
}

export function validateStorageLayoutEvaluation(value: StorageLayoutEvaluation): string[] {
  const errors: string[] = [];
  if (!isSha256Hex(value.layoutSelectionHash) || !value.systemProfileId) errors.push("storage evaluation identity/hash invalid");
  if (![value.usableBytes.min, value.usableBytes.max].every(Number.isFinite) || value.usableBytes.min < 0 || value.usableBytes.max < value.usableBytes.min) errors.push("usableBytes interval invalid");
  if (value.vdevResults.some((result) => !result.vdevId || ![result.estimatedUsableBytes.min, result.estimatedUsableBytes.max].every(Number.isFinite) || result.estimatedUsableBytes.min < 0 || result.estimatedUsableBytes.max < result.estimatedUsableBytes.min || !Number.isInteger(result.faultTolerance.diskFailures) || result.faultTolerance.diskFailures < 0 || result.faultTolerance.conditions.length === 0)) errors.push("vdev result interval/fault tolerance invalid");
  if (value.vdevResults.some((result) => result.diskInstanceIds !== undefined && (new Set(result.diskInstanceIds).size !== result.diskInstanceIds.length || result.diskInstanceIds.some((id) => !id)))) errors.push("vdev disk instance IDs invalid");
  if (value.vdevResults.some((result) => result.mixedCapacityLossBytes !== undefined && (!Number.isFinite(result.mixedCapacityLossBytes) || result.mixedCapacityLossBytes < 0))) errors.push("vdev mixed-capacity loss invalid");
  if (value.vdevResults.some((result) => result.controllerPaths !== undefined && (new Set(result.controllerPaths.map((path) => `${path.controllerInstanceId}:${path.controllerPortId}`)).size !== result.controllerPaths.length || result.controllerPaths.some((path) => !path.diskInstanceId || !path.controllerInstanceId || !path.controllerPortId || !path.transport)))) errors.push("vdev controller paths invalid");
  if (value.vdevResults.some((result) => result.resilverRisks !== undefined && (result.resilverRisks.length === 0 || result.resilverRisks.some((risk) => !risk)))) errors.push("vdev resilver risks invalid");
  if (new Set(value.vdevResults.map((result) => result.vdevId)).size !== value.vdevResults.length) errors.push("storage evaluation vdevId must be unique");
  if (new Set(value.hbaAndPathDecisionIds).size !== value.hbaAndPathDecisionIds.length || value.hbaAndPathDecisionIds.some((id) => !id)) errors.push("HBA/path decision IDs invalid");
  if (value.expansionOptions.some((option) => !option.optionId || !Number.isInteger(option.requiredInstanceCount) || option.requiredInstanceCount <= 0 || option.riskDecisionIds.length === 0)) errors.push("expansion option requirements/risks invalid");
  if (new Set(value.expansionOptions.map((option) => option.optionId)).size !== value.expansionOptions.length) errors.push("expansion optionId must be unique");
  if (value.decisions.some((decision) => decision.domain !== "storage")) errors.push("storage evaluation may only contain storage decisions");
  if (new Set(value.decisions.map((decision) => decision.decisionId)).size !== value.decisions.length) errors.push("storage decisionId must be unique");
  if (value.spareDiskIds !== undefined && (new Set(value.spareDiskIds).size !== value.spareDiskIds.length || value.spareDiskIds.some((id) => !id))) errors.push("spare disk IDs invalid");
  if (value.helpRefs !== undefined && (new Set(value.helpRefs).size !== value.helpRefs.length || value.helpRefs.some((ref) => !ref.startsWith("help.storage.")))) errors.push("storage help refs invalid");
  return errors;
}

/** Confirmation is valid only for the exact safety hash and one unique locator per disk. */
export function validateDestructiveActionPlanShape(value: unknown): string[] {
  return validateDestructiveActionPlanShapeRuntime(value);
}

export function validateDestructiveActionPlan(value: unknown, context?: DestructiveActionValidationContext): string[] {
  const errors = validateDestructiveActionPlanShape(value);
  if (!isRecord(value)) return errors;
  const plan = value as unknown as DestructiveActionPlan;
  if (!context) return [...errors, "destructive action requires current plan/config/revision and disk locator context"];
  if (!isSha256Hex(context.currentConfigHash) || !isSha256Hex(context.currentPlanRevisionHash) || !isSha256Hex(context.currentProcedureSafetyHash)
    || !context.currentPlanId || !context.currentPlanVersionId || !isRecord(context.diskRevisionHashes)
    || typeof context.diskLocatorObservations?.get !== "function") errors.push("destructive action validation context invalid");
  if (plan.inputPlanId !== context.currentPlanId || plan.inputPlanVersionId !== context.currentPlanVersionId || plan.inputConfigHash !== context.currentConfigHash || plan.inputPlanRevisionHash !== context.currentPlanRevisionHash) errors.push("destructive action confirmation is stale for the current plan/config/revision");
  if (plan.confirmation === "confirmed" && plan.inputProcedureSafetyHash !== context.currentProcedureSafetyHash) errors.push("destructive confirmation is stale for the current procedureSafetyHash");
  if (Array.isArray(plan.diskInstanceIds) && Array.isArray(plan.locatorObservationIds) && typeof context.diskLocatorObservations?.get === "function") {
    for (const [index, diskInstanceId] of plan.diskInstanceIds.entries()) {
      const observation = context.diskLocatorObservations.get(diskInstanceId);
      const declaredObservationId = plan.locatorObservationIds[index];
      const currentRevisionHash = context.diskRevisionHashes[diskInstanceId];
      if (!observation || observation.observationId !== declaredObservationId
        || observation.fieldId !== "storage.disk_locator"
        || observation.subjectRef.kind !== "instance" || observation.subjectRef.instanceId !== diskInstanceId
        || !currentRevisionHash
        || !canProjectUserObservation(observation, {
          planId: context.currentPlanId,
          subjectExists: true,
          currentConfigHash: context.currentConfigHash,
          currentSubjectRevisionHash: currentRevisionHash,
        })) errors.push(`disk ${diskInstanceId} lacks a current active storage.disk_locator observation`);
    }
  }
  return errors;
}

/** Server-facing destructive-action gate; current device/plan state is resolver-issued. */
export async function validateDestructiveActionPlanAuthoritatively(
  value: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<DestructiveActionValidationContext, "destructive-action-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<DestructiveActionValidationContext, "destructive-action-context">(
    resolver,
    "destructive-action-context",
    contextRef,
  );
  if (!resolved.ok) return [`destructive action authoritative context resolution failed: ${resolved.error}`];
  return validateDestructiveActionPlan(value, resolved.value);
}
