import type { BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import { sha256Hex } from "./canonical";
import { PLAN_SCHEMA_VERSION, type PlanEvaluationSnapshot } from "./contracts";

export interface EvaluationInput {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: BuildConfig;
}

export interface ResolvedEvaluationInput extends EvaluationInput {
  evaluation: BuildEvaluation;
}

interface CachedEvaluation {
  evaluation: BuildEvaluation;
  evaluationHash: string;
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
    const configHash = await sha256Hex(input.config);
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
    const generation = (this.generations.get(input.planId) ?? 0) + 1;
    this.generations.set(input.planId, generation);
    const [configHash, evaluationHash] = await Promise.all([sha256Hex(input.config), sha256Hex(input.evaluation)]);
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
  return {
    resolvedFindingIds: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
    introducedFindingIds: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
    budgetDeltaCny: Number.isFinite(before.price.knownCny) && Number.isFinite(after.price.knownCny) ? after.price.knownCny - before.price.knownCny : null,
    beforeVerdict: verdict(before),
    afterVerdict: verdict(after),
  };
}

