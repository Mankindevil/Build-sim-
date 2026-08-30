import {
  allocateRequirementSuppliesRuntime,
  requirementArtifactContentHashRuntime,
  validateRequirementAllocationResultRuntime,
  validateRequirementNodeRuntime,
} from "../requirements/runtime.mjs";
import {
  evaluateFirmwarePathRuntime,
  projectFirmwareCandidateRequirementsRuntime,
  validateFirmwarePathEvaluationRuntime,
} from "./runtime.mjs";

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function exact(value, required, optional = []) {
  return record(value) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function sorted(value) { return [...value].map((item) => item.normalize("NFC")).sort(compare); }
function normalizedPreflight(value) {
  return {
    workingCpuAvailable: value?.workingCpuAvailable ?? null,
    workingMemoryAvailable: value?.workingMemoryAvailable ?? null,
    displayPathAvailable: value?.displayPathAvailable ?? null,
  };
}
function normalizeBaseInput(input) {
  const fields = ["capability", "instanceId", "currentObservation", "cpuSkuId", "targetReleaseFactId",
    "availableRequirementIds", "availableFactIds", "preflight", "transitionTemporaryHardwareRequirements",
    "requestedSettings", "requireRecovery"];
  if (!exact(input, ["capability", "instanceId"], fields.filter((field) => !["capability", "instanceId"].includes(field)))) {
    throw new TypeError("firmware path input shape invalid");
  }
  if (input.preflight !== undefined && (!record(input.preflight)
    || Object.keys(input.preflight).some((key) => !["workingCpuAvailable", "workingMemoryAvailable", "displayPathAvailable"].includes(key)))) {
    throw new TypeError("firmware preflight input shape invalid");
  }
  if (input.transitionTemporaryHardwareRequirements !== undefined
    && (!Array.isArray(input.transitionTemporaryHardwareRequirements)
      || input.transitionTemporaryHardwareRequirements.some((entry) => !exact(entry, ["transitionId", "requirementIds"])))) {
    throw new TypeError("firmware temporary requirements input shape invalid");
  }
  if (input.requestedSettings !== undefined && (!Array.isArray(input.requestedSettings)
    || input.requestedSettings.some((setting) => !exact(setting, ["settingId", "desiredValue", "evidenceRefs"])))) {
    throw new TypeError("firmware requested settings input shape invalid");
  }
  const availableRequirementIds = [...(input.availableRequirementIds ?? [])];
  if (availableRequirementIds.length > 0) throw new TypeError("firmware fixed-point availability must be derived from allocation");
  return {
    capability: input.capability,
    instanceId: input.instanceId,
    currentObservation: input.currentObservation === undefined || input.currentObservation === null ? null : {
      ...structuredClone(input.currentObservation),
      evidenceRefs: sorted(input.currentObservation.evidenceRefs),
    },
    cpuSkuId: input.cpuSkuId ?? null,
    targetReleaseFactId: input.targetReleaseFactId ?? null,
    availableRequirementIds: [],
    availableFactIds: sorted(input.availableFactIds ?? []),
    preflight: normalizedPreflight(input.preflight),
    transitionTemporaryHardwareRequirements: [...(input.transitionTemporaryHardwareRequirements ?? [])].map((entry) => ({
      transitionId: entry.transitionId,
      requirementIds: sorted(entry.requirementIds),
    })).sort((left, right) => compare(left.transitionId, right.transitionId)),
    requestedSettings: [...(input.requestedSettings ?? [])].map((setting) => ({
      settingId: setting.settingId,
      desiredValue: setting.desiredValue,
      evidenceRefs: sorted(setting.evidenceRefs),
    })).sort((left, right) => compare(left.settingId, right.settingId)),
    requireRecovery: input.requireRecovery ?? false,
  };
}
function structuralRequirementHash(requirement) {
  const hash = requirementArtifactContentHashRuntime({ ...requirement, evidenceRefs: [] }, "firmware-fixed-point-requirement-v1");
  if (hash === null) throw new TypeError("firmware fixed-point requirement cannot be canonicalized");
  return hash;
}
function addRequirement(byId, input) {
  const errors = validateRequirementNodeRuntime(input);
  if (errors.length) throw new TypeError(`Invalid firmware fixed-point requirement: ${errors.join("; ")}`);
  const requirement = structuredClone(input); const existing = byId.get(requirement.requirementId);
  if (existing === undefined) { byId.set(requirement.requirementId, requirement); return; }
  if (structuralRequirementHash(existing) !== structuralRequirementHash(requirement)) {
    throw new TypeError(`Conflicting firmware fixed-point requirement: ${requirement.requirementId}`);
  }
  byId.set(requirement.requirementId, {
    ...existing,
    evidenceRefs: [...new Set([...existing.evidenceRefs, ...requirement.evidenceRefs])].sort(compare),
  });
}
function addRequirements(byId, values) { for (const value of values) addRequirement(byId, value); }
function sortedRequirements(byId) {
  return [...byId.values()].map((value) => structuredClone(value))
    .sort((left, right) => compare(left.requirementId, right.requirementId));
}
function satisfiedIds(allocation) {
  return allocation.satisfactions.filter(({ status }) => status === "satisfied")
    .map(({ requirementId }) => requirementId).sort(compare);
}
function scopedOptions(options, requirements) {
  if (options === undefined) return {};
  const ids = new Set(requirements.map(({ requirementId }) => requirementId));
  return {
    ...(options.safetyCheckpoints === undefined ? {} : { safetyCheckpoints: options.safetyCheckpoints }),
    ...(options.checkpointByRequirement === undefined ? {} : { checkpointByRequirement: options.checkpointByRequirement }),
    ...(options.blockedRequirementIds === undefined ? {} : {
      blockedRequirementIds: options.blockedRequirementIds.filter((requirementId) => ids.has(requirementId)),
    }),
  };
}
function evaluationInput(base, availableRequirementIds) {
  return { ...base, availableRequirementIds: [...availableRequirementIds].sort(compare) };
}
function evaluationSelectionKey(evaluation) {
  return JSON.stringify({
    targetReleaseFactId: evaluation.targetReleaseFactId,
    selectedTransitionIds: evaluation.selectedTransitions.map(({ transitionId }) => transitionId),
    recoveryTransitionIds: evaluation.recovery.transitionIds,
    derivedRequirementHashes: evaluation.derivedRequirements.map((requirement) => (
      requirementArtifactContentHashRuntime(requirement, "firmware-fixed-point-derived-v1")
    )),
    settingsReset: evaluation.settingsReset,
  });
}
function routeKey(evaluation) {
  return JSON.stringify({
    targetReleaseFactId: evaluation.targetReleaseFactId,
    reason: evaluation.selectedTransitions.length === 0 ? evaluation.reason : null,
    forward: evaluation.selectedTransitions.map(({ transitionId }) => transitionId),
    recovery: evaluation.recovery.transitionIds,
  });
}
function routeOutcomeKey(evaluation) {
  return JSON.stringify({ route: routeKey(evaluation), verdict: evaluation.verdict, reason: evaluation.reason,
    selection: evaluationSelectionKey(evaluation) });
}
function evaluated(base, available) {
  const result = evaluateFirmwarePathRuntime(evaluationInput(base, available));
  const errors = validateFirmwarePathEvaluationRuntime(result, base.capability);
  if (errors.length) throw new TypeError(`firmware path replay invalid: ${errors.join("; ")}`);
  return result;
}
function discoverRouteOptions(base, candidateIds) {
  const all = [...candidateIds].sort(compare); const queue = [[]]; const scheduled = new Set([""]); const byOutcome = new Map();
  let processed = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const excluded = queue[cursor];
    processed += 1;
    if (processed > 4_096) throw new Error(`firmware route candidate search truncated for ${base.instanceId}`);
    const excludedSet = new Set(excluded);
    const evaluation = evaluated(base, all.filter((requirementId) => !excludedSet.has(requirementId)));
    const outcomeKey = routeOutcomeKey(evaluation);
    if (!byOutcome.has(outcomeKey)) byOutcome.set(outcomeKey, evaluation);
    const branchIds = evaluation.derivedRequirements.map(({ requirementId }) => requirementId)
      .filter((requirementId) => candidateIds.has(requirementId) && !excludedSet.has(requirementId)).sort(compare);
    for (const requirementId of branchIds) {
      const next = [...excluded, requirementId].sort(compare); const stateKey = next.join("\0");
      if (scheduled.has(stateKey)) continue;
      if (scheduled.size >= 4_096) throw new Error(`firmware route candidate search truncated for ${base.instanceId}`);
      scheduled.add(stateKey); queue.push(next);
    }
  }
  return [...byOutcome.values()].sort((left, right) => compare(routeOutcomeKey(left), routeOutcomeKey(right)));
}
function cartesian(groups) {
  let product = 1n;
  for (const group of groups) product *= BigInt(group.length);
  if (product === 0n || product > 4_096n) throw new Error("firmware route combination search truncated");
  let combinations = [[]];
  for (const group of groups) combinations = combinations.flatMap((prefix) => group.map((entry) => [...prefix, entry]));
  return combinations;
}
function compareScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]; const b = right[index]; if (a === b) continue;
    return typeof a === "number" && typeof b === "number" ? a - b : compare(String(a), String(b));
  }
  return 0;
}
function combinationScore(evaluations, allocation, rootIds) {
  const requirementById = new Map(allocation.requirements.map((requirement) => [requirement.requirementId, requirement]));
  const rootResidual = { safety: 0, boot: 0, normal: 0 };
  for (const satisfaction of allocation.satisfactions) {
    if (!rootIds.has(satisfaction.requirementId)) continue;
    const requirement = requirementById.get(satisfaction.requirementId);
    const bucket = requirement?.criticality === "safety" || requirement?.requiredBefore === "assembly"
      || requirement?.requiredBefore === "pre_power" ? "safety"
      : requirement?.criticality === "boot" || requirement?.requiredBefore === "first_boot" ? "boot" : "normal";
    rootResidual[bucket] += satisfaction.residualQuantity;
  }
  return [rootResidual.safety, rootResidual.boot,
    evaluations.filter(({ verdict }) => verdict !== "pass").length,
    evaluations.reduce((total, evaluation) => total + evaluation.missingRequirementIds.length
      + evaluation.missingPowerPrerequisiteFactIds.length + (evaluation.recovery.status === "unavailable" ? 1 : 0), 0),
    rootResidual.normal,
    evaluations.reduce((total, evaluation) => total + evaluation.selectedTransitions.length + evaluation.recovery.transitionIds.length, 0),
    evaluations.map(routeKey).join("\u0001")];
}

