import { canonicalize, type SnapshotHashes } from "../hash";
import type { BuildPlan, PlanRepository, PlanVersion } from "../plans/contracts";
import { hashPlanConfig } from "../plans/canonical";
import { previewPlanProposal } from "../plans/proposals";
import type { PlanChangeProposal } from "../plans/contracts";
import {
  FileScenarioRepository,
  ScenarioRepositoryError,
  type CreateScenarioBranchInput,
  type CreateScenarioFamilyInput,
} from "../scenarios/repository";
import type { PersistedScenarioBranch, ScenarioFamily } from "../scenarios/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { BuildConfigV3 } from "../topology/contracts";
import {
  ReadonlyWhatIfService,
  type GovernedWhatIfArtifact,
  type WhatIfSnapshotAuthority,
} from "../solver/what-if";
import type { AuthoritativeSolverEvaluationReceipt } from "../solver/solve";
import type { SolverArtifactWriter } from "../solver/solve";
import type { AuthoritativeEvaluationSnapshotPipeline, GovernedEvaluationInput } from "./evaluation-service";
import type { RootBoundSolverCandidateInputAuthority } from "./solver-production";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => allowed.has(field));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function v3Version(
  versions: readonly PlanVersion<BuildConfigV3>[],
  versionId: string,
): PlanVersion<BuildConfigV3> {
  const version = versions.find((candidate) => candidate.id === versionId);
  if (!version || version.config.schemaVersion !== "3.0.0" || !version.evaluationLock || !version.evaluationHash) {
    throw new ScenarioRepositoryError("not_found", "governed V3 scenario base version was not found");
  }
  return structuredClone(version);
}

/** Uses the ordinary repository snapshot pipeline for a server-owned scenario
 * candidate. No config or snapshot authority is accepted from transport. */
export interface PipelineSolverCandidateInputAuthority extends RootBoundSolverCandidateInputAuthority {
  prepareAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
  ): Promise<GovernedEvaluationInput>;
}

export function createPipelineSolverCandidateInputAuthority(
  pipeline: AuthoritativeEvaluationSnapshotPipeline,
): PipelineSolverCandidateInputAuthority {
  const prepared = new Map<string, GovernedEvaluationInput>();
  const keyFor = async (
    activeRoot: string,
    runtimeGeneration: number,
    input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
  ) => `${activeRoot}\0${runtimeGeneration}\0${input.planId}\0${input.basePlanVersionId}\0${await hashPlanConfig(input.config)}`;
  const resolveFresh = (
    activeRoot: string,
    runtimeGeneration: number,
    input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
  ) => pipeline.resolveDetachedCandidateAtRoot(activeRoot, runtimeGeneration, input);
  return Object.freeze({
    authorityKind: "root-bound-solver-candidate-input-authority-v1" as const,
    async prepareAtRoot(
      activeRoot: string,
      runtimeGeneration: number,
      input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
    ) {
      const value = await resolveFresh(activeRoot, runtimeGeneration, input);
      prepared.set(await keyFor(activeRoot, runtimeGeneration, input), structuredClone(value));
      if (prepared.size > 128) prepared.delete(prepared.keys().next().value!);
      return structuredClone(value);
    },
    async resolveAtRoot(
      activeRoot: string,
      runtimeGeneration: number,
      input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
    ): Promise<GovernedEvaluationInput> {
      const key = await keyFor(activeRoot, runtimeGeneration, input);
      const cached = prepared.get(key);
      if (cached) {
        prepared.delete(key);
        return structuredClone(cached);
      }
      return resolveFresh(activeRoot, runtimeGeneration, input);
    },
  });
}

