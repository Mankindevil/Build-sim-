import type { ProgressiveBuildEvaluation } from "../compatibility/contracts";
import type { DomainHashes } from "../hash";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import { canonicalJson } from "../plans/canonical";
import type { BuildConfigV3 } from "../topology/contracts";
import type { BuildProcedure, BuildProcedureStep, EvaluatorArtifactAuthorityRef, ProcedureDependencyContext } from "./contracts";
import type { GeneratedBuildProcedure } from "./first-boot";

export interface PartialPreparationProcedureInput {
  readonly planVersionId: string;
  readonly config: BuildConfigV3;
  readonly evaluationHash: string;
  readonly evaluation: ProgressiveBuildEvaluation;
  readonly domainHashes: DomainHashes;
  readonly evaluatorArtifactRef: EvaluatorArtifactAuthorityRef;
  readonly evaluatorArtifactHash: string;
  readonly evaluatorVersion: string;
}

function digest(domain: string, value: unknown): string {
  const hash = sha256Utf8Runtime(`buildsim:${domain}:${canonicalJson(value)}`);
  if (hash === null) throw new TypeError(`${domain} cannot be hashed`);
  return hash;
}

/**
 * Generates a deliberately non-energized procedure for an incomplete or
 * blocked saved plan. It cannot contain installation, firmware, first-power or
 * system phases and therefore cannot be mistaken for a completed boot path.
 */
export function generatePartialPreparationProcedure(input: PartialPreparationProcedureInput): GeneratedBuildProcedure {
  const allInstances = input.config.components.map(({ instanceId }) => instanceId).sort();
  const requirements = [...input.evaluation.requirements].sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  const identityRequirementIds = requirements
    .filter(({ kind, producedBy }) => kind === "evidence" || kind === "component" || producedBy.ruleId.includes("identity"))
    .map(({ requirementId }) => requirementId);
  const measurementRequirementIds = requirements
    .filter(({ kind }) => kind === "measurement")
    .map(({ requirementId }) => requirementId);
  const blockerRequirementIds = requirements
    .filter(({ criticality, requiredBefore }) => criticality !== "normal" || requiredBefore !== undefined)
    .map(({ requirementId }) => requirementId);
  const procedureSafetyHash = digest("partial-preparation-safety-v1", {
    planVersionId: input.planVersionId,
    evaluationHash: input.evaluationHash,
    compatibilityHash: input.domainHashes.compatibilityHash,
    spatialHash: input.domainHashes.spatialHash,
    requirementIds: requirements.map(({ requirementId }) => requirementId),
    readiness: input.evaluation.readiness,
  });
  const steps: BuildProcedureStep[] = [];
  const add = (partial: Omit<BuildProcedureStep, "dependencyHash" | "dependencyHashes">, dependencyHashes: Partial<DomainHashes>) => {
    const dependencyHash = digest("partial-preparation-step-v1", {
      planVersionId: input.planVersionId,
      stepId: partial.stepId,
      instanceIds: partial.instanceIds,
      requirementIds: partial.requirementIds,
      dependencyHashes,
    });
    steps.push({ ...partial, dependencyHashes, dependencyHash });
  };
  add({
    stepId: "prepare-inventory",
    phase: "prepare",
    action: "核对每个已选择部件的实例、数量和标签；保持整机断电，不安装、不连接市电。",
    dependsOn: [],
    instanceIds: allInstances,
    requirementIds: identityRequirementIds,
    expectedResult: "已选择的实物与方案实例一一对应，未确认项保持待补充。",
    failureAction: "停止后续动作，先修正身份或数量差异。",
    riskLevel: "normal",
    stopConditions: ["身份不一致", "数量不一致", "发现损坏", "任何供电连接尝试"],
    failureBranchStepIds: [],
    confirmationPolicy: "user_confirm",
    safetyCritical: false,
    evidenceRefs: [`evaluation:${input.evaluationHash}`],
  }, { compatibilityHash: input.domainHashes.compatibilityHash });
  add({
    stepId: "record-bounded-measurements",
    phase: "prepare",
    action: "在不安装、不通电的状态下记录机箱、部件、接口和走线路径所需量尺；每项保留观察 ID 与测量公差。",
    dependsOn: ["prepare-inventory"],
    instanceIds: allInstances,
    requirementIds: measurementRequirementIds,
    expectedResult: "测量值、基准面、公差和对应实例均已记录为方案范围内观察。",
    failureAction: "无法确定基准面或公差时保持未知，不以估计值代替。",
    riskLevel: "normal",
    stopConditions: ["需要拆装或通电才能测量", "测量对象身份未确认"],
    failureBranchStepIds: [],
    confirmationPolicy: "observation_required",
    safetyCritical: false,
    evidenceRefs: [`evaluation:${input.evaluationHash}`, ...requirements.flatMap(({ evidenceRefs }) => evidenceRefs).slice(0, 40)],
  }, { compatibilityHash: input.domainHashes.compatibilityHash, spatialHash: input.domainHashes.spatialHash });
  add({
    stepId: "review-open-evidence-and-requirements",
    phase: "prepare",
    action: "逐项复核仍未满足的资料、部件、附件、供电和首次启动前置条件；保持断电，不能把此步骤当作装机或首次通电许可。",
    dependsOn: ["record-bounded-measurements"],
    instanceIds: allInstances,
    requirementIds: blockerRequirementIds,
    expectedResult: "所有未满足项都有明确的补充动作，并继续保持 blocked/unknown。",
    failureAction: "若任何关键前置条件仍不明确，结束本次准备流程并继续补充资料。",
    riskLevel: "caution",
    stopConditions: ["试图安装部件", "试图连接电源", "试图执行固件或系统步骤"],
    failureBranchStepIds: [],
    confirmationPolicy: "user_confirm",
    safetyCritical: false,
    evidenceRefs: [`evaluation:${input.evaluationHash}`],
  }, { compatibilityHash: input.domainHashes.compatibilityHash, procedureSafetyHash });
  const procedureBase = {
    inputEvaluationHash: input.evaluationHash,
    procedureSafetyHash,
    phases: ["prepare"] as const,
    steps,
  };
  const procedure: BuildProcedure = {
    procedureId: `procedure.${input.planVersionId}.${digest("partial-preparation-procedure-v1", procedureBase)}`,
    ...procedureBase,
    phases: [...procedureBase.phases],
  };
  const dependencyContext: ProcedureDependencyContext = {
    evaluatorArtifactRef: input.evaluatorArtifactRef,
    evaluatorArtifactHash: input.evaluatorArtifactHash,
    evaluatorVersion: input.evaluatorVersion,
    expectedInputEvaluationHash: input.evaluationHash,
    expectedProcedureSafetyHash: procedureSafetyHash,
    expectedStepDependencyHashes: Object.fromEntries(steps.map(({ stepId, dependencyHash }) => [stepId, dependencyHash])),
  };
  return { procedure, dependencyContext, firmwarePlans: [] };
}
