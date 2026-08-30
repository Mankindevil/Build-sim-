import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../../src/topology/contracts";
import type { DomainHashes } from "../../src/hash";
import type { FirmwarePathEvaluation } from "../../src/firmware/contracts";
import type { SystemCheckAuthority, SystemProfileEvaluation } from "../../src/system-profiles/contracts";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../../src/system-profiles/registry";
import { evaluateSystemProfile } from "../../src/system-profiles/evaluate";
import { generateFirstBootProcedure, type GeneratedBuildProcedure } from "../../src/build-execution/first-boot";

export const hash = (character: string): string => character.repeat(64);

export const domainHashes = (): DomainHashes => ({
  compatibilityHash: hash("1"), spatialHash: hash("2"), simulationHash: hash("3"),
  procedureSafetyHash: hash("4"), priceHash: hash("5"),
});

export function configFor(profileId: "system.windows-11" | "system.truenas-scale"): BuildConfigV3 {
  const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
  const config = createEmptyBuildConfigV3("plan-u7", "U7", "2026-08-29T00:00:00.000Z");
  config.intent = { state: "answered", value: profileId === "system.truenas-scale" ? "nas" : "pc", source: "user", confirmedByUser: true };
  config.system = { profileId, versionFactId: profile.releaseFactId, source: "user", lockedByUser: true };
  config.components = [
    { instanceId: "board-1", kind: "motherboard", role: "board", state: "planned", identity: { status: "resolved", skuId: "sku.board", identityClaimIds: ["claim.board"] }, source: "user" },
    { instanceId: "cpu-1", kind: "cpu", role: "cpu", state: "planned", identity: { status: "resolved", skuId: "sku.cpu", identityClaimIds: ["claim.cpu"] }, source: "user" },
  ];
  return config;
}

export function firmwarePath(overrides: Partial<FirmwarePathEvaluation> = {}): FirmwarePathEvaluation {
  return {
    schemaVersion: "firmware-path-evaluation-v1",
    instanceId: "board-1",
    capabilityRef: { subjectSkuId: "sku.board", subjectRevision: "rev-a", region: "CN", contentHash: hash("a"), factSnapshotRef: { snapshotId: "facts-1", contentHash: hash("b") } },
    currentObservation: { observationId: "obs-bios", releaseFactId: "release.old", method: "uefi_screen", evidenceRefs: ["observation:obs-bios"] },
    cpuSkuId: "sku.cpu",
    minimumReleaseFactId: "release.new",
    targetReleaseFactId: "release.new",
    searchAuthority: { requestedTargetReleaseFactId: "release.new", availableRequirementIds: ["req-media"], availableFactIds: ["fact.power"], preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true }, transitionTemporaryHardwareRequirements: [], requestedSettings: [{ settingId: "secure_boot", desiredValue: "enabled", evidenceRefs: ["fact.setting"] }], requireRecovery: true },
    verdict: "pass",
    reason: "path_available",
    selectedTransitions: [{
      transitionId: "flash-a", fromReleaseFactId: "release.old", toReleaseFactId: "release.new", purpose: "upgrade", method: "usb_flashback", requiresWorkingCpu: false,
      requirementIds: ["req-media"], temporaryHardwareRequirementIds: [], missingRequirementIds: [], firmwareFileFactId: "fact.file", mediaFormat: "fat32", requiredFilename: "BOARD.CAP",
      checksumFactId: "fact.checksum", powerPrerequisiteFactIds: ["fact.power"], missingPowerPrerequisiteFactIds: [], recoveryTransitionIds: ["recovery-a"], resetsSettings: true,
      releaseFactIds: ["release.old", "release.new"], sourceFactIds: ["fact.file", "fact.procedure"],
    }],
    bridgeReleaseFactIds: [], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [], derivedRequirements: [], settingsReset: true,
    recovery: { status: "available", transitionIds: ["recovery-a"], missingRequirementIds: [], missingPowerPrerequisiteFactIds: [] },
    pathAlternativesExamined: 1, searchTruncated: false, assumptions: [], contentHash: hash("c"),
    ...overrides,
  };
}

export function passChecks(profileId: "system.windows-11" | "system.truenas-scale"): SystemCheckAuthority[] {
  const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
  return profile.requiredChecks.filter((checkId) => checkId !== "firmware_path").map((checkId) => ({
    checkId,
    status: "pass",
    instanceIds: checkId === "boot_device" ? ["boot-1"] : ["board-1"],
    factIds: [`fact.${checkId}`],
    message: `${checkId} has governed support authority.`,
  }));
}

export function systemEvaluation(profileId: "system.windows-11" | "system.truenas-scale", checks = passChecks(profileId), firmware = firmwarePath()): SystemProfileEvaluation {
  const config = configFor(profileId);
  return evaluateSystemProfile({ config, profile: DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId), firmwareEvaluations: [firmware], checks });
}

export function generatedProcedure(profileId: "system.windows-11" | "system.truenas-scale"): GeneratedBuildProcedure {
  const config = configFor(profileId);
  const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
  const firmware = firmwarePath();
  const evaluation = evaluateSystemProfile({ config, profile, firmwareEvaluations: [firmware], checks: passChecks(profileId) });
  return generateFirstBootProcedure({
    planVersionId: "version-u7",
    config,
    evaluationHash: hash("d"),
    domainHashes: domainHashes(),
    profile,
    systemEvaluation: evaluation,
    firmwareEvaluations: [firmware],
    storageEvaluation: null,
    evaluatorArtifactRef: `sha256:${hash("e")}`,
    evaluatorArtifactHash: hash("e"),
    evaluatorVersion: "u7-evaluator-1",
  });
}
