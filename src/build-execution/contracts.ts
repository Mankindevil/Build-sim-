import { DOMAIN_HASH_FIELDS, isSha256Hex, type DomainHashes } from "../hash";
import { validateFacetPredicate, validateFirmwareSettingValue, type FirmwareSettingId } from "../contracts/registries";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";
import {
  validateRequirementNode,
  validateRequirementSatisfaction,
  validateSafetyCheckpointRecord,
  type FacetPredicate,
  type RequirementNode,
  type RequirementSatisfaction,
  type SafetyCheckpointRecord,
} from "../requirements/contracts";

export interface BundleItem {
  bundleItemId: string;
  ownerSkuId: string;
  kind: "cable" | "fastener" | "standoff" | "bracket" | "adapter" | "tool" | "consumable";
  specification: FacetPredicate[];
  quantity: number;
  region?: string;
  revision?: string;
  variantScopeFactIds: string[];
  evidenceFactIds: string[];
}

export interface AssemblyRequirement {
  requirementId: string;
  neededByStepId: string;
}

export type BuildPhase = "prepare" | "bench_test" | "mechanical" | "wiring" | "firmware" | "first_power" | "system_install" | "verification";

export interface BuildProcedure {
  procedureId: string;
  inputEvaluationHash: string;
  procedureSafetyHash: string;
  phases: BuildPhase[];
  steps: BuildProcedureStep[];
}

export interface BuildProcedureStep {
  stepId: string;
  phase: BuildPhase;
  action: string;
  dependsOn: string[];
  instanceIds: string[];
  requirementIds: string[];
  expectedResult: string;
  failureAction: string;
  riskLevel: "normal" | "caution" | "safety_critical" | "destructive";
  stopConditions: string[];
  failureBranchStepIds: string[];
  confirmationPolicy: "none" | "user_confirm" | "measurement" | "observation_required";
  safetyCritical: boolean;
  dependencyHashes: Partial<DomainHashes>;
  dependencyHash: string;
  evidenceRefs: string[];
}

export interface BuildStepResult {
  stepId: string;
  result: "confirmed" | "failed" | "skipped_non_safety";
  at: string;
  actor: "user";
  confirmedAgainstDependencyHash: string;
  note?: string;
  observationIds?: string[];
}

export interface ExecutionSession {
  executionSessionId: string;
  planVersionId: string;
  procedureId: string;
  evaluationHash: string;
  procedureSafetyHash: string;
  status: "active" | "completed" | "stale" | "abandoned";
  staleReason?: string;
  results: BuildStepResult[];
}

/** Derived projection only. It is never accepted as mutable plan input. */
export interface BuildReadiness {
  assemblyReady: boolean;
  powerReady: boolean;
  postReady: boolean;
  systemInstallReady: boolean;
  workloadReady: boolean;
  destructiveActionReady: boolean;
}

export interface FirmwareVersionIdentification {
  method: "bios_screen" | "firmware_screen" | "label" | "os_tool" | "bmc";
  observationFieldId: string;
  evidenceRefs: string[];
}

export interface FirmwareMediaRequirement {
  format: string;
  fileName: string;
  checksumFactId: string;
  mediaRequirementIds: string[];
}

export interface FirmwarePlan {
  firmwarePlanId: string;
  instanceId: string;
  status: "pass" | "fail" | "blocked";
  inputHash: string;
  currentVersionObservationId?: string;
  currentReleaseFactId?: string;
  versionIdentification: FirmwareVersionIdentification;
  minimumVersionFactIds: string[];
  targetVersionFactIds: string[];
  transitions: FirmwareTransition[];
  derivedRequirementIds: string[];
  requiredSettings: Array<{ key: FirmwareSettingId; value: string; reason: string; evidenceRefs: string[] }>;
}

