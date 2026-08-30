import { canonicalize, hashContent, isSnapshotHashes, type SnapshotHashes } from "../hash";
import type { CompatibilityDomain, ProgressiveVerdict } from "../compatibility/contracts";
import type { NumericRange } from "../thermal/types";

const USER_INPUT_FIELDS = Object.freeze([
  "configHash",
  "requirementSpecHash",
  "systemProfileHash",
  "simulationInputHash",
] satisfies Array<keyof SnapshotHashes>);

const MARKET_FIELDS = Object.freeze(["priceSnapshotHash"] satisfies Array<keyof SnapshotHashes>);

const GOVERNED_MODEL_FIELDS = Object.freeze([
  "factSnapshotHash",
  "userObservationSnapshotHash",
  "ruleSetHash",
  "adapterSnapshotHash",
  "engineHash",
  "simulationModelHash",
] satisfies Array<keyof SnapshotHashes>);

export interface RecommendationWhatIfSide {
  readonly evaluationHash: string;
  readonly snapshotHashes: SnapshotHashes;
  readonly knownTotalCny: number;
  readonly priceComplete: boolean;
  readonly domainVerdicts: Readonly<Partial<Record<CompatibilityDomain, ProgressiveVerdict>>>;
  readonly peakTemperatureC: NumericRange | null;
  readonly acousticTotalDba: NumericRange | null;
  readonly upgradePathRefs: readonly string[];
}

export interface RecommendationWhatIfResult {
  readonly schemaVersion: "recommendation-what-if-v1";
  readonly comparisonId: string;
  readonly beforeEvaluationHash: string;
  readonly afterEvaluationHash: string;
  readonly snapshotAttribution: "same_governed_snapshots" | "market_refreshed";
  readonly userInputChanges: readonly (keyof SnapshotHashes)[];
  readonly marketRefreshChanges: readonly (keyof SnapshotHashes)[];
  readonly cost: {
    readonly beforeKnownCny: number;
    readonly afterKnownCny: number;
    readonly deltaKnownCny: number;
    readonly comparisonComplete: boolean;
  };
  readonly domainChanges: readonly {
    readonly domain: CompatibilityDomain;
    readonly before: ProgressiveVerdict | "not_reported";
    readonly after: ProgressiveVerdict | "not_reported";
  }[];
  readonly thermal: { readonly before: NumericRange | null; readonly after: NumericRange | null; readonly midpointDeltaC: number | null };
  readonly acoustic: { readonly before: NumericRange | null; readonly after: NumericRange | null; readonly midpointDeltaDba: number | null };
  readonly upgradePaths: { readonly addedRefs: readonly string[]; readonly removedRefs: readonly string[] };
  readonly sensitivity: readonly {
    readonly dimension: "cost" | "compatibility" | "thermal" | "acoustic" | "spatial" | "wiring" | "upgrade_path";
    readonly changed: boolean;
    readonly attribution: "user_input" | "market_refresh" | "mixed";
  }[];
}

export interface CompareRecommendationWhatIfOptions {
  /** Price refresh is opt-in; all governed model snapshots remain pinned. */
  readonly allowMarketRefresh?: boolean;
}

function changedFields(before: SnapshotHashes, after: SnapshotHashes, fields: readonly (keyof SnapshotHashes)[]): Array<keyof SnapshotHashes> {
  return fields.filter((field) => before[field] !== after[field]);
}

function finiteRange(value: NumericRange | null): boolean {
  return value === null || (Number.isFinite(value.lo) && Number.isFinite(value.hi) && value.lo <= value.hi);
}

function midpointDelta(before: NumericRange | null, after: NumericRange | null): number | null {
  return before === null || after === null ? null : (after.lo + after.hi - before.lo - before.hi) / 2;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validateSide(side: RecommendationWhatIfSide, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(side.evaluationHash) || !isSnapshotHashes(side.snapshotHashes)) throw new TypeError(`${label} what-if authority is invalid`);
  if (!Number.isFinite(side.knownTotalCny) || side.knownTotalCny < 0 || !finiteRange(side.peakTemperatureC) || !finiteRange(side.acousticTotalDba)) throw new TypeError(`${label} what-if metrics are invalid`);
  if (side.upgradePathRefs.some((ref) => typeof ref !== "string" || ref.length === 0) || new Set(side.upgradePathRefs).size !== side.upgradePathRefs.length) throw new TypeError(`${label} what-if upgrade path refs are invalid`);
}

/**
 * Compares two already-issued evaluations. It never evaluates compatibility or
 * refreshes prices itself, and therefore cannot create a second decision path.
 */
