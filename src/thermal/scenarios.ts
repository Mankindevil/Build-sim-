import type { ActionableRequirementMetric, RequirementSpec, WorkloadRequirement } from "../requirements/contracts";
import type { ThermalEnvironmentProfile } from "./types";

export interface StandardThermalScenario {
  readonly scenarioId: "idle" | "cpu-sustained" | "gpu-sustained" | "nas-scrub" | "balanced-mixed";
  readonly label: string;
  readonly componentLoadFractions: Readonly<Record<string, { lo: number; hi: number }>>;
}

export interface ResolvedThermalScenario {
  readonly scenarioId: string;
  readonly workloadMetricRefs: readonly string[];
  readonly source: "requirement" | "user_standard_scenario" | "model_default";
  readonly confirmedByUser: boolean;
  readonly requiresConfirmation: boolean;
  readonly assumptions: readonly string[];
}

export const STANDARD_THERMAL_SCENARIOS: readonly StandardThermalScenario[] = Object.freeze([
  { scenarioId: "idle", label: "Idle", componentLoadFractions: { cpu: { lo: 0.03, hi: 0.12 }, gpu: { lo: 0.02, hi: 0.08 }, storage: { lo: 0, hi: 0.1 } } },
  { scenarioId: "cpu-sustained", label: "Sustained CPU", componentLoadFractions: { cpu: { lo: 0.8, hi: 1 }, gpu: { lo: 0.02, hi: 0.12 }, storage: { lo: 0.05, hi: 0.25 } } },
  { scenarioId: "gpu-sustained", label: "Sustained GPU", componentLoadFractions: { cpu: { lo: 0.25, hi: 0.65 }, gpu: { lo: 0.8, hi: 1 }, storage: { lo: 0.05, hi: 0.2 } } },
  { scenarioId: "nas-scrub", label: "NAS scrub", componentLoadFractions: { cpu: { lo: 0.2, hi: 0.6 }, gpu: { lo: 0, hi: 0 }, storage: { lo: 0.7, hi: 1 } } },
  { scenarioId: "balanced-mixed", label: "Balanced mixed", componentLoadFractions: { cpu: { lo: 0.2, hi: 0.75 }, gpu: { lo: 0.1, hi: 0.75 }, storage: { lo: 0.1, hi: 0.65 } } },
]);

function actionable(workload: WorkloadRequirement): workload is Extract<WorkloadRequirement, { name: string }> {
  return "name" in workload && (workload.state === undefined || workload.state === "answered");
}

function metricRef(workloadId: string, metric: ActionableRequirementMetric): string {
  return `requirement:${workloadId}:${metric.metricId}`;
}

export function resolveThermalScenario(input: {
  readonly requirementSpec: RequirementSpec | null;
  readonly explicitStandardScenarioId?: StandardThermalScenario["scenarioId"];
  readonly explicitScenarioConfirmedByUser?: boolean;
}): ResolvedThermalScenario {
  const workloads = input.requirementSpec?.workloads.filter(actionable) ?? [];
  const confirmed = workloads.filter((workload) => workload.state === undefined || workload.confirmedByUser);
  const selectedScenarios = confirmed.flatMap((workload) => workload.metrics.flatMap((metric) => {
    if (metric.metricId !== "thermal.scenario" || ("state" in metric && metric.state !== undefined && metric.state !== "answered")
      || ("confirmedByUser" in metric && metric.confirmedByUser === false) || metric.operator !== "eq"
      || typeof metric.value !== "string") return [];
    return [metric.value];
  }));
  if (selectedScenarios.length > 1 || selectedScenarios.some((scenarioId) => !STANDARD_THERMAL_SCENARIOS.some((candidate) => candidate.scenarioId === scenarioId))) {
    throw new TypeError("RequirementSpec thermal scenario must select one known standard scenario");
  }
  const refs = confirmed.flatMap((workload) => workload.metrics.flatMap((metric) => {
    if ("state" in metric && metric.state !== undefined && metric.state !== "answered") return [];
    if ("confirmedByUser" in metric && metric.confirmedByUser === false) return [];
    return [metricRef(workload.workloadId, metric as ActionableRequirementMetric)];
  })).sort();
  if (selectedScenarios.length === 1) return {
    scenarioId: selectedScenarios[0]!,
    workloadMetricRefs: refs,
    source: "requirement",
    confirmedByUser: true,
    requiresConfirmation: false,
    assumptions: ["user selected a standard workload scenario in the current RequirementSpec"],
  };
  if (refs.length > 0) return {
    scenarioId: `requirements:${confirmed.map(({ workloadId }) => workloadId).sort().join("+")}`,
    workloadMetricRefs: refs,
    source: "requirement",
    confirmedByUser: true,
    requiresConfirmation: false,
    assumptions: ["workload comes from the current confirmed RequirementSpec"],
  };
  if (input.explicitStandardScenarioId !== undefined) {
    if (!STANDARD_THERMAL_SCENARIOS.some(({ scenarioId }) => scenarioId === input.explicitStandardScenarioId)) {
      throw new TypeError("thermal standard scenario is unknown");
    }
    const confirmedByUser = input.explicitScenarioConfirmedByUser === true;
    return {
      scenarioId: input.explicitStandardScenarioId,
      workloadMetricRefs: [`scenario:${input.explicitStandardScenarioId}`],
      source: "user_standard_scenario",
      confirmedByUser,
      requiresConfirmation: !confirmedByUser,
      assumptions: confirmedByUser ? ["user selected the standard workload scenario"] : ["standard workload scenario awaits user confirmation"],
    };
  }
  return {
    scenarioId: "balanced-mixed",
    workloadMetricRefs: ["scenario:balanced-mixed"],
    source: "model_default",
    confirmedByUser: false,
    requiresConfirmation: true,
    assumptions: ["no workload was provided; balanced-mixed is a broad planning default", "component class or price was not used to infer workload"],
  };
}

export function resolveThermalEnvironment(requirementSpec: RequirementSpec | null): ThermalEnvironmentProfile {
  for (const workload of requirementSpec?.workloads ?? []) {
    if (!actionable(workload) || (workload.state === "answered" && !workload.confirmedByUser)) continue;
    for (const metric of workload.metrics) {
      if (metric.metricId !== "thermal.ambient" || ("state" in metric && metric.state !== undefined && metric.state !== "answered")
        || ("confirmedByUser" in metric && metric.confirmedByUser === false)) continue;
      if (metric.operator === "eq" && typeof metric.value === "number") return {
        ambientC: { lo: metric.value, hi: metric.value }, source: "requirement",
        sourceRef: metricRef(workload.workloadId, metric as ActionableRequirementMetric), confirmedByUser: true,
      };
      if (metric.operator === "between" && Array.isArray(metric.value) && metric.value.length === 2
        && metric.value.every((value) => typeof value === "number" && Number.isFinite(value))) return {
        ambientC: { lo: metric.value[0] as number, hi: metric.value[1] as number }, source: "requirement",
        sourceRef: metricRef(workload.workloadId, metric as ActionableRequirementMetric), confirmedByUser: true,
      };
    }
  }
  return { ambientC: { lo: 20, hi: 30 }, source: "model_default", sourceRef: "model-default:ambient-20-30c", confirmedByUser: false };
}
