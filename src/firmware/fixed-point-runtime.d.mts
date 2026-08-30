import type {
  FirmwareRequirementBatchFixedPointInput,
  FirmwareRequirementBatchFixedPointResult,
} from "./contracts";

export function evaluateFirmwareRequirementBatchFixedPointRuntime(
  input: FirmwareRequirementBatchFixedPointInput,
): FirmwareRequirementBatchFixedPointResult;
export function validateFirmwareRequirementBatchFixedPointReplayRuntime(
  value: unknown,
  context: FirmwareRequirementBatchFixedPointInput,
): string[];