/** Single JS authority for online composition and offline restore replay. */
export function evaluateFirmwareRequirementBatchFixedPointRuntime(input) {
  if (!exact(input, ["baseInputs", "rootRequirements", "supplies"], ["allocationOptions", "maxIterations"])
    || !Array.isArray(input.baseInputs) || input.baseInputs.length === 0
    || !Array.isArray(input.rootRequirements) || !Array.isArray(input.supplies)) {
    throw new TypeError("firmware requirement batch fixed-point input invalid");
  }
  const maxIterations = input.maxIterations ?? 4_096;
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0 || maxIterations > 4_096) {
    throw new TypeError("firmware requirement fixed-point maxIterations must be an integer from 1 to 4096");
  }
  const bases = input.baseInputs.map(normalizeBaseInput).sort((left, right) => compare(left.instanceId, right.instanceId));
  if (new Set(bases.map(({ instanceId }) => instanceId)).size !== bases.length) throw new TypeError("firmware target IDs repeat");
  const candidatesByInstance = new Map(); const candidateIdsByInstance = new Map(); const allCandidates = new Map();
  for (const base of bases) {
    const candidates = projectFirmwareCandidateRequirementsRuntime(base);
    candidatesByInstance.set(base.instanceId, candidates);
    candidateIdsByInstance.set(base.instanceId, new Set(candidates.map(({ requirementId }) => requirementId)));
    addRequirements(allCandidates, candidates);
  }
  const candidateRequirements = sortedRequirements(allCandidates);
  const rootInputIds = input.rootRequirements.map((requirement) => requirement?.requirementId);
  if (new Set(rootInputIds).size !== rootInputIds.length
    || !input.rootRequirements.every((requirement, index) => index === 0
      || input.rootRequirements[index - 1].requirementId < requirement.requirementId)) {
    throw new TypeError("firmware fixed-point roots must be unique and canonically ordered");
  }
  const roots = new Map(); addRequirements(roots, input.rootRequirements);
  const injectedCandidateRoot = candidateRequirements.find(({ requirementId }) => roots.has(requirementId));
  if (injectedCandidateRoot !== undefined) {
    throw new TypeError(`firmware fixed-point static roots contain a route-derived requirement: ${injectedCandidateRoot.requirementId}`);
  }
  const optionGroups = bases.map((base) => discoverRouteOptions(base, candidateIdsByInstance.get(base.instanceId)));
  const combinations = cartesian(optionGroups);
  if (combinations.length > maxIterations) throw new Error("firmware route combination search exceeded maxIterations");
  let best = null; let bestScore = null; let examined = 0;
  for (const proposed of combinations) {
    examined += 1;
    const finalById = new Map(); addRequirements(finalById, [...roots.values()]);
    for (const evaluation of proposed) addRequirements(finalById, evaluation.derivedRequirements);
    const finalRequirements = sortedRequirements(finalById);
    const allocation = allocateRequirementSuppliesRuntime(
      finalRequirements, input.supplies, scopedOptions(input.allocationOptions, finalRequirements),
    );
    const satisfied = new Set(satisfiedIds(allocation)); const evaluations = []; const availabilityByInstance = [];
    for (const base of bases) {
      const requirementIds = [...candidateIdsByInstance.get(base.instanceId)]
        .filter((requirementId) => satisfied.has(requirementId)).sort(compare);
      evaluations.push(evaluated(base, requirementIds)); availabilityByInstance.push({ instanceId: base.instanceId, requirementIds });
    }
    const stable = proposed.every((evaluation, index) => routeKey(evaluation) === routeKey(evaluations[index])
      && evaluationSelectionKey(evaluation) === evaluationSelectionKey(evaluations[index]));
    if (!stable) continue;
    const score = combinationScore(evaluations, allocation, new Set(roots.keys()));
    if (bestScore === null || compareScore(score, bestScore) < 0) {
      bestScore = score;
      best = { evaluations, requirementAllocation: allocation, candidateRequirements: structuredClone(candidateRequirements),
        availabilityByInstance, iterations: examined, reachedFixedPoint: true };
    }
  }
  if (best === null) throw new Error("firmware requirement fixed-point has no allocation-stable route combination");
  best.iterations = examined;
  return best;
}

