import type { BuildConfig, BuildConfigDocument } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import { isProgressiveBuildEvaluation } from "../compatibility/contracts";
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
  type PlanEvaluationLock,
} from "./contracts";
import { verifyPlanEvaluationLock } from "./evaluation-lock";

export interface EvaluationInput {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  config: BuildConfig;
  evaluationLock?: PlanEvaluationLock;
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
  evaluationLock?: PlanEvaluationLock;
}

interface CachedEvaluation {
  evaluation: PlanEvaluation;
  evaluationHash: string;
}

export interface LockedEvaluationExecutionInput extends EvaluationInput {
  evaluationLock: PlanEvaluationLock;
}

export interface EvaluationCoordinatorOptions {
  /** Flag-on paths never fall back to the config-only legacy evaluator. */
  factGraphEnabled?: boolean;
  /** Repository-backed closure verification; a self-consistent lock is insufficient. */
  verifyEvaluationLock?: (lock: PlanEvaluationLock) => boolean | Promise<boolean>;
  /** Governed evaluator receives the exact lock whose payloads it must resolve and consume. */
  evaluateLocked?: (input: LockedEvaluationExecutionInput) => PlanEvaluation | Promise<PlanEvaluation>;
  /** Optional authority for installing externally evaluated payloads in strict mode. */
  verifyResolvedEvaluation?: (input: ResolvedPlanEvaluationInput, configHash: string, evaluationHash: string) => boolean | Promise<boolean>;
}

export interface EvaluationFreshness {
  status: "current" | "stale" | "legacy_unlocked";
  reason:
    | "lock_matches"
    | "snapshot_has_no_evaluation_lock"
    | "snapshot_inputs_changed"
    | "snapshot_lock_invalid"
    | "snapshot_evaluation_invalid"
    | "current_lock_invalid";
}

/**
 * Fact-graph evaluation identity. The payload may conservatively remain
 * unknown while facts/models change, so the immutable full-input lock is part
 * of the identity rather than pretending unchanged JSON means unchanged work.
 */
export async function authoritativeEvaluationHash(
  evaluation: PlanEvaluation,
  evaluationLock: PlanEvaluationLock,
): Promise<string> {
  return authoritativeEvaluationHashFromLockHash(evaluation, evaluationLock.contentHash);
}

export async function authoritativeEvaluationHashFromLockHash(
  evaluation: PlanEvaluation,
  evaluationLockHash: string,
): Promise<string> {
  return sha256Hex({
    domain: "authoritative-evaluation-identity",
    schemaVersion: "authoritative-evaluation-identity-v1",
    evaluationLockHash,
    evaluation,
  });
}

