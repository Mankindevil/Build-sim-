import { canonicalJson } from "../plans/canonical";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import type { DomainHashes } from "../hash";
import type { FirmwarePathEvaluation } from "../firmware/contracts";
import type { StorageLayoutEvaluation } from "../storage/contracts";
import type { SystemProfileDefinition, SystemProfileEvaluation } from "../system-profiles/contracts";
import type { BuildConfigV3 } from "../topology/contracts";
import type {
  BuildProcedure,
  BuildProcedureStep,
  EvaluatorArtifactAuthorityRef,
  FirmwarePlan,
  ProcedureDependencyContext,
} from "./contracts";
import { firmwarePlanFromPath } from "./bios-plan";
import { commissioningChecks } from "./commissioning";
import { firmwareSettingProcedureItems } from "./settings";

export interface BuildProcedureGenerationInput {
  readonly planVersionId: string;
  readonly config: BuildConfigV3;
  readonly evaluationHash: string;
  readonly domainHashes: DomainHashes;
  readonly profile: SystemProfileDefinition;
  readonly systemEvaluation: SystemProfileEvaluation;
  readonly firmwareEvaluations: readonly FirmwarePathEvaluation[];
  readonly storageEvaluation: StorageLayoutEvaluation | null;
  readonly evaluatorArtifactRef: EvaluatorArtifactAuthorityRef;
  readonly evaluatorArtifactHash: string;
  readonly evaluatorVersion: string;
}

export interface GeneratedBuildProcedure {
  readonly procedure: BuildProcedure;
  readonly dependencyContext: ProcedureDependencyContext;
  readonly firmwarePlans: readonly FirmwarePlan[];
}

function digest(domain: string, value: unknown): string {
  const hash = sha256Utf8Runtime(`buildsim:${domain}:${canonicalJson(value)}`);
  if (hash === null) throw new TypeError(`${domain} cannot be hashed`);
  return hash;
}