export interface FirmwareTransition {
  transitionId: string;
  fromReleaseFactId: string;
  toReleaseFactId: string;
  method: "uefi" | "usb_flashback" | "bmc" | "os_tool";
  requiresWorkingCpu: boolean;
  requirementIds: string[];
  temporaryHardwareRequirementIds: string[];
  firmwareFileFactId: string;
  media: FirmwareMediaRequirement;
  powerPrerequisiteRequirementIds: string[];
  recoveryTransitionIds: string[];
  resetsSettings: boolean;
  releaseFactIds: string[];
  officialProcedureEvidenceRefs: string[];
}

export interface ReadinessInputs {
  requirementNodes: readonly RequirementNode[];
  satisfactions: readonly RequirementSatisfaction[];
  checkpointRecords: readonly SafetyCheckpointRecord[];
  checkpointContext: {
    planVersionId: string;
    procedureId: string;
    procedureSafetyHash: string;
    expectedDependencyHashes: Readonly<Record<string, string>>;
  };
  requiredCheckpointIds: {
    assembly: readonly string[];
    power: readonly string[];
    post: readonly string[];
    systemInstall: readonly string[];
    workload: readonly string[];
    destructive: readonly string[];
  };
}

/** Expected values are supplied by the governed evaluator/artifact repository. */
export interface ProcedureDependencyContext {
  evaluatorArtifactRef: string;
  evaluatorArtifactHash: string;
  evaluatorVersion: string;
  expectedInputEvaluationHash: string;
  expectedProcedureSafetyHash: string;
  expectedStepDependencyHashes: Readonly<Record<string, string>>;
}

export interface ExecutionValidationContext {
  procedure: BuildProcedure;
  dependencyContext: ProcedureDependencyContext;
}

export interface AuthoritativeReadinessDerivation {
  readiness?: BuildReadiness;
  errors: string[];
}

function missingCheckpoints(required: readonly string[], confirmed: ReadonlySet<string>): boolean {
  return required.some((checkpoint) => !confirmed.has(checkpoint));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateBundleItem(value: unknown): string[] {
  if (!isRecord(value)) return ["bundle item must be an object"];
  const item = value as unknown as BundleItem;
  const errors: string[] = [];
  if (Object.keys(item).some((key) => !["bundleItemId", "ownerSkuId", "kind", "specification", "quantity", "region", "revision", "variantScopeFactIds", "evidenceFactIds"].includes(key))) errors.push("bundle item contains unknown fields");
  if (!item.bundleItemId || !item.ownerSkuId) errors.push("bundle item identity missing");
  if (!["cable", "fastener", "standoff", "bracket", "adapter", "tool", "consumable"].includes(item.kind)) errors.push("bundle item kind invalid");
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) errors.push("bundle item quantity must be a positive integer");
  if (item.region !== undefined && (typeof item.region !== "string" || item.region.length === 0)) errors.push("bundle item region invalid");
  if (item.revision !== undefined && (typeof item.revision !== "string" || item.revision.length === 0)) errors.push("bundle item revision invalid");
  if (!Array.isArray(item.specification)) errors.push("bundle item specification must be an array");
  else item.specification.forEach((predicate, index) => errors.push(...validateFacetPredicate(predicate).map((error) => `specification.${index}: ${error}`)));
  if (!isStringArray(item.variantScopeFactIds)) errors.push("bundle item variant scope IDs invalid");
  else if (item.variantScopeFactIds.some((id) => !id) || new Set(item.variantScopeFactIds).size !== item.variantScopeFactIds.length) errors.push("bundle item variant scope IDs invalid");
  if (!isStringArray(item.evidenceFactIds) || item.evidenceFactIds.length === 0 || item.evidenceFactIds.some((id) => !id) || new Set(item.evidenceFactIds).size !== item.evidenceFactIds.length) errors.push("bundle item requires unique evidence facts");
  return errors;
}

export function validateAssemblyRequirement(value: unknown): string[] {
  if (!isRecord(value)) return ["assembly requirement must be an object"];
  return typeof value.requirementId === "string" && value.requirementId.length > 0 && typeof value.neededByStepId === "string" && value.neededByStepId.length > 0 ? [] : ["assembly requirement must identify a derived requirement and procedure step"];
}

