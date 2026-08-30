import type { BuildProcedure, BuildProcedureStep, ProcedureDependencyContext } from "../build-execution/contracts";
import type { DomainHashes } from "../hash";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import { canonicalJson } from "../plans/canonical";
import type { RequirementNode, RequirementSatisfaction } from "../requirements/contracts";
import { validateRequirementNodeRuntime, validateRequirementSatisfactionRuntime } from "../requirements/runtime.mjs";
import type { CableRouteResult } from "../routing";
import type { BuildConfigV3 } from "../topology/contracts";

export interface AssemblyOrderConstraint {
  readonly constraintId: string;
  readonly beforeStepId: string;
  readonly afterStepId: string;
  readonly evidenceRefs: readonly string[];
}

export interface AssemblyStepResourceProjection {
  readonly stepId: string;
  readonly ready: boolean;
  readonly requirementIds: readonly string[];
  readonly accessoryRefs: readonly string[];
  readonly toolRefs: readonly string[];
  readonly cableRefs: readonly string[];
  readonly consumableRefs: readonly string[];
  readonly unresolvedRequirementIds: readonly string[];
}

export interface GeneratedAssemblyProcedure {
  readonly procedure: BuildProcedure;
  readonly dependencyContext: ProcedureDependencyContext;
  readonly resources: readonly AssemblyStepResourceProjection[];
}

export interface GenerateAssemblyProcedureInput {
  readonly planVersionId: string;
  readonly config: BuildConfigV3;
  readonly evaluationHash: string;
  readonly domainHashes: DomainHashes;
  readonly requirements: readonly RequirementNode[];
  readonly satisfactions: readonly RequirementSatisfaction[];
  readonly routes: readonly CableRouteResult[];
  readonly constraints: readonly AssemblyOrderConstraint[];
  readonly evaluatorArtifactRef: `sha256:${string}` | `evaluation-artifact:${string}`;
  readonly evaluatorArtifactHash: string;
  readonly evaluatorVersion: string;
  readonly alternativeRouteNodeIds?: Readonly<Record<string, readonly string[]>>;
}

function digest(domain: string, value: unknown): string {
  const hash = sha256Utf8Runtime(`buildsim:${domain}:${canonicalJson(value)}`);
  if (hash === null) throw new TypeError(`${domain} cannot be hashed`);
  return hash;
}

function routeInstances(route: CableRouteResult): string[] {
  const endpointInstances = [route.fromPortKey, route.toPortKey].map((value) => value.split(":")[0]!).filter(Boolean);
  return [...new Set([route.cableInstanceId, ...endpointInstances])].sort();
}

function resourceProjection(
  stepId: string,
  requirementIds: readonly string[],
  requirementById: ReadonlyMap<string, RequirementNode>,
  satisfactionById: ReadonlyMap<string, RequirementSatisfaction>,
): AssemblyStepResourceProjection {
  const refs: Record<"accessoryRefs" | "toolRefs" | "cableRefs" | "consumableRefs", string[]> = {
    accessoryRefs: [], toolRefs: [], cableRefs: [], consumableRefs: [],
  };
  const unresolved: string[] = [];
  for (const requirementId of requirementIds) {
    const requirement = requirementById.get(requirementId)!;
    const satisfaction = satisfactionById.get(requirementId);
    if (!satisfaction || satisfaction.status !== "satisfied" || satisfaction.residualQuantity !== 0) {
      unresolved.push(requirementId); continue;
    }
    const target = requirement.kind === "tool" ? refs.toolRefs
      : requirement.kind === "cable" ? refs.cableRefs
        : requirement.kind === "consumable" ? refs.consumableRefs : refs.accessoryRefs;
    target.push(...satisfaction.allocations.map(({ refId }) => refId));
  }
  return {
    stepId,
    ready: unresolved.length === 0,
    requirementIds: [...requirementIds].sort(),
    accessoryRefs: [...new Set(refs.accessoryRefs)].sort(),
    toolRefs: [...new Set(refs.toolRefs)].sort(),
    cableRefs: [...new Set(refs.cableRefs)].sort(),
    consumableRefs: [...new Set(refs.consumableRefs)].sort(),
    unresolvedRequirementIds: unresolved.sort(),
  };
}