export function createPipelineWhatIfSnapshotAuthority(options: {
  coordinator: RuntimeCoordinator;
  candidates: PipelineSolverCandidateInputAuthority;
}): WhatIfSnapshotAuthority {
  return Object.freeze({
    authorityKind: "what-if-snapshot-authority-v1" as const,
    async resolveRefreshed(input: Parameters<WhatIfSnapshotAuthority["resolveRefreshed"]>[0]) {
      if (await hashPlanConfig(input.beforeConfig) !== input.beforeConfigHash
        || await hashPlanConfig(input.afterConfig) !== input.afterConfigHash) {
        throw new Error("what-if refreshed config authority is inconsistent");
      }
      return (await options.coordinator.withWrite(async ({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => {
        const before = await options.candidates.prepareAtRoot(activeRoot, state.runtimeGeneration, {
          planId: input.planId,
          basePlanVersionId: input.basePlanVersionId,
          config: structuredClone(input.beforeConfig),
        });
        const after = await options.candidates.prepareAtRoot(activeRoot, state.runtimeGeneration, {
          planId: input.planId,
          basePlanVersionId: input.basePlanVersionId,
          config: structuredClone(input.afterConfig),
        });
        return {
          before: structuredClone(before.snapshotHashes),
          after: structuredClone(after.snapshotHashes),
        };
      })).result;
    },
  });
}

export interface ScenarioWhatIfRouteRuntime {
  createFamily(input: unknown): Promise<ScenarioFamily>;
  createBranch(input: unknown): Promise<PersistedScenarioBranch>;
  getScenario(planId: string, scenarioId: string): Promise<{
    family: ScenarioFamily;
    branch: PersistedScenarioBranch;
    config: BuildConfigV3;
    result: Awaited<ReturnType<FileScenarioRepository["getResult"]>>;
  }>;
  evaluate(input: { planId: string; scenarioId: string; refreshSnapshots: boolean }): Promise<{
    artifactRef: string;
    artifact: GovernedWhatIfArtifact;
    result: Awaited<ReturnType<FileScenarioRepository["getResult"]>>;
    before: AuthoritativeSolverEvaluationReceipt;
    after: AuthoritativeSolverEvaluationReceipt;
  }>;
  proposal(planId: string, scenarioId: string): Promise<PlanChangeProposal<BuildConfigV3>>;
}

/** Production facade for immutable scenario creation/evaluation. It never has
 * a PlanRepository write method; accepting a result only returns the ordinary
 * proposal object for the existing approval path. */
export class ProductionScenarioWhatIfRuntime implements ScenarioWhatIfRouteRuntime {
  readonly service: ReadonlyWhatIfService;

  constructor(private readonly options: {
    scenarios: FileScenarioRepository;
    plans: Pick<PlanRepository<BuildConfigV3>, "get" | "listVersions">;
    evaluator: ConstructorParameters<typeof ReadonlyWhatIfService>[0]["evaluator"];
    artifacts: SolverArtifactWriter;
    snapshotAuthority?: WhatIfSnapshotAuthority;
    now?: () => string;
  }) {
    this.service = new ReadonlyWhatIfService({
      scenarios: options.scenarios,
      evaluator: options.evaluator,
      artifacts: options.artifacts,
      ...(options.snapshotAuthority ? { snapshotAuthority: options.snapshotAuthority } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async createFamily(input: unknown): Promise<ScenarioFamily> {
    if (!record(input) || !exact(input, ["familyId", "planId", "name", "basePlanVersionId"])
      || !nonEmpty(input.familyId) || !nonEmpty(input.planId) || !nonEmpty(input.name) || !nonEmpty(input.basePlanVersionId)) {
      throw new TypeError("scenario family request fields are invalid");
    }
    const version = v3Version(
      await this.options.plans.listVersions(input.planId),
      input.basePlanVersionId,
    );
    const familyInput: CreateScenarioFamilyInput = {
      familyId: input.familyId,
      planId: input.planId,
      name: input.name,
      basePlanVersionId: version.id,
      baseConfigHash: version.configHash,
      baseSnapshotHashes: structuredClone(version.evaluationLock!.snapshotHashes),
    };
    return this.options.scenarios.createFamily(familyInput);
  }

  async createBranch(input: unknown): Promise<PersistedScenarioBranch> {
    if (!record(input) || !exact(input, ["scenarioId", "familyId", "planId", "patch"], ["simulationInputPatch"])
      || !nonEmpty(input.scenarioId) || !nonEmpty(input.familyId) || !nonEmpty(input.planId) || !Array.isArray(input.patch)
      || (input.simulationInputPatch !== undefined && !Array.isArray(input.simulationInputPatch))) {
      throw new TypeError("scenario branch request fields are invalid");
    }
    const family = await this.options.scenarios.getFamily(input.familyId);
    if (family.planId !== input.planId) throw new ScenarioRepositoryError("not_found", "scenario family was not found for this plan");
    const branchInput: CreateScenarioBranchInput = {
      scenarioId: input.scenarioId,
      familyId: input.familyId,
      patch: structuredClone(input.patch) as CreateScenarioBranchInput["patch"],
      ...(input.simulationInputPatch === undefined ? {} : {
        simulationInputPatch: structuredClone(input.simulationInputPatch) as NonNullable<CreateScenarioBranchInput["simulationInputPatch"]>,
      }),
      actor: "user",
    };
    return this.options.scenarios.createBranch(branchInput);
  }

  async getScenario(planId: string, scenarioId: string) {
    const view = await this.options.scenarios.materializeComparison(scenarioId);
    if (view.family.planId !== planId) throw new ScenarioRepositoryError("not_found", "scenario was not found for this plan");
    return {
      family: structuredClone(view.family),
      branch: structuredClone(view.branch),
      config: structuredClone(view.config),
      result: await this.options.scenarios.getResult(scenarioId),
    };
  }

  async evaluate(input: { planId: string; scenarioId: string; refreshSnapshots: boolean }) {
    const view = await this.options.scenarios.materializeComparison(input.scenarioId);
    if (view.family.planId !== input.planId) throw new ScenarioRepositoryError("not_found", "scenario was not found for this plan");
    const evaluated = await this.service.evaluate({
      scenarioId: input.scenarioId,
      ...(input.refreshSnapshots ? { refreshSnapshots: true } : {}),
    });
    return { ...evaluated, result: evaluated.result };
  }

  async proposal(planId: string, scenarioId: string) {
    const view = await this.getScenario(planId, scenarioId);
    if (!view.result) throw new ScenarioRepositoryError("conflict", "scenario must be evaluated before proposing acceptance");
    const plan: BuildPlan<BuildConfigV3> = await this.options.plans.get(planId);
    if (!plan.activeVersionId) throw new ScenarioRepositoryError("stale", "active plan has no immutable base version");
    const configHash = await hashPlanConfig(plan.draft.config);
    if (canonicalize(view.family.baseSnapshotHashes) !== canonicalize(view.branch.baseSnapshotHashes)) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario branch snapshot authority changed");
    }
    const acceptance = await this.service.proposalForAcceptance(scenarioId, {
      planId,
      planVersionId: plan.activeVersionId,
      configHash,
      draftRevision: plan.draftRevision,
    });
    if (acceptance.expectedPlanVersionId !== plan.activeVersionId
      || acceptance.expectedConfigHash !== configHash
      || acceptance.expectedDraftRevision !== plan.draftRevision) {
      throw new ScenarioRepositoryError("stale", "scenario proposal no longer matches the active draft");
    }
    return (await previewPlanProposal(plan.draft.config, {
      id: `proposal-${scenarioId}`,
      planId,
      expectedDraftRevision: acceptance.expectedDraftRevision,
      expectedConfigHash: acceptance.expectedConfigHash,
      summary: `采用情景：${view.family.name}`,
      rationale: [
        `情景 ${scenarioId} 已完成只读重评。`,
        view.result.snapshotAttribution === "same_snapshots"
          ? "比较使用同一组非配置快照。"
          : "比较包含事实或市场快照刷新；界面会单独标明。",
        "当前返回值仍是普通方案提案，尚未写入活动方案。",
      ],
      operations: acceptance.operations,
      createdAt: view.result.createdAt,
    })).proposal;
  }
}
