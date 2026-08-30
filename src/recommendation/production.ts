import path from "node:path";
import { canonicalize, isSnapshotHashes, legacySha256Hex, type SnapshotHashes } from "../hash";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { authoritativeEvaluationHash } from "../plans/evaluation";
import type { BuildConfigV3 } from "../topology/contracts";
import { isProgressiveBuildEvaluation, type ProgressiveBuildEvaluation } from "../compatibility/contracts";
import type { PriceRepository } from "../price/repository";
import { projectCurrentChinaPrice, type CurrentPriceProjection } from "../price/policy";
import { assessMarketCycle, type MarketCycleAssessment } from "./market-cycle";
import { explainRecommendation, type RecommendationExplanation } from "./explain";
import { createCandidatePromotionRecord } from "./policy";
import { rankWholeBuilds, type ExcludedWholeBuild, type RankableWholeBuild } from "./ranking";
import { scorePurchaseEligibleCandidate } from "./score";
import {
  DEFAULT_RECOMMENDATION_WEIGHTS,
  validateRecommendationWeights,
  type GovernedRecommendationContext,
  type RecommendationPenalty,
  type RecommendationScore,
  type RecommendationWeights,
  type WholeBuildRecommendation,
} from "./contracts";
import {
  PURCHASE_ELIGIBILITY_POLICY,
  type DomainCoverage,
  type GovernedPurchaseEligibilityContext,
  type SolverCandidate,
} from "../solver/contracts";
import type { GovernedEvaluationInput, GovernedEvaluationResult } from "../server/evaluation-service";
import type { GovernedSolverCandidateEvaluator, RootBoundSolverCandidateInputAuthority } from "../server/solver-production";
import type { SolverRecommendationSource, WholeBuildSolverService } from "../server/solver-service";

const MEDIA_TYPE = "application/vnd.buildsim.recommendation+json";
const REF = /^sha256:[a-f0-9]{64}$/;
const SCORING_VERSION = "recommendation-score-v1";

interface PreparedCandidate {
  readonly candidateArtifactRef: string;
  readonly candidate: SolverCandidate;
  readonly config: BuildConfigV3;
  readonly input: GovernedEvaluationInput;
}

interface EvaluatedCandidate extends PreparedCandidate {
  readonly evaluation: ProgressiveBuildEvaluation;
  readonly evaluationHash: string;
}

export interface RecommendationCandidateArtifactIndex {
  candidateId: string;
  candidateArtifactRef: string;
  eligibilityContextRef: string;
  promotionRef: string;
  scoreRef: string | null;
  explanationRef: string | null;
  contextRef: string | null;
}

export interface ProductionRecommendationSetArtifact {
  schemaVersion: "production-recommendation-set-v1";
  planId: string;
  solverJobId: string;
  solverRequestRef: string;
  solverResultRef: string;
  runtimeGeneration: number;
  generatedAt: string;
  weights: RecommendationWeights;
  status: "ranked" | "insufficient_eligible_candidates";
  recommendations: WholeBuildRecommendation[];
  excluded: ExcludedWholeBuild[];
  candidates: RecommendationCandidateArtifactIndex[];
  searchCompleteness: "complete" | "partial";
}

export interface ProductionRecommendationView {
  schemaVersion: "production-recommendation-view-v1";
  setRef: string;
  current: boolean;
  staleCandidateIds: string[];
  set: ProductionRecommendationSetArtifact;
  contexts: GovernedRecommendationContext[];
  explanations: RecommendationExplanation[];
}

export interface GenerateProductionRecommendationsInput {
  planId: string;
  solverJobId: string;
  weights?: RecommendationWeights;
}