export function generateAssemblyProcedure(input: GenerateAssemblyProcedureInput): GeneratedAssemblyProcedure {
  const requirementById = new Map(input.requirements.map((entry) => [entry.requirementId, entry]));
  const satisfactionById = new Map(input.satisfactions.map((entry) => [entry.requirementId, entry]));
  if (requirementById.size !== input.requirements.length || satisfactionById.size !== input.satisfactions.length
    || input.requirements.some((entry) => validateRequirementNodeRuntime(entry).length > 0)
    || input.satisfactions.some((entry) => validateRequirementSatisfactionRuntime(requirementById.get(entry.requirementId), entry).length > 0)
    || input.satisfactions.some((entry) => !requirementById.has(entry.requirementId))) {
    throw new TypeError("assembly procedure requirement authority is invalid");
  }
  const procedureSafetyHash = digest("assembly-procedure-safety-v1", {
    planVersionId: input.planVersionId,
    evaluationHash: input.evaluationHash,
    compatibilityHash: input.domainHashes.compatibilityHash,
    spatialHash: input.domainHashes.spatialHash,
    safetyRequirementIds: input.requirements.filter((entry) => entry.criticality === "safety").map(({ requirementId }) => requirementId).sort(),
    routeVerdicts: input.routes.map(({ cableInstanceId, verdict, reason }) => ({ cableInstanceId, verdict, reason })).sort((left, right) => left.cableInstanceId.localeCompare(right.cableInstanceId)),
  });
  const resources: AssemblyStepResourceProjection[] = [];
  const steps: BuildProcedureStep[] = [];
  const componentById = new Map(input.config.components.map((component) => [component.instanceId, component]));
  const placementByComponent = new Map(input.config.placements.map((placement) => [placement.componentInstanceId, placement]));
  const requirementsFor = (instanceIds: readonly string[]) => input.requirements
    .filter((requirement) => requirement.producedBy.instanceIds.some((instanceId) => instanceIds.includes(instanceId)))
    .map(({ requirementId }) => requirementId).sort();
  const addStep = (
    base: Omit<BuildProcedureStep, "dependencyHash" | "dependencyHashes">,
    routeClosure: unknown,
  ) => {
    const projection = resourceProjection(base.stepId, base.requirementIds, requirementById, satisfactionById);
    resources.push(projection);
    const dependencyHashes = {
      compatibilityHash: input.domainHashes.compatibilityHash,
      spatialHash: input.domainHashes.spatialHash,
      ...(base.safetyCritical ? { procedureSafetyHash } : {}),
    };
    const dependencyHash = digest("assembly-step-dependency-v1", {
      planVersionId: input.planVersionId,
      stepId: base.stepId,
      instanceIds: base.instanceIds,
      requirementIds: base.requirementIds,
      satisfactionState: base.requirementIds.map((id) => satisfactionById.get(id) ?? null),
      routeClosure,
      dependencyHashes,
    });
    steps.push({ ...base, dependencyHashes, dependencyHash });
  };
  for (const placement of [...input.config.placements].sort((left, right) => left.placementId.localeCompare(right.placementId))) {
    const component = componentById.get(placement.componentInstanceId);
    const owner = componentById.get(placement.mountOwnerInstanceId);
    if (!component || !owner) throw new TypeError("assembly placement references an absent topology instance");
    const stepId = `mechanical:${placement.placementId}`;
    const parentPlacement = placementByComponent.get(placement.mountOwnerInstanceId);
    const requirementIds = requirementsFor([component.instanceId, owner.instanceId]);
    addStep({
      stepId, phase: "mechanical",
      action: `Install ${component.instanceId} at ${owner.instanceId}:${placement.mountId} using only the allocated accessories, fasteners, tools and consumables.`,
      dependsOn: parentPlacement ? [`mechanical:${parentPlacement.placementId}`] : [],
      instanceIds: [component.instanceId, owner.instanceId].sort(), requirementIds,
      expectedResult: "The component is seated at the governed mount and required service space remains clear.",
      failureAction: "Remove the component and use the declared alternative access path; do not force the part or fastener.",
      riskLevel: input.requirements.some((entry) => requirementIds.includes(entry.requirementId) && entry.criticality === "safety") ? "safety_critical" : "caution",
      stopConditions: ["mount identity differs", "fastener or tool requirement is unresolved", "insertion sweep is blocked"],
      failureBranchStepIds: [], confirmationPolicy: "observation_required", safetyCritical: true,
      evidenceRefs: input.requirements.filter((entry) => requirementIds.includes(entry.requirementId)).flatMap((entry) => entry.evidenceRefs).sort(),
    }, { placement });
  }
  for (const route of [...input.routes].sort((left, right) => left.cableInstanceId.localeCompare(right.cableInstanceId))) {
    const stepId = `wiring:${route.cableInstanceId}`;
    const instanceIds = routeInstances(route);
    if (instanceIds.some((instanceId) => !componentById.has(instanceId))) throw new TypeError("assembly route references an absent topology instance");
    const endpointDependencies = instanceIds.flatMap((instanceId) => {
      const placement = placementByComponent.get(instanceId);
      return placement ? [`mechanical:${placement.placementId}`] : [];
    });
    const requirementIds = requirementsFor(instanceIds);
    const alternatives = input.alternativeRouteNodeIds?.[route.cableInstanceId] ?? [];
    addStep({
      stepId, phase: "wiring",
      action: `Route ${route.cableInstanceId} through ${route.nodeIds.join(" → ") || "no verified path"}; preserve the checked bend radius and service loop.`,
      dependsOn: [...new Set(endpointDependencies)].sort(), instanceIds, requirementIds,
      expectedResult: "Both unique endpoints are connected and the cable remains inside capacity, length and bend limits.",
      failureAction: alternatives.length > 0
        ? `Stop and use alternative route ${alternatives.join(" → ")}.`
        : "Stop and obtain a longer/right-angle cable or a governed alternative route.",
      riskLevel: route.verdict === "pass" ? "caution" : "safety_critical",
      stopConditions: [
        ...(route.verdict === "pass" ? [] : [`route is ${route.verdict}: ${route.reason}`]),
        "connector keying or pinout differs", "bundle/opening capacity is exceeded", "minimum bend radius cannot be maintained",
      ],
      failureBranchStepIds: [], confirmationPolicy: "observation_required", safetyCritical: true,
      evidenceRefs: input.requirements.filter((entry) => requirementIds.includes(entry.requirementId)).flatMap((entry) => entry.evidenceRefs).sort(),
    }, route);
  }
  const stepById = new Map(steps.map((step) => [step.stepId, step]));
  const constraintIds = new Set<string>();
  for (const constraint of input.constraints) {
    if (!constraint.constraintId || constraintIds.has(constraint.constraintId)
      || !stepById.has(constraint.beforeStepId) || !stepById.has(constraint.afterStepId)
      || constraint.beforeStepId === constraint.afterStepId) throw new TypeError("assembly order constraint is invalid");
    constraintIds.add(constraint.constraintId);
    const after = stepById.get(constraint.afterStepId)!;
    const replaced = { ...after, dependsOn: [...new Set([...after.dependsOn, constraint.beforeStepId])].sort(), evidenceRefs: [...new Set([...after.evidenceRefs, ...constraint.evidenceRefs])].sort() };
    stepById.set(replaced.stepId, replaced);
    steps[steps.findIndex(({ stepId }) => stepId === replaced.stepId)] = replaced;
  }
  const pending = new Set(steps.map(({ stepId }) => stepId));
  const ordered: BuildProcedureStep[] = [];
  while (pending.size) {
    const ready = steps.filter((step) => pending.has(step.stepId) && step.dependsOn.every((dependency) => !pending.has(dependency)))
      .sort((left, right) => left.stepId.localeCompare(right.stepId));
    if (!ready.length) throw new TypeError("assembly procedure dependencies contain a cycle");
    for (const step of ready) { pending.delete(step.stepId); ordered.push(step); }
  }
  const phases = (["mechanical", "wiring"] as const).filter((phase) => ordered.some((step) => step.phase === phase));
  const procedureBase = { inputEvaluationHash: input.evaluationHash, procedureSafetyHash, phases, steps: ordered };
  const procedure: BuildProcedure = {
    procedureId: `procedure.${input.planVersionId}.${digest("assembly-procedure-v1", procedureBase)}`,
    ...procedureBase,
  };
  const dependencyContext: ProcedureDependencyContext = {
    evaluatorArtifactRef: input.evaluatorArtifactRef,
    evaluatorArtifactHash: input.evaluatorArtifactHash,
    evaluatorVersion: input.evaluatorVersion,
    expectedInputEvaluationHash: input.evaluationHash,
    expectedProcedureSafetyHash: procedureSafetyHash,
    expectedStepDependencyHashes: Object.fromEntries(ordered.map(({ stepId, dependencyHash }) => [stepId, dependencyHash])),
  };
  return { procedure, dependencyContext, resources: resources.sort((left, right) => left.stepId.localeCompare(right.stepId)) };
}