export function generateFirstBootProcedure(input: BuildProcedureGenerationInput): GeneratedBuildProcedure {
  if (input.config.system?.profileId !== input.profile.profileId || input.systemEvaluation.profileId !== input.profile.profileId) {
    throw new TypeError("procedure system profile binding mismatch");
  }
  if (input.systemEvaluation.verdict === "fail") throw new TypeError("a failed system evaluation cannot produce an executable first-boot procedure");
  const firmwarePlans = input.firmwareEvaluations.map(firmwarePlanFromPath);
  const procedureSafetyHash = digest("procedure-safety-v1", {
    planVersionId: input.planVersionId,
    evaluationHash: input.evaluationHash,
    systemEvaluationHash: input.systemEvaluation.contentHash,
    firmwareEvaluationHashes: input.firmwareEvaluations.map(({ contentHash }) => contentHash).sort(),
    storageLayoutHash: input.storageEvaluation?.layoutSelectionHash ?? null,
    compatibilityHash: input.domainHashes.compatibilityHash,
    spatialHash: input.domainHashes.spatialHash,
  });
  const allInstances = input.config.components.map(({ instanceId }) => instanceId).sort();
  const steps: BuildProcedureStep[] = [];
  const add = (partial: Omit<BuildProcedureStep, "dependencyHash" | "dependencyHashes">, dependencies: Partial<DomainHashes>) => {
    const dependencyHashes = { ...dependencies, ...(partial.safetyCritical ? { procedureSafetyHash } : {}) };
    const dependencyHash = digest("procedure-step-dependency-v1", {
      planVersionId: input.planVersionId,
      stepId: partial.stepId,
      instanceIds: partial.instanceIds,
      requirementIds: partial.requirementIds,
      dependencyHashes,
    });
    steps.push({ ...partial, dependencyHashes, dependencyHash });
  };
  add({
    stepId: "prepare-inventory", phase: "prepare", action: "Match every planned component to the current topology before opening or installing media.",
    dependsOn: [], instanceIds: allInstances, requirementIds: [], expectedResult: "Every present component maps to one planned instance.",
    failureAction: "Stop and resolve identity or quantity differences.", riskLevel: "normal", stopConditions: ["unresolved identity"], failureBranchStepIds: [],
    confirmationPolicy: "user_confirm", safetyCritical: false, evidenceRefs: [input.profile.helpRef],
  }, { compatibilityHash: input.domainHashes.compatibilityHash });
  add({
    stepId: "bench-minimal-post", phase: "bench_test", action: "Bench-test the minimum CPU, one memory module and one governed display path.",
    dependsOn: ["prepare-inventory"], instanceIds: allInstances, requirementIds: input.systemEvaluation.requirements.filter(({ requiredBefore }) => requiredBefore === "first_boot").map(({ requirementId }) => requirementId),
    expectedResult: "POST begins and debug indicators progress normally.", failureAction: "Remove power and follow the POST diagnostic branch.", riskLevel: "safety_critical",
    stopConditions: ["no POST", "burning smell", "unexpected shutdown", "abnormal temperature rise"], failureBranchStepIds: ["diagnose-post"],
    confirmationPolicy: "observation_required", safetyCritical: true, evidenceRefs: [...input.profile.officialSourceRefs],
  }, { compatibilityHash: input.domainHashes.compatibilityHash, spatialHash: input.domainHashes.spatialHash });
  add({
    stepId: "diagnose-post", phase: "bench_test", action: "Record debug LED/code, power state and current firmware version; do not continue installation.",
    dependsOn: ["prepare-inventory"], instanceIds: allInstances, requirementIds: [], expectedResult: "A bounded diagnostic observation is recorded.",
    failureAction: "Keep the system powered off and request evidence-guided diagnosis.", riskLevel: "caution", stopConditions: ["electrical fault", "uncontrolled heat"], failureBranchStepIds: [],
    confirmationPolicy: "observation_required", safetyCritical: false, evidenceRefs: ["observation:boot.result", "observation:firmware.bios_version"],
  }, { compatibilityHash: input.domainHashes.compatibilityHash });
  let previous = "bench-minimal-post";
  for (const plan of firmwarePlans) {
    if (plan.status !== "pass") continue;
    for (const transition of plan.transitions) {
      const id = `firmware-${transition.transitionId}`;
      const recoveryIds = input.firmwareEvaluations.find(({ instanceId }) => instanceId === plan.instanceId)?.recovery.transitionIds ?? [];
      add({
        stepId: id, phase: "firmware", action: `Use ${transition.media.format} media and exact file ${transition.media.fileName}; verify checksum fact ${transition.media.checksumFactId} before the vendor procedure.`,
        dependsOn: [previous], instanceIds: [plan.instanceId], requirementIds: [...transition.requirementIds, ...transition.temporaryHardwareRequirementIds],
        expectedResult: `Firmware reaches ${transition.toReleaseFactId} and requested reset behavior is observed.`, failureAction: recoveryIds.length > 0
          ? `Do not remove power; follow governed recovery transition ${recoveryIds.join(", ")}.`
          : "Do not remove power; stop because no governed recovery transition is available.",
        riskLevel: "safety_critical", stopConditions: ["checksum mismatch", "unstable power", "wrong board/revision/file"], failureBranchStepIds: [],
        confirmationPolicy: "observation_required", safetyCritical: true, evidenceRefs: [...transition.officialProcedureEvidenceRefs],
      }, { compatibilityHash: input.domainHashes.compatibilityHash });
      previous = id;
    }
  }
  for (const item of firmwareSettingProcedureItems(firmwarePlans)) {
    const id = `setting-${item.instanceId}-${item.settingId}`;
    add({
      stepId: id, phase: "firmware", action: `Set ${item.settingId} to ${item.desiredValue}. ${item.reason}`,
      dependsOn: [previous], instanceIds: [item.instanceId], requirementIds: [], expectedResult: `${item.settingId} is recorded as ${item.desiredValue}.`,
      failureAction: "Restore the prior known-good setting or stop before OS installation.", riskLevel: item.settingId === "storage_controller_mode" ? "destructive" : "caution",
      stopConditions: ["setting differs from governed target"], failureBranchStepIds: [], confirmationPolicy: "observation_required",
      safetyCritical: item.settingId === "storage_controller_mode", evidenceRefs: [...item.evidenceRefs, ...input.profile.officialSourceRefs],
    }, { compatibilityHash: input.domainHashes.compatibilityHash });
    previous = id;
  }
  for (const check of commissioningChecks(input.profile)) {
    const id = `commission-${check.checkId}`;
    add({
      stepId: id,
      phase: check.checkId.includes("install") || check.checkId.includes("drivers") ? "system_install" : check.checkId === "inventory" ? "verification" : "first_power",
      action: check.action, dependsOn: [previous], instanceIds: allInstances, requirementIds: input.systemEvaluation.requirements.map(({ requirementId }) => requirementId),
      expectedResult: check.expectedResult, failureAction: "Stop; preserve the current state and follow the failure branch before continuing.",
      riskLevel: check.safetyCritical ? (check.checkId.includes("install-target") || check.checkId.includes("data-protection") ? "destructive" : "safety_critical") : "normal",
      stopConditions: [...check.stopConditions], failureBranchStepIds: [], confirmationPolicy: check.safetyCritical ? "observation_required" : "user_confirm",
      safetyCritical: check.safetyCritical, evidenceRefs: [...input.profile.officialSourceRefs, input.profile.helpRef],
    }, { compatibilityHash: input.domainHashes.compatibilityHash, ...(input.storageEvaluation ? { simulationHash: input.domainHashes.simulationHash } : {}) });
    previous = id;
  }
  const phases = (["prepare", "bench_test", "firmware", "first_power", "system_install", "verification"] as const).filter((phase) => steps.some((step) => step.phase === phase));
  const procedureBase = { inputEvaluationHash: input.evaluationHash, procedureSafetyHash, phases, steps };
  const procedureId = `procedure.${input.planVersionId}.${digest("build-procedure-v1", procedureBase)}`;
  const procedure: BuildProcedure = { procedureId, ...procedureBase };
  const dependencyContext: ProcedureDependencyContext = {
    evaluatorArtifactRef: input.evaluatorArtifactRef,
    evaluatorArtifactHash: input.evaluatorArtifactHash,
    evaluatorVersion: input.evaluatorVersion,
    expectedInputEvaluationHash: input.evaluationHash,
    expectedProcedureSafetyHash: procedureSafetyHash,
    expectedStepDependencyHashes: Object.fromEntries(steps.map(({ stepId, dependencyHash }) => [stepId, dependencyHash])),
  };
  return { procedure, dependencyContext, firmwarePlans };
}