/** A pure derivation contract: callers supply requirements/checkpoints, never readiness booleans. */
export function deriveBuildReadiness(input: ReadinessInputs): BuildReadiness {
  const openById = new Map(input.satisfactions.map((item) => [item.requirementId, item.status !== "satisfied"]));
  const hasOpenBefore = (stages: readonly NonNullable<RequirementNode["requiredBefore"]>[]) => input.requirementNodes.some((node) => stages.includes(node.requiredBefore as NonNullable<RequirementNode["requiredBefore"]>) && openById.get(node.requirementId) !== false);
  const requirementById = new Map(input.requirementNodes.map((node) => [node.requirementId, node]));
  const confirmed = new Set(input.checkpointRecords.filter((checkpoint) => {
    const requirement = requirementById.get(checkpoint.requirementId) ?? {
      requirementId: checkpoint.requirementId,
      kind: "user_decision" as const,
      predicates: [],
      quantity: 1,
      criticality: "safety" as const,
      producedBy: { ruleId: "checkpoint", ruleVersion: "1", instanceIds: [] },
      evidenceRefs: [],
    };
    const expectedDependencyHash = input.checkpointContext.expectedDependencyHashes[checkpoint.checkpointId];
    return expectedDependencyHash !== undefined
      && validateSafetyCheckpointRecord(checkpoint, requirement, {
        planVersionId: input.checkpointContext.planVersionId,
        procedureId: input.checkpointContext.procedureId,
        expectedDependencyHash,
        expectedProcedureSafetyHash: input.checkpointContext.procedureSafetyHash,
      }).length === 0;
  }).map((checkpoint) => checkpoint.checkpointId));
  const hasUnscopedOpenBootOrSafety = input.requirementNodes.some((node) => node.requiredBefore === undefined
    && (node.criticality === "boot" || node.criticality === "safety")
    && openById.get(node.requirementId) !== false);
  const assemblyReady = !hasOpenBefore(["assembly"]) && !missingCheckpoints(input.requiredCheckpointIds.assembly, confirmed);
  const powerReady = assemblyReady && !hasUnscopedOpenBootOrSafety && !hasOpenBefore(["pre_power"]) && !missingCheckpoints(input.requiredCheckpointIds.power, confirmed);
  const postReady = powerReady && !hasOpenBefore(["first_boot"]) && !missingCheckpoints(input.requiredCheckpointIds.post, confirmed);
  const systemInstallReady = postReady && !hasOpenBefore(["os_install"]) && !missingCheckpoints(input.requiredCheckpointIds.systemInstall, confirmed);
  return {
    assemblyReady,
    powerReady,
    postReady,
    systemInstallReady,
    workloadReady: systemInstallReady && !missingCheckpoints(input.requiredCheckpointIds.workload, confirmed),
    destructiveActionReady: powerReady && !missingCheckpoints(input.requiredCheckpointIds.destructive, confirmed),
  };
}

