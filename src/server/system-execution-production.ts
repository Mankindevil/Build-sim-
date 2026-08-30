import { randomUUID } from "node:crypto";
import { staleExecutionStepIds, type BuildStepResult, type BuildProcedure } from "../build-execution/contracts";
import { startExecution } from "../build-execution/checklist";
import type { StoredExecutionSession } from "../build-execution/repository";
import { ExecutionRepository, ExecutionRepositoryError } from "../build-execution/repository";
import { generateFirstBootProcedure, type GeneratedBuildProcedure } from "../build-execution/first-boot";
import { generatePartialPreparationProcedure } from "../build-execution/partial-preparation";
import { isProgressiveBuildEvaluation, type ProgressiveBuildEvaluation } from "../compatibility/contracts";
import type { FactRepository } from "../facts/repository";
import type { DomainHashes } from "../hash";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import type { ObservationRepository } from "../observations/repository";
import { canonicalJson } from "../plans/canonical";
import type { PlanVersion } from "../plans/contracts";
import type { EvaluationLockRepository } from "../plans/evaluation-lock-repository";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  projectProductionTrueNasLayout,
  type ProductionStorageLayoutProjection,
} from "../storage/production";
import type { DestructiveActionPlan } from "../storage/contracts";
import { createDestructiveActionPlan } from "../storage/truenas";
import type { FirmwarePathEvaluation } from "../firmware/contracts";
import { SystemProfileRegistry } from "../system-profiles/registry";
import { systemProfileEvaluationFromProgressive } from "../system-profiles/production";
import type { SystemProfileDefinition, SystemProfileEvaluation } from "../system-profiles/contracts";
import type { BuildConfigV3 } from "../topology/contracts";
import type {
  AuthoritativeEvaluationReceipt,
} from "./evaluation-service";

export class SystemExecutionProductionError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "blocked" | "invalid_input" | "unavailable", message: string) {
    super(message);
    this.name = "SystemExecutionProductionError";
  }
}

export interface SystemExecutionPlanAuthority {
  versionAtRoot(activeRoot: string, planId: string, planVersionId: string): Promise<PlanVersion<BuildConfigV3> | null>;
  versionIdsAtRoot(activeRoot: string, planId: string): Promise<readonly string[]>;
  activeVersionIdAtRoot(activeRoot: string, planId: string): Promise<string | null>;
}

export interface SystemProcedurePreview {
  readonly schemaVersion: "system-procedure-preview-v1";
  readonly mode: "preparation_only" | "full_execution";
  readonly planId: string;
  readonly planVersionId: string;
  readonly configHash: string;
  readonly evaluationHash: string;
  readonly evaluationLockHash: string;
  readonly profile: SystemProfileDefinition | null;
  readonly systemEvaluation: SystemProfileEvaluation | null;
  readonly firmwareEvaluations: readonly FirmwarePathEvaluation[];
  readonly storageLayouts: readonly ProductionStorageLayoutProjection[];
  readonly blockers: readonly string[];
  readonly generated: GeneratedBuildProcedure | null;
  readonly destructiveActions: readonly {
    readonly stepId: string;
    readonly plan: DestructiveActionPlan | null;
    readonly blockedReason: string | null;
  }[];
}

export interface RecordExecutionStepInput {
  readonly planId: string;
  readonly executionSessionId: string;
  readonly expectedRevision: number;
  readonly expectedHash: string;
  readonly stepId: string;
  readonly result: BuildStepResult["result"];
  readonly note?: string;
  readonly observationIds?: readonly string[];
}

export interface ConfirmDestructiveActionInput {
  readonly planId: string;
  readonly executionSessionId: string;
  readonly expectedRevision: number;
  readonly expectedHash: string;
  readonly stepId: string;
}

export interface RevalidateExecutionSessionInput {
  readonly planId: string;
  readonly executionSessionId: string;
  readonly againstPlanVersionId: string;
  readonly expectedRevision: number;
  readonly expectedHash: string;
}

function digest(domain: string, value: unknown): string {
  const hash = sha256Utf8Runtime(`buildsim:${domain}:${canonicalJson(value)}`);
  if (hash === null) throw new TypeError(`${domain} cannot be hashed`);
  return hash;
}