export async function compareRecommendationWhatIf(
  before: RecommendationWhatIfSide,
  after: RecommendationWhatIfSide,
  options: CompareRecommendationWhatIfOptions = {},
): Promise<RecommendationWhatIfResult> {
  validateSide(before, "before");
  validateSide(after, "after");
  const governedChanges = changedFields(before.snapshotHashes, after.snapshotHashes, GOVERNED_MODEL_FIELDS);
  if (governedChanges.length > 0) throw new TypeError(`what-if governed snapshots changed: ${governedChanges.join(",")}`);
  const userInputChanges = changedFields(before.snapshotHashes, after.snapshotHashes, USER_INPUT_FIELDS);
  const marketRefreshChanges = changedFields(before.snapshotHashes, after.snapshotHashes, MARKET_FIELDS);
  if (marketRefreshChanges.length > 0 && options.allowMarketRefresh !== true) throw new TypeError("what-if price snapshot refresh requires explicit attribution");

  const domainNames = sortedUnique([...Object.keys(before.domainVerdicts), ...Object.keys(after.domainVerdicts)]) as CompatibilityDomain[];
  const domainChanges: Array<RecommendationWhatIfResult["domainChanges"][number]> = domainNames.flatMap((domain) => {
    const left: ProgressiveVerdict | "not_reported" = before.domainVerdicts[domain] ?? "not_reported";
    const right: ProgressiveVerdict | "not_reported" = after.domainVerdicts[domain] ?? "not_reported";
    return left === right ? [] : [{ domain, before: left, after: right }];
  });
  const beforePaths = new Set(before.upgradePathRefs);
  const afterPaths = new Set(after.upgradePathRefs);
  const upgradePaths = {
    addedRefs: sortedUnique(after.upgradePathRefs.filter((ref) => !beforePaths.has(ref))),
    removedRefs: sortedUnique(before.upgradePathRefs.filter((ref) => !afterPaths.has(ref))),
  };
  const costChanged = before.knownTotalCny !== after.knownTotalCny || before.priceComplete !== after.priceComplete;
  const compatibilityChanged = domainChanges.some(({ domain }) => !["thermal", "acoustic", "mechanical", "routing", "assembly", "electrical"].includes(domain));
  const spatialChanged = domainChanges.some(({ domain }) => domain === "mechanical");
  const wiringChanged = domainChanges.some(({ domain }) => domain === "routing" || domain === "assembly" || domain === "electrical");
  const thermalDelta = midpointDelta(before.peakTemperatureC, after.peakTemperatureC);
  const acousticDelta = midpointDelta(before.acousticTotalDba, after.acousticTotalDba);
  const attribution = marketRefreshChanges.length > 0 && userInputChanges.length > 0 ? "mixed" as const
    : marketRefreshChanges.length > 0 ? "market_refresh" as const : "user_input" as const;
  const material = {
    beforeEvaluationHash: before.evaluationHash,
    afterEvaluationHash: after.evaluationHash,
    beforeSnapshotHashes: before.snapshotHashes,
    afterSnapshotHashes: after.snapshotHashes,
    userInputChanges,
    marketRefreshChanges,
    cost: { beforeKnownCny: before.knownTotalCny, afterKnownCny: after.knownTotalCny },
    domainChanges,
    thermal: { before: before.peakTemperatureC, after: after.peakTemperatureC },
    acoustic: { before: before.acousticTotalDba, after: after.acousticTotalDba },
    upgradePaths,
  };
  const comparisonHash = await hashContent(material, { domain: "recommendation.what-if-id", schemaVersion: "1.0.0" });
  return {
    schemaVersion: "recommendation-what-if-v1",
    comparisonId: `recommendation-what-if-${comparisonHash}`,
    beforeEvaluationHash: before.evaluationHash,
    afterEvaluationHash: after.evaluationHash,
    snapshotAttribution: marketRefreshChanges.length === 0 ? "same_governed_snapshots" : "market_refreshed",
    userInputChanges,
    marketRefreshChanges,
    cost: {
      beforeKnownCny: before.knownTotalCny,
      afterKnownCny: after.knownTotalCny,
      deltaKnownCny: after.knownTotalCny - before.knownTotalCny,
      comparisonComplete: before.priceComplete && after.priceComplete,
    },
    domainChanges,
    thermal: { before: before.peakTemperatureC, after: after.peakTemperatureC, midpointDeltaC: thermalDelta },
    acoustic: { before: before.acousticTotalDba, after: after.acousticTotalDba, midpointDeltaDba: acousticDelta },
    upgradePaths,
    sensitivity: [
      { dimension: "cost", changed: costChanged, attribution },
      { dimension: "compatibility", changed: compatibilityChanged, attribution: "user_input" },
      { dimension: "thermal", changed: thermalDelta !== 0, attribution: "user_input" },
      { dimension: "acoustic", changed: acousticDelta !== 0, attribution: "user_input" },
      { dimension: "spatial", changed: spatialChanged, attribution: "user_input" },
      { dimension: "wiring", changed: wiringChanged, attribution: "user_input" },
      { dimension: "upgrade_path", changed: upgradePaths.addedRefs.length > 0 || upgradePaths.removedRefs.length > 0, attribution: "user_input" },
    ],
  };
}

export function recommendationWhatIfEqual(left: RecommendationWhatIfResult, right: RecommendationWhatIfResult): boolean {
  return canonicalize(left) === canonicalize(right);
}
