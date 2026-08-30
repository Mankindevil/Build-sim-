import type { FirmwarePathEvaluation } from "../firmware/contracts";
import type { FirmwarePlan, FirmwareTransition } from "./contracts";

function transition(value: FirmwarePathEvaluation["selectedTransitions"][number], selectedIds: ReadonlySet<string>): FirmwareTransition {
  return {
    transitionId: value.transitionId,
    fromReleaseFactId: value.fromReleaseFactId,
    toReleaseFactId: value.toReleaseFactId,
    method: value.method,
    requiresWorkingCpu: value.requiresWorkingCpu,
    requirementIds: [...value.requirementIds],
    temporaryHardwareRequirementIds: [...value.temporaryHardwareRequirementIds],
    firmwareFileFactId: value.firmwareFileFactId,
    media: {
      format: value.mediaFormat,
      fileName: value.requiredFilename,
      checksumFactId: value.checksumFactId,
      mediaRequirementIds: [...value.requirementIds],
    },
    powerPrerequisiteRequirementIds: [...value.powerPrerequisiteFactIds],
    recoveryTransitionIds: value.recoveryTransitionIds.filter((id) => selectedIds.has(id)),
    resetsSettings: value.resetsSettings,
    releaseFactIds: [...value.releaseFactIds],
    officialProcedureEvidenceRefs: [...value.sourceFactIds],
  };
}

/** Pure projection only: the U6 path evaluator remains the sole upgrade-graph authority. */
export function firmwarePlanFromPath(evaluation: FirmwarePathEvaluation): FirmwarePlan {
  const selectedIds = new Set(evaluation.selectedTransitions.map(({ transitionId }) => transitionId));
  const evidenceRefs = [
    evaluation.capabilityRef.factSnapshotRef.snapshotId,
    evaluation.capabilityRef.factSnapshotRef.contentHash,
    ...(evaluation.currentObservation?.evidenceRefs ?? []),
  ];
  return {
    firmwarePlanId: `firmware-plan.${evaluation.instanceId}.${evaluation.contentHash}`,
    instanceId: evaluation.instanceId,
    status: evaluation.verdict === "pass" ? "pass" : "blocked",
    inputHash: evaluation.contentHash,
    ...(evaluation.currentObservation ? {
      currentVersionObservationId: evaluation.currentObservation.observationId,
      currentReleaseFactId: evaluation.currentObservation.releaseFactId,
    } : {}),
    versionIdentification: {
      method: evaluation.currentObservation?.method === "uefi_screen" ? "bios_screen"
        : evaluation.currentObservation?.method === "bmc_inventory" ? "bmc"
          : evaluation.currentObservation?.method === "os_probe" ? "os_tool"
            : evaluation.currentObservation?.method === "label_observation" ? "label" : "bios_screen",
      observationFieldId: "firmware.bios_version",
      evidenceRefs: [...new Set(evidenceRefs.length > 0 ? evidenceRefs : [evaluation.capabilityRef.contentHash])].sort(),
    },
    minimumVersionFactIds: evaluation.minimumReleaseFactId ? [evaluation.minimumReleaseFactId] : [],
    targetVersionFactIds: evaluation.targetReleaseFactId ? [evaluation.targetReleaseFactId] : [],
    transitions: evaluation.selectedTransitions.map((value) => transition(value, selectedIds)),
    derivedRequirementIds: evaluation.derivedRequirements.map(({ requirementId }) => requirementId).sort(),
    requiredSettings: evaluation.searchAuthority.requestedSettings.map(({ settingId, desiredValue, evidenceRefs: refs }) => ({
      key: settingId,
      value: desiredValue,
      reason: evaluation.settingsReset ? "Restore the governed setting after the selected firmware transition resets settings." : "Apply the selected system-profile firmware setting.",
      evidenceRefs: [...refs],
    })),
  };
}