function procedureDomainHashes(evaluation: ProgressiveBuildEvaluation, systemEvaluation: SystemProfileEvaluation | null, storageLayouts: readonly ProductionStorageLayoutProjection[]): DomainHashes {
  const authority = evaluation.authority;
  const domain = (names: readonly string[]) => evaluation.domainEvaluations.filter((entry) => names.includes(entry.domain));
  const compatibilityHash = digest("procedure-compatibility-v1", {
    authority: { configHash: authority.configHash, ruleSet: authority.ruleSet, engine: authority.engine },
    domains: domain(["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing"]),
    systemEvaluationHash: systemEvaluation?.contentHash ?? null,
  });
  const spatialHash = digest("procedure-spatial-v1", {
    configHash: authority.configHash,
    adapterSnapshot: authority.adapterSnapshot,
    observationSnapshotHash: authority.snapshotHashes.userObservationSnapshotHash,
    domains: domain(["mechanical", "assembly", "routing"]),
  });
  const simulationHash = digest("procedure-simulation-v1", {
    simulationModelHash: authority.snapshotHashes.simulationModelHash,
    simulationInputHash: authority.snapshotHashes.simulationInputHash,
    storageLayouts: storageLayouts.map((entry) => entry.status === "ready"
      ? { layoutId: entry.layoutId, layoutSelectionHash: entry.evaluation.layoutSelectionHash }
      : { layoutId: entry.layoutId, blocked: entry.reasons }),
  });
  const procedureSafetyHash = digest("procedure-safety-input-v1", {
    compatibilityHash,
    spatialHash,
    simulationHash,
    firmwareEvaluationHashes: evaluation.firmwareEvaluations.map(({ contentHash }) => contentHash).sort(),
    systemEvaluationHash: systemEvaluation?.contentHash ?? null,
  });
  const priceHash = digest("procedure-price-v1", evaluation.priceProjection);
  return { compatibilityHash, spatialHash, simulationHash, procedureSafetyHash, priceHash };
}

function exactReceipt(receipt: AuthoritativeEvaluationReceipt, planId: string, version: PlanVersion<BuildConfigV3>): ProgressiveBuildEvaluation {
  if (receipt.planId !== planId
    || receipt.configHash !== version.configHash || receipt.evaluationLock.contentHash !== version.evaluationLock?.contentHash
    || receipt.evaluationHash !== version.evaluationHash || !isProgressiveBuildEvaluation(receipt.evaluation)) {
    throw new SystemExecutionProductionError("conflict", "saved version does not have one exact governed progressive receipt");
  }
  return receipt.evaluation;
}

function changedProcedureStepIds(previous: BuildProcedure, current: BuildProcedure): string[] {
  const previousById = new Map(previous.steps.map((step) => [step.stepId, step.dependencyHash]));
  const currentById = new Map(current.steps.map((step) => [step.stepId, step.dependencyHash]));
  return [...new Set([...previousById.keys(), ...currentById.keys()])]
    .filter((stepId) => previousById.get(stepId) !== currentById.get(stepId))
    .sort();
}

