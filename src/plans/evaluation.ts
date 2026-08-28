import type { BuildConfig, BuildConfigDocument } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { BuildConfigV3 } from "../topology/contracts";
import { projectTopologyBom } from "../topology/projections";
import { hashPlanConfig, sha256Hex } from "./canonical";
import {
  PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION,
  PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS,
  PLAN_SCHEMA_VERSION,
  type PlanEvaluation,
  type PlanEvaluationSnapshot,
  type PlanPartialEvaluationV3,
} from "./contracts";

export interface EvaluationInput {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: BuildConfig;
}

export interface ResolvedEvaluationInput extends EvaluationInput {
  evaluation: BuildEvaluation;
}

export interface ResolvedPlanEvaluationInput {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: BuildConfigDocument;
  evaluation: PlanEvaluation;
  expectedConfigHash?: string;
  expectedEvaluationHash?: string;
}

interface CachedEvaluation {
  evaluation: PlanEvaluation;
  evaluationHash: string;
}

export function createPlanPartialEvaluationV3(config: BuildConfigV3): PlanPartialEvaluationV3 {
  return {
    schemaVersion: PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION,
    kind: "topology-v3-partial",
    configSchemaVersion: "3.0.0",
    topologyBom: projectTopologyBom(config),
    unknownDomains: [...PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS],
  };
}

export function isPlanPartialEvaluationV3(value: PlanEvaluation): value is PlanPartialEvaluationV3 {
  return "kind" in value && value.kind === "topology-v3-partial";
}

export class EvaluationCoordinator {
  private readonly cache = new Map<string, Promise<CachedEvaluation>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly evaluator: (config: BuildConfig) => BuildEvaluation | Promise<BuildEvaluation>,
    private readonly now = () => new Date().toISOString(),
  ) {}

  async evaluate(input: EvaluationInput): Promise<{ snapshot: PlanEvaluationSnapshot; latest: boolean }> {
    const generation = (this.generations.get(input.planId) ?? 0) + 1;
    this.generations.set(input.planId, generation);
    const configHash = await hashPlanConfig(input.config);
    let cached = this.cache.get(configHash);
    if (!cached) {
      cached = Promise.resolve(this.evaluator(structuredClone(input.config))).then(async (evaluation) => ({
        evaluation,
        evaluationHash: await sha256Hex(evaluation),
      }));
      this.cache.set(configHash, cached);
    }
    const result = await cached;
    const snapshot: PlanEvaluationSnapshot = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: input.planId,
      planVersionId: input.planVersionId,
      draftRevision: input.draftRevision,
      configHash,
      evaluationHash: result.evaluationHash,
      evaluatedAt: this.now(),
      evaluation: result.evaluation,
    };
    return { snapshot, latest: this.generations.get(input.planId) === generation };
  }

  async acceptResolved(input: ResolvedEvaluationInput): Promise<{ snapshot: PlanEvaluationSnapshot; latest: boolean }> {
    return this.acceptPlanResolved(input);
  }

  async acceptPlanResolved(input: ResolvedPlanEvaluationInput): Promise<{ snapshot: PlanEvaluationSnapshot; latest: boolean }> {
    const generation = (this.generations.get(input.planId) ?? 0) + 1;
    this.generations.set(input.planId, generation);
    if (input.config.schemaVersion === "3.0.0") {
      if (!isPlanPartialEvaluationV3(input.evaluation)) throw new Error("BuildConfig V3 requires a partial topology evaluation");
      if (await sha256Hex(input.evaluation) !== await sha256Hex(createPlanPartialEvaluationV3(input.config))) throw new Error("V3 partial evaluation does not match the active topology");
    } else if (isPlanPartialEvaluationV3(input.evaluation)) {
      throw new Error("BuildConfig V2 cannot use a V3 partial evaluation");
    }
    const [configHash, evaluationHash] = await Promise.all([hashPlanConfig(input.config), sha256Hex(input.evaluation)]);
    if (input.expectedConfigHash !== undefined && input.expectedConfigHash !== configHash) throw new Error("Authoritative evaluation config hash mismatch");
    if (input.expectedEvaluationHash !== undefined && input.expectedEvaluationHash !== evaluationHash) throw new Error("Authoritative evaluation payload hash mismatch");
    this.cache.set(configHash, Promise.resolve({ evaluation: input.evaluation, evaluationHash }));
    const snapshot: PlanEvaluationSnapshot = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: input.planId,
      planVersionId: input.planVersionId,
      draftRevision: input.draftRevision,
      configHash,
      evaluationHash,
      evaluatedAt: this.now(),
      evaluation: input.evaluation,
    };
    return { snapshot, latest: this.generations.get(input.planId) === generation };
  }

  clear(): void { this.cache.clear(); }
}

export interface EvaluationDiff {
  resolvedFindingIds: string[];
  introducedFindingIds: string[];
  budgetDeltaCny: number | null;
  beforeVerdict: "ok" | "warn" | "bad";
  afterVerdict: "ok" | "warn" | "bad";
}

function verdict(evaluation: BuildEvaluation): EvaluationDiff["beforeVerdict"] {
  return evaluation.findings.some((finding) => finding.verdict === "bad") ? "bad" : evaluation.findings.some((finding) => finding.verdict === "warn") ? "warn" : "ok";
}

export function diffEvaluations(before: BuildEvaluation, after: BuildEvaluation): EvaluationDiff {
  const beforeIds = new Set(before.findings.filter((finding) => finding.verdict !== "ok").map((finding) => finding.id));
  const afterIds = new Set(after.findings.filter((finding) => finding.verdict !== "ok").map((finding) => finding.id));
  // Older cached payloads may not carry `complete`, so also inspect both kinds
  // of unresolved line. A partial known sum is never a budget delta.
  const priceIsComplete = (price: BuildEvaluation["price"]): boolean =>
    price.complete !== false &&
    (price.unknownSkuIds?.length ?? 0) === 0 &&
    (price.unresolvedRequirements?.length ?? 0) === 0;
  const pricesComplete = priceIsComplete(before.price) && priceIsComplete(after.price);
  return {
    resolvedFindingIds: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
    introducedFindingIds: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
    budgetDeltaCny: pricesComplete && Number.isFinite(before.price.knownCny) && Number.isFinite(after.price.knownCny) ? after.price.knownCny - before.price.knownCny : null,
    beforeVerdict: verdict(before),
    afterVerdict: verdict(after),
  };
}
