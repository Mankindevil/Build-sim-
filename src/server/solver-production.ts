import {
  ARTIFACT_LOCK_ROLES,
  canonicalize,
  createArtifactLockfile,
  legacySha256Hex,
  type ArtifactLockEntries,
  type SnapshotHashes,
} from "../hash";
import { evaluateProgressiveCompatibility } from "../compatibility/engine";
import type { ProgressiveBuildEvaluation } from "../compatibility/contracts";
import { createPlanEvaluationLock } from "../plans/evaluation-lock";
import { authoritativeEvaluationHash } from "../plans/evaluation";
import type { BuildConfigV3 } from "../topology/contracts";
import { configV3Hash } from "../topology/hash";
import type { GovernedEvaluationInput, GovernedEvaluationResult } from "./evaluation-service";
import type {
  AuthoritativeEvaluationReceipt,
  EvaluationReceiptAuthority,
  EvaluationSnapshotAuthority,
  EvaluationTargetAuthority,
} from "./evaluation-service";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type {
  AuthoritativeSolverEvaluationReceipt,
  AuthoritativeSolverEvaluator,
} from "../solver/solve";
import type { DomainCoverage } from "../solver/contracts";
import {
  SolverArtifactStore,
  WholeBuildSolverService,
  WHOLE_BUILD_SOLVER_JOB_TYPE,
  type EnqueueWholeBuildSolveInput,
  type SolverBaseAuthority,
  type SolverBaseSnapshot,
  type SolverRequirementAuthority,
} from "./solver-service";
import { validateSolverProgressiveEvaluationClosureRuntime } from "../solver/runtime-validation.mjs";
import {
  AuthoritativeCapabilityCandidateService,
  type RootBoundCapabilityIndexAuthority,
} from "../solver/capability-candidates";
import { createCapabilityRecord, type CapabilityRecord } from "../capabilities/facets";
import { CAPABILITY_FACET_REGISTRY, isComponentKindId, type CapabilityFacet } from "../contracts/registries";
import type { FactRepository } from "../facts/repository";
import type { FactRecord } from "../facts/contracts";
import type { EvidenceClaimRepository } from "../evidence/claim-repository";
import type { PlanVersion } from "../plans/contracts";
import type { EvaluationLockRepository } from "../plans/evaluation-lock-repository";
import type { SolverComponentRequirement } from "../solver/candidate-index";
import { isProgressiveBuildEvaluation } from "../compatibility/contracts";
import { FileJobRepository, JobRepositoryError, type BackgroundJob } from "../jobs";
import { DurableJobScheduler, DurableJobWorker } from "../jobs/worker";

export interface ProductionSolverEvaluationBase {
  planId: string;
  basePlanVersionId: string;
  input: GovernedEvaluationInput;
}

/** Resolves one immutable version and its exact replay input at an active root. */
export interface RootBoundSolverEvaluationAuthority {
  readonly authorityKind: "root-bound-solver-evaluation-authority-v1";
  resolveAtRoot(
    activeRoot: string,
    input: { planId: string; basePlanVersionId: string },
  ): Promise<ProductionSolverEvaluationBase | null>;
}

export interface RootBoundSolverCandidateInputAuthority {
  readonly authorityKind: "root-bound-solver-candidate-input-authority-v1";
  resolveAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    input: { planId: string; basePlanVersionId: string; config: BuildConfigV3 },
  ): Promise<GovernedEvaluationInput>;
}

export interface GovernedSolverCandidateEvaluator {
  readonly authorityKind: "governed-solver-candidate-evaluator-v1";
  evaluate(input: GovernedEvaluationInput): Promise<GovernedEvaluationResult>;
}