export class ProductionSystemExecutionRuntime {
  private readonly executions: ExecutionRepository;
  private readonly now: () => string;

  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    plans: SystemExecutionPlanAuthority;
    locks: EvaluationLockRepository;
    facts: FactRepository;
    observations: ObservationRepository;
    storageLayoutEnabled?: boolean;
    executions?: ExecutionRepository;
    now?: () => string;
  }) {
    this.executions = options.executions ?? new ExecutionRepository({ coordinator: options.coordinator });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async version(planId: string, planVersionId: string): Promise<PlanVersion<BuildConfigV3>> {
    await this.options.coordinator.initialize();
    const result = await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
      this.options.plans.versionAtRoot(activeRoot, planId, planVersionId)
    ));
    const version = result.result as PlanVersion<BuildConfigV3> | null;
    if (!version) throw new SystemExecutionProductionError("not_found", "plan version was not found");
    if (!version.evaluationLock || !version.evaluationHash || !version.evaluatedAt) {
      throw new SystemExecutionProductionError("blocked", "plan version lacks a governed evaluation lock");
    }
    return version;
  }

  async preview(planId: string, planVersionId: string): Promise<SystemProcedurePreview> {
    const initialVersion = await this.version(planId, planVersionId);
    const snapshot = await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const version = await this.options.plans.versionAtRoot(activeRoot, planId, planVersionId);
      if (!version || !version.evaluationLock || !version.evaluationHash || !version.evaluatedAt
        || version.configHash !== initialVersion.configHash) {
        throw new SystemExecutionProductionError("conflict", "plan version authority changed while preparing the procedure");
      }
      const receipt = await this.options.locks.getIssuedVersionReceiptAtRoot(activeRoot, {
        planId,
        configHash: version.configHash,
        evaluationHash: version.evaluationHash,
        evaluatedAt: version.evaluatedAt!,
        evaluationLock: version.evaluationLock,
      });
      if (!receipt) throw new SystemExecutionProductionError("conflict", "saved version receipt is unavailable");
      const progressive = exactReceipt(receipt, planId, version);
      if (version.config.system === null) {
        return { version, receipt, progressive, profile: null, systemEvaluation: null, storageLayouts: [] };
      }
      const artifacts = await this.options.locks.hydrateArtifactInputsAtRoot(activeRoot, version.evaluationLock);
      const registry = new SystemProfileRegistry((artifacts.systemProfile.payload as { registry?: unknown }).registry);
      const profile = registry.resolve(version.config.system.profileId);
      if (version.config.system.versionFactId !== profile.releaseFactId) {
        throw new SystemExecutionProductionError("conflict", "saved system release differs from the locked profile registry");
      }
      const systemEvaluation = systemProfileEvaluationFromProgressive(progressive, profile, version.config.system.source);
      if (!systemEvaluation) throw new SystemExecutionProductionError("blocked", "the governed receipt lacks a complete U7 system-profile evaluation");
      const factClosure = await this.options.facts.getSnapshotClosureAtRoot(activeRoot, version.evaluationLock.factSnapshotId);
      const observationClosure = await this.options.observations.getSnapshotClosureAtRoot(
        activeRoot,
        planId,
        version.evaluationLock.userObservationSnapshotId,
      );
      if (!factClosure || factClosure.snapshot.contentHash !== version.evaluationLock.snapshotHashes.factSnapshotHash
        || !observationClosure || observationClosure.snapshot.contentHash !== version.evaluationLock.snapshotHashes.userObservationSnapshotHash) {
        throw new SystemExecutionProductionError("unavailable", "procedure fact/observation closure cannot be replayed");
      }
      const storageLayouts = this.options.storageLayoutEnabled !== false
        && version.config.system.profileId === "system.truenas-scale"
        ? await Promise.all(version.config.logicalLayouts.map((selection) => projectProductionTrueNasLayout({
          config: version.config,
          configHash: version.configHash,
          selection,
          facts: factClosure.facts,
          observations: observationClosure.observations.map(({ observation }) => observation),
        }))) : [];
      return { version, receipt, progressive, profile, systemEvaluation, storageLayouts };
    });
    const value = snapshot.result as {
      version: PlanVersion<BuildConfigV3>;
      receipt: AuthoritativeEvaluationReceipt;
      progressive: ProgressiveBuildEvaluation;
      profile: SystemProfileDefinition | null;
      systemEvaluation: SystemProfileEvaluation | null;
      storageLayouts: ProductionStorageLayoutProjection[];
    };
    const blockers = [
      ...(value.profile === null ? ["a system profile must be selected before first-power or installation steps"] : []),
      ...(value.systemEvaluation !== null && value.systemEvaluation.verdict !== "pass"
        ? ["selected system is not yet governed-pass for first-power execution"] : []),
      ...(!value.progressive.readiness.powerReady ? ["power readiness is not established"] : []),
      ...(!value.progressive.readiness.firstBootReady ? ["first-boot readiness is not established"] : []),
      ...(value.profile?.profileId === "system.truenas-scale" && this.options.storageLayoutEnabled === false
        ? ["storage layout rollout is disabled"] : []),
      ...(value.profile?.profileId === "system.truenas-scale" && value.version.config.logicalLayouts.length === 0
        ? ["TrueNAS requires one explicit boot/data layout before installation"] : []),
      ...(value.profile?.profileId === "system.truenas-scale" && value.version.config.logicalLayouts.length > 1
        ? ["procedure generation requires one unambiguous active TrueNAS layout"] : []),
      ...value.storageLayouts.flatMap((entry) => entry.status === "blocked" ? entry.reasons : []),
    ];
    const readyStorage = value.storageLayouts.length === 1 && value.storageLayouts[0]?.status === "ready"
      ? value.storageLayouts[0].evaluation : null;
    const domainHashes = procedureDomainHashes(value.progressive, value.systemEvaluation, value.storageLayouts);
    const evaluatorAuthority = {
      evaluatorArtifactRef: `evaluation-artifact:${value.progressive.authority.engine.contentHash}` as const,
      evaluatorArtifactHash: value.progressive.authority.engine.contentHash,
      evaluatorVersion: "progressive-build-evaluation-v1",
    };
    const mode = blockers.length === 0 ? "full_execution" as const : "preparation_only" as const;
    const generated = mode === "full_execution"
      ? generateFirstBootProcedure({
        planVersionId,
        config: value.version.config,
        evaluationHash: value.receipt.evaluationHash,
        domainHashes,
        profile: value.profile!,
        systemEvaluation: value.systemEvaluation!,
        firmwareEvaluations: value.progressive.firmwareEvaluations,
        storageEvaluation: readyStorage,
        ...evaluatorAuthority,
      })
      : generatePartialPreparationProcedure({
        planVersionId,
        config: value.version.config,
        evaluationHash: value.receipt.evaluationHash,
        evaluation: value.progressive,
        domainHashes,
        ...evaluatorAuthority,
      });
    const readyProjection = value.storageLayouts.length === 1 && value.storageLayouts[0]?.status === "ready"
      ? value.storageLayouts[0] : null;
    const planRevisionHash = digest("plan-version-revision-v1", {
      planId,
      planVersionId,
      configHash: value.version.configHash,
    });
    const destructiveActions = (generated?.procedure.steps ?? []).filter(({ riskLevel }) => riskLevel === "destructive").map((step) => {
      const targetsBootPool = step.stepId === "commission-truenas-install-target"
        || step.stepId === "commission-truenas-data-protection";
      if (!targetsBootPool || !readyProjection) return {
        stepId: step.stepId,
        plan: null,
        blockedReason: targetsBootPool
          ? "one exact ready TrueNAS layout is required before disk confirmation"
          : "this destructive setting requires a dedicated non-disk confirmation flow",
      };
      const plan = createDestructiveActionPlan({
        actionId: `destructive.${step.stepId}`,
        diskInstanceIds: value.version.config.logicalLayouts[0]?.bootPoolDiskIds ?? [],
        disks: readyProjection.disks,
        planId,
        planVersionId,
        configHash: value.version.configHash,
        planRevisionHash,
        procedureSafetyHash: generated!.procedure.procedureSafetyHash,
      });
      return {
        stepId: step.stepId,
        plan,
        blockedReason: plan ? null : "every target disk requires one unique current physical locator observation",
      };
    });
    return {
      schemaVersion: "system-procedure-preview-v1",
      mode,
      planId,
      planVersionId,
      configHash: value.version.configHash,
      evaluationHash: value.receipt.evaluationHash,
      evaluationLockHash: value.receipt.evaluationLock.contentHash,
      profile: structuredClone(value.profile),
      systemEvaluation: structuredClone(value.systemEvaluation),
      firmwareEvaluations: structuredClone(value.progressive.firmwareEvaluations),
      storageLayouts: structuredClone(value.storageLayouts),
      blockers: [...new Set(blockers)].sort(),
      generated: generated ? structuredClone(generated) : null,
      destructiveActions: structuredClone(destructiveActions),
    };
  }

  async start(planId: string, planVersionId: string): Promise<StoredExecutionSession> {
    const preview = await this.preview(planId, planVersionId);
    if (!preview.generated) throw new SystemExecutionProductionError("blocked", preview.blockers.join("; ") || "procedure is not executable");
    const runtimeGeneration = (await this.options.coordinator.initialize()).runtimeGeneration;
    return startExecution({
      repository: this.executions,
      generated: preview.generated,
      planVersionId,
      leaseToken: `execution-lease-${randomUUID()}`,
      leaseExpiresAt: new Date(Date.parse(this.now()) + 24 * 60 * 60 * 1_000).toISOString(),
      runtimeGeneration,
    });
  }

  async list(planId: string): Promise<StoredExecutionSession[]> {
    const versionIds = await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
      this.options.plans.versionIdsAtRoot(activeRoot, planId)
    ));
    const allowed = new Set(versionIds.result as readonly string[]);
    return (await this.executions.list()).filter(({ session }) => allowed.has(session.planVersionId));
  }

  async get(planId: string, executionSessionId: string): Promise<StoredExecutionSession> {
    const stored = await this.executions.get(executionSessionId);
    const allowed = await this.list(planId);
    if (!allowed.some(({ session }) => session.executionSessionId === executionSessionId)) {
      throw new SystemExecutionProductionError("not_found", "execution session was not found for this plan");
    }
    return stored;
  }

  private async activeVersionId(planId: string): Promise<string | null> {
    const snapshot = await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
      this.options.plans.activeVersionIdAtRoot(activeRoot, planId)
    ));
    return snapshot.result as string | null;
  }

  private activeVersionPrecommitAuthorizer(planId: string, expectedActiveVersionId: string) {
    return async ({ activeRoot }: { activeRoot: string }): Promise<boolean> => (
      await this.options.plans.activeVersionIdAtRoot(activeRoot, planId)
    ) === expectedActiveVersionId;
  }

  async revalidate(input: RevalidateExecutionSessionInput): Promise<StoredExecutionSession> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.expectedHash)
      || !input.againstPlanVersionId) {
      throw new SystemExecutionProductionError("invalid_input", "execution revalidation guards are invalid");
    }
    const stored = await this.get(input.planId, input.executionSessionId);
    if (stored.revision !== input.expectedRevision || stored.recordHash !== input.expectedHash) {
      throw new SystemExecutionProductionError("conflict", "execution session changed before revalidation");
    }
    if (stored.session.status === "stale" || stored.session.status === "abandoned") return stored;
    if (await this.activeVersionId(input.planId) !== input.againstPlanVersionId) {
      throw new SystemExecutionProductionError("conflict", "execution revalidation target is not the active saved version");
    }

    let preview: SystemProcedurePreview;
    try {
      preview = await this.preview(input.planId, input.againstPlanVersionId);
    } catch (error) {
      if (!(error instanceof SystemExecutionProductionError)) throw error;
      if (error.code === "not_found" || error.code === "invalid_input") throw error;
      preview = {
        schemaVersion: "system-procedure-preview-v1",
        mode: "preparation_only",
        planId: input.planId,
        planVersionId: input.againstPlanVersionId,
        configHash: "0".repeat(64),
        evaluationHash: "0".repeat(64),
        evaluationLockHash: "0".repeat(64),
        profile: {} as SystemProfileDefinition,
        systemEvaluation: {} as SystemProfileEvaluation,
        firmwareEvaluations: [],
        storageLayouts: [],
        blockers: [error.message],
        generated: null,
        destructiveActions: [],
      };
    }

    const targetProcedure = preview.generated?.procedure ?? null;
    const changedStepIds = targetProcedure
      ? changedProcedureStepIds(stored.replayContext.procedure, targetProcedure)
      : stored.replayContext.procedure.steps.map(({ stepId }) => stepId).sort();
    const staleConfirmedStepIds = targetProcedure ? staleExecutionStepIds(stored.session, targetProcedure).sort() : stored.session.results.map(({ stepId }) => stepId).sort();
    const safetyHashChanged = !targetProcedure || targetProcedure.procedureSafetyHash !== stored.session.procedureSafetyHash;
    if (targetProcedure && !safetyHashChanged && changedStepIds.length === 0 && staleConfirmedStepIds.length === 0) return stored;

    const staleReason = [
      `revalidated against plan version ${input.againstPlanVersionId}`,
      `safety hash changed: ${safetyHashChanged ? "yes" : "no"}`,
      `changed steps: ${changedStepIds.length ? changedStepIds.join(",") : "none"}`,
      `stale confirmed steps: ${staleConfirmedStepIds.length ? staleConfirmedStepIds.join(",") : "none"}`,
      ...(preview.blockers.length ? [`blockers: ${preview.blockers.join(" | ")}`] : []),
    ].join("; ");
    try {
      return await this.executions.commit(input.executionSessionId, {
        session: { ...stored.session, status: "stale", staleReason },
        procedure: stored.replayContext.procedure,
        dependencyContext: stored.replayContext.dependencyContext,
        expectedRevision: stored.revision,
        expectedHash: stored.recordHash,
        leaseToken: stored.leaseToken,
        runtimeGeneration: stored.runtimeGeneration,
        precommitAuthorizer: this.activeVersionPrecommitAuthorizer(input.planId, input.againstPlanVersionId),
      });
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) {
        const code = error.code === "not_found" ? "not_found" : error.code === "invalid_input" ? "invalid_input" : "conflict";
        throw new SystemExecutionProductionError(code, error.message);
      }
      throw error;
    }
  }

  private async revalidateAgainstActiveVersion(stored: StoredExecutionSession, planId: string): Promise<{
    stored: StoredExecutionSession;
    activeVersionId: string;
  }> {
    const activeVersionId = await this.activeVersionId(planId);
    if (!activeVersionId) throw new SystemExecutionProductionError("conflict", "plan has no active saved version for execution");
    if (activeVersionId === stored.session.planVersionId) return { stored, activeVersionId };
    const revalidated = await this.revalidate({
      planId,
      executionSessionId: stored.session.executionSessionId,
      againstPlanVersionId: activeVersionId,
      expectedRevision: stored.revision,
      expectedHash: stored.recordHash,
    });
    if (revalidated.session.status === "stale") {
      throw new SystemExecutionProductionError("conflict", "execution session became stale against the active saved version");
    }
    return { stored: revalidated, activeVersionId };
  }

  async recordStep(input: RecordExecutionStepInput): Promise<StoredExecutionSession> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.expectedHash)) {
      throw new SystemExecutionProductionError("invalid_input", "execution revision/hash guard is invalid");
    }
    let stored = await this.get(input.planId, input.executionSessionId);
    if (stored.revision !== input.expectedRevision || stored.recordHash !== input.expectedHash) {
      throw new SystemExecutionProductionError("conflict", "execution session changed before the step result was recorded");
    }
    const current = await this.revalidateAgainstActiveVersion(stored, input.planId);
    stored = current.stored;
    const step = stored.replayContext.procedure.steps.find(({ stepId }) => stepId === input.stepId);
    if (!step) throw new SystemExecutionProductionError("not_found", "procedure step was not found");
    if (stored.session.status !== "active") throw new SystemExecutionProductionError("conflict", "execution session is not active");
    if (stored.session.results.some(({ stepId }) => stepId === input.stepId)) throw new SystemExecutionProductionError("conflict", "procedure step already has a result");
    if (step.riskLevel === "destructive" && !(stored.session.destructiveActionConfirmations ?? []).some((action) => (
      action.actionId === `destructive.${step.stepId}`
      && action.confirmation === "confirmed"
      && action.inputPlanVersionId === stored.session.planVersionId
      && action.inputProcedureSafetyHash === stored.session.procedureSafetyHash
    ))) {
      throw new SystemExecutionProductionError("blocked", "destructive steps require a separately confirmed exact-disk action plan");
    }
    if (step.safetyCritical && input.result === "skipped_non_safety") {
      throw new SystemExecutionProductionError("invalid_input", "a safety-critical step cannot be skipped");
    }
    if (step.confirmationPolicy === "observation_required" && input.result === "confirmed"
      && (!input.observationIds || input.observationIds.length === 0)) {
      throw new SystemExecutionProductionError("invalid_input", "this step requires at least one observation ID");
    }
    const result: BuildStepResult = {
      stepId: step.stepId,
      result: input.result,
      at: this.now(),
      actor: "user",
      confirmedAgainstDependencyHash: step.dependencyHash,
      ...(input.note ? { note: input.note } : {}),
      ...(input.observationIds ? { observationIds: [...new Set(input.observationIds)].sort() } : {}),
    };
    const results = [...stored.session.results, result];
    const resolved = stored.replayContext.procedure.steps.every((candidate) => results.some((entry) => entry.stepId === candidate.stepId
      && (entry.result === "confirmed" || (!candidate.safetyCritical && entry.result === "skipped_non_safety"))));
    try {
      return await this.executions.commit(input.executionSessionId, {
        session: { ...stored.session, results, status: resolved ? "completed" : "active" },
        procedure: stored.replayContext.procedure,
        dependencyContext: stored.replayContext.dependencyContext,
        expectedRevision: stored.revision,
        expectedHash: stored.recordHash,
        leaseToken: stored.leaseToken,
        runtimeGeneration: stored.runtimeGeneration,
        precommitAuthorizer: this.activeVersionPrecommitAuthorizer(input.planId, current.activeVersionId),
      });
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) {
        const code = error.code === "not_found" ? "not_found" : error.code === "invalid_input" ? "invalid_input" : "conflict";
        throw new SystemExecutionProductionError(code, error.message);
      }
      throw error;
    }
  }

  async confirmDestructiveAction(input: ConfirmDestructiveActionInput): Promise<StoredExecutionSession> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.expectedHash)) {
      throw new SystemExecutionProductionError("invalid_input", "destructive confirmation revision/hash guard is invalid");
    }
    let stored = await this.get(input.planId, input.executionSessionId);
    if (stored.revision !== input.expectedRevision || stored.recordHash !== input.expectedHash) {
      throw new SystemExecutionProductionError("conflict", "execution session changed before destructive confirmation");
    }
    const current = await this.revalidateAgainstActiveVersion(stored, input.planId);
    stored = current.stored;
    const step = stored.replayContext.procedure.steps.find(({ stepId }) => stepId === input.stepId);
    if (!step || step.riskLevel !== "destructive") {
      throw new SystemExecutionProductionError("not_found", "destructive procedure step was not found");
    }
    if (stored.session.status !== "active") throw new SystemExecutionProductionError("conflict", "execution session is not active");
    if (!step.dependsOn.every((dependencyId) => stored.session.results.some((result) => result.stepId === dependencyId && result.result === "confirmed"))) {
      throw new SystemExecutionProductionError("conflict", "destructive step dependencies are not confirmed");
    }
    const preview = await this.preview(input.planId, stored.session.planVersionId);
    if (!preview.generated || preview.generated.procedure.procedureId !== stored.session.procedureId
      || preview.generated.procedure.procedureSafetyHash !== stored.session.procedureSafetyHash) {
      throw new SystemExecutionProductionError("conflict", "destructive confirmation procedure authority changed");
    }
    const candidate = preview.destructiveActions.find(({ stepId }) => stepId === input.stepId);
    if (!candidate?.plan) throw new SystemExecutionProductionError("blocked", candidate?.blockedReason ?? "exact disk confirmation is unavailable");
    const confirmed: DestructiveActionPlan = {
      ...candidate.plan,
      confirmation: "confirmed",
      confirmationAt: this.now(),
    };
    const existing = (stored.session.destructiveActionConfirmations ?? []).find(({ actionId }) => actionId === confirmed.actionId);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(confirmed)) return stored;
      throw new SystemExecutionProductionError("conflict", "destructive action already has a different confirmation");
    }
    try {
      return await this.executions.commit(input.executionSessionId, {
        session: {
          ...stored.session,
          destructiveActionConfirmations: [...(stored.session.destructiveActionConfirmations ?? []), confirmed],
        },
        procedure: stored.replayContext.procedure,
        dependencyContext: stored.replayContext.dependencyContext,
        expectedRevision: stored.revision,
        expectedHash: stored.recordHash,
        leaseToken: stored.leaseToken,
        runtimeGeneration: stored.runtimeGeneration,
        precommitAuthorizer: this.activeVersionPrecommitAuthorizer(input.planId, current.activeVersionId),
      });
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) {
        const code = error.code === "not_found" ? "not_found" : error.code === "invalid_input" ? "invalid_input" : "conflict";
        throw new SystemExecutionProductionError(code, error.message);
      }
      throw error;
    }
  }
}
