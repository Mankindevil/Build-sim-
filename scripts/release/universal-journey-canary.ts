import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateUniversalJourneyEvidenceManifest,
  type UniversalJourneyEvidenceManifest,
  type UniversalJourneyPlanBinding,
} from "../../src/release/universal-journey";
import { isProgressiveBuildEvaluation, type ProgressiveBuildEvaluation } from "../../src/compatibility/contracts";
import { loadRuntimeCaseAdapterRegistrySnapshotAtRoot } from "../../src/adapters/runtime-registry-repository";
import { FileJobRepository } from "../../src/jobs/repository";
import type { BuildConfigV3 } from "../../src/topology/contracts";
import { createWorkspaceRepositories } from "../../src/server/workspace-server";
import type { PlanVersion } from "../../src/plans/contracts";
import { hashPlanConfig } from "../../src/plans/canonical";
import type { AuthoritativeEvaluationReceipt } from "../../src/server/evaluation-service";
import { createPortablePlanPackage, openPortablePlanPackage, planPortableImport } from "../../src/portability";
import { createBackup, persistBackupVerification, restoreBackup, verifyBackup } from "../../src/backup/runtime.mjs";
import { runDoctor } from "../../src/doctor/runner.mjs";
import {
  DEFAULT_DOCTOR_CHECK_REGISTRY,
  DOCTOR_CHECK_REGISTRY_VERSION,
  DOCTOR_VERSION,
  verifyDoctorReport,
} from "../../src/doctor/contracts";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { canonicalize } from "../../src/hash";

export const UNIVERSAL_JOURNEY_CHECK_IDS = Object.freeze([
  "stage-b.evidence-manifest",
  "stage-b.complete-governed-plan",
  "stage-b.thermal-acoustic-intervals",
  "stage-b.ranked-recommendations",
  "stage-b.supplies-and-firmware",
  "stage-b.full-procedure-before-checkpoints",
  "stage-b.nas-layout",
  "journey.blank-intent-and-solver-outcomes",
  "journey.read-only-scenarios",
  "journey.provisional-case",
  "journey.price-and-job-recovery",
  "journey.portable-backup-restore-doctor",
] as const);

export type UniversalJourneyCheckId = (typeof UNIVERSAL_JOURNEY_CHECK_IDS)[number];

export interface UniversalJourneyCanaryCheck {
  checkId: UniversalJourneyCheckId;
  status: "pass" | "blocked";
  evidence: unknown;
}

type WorkspaceServices = ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>;

interface ResolvedPlanEvidence {
  version: PlanVersion<BuildConfigV3>;
  receipt: AuthoritativeEvaluationReceipt;
  evaluation: ProgressiveBuildEvaluation;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;

function pass(checkId: UniversalJourneyCheckId, evidence: unknown): UniversalJourneyCanaryCheck {
  return { checkId, status: "pass", evidence };
}

function blocked(checkId: UniversalJourneyCheckId, evidence: unknown): UniversalJourneyCanaryCheck {
  return { checkId, status: "blocked", evidence };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown release evidence error";
}

function allBlocked(reason: string, details: unknown = null): UniversalJourneyCanaryCheck[] {
  return UNIVERSAL_JOURNEY_CHECK_IDS.map((checkId) => blocked(checkId, { reason, details }));
}

async function readManifest(evidenceRuntimeRoot: string): Promise<UniversalJourneyEvidenceManifest> {
  const file = path.join(path.resolve(evidenceRuntimeRoot), "release-evidence", "universal-journey.json");
  let stats;
  try { stats = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`universal journey evidence is missing: ${file}`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_MANIFEST_BYTES) {
    throw new Error("universal journey evidence must be a bounded regular file");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("universal journey evidence is not valid JSON"); }
  const errors = await validateUniversalJourneyEvidenceManifest(value);
  if (errors.length) throw new Error(errors.join("; "));
  return structuredClone(value) as UniversalJourneyEvidenceManifest;
}

async function resolvePlan(
  services: WorkspaceServices,
  binding: UniversalJourneyPlanBinding,
): Promise<ResolvedPlanEvidence> {
  const versions = await services.repository.listVersions(binding.planId);
  const version = versions.find(({ id }) => id === binding.planVersionId);
  if (!version || version.config.schemaVersion !== "3.0.0" || !version.evaluationHash
    || !version.evaluationLock || !version.evaluatedAt) throw new Error("governed V3 plan version was not found");
  if (version.configHash !== binding.configHash || version.evaluationHash !== binding.evaluationHash
    || version.evaluationLock.contentHash !== binding.evaluationLockHash
    || version.evaluationLock.snapshotHashes.factSnapshotHash !== binding.factSnapshotHash) {
    throw new Error("plan version does not match the journey hash tuple");
  }
  const result = await services.coordinator!.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
    services.evaluationLockRepository.getIssuedVersionReceiptAtRoot(activeRoot, {
      planId: binding.planId,
      configHash: version.configHash,
      evaluationHash: version.evaluationHash!,
      evaluatedAt: version.evaluatedAt!,
      evaluationLock: version.evaluationLock!,
    })
  ));
  const receipt = result.result as AuthoritativeEvaluationReceipt | null;
  if (!receipt || !isProgressiveBuildEvaluation(receipt.evaluation)) {
    throw new Error("plan version has no exact progressive evaluation receipt");
  }
  return { version: structuredClone(version), receipt, evaluation: receipt.evaluation };
}

