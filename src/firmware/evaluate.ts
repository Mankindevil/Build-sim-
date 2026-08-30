import { verifyFirmwareCapability } from "../capabilities/firmware";
import { evaluateFirmwarePathRuntime, validateFirmwarePathEvaluationRuntime } from "./runtime.mjs";
import type {
  FirmwarePathEvaluation,
  FirmwarePathEvaluationInput,
  NormalizedFirmwarePathEvaluationInput,
  FirmwarePreflightAvailability,
} from "./contracts";

function values(value: ReadonlySet<string> | readonly string[] | undefined): string[] {
  return [...(value ?? [])].sort();
}

function preflight(value: FirmwarePathEvaluationInput["preflight"]): FirmwarePreflightAvailability {
  return {
    workingCpuAvailable: value?.workingCpuAvailable ?? null,
    workingMemoryAvailable: value?.workingMemoryAvailable ?? null,
    displayPathAvailable: value?.displayPathAvailable ?? null,
  };
}

/** Canonicalize caller collections before either projection or graph replay. */
export function normalizeFirmwarePathEvaluationInput(
  input: FirmwarePathEvaluationInput,
): NormalizedFirmwarePathEvaluationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("firmware path input must be an object");
  return {
    capability: input.capability,
    instanceId: input.instanceId,
    currentObservation: input.currentObservation === undefined || input.currentObservation === null ? null : {
      ...input.currentObservation,
      evidenceRefs: [...input.currentObservation.evidenceRefs].sort(),
    },
    cpuSkuId: input.cpuSkuId ?? null,
    targetReleaseFactId: input.targetReleaseFactId ?? null,
    availableRequirementIds: values(input.availableRequirementIds),
    availableFactIds: values(input.availableFactIds),
    preflight: preflight(input.preflight),
    transitionTemporaryHardwareRequirements: (input.transitionTemporaryHardwareRequirements ?? []).map((entry) => ({
      transitionId: entry.transitionId,
      requirementIds: [...entry.requirementIds].sort(),
    })).sort((left, right) => left.transitionId.localeCompare(right.transitionId)),
    requestedSettings: (input.requestedSettings ?? []).map((setting) => ({
      settingId: setting.settingId,
      desiredValue: setting.desiredValue,
      evidenceRefs: [...setting.evidenceRefs].sort(),
    })).sort((left, right) => left.settingId.localeCompare(right.settingId)),
    requireRecovery: input.requireRecovery ?? false,
  };
}

/**
 * Select an executable release path while searching. A shorter path with an
 * unmet CPU/media/power prerequisite never masks a longer executable path.
 */
export async function evaluateFirmwarePath(input: FirmwarePathEvaluationInput): Promise<FirmwarePathEvaluation> {
  const normalized = normalizeFirmwarePathEvaluationInput(input);
  if (!await verifyFirmwareCapability(normalized.capability)) throw new TypeError("firmware capability invalid or content hash mismatch");
  for (const requested of normalized.requestedSettings) {
    const setting = normalized.capability.settings.find((candidate) => candidate.settingId === requested.settingId);
    if (!setting || !setting.supportedValues.includes(requested.desiredValue)) {
      throw new TypeError(`requested firmware setting is not supported: ${requested.settingId}=${requested.desiredValue}`);
    }
  }
  const result = evaluateFirmwarePathRuntime(normalized) as FirmwarePathEvaluation;
  const errors = validateFirmwarePathEvaluationRuntime(result, normalized.capability);
  if (errors.length) throw new TypeError(`Invalid firmware path evaluation: ${errors.join("; ")}`);
  return result;
}

export const evaluateFirmwareUpgradePath = evaluateFirmwarePath;