/** Rehydrates a saved V3 version from the same repositories as ordinary evaluation. */
export function createRootBoundSolverEvaluationAuthority(options: {
  targets: EvaluationTargetAuthority;
  snapshots: EvaluationSnapshotAuthority;
  locks: EvaluationLockRepository;
}): RootBoundSolverEvaluationAuthority {
  return Object.freeze({
    authorityKind: "root-bound-solver-evaluation-authority-v1" as const,
    async resolveAtRoot(activeRoot: string, request: { planId: string; basePlanVersionId: string }) {
      const target = await options.targets.readTargetAtRoot(activeRoot, request.planId, {
        kind: "version",
        versionId: request.basePlanVersionId,
      });
      if (target.planId !== request.planId || target.planVersionId !== request.basePlanVersionId
        || target.config.schemaVersion !== "3.0.0" || !target.pinnedEvaluationLock
        || !await options.locks.verifyAtRoot(activeRoot, target.pinnedEvaluationLock)) return null;
      const artifacts = await options.snapshots.loadArtifactsAtRoot(activeRoot, target, 1);
      const entries = Object.fromEntries(ARTIFACT_LOCK_ROLES.map((role) => [role, artifacts[role].ref])) as ArtifactLockEntries;
      const artifactLockfile = await createArtifactLockfile(entries);
      const factClosure = await options.snapshots.resolveFactSnapshotAtRoot(activeRoot, target);
      const observationClosure = await options.snapshots.resolveObservationSnapshotAtRoot(activeRoot, target, artifacts);
      const externalInputs = await options.snapshots.loadExternalInputsAtRoot(activeRoot, target, {
        factSnapshot: factClosure.snapshot,
        observationSnapshot: observationClosure.snapshot,
        artifactLockfile,
        caseInstanceOverrides: [],
      });
      const lock = target.pinnedEvaluationLock;
      if (artifactLockfile.lockfileHash !== lock.artifactLockfileHash
        || lock.snapshotHashes.factSnapshotHash !== factClosure.snapshot.contentHash
        || lock.snapshotHashes.userObservationSnapshotHash !== observationClosure.snapshot.contentHash
        || lock.snapshotHashes.requirementSpecHash !== externalInputs.requirementSpec.ref.contentHash
        || lock.snapshotHashes.priceSnapshotHash !== externalInputs.priceSnapshot.ref.contentHash
        || lock.snapshotHashes.simulationInputHash !== externalInputs.simulationInput.ref.contentHash) return null;
      return {
        planId: request.planId,
        basePlanVersionId: request.basePlanVersionId,
        input: {
          planId: request.planId,
          planVersionId: request.basePlanVersionId,
          draftRevision: 0,
          config: structuredClone(target.config),
          snapshotHashes: structuredClone(lock.snapshotHashes),
          factClosure: structuredClone(factClosure),
          observationClosure: structuredClone(observationClosure),
          artifactLockfile,
          artifacts: structuredClone(artifacts),
          externalInputs: structuredClone(externalInputs),
          evaluationLock: structuredClone(lock),
        },
      };
    },
  });
}

function projectSolverComponentRequirements(evaluation: ProgressiveBuildEvaluation): SolverComponentRequirement[] {
  return evaluation.requirements.filter(({ kind }) => kind === "component").map((requirement) => {
    const category = requirement.predicates.find(({ facetId }) => facetId === "identity.category");
    if (!category || category.operator !== "eq" || typeof category.value !== "string"
      || !isComponentKindId(category.value)) {
      throw new Error(`component requirement ${requirement.requirementId} lacks an exact component kind`);
    }
    return {
      requirementId: requirement.requirementId,
      componentKindId: category.value,
      role: `required-${category.value}`,
      predicates: requirement.predicates.filter(({ facetId }) => facetId !== "identity.category")
        .map((predicate) => structuredClone(predicate)),
      quantity: requirement.quantity,
      hardConstraintIds: requirement.criticality === "normal" ? [] : [requirement.requirementId],
    };
  }).sort((left, right) => compareText(left.requirementId, right.requirementId));
}