/** Resolve requirements, satisfactions and required gates as one evaluator-owned snapshot. */
export async function deriveBuildReadinessAuthoritatively(
  readinessRef: string,
  resolver: AuthoritativeResolver<ReadinessInputs, "readiness-inputs">,
): Promise<AuthoritativeReadinessDerivation> {
  const resolved = await resolveAuthoritativeContext<ReadinessInputs, "readiness-inputs">(
    resolver,
    "readiness-inputs",
    readinessRef,
  );
  if (!resolved.ok) return { errors: [`readiness authoritative inputs resolution failed: ${resolved.error}`] };
  const input = resolved.value;
  if (!input || !Array.isArray(input.requirementNodes) || !Array.isArray(input.satisfactions)
    || !Array.isArray(input.checkpointRecords) || !isRecord(input.checkpointContext)
    || !isRecord(input.requiredCheckpointIds)) return { errors: ["readiness authoritative inputs invalid"] };
  const errors: string[] = [];
  const requirementById = new Map(input.requirementNodes.map((requirement) => [requirement.requirementId, requirement]));
  input.requirementNodes.forEach((requirement, index) => errors.push(...validateRequirementNode(requirement).map((error) => `requirementNodes.${index}: ${error}`)));
  input.satisfactions.forEach((satisfaction, index) => {
    const requirement = requirementById.get(satisfaction.requirementId);
    if (!requirement) errors.push(`satisfactions.${index}: requirement missing from authoritative inputs`);
    else {
      const checkpoint = input.checkpointRecords.find((item) => item.requirementId === requirement.requirementId);
      const expectedDependencyHash = checkpoint === undefined ? undefined : input.checkpointContext.expectedDependencyHashes[checkpoint.checkpointId];
      errors.push(...validateRequirementSatisfaction(
        requirement,
        satisfaction,
        checkpoint,
        checkpoint && expectedDependencyHash ? {
          planVersionId: input.checkpointContext.planVersionId,
          procedureId: input.checkpointContext.procedureId,
          expectedDependencyHash,
          expectedProcedureSafetyHash: input.checkpointContext.procedureSafetyHash,
        } : undefined,
      ).map((error) => `satisfactions.${index}: ${error}`));
    }
  });
  const requiredGroups = ["assembly", "power", "post", "systemInstall", "workload", "destructive"] as const;
  for (const group of requiredGroups) {
    const ids = input.requiredCheckpointIds[group];
    if (!isStringArray(ids) || new Set(ids).size !== ids.length) errors.push(`requiredCheckpointIds.${group} invalid`);
  }
  if (!isSha256Hex(input.checkpointContext.procedureSafetyHash)
    || !input.checkpointContext.planVersionId || !input.checkpointContext.procedureId
    || !isRecord(input.checkpointContext.expectedDependencyHashes)) errors.push("readiness checkpoint context invalid");
  if (errors.length > 0) return { errors };
  return { readiness: deriveBuildReadiness(input), errors: [] };
}

