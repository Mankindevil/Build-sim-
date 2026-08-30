import { canonicalize, isSnapshotHashes, sha256Hex, type SnapshotHashes } from "../hash";
import { applyTopologyV3Patch } from "../scenarios/patch";
import { configV3Hash } from "../topology/hash";
import { createStableComponentInstanceId } from "../topology/normalize";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import type { TopologyV3PatchOperation } from "../contracts/registries";
import { PURCHASE_ELIGIBILITY_POLICY, type DomainCoverage, type SolveRequest, type SolveResult, type SolverCandidate, type UnsatProof } from "./contracts";
import { validateSolveRequest, validateSolveResult, validateSolverCandidate } from "./contracts";
import {
  buildSolverCandidateIndex,
  residualRequirementQuantity,
  type SolverCandidateIndex,
  type SolverComponentRequirement,
  type SolverIndexedCandidate,
} from "./candidate-index";
import {
  createExhaustiveUnsatProof,
  provenSingletonConflictSets,
  type SolverSearchRejection,
} from "./unsat";
import { validateSolverSearchCheckpointRuntime } from "./runtime-validation.mjs";

const REF = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface SolverArtifactWriter {
  readonly authorityKind: "solver-artifact-writer-v1";
  put(input: {
    kind: string;
    value: unknown;
    references: ReadonlyArray<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }>;
  }): Promise<{ ref: string }>;
}

/** Narrow projection of the normal governed evaluation pipeline receipt. */
export interface AuthoritativeSolverEvaluationReceipt {
  schemaVersion: "authoritative-solver-evaluation-v1";
  planId: string;
  basePlanVersionId: string;
  buildConfigHash: string;
  inputHashes: SnapshotHashes;
  evaluationHash: string;
  evaluationReceiptRef: string;
  coverageArtifactRef: string;
  domainCoverage: DomainCoverage[];
  residualRequirementIds: string[];
  unsatisfiedHardConstraintIds: string[];
  excludedReasonIds?: string[];
}

/**
 * This dependency must be composed around the same server evaluation service
 * used for an ordinary plan. It returns persisted receipt/coverage references;
 * the solver never hashes an evaluation or invents domain coverage.
 */
export interface AuthoritativeSolverEvaluator {
  readonly authorityKind: "authoritative-solver-evaluator-v1";
  evaluate(input: {
    planId: string;
    basePlanVersionId: string;
    candidateConfig: BuildConfigV3;
    expectedInputHashes: SnapshotHashes;
  }): Promise<AuthoritativeSolverEvaluationReceipt>;
}

export interface SolverSearchCheckpoint {
  schemaVersion: "whole-build-solver-checkpoint-v1";
  solverVersion: string;
  seed: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  limits: SolveRequest["limits"];
  candidateIndexHash: string;
  candidateIndexRef: string;
  nextAssignment: number;
  totalAssignments: number;
  elapsedDurationMs: number;
  exploredAssignmentHashes: string[];
  pruned: number;
  candidates: SolverCandidate[];
  rejections: SolverSearchRejection[];
}

export interface WholeBuildSolveOutput {
  result: SolveResult;
  unsatProof?: UnsatProof;
  checkpoint: SolverSearchCheckpoint;
  candidateIndex: SolverCandidateIndex;
}

interface AssignmentSlot {
  requirement: SolverComponentRequirement;
  ordinal: number;
  choices: SolverIndexedCandidate[];
}