function clone<T>(value: T): T { return structuredClone(value); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function same(left: unknown, right: unknown): boolean { return canonicalize(left) === canonicalize(right); }

function purchaseRequirements(evaluation: ProgressiveBuildEvaluation) {
  const satisfaction = new Map(evaluation.requirementAllocation.satisfactions
    .map((item) => [item.requirementId, item] as const));
  return evaluation.requirements.filter((requirement) => satisfaction.get(requirement.requirementId)?.status !== "satisfied");
}

async function coverageFor(evaluation: ProgressiveBuildEvaluation, evaluationHash: string): Promise<DomainCoverage[]> {
  const byDomain = new Map(evaluation.domainEvaluations.map((item) => [item.domain, item] as const));
  return Promise.all(PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map(async (domain) => {
    const item = byDomain.get(domain);
    const verdict: DomainCoverage["verdict"] = item?.verdict === "pass" || item?.verdict === "fail"
      ? item.verdict : "blocked";
    return {
      domain,
      verdict,
      domainHash: await legacySha256Hex({
        schemaVersion: "purchase-domain-coverage-v1",
        evaluationHash,
        domain,
        verdict,
        domainEvaluation: item ?? null,
      }),
      evaluationHash,
      requiredForPurchase: true,
    };
  }));
}

function workloadBenchmarkRefs(config: BuildConfigV3): string[] {
  const spec = config.requirementSpec;
  if (!spec) return [];
  return [...new Set(spec.workloads.flatMap((workload) => {
    if (workload.state === "deferred" || workload.state === "not_applicable") return [];
    if (workload.state === "answered" && workload.confirmedByUser !== true) return [];
    return [
      ...("evidenceOrBenchmarkRefs" in workload ? workload.evidenceOrBenchmarkRefs ?? [] : []),
      ...workload.metrics.flatMap((metric) => {
        if (metric.state === "deferred" || metric.state === "not_applicable") return [];
        if (metric.state === "answered" && metric.confirmedByUser !== true) return [];
        return "benchmarkId" in metric && metric.benchmarkId ? [`benchmark:${metric.benchmarkId}`] : [];
      }),
    ];
  }))].sort(compareText);
}

function boundedRatio(numerator: number, denominator: number, empty = 0): number {
  return denominator <= 0 ? empty : Math.max(0, Math.min(1, numerator / denominator));
}

function domainScore(coverage: readonly DomainCoverage[], domains: readonly DomainCoverage["domain"][]): number {
  const selected = coverage.filter(({ domain }) => domains.includes(domain));
  return boundedRatio(selected.filter(({ verdict }) => verdict === "pass").length, domains.length);
}

function objectiveScores(input: {
  evaluation: ProgressiveBuildEvaluation;
  coverage: readonly DomainCoverage[];
  config: BuildConfigV3;
  totalCny: number | undefined;
}): RecommendationScore["objectiveScores"] {
  const satisfactions = input.evaluation.requirementAllocation.satisfactions;
  const workloadValue = boundedRatio(satisfactions.filter(({ status }) => status === "satisfied").length, satisfactions.length, 1);
  const skeletonKinds = new Set(["case", "motherboard", "power-supply"]);
  const skeleton = input.config.components.filter(({ kind }) => skeletonKinds.has(kind));
  const stableSkeleton = skeleton.filter(({ identity }) => identity.status === "resolved").length;
  const budget = input.config.requirementSpec?.budget;
  const governedBudget = budget?.state === "answered" && budget.confirmedByUser === true ? budget.value : null;
  const budgetLimit = governedBudget?.targetCny ?? governedBudget?.hardCapCny;
  const marketAndLifecycleCost = input.totalCny === undefined ? 0
    : budgetLimit && budgetLimit > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, input.totalCny - budgetLimit) / budgetLimit)) : 0.5;
  return {
    workloadValue,
    evidencedReliability: domainScore(input.coverage, PURCHASE_ELIGIBILITY_POLICY.requiredDomains),
    maintainability: domainScore(input.coverage, ["assembly", "commissioning"]),
    usableExpandability: domainScore(input.coverage, ["mechanical", "storage", "routing"]),
    replacementFriction: boundedRatio(stableSkeleton, skeleton.length, 1),
    marketAndLifecycleCost,
  };
}

