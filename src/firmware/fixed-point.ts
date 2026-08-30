import type {
  FirmwareRequirementBatchFixedPointInput,
  FirmwareRequirementBatchFixedPointResult,
  FirmwareRequirementFixedPointInput,
  FirmwareRequirementFixedPointResult,
} from "./contracts";
import {
  evaluateFirmwareRequirementBatchFixedPointRuntime,
} from "./fixed-point-runtime.mjs";
import { validateRequirementAllocationResultRuntime } from "../requirements/runtime.mjs";
import { validateFirmwarePathEvaluationRuntime } from "./runtime.mjs";

function validatedBatchResult(
  input: FirmwareRequirementBatchFixedPointInput,
  value: unknown,
): FirmwareRequirementBatchFixedPointResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("firmware requirement fixed-point runtime returned an invalid result");
  }
  const result = value as FirmwareRequirementBatchFixedPointResult;
  const allocationErrors = validateRequirementAllocationResultRuntime(result.requirementAllocation);
  const capabilityByInstance = new Map(input.baseInputs.map(({ instanceId, capability }) => [instanceId, capability]));
  const pathErrors = Array.isArray(result.evaluations)
    ? result.evaluations.flatMap((evaluation, index) => validateFirmwarePathEvaluationRuntime(
      evaluation,
      capabilityByInstance.get(evaluation.instanceId),
    ).map((error) => `evaluations.${index}: ${error}`))
    : ["evaluations must be an array"];
  if (allocationErrors.length > 0 || pathErrors.length > 0
    || result.reachedFixedPoint !== true
    || !Number.isSafeInteger(result.iterations) || result.iterations <= 0
    || !Array.isArray(result.candidateRequirements)
    || !Array.isArray(result.availabilityByInstance)) {
    throw new TypeError(
      `firmware requirement fixed-point runtime returned an invalid result: ${[
        ...allocationErrors,
        ...pathErrors,
      ].join("; ")}`,
    );
  }
  return result;
}

/**
 * Batch fixed point performs one global, quantity-conserving allocation across
 * every firmware target. The JS runtime is the sole online and restore-replay
 * algorithm so persisted evaluations cannot drift from TypeScript execution.
 */
export async function evaluateFirmwareRequirementBatchFixedPoint(
  input: FirmwareRequirementBatchFixedPointInput,
): Promise<FirmwareRequirementBatchFixedPointResult> {
  return validatedBatchResult(input, evaluateFirmwareRequirementBatchFixedPointRuntime(input));
}

/** Single-target convenience wrapper over the global fixed-point authority. */
export async function evaluateFirmwareRequirementFixedPoint(
  input: FirmwareRequirementFixedPointInput,
): Promise<FirmwareRequirementFixedPointResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("firmware requirement fixed-point input must be an object");
  }
  const batchInput: FirmwareRequirementBatchFixedPointInput = {
    baseInputs: [input.baseInput],
    rootRequirements: input.rootRequirements,
    supplies: input.supplies,
    ...(input.allocationOptions === undefined ? {} : { allocationOptions: input.allocationOptions }),
    ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
  };
  const batch = await evaluateFirmwareRequirementBatchFixedPoint(batchInput);
  const evaluation = batch.evaluations[0];
  const availability = batch.availabilityByInstance[0];
  if (evaluation === undefined || availability === undefined) {
    throw new Error("firmware fixed-point target result missing");
  }
  return {
    evaluation,
    requirementAllocation: batch.requirementAllocation,
    candidateRequirements: batch.candidateRequirements,
    availableRequirementIds: availability.requirementIds,
    iterations: batch.iterations,
    reachedFixedPoint: true,
  };
}