interface AssignmentChoice {
  slot: AssignmentSlot;
  candidate: SolverIndexedCandidate;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameLockedInputHashes(actual: SnapshotHashes, expected: SnapshotHashes, configHash: string): boolean {
  if (!isSnapshotHashes(actual) || actual.configHash !== configHash) return false;
  return (Object.keys(expected) as Array<keyof SnapshotHashes>)
    .every((field) => field === "configHash" || actual[field] === expected[field]);
}

export function assertAuthoritativeSolverEvaluationReceipt(
  receipt: AuthoritativeSolverEvaluationReceipt,
  expected: { planId: string; basePlanVersionId: string; configHash: string; snapshotHashes: SnapshotHashes },
): void {
  if (!receipt || receipt.schemaVersion !== "authoritative-solver-evaluation-v1"
    || receipt.planId !== expected.planId || receipt.basePlanVersionId !== expected.basePlanVersionId
    || receipt.buildConfigHash !== expected.configHash || !HASH.test(receipt.evaluationHash)
    || !REF.test(receipt.evaluationReceiptRef) || !REF.test(receipt.coverageArtifactRef)
    || !sameLockedInputHashes(receipt.inputHashes, expected.snapshotHashes, expected.configHash)) {
    throw new Error("authoritative solver evaluation receipt is stale or invalid");
  }
  if (!Array.isArray(receipt.domainCoverage) || receipt.domainCoverage.length === 0
    || receipt.domainCoverage.some((coverage) => coverage.evaluationHash !== receipt.evaluationHash
      || !HASH.test(coverage.domainHash) || !["pass", "fail", "blocked"].includes(coverage.verdict))
    || new Set(receipt.domainCoverage.map((coverage) => coverage.domain)).size !== receipt.domainCoverage.length) {
    throw new Error("authoritative solver evaluation coverage binding is invalid");
  }
  for (const ids of [receipt.residualRequirementIds, receipt.unsatisfiedHardConstraintIds, receipt.excludedReasonIds ?? []]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
      throw new Error("authoritative solver evaluation IDs are invalid");
    }
  }
}

function lockedInstances(base: BuildConfigV3, requested: readonly string[]): ComponentInstance[] {
  const byId = new Map(base.components.map((component) => [component.instanceId, component]));
  for (const id of requested) if (!byId.has(id)) throw new Error(`locked solver instance ${id} is missing from the base topology`);
  const ids = new Set(requested);
  for (const component of base.components) {
    if (component.source === "user" || component.state === "ordered") ids.add(component.instanceId);
  }
  return [...ids].sort(compareText).map((id) => structuredClone(byId.get(id)!));
}

function assertLocksPreserved(config: BuildConfigV3, locked: readonly ComponentInstance[]): void {
  const byId = new Map(config.components.map((component) => [component.instanceId, component]));
  for (const component of locked) {
    const replayed = byId.get(component.instanceId);
    if (!replayed || canonicalize(replayed) !== canonicalize(component)) {
      throw new Error(`solver candidate changed locked instance ${component.instanceId}`);
    }
  }
}

function slotsFor(index: SolverCandidateIndex): AssignmentSlot[] {
  return index.pools.flatMap((pool) => Array.from(
    { length: residualRequirementQuantity(pool.requirement) },
    (_, ordinal) => ({ requirement: pool.requirement, ordinal, choices: pool.candidates }),
  ));
}

function totalAssignments(slots: readonly AssignmentSlot[]): number {
  if (slots.some((slot) => slot.choices.length === 0)) return 0;
  let total = 1n;
  for (const slot of slots) total *= BigInt(slot.choices.length);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(total);
}

function assignmentAt(slots: readonly AssignmentSlot[], index: number): AssignmentChoice[] {
  let remainder = index;
  const result = new Array<AssignmentChoice>(slots.length);
  for (let position = slots.length - 1; position >= 0; position -= 1) {
    const slot = slots[position]!;
    const radix = slot.choices.length;
    const choice = remainder % radix;
    remainder = Math.floor(remainder / radix);
    result[position] = { slot, candidate: slot.choices[choice]! };
  }
  return result;
}