async function checkSafely(
  checkId: UniversalJourneyCheckId,
  operation: () => Promise<unknown>,
): Promise<UniversalJourneyCanaryCheck> {
  try { return pass(checkId, await operation()); }
  catch (error) { return blocked(checkId, { reason: message(error) }); }
}

function hasRange(value: { lo: number; hi: number } | null): boolean {
  return value !== null && Number.isFinite(value.lo) && Number.isFinite(value.hi) && value.lo <= value.hi;
}

function replayServices(runtimeRoot: string): WorkspaceServices {
  return createWorkspaceRepositories<BuildConfigV3>({
    RUNTIME_ROOT: runtimeRoot,
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
    BUILD_SIM_FACT_GRAPH_ENABLED: "true",
    BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
  });
}

export async function verifyUniversalJourneyEvidence(options: {
  services: WorkspaceServices;
  evidenceRuntimeRoot: string;
}): Promise<UniversalJourneyCanaryCheck[]> {
  let manifest: UniversalJourneyEvidenceManifest;
  try { manifest = await readManifest(options.evidenceRuntimeRoot); }
  catch (error) { return allBlocked("manifest_unavailable", message(error)); }
  const state = await options.services.coordinator!.readState();
  if (manifest.runtimeGeneration !== state.runtimeGeneration) {
    return allBlocked("runtime_generation_mismatch", {
      manifestRuntimeGeneration: manifest.runtimeGeneration,
      activeRuntimeGeneration: state.runtimeGeneration,
    });
  }

  const checks: UniversalJourneyCanaryCheck[] = [pass("stage-b.evidence-manifest", {
    contentHash: manifest.contentHash,
    runtimeGeneration: manifest.runtimeGeneration,
    createdAt: manifest.createdAt,
  })];
  let stageB: ResolvedPlanEvidence | null = null;
  let nas: ResolvedPlanEvidence | null = null;
  let blank: ResolvedPlanEvidence | null = null;
  let accepted: ResolvedPlanEvidence | null = null;
  try { stageB = await resolvePlan(options.services, manifest.stageB.plan); }
  catch { /* Per-check resolver below reports the exact failure. */ }
  try { nas = await resolvePlan(options.services, manifest.stageB.nasPlan); }
  catch { /* Per-check resolver below reports the exact failure. */ }
  try { blank = await resolvePlan(options.services, manifest.journey.blankPlan); }
  catch { /* Per-check resolver below reports the exact failure. */ }
  try { accepted = await resolvePlan(options.services, manifest.journey.acceptedPlan); }
  catch { /* Per-check resolver below reports the exact failure. */ }

  checks.push(await checkSafely("stage-b.complete-governed-plan", async () => {
    stageB ??= await resolvePlan(options.services, manifest.stageB.plan);
    const current = await options.services.repository.get(manifest.stageB.plan.planId);
    if (!options.services.wholeBuildSolver) throw new Error("production solver service is disabled");
    const solver = await options.services.wholeBuildSolver.status(manifest.stageB.solverJobId);
    const acceptedCandidate = solver.result?.result.candidates.find((candidate) => (
      candidate.buildConfigHash === stageB!.version.configHash
      && candidate.evaluationHash === stageB!.receipt.evaluationHash
      && canonicalize(candidate.inputHashes) === canonicalize(stageB!.receipt.evaluationLock.snapshotHashes)
      && candidate.residualRequirementIds.length === 0
    ));
    if (current.activeVersionId !== stageB.version.id || stageB.evaluation.readiness.profileCompleteness !== "complete") {
      throw new Error("stage B plan is not the active complete governed version");
    }
    if (!acceptedCandidate) throw new Error("stage B plan is not an exact complete solver candidate");
    return {
      planId: stageB.version.planId,
      planVersionId: stageB.version.id,
      solverJobId: solver.job.jobId,
      candidateId: acceptedCandidate.candidateId,
      configHash: stageB.version.configHash,
      evaluationHash: stageB.receipt.evaluationHash,
      profileCompleteness: stageB.evaluation.readiness.profileCompleteness,
    };
  }));

  checks.push(await checkSafely("stage-b.thermal-acoustic-intervals", async () => {
    stageB ??= await resolvePlan(options.services, manifest.stageB.plan);
    const value = stageB.evaluation.thermalAcousticEvaluation;
    if (value.simulationInputHash !== stageB.receipt.evaluationLock.snapshotHashes.simulationInputHash
      || value.simulationInputClosureHash === null || value.workloadId.length === 0
      || value.thermal.verdict === "blocked" || !hasRange(value.thermal.peakTemperatureC)
      || value.thermal.components.length === 0 || value.thermal.chambers.length === 0 || value.thermal.assumptions.length === 0
      || value.acoustic.verdict === "blocked" || !hasRange(value.acoustic.totalDba)
      || value.acoustic.contributions.length === 0 || value.acoustic.assumptions.length === 0) {
      throw new Error("stage B thermal/acoustic interval closure is incomplete");
    }
    return {
      simulationInputHash: value.simulationInputHash,
      simulationInputClosureHash: value.simulationInputClosureHash,
      workloadId: value.workloadId,
      thermal: { verdict: value.thermal.verdict, peakTemperatureC: value.thermal.peakTemperatureC, componentCount: value.thermal.components.length },
      acoustic: { verdict: value.acoustic.verdict, totalDba: value.acoustic.totalDba, contributionCount: value.acoustic.contributions.length },
    };
  }));

  checks.push(await checkSafely("stage-b.ranked-recommendations", async () => {
    if (!options.services.recommendations) throw new Error("production recommendation service is disabled");
    const view = await options.services.recommendations.view(
      manifest.stageB.plan.planId,
      manifest.stageB.solverJobId,
      manifest.stageB.recommendationSetRef,
    );
    const tiers = view.set.recommendations.map(({ tier }) => tier).sort();
    const stageBCandidate = view.contexts.find(({ candidate }) => (
      candidate.buildConfigHash === manifest.stageB.plan.configHash
      && candidate.evaluationHash === manifest.stageB.plan.evaluationHash
      && candidate.residualRequirementIds.length === 0
    ));
    if (!view.current || view.set.status !== "ranked" || view.set.searchCompleteness !== "complete"
      || view.staleCandidateIds.length !== 0 || tiers.join(",") !== "balanced,economy,long_term"
      || view.contexts.length !== 3 || view.explanations.length !== 3 || !stageBCandidate) {
      throw new Error("stage B recommendation set is incomplete or stale");
    }
    return {
      setRef: view.setRef,
      solverJobId: view.set.solverJobId,
      acceptedCandidateId: stageBCandidate.candidate.candidateId,
      tiers,
      contextCount: view.contexts.length,
      explanationCount: view.explanations.length,
    };
  }));

  checks.push(await checkSafely("stage-b.supplies-and-firmware", async () => {
    stageB ??= await resolvePlan(options.services, manifest.stageB.plan);
    const evaluation = stageB.evaluation;
    const requirementKinds = new Set(evaluation.requirements.map(({ kind }) => kind));
    const satisfaction = new Map(evaluation.requirementAllocation.satisfactions.map((entry) => [entry.requirementId, entry]));
    const materialKinds = ["cable", "fastener", "tool"] as const;
    if (materialKinds.some((kind) => !requirementKinds.has(kind))
      || evaluation.requirements.some((requirement) => !satisfaction.has(requirement.requirementId))) {
      throw new Error("stage B package/purchase/tool requirements are not explicit");
    }
    const allocations = evaluation.requirementAllocation.satisfactions.flatMap(({ allocations: entries }) => entries);
    if (!allocations.some(({ source }) => source === "package_content") || !allocations.some(({ source }) => source === "purchase")) {
      throw new Error("stage B does not distinguish included and purchased supplies");
    }
    const unsafeUnverified = evaluation.requirements.flatMap((requirement) => {
      const entry = satisfaction.get(requirement.requirementId);
      if (!entry || entry.status !== "satisfied" || (requirement.requiredBefore === undefined && requirement.criticality === "normal")) return [];
      return entry.allocations.filter(({ availability, verificationStatus }) => availability !== "present_verified" || verificationStatus !== "verified");
    });
    if (unsafeUnverified.length !== 0) throw new Error("unverified supplies satisfy a gated requirement");
    if (evaluation.firmwareEvaluations.length === 0 || evaluation.firmwareEvaluations.some((firmware) => (
      firmware.verdict !== "pass" || firmware.missingRequirementIds.length !== 0
      || firmware.missingPowerPrerequisiteFactIds.length !== 0
      || firmware.recovery.status === "blocked" || firmware.recovery.status === "unavailable"
    ))) throw new Error("stage B firmware path is missing or blocked");
    return {
      requirementKinds: [...requirementKinds].sort(),
      includedAllocationCount: allocations.filter(({ source }) => source === "package_content").length,
      purchaseAllocationCount: allocations.filter(({ source }) => source === "purchase").length,
      firmware: evaluation.firmwareEvaluations.map(({ instanceId, verdict, reason, selectedTransitions, recovery }) => ({
        instanceId, verdict, reason, transitionIds: selectedTransitions.map(({ transitionId }) => transitionId), recovery,
      })),
    };
  }));

  checks.push(await checkSafely("stage-b.full-procedure-before-checkpoints", async () => {
    if (!options.services.systemExecution) throw new Error("production execution service is disabled");
    const preview = await options.services.systemExecution.preview(manifest.stageB.plan.planId, manifest.stageB.plan.planVersionId);
    const stored = await options.services.systemExecution.get(manifest.stageB.plan.planId, manifest.stageB.executionSessionId);
    if (preview.mode !== "full_execution" || preview.blockers.length !== 0 || !preview.generated
      || preview.generated.procedure.steps.length === 0
      || !preview.generated.procedure.steps.some(({ phase }) => phase === "first_power")
      || !preview.generated.procedure.steps.some(({ safetyCritical }) => safetyCritical)
      || stored.session.planVersionId !== manifest.stageB.plan.planVersionId
      || stored.session.evaluationHash !== manifest.stageB.plan.evaluationHash
      || stored.session.procedureId !== preview.generated.procedure.procedureId) {
      throw new Error("stage B full execution procedure/session closure is incomplete");
    }
    const safetyStepIds = new Set(preview.generated.procedure.steps.filter(({ safetyCritical }) => safetyCritical).map(({ stepId }) => stepId));
    const confirmedSafetyStepIds = stored.session.results.filter(({ result, stepId }) => result === "confirmed" && safetyStepIds.has(stepId)).map(({ stepId }) => stepId);
    if (confirmedSafetyStepIds.length !== 0) throw new Error("stage B evidence was captured after safety checkpoints were completed");
    return {
      executionSessionId: stored.session.executionSessionId,
      procedureId: stored.session.procedureId,
      phases: preview.generated.procedure.phases,
      safetyCheckpointCount: safetyStepIds.size,
      confirmedSafetyStepIds,
      powerReady: false,
    };
  }));

  checks.push(await checkSafely("stage-b.nas-layout", async () => {
    nas ??= await resolvePlan(options.services, manifest.stageB.nasPlan);
    if (!options.services.systemExecution) throw new Error("production execution service is disabled");
    const preview = await options.services.systemExecution.preview(nas.version.planId, nas.version.id);
    if (nas.version.config.system?.profileId !== "system.truenas-scale" || nas.version.config.logicalLayouts.length === 0) {
      throw new Error("stage B NAS plan lacks an explicit TrueNAS boot/data layout");
    }
    const ready = preview.storageLayouts.filter((layout) => layout.status === "ready");
    if (ready.length === 0 || ready.some(({ evaluation }) => evaluation.usableBytes.min < 0
      || evaluation.usableBytes.max < evaluation.usableBytes.min
      || evaluation.vdevResults.length === 0
      || evaluation.vdevResults.some((vdev) => !vdev.diskInstanceIds?.length || !vdev.controllerPaths?.length || vdev.faultTolerance.conditions.length === 0)
      || evaluation.expansionOptions.length === 0)) {
      throw new Error("stage B NAS capacity, path, fault-tolerance or expansion closure is incomplete");
    }
    if (preview.destructiveActions.some(({ plan }) => plan?.confirmation === "confirmed")) {
      throw new Error("stage B NAS release evidence contains an executed destructive action");
    }
    return {
      planId: nas.version.planId,
      planVersionId: nas.version.id,
      layouts: ready.map(({ layoutId, evaluation }) => ({
        layoutId, usableBytes: evaluation.usableBytes,
        vdevs: evaluation.vdevResults.map(({ vdevId, faultTolerance, diskInstanceIds, controllerPaths }) => ({ vdevId, faultTolerance, diskInstanceIds, controllerPaths })),
        expansionOptions: evaluation.expansionOptions,
      })),
      destructiveActions: preview.destructiveActions,
    };
  }));

  checks.push(await checkSafely("journey.blank-intent-and-solver-outcomes", async () => {
    blank ??= await resolvePlan(options.services, manifest.journey.blankPlan);
    accepted ??= await resolvePlan(options.services, manifest.journey.acceptedPlan);
    const config = blank.version.config;
    const spec = config.requirementSpec;
    if (config.components.length !== 0 || config.placements.length !== 0 || config.connections.length !== 0
      || !spec || spec.workloads.length === 0 || spec.constraints.length < 2
      || !spec.constraints.some((constraint) => "strength" in constraint && constraint.strength === "hard")
      || !spec.constraints.some((constraint) => "strength" in constraint && constraint.strength === "soft")
      || spec.budget?.state !== "answered" || spec.budget.confirmedByUser !== true
      || accepted.version.planId !== blank.version.planId || accepted.version.id === blank.version.id) {
      throw new Error("cross-product blank intent or accepted-plan lineage is incomplete");
    }
    if (!options.services.wholeBuildSolver) throw new Error("production solver service is disabled");
    const [feasible, unsat] = await Promise.all([
      options.services.wholeBuildSolver.status(manifest.journey.feasibleSolverJobId),
      options.services.wholeBuildSolver.status(manifest.journey.unsatSolverJobId),
    ]);
    if (feasible.result?.result.status !== "feasible_complete" || feasible.result.result.candidates.length === 0
      || feasible.result.result.candidates.some(({ residualRequirementIds }) => residualRequirementIds.length !== 0)
      || unsat.result?.result.status !== "unsat_proven" || unsat.result.result.irreducibleConflictSets.length === 0) {
      throw new Error("cross-product solver outcomes are not one complete candidate plus one explained conflict");
    }
    return {
      blankPlanVersionId: blank.version.id,
      acceptedPlanVersionId: accepted.version.id,
      feasible: { jobId: feasible.job.jobId, candidateIds: feasible.result.result.candidates.map(({ candidateId }) => candidateId) },
      unsat: { jobId: unsat.job.jobId, conflictSets: unsat.result.result.irreducibleConflictSets },
    };
  }));

  checks.push(await checkSafely("journey.read-only-scenarios", async () => {
    if (!options.services.scenarioWhatIf) throw new Error("production what-if service is disabled");
    accepted ??= await resolvePlan(options.services, manifest.journey.acceptedPlan);
    const currentBefore = await options.services.repository.get(accepted.version.planId);
    const configHashBefore = await hashPlanConfig(currentBefore.draft.config);
    const values = await Promise.all(Object.entries(manifest.journey.scenarios).map(async ([role, scenarioId]) => {
      const view = await options.services.scenarioWhatIf!.getScenario(accepted!.version.planId, scenarioId);
      if (!view.result || view.result.snapshotAttribution !== "same_snapshots"
        || view.result.beforeEvaluationHash === view.result.afterEvaluationHash
        || view.family.basePlanVersionId !== manifest.journey.acceptedPlan.planVersionId
        || view.branch.patch.length + (view.branch.simulationInputPatch?.length ?? 0) === 0) {
        throw new Error(`cross-product ${role} scenario is missing its immutable same-snapshot result`);
      }
      return { role, scenarioId, patchHash: view.branch.patchHash, beforeEvaluationHash: view.result.beforeEvaluationHash, afterEvaluationHash: view.result.afterEvaluationHash };
    }));
    const currentAfter = await options.services.repository.get(accepted.version.planId);
    if (currentAfter.activeVersionId !== currentBefore.activeVersionId || currentAfter.draftRevision !== currentBefore.draftRevision
      || await hashPlanConfig(currentAfter.draft.config) !== configHashBefore) {
      throw new Error("cross-product what-if mutated the active plan");
    }
    return values;
  }));

  checks.push(await checkSafely("journey.provisional-case", async () => {
    const result = await options.services.coordinator!.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const registry = await loadRuntimeCaseAdapterRegistrySnapshotAtRoot(activeRoot, manifest.journey.provisionalCase.registryRef);
      if (!registry || registry.runtimeGeneration !== manifest.runtimeGeneration) throw new Error("provisional case registry snapshot is missing or stale");
      const entries = registry.entries.filter(({ candidateId, identity }) => candidateId === manifest.journey.provisionalCase.candidateId
        && identity.skuId === manifest.journey.provisionalCase.skuId
        && identity.region === manifest.journey.provisionalCase.region
        && identity.revision === manifest.journey.provisionalCase.revision);
      if (entries.length !== 1) throw new Error("provisional case candidate does not resolve to one exact registry entry");
      return { registryRef: registry.registryRef, registryGeneration: registry.registryGeneration, candidateId: entries[0]!.candidateId, identity: entries[0]!.identity };
    });
    return result.result;
  }));

  checks.push(await checkSafely("journey.price-and-job-recovery", async () => {
    accepted ??= await resolvePlan(options.services, manifest.journey.acceptedPlan);
    const [targets, history, events] = await Promise.all([
      options.services.priceRepository.listTargets(),
      options.services.priceRepository.listHistoryPoints(),
      options.services.priceRepository.listTargetEvents(),
    ]);
    const selected = targets.filter(({ target }) => manifest.journey.priceTargetIds.includes(target.targetId));
    if (selected.length !== manifest.journey.priceTargetIds.length
      || selected.some(({ target }) => target.planId !== accepted!.version.planId)
      || selected.some(({ target }) => !history.some((point) => point.skuId === target.skuId
        && point.variantIdentityFactIds.length === target.variantIdentityFactIds.length
        && [...point.variantIdentityFactIds].sort().every((value, index) => value === [...target.variantIdentityFactIds].sort()[index])))
      || selected.some(({ target }) => !events.some((event) => event.targetId === target.targetId))
      || new Set(events.map(({ eventId }) => eventId)).size !== events.length
      || new Set(events.map(({ idempotencyKey }) => idempotencyKey)).size !== events.length) {
      throw new Error("cross-product current/history/target price closure is incomplete or duplicated");
    }
    if (!options.services.planPrices) throw new Error("production plan price service is disabled");
    const priceView = await options.services.planPrices.forPlan(accepted.version.planId);
    const selectedTargetIds = new Set(manifest.journey.priceTargetIds);
    const targetComponents = priceView.components.filter(({ targets: componentTargets }) => (
      componentTargets.some(({ target }) => selectedTargetIds.has(target.targetId))
    ));
    if (targetComponents.length === 0 || targetComponents.some(({ current, history: componentHistory, buyWait }) => (
      !["single", "range"].includes(current.status) || componentHistory.length === 0
      || buyWait.recommendation === "unavailable" || buyWait.confidence === "unavailable"
    ))) throw new Error("cross-product current price or buy/wait projection is unavailable");
    const jobs = new FileJobRepository({ coordinator: options.services.coordinator! });
    const recovered = await Promise.all(manifest.journey.recoveryJobs.map(async (binding) => {
      const job = await jobs.get(binding.jobId);
      if (job.type !== binding.expectedType || job.attempt < 2 || job.revision < 2
        || job.leaseOwner !== undefined || job.leaseToken !== undefined || job.leaseExpiresAt !== undefined
        || !["succeeded", "failed", "dead_letter", "paused_restore_review"].includes(job.status)
        || (job.status === "succeeded" && job.resultRefs.length === 0)) {
        throw new Error(`cross-product ${binding.role} job lacks a restarted stable result`);
      }
      return { role: binding.role, jobId: job.jobId, type: job.type, status: job.status, revision: job.revision, attempt: job.attempt, resultRefs: job.resultRefs };
    }));
    return {
      priceTargetIds: selected.map(({ target }) => target.targetId).sort(),
      historyPointCount: history.length,
      targetEventIds: events.map(({ eventId }) => eventId).sort(),
      buyWait: targetComponents.map(({ instanceId, current, buyWait }) => ({ instanceId, currentStatus: current.status, buyWait })),
      recoveryJobs: recovered,
    };
  }));

  checks.push(await checkSafely("journey.portable-backup-restore-doctor", async () => {
    accepted ??= await resolvePlan(options.services, manifest.journey.acceptedPlan);
    const temporary = await mkdtemp(path.join(tmpdir(), "buildsim-universal-journey-replay-"));
    const portableRoot = path.join(temporary, "portable-runtime");
    const restoreRoot = path.join(temporary, "restored-runtime");
    const portableFile = path.join(temporary, "journey.buildsim");
    const firstBackupFile = path.join(temporary, "journey-first.backup");
    const verifiedBackupFile = path.join(temporary, "journey-verified.backup");
    const portablePassword = "universal journey portable replay password";
    const backupPassword = "universal journey backup replay password";
    const replayedAt = new Date().toISOString();
    try {
      const exported = await createPortablePlanPackage({
        coordinator: options.services.coordinator!,
        outputFile: portableFile,
        password: portablePassword,
        planId: accepted.version.planId,
        portableProfile: "complete",
        redacted: true,
        now: () => replayedAt,
      });
      const opened = await openPortablePlanPackage(portableFile, portablePassword);
      if (!exported.exactReplayReady || !opened.exactReplayReady
        || opened.payload.manifest.manifestHash !== exported.manifest.manifestHash) {
        throw new Error("complete portable package is not exact-replay ready");
      }
      const portableCoordinator = new RuntimeCoordinator({ root: portableRoot, now: () => replayedAt });
      await portableCoordinator.initialize("universal-journey-canary");
      const dryRun = await planPortableImport({
        coordinator: portableCoordinator,
        inputFile: portableFile,
        password: portablePassword,
        mode: "dry_run",
        expectedManifestHash: exported.manifest.manifestHash,
        now: () => replayedAt,
      });
      if (dryRun.plan.action !== "copy_as_new_plan" || dryRun.plan.resultMode !== "exact_replay") {
        throw new Error("complete portable dry-run is not one exact replay into an empty repository");
      }
      const imported = await planPortableImport({
        coordinator: portableCoordinator,
        inputFile: portableFile,
        password: portablePassword,
        mode: "apply",
        expectedManifestHash: dryRun.plan.manifestHash,
        now: () => replayedAt,
      });
      if (imported.importedPlanId !== accepted.version.planId || imported.plan.resultMode !== "exact_replay") {
        throw new Error("complete portable apply changed the plan identity or replay mode");
      }
      const importedServices = replayServices(portableRoot);
      await importedServices.coordinator!.initialize();
      const importedPlan = await resolvePlan(importedServices, manifest.journey.acceptedPlan);

      await createBackup({
        coordinator: options.services.coordinator!,
        outputFile: firstBackupFile,
        password: backupPassword,
        planIds: [accepted.version.planId],
        evaluationHashes: [accepted.receipt.evaluationHash],
        factSnapshotIds: [accepted.receipt.evaluationLock.factSnapshotId],
        userObservationSnapshotIds: [accepted.receipt.evaluationLock.userObservationSnapshotId],
        artifactLockfileRef: `sha256:${accepted.receipt.evaluationLock.artifactLockfileHash}`,
        now: () => replayedAt,
      });
      const firstVerification = await verifyBackup({ inputFile: firstBackupFile, password: backupPassword, now: () => replayedAt });
      if (!firstVerification.valid || firstVerification.report.result !== "pass") throw new Error("first full backup did not verify");
      await persistBackupVerification({ coordinator: options.services.coordinator!, verification: firstVerification });
      const backedUp = await createBackup({
        coordinator: options.services.coordinator!,
        outputFile: verifiedBackupFile,
        password: backupPassword,
        planIds: [accepted.version.planId],
        evaluationHashes: [accepted.receipt.evaluationHash],
        factSnapshotIds: [accepted.receipt.evaluationLock.factSnapshotId],
        userObservationSnapshotIds: [accepted.receipt.evaluationLock.userObservationSnapshotId],
        artifactLockfileRef: `sha256:${accepted.receipt.evaluationLock.artifactLockfileHash}`,
        now: () => replayedAt,
      });
      const backupVerification = await verifyBackup({ inputFile: verifiedBackupFile, password: backupPassword, now: () => replayedAt });
      if (!backupVerification.valid || backupVerification.report.result !== "pass") throw new Error("verified full backup did not verify");

      const restoredCoordinator = new RuntimeCoordinator({ root: restoreRoot, now: () => replayedAt });
      const restored = await restoreBackup({
        coordinator: restoredCoordinator,
        inputFile: verifiedBackupFile,
        password: backupPassword,
        now: () => replayedAt,
      });
      if (!restored.restored) throw new Error("full backup did not restore into the empty runtime");
      const restoredServices = replayServices(restoreRoot);
      await restoredServices.coordinator!.initialize();
      const restoredPlan = await resolvePlan(restoredServices, manifest.journey.acceptedPlan);
      const doctor = await runDoctor({
        coordinator: restoredCoordinator,
        strict: true,
        offline: false,
        now: () => replayedAt,
        referenceClockMs: Date.parse(replayedAt),
        serviceVersionsVerified: true,
        browserWebglAvailable: true,
        searxngAvailable: true,
        pdfParserAvailable: true,
      });
      const doctorVerification = await verifyDoctorReport(doctor.report, {
        doctorVersion: DOCTOR_VERSION,
        checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION,
        runtimeGeneration: doctor.report.runtimeGeneration,
        checkRegistry: DEFAULT_DOCTOR_CHECK_REGISTRY,
        evidenceArtifacts: doctor.evidenceArtifacts,
      });
      if (!doctorVerification.verified || doctor.report.overall !== "healthy" || doctor.exitCode !== 0) {
        const nonPassing = doctor.report.checks.filter(({ status }) => status !== "pass")
          .map(({ checkId, status, summary, evidence }) => `${checkId}:${status}:${summary}:${evidence.map(({ code }) => code).join("+")}`).join(",");
        throw new Error(`restored runtime Doctor is not strictly healthy: ${[
          ...doctorVerification.errors,
          `overall=${doctor.report.overall}`,
          `exitCode=${doctor.exitCode}`,
          `checks=${nonPassing || "none"}`,
        ].join("; ")}`);
      }
      const tuples = [importedPlan, restoredPlan].map(({ version, receipt }) => ({
        planId: version.planId,
        planVersionId: version.id,
        configHash: version.configHash,
        evaluationHash: receipt.evaluationHash,
        evaluationLockHash: receipt.evaluationLock.contentHash,
        factSnapshotHash: receipt.evaluationLock.snapshotHashes.factSnapshotHash,
      }));
      if (tuples.some((tuple) => tuple.configHash !== manifest.journey.acceptedPlan.configHash
        || tuple.evaluationHash !== manifest.journey.acceptedPlan.evaluationHash
        || tuple.evaluationLockHash !== manifest.journey.acceptedPlan.evaluationLockHash
        || tuple.factSnapshotHash !== manifest.journey.acceptedPlan.factSnapshotHash)) {
        throw new Error("portable or backup replay changed the governed plan hash tuple");
      }
      return {
        portableManifestHash: exported.manifest.manifestHash,
        portableDryRunAction: dryRun.plan.action,
        portableResultMode: imported.plan.resultMode,
        backupManifestHash: backedUp.manifest.manifestHash,
        backupVerificationResult: backupVerification.report.result,
        restoredRuntimeGeneration: restored.state.runtimeGeneration,
        doctorReportHash: doctor.report.reportHash,
        doctorOverall: doctor.report.overall,
        replayedPlanHashTuples: tuples,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }));
  return checks;
}