function priceConfidence(values: readonly CurrentPriceProjection[]): RecommendationScore["priceConfidence"] {
  if (values.length === 0 || values.some(({ confidence }) => confidence === "unavailable")) return "unavailable";
  if (values.some(({ confidence }) => confidence === "low")) return "low";
  if (values.some(({ confidence }) => confidence === "medium")) return "medium";
  return "high";
}

function combineMarketCycles(values: readonly MarketCycleAssessment[]): MarketCycleAssessment {
  const abnormal = values.filter(({ status }) => status === "abnormal");
  const local = values.filter(({ basis }) => basis === "local_history");
  const evidenceRefs = [...new Set(values.flatMap(({ evidenceRefs }) => evidenceRefs))].sort(compareText);
  const sampleCount = values.reduce((sum, value) => sum + value.coverage.sampleCount, 0);
  const coverageDays = values.reduce((maximum, value) => Math.max(maximum, value.coverage.coverageDays), 0);
  if (abnormal.length) return {
    schemaVersion: "market-cycle-assessment-v1", basis: "local_history", confidence: "high", status: "abnormal",
    evidenceRefs, coverage: { sampleCount, coverageDays },
    explanation: `${abnormal.length} exact-variant component price series are outside their governed historical band.`,
  };
  if (local.length) return {
    schemaVersion: "market-cycle-assessment-v1", basis: "local_history", confidence: local.length === values.length ? "high" : "medium",
    status: "normal", evidenceRefs, coverage: { sampleCount, coverageDays },
    explanation: `${local.length} exact-variant component price series have sufficient local history; sparse components remain explicit.`,
  };
  return {
    schemaVersion: "market-cycle-assessment-v1", basis: "insufficient", confidence: "unavailable", status: "unknown",
    evidenceRefs, coverage: { sampleCount, coverageDays },
    explanation: "insufficient exact-variant local history for a whole-build market-cycle statement",
  };
}

function parsedJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error("recommendation artifact is not JSON"); }
}

function assertSet(value: unknown): asserts value is ProductionRecommendationSetArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recommendation set is invalid");
  const item = value as Partial<ProductionRecommendationSetArtifact>;
  if (item.schemaVersion !== "production-recommendation-set-v1" || !item.planId || !item.solverJobId
    || !REF.test(String(item.solverRequestRef)) || !REF.test(String(item.solverResultRef))
    || !Number.isSafeInteger(item.runtimeGeneration) || !Number.isFinite(Date.parse(String(item.generatedAt)))
    || !Array.isArray(item.recommendations) || !Array.isArray(item.excluded) || !Array.isArray(item.candidates)
    || validateRecommendationWeights(item.weights).length) throw new Error("recommendation set contract is invalid");
}