async function assignmentMaterial(planId: string, choices: readonly AssignmentChoice[]): Promise<{
  assignmentHash: string;
  operations: TopologyV3PatchOperation[];
}> {
  const material = choices.map(({ slot, candidate }) => ({
    requirementId: slot.requirement.requirementId,
    ordinal: slot.ordinal,
    componentKindId: slot.requirement.componentKindId,
    subjectSkuId: candidate.subjectSkuId,
    capabilityRecordHash: candidate.capabilityRecordHash,
  }));
  const assignmentHash = await sha256Hex(`buildsim\0solver-assignment-v1\0${canonicalize(material)}`);
  const operations: TopologyV3PatchOperation[] = [];
  for (const { slot, candidate } of choices) {
    const instanceId = await createStableComponentInstanceId({
      planId,
      kind: slot.requirement.componentKindId,
      sourceKey: `solver:${slot.requirement.requirementId}:${candidate.subjectSkuId}:${assignmentHash}`,
      ordinal: slot.ordinal,
    });
    operations.push({
      op: "add",
      selector: { collection: "components", id: instanceId },
      value: {
        instanceId,
        kind: slot.requirement.componentKindId,
        role: slot.requirement.role,
        state: "planned",
        identity: {
          status: "resolved",
          skuId: candidate.subjectSkuId,
          identityClaimIds: [...candidate.identityClaimIds],
        },
        source: "agent",
      },
    });
  }
  return { assignmentHash, operations };
}

function normalizeCheckpoint(checkpoint: SolverSearchCheckpoint): SolverSearchCheckpoint {
  return {
    ...structuredClone(checkpoint),
    exploredAssignmentHashes: [...checkpoint.exploredAssignmentHashes],
    candidates: [...checkpoint.candidates].sort((left, right) => compareText(left.candidateId, right.candidateId)),
    rejections: [...checkpoint.rejections].sort((left, right) => compareText(left.assignmentHash, right.assignmentHash)),
  };
}

