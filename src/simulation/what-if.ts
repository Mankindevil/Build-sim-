import type { AcousticEvaluation } from "../acoustics";
import type { NumericRange, ThermalNetworkEvaluation } from "../thermal";
import { simulationInputChangedFields, type SimulationInputHashClosure } from "./contracts";

export interface SimulationRangeDelta {
  readonly before: NumericRange | null;
  readonly after: NumericRange | null;
  readonly delta: NumericRange | null;
}

export interface SimulationContributorDelta {
  readonly contributorId: string;
  readonly metric: "temperature_c" | "sound_pressure_dba";
  readonly beforeUpper: number | null;
  readonly afterUpper: number | null;
  readonly deltaUpper: number | null;
}

export interface SimulationWhatIfDiff {
  readonly schemaVersion: "simulation-what-if-diff-v1";
  readonly beforeInputHash: string;
  readonly afterInputHash: string;
  readonly changedInputPaths: readonly string[];
  readonly lockedInputPaths: readonly string[];
  readonly changeSources: readonly string[];
  readonly peakTemperatureC: SimulationRangeDelta;
  readonly totalDbaAt1M: SimulationRangeDelta;
  readonly contributors: readonly SimulationContributorDelta[];
}

const INPUT_PATHS = [
  "/workloadMetricRefs", "/ambientC", "/fanPolicyId", "/storageActivity", "/placementIds", "/routeIds", "/modelVersion",
] as const;

function delta(before: NumericRange | null, after: NumericRange | null): SimulationRangeDelta {
  return {
    before: before ? { ...before } : null,
    after: after ? { ...after } : null,
    delta: before && after ? { lo: after.lo - before.hi, hi: after.hi - before.lo } : null,
  };
}

function layoutChanges(before: SimulationInputHashClosure, after: SimulationInputHashClosure): string[] {
  const ids = new Set([...before.logicalLayouts, ...after.logicalLayouts].map(({ logicalLayoutId }) => logicalLayoutId));
  return [...ids].sort().flatMap((id) => {
    const left = before.logicalLayouts.find((layout) => layout.logicalLayoutId === id)?.layoutHash;
    const right = after.logicalLayouts.find((layout) => layout.logicalLayoutId === id)?.layoutHash;
    return left === right ? [] : [`/logicalLayouts/${id}`];
  });
}

/**
 * Compares two already-evaluated closures. Workload, environment and model are
 * locked by default, so a layout/fan/placement what-if cannot change its basis.
 */
export function compareSimulationWhatIf(input: {
  readonly beforeInput: SimulationInputHashClosure;
  readonly afterInput: SimulationInputHashClosure;
  readonly beforeThermal: ThermalNetworkEvaluation;
  readonly afterThermal: ThermalNetworkEvaluation;
  readonly beforeAcoustic: AcousticEvaluation;
  readonly afterAcoustic: AcousticEvaluation;
  readonly lockEnvironmentAndWorkload?: boolean;
}): SimulationWhatIfDiff {
  const changedInputPaths = [
    ...simulationInputChangedFields(input.beforeInput.sourcedInput.input, input.afterInput.sourcedInput.input),
    ...layoutChanges(input.beforeInput, input.afterInput),
  ].sort();
  if (input.beforeInput.contentHash === input.afterInput.contentHash || changedInputPaths.length === 0) {
    throw new TypeError("simulation what-if requires a changed authoritative input closure");
  }
  if (input.lockEnvironmentAndWorkload !== false
    && changedInputPaths.some((path) => path === "/ambientC" || path === "/workloadMetricRefs" || path === "/modelVersion")) {
    throw new TypeError("simulation what-if changed the locked environment, workload or model basis");
  }
  const thermalIds = new Set([...input.beforeThermal.components, ...input.afterThermal.components].map(({ componentInstanceId }) => componentInstanceId));
  const acousticIds = new Set([...input.beforeAcoustic.contributions, ...input.afterAcoustic.contributions].map(({ componentInstanceId }) => componentInstanceId));
  const contributors: SimulationContributorDelta[] = [
    ...[...thermalIds].sort().map((componentInstanceId) => {
      const beforeUpper = input.beforeThermal.components.find((component) => component.componentInstanceId === componentInstanceId)?.temperatureC?.hi ?? null;
      const afterUpper = input.afterThermal.components.find((component) => component.componentInstanceId === componentInstanceId)?.temperatureC?.hi ?? null;
      return { contributorId: componentInstanceId, metric: "temperature_c" as const, beforeUpper, afterUpper, deltaUpper: beforeUpper !== null && afterUpper !== null ? afterUpper - beforeUpper : null };
    }),
    ...[...acousticIds].sort().map((componentInstanceId) => {
      const beforeUpper = input.beforeAcoustic.contributions.find((source) => source.componentInstanceId === componentInstanceId)?.soundPressureDbaAt1M.hi ?? null;
      const afterUpper = input.afterAcoustic.contributions.find((source) => source.componentInstanceId === componentInstanceId)?.soundPressureDbaAt1M.hi ?? null;
      return { contributorId: componentInstanceId, metric: "sound_pressure_dba" as const, beforeUpper, afterUpper, deltaUpper: beforeUpper !== null && afterUpper !== null ? afterUpper - beforeUpper : null };
    }),
  ].filter(({ deltaUpper }) => deltaUpper === null || deltaUpper !== 0)
    .sort((left, right) => Math.abs(right.deltaUpper ?? Number.POSITIVE_INFINITY) - Math.abs(left.deltaUpper ?? Number.POSITIVE_INFINITY)
      || left.metric.localeCompare(right.metric) || left.contributorId.localeCompare(right.contributorId));
  return {
    schemaVersion: "simulation-what-if-diff-v1",
    beforeInputHash: input.beforeInput.contentHash,
    afterInputHash: input.afterInput.contentHash,
    changedInputPaths,
    lockedInputPaths: INPUT_PATHS.filter((path) => !changedInputPaths.includes(path)),
    changeSources: changedInputPaths.map((path) => path.startsWith("/logicalLayouts/") ? `layout:${path.slice("/logicalLayouts/".length)}` : `simulation-input:${path}`),
    peakTemperatureC: delta(input.beforeThermal.peakTemperatureC, input.afterThermal.peakTemperatureC),
    totalDbaAt1M: delta(input.beforeAcoustic.totalDba, input.afterAcoustic.totalDba),
    contributors,
  };
}