export function validateBuildProcedure(value: unknown, context?: ProcedureDependencyContext): string[] {
  if (!isRecord(value)) return ["procedure must be an object"];
  const errors: string[] = [];
  if (!Array.isArray(value.phases) || !Array.isArray(value.steps)) return ["procedure phases and steps must be arrays"];
  if (value.steps.some((step) => !isRecord(step))) return ["procedure steps must be objects"];
  const structurallyUsable = value.steps.every((step) => {
    const record = step as Record<string, unknown>;
    return ["dependsOn", "instanceIds", "requirementIds", "stopConditions", "failureBranchStepIds", "evidenceRefs"].every((field) => isStringArray(record[field]))
      && isRecord(record.dependencyHashes);
  });
  if (!structurallyUsable) return ["procedure step collections/dependencyHashes invalid"];
  const procedure = value as unknown as BuildProcedure;
  if (Object.keys(procedure).some((key) => !["procedureId", "inputEvaluationHash", "procedureSafetyHash", "phases", "steps"].includes(key))) errors.push("procedure contains topology, requirement-spec, observation or unknown fields");
  if (procedure.phases.length === 0 || procedure.steps.length === 0) errors.push("procedure requires at least one phase and step");
  if (!procedure.procedureId || !isSha256Hex(procedure.inputEvaluationHash) || !isSha256Hex(procedure.procedureSafetyHash)) errors.push("procedure identity/hashes invalid");
  if (!context
    || !context.evaluatorArtifactRef || !context.evaluatorVersion || !isSha256Hex(context.evaluatorArtifactHash)
    || !isSha256Hex(context.expectedInputEvaluationHash) || !isSha256Hex(context.expectedProcedureSafetyHash)
    || !isRecord(context.expectedStepDependencyHashes)) {
    errors.push("procedure requires a governed dependency context");
  } else {
    if (procedure.inputEvaluationHash !== context.expectedInputEvaluationHash) errors.push("procedure inputEvaluationHash differs from authoritative evaluation");
    if (procedure.procedureSafetyHash !== context.expectedProcedureSafetyHash) errors.push("procedureSafetyHash differs from authoritative safety artifact");
  }
  const phaseSet = new Set(procedure.phases);
  if (procedure.phases.some((phase) => !["prepare", "bench_test", "mechanical", "wiring", "firmware", "first_power", "system_install", "verification"].includes(String(phase)))) errors.push("procedure phase invalid");
  if (phaseSet.size !== procedure.phases.length) errors.push("procedure phases must not repeat");
  const stepIds = new Set(procedure.steps.map((step) => step.stepId));
  if (stepIds.size !== procedure.steps.length) errors.push("procedure stepId must be unique");
  for (const step of procedure.steps) {
    if (Object.keys(step).some((key) => !["stepId", "phase", "action", "dependsOn", "instanceIds", "requirementIds", "expectedResult", "failureAction", "riskLevel", "stopConditions", "failureBranchStepIds", "confirmationPolicy", "safetyCritical", "dependencyHashes", "dependencyHash", "evidenceRefs"].includes(key))) errors.push(`${step.stepId}: step contains unknown fields`);
    if (!phaseSet.has(step.phase)) errors.push(`${step.stepId}: phase is not declared by procedure`);
    if (step.dependsOn.some((dependency) => !stepIds.has(dependency) || dependency === step.stepId)) errors.push(`${step.stepId}: dependency missing or self-referential`);
    if (step.failureBranchStepIds.some((branch) => !stepIds.has(branch) || branch === step.stepId)) errors.push(`${step.stepId}: failure branch missing or self-referential`);
    if ((step.riskLevel === "safety_critical" || step.riskLevel === "destructive") && !step.safetyCritical) errors.push(`${step.stepId}: high-risk step must be safetyCritical`);
    if (step.safetyCritical && step.confirmationPolicy === "none") errors.push(`${step.stepId}: safety step requires confirmation`);
    if (!step.stepId || !step.action || !step.expectedResult || !step.failureAction || !isSha256Hex(step.dependencyHash)) errors.push(`${step.stepId}: executable procedure fields missing or dependencyHash invalid`);
    if (context && isRecord(context.expectedStepDependencyHashes) && context.expectedStepDependencyHashes[step.stepId] !== step.dependencyHash) errors.push(`${step.stepId}: dependencyHash differs from authoritative recomputation`);
    const dependencyEntries = Object.entries(step.dependencyHashes);
    if (dependencyEntries.some(([field, hash]) => !(DOMAIN_HASH_FIELDS as readonly string[]).includes(field) || !isSha256Hex(hash))) errors.push(`${step.stepId}: dependencyHashes invalid`);
    if (step.safetyCritical && dependencyEntries.length === 0) errors.push(`${step.stepId}: safety step requires domain dependency hashes`);
    if (step.safetyCritical && step.dependencyHashes.procedureSafetyHash !== procedure.procedureSafetyHash) errors.push(`${step.stepId}: safety step must bind current procedureSafetyHash`);
    if (step.safetyCritical && (step.stopConditions.length === 0 || step.evidenceRefs.length === 0)) errors.push(`${step.stepId}: safety step requires stop conditions and evidence`);
  }
  if (context && isRecord(context.expectedStepDependencyHashes)) {
    const expectedIds = Object.keys(context.expectedStepDependencyHashes);
    if (expectedIds.some((stepId) => !stepIds.has(stepId))) errors.push("dependency context contains an unknown step");
  }
  const stepById = new Map(procedure.steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const dependency of stepById.get(stepId)?.dependsOn ?? []) if (stepById.has(dependency) && hasCycle(dependency)) return true;
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  if (procedure.steps.some((step) => hasCycle(step.stepId))) errors.push("procedure dependencies contain a cycle");
  return errors;
}