/** Deterministic bounded whole-build feasibility search. */
export async function solveWholeBuild(input: {
  planId: string;
  request: SolveRequest;
  baseConfig: BuildConfigV3;
  requirements: readonly SolverComponentRequirement[];
  candidateService: Parameters<typeof buildSolverCandidateIndex>[0]["service"];
  evaluator: AuthoritativeSolverEvaluator;
  artifacts: SolverArtifactWriter;
  solverVersion?: string;
  seed?: string;
  resumeFrom?: SolverSearchCheckpoint;
  checkpoint?: (checkpoint: SolverSearchCheckpoint) => void | Promise<void>;
  nowMs?: () => number;
}): Promise<WholeBuildSolveOutput> {
  const requestErrors = validateSolveRequest(input.request);
  if (requestErrors.length) throw new TypeError(`invalid whole-build solve request: ${requestErrors.join("; ")}`);
  if (!input.planId.trim() || input.baseConfig.id !== input.planId) throw new TypeError("whole-build solver plan/base binding is invalid");
  if (await configV3Hash(input.baseConfig) !== input.request.baseConfigHash) throw new Error("whole-build solver base config hash is stale");
  if (input.baseConfig.requirementSpec?.requirementSpecId !== input.request.requirementSpecId) {
    throw new Error("whole-build solver RequirementSpec binding is stale or missing");
  }
  if (input.evaluator?.authorityKind !== "authoritative-solver-evaluator-v1") throw new TypeError("authoritative solver evaluator is required");
  if (input.artifacts?.authorityKind !== "solver-artifact-writer-v1") throw new TypeError("solver artifact authority is required");
  const solverVersion = input.solverVersion ?? "whole-build-solver-v1";
  const seed = input.seed ?? await sha256Hex(`buildsim\0solver-seed-v1\0${canonicalize({ request: input.request, solverVersion })}`);
  const index = await buildSolverCandidateIndex({
    planId: input.planId,
    requirements: input.requirements,
    snapshotHashes: input.request.baseSnapshotHashes,
    maxCandidatesPerRequirement: input.request.limits.maxCandidatesPerRequirement,
    service: input.candidateService,
  });
  const candidateIndexHash = index.contentHash;
  const candidateIndexArtifact = await input.artifacts.put({ kind: "solver-candidate-index", value: index, references: [] });
  if (!REF.test(candidateIndexArtifact.ref)) throw new Error("solver artifact writer returned an invalid candidate index ref");
  const slots = slotsFor(index);
  const total = totalAssignments(slots);
  const locked = lockedInstances(input.baseConfig, input.request.lockedInstanceIds);
  const fresh: SolverSearchCheckpoint = {
    schemaVersion: "whole-build-solver-checkpoint-v1",
    solverVersion,
    seed,
    basePlanVersionId: input.request.basePlanVersionId,
    baseConfigHash: input.request.baseConfigHash,
    baseSnapshotHashes: structuredClone(input.request.baseSnapshotHashes),
    limits: structuredClone(input.request.limits),
    candidateIndexHash,
    candidateIndexRef: candidateIndexArtifact.ref,
    nextAssignment: 0,
    totalAssignments: total,
    elapsedDurationMs: 0,
    exploredAssignmentHashes: [],
    pruned: 0,
    candidates: [],
    rejections: [],
  };
  if (input.resumeFrom) {
    const resumeErrors = validateSolverSearchCheckpointRuntime(input.resumeFrom);
    if (resumeErrors.length) throw new Error(`solver resume checkpoint is invalid: ${resumeErrors.join("; ")}`);
  }
  let checkpoint = input.resumeFrom ? normalizeCheckpoint(input.resumeFrom) : fresh;
  if (input.resumeFrom && canonicalize({
    ...checkpoint,
    nextAssignment: 0, elapsedDurationMs: 0, exploredAssignmentHashes: [], pruned: 0, candidates: [], rejections: [],
  }) !== canonicalize(fresh)) {
    throw new Error("solver checkpoint does not match the exact base/version/seed/limits/candidate index");
  }
  if (checkpoint.nextAssignment !== checkpoint.exploredAssignmentHashes.length
    || checkpoint.nextAssignment < 0 || checkpoint.nextAssignment > checkpoint.totalAssignments) {
    throw new Error("solver checkpoint search cursor is invalid");
  }
  const clock = input.nowMs ?? Date.now;
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) throw new Error("solver monotonic clock is invalid");
  const elapsedBeforeRun = checkpoint.elapsedDurationMs;
  for (let assignmentIndex = checkpoint.nextAssignment; assignmentIndex < total; assignmentIndex += 1) {
    const sampledAt = clock();
    if (!Number.isFinite(sampledAt)) throw new Error("solver monotonic clock is invalid");
    const elapsed = Math.max(0, sampledAt - startedAt);
    if (checkpoint.exploredAssignmentHashes.length >= input.request.limits.maxEvaluations
      || elapsedBeforeRun + elapsed >= input.request.limits.maxDurationMs) break;
    const { assignmentHash, operations } = await assignmentMaterial(input.planId, assignmentAt(slots, assignmentIndex));
    const candidateConfig = applyTopologyV3Patch(input.baseConfig, operations, { actor: "solver" });
    assertLocksPreserved(candidateConfig, locked);
    const buildConfigHash = await configV3Hash(candidateConfig);
    const expectedInputHashes = { ...input.request.baseSnapshotHashes, configHash: buildConfigHash };
    const receipt = await input.evaluator.evaluate({
      planId: input.planId,
      basePlanVersionId: input.request.basePlanVersionId,
      candidateConfig: structuredClone(candidateConfig),
      expectedInputHashes,
    });
    assertAuthoritativeSolverEvaluationReceipt(receipt, {
      planId: input.planId,
      basePlanVersionId: input.request.basePlanVersionId,
      configHash: buildConfigHash,
      snapshotHashes: input.request.baseSnapshotHashes,
    });
    checkpoint.exploredAssignmentHashes.push(assignmentHash);
    checkpoint.nextAssignment = assignmentIndex + 1;
    const completedAt = clock();
    if (!Number.isFinite(completedAt)) throw new Error("solver monotonic clock is invalid");
    checkpoint.elapsedDurationMs = Math.max(checkpoint.elapsedDurationMs, elapsedBeforeRun + Math.max(0, completedAt - startedAt));
    const failedDomains = receipt.domainCoverage.filter((coverage) => coverage.verdict === "fail");
    if (receipt.unsatisfiedHardConstraintIds.length || failedDomains.length) {
      checkpoint.pruned += 1;
      checkpoint.rejections.push({
        assignmentHash,
        hardConstraintIds: [...new Set([
          ...receipt.unsatisfiedHardConstraintIds,
          ...failedDomains.map((coverage) => `domain:${coverage.domain}`),
        ])].sort(compareText),
        evaluationReceiptRef: receipt.evaluationReceiptRef,
      });
    } else {
      const configArtifact = await input.artifacts.put({
        kind: "solver-candidate-config",
        value: candidateConfig,
        references: [],
      });
      const operationsArtifact = await input.artifacts.put({
        kind: "solver-candidate-operations",
        value: operations,
        references: [],
      });
      if (!REF.test(configArtifact.ref) || !REF.test(operationsArtifact.ref)) throw new Error("solver artifact writer returned an invalid ref");
      const candidateHash = await sha256Hex(`buildsim\0solver-candidate-v1\0${canonicalize({
        assignmentHash, buildConfigHash, evaluationHash: receipt.evaluationHash,
      })}`);
      const excludedReasonIds = [...new Set([
        ...(receipt.excludedReasonIds ?? []),
        ...receipt.domainCoverage.filter((coverage) => coverage.verdict === "blocked").map((coverage) => `domain:${coverage.domain}:blocked`),
      ])].sort(compareText);
      const candidateMaterial: SolverCandidate = {
        candidateId: `candidate-${candidateHash}`,
        requirementSpecId: input.request.requirementSpecId,
        basePlanVersionId: input.request.basePlanVersionId,
        baseConfigHash: input.request.baseConfigHash,
        candidateConfigRef: configArtifact.ref,
        operationsRef: operationsArtifact.ref,
        buildConfigHash,
        inputHashes: structuredClone(receipt.inputHashes),
        evaluationHash: receipt.evaluationHash,
        evaluationReceiptRef: receipt.evaluationReceiptRef,
        coverageArtifactRef: receipt.coverageArtifactRef,
        candidateKind: "feasibility_candidate",
        domainCoverage: structuredClone(receipt.domainCoverage)
          .sort((left, right) => compareText(left.domain, right.domain)),
        residualRequirementIds: [...receipt.residualRequirementIds].sort(compareText),
        excludedReasonIds,
      };
      const candidateArtifact = await input.artifacts.put({
        kind: "solver-candidate",
        value: candidateMaterial,
        references: [
          { ref: candidateMaterial.candidateConfigRef, necessity: "required_for_replay" },
          { ref: candidateMaterial.operationsRef, necessity: "required_for_replay" },
          { ref: candidateMaterial.evaluationReceiptRef!, necessity: "required_for_replay" },
          { ref: candidateMaterial.coverageArtifactRef!, necessity: "required_for_replay" },
        ],
      });
      if (!REF.test(candidateArtifact.ref)) throw new Error("solver artifact writer returned an invalid candidate ref");
      const candidate: SolverCandidate = { ...candidateMaterial, candidateArtifactRef: candidateArtifact.ref };
      const errors = validateSolverCandidate(candidate);
      if (errors.length) throw new Error(`authoritative evaluator produced an invalid solver candidate: ${errors.join("; ")}`);
      checkpoint.candidates.push(candidate);
    }
    checkpoint = normalizeCheckpoint(checkpoint);
    const checkpointErrors = validateSolverSearchCheckpointRuntime(checkpoint);
    if (checkpointErrors.length) throw new Error(`solver emitted an invalid checkpoint: ${checkpointErrors.join("; ")}`);
    await input.checkpoint?.(structuredClone(checkpoint));
  }

  const exhaustive = checkpoint.nextAssignment === total
    && index.pools.every((pool) => !pool.truncated && pool.blockedIdentitySkuIds.length === 0);
  const emptyPoolConstraints = index.pools
    .filter((pool) => residualRequirementQuantity(pool.requirement) > 0 && pool.candidates.length === 0)
    .flatMap((pool) => pool.requirement.hardConstraintIds.length ? pool.requirement.hardConstraintIds : [pool.requirement.requirementId]);
  const rejectedConstraints = checkpoint.rejections.flatMap((rejection) => rejection.hardConstraintIds);
  const unsatisfiedHardConstraintIds = [...new Set([...emptyPoolConstraints, ...rejectedConstraints])].sort(compareText);
  let status: SolveResult["status"];
  const candidatesHaveBlockedOrResidualAuthority = checkpoint.candidates.some((candidate) => {
    const byDomain = new Map(candidate.domainCoverage.map((coverage) => [coverage.domain, coverage]));
    return candidate.residualRequirementIds.length > 0 || candidate.excludedReasonIds.length > 0
      || PURCHASE_ELIGIBILITY_POLICY.requiredDomains.some((domain) => byDomain.get(domain)?.verdict !== "pass");
  });
  if (checkpoint.candidates.length) status = exhaustive && !candidatesHaveBlockedOrResidualAuthority ? "feasible_complete" : "feasible_partial";
  else if (exhaustive) status = "unsat_proven";
  else status = "blocked_inputs";
  const unexploredRanges = !exhaustive && total > checkpoint.nextAssignment
    ? [{ start: checkpoint.nextAssignment, end: total - 1 }] : [];
  const searchSummary = {
    schemaVersion: "whole-build-search-summary-v1",
    solverVersion,
    seed,
    basePlanVersionId: input.request.basePlanVersionId,
    baseConfigHash: input.request.baseConfigHash,
    candidateIndexHash,
    candidateIndexRef: candidateIndexArtifact.ref,
    totalAssignments: total,
    elapsedDurationMs: checkpoint.elapsedDurationMs,
    nextAssignment: checkpoint.nextAssignment,
    explored: checkpoint.exploredAssignmentHashes.length,
    pruned: checkpoint.pruned,
    unexploredRanges,
    candidateIds: checkpoint.candidates.map((candidate) => candidate.candidateId).sort(compareText),
    candidateArtifactRefs: checkpoint.candidates.map((candidate) => candidate.candidateArtifactRef!).sort(compareText),
  };
  const searchSummaryArtifact = await input.artifacts.put({
    kind: "solver-search-summary",
    value: searchSummary,
    references: [{ ref: candidateIndexArtifact.ref, necessity: "required_for_replay" as const }, ...checkpoint.candidates.map((candidate) => ({
      ref: candidate.candidateArtifactRef!, necessity: "required_for_replay" as const,
    }))],
  });
  const result: SolveResult = {
    status,
    solverVersion,
    seed,
    effectiveLimits: structuredClone(input.request.limits),
    explored: checkpoint.exploredAssignmentHashes.length,
    pruned: checkpoint.pruned,
    candidates: [...checkpoint.candidates].sort((left, right) => compareText(left.candidateId, right.candidateId)),
    unsatisfiedHardConstraintIds: status === "feasible_complete" || status === "feasible_partial"
      ? [] : [...new Set([
        ...unsatisfiedHardConstraintIds,
        ...index.pools.flatMap((pool) => pool.blockedIdentitySkuIds.length ? [`${pool.requirement.requirementId}:identity-claim-closure`] : []),
        ...(!exhaustive && total > checkpoint.nextAssignment ? ["solver.search-incomplete"] : []),
      ])].sort(compareText),
    irreducibleConflictSets: status === "unsat_proven" ? provenSingletonConflictSets(index) : [],
    searchSummaryRef: searchSummaryArtifact.ref,
    ...(unexploredRanges.length ? { unexploredRanges } : {}),
  };
  let unsatProof: UnsatProof | undefined;
  if (status === "unsat_proven") {
    unsatProof = await createExhaustiveUnsatProof({
      schemaVersion: "solver-exhaustive-unsat-material-v1",
      solverVersion,
      seed,
      basePlanVersionId: input.request.basePlanVersionId,
      baseSnapshotHashes: input.request.baseSnapshotHashes,
      candidateIndex: index,
      totalAssignments: total,
      exploredAssignmentHashes: checkpoint.exploredAssignmentHashes,
      rejections: checkpoint.rejections,
    });
  }
  const resultErrors = validateSolveResult(result, unsatProof);
  if (resultErrors.length) throw new Error(`whole-build solver emitted an invalid result: ${resultErrors.join("; ")}`);
  return { result, ...(unsatProof ? { unsatProof } : {}), checkpoint: normalizeCheckpoint(checkpoint), candidateIndex: index };
}