export class ProductionRecommendationService {
  private readonly now: () => string;

  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    solver: Pick<WholeBuildSolverService, "recommendationSourceAtRoot">;
    candidateInputs: RootBoundSolverCandidateInputAuthority;
    evaluator: GovernedSolverCandidateEvaluator;
    prices: Pick<PriceRepository, "listObservationsAtRoot" | "listHistoryPointsAtRoot">;
    now?: () => string;
  }) {
    if (options.candidateInputs.authorityKind !== "root-bound-solver-candidate-input-authority-v1"
      || options.evaluator.authorityKind !== "governed-solver-candidate-evaluator-v1") {
      throw new TypeError("production recommendation requires governed candidate/evaluator authorities");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private artifactsAtRoot(activeRoot: string) {
    return new FileArtifactRepository({ root: path.join(activeRoot, "artifacts"), now: this.now });
  }

  private async putArtifact(activeRoot: string, kind: string, value: unknown, references: readonly string[]): Promise<string> {
    const repo = this.artifactsAtRoot(activeRoot);
    const stored = await repo.put({
      bytes: Buffer.from(canonicalize(value), "utf8"), mediaType: MEDIA_TYPE,
      privacyClass: "runtime_internal", kind,
      references: [...new Set(references.filter((ref) => REF.test(ref)))].sort(compareText)
        .map((ref) => ({ ref, necessity: "required_for_replay" as const })),
      createdAt: this.now(),
    });
    return stored.record.ref;
  }

  private async prepare(planId: string, solverJobId: string): Promise<{
    source: SolverRecommendationSource;
    prepared: PreparedCandidate[];
  }> {
    return (await this.options.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number };
    }) => {
      const source = await this.options.solver.recommendationSourceAtRoot(activeRoot, solverJobId, planId);
      if (source.runtimeGeneration !== state.runtimeGeneration) throw new Error("recommendation solver result belongs to a prior runtime generation");
      const prepared: PreparedCandidate[] = [];
      for (const item of source.candidates) {
        const input = await this.options.candidateInputs.resolveAtRoot(activeRoot, state.runtimeGeneration, {
          planId,
          basePlanVersionId: item.candidate.basePlanVersionId,
          config: clone(item.config),
        });
        if (input.snapshotHashes.configHash !== item.candidate.buildConfigHash) throw new Error("recommendation candidate config hash is stale");
        prepared.push({ ...clone(item), input: clone(input) });
      }
      return { source, prepared };
    })).result;
  }

  private async evaluate(prepared: readonly PreparedCandidate[]): Promise<EvaluatedCandidate[]> {
    return Promise.all(prepared.map(async (item) => {
      const result: GovernedEvaluationResult = await this.options.evaluator.evaluate(clone(item.input));
      if (!isProgressiveBuildEvaluation(result.evaluation)) throw new Error("recommendation evaluator did not return progressive coverage");
      return {
        ...clone(item),
        evaluation: clone(result.evaluation),
        evaluationHash: await authoritativeEvaluationHash(result.evaluation, item.input.evaluationLock),
      };
    }));
  }

  async generate(raw: GenerateProductionRecommendationsInput): Promise<ProductionRecommendationView> {
    if (!raw || !raw.planId || !/^job-[a-f0-9]{64}$/.test(raw.solverJobId)) throw new TypeError("recommendation request identity is invalid");
    const weights = clone(raw.weights ?? DEFAULT_RECOMMENDATION_WEIGHTS);
    const weightErrors = validateRecommendationWeights(weights);
    if (weightErrors.length) throw new TypeError(`recommendation weights invalid: ${weightErrors.join("; ")}`);
    await this.options.coordinator.initialize();
    const first = await this.prepare(raw.planId, raw.solverJobId);
    const evaluated = await this.evaluate(first.prepared);
    const generatedAt = this.now();
    const setRef = (await this.options.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number };
    }) => {
      const current = await this.options.solver.recommendationSourceAtRoot(activeRoot, raw.solverJobId, raw.planId);
      if (current.runtimeGeneration !== state.runtimeGeneration || current.resultRef !== first.source.resultRef
        || current.requestRef !== first.source.requestRef || !same(current.candidates, first.source.candidates)) {
        throw new Error("recommendation solver source changed before commit");
      }
      for (const item of evaluated) {
        const refreshed = await this.options.candidateInputs.resolveAtRoot(activeRoot, state.runtimeGeneration, {
          planId: raw.planId, basePlanVersionId: item.candidate.basePlanVersionId, config: clone(item.config),
        });
        if (!same(refreshed.snapshotHashes, item.input.snapshotHashes)
          || refreshed.evaluationLock.contentHash !== item.input.evaluationLock.contentHash) {
          throw new Error("recommendation inputs changed before commit");
        }
      }
      const [observations, history] = await Promise.all([
        this.options.prices.listObservationsAtRoot(activeRoot),
        this.options.prices.listHistoryPointsAtRoot(activeRoot),
      ]);
      const rankable: RankableWholeBuild[] = [];
      const excluded: ExcludedWholeBuild[] = [];
      const candidateArtifacts: RecommendationCandidateArtifactIndex[] = [];
      for (const item of evaluated) {
        const coverage = await coverageFor(item.evaluation, item.evaluationHash);
        const residual = purchaseRequirements(item.evaluation);
        const coverageValue = {
          schemaVersion: "purchase-eligibility-coverage-v1", candidateId: item.candidate.candidateId,
          candidateArtifactRef: item.candidateArtifactRef,
          engineArtifactRef: item.input.artifacts.engine.ref.ref,
          requirementSpecRef: item.input.externalInputs.requirementSpec.ref.ref,
          evaluationHash: item.evaluationHash, inputHashes: clone(item.input.snapshotHashes), coverage,
        };
        const coverageRef = await this.putArtifact(activeRoot, "recommendation-eligibility-coverage", coverageValue, [
          item.candidateArtifactRef, item.input.artifacts.engine.ref.ref, item.input.externalInputs.requirementSpec.ref.ref,
        ]);
        const closureValue = {
          schemaVersion: "purchase-hard-requirement-closure-v1", candidateId: item.candidate.candidateId,
          coverageRef,
          requirementSpecRef: item.input.externalInputs.requirementSpec.ref.ref,
          requirementSpecHash: item.input.snapshotHashes.requirementSpecHash, evaluationHash: item.evaluationHash,
          residualMustRequirementIds: residual.map(({ requirementId }) => requirementId).sort(compareText),
          unsatisfiedHardConstraintIds: residual.filter(({ criticality }) => criticality !== "normal")
            .map(({ requirementId }) => requirementId).sort(compareText),
          requirementClosure: clone(item.evaluation.requirementClosure),
          requirementAllocationHash: item.evaluation.requirementAllocation.contentHash,
        };
        const closureRef = await this.putArtifact(activeRoot, "recommendation-hard-requirement-closure", closureValue, [
          coverageRef, item.input.externalInputs.requirementSpec.ref.ref,
        ]);
        const eligibility: GovernedPurchaseEligibilityContext = {
          policy: PURCHASE_ELIGIBILITY_POLICY,
          currentInputHashes: clone(item.input.snapshotHashes), coverage,
          coverageHash: coverageRef.slice("sha256:".length), coverageArtifactRef: coverageRef,
          authoritativeEvaluation: {
            evaluationHash: item.evaluationHash,
            evaluatorId: item.input.artifacts.engine.ref.artifactId,
            evaluatorVersion: item.input.artifacts.engine.ref.schemaVersion,
            evaluatorContractVersion: PURCHASE_ELIGIBILITY_POLICY.evaluatorContractVersion,
            evaluatorArtifactRef: item.input.artifacts.engine.ref.ref,
            evaluatorArtifactHash: item.input.artifacts.engine.ref.contentHash,
          },
          hardRequirementClosure: {
            requirementSpecHash: item.input.snapshotHashes.requirementSpecHash,
            evaluationHash: item.evaluationHash,
            closureArtifactRef: closureRef, closureArtifactHash: closureRef.slice("sha256:".length),
            residualMustRequirementIds: [...closureValue.residualMustRequirementIds],
            unsatisfiedHardConstraintIds: [...closureValue.unsatisfiedHardConstraintIds],
          },
        };
        const eligibilityArtifact = {
          schemaVersion: "recommendation-eligibility-context-v1", candidateArtifactRef: item.candidateArtifactRef,
          coverageRef, closureRef, context: eligibility,
        };
        const eligibilityRef = await this.putArtifact(activeRoot, "recommendation-eligibility-context", eligibilityArtifact, [item.candidateArtifactRef, coverageRef, closureRef]);
        const promotion = await createCandidatePromotionRecord({ candidate: item.candidate, context: eligibility, createdAt: generatedAt });
        const promotionRef = await this.putArtifact(activeRoot, "recommendation-candidate-promotion", {
          schemaVersion: "recommendation-candidate-promotion-v1", candidateArtifactRef: item.candidateArtifactRef,
          eligibilityContextRef: eligibilityRef, promotion,
        }, [eligibilityRef, item.candidateArtifactRef]);
        if (promotion.outcome !== "purchase_eligible") {
          excluded.push({
            candidateId: item.candidate.candidateId,
            reasonIds: [
              ...coverage.filter(({ verdict }) => verdict !== "pass").map(({ domain, verdict }) => `domain:${domain}:${verdict}`),
              ...closureValue.residualMustRequirementIds.map((id) => `requirement:${id}:open`),
            ].sort(compareText),
          });
          candidateArtifacts.push({ candidateId: item.candidate.candidateId, candidateArtifactRef: item.candidateArtifactRef, eligibilityContextRef: eligibilityRef, promotionRef, scoreRef: null, explanationRef: null, contextRef: null });
          continue;
        }
        const benchmarkRefs = workloadBenchmarkRefs(item.config);
        if (!benchmarkRefs.length) {
          excluded.push({ candidateId: item.candidate.candidateId, reasonIds: ["workload:benchmark-evidence-missing"] });
          candidateArtifacts.push({ candidateId: item.candidate.candidateId, candidateArtifactRef: item.candidateArtifactRef, eligibilityContextRef: eligibilityRef, promotionRef, scoreRef: null, explanationRef: null, contextRef: null });
          continue;
        }
        const purchaseComponents = item.config.components.filter(({ state }) => state === "planned" || state === "ordered");
        const projections = purchaseComponents.map((component) => component.identity.status === "resolved"
          ? projectCurrentChinaPrice({ skuId: component.identity.skuId, variantIdentityFactIds: component.identity.identityClaimIds, observations, now: generatedAt })
          : null);
        const completePrice = projections.every((projection) => projection !== null && projection.minCny !== null && projection.maxCny !== null);
        const componentPrice = new Map(purchaseComponents.map((component, index) => {
          const projection = projections[index];
          return [component.instanceId, projection && projection.minCny !== null && projection.maxCny !== null
            ? (projection.minCny + projection.maxCny) / 2 : null] as const;
        }));
        const plannedCny = completePrice ? purchaseComponents.filter(({ state }) => state === "planned")
          .reduce((sum, component) => sum + componentPrice.get(component.instanceId)!, 0) : undefined;
        const orderedCny = completePrice ? purchaseComponents.filter(({ state }) => state === "ordered")
          .reduce((sum, component) => sum + componentPrice.get(component.instanceId)!, 0) : undefined;
        const totalCny = plannedCny === undefined || orderedCny === undefined ? undefined : plannedCny + orderedCny;
        const exactCycles = purchaseComponents.map((component, index) => {
          const projection = projections[index];
          if (!projection || component.identity.status !== "resolved") return assessMarketCycle({ history: [], currentPriceCny: null });
          const identity = component.identity;
          const exactHistory = history.filter((point) => point.skuId === identity.skuId
            && same([...point.variantIdentityFactIds].sort(), [...identity.identityClaimIds].sort()));
          const currentPrice = projection.minCny === null || projection.maxCny === null ? null : (projection.minCny + projection.maxCny) / 2;
          return assessMarketCycle({ history: exactHistory, currentPriceCny: currentPrice });
        });
        const marketCycle = combineMarketCycles(exactCycles);
        const penalties: RecommendationPenalty[] = marketCycle.status === "abnormal" ? [{
          kind: "abnormal_price_cycle", amount: 0.05,
          explanation: marketCycle.explanation,
          evidenceRefs: marketCycle.evidenceRefs.length ? [...marketCycle.evidenceRefs] : [coverageRef],
        }] : [];
        const confidence = priceConfidence(projections.filter((value): value is CurrentPriceProjection => value !== null));
        const score = scorePurchaseEligibleCandidate({
          candidate: item.candidate, promotion, eligibility, scoringVersion: SCORING_VERSION,
          objectiveScores: objectiveScores({ evaluation: item.evaluation, coverage, config: item.config, totalCny }),
          workloadBenchmarkRefs: benchmarkRefs, priceConfidence: confidence, penalties, weights,
        });
        const scoreRef = await this.putArtifact(activeRoot, "recommendation-score", {
          schemaVersion: "recommendation-score-artifact-v1", promotionRef, coverageRef, score,
        }, [promotionRef, coverageRef]);
        const explanation = explainRecommendation({
          score, marketCycle,
          factGaps: [
            ...item.evaluation.requirements.filter((requirement) => residual.some(({ requirementId }) => requirementId === requirement.requirementId))
              .map(({ requirementId }) => `requirement:${requirementId}`),
            ...purchaseComponents.filter((component, index) => projections[index]?.status === "unavailable")
              .map(({ instanceId }) => `price:${instanceId}:unavailable`),
          ],
          upgradeImpacts: ["locked and ordered instances remain unchanged", "future substitutions must replay all purchase domains"],
        });
        const explanationRef = await this.putArtifact(activeRoot, "recommendation-explanation", {
          schemaVersion: "recommendation-explanation-artifact-v1", scoreRef, explanation,
        }, [scoreRef]);
        const context: GovernedRecommendationContext = {
          candidate: clone(item.candidate), promotion: clone(promotion), eligibilityContext: clone(eligibility), score: clone(score),
          candidateConfigRef: item.candidate.candidateConfigRef, requirementCoverageRef: coverageRef,
          inputHashes: clone(item.input.snapshotHashes),
        };
        const contextRef = await this.putArtifact(activeRoot, "recommendation-context", {
          schemaVersion: "recommendation-context-artifact-v1", candidateArtifactRef: item.candidateArtifactRef,
          eligibilityContextRef: eligibilityRef, promotionRef, scoreRef, explanationRef, context,
        }, [item.candidateArtifactRef, eligibilityRef, promotionRef, scoreRef, explanationRef]);
        candidateArtifacts.push({ candidateId: item.candidate.candidateId, candidateArtifactRef: item.candidateArtifactRef, eligibilityContextRef: eligibilityRef, promotionRef, scoreRef, explanationRef, contextRef });
        rankable.push({
          candidate: clone(item.candidate), promotion, eligibility, score,
          baseConfig: clone(current.baseConfig), candidateConfig: clone(item.config),
          lockedInstanceIds: [...current.request.request.lockedInstanceIds], candidateConfigRef: item.candidate.candidateConfigRef,
          requirementCoverageRef: coverageRef, solverVersion: current.result.result.solverVersion,
          searchCompleteness: current.result.result.status === "feasible_complete" ? "complete" : "partial",
          explanationRef,
          ...(totalCny === undefined ? {} : { totalCny, plannedCny: plannedCny!, orderedCny: orderedCny! }),
        });
      }
      let recommendations: WholeBuildRecommendation[] = [];
      if (rankable.length >= 2) {
        const ranked = await rankWholeBuilds(rankable);
        recommendations = [...ranked.recommendations];
        excluded.push(...ranked.excluded);
      }
      const set: ProductionRecommendationSetArtifact = {
        schemaVersion: "production-recommendation-set-v1", planId: raw.planId, solverJobId: raw.solverJobId,
        solverRequestRef: current.requestRef, solverResultRef: current.resultRef,
        runtimeGeneration: state.runtimeGeneration, generatedAt, weights,
        status: recommendations.length ? "ranked" : "insufficient_eligible_candidates",
        recommendations, excluded: [...new Map(excluded.map((item) => [item.candidateId, item])).values()].sort((a, b) => compareText(a.candidateId, b.candidateId)),
        candidates: candidateArtifacts.sort((a, b) => compareText(a.candidateId, b.candidateId)),
        searchCompleteness: current.result.result.status === "feasible_complete" ? "complete" : "partial",
      };
      return this.putArtifact(activeRoot, "recommendation-set", set, [
        current.requestRef, current.resultRef,
        ...candidateArtifacts.flatMap((item) => [item.candidateArtifactRef, item.eligibilityContextRef, item.promotionRef, item.scoreRef, item.explanationRef, item.contextRef]
          .filter((ref): ref is string => ref !== null)),
      ]);
    })).result;
    return this.view(raw.planId, raw.solverJobId, setRef);
  }

  async view(planId: string, solverJobId: string, exactSetRef?: string): Promise<ProductionRecommendationView> {
    if (!planId || !/^job-[a-f0-9]{64}$/.test(solverJobId) || (exactSetRef !== undefined && !REF.test(exactSetRef))) {
      throw new TypeError("recommendation view identity is invalid");
    }
    return (await this.options.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string; state: { runtimeGeneration: number };
    }) => {
      const repo = this.artifactsAtRoot(activeRoot);
      let ref = exactSetRef;
      if (!ref) {
        const listed = await repo.listAt(path.join(activeRoot, "artifacts"), { initialize: false });
        const matches: Array<{ ref: string; value: ProductionRecommendationSetArtifact }> = [];
        for (const record of listed.records.filter(({ kind }: { kind: string }) => kind === "recommendation-set")) {
          const artifact = await repo.getAt(path.join(activeRoot, "artifacts"), record.ref);
          if (!artifact) continue;
          const value = parsedJson(artifact.bytes);
          assertSet(value);
          if (value.planId === planId && value.solverJobId === solverJobId) matches.push({ ref: record.ref, value });
        }
        matches.sort((left, right) => right.value.generatedAt.localeCompare(left.value.generatedAt) || compareText(right.ref, left.ref));
        ref = matches[0]?.ref;
      }
      if (!ref) throw new Error("recommendation set was not found");
      const artifact = await repo.getAt(path.join(activeRoot, "artifacts"), ref);
      if (!artifact || artifact.record.kind !== "recommendation-set" || artifact.record.mediaType !== MEDIA_TYPE) throw new Error("recommendation set artifact is missing");
      const set = parsedJson(artifact.bytes);
      assertSet(set);
      if (set.planId !== planId || set.solverJobId !== solverJobId) throw new Error("recommendation set plan/job binding is invalid");
      const source = await this.options.solver.recommendationSourceAtRoot(activeRoot, solverJobId, planId);
      const staleCandidateIds: string[] = [];
      const contexts: GovernedRecommendationContext[] = [];
      const explanations: RecommendationExplanation[] = [];
      for (const index of set.candidates) {
        const sourceCandidate = source.candidates.find(({ candidate }) => candidate.candidateId === index.candidateId);
        if (!sourceCandidate) { staleCandidateIds.push(index.candidateId); continue; }
        const input = await this.options.candidateInputs.resolveAtRoot(activeRoot, state.runtimeGeneration, {
          planId, basePlanVersionId: sourceCandidate.candidate.basePlanVersionId, config: clone(sourceCandidate.config),
        });
        const contextArtifact = index.contextRef
          ? await repo.getAt(path.join(activeRoot, "artifacts"), index.contextRef).catch(() => null)
          : null;
        if (contextArtifact?.record.kind === "recommendation-context") {
          const context = (parsedJson(contextArtifact.bytes) as { context: GovernedRecommendationContext }).context;
          if (!isSnapshotHashes(context.inputHashes) || !same(context.inputHashes, input.snapshotHashes)) staleCandidateIds.push(index.candidateId);
          else contexts.push(clone(context));
        } else if (index.scoreRef) staleCandidateIds.push(index.candidateId);
        if (index.explanationRef) {
          const explanationArtifact = await repo.getAt(path.join(activeRoot, "artifacts"), index.explanationRef);
          if (explanationArtifact?.record.kind === "recommendation-explanation") {
            explanations.push((parsedJson(explanationArtifact.bytes) as { explanation: RecommendationExplanation }).explanation);
          }
        }
      }
      return {
        schemaVersion: "production-recommendation-view-v1",
        setRef: ref,
        current: source.runtimeGeneration === state.runtimeGeneration && source.resultRef === set.solverResultRef && staleCandidateIds.length === 0,
        staleCandidateIds: [...new Set(staleCandidateIds)].sort(compareText),
        set: clone(set), contexts, explanations,
      };
    })).result;
  }
}