/** Produces the immutable base and requirement authorities consumed by the durable solver. */
export function createProductionSolverBaseAuthorities(options: {
  evaluationAuthority: RootBoundSolverEvaluationAuthority;
  receipts: EvaluationReceiptAuthority;
  versionAtRoot(activeRoot: string, planId: string, versionId: string): Promise<PlanVersion<BuildConfigV3> | null>;
  artifactsAtRoot(activeRoot: string): SolverArtifactStore;
}): { baseAuthority: SolverBaseAuthority; requirementAuthority: SolverRequirementAuthority } {
  const resolve = async (activeRoot: string, input: { planId: string; basePlanVersionId: string }) => {
    const [base, version] = await Promise.all([
      options.evaluationAuthority.resolveAtRoot(activeRoot, input),
      options.versionAtRoot(activeRoot, input.planId, input.basePlanVersionId),
    ]);
    if (!base || !version || !version.evaluationLock || !version.evaluationHash
      || version.planId !== input.planId || version.id !== input.basePlanVersionId
      || version.config.schemaVersion !== "3.0.0" || version.configHash !== base.input.snapshotHashes.configHash
      || version.evaluationLock.contentHash !== base.input.evaluationLock.contentHash) return null;
    const receipt = await options.receipts.getReceiptByLockAtRoot(activeRoot, input.planId, {
      kind: "version", versionId: input.basePlanVersionId,
    }, version.evaluationLock.contentHash);
    if (!receipt || receipt.evaluationHash !== version.evaluationHash || !isProgressiveBuildEvaluation(receipt.evaluation)) return null;
    return {
      base,
      version: { ...version, evaluationLock: version.evaluationLock },
      receipt: { ...receipt, evaluation: receipt.evaluation },
    };
  };
  const baseAuthority: SolverBaseAuthority = {
    authorityKind: "solver-base-authority-v1",
    async resolveCurrentAtRoot(activeRoot, input): Promise<SolverBaseSnapshot | null> {
      const resolved = await resolve(activeRoot, input);
      if (!resolved) return null;
      const artifacts = options.artifactsAtRoot(activeRoot);
      const basePlanVersionRef = await artifacts.put("solver-base-plan-version", resolved.version);
      const evaluationLockRef = await artifacts.put("solver-base-evaluation-lock", resolved.version.evaluationLock);
      return {
        planId: input.planId,
        basePlanVersionId: input.basePlanVersionId,
        config: structuredClone(resolved.version.config),
        configHash: resolved.version.configHash,
        snapshotHashes: structuredClone(resolved.version.evaluationLock.snapshotHashes),
        draftRevision: 0,
        basePlanVersionRef,
        evaluationLockRef,
      };
    },
  };
  const requirementAuthority: SolverRequirementAuthority = {
    authorityKind: "solver-requirement-authority-v1",
    async resolveAtRoot(activeRoot, input) {
      const resolved = await resolve(activeRoot, {
        planId: input.base.planId,
        basePlanVersionId: input.base.basePlanVersionId,
      });
      if (!resolved || resolved.version.configHash !== input.base.configHash
        || canonicalize(resolved.version.evaluationLock!.snapshotHashes) !== canonicalize(input.base.snapshotHashes)) {
        throw new Error("solver requirement base authority is stale");
      }
      const requirementClosureRef = await options.artifactsAtRoot(activeRoot).put(
        "solver-requirement-closure",
        resolved.receipt.evaluation.requirementClosure,
      );
      return {
        requirements: projectSolverComponentRequirements(resolved.receipt.evaluation),
        requirementClosureRef,
      };
    },
  };
  return { baseAuthority, requirementAuthority };
}

export interface ProductionWholeBuildSolverStatus {
  job: BackgroundJob;
  result: Awaited<ReturnType<WholeBuildSolverService["result"]>>;
}

export interface WholeBuildSolverRouteRuntime {
  enqueue(input: unknown): Promise<Awaited<ReturnType<WholeBuildSolverService["enqueue"]>>>;
  status(jobId: string): Promise<ProductionWholeBuildSolverStatus>;
  cancel(input: { jobId: string; expectedRevision: number }): Promise<BackgroundJob>;
  resume(input: { jobId: string; expectedRevision: number }): Promise<BackgroundJob>;
}