/** Server-facing procedure gate; dependency hashes are loaded by stable ref. */
export async function validateBuildProcedureAuthoritatively(
  value: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<ProcedureDependencyContext, "procedure-dependency-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<ProcedureDependencyContext, "procedure-dependency-context">(
    resolver,
    "procedure-dependency-context",
    contextRef,
  );
  if (!resolved.ok) return [`procedure authoritative context resolution failed: ${resolved.error}`];
  return validateBuildProcedure(value, resolved.value);
}

export function validateExecutionSession(sessionValue: unknown, procedureValue: unknown, context?: ProcedureDependencyContext): string[] {
  if (!isRecord(sessionValue)) return ["execution session must be an object"];
  if (validateBuildProcedure(procedureValue, context).length > 0 || !isRecord(procedureValue)) return ["execution session procedure is invalid"];
  if (!Array.isArray(sessionValue.results) || sessionValue.results.some((result) => !isRecord(result))) return ["execution session results must be object records"];
  const session = sessionValue as unknown as ExecutionSession;
  const procedure = procedureValue as unknown as BuildProcedure;
  const errors: string[] = [];
  if (Object.keys(sessionValue).some((key) => !["executionSessionId", "planVersionId", "procedureId", "evaluationHash", "procedureSafetyHash", "status", "staleReason", "results"].includes(key))) errors.push("execution session contains unknown fields");
  if (!session.executionSessionId || !session.planVersionId || !isSha256Hex(session.evaluationHash) || !isSha256Hex(session.procedureSafetyHash)) errors.push("session identity/hashes invalid");
  if (!["active", "completed", "stale", "abandoned"].includes(String(session.status))) errors.push("execution session status invalid");
  if (session.procedureId !== procedure.procedureId) errors.push("session procedureId mismatch");
  if (session.procedureSafetyHash !== procedure.procedureSafetyHash) errors.push("session procedureSafetyHash mismatch");
  const stepById = new Map(procedure.steps.map((step) => [step.stepId, step]));
  const seen = new Set<string>();
  for (const result of session.results) {
    if (Object.keys(result).some((key) => !["stepId", "result", "at", "actor", "confirmedAgainstDependencyHash", "note", "observationIds"].includes(key))) errors.push(`${result.stepId}: result contains unknown fields`);
    const step = stepById.get(result.stepId);
    if (!step) { errors.push(`${result.stepId}: result references missing step`); continue; }
    if (seen.has(result.stepId)) errors.push(`${result.stepId}: duplicate result`);
    seen.add(result.stepId);
    if (!Number.isFinite(Date.parse(result.at)) || result.actor !== "user" || !isSha256Hex(result.confirmedAgainstDependencyHash)) errors.push(`${result.stepId}: result audit binding invalid`);
    if (!["confirmed", "failed", "skipped_non_safety"].includes(String(result.result))) errors.push(`${result.stepId}: result state invalid`);
    if (result.observationIds !== undefined && (!isStringArray(result.observationIds) || result.observationIds.some((id) => !id))) errors.push(`${result.stepId}: result observationIds invalid`);
    if (result.result === "skipped_non_safety" && step.safetyCritical) errors.push(`${result.stepId}: safety step cannot be skipped`);
    if ((session.status === "active" || session.status === "completed") && result.confirmedAgainstDependencyHash !== step.dependencyHash) errors.push(`${result.stepId}: current session result has a stale dependency hash`);
  }
  const resultById = new Map(session.results.map((result) => [result.stepId, result]));
  for (const result of session.results) {
    if (result.result === "failed") continue;
    const step = stepById.get(result.stepId);
    if (!step) continue;
    for (const dependencyId of step.dependsOn) {
      const dependencyResult = resultById.get(dependencyId);
      if (dependencyResult?.result !== "confirmed") errors.push(`${result.stepId}: dependency ${dependencyId} is not confirmed`);
      else if (Date.parse(dependencyResult.at) > Date.parse(result.at)) errors.push(`${result.stepId}: dependency ${dependencyId} was confirmed later`);
    }
  }
  if (session.status === "completed") {
    if (procedure.steps.some((step) => !session.results.some((result) => result.stepId === step.stepId && (result.result === "confirmed" || (!step.safetyCritical && result.result === "skipped_non_safety"))))) errors.push("completed session has an unresolved procedure step");
    if (session.results.some((result) => result.result === "failed")) errors.push("completed session cannot contain failed results");
  }
  if (session.status === "stale" && !session.staleReason) errors.push("stale session requires staleReason");
  if (session.status !== "stale" && session.staleReason) errors.push("only a stale session may carry staleReason");
  return errors;
}