export function validateFirmwareRequirementBatchFixedPointReplayRuntime(value, context) {
  try {
    if (!exact(value, ["evaluations", "requirementAllocation"]) || !Array.isArray(value.evaluations)) {
      return ["firmware batch fixed-point persisted projection invalid"];
    }
    const errors = validateRequirementAllocationResultRuntime(value.requirementAllocation);
    value.evaluations.forEach((evaluation, index) => {
      const capability = context?.baseInputs?.find((input) => input?.instanceId === evaluation?.instanceId)?.capability;
      errors.push(...validateFirmwarePathEvaluationRuntime(evaluation, capability)
        .map((error) => `evaluations.${index}: ${error}`));
    });
    if (errors.length) return errors;
    const replay = evaluateFirmwareRequirementBatchFixedPointRuntime(context);
    const actualHash = requirementArtifactContentHashRuntime(value, "firmware-batch-fixed-point-projection-v1");
    const expectedHash = requirementArtifactContentHashRuntime({
      evaluations: replay.evaluations,
      requirementAllocation: replay.requirementAllocation,
    }, "firmware-batch-fixed-point-projection-v1");
    return actualHash !== null && actualHash === expectedHash ? []
      : ["firmware batch fixed-point differs from authoritative global replay"];
  } catch { return ["firmware batch fixed-point replay validation failed closed"]; }
}