/** A saved evaluation never silently follows mutable facts or model artifacts. */
export async function assessEvaluationFreshness(
  snapshot: PlanEvaluationSnapshot,
  currentLock: PlanEvaluationLock | null,
  verifyCurrentLock?: (lock: PlanEvaluationLock) => boolean | Promise<boolean>,
): Promise<EvaluationFreshness> {
  if (!snapshot.evaluationLock) return { status: "legacy_unlocked", reason: "snapshot_has_no_evaluation_lock" };
  if (!await verifyPlanEvaluationLock(snapshot.evaluationLock)
    || snapshot.evaluationLock.planId !== snapshot.planId
    || snapshot.evaluationLock.snapshotHashes.configHash !== snapshot.configHash) {
    return { status: "stale", reason: "snapshot_lock_invalid" };
  }
  if (snapshot.evaluationHash !== await authoritativeEvaluationHash(snapshot.evaluation, snapshot.evaluationLock)) {
    return { status: "stale", reason: "snapshot_evaluation_invalid" };
  }
  if (!currentLock || !await verifyPlanEvaluationLock(currentLock)
    || currentLock.planId !== snapshot.planId
    || (verifyCurrentLock && !await verifyCurrentLock(currentLock))) {
    return { status: "stale", reason: "current_lock_invalid" };
  }
  return snapshot.evaluationLock.contentHash === currentLock.contentHash
    ? { status: "current", reason: "lock_matches" }
    : { status: "stale", reason: "snapshot_inputs_changed" };
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

export function isTopologyEvaluationV3(
  value: PlanEvaluation,
): value is Exclude<PlanEvaluation, BuildEvaluation> {
  return isPlanPartialEvaluationV3(value) || isProgressiveBuildEvaluation(value);
}

/** Bind either readable V3 fallback shape to the exact active topology. */
export async function matchesBuildConfigV3Evaluation(
  config: BuildConfigV3,
  evaluation: PlanEvaluation,
): Promise<boolean> {
  if (isPlanPartialEvaluationV3(evaluation)) {
    return await sha256Hex(evaluation) === await sha256Hex(createPlanPartialEvaluationV3(config));
  }
  if (!isProgressiveBuildEvaluation(evaluation)) return false;
  return evaluation.authority.configHash === await hashPlanConfig(config)
    && await sha256Hex(evaluation.topologyBom) === await sha256Hex(projectTopologyBom(config));
}

export class EvaluationCoordinator {
  private readonly cache = new Map<string, Promise<CachedEvaluation>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly evaluator: (config: BuildConfig) => BuildEvaluation | Promise<BuildEvaluation>,
    private readonly now = () => new Date().toISOString(),
    private readonly options: EvaluationCoordinatorOptions = {},
  ) {}

  private async authorizeLock(input: EvaluationInput, configHash: string): Promise<PlanEvaluationLock | undefined> {
    const lock = input.evaluationLock;
    if (this.options.factGraphEnabled && !lock) throw new Error("Fact graph evaluation requires an authoritative evaluation lock");
    if (!lock) return undefined;
    if (!await verifyPlanEvaluationLock(lock) || lock.planId !== input.planId || lock.snapshotHashes.configHash !== configHash) {
      throw new Error("Evaluation input lock is invalid or does not match plan/config");
    }
    if (this.options.factGraphEnabled) {
      if (!this.options.verifyEvaluationLock) throw new Error("Fact graph evaluation lock repository authority is unavailable");
      if (!await this.options.verifyEvaluationLock(lock)) throw new Error("Evaluation input lock repository closure is invalid");
      if (!this.options.evaluateLocked) throw new Error("Fact graph governed evaluator is unavailable");
    }
    return lock;
  }

  async evaluate(input: EvaluationInput): Promise<{ snapshot: PlanEvaluationSnapshot; latest: boolean }> {
    const generation = (this.generations.get(input.planId) ?? 0) + 1;
    this.generations.set(input.planId, generation);
    const configHash = await hashPlanConfig(input.config);
    const evaluationLock = await this.authorizeLock(input, configHash);
    const cacheKey = evaluationLock?.contentHash ?? configHash;
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      const evaluationPromise = this.options.factGraphEnabled
        ? Promise.resolve(this.options.evaluateLocked!({ ...structuredClone(input), evaluationLock: structuredClone(evaluationLock!) }))
        : Promise.resolve(this.evaluator(structuredClone(input.config)));
      cached = evaluationPromise.then(async (evaluation) => ({
        evaluation,
        evaluationHash: evaluationLock
          ? await authoritativeEvaluationHash(evaluation, evaluationLock)
          : await sha256Hex(evaluation),
      }));
      this.cache.set(cacheKey, cached);
    }
    const result = await cached;
    const snapshot: PlanEvaluationSnapshot = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: input.planId,
      planVersionId: input.planVersionId,
      draftRevision: input.draftRevision,
      configHash,
      evaluationHash: result.evaluationHash,
      ...(evaluationLock ? { evaluationLock: structuredClone(evaluationLock) } : {}),
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
    const configHash = await hashPlanConfig(input.config);
    if (input.config.schemaVersion === "3.0.0") {
      if (!await matchesBuildConfigV3Evaluation(input.config, input.evaluation)) {
        throw new Error("V3 evaluation does not match the active topology/config authority");
      }
    } else if (isTopologyEvaluationV3(input.evaluation)) {
      throw new Error("BuildConfig V2 cannot use a V3 topology evaluation");
    }
    if (input.config.schemaVersion === "2.0.0") {
      const evaluationConfigHash = await hashPlanConfig((input.evaluation as BuildEvaluation).config);
      if (evaluationConfigHash !== configHash) throw new Error("Authoritative evaluation config payload does not match the active config");
    }
    const evaluationLock = await this.authorizeLock(input as EvaluationInput, configHash);
    const evaluationHash = evaluationLock
      ? await authoritativeEvaluationHash(input.evaluation, evaluationLock)
      : await sha256Hex(input.evaluation);
    if (input.expectedConfigHash !== undefined && input.expectedConfigHash !== configHash) throw new Error("Authoritative evaluation config hash mismatch");
    if (input.expectedEvaluationHash !== undefined && input.expectedEvaluationHash !== evaluationHash) throw new Error("Authoritative evaluation identity hash mismatch");
    if (this.options.factGraphEnabled) {
      if (!this.options.verifyResolvedEvaluation) throw new Error("Fact graph resolved evaluation authority is unavailable");
      if (!await this.options.verifyResolvedEvaluation(input, configHash, evaluationHash)) throw new Error("Resolved evaluation authority rejected the payload");
    }
    const cacheKey = evaluationLock?.contentHash ?? configHash;
    this.cache.set(cacheKey, Promise.resolve({ evaluation: input.evaluation, evaluationHash }));
    const snapshot: PlanEvaluationSnapshot = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: input.planId,
      planVersionId: input.planVersionId,
      draftRevision: input.draftRevision,
      configHash,
      evaluationHash,
      ...(evaluationLock ? { evaluationLock: structuredClone(evaluationLock) } : {}),
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