/** Server-facing execution gate; procedure and dependency context are resolved together. */
export async function validateExecutionSessionAuthoritatively(
  sessionValue: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<ExecutionValidationContext, "execution-validation-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<ExecutionValidationContext, "execution-validation-context">(
    resolver,
    "execution-validation-context",
    contextRef,
  );
  if (!resolved.ok) return [`execution authoritative context resolution failed: ${resolved.error}`];
  return validateExecutionSession(sessionValue, resolved.value.procedure, resolved.value.dependencyContext);
}

/** Selective invalidation compares per-step dependency hashes, not the audit evaluation hash. */
export function staleExecutionStepIds(session: ExecutionSession, procedure: BuildProcedure): string[] {
  const currentSteps = new Map(procedure.steps.map((step) => [step.stepId, step]));
  return session.results.filter((result) => currentSteps.get(result.stepId)?.dependencyHash !== result.confirmedAgainstDependencyHash).map((result) => result.stepId);
}

export function validateFirmwarePlan(value: unknown): string[] {
  if (!isRecord(value)) return ["firmware plan must be an object"];
  const plan = value as Partial<FirmwarePlan> & Record<string, unknown>;
  const errors: string[] = [];
  const planFields = ["firmwarePlanId", "instanceId", "status", "inputHash", "currentVersionObservationId", "currentReleaseFactId", "versionIdentification", "minimumVersionFactIds", "targetVersionFactIds", "transitions", "derivedRequirementIds", "requiredSettings"];
  if (Object.keys(plan).some((key) => !planFields.includes(key))) errors.push("firmware plan contains unknown fields");
  if (!plan.firmwarePlanId || !plan.instanceId || !isSha256Hex(plan.inputHash)) errors.push("firmware plan identity/inputHash invalid");
  if (plan.status !== "pass" && plan.status !== "fail" && plan.status !== "blocked") errors.push("firmware plan status invalid");
  if (plan.currentVersionObservationId !== undefined && (typeof plan.currentVersionObservationId !== "string" || !plan.currentVersionObservationId)) errors.push("current firmware observation ID invalid");
  if (plan.currentReleaseFactId !== undefined && (typeof plan.currentReleaseFactId !== "string" || !plan.currentReleaseFactId)) errors.push("current firmware release fact ID invalid");
  if (!isRecord(plan.versionIdentification) || typeof plan.versionIdentification.observationFieldId !== "string" || !isStringArray(plan.versionIdentification.evidenceRefs) || plan.versionIdentification.evidenceRefs.length === 0) errors.push("firmware version identification requires observation field and evidence");
  const transitions = Array.isArray(plan.transitions) ? plan.transitions : [];
  if (!Array.isArray(plan.transitions)) errors.push("firmware transitions must be an array");
  if (transitions.some((transition) => !isRecord(transition))) errors.push("firmware transitions must contain objects");
  const usableTransitions = transitions.filter(isRecord) as unknown as FirmwareTransition[];
  const transitionIds = new Set(usableTransitions.map((transition) => transition.transitionId));
  if (transitionIds.size !== usableTransitions.length || usableTransitions.some((transition) => !transition.transitionId)) errors.push("firmware transitionId must be non-empty and unique");
  for (const transition of usableTransitions) {
    const transitionFields = ["transitionId", "fromReleaseFactId", "toReleaseFactId", "method", "requiresWorkingCpu", "requirementIds", "temporaryHardwareRequirementIds", "firmwareFileFactId", "media", "powerPrerequisiteRequirementIds", "recoveryTransitionIds", "resetsSettings", "releaseFactIds", "officialProcedureEvidenceRefs"];
    if (Object.keys(transition).some((key) => !transitionFields.includes(key))) errors.push(`${transition.transitionId}: transition contains unknown fields`);
    if (!transition.fromReleaseFactId || !transition.toReleaseFactId || transition.fromReleaseFactId === transition.toReleaseFactId) errors.push(`${transition.transitionId}: transition endpoints invalid`);
    if (!["uefi", "usb_flashback", "bmc", "os_tool"].includes(String(transition.method)) || typeof transition.requiresWorkingCpu !== "boolean" || typeof transition.resetsSettings !== "boolean") errors.push(`${transition.transitionId}: transition method/flags invalid`);
    for (const field of ["requirementIds", "temporaryHardwareRequirementIds", "powerPrerequisiteRequirementIds", "releaseFactIds", "officialProcedureEvidenceRefs"] as const) {
      if (!isStringArray(transition[field]) || transition[field].some((id) => !id) || new Set(transition[field]).size !== transition[field].length) errors.push(`${transition.transitionId}: ${field} invalid`);
    }
    if (!isStringArray(transition.recoveryTransitionIds)) errors.push(`${transition.transitionId}: recovery transitions invalid`);
    else {
      if (transition.recoveryTransitionIds.some((id) => !transitionIds.has(id))) errors.push(`${transition.transitionId}: recovery transition missing`);
      if (transition.recoveryTransitionIds.includes(transition.transitionId)) errors.push(`${transition.transitionId}: recovery transition cannot reference itself`);
    }
    if (transition.method === "usb_flashback" && transition.requiresWorkingCpu) errors.push(`${transition.transitionId}: USB flashback must not require a working CPU`);
    if (!isRecord(transition.media) || !transition.media.fileName || !transition.media.format || !transition.media.checksumFactId || !isStringArray(transition.officialProcedureEvidenceRefs) || transition.officialProcedureEvidenceRefs.length === 0) errors.push(`${transition.transitionId}: media/checksum/official procedure incomplete`);
  }
  if (!isStringArray(plan.minimumVersionFactIds) || !isStringArray(plan.targetVersionFactIds) || !isStringArray(plan.derivedRequirementIds) || !Array.isArray(plan.requiredSettings)) errors.push("firmware fact/requirement/settings collections invalid");
  else for (const [index, setting] of plan.requiredSettings.entries()) {
    if (!isRecord(setting) || Object.keys(setting).some((key) => !["key", "value", "reason", "evidenceRefs"].includes(key))
      || validateFirmwareSettingValue(setting.key, setting.value).length > 0
      || typeof setting.reason !== "string" || !setting.reason || !isStringArray(setting.evidenceRefs) || setting.evidenceRefs.length === 0) errors.push(`firmware requiredSettings.${index} invalid`);
  }
  const targetVersionFactIds = isStringArray(plan.targetVersionFactIds) ? plan.targetVersionFactIds : [];
  if ((plan.currentVersionObservationId === undefined) !== (plan.currentReleaseFactId === undefined)) errors.push("current firmware observation and release fact must be bound together");
  if (plan.status === "pass" && (!plan.currentVersionObservationId || !plan.currentReleaseFactId)) errors.push("passing firmware plan requires a currently observed release");
  if (plan.status === "pass" && targetVersionFactIds.length === 0) errors.push("passing firmware plan requires a target release");
  if (plan.status === "pass" && plan.currentReleaseFactId) {
    const reachable = new Set<string>([plan.currentReleaseFactId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of usableTransitions) {
        if (reachable.has(transition.fromReleaseFactId) && !reachable.has(transition.toReleaseFactId)) {
          reachable.add(transition.toReleaseFactId);
          changed = true;
        }
      }
    }
    if (targetVersionFactIds.some((target) => !reachable.has(target))) errors.push("target firmware release is not reachable from the currently observed release");
  }
  return errors;
}