/** Durable production scheduler and narrow route facade for whole-build solving. */
export class ProductionWholeBuildSolverRuntime implements WholeBuildSolverRouteRuntime {
  readonly jobs: FileJobRepository;
  readonly service: WholeBuildSolverService;
  private readonly scheduler: DurableJobScheduler;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: {
    coordinator: RuntimeCoordinator;
    artifacts: SolverArtifactStore;
    baseAuthority: SolverBaseAuthority;
    requirementAuthority: SolverRequirementAuthority;
    candidateService: AuthoritativeCapabilityCandidateService;
    evaluator: AuthoritativeSolverEvaluator;
    workerId?: string;
    schedulerIntervalMs?: number;
    now?: () => string;
  }) {
    this.jobs = new FileJobRepository({
      coordinator: options.coordinator,
      ...(options.now ? { now: options.now } : {}),
    });
    this.service = new WholeBuildSolverService({
      coordinator: options.coordinator,
      jobs: this.jobs,
      artifacts: options.artifacts,
      baseAuthority: options.baseAuthority,
      requirementAuthority: options.requirementAuthority,
      candidateService: options.candidateService,
      evaluator: options.evaluator,
      ...(options.now ? { now: options.now } : {}),
    });
    const worker = new DurableJobWorker({
      repository: this.jobs,
      workerId: options.workerId ?? "workspace-whole-build-solver",
      handlers: this.service.handlers(),
      types: [WHOLE_BUILD_SOLVER_JOB_TYPE],
    });
    this.scheduler = new DurableJobScheduler(this.jobs, worker);
    this.intervalMs = options.schedulerIntervalMs ?? 250;
  }

  async initialize(): Promise<void> {
    await this.jobs.initialize();
  }

  async enqueue(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("solver request must be an object");
    const value = raw as Record<string, unknown>;
    const keys = ["planId", "basePlanVersionId", "lockedInstanceIds", "requirementSpecId", "limits"];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
      throw new TypeError("solver request fields are invalid");
    }
    return this.service.enqueue(structuredClone(value) as unknown as EnqueueWholeBuildSolveInput);
  }

  async status(jobId: string): Promise<ProductionWholeBuildSolverStatus> {
    if (!/^job-[a-f0-9]{64}$/.test(jobId)) throw new TypeError("solver job ID is invalid");
    const job = await this.jobs.get(jobId);
    if (job.type !== WHOLE_BUILD_SOLVER_JOB_TYPE) throw new JobRepositoryError("not_found", "solver job not found");
    return { job, result: await this.service.result(jobId) };
  }

  async cancel(input: { jobId: string; expectedRevision: number }): Promise<BackgroundJob> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError("solver expectedRevision is invalid");
    return this.jobs.cancel(input.jobId, input.expectedRevision);
  }

  async resume(input: { jobId: string; expectedRevision: number }): Promise<BackgroundJob> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError("solver expectedRevision is invalid");
    return this.jobs.resume(input.jobId, input.expectedRevision);
  }

  tick() { return this.scheduler.tick(); }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.initialize();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.scheduler.tick().catch(() => undefined).finally(() => { this.ticking = false; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface SolverProgressiveEvaluationCoverageArtifact {
  schemaVersion: "solver-progressive-evaluation-coverage-v1";
  evaluationHash: string;
  domainCoverage: DomainCoverage[];
}

export interface SolverProgressiveEvaluationReceiptArtifact {
  schemaVersion: "solver-progressive-evaluation-receipt-v1";
  planId: string;
  basePlanVersionId: string;
  buildConfigHash: string;
  inputHashes: SnapshotHashes;
  evaluationHash: string;
  evaluation: ProgressiveBuildEvaluation;
  replayInput: {
    config: BuildConfigV3;
    evaluationLock: GovernedEvaluationInput["evaluationLock"];
    artifactLockfile: GovernedEvaluationInput["artifactLockfile"];
    ruleSetPayload: unknown;
    enginePayload: unknown;
    adapterSnapshotPayload: unknown;
    priceSnapshot: GovernedEvaluationInput["externalInputs"]["priceSnapshot"];
    factClosure: GovernedEvaluationInput["factClosure"];
    observationClosure: GovernedEvaluationInput["observationClosure"];
    firmwareCapabilities: unknown[];
    firmwarePathInputs: unknown[];
    firmwareFixedPointRootRequirements: unknown[];
    assemblySafetyInputs: unknown[];
    requirementRoots: unknown[];
  };
  coverageArtifactRef: string;
  evaluatedAt: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameNonConfigHashes(actual: SnapshotHashes, expected: SnapshotHashes): boolean {
  return (Object.keys(expected) as Array<keyof SnapshotHashes>)
    .every((field) => field === "configHash" || actual[field] === expected[field]);
}

function exactBaseIdentity(
  left: ProductionSolverEvaluationBase | null,
  right: ProductionSolverEvaluationBase,
): boolean {
  return left !== null && left.planId === right.planId && left.basePlanVersionId === right.basePlanVersionId
    && left.input.evaluationLock.contentHash === right.input.evaluationLock.contentHash
    && canonicalize(left.input.config) === canonicalize(right.input.config)
    && canonicalize(left.input.snapshotHashes) === canonicalize(right.input.snapshotHashes);
}

function capabilityRecordsForSnapshot(
  facts: readonly FactRecord[],
  snapshotId: string,
  snapshotHash: string,
): Promise<CapabilityRecord[]> {
  const productFacts = facts.filter((fact): fact is FactRecord & { subject: Extract<FactRecord["subject"], { kind: "product" }> } => (
    fact.subject.kind === "product" && Boolean(fact.subject.skuId)
    && fact.status === "active" && (fact.authority === "official" || fact.authority === "third_party")
    && Object.hasOwn(CAPABILITY_FACET_REGISTRY, fact.field)
  ));
  const bySku = new Map<string, typeof productFacts>();
  for (const fact of productFacts) bySku.set(fact.subject.skuId!, [...(bySku.get(fact.subject.skuId!) ?? []), fact]);
  return Promise.all([...bySku].flatMap(([subjectSkuId, subjectFacts]) => {
    const categoryFacts = subjectFacts.filter(({ field }) => field === "identity.category");
    if (categoryFacts.length !== 1 || typeof categoryFacts[0]!.value !== "string"
      || !isComponentKindId(categoryFacts[0]!.value)) return [];
    const grouped = new Map<string, typeof subjectFacts>();
    for (const fact of subjectFacts) grouped.set(fact.field, [...(grouped.get(fact.field) ?? []), fact]);
    const facets: CapabilityFacet[] = [];
    for (const [facetId, candidates] of grouped) {
      const first = candidates[0]!;
      if (candidates.some((candidate) => canonicalize(candidate.value) !== canonicalize(first.value)
        || candidate.unit !== first.unit)) continue;
      const contract = CAPABILITY_FACET_REGISTRY[facetId as keyof typeof CAPABILITY_FACET_REGISTRY];
      facets.push({
        facetId: facetId as CapabilityFacet["facetId"],
        value: structuredClone(first.value) as CapabilityFacet["value"],
        ...(first.unit === undefined ? {} : { unitId: first.unit as CapabilityFacet["unitId"] }),
        sourceFactIds: candidates.map(({ factId }) => factId).sort(compareText),
        safetyClass: contract.safetyClass,
      } as CapabilityFacet);
    }
    return [createCapabilityRecord({
      schemaVersion: "capability-record-v1",
      subjectSkuId,
      componentKindId: categoryFacts[0]!.value,
      factSnapshotRef: { snapshotId, contentHash: snapshotHash },
      facets,
      providerRefs: ["provider.fact-snapshot-v1"],
    })];
  }));
}

/** Builds the exact candidate index from the snapshot pinned by the solver request. */
export function createProductionCapabilityCandidateService(options: {
  coordinator: RuntimeCoordinator;
  facts: FactRepository;
  claims: EvidenceClaimRepository;
}): AuthoritativeCapabilityCandidateService {
  const authority: RootBoundCapabilityIndexAuthority = {
    authorityKind: "root-bound-capability-index-authority-v1",
    async resolveAtRoot(activeRoot, planId, expectedFactSnapshotHash) {
      if (!expectedFactSnapshotHash) throw new Error("production capability query requires its exact FactSnapshot hash");
      const snapshotId = `fact-snapshot-sha256-${expectedFactSnapshotHash}`;
      const closure = await options.facts.getSnapshotClosureAtRoot(activeRoot, snapshotId);
      if (!closure || closure.snapshot.contentHash !== expectedFactSnapshotHash) {
        throw new Error("production capability FactSnapshot is unavailable");
      }
      return {
        planId,
        factSnapshot: structuredClone(closure.snapshot),
        capabilityRecords: await capabilityRecordsForSnapshot(
          closure.facts,
          closure.snapshot.snapshotId,
          closure.snapshot.contentHash,
        ),
      };
    },
    getFactAtRoot: (activeRoot, factId) => options.facts.getFactAtRoot(activeRoot, factId),
    getEvidenceClaimAtRoot: (activeRoot, claimId) => options.claims.getClaimAtRoot(activeRoot, claimId),
  };
  return new AuthoritativeCapabilityCandidateService({ coordinator: options.coordinator, authority });
}

/**
 * Evaluates every solver candidate with the same locked progressive evaluator
 * used by an ordinary V3 plan, then persists a self-contained replay receipt.
 */
export class ProductionAuthoritativeSolverEvaluator implements AuthoritativeSolverEvaluator {
  readonly authorityKind = "authoritative-solver-evaluator-v1" as const;

  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    authority: RootBoundSolverEvaluationAuthority;
    candidateInputs?: RootBoundSolverCandidateInputAuthority;
    governedEvaluator?: GovernedSolverCandidateEvaluator;
    artifacts: SolverArtifactStore;
    now?: () => string;
  }) {}

  async evaluate(input: {
    planId: string;
    basePlanVersionId: string;
    candidateConfig: BuildConfigV3;
    expectedInputHashes: SnapshotHashes;
  }): Promise<AuthoritativeSolverEvaluationReceipt> {
    const buildConfigHash = await configV3Hash(input.candidateConfig);
    if (input.expectedInputHashes.configHash !== buildConfigHash) {
      throw new Error("solver candidate expected config hash is stale");
    }
    const prepared = await this.options.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const base = await this.options.authority.resolveAtRoot(activeRoot, {
        planId: input.planId,
        basePlanVersionId: input.basePlanVersionId,
      });
      if (!base) throw new Error("solver evaluation base version is unavailable");
      if (sameNonConfigHashes(input.expectedInputHashes, base.input.snapshotHashes)) {
        return { base, governedInput: base.input, refreshed: false };
      }
      const candidateInputs = this.options.candidateInputs;
      if (!candidateInputs || candidateInputs.authorityKind !== "root-bound-solver-candidate-input-authority-v1") {
        throw new Error("solver candidate expected input hashes are stale; refreshed input authority is unavailable");
      }
      const governedInput = await candidateInputs.resolveAtRoot(activeRoot, state.runtimeGeneration, {
        planId: input.planId,
        basePlanVersionId: input.basePlanVersionId,
        config: structuredClone(input.candidateConfig),
      });
      if (canonicalize(governedInput.snapshotHashes) !== canonicalize(input.expectedInputHashes)) {
        throw new Error("refreshed solver candidate input hashes changed before evaluation");
      }
      return { base, governedInput, refreshed: true };
    });
    const { base, governedInput: sourceInput, refreshed } = prepared.result as {
      base: ProductionSolverEvaluationBase;
      governedInput: GovernedEvaluationInput;
      refreshed: boolean;
    };
    if (base.planId !== input.planId || base.basePlanVersionId !== input.basePlanVersionId
      || base.input.planId !== input.planId || base.input.config.schemaVersion !== "3.0.0"
      || base.input.planVersionId !== input.basePlanVersionId) {
      throw new Error("solver evaluation base authority is inconsistent");
    }
    if (sourceInput.planId !== input.planId || sourceInput.planVersionId !== input.basePlanVersionId
      || !sameNonConfigHashes(input.expectedInputHashes, sourceInput.snapshotHashes)) {
      throw new Error("solver candidate expected input hashes are stale");
    }
    const inputHashes: SnapshotHashes = { ...structuredClone(sourceInput.snapshotHashes), configHash: buildConfigHash };
    const evaluationLock = await createPlanEvaluationLock({
      planId: input.planId,
      snapshotHashes: inputHashes,
      factSnapshotId: sourceInput.evaluationLock.factSnapshotId,
      userObservationSnapshotId: sourceInput.evaluationLock.userObservationSnapshotId,
      artifactLockfileHash: sourceInput.artifactLockfile.lockfileHash,
    });
    const governedInput: GovernedEvaluationInput = {
      ...structuredClone(sourceInput),
      config: structuredClone(input.candidateConfig),
      snapshotHashes: inputHashes,
      evaluationLock,
    };
    const evaluation = this.options.governedEvaluator
      ? (await this.options.governedEvaluator.evaluate(governedInput)).evaluation
      : await evaluateProgressiveCompatibility(governedInput);
    if (!isProgressiveBuildEvaluation(evaluation)) throw new Error("solver governed evaluator did not return a progressive evaluation");
    if (!this.options.governedEvaluator && (evaluation.firmwareCapabilities.length || evaluation.firmwareEvaluations.length
      || evaluation.assemblySafetyEvaluations.length)) {
      throw new Error("solver progressive replay needs nested evaluation inputs from its root authority");
    }
    const evaluationHash = await authoritativeEvaluationHash(evaluation, evaluationLock);
    const domainCoverage: DomainCoverage[] = await Promise.all(evaluation.domainEvaluations.map(async (domain) => {
      const verdict: DomainCoverage["verdict"] = domain.verdict === "pass" || domain.verdict === "fail"
        ? domain.verdict : "blocked";
      return {
        domain: domain.domain,
        verdict,
        domainHash: await legacySha256Hex({
          schemaVersion: "solver-progressive-domain-coverage-v1",
          evaluationHash,
          domain: domain.domain,
          verdict,
          domainEvaluation: domain,
        }),
        evaluationHash,
        requiredForPurchase: false,
      };
    }));
    domainCoverage.sort((left, right) => compareText(left.domain, right.domain));
    const coverageArtifact: SolverProgressiveEvaluationCoverageArtifact = {
      schemaVersion: "solver-progressive-evaluation-coverage-v1",
      evaluationHash,
      domainCoverage,
    };
    const coverageArtifactRef = await this.options.artifacts.put(
      "solver-progressive-evaluation-coverage",
      coverageArtifact,
    );
    const rootIds = new Set(evaluation.requirementClosure.rootRequirementIds);
    const replayInput: SolverProgressiveEvaluationReceiptArtifact["replayInput"] = {
      config: structuredClone(input.candidateConfig),
      evaluationLock: structuredClone(evaluationLock),
      artifactLockfile: structuredClone(sourceInput.artifactLockfile),
      ruleSetPayload: structuredClone(sourceInput.artifacts.ruleSet.payload),
      enginePayload: structuredClone(sourceInput.artifacts.engine.payload),
      adapterSnapshotPayload: structuredClone(sourceInput.artifacts.adapterSnapshot.payload),
      priceSnapshot: structuredClone(sourceInput.externalInputs.priceSnapshot),
      factClosure: structuredClone(sourceInput.factClosure),
      observationClosure: structuredClone(sourceInput.observationClosure),
      firmwareCapabilities: [],
      firmwarePathInputs: [],
      firmwareFixedPointRootRequirements: [],
      assemblySafetyInputs: [],
      requirementRoots: evaluation.requirements.filter(({ requirementId }) => rootIds.has(requirementId)),
    };
    const receiptArtifact: SolverProgressiveEvaluationReceiptArtifact = {
      schemaVersion: "solver-progressive-evaluation-receipt-v1",
      planId: input.planId,
      basePlanVersionId: input.basePlanVersionId,
      buildConfigHash,
      inputHashes,
      evaluationHash,
      evaluation,
      replayInput,
      coverageArtifactRef,
      evaluatedAt: (this.options.now ?? (() => new Date().toISOString()))(),
    };
    const closureErrors = validateSolverProgressiveEvaluationClosureRuntime(receiptArtifact, coverageArtifact);
    if (closureErrors.length) throw new Error(`solver progressive evaluation closure invalid: ${closureErrors.join("; ")}`);
    const evaluationReceiptRef = await this.options.artifacts.put(
      "solver-progressive-evaluation-receipt",
      receiptArtifact,
    );
    const finalBase = await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot }: {
      activeRoot: string;
    }) => {
      const pinned = await this.options.authority.resolveAtRoot(activeRoot, {
        planId: input.planId,
        basePlanVersionId: input.basePlanVersionId,
      });
      return { pinned };
    });
    const final = finalBase.result as { pinned: ProductionSolverEvaluationBase | null };
    if (!exactBaseIdentity(final.pinned, base)) {
      throw new Error("solver evaluation base changed before receipt publication");
    }
    const satisfactionById = new Map(evaluation.requirementAllocation.satisfactions
      .map((satisfaction) => [satisfaction.requirementId, satisfaction]));
    const residualRequirementIds = evaluation.requirements
      .filter((requirement) => satisfactionById.get(requirement.requirementId)?.status !== "satisfied")
      .map(({ requirementId }) => requirementId).sort(compareText);
    const unsatisfiedHardConstraintIds = evaluation.requirements
      .filter((requirement) => requirement.criticality !== "normal"
        && satisfactionById.get(requirement.requirementId)?.status !== "satisfied")
      .map(({ requirementId }) => requirementId).sort(compareText);
    return {
      schemaVersion: "authoritative-solver-evaluation-v1",
      planId: input.planId,
      basePlanVersionId: input.basePlanVersionId,
      buildConfigHash,
      inputHashes,
      evaluationHash,
      evaluationReceiptRef,
      coverageArtifactRef,
      domainCoverage,
      residualRequirementIds,
      unsatisfiedHardConstraintIds,
      excludedReasonIds: domainCoverage.filter(({ verdict }) => verdict === "blocked")
        .map(({ domain }) => `domain:${domain}:blocked`).sort(compareText),
    };
  }
}
