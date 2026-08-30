import { aggregateAcousticSources } from "../acoustics/aggregate";
import { acousticObservationSources, type AcousticCalibrationObservation } from "../acoustics/calibration";
import { acousticSourceAtOperatingPoint } from "../acoustics/operating-point";
import type { AcousticCurve, AcousticEvaluation, CoilWhineRisk } from "../acoustics/types";
import type { CaseAdapterArtifactPayload } from "../adapters/registry";
import type { EvidenceLevel } from "../core/evidence";
import type { FactRecord } from "../facts/contracts";
import type { ArtifactPayload } from "../hash";
import type { GovernedEvaluationInput } from "../server/evaluation-service";
import { solveAirflowNetwork } from "../thermal/airflow-graph";
import { calibrateThermalEvaluation, type ThermalCalibrationObservation } from "../thermal/calibration";
import { inferredPlanningFanCurve } from "../thermal/fan-operating-point";
import { resolveThermalEnvironment, resolveThermalScenario, STANDARD_THERMAL_SCENARIOS } from "../thermal/scenarios";
import { evaluateSteadyStateThermal } from "../thermal/steady-state";
import type { AirflowNetwork, FanCurve, NumericRange, ThermalHeatSource, ThermalNetworkEvaluation } from "../thermal/types";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import { validateSimulationInputHashClosure, type SimulationInputHashClosure } from "./contracts";
import { resolveStorageActivity } from "./storage-activity";

export interface ProductionThermalAcousticEvaluation {
  readonly schemaVersion: "production-thermal-acoustic-evaluation-v1";
  /** Hash of the locked external SimulationInput artifact. */
  readonly simulationInputHash: string;
  /** Hash of the canonical SimulationInput closure inside that artifact. */
  readonly simulationInputClosureHash: string | null;
  readonly workloadId: string;
  readonly calibration: {
    readonly appliedThermalObservationIds: readonly string[];
    readonly rejectedThermalObservationIds: readonly string[];
    readonly appliedAcousticObservationIds: readonly string[];
    readonly rejectedAcousticObservationIds: readonly string[];
  };
  readonly thermal: ThermalNetworkEvaluation;
  readonly acoustic: AcousticEvaluation;
}

export interface ProductionThermalAcousticFeatureOptions {
  readonly thermalV3Enabled?: boolean;
  readonly acousticV3Enabled?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evidence(fact: FactRecord): EvidenceLevel {
  return fact.authority === "official" ? "official" : "inferred";
}

function subjectMatches(fact: FactRecord, planId: string, component: ComponentInstance): boolean {
  if (fact.subject.kind === "product") return component.identity.status === "resolved" && fact.subject.skuId === component.identity.skuId;
  if (fact.subject.planId !== planId) return false;
  const subject = fact.subject.subjectRef;
  return ("instanceId" in subject && subject.instanceId === component.instanceId)
    || (subject.kind === "mount" && subject.ownerInstanceId === component.instanceId);
}

function exactFact(input: GovernedEvaluationInput, component: ComponentInstance, field: string): FactRecord | null {
  const matches = input.factClosure.facts.filter((fact) => fact.status === "active" && fact.field === field && subjectMatches(fact, input.planId, component));
  return matches.length === 1 ? matches[0]! : null;
}

function rangeFact(input: GovernedEvaluationInput, component: ComponentInstance, field: string): { range: NumericRange; fact: FactRecord } | null {
  const fact = exactFact(input, component, field);
  if (!fact || !record(fact.value) || typeof fact.value.lo !== "number" || typeof fact.value.hi !== "number") return null;
  return { range: { lo: fact.value.lo, hi: fact.value.hi }, fact };
}

function numberFact(input: GovernedEvaluationInput, component: ComponentInstance, field: string): { value: number; fact: FactRecord } | null {
  const fact = exactFact(input, component, field);
  return fact && typeof fact.value === "number" && Number.isFinite(fact.value) ? { value: fact.value, fact } : null;
}

function observationUncertaintyPlusMinus(observation: GovernedEvaluationInput["observationClosure"]["observations"][number]["observation"]): number {
  if (observation.uncertainty?.plusMinus !== undefined) return observation.uncertainty.plusMinus;
  if (observation.uncertainty?.min !== undefined && observation.uncertainty.max !== undefined && typeof observation.value === "number") {
    return Math.max(observation.value - observation.uncertainty.min, observation.uncertainty.max - observation.value);
  }
  throw new TypeError(`calibration observation ${observation.observationId} lacks numeric uncertainty`);
}

function thermalCalibrationObservations(input: GovernedEvaluationInput, workloadId: string): ThermalCalibrationObservation[] {
  return input.observationClosure.observations.flatMap(({ observation }) => {
    if (typeof observation.value !== "number") return [];
    const componentInstanceId = observation.subjectRef.kind === "instance" ? observation.subjectRef.instanceId : null;
    const kind: ThermalCalibrationObservation["kind"] | null = observation.fieldId === "thermal.ambient_temperature" ? "ambient_c"
      : observation.fieldId === "thermal.fan_rpm" ? "fan_rpm"
        : observation.fieldId === "thermal.component_temperature" ? "component_temperature_c" : null;
    if (kind === null || (kind !== "ambient_c" && componentInstanceId === null)) return [];
    return [{
      observationId: observation.observationId,
      planId: observation.planId,
      componentInstanceId,
      workloadId: observation.measurementContext?.workloadId ?? workloadId,
      kind,
      value: observation.value,
      uncertaintyPlusMinus: observationUncertaintyPlusMinus(observation),
      method: observation.method,
      observedAt: observation.capturedAt,
      status: observation.status === "active" ? "active" as const : "retracted" as const,
    }];
  }).sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function acousticCalibrationObservations(input: GovernedEvaluationInput): AcousticCalibrationObservation[] {
  return input.observationClosure.observations.flatMap(({ observation }) => {
    const context = observation.measurementContext;
    if (observation.fieldId !== "acoustics.sound_pressure" || typeof observation.value !== "number"
      || observation.subjectRef.kind !== "instance" || context?.testMethodId === undefined
      || context.referenceDistanceM === undefined || context.rpm === undefined) return [];
    return [{
      observationId: observation.observationId,
      planId: observation.planId,
      componentInstanceId: observation.subjectRef.instanceId,
      loadId: context.workloadId,
      rpm: { ...context.rpm },
      soundPressureDba: observation.value,
      uncertaintyPlusMinusDba: observationUncertaintyPlusMinus(observation),
      weighting: "A" as const,
      referenceDistanceM: context.referenceDistanceM,
      testMethodId: context.testMethodId,
      observedAt: observation.capturedAt,
      status: observation.status === "active" ? "active" as const : "retracted" as const,
    }];
  }).sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function simulationClosure(input: GovernedEvaluationInput): SimulationInputHashClosure | null {
  const artifact = input.externalInputs.simulationInput.payload as ArtifactPayload;
  const value = record(artifact) ? artifact.payload : null;
  if (!record(value)) return null;
  const closure = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "caseInstanceOverrides"));
  return validateSimulationInputHashClosure(closure).length === 0 ? closure as unknown as SimulationInputHashClosure : null;
}

function caseVolumeLitres(input: GovernedEvaluationInput, caseComponent: ComponentInstance): { value: number; sourceRefs: string[] } | null {
  const identity = caseComponent.identity;
  if (identity.status !== "resolved") return null;
  const payload = input.artifacts.adapterSnapshot.payload as Partial<CaseAdapterArtifactPayload>;
  const manifests = payload.caseManifests?.filter((manifest) => manifest.identity.skuId === identity.skuId) ?? [];
  if (manifests.length !== 1) return null;
  const manifest = manifests[0]!;
  const nodes = manifest.geometry.interiorSpaces.length ? manifest.geometry.interiorSpaces : [manifest.geometry.envelope];
  const value = nodes.reduce((sum, node) => sum + node.sizeMm[0] * node.sizeMm[1] * node.sizeMm[2] / 1_000_000, 0);
  return Number.isFinite(value) && value > 0 ? { value, sourceRefs: [manifest.contentHash, ...manifest.sourceRefs] } : null;
}

function componentCase(config: BuildConfigV3, component: ComponentInstance): ComponentInstance | null {
  if (component.kind === "case") return component;
  const placement = config.placements.find((candidate) => candidate.componentInstanceId === component.instanceId);
  if (!placement) return null;
  return config.components.find((candidate) => candidate.instanceId === placement.mountOwnerInstanceId && candidate.kind === "case") ?? null;
}

function scenarioFraction(workloadId: string, kind: ComponentInstance["kind"]): NumericRange {
  const scenarioId = workloadId.startsWith("scenario:") ? workloadId.slice("scenario:".length) : "balanced-mixed";
  const scenario = STANDARD_THERMAL_SCENARIOS.find((candidate) => candidate.scenarioId === scenarioId)
    ?? STANDARD_THERMAL_SCENARIOS.find((candidate) => candidate.scenarioId === "balanced-mixed")!;
  const key = kind === "cpu" ? "cpu" : kind === "gpu" ? "gpu" : kind === "storage_drive" ? "storage" : "other";
  return scenario.componentLoadFractions[key] ?? { lo: 0.1, hi: 0.6 };
}

function thermalNetwork(input: GovernedEvaluationInput, config: BuildConfigV3): { network: AirflowNetwork | null; missing: string[] } {
  const cases = config.components.filter((component) => component.kind === "case");
  const missing: string[] = [];
  const chambers = cases.flatMap((component) => {
    const volume = caseVolumeLitres(input, component);
    if (!volume) { missing.push(`case-volume:${component.instanceId}`); return []; }
    return [{
      chamberId: component.instanceId, label: component.role || component.instanceId, volumeLitres: volume.value, maximumTemperatureC: null,
      provenance: { evidence: "inferred" as const, sourceRefs: volume.sourceRefs, assumptions: ["case chamber volume comes from the locked adapter geometry"] },
    }];
  });
  if (chambers.length === 0) return { network: null, missing: [...missing, "case-chamber-missing"] };
  const edges: AirflowNetwork["edges"][number][] = [];
  for (const caseComponent of cases) {
    if (!chambers.some(({ chamberId }) => chamberId === caseComponent.instanceId)) continue;
    const resistance = rangeFact(input, caseComponent, "thermal.airflow_resistance");
    if (!resistance) { missing.push(`airflow-resistance:${caseComponent.instanceId}`); continue; }
    edges.push({
      edgeId: `opening:${caseComponent.instanceId}`, fromChamberId: null, toChamberId: caseComponent.instanceId, kind: "opening",
      resistancePaPerCfm2: resistance.range, enabled: true,
      provenance: { evidence: evidence(resistance.fact), sourceRefs: [resistance.fact.factId], assumptions: [] },
    });
    const fans = config.components.filter((component) => component.kind === "case_fan" && componentCase(config, component)?.instanceId === caseComponent.instanceId);
    if (fans.length === 0) missing.push(`installed-fan:${caseComponent.instanceId}`);
    for (const fan of fans) {
      const curveFact = exactFact(input, fan, "thermal.airflow_curve");
      if (!curveFact || !record(curveFact.value) || !Array.isArray(curveFact.value.points)) {
        missing.push(`fan-airflow-curve:${fan.instanceId}`);
        edges.push({
          edgeId: fan.instanceId,
          fromChamberId: caseComponent.instanceId,
          toChamberId: null,
          kind: "fan",
          resistancePaPerCfm2: { lo: 0, hi: 0 },
          enabled: true,
          fanCurve: inferredPlanningFanCurve(fan.instanceId),
          provenance: {
            evidence: "unknown",
            sourceRefs: [],
            assumptions: ["exact fan P-Q curve is missing; the displayed interval is a broad locked-model inference"],
          },
        });
        continue;
      }
      const value = curveFact.value as unknown as { curveId: string; uncertaintyFraction: number; points: FanCurve["points"] };
      edges.push({
        edgeId: fan.instanceId, fromChamberId: caseComponent.instanceId, toChamberId: null, kind: "fan",
        resistancePaPerCfm2: { lo: 0, hi: 0 }, enabled: true,
        fanCurve: {
          curveId: value.curveId, uncertaintyFraction: value.uncertaintyFraction, points: structuredClone(value.points),
          provenance: { evidence: evidence(curveFact), sourceRefs: [curveFact.factId], assumptions: [] },
        },
        provenance: { evidence: evidence(curveFact), sourceRefs: [curveFact.factId], assumptions: [] },
      });
    }
  }
  return { network: { schemaVersion: "airflow-network-v1", chambers, edges }, missing };
}

function heatSources(
  input: GovernedEvaluationInput,
  config: BuildConfigV3,
  workloadId: string,
  closure: SimulationInputHashClosure | null,
): { sources: ThermalHeatSource[]; missing: string[] } {
  const sources: ThermalHeatSource[] = [];
  const missing: string[] = [];
  for (const component of config.components.filter(({ kind }) => !["case", "cable", "adapter", "bracket"].includes(kind))) {
    const owner = componentCase(config, component);
    const designPower = numberFact(input, component, "thermal.design_power");
    const resistance = rangeFact(input, component, "thermal.case_to_air_resistance");
    const maximum = numberFact(input, component, "thermal.maximum_temperature");
    if (!owner) missing.push(`thermal-placement:${component.instanceId}`);
    if (!designPower) missing.push(`thermal-design-power:${component.instanceId}`);
    if (!resistance) missing.push(`case-to-air-resistance:${component.instanceId}`);
    if (!maximum) missing.push(`maximum-temperature:${component.instanceId}`);
    if (!owner || !designPower || !resistance) continue;
    const storageActivity = component.kind === "storage_drive" && closure !== null
      ? resolveStorageActivity({ config, closure, componentInstanceId: component.instanceId }) : null;
    if (component.kind === "storage_drive" && storageActivity?.status !== "ready") {
      missing.push(storageActivity?.reasonCode ?? `storage-activity:${component.instanceId}`);
      continue;
    }
    const fraction = storageActivity?.status === "ready"
      ? { lo: storageActivity.activeFraction, hi: storageActivity.activeFraction }
      : scenarioFraction(workloadId, component.kind);
    sources.push({
      sourceId: `heat:${component.instanceId}`, componentInstanceId: component.instanceId, chamberId: owner.instanceId, workloadId,
      watts: { lo: designPower.value * fraction.lo, hi: designPower.value * fraction.hi },
      caseToAirResistanceKPerW: resistance.range, maximumTemperatureC: maximum?.value ?? null,
      provenance: {
        evidence: [designPower.fact, resistance.fact, maximum?.fact].filter((fact): fact is FactRecord => fact !== undefined)
          .some((fact) => evidence(fact) === "inferred") ? "inferred" : "official",
        sourceRefs: [designPower.fact.factId, resistance.fact.factId, ...(maximum ? [maximum.fact.factId] : [])].sort(),
        assumptions: storageActivity?.status === "ready"
          ? [storageActivity.assumption]
          : [`workload fraction ${fraction.lo}-${fraction.hi} for ${component.kind}`],
      },
    });
  }
  return { sources, missing };
}

function acousticEvaluation(
  input: GovernedEvaluationInput,
  config: BuildConfigV3,
  workloadId: string,
  thermal: ThermalNetworkEvaluation,
  closure: SimulationInputHashClosure | null,
): { evaluation: AcousticEvaluation; appliedObservationIds: string[]; rejectedObservationIds: string[] } {
  const sources = [];
  const risks: CoilWhineRisk[] = [];
  const missing: string[] = [];
  const activityAssumptions: string[] = [];
  let testMethodId: string | null = null;
  for (const component of config.components) {
    const curveFact = exactFact(input, component, "acoustic.sound_curve");
    const riskFact = exactFact(input, component, "acoustic.coil_whine_risk");
    if (riskFact && record(riskFact.value)) risks.push({
      componentInstanceId: component.instanceId,
      risk: riskFact.value.risk as CoilWhineRisk["risk"], sourceRefs: [riskFact.factId], note: String(riskFact.value.note),
    });
    if (!curveFact) {
      continue;
    }
    const value = curveFact.value as { curveId: string; weighting: "A"; referenceDistanceM: number; loadId: string; testMethodId: string; points: Array<{ rpm: number; lo: number; hi: number }> };
    if (value.loadId !== workloadId) { missing.push(`acoustic-load-mismatch:${component.instanceId}`); continue; }
    if (testMethodId !== null && testMethodId !== value.testMethodId) { missing.push(`acoustic-method-mismatch:${component.instanceId}`); continue; }
    testMethodId ??= value.testMethodId;
    const point = thermal.airflow.fanOperatingPoints.find(({ edgeId }) => edgeId === component.instanceId);
    const rpm = point?.rpm ?? { lo: value.points[0]!.rpm, hi: value.points.at(-1)!.rpm };
    const curve: AcousticCurve = {
      curveId: value.curveId, componentInstanceId: component.instanceId, weighting: "A", referenceDistanceM: value.referenceDistanceM,
      loadId: value.loadId, testMethodId: value.testMethodId,
      points: value.points.map(({ rpm: pointRpm, lo, hi }) => ({ rpm: pointRpm, soundPressureDba: { lo, hi } })),
      sourceRefs: [curveFact.factId], evidence: evidence(curveFact),
    };
    const source = acousticSourceAtOperatingPoint(curve, rpm);
    if (component.kind === "storage_drive") {
      const activity = closure === null ? null : resolveStorageActivity({ config, closure, componentInstanceId: component.instanceId });
      if (activity?.status !== "ready") {
        missing.push(activity?.reasonCode ?? `storage-activity:${component.instanceId}`);
        continue;
      }
      const adjustmentDba = 10 * Math.log10(activity.activeFraction);
      sources.push({
        ...source,
        soundPressureDbaAt1M: {
          lo: source.soundPressureDbaAt1M.lo + adjustmentDba,
          hi: source.soundPressureDbaAt1M.hi + adjustmentDba,
        },
      });
      activityAssumptions.push(`${activity.assumption}; hardware sound is reported as an equivalent scenario level`);
    } else {
      sources.push(source);
    }
  }
  const observations = acousticCalibrationObservations(input);
  const observationMethods = [...new Set(observations.filter((entry) => entry.status === "active" && entry.loadId === workloadId)
    .map(({ testMethodId: method }) => method))].sort();
  testMethodId ??= observationMethods.length === 1 ? observationMethods[0]! : null;
  if (observationMethods.length > 1 && testMethodId === null) missing.push("acoustic-method-mismatch:observations");
  const projected = acousticObservationSources({
    planId: input.planId,
    loadId: workloadId,
    testMethodId: testMethodId ?? "unresolved",
    observations,
  });
  sources.push(...projected.sources);
  const suppliedInstances = new Set(sources.map(({ componentInstanceId }) => componentInstanceId));
  for (const component of config.components) {
    if (["case_fan", "cpu_cooler", "aio", "pump", "gpu", "psu", "storage_drive"].includes(component.kind)
      && !suppliedInstances.has(component.instanceId)) missing.push(`acoustic-curve:${component.instanceId}`);
  }
  const maximumDba = config.requirementSpec?.workloads.flatMap((workload) => workload.metrics).flatMap((metric) => {
    if (metric.metricId !== "acoustics.noise" || ("state" in metric && metric.state !== undefined && metric.state !== "answered")
      || ("confirmedByUser" in metric && metric.confirmedByUser === false)) return [];
    if (metric.operator === "lte" && typeof metric.value === "number") return [metric.value];
    if (metric.operator === "between" && Array.isArray(metric.value) && typeof metric.value[1] === "number") return [metric.value[1]];
    return [];
  }).at(0);
  const evaluation = aggregateAcousticSources({
    sources, loadId: workloadId, testMethodId: testMethodId ?? "unresolved",
    ...(maximumDba === undefined ? {} : { maximumDba }),
    coilWhineRisks: risks, blockedReasonCodes: missing, assumptions: activityAssumptions,
  });
  const appliedObservationIds = projected.sources.map(({ sourceId }) => sourceId.replace(/^observation:/u, "")).sort();
  return { evaluation, appliedObservationIds, rejectedObservationIds: projected.rejectedObservationIds };
}

function blockedThermalEvaluation(ambientC: NumericRange, reason: string): ThermalNetworkEvaluation {
  return {
    schemaVersion: "thermal-network-evaluation-v1",
    ambientC,
    airflow: {
      schemaVersion: "airflow-network-result-v1",
      fanOperatingPoints: [],
      chambers: [],
      blockedReasonCodes: [reason],
      assumptions: [],
    },
    chambers: [],
    components: [],
    peakTemperatureC: null,
    verdict: "blocked",
    energyBalanceToleranceW: 0,
    energyBalanceResidualW: 0,
    blockedReasonCodes: [reason],
    assumptions: [`blocked: ${reason}`],
    evidence: "unknown",
    displayNotice: "规划热场插值，非 CFD、非实测",
  };
}

function blockedAcousticEvaluation(workloadId: string, reason: string): AcousticEvaluation {
  return {
    schemaVersion: "acoustic-evaluation-v1",
    referenceDistanceM: 1,
    loadId: workloadId,
    testMethodId: "unresolved",
    totalDba: null,
    level: "unknown",
    verdict: "blocked",
    blockedReasonCodes: [reason],
    contributions: [],
    excludedSourceIds: [],
    coilWhineRisks: [],
    assumptions: [`blocked: ${reason}`],
    displayNotice: "标准化硬件声源结果，不代表房间或用户位置的实际噪音",
  };
}

export function evaluateProductionThermalAcoustic(
  input: GovernedEvaluationInput,
  options: ProductionThermalAcousticFeatureOptions = {},
): ProductionThermalAcousticEvaluation {
  if (input.config.schemaVersion !== "3.0.0") throw new TypeError("production thermal/acoustic evaluation requires BuildConfig V3");
  const closure = simulationClosure(input);
  const scenario = resolveThermalScenario({ requirementSpec: input.config.requirementSpec });
  const environment = resolveThermalEnvironment(input.config.requirementSpec);
  const workloadId = scenario.scenarioId.startsWith("requirements:") ? scenario.scenarioId : `scenario:${scenario.scenarioId}`;
  const thermalV3Enabled = options.thermalV3Enabled !== false;
  const acousticV3Enabled = options.acousticV3Enabled !== false;
  if (!thermalV3Enabled) {
    const rejectedThermalObservationIds = thermalCalibrationObservations(input, workloadId).map(({ observationId }) => observationId).sort();
    const rejectedAcousticObservationIds = acousticCalibrationObservations(input).map(({ observationId }) => observationId).sort();
    return {
      schemaVersion: "production-thermal-acoustic-evaluation-v1",
      simulationInputHash: input.snapshotHashes.simulationInputHash,
      simulationInputClosureHash: closure?.contentHash ?? null,
      workloadId,
      calibration: {
        appliedThermalObservationIds: [],
        rejectedThermalObservationIds,
        appliedAcousticObservationIds: [],
        rejectedAcousticObservationIds,
      },
      thermal: blockedThermalEvaluation(environment.ambientC, "thermal-v3-disabled"),
      acoustic: blockedAcousticEvaluation(workloadId, acousticV3Enabled ? "thermal-v3-disabled" : "acoustic-v3-disabled"),
    };
  }
  const network = thermalNetwork(input, input.config);
  const heat = heatSources(input, input.config, workloadId, closure);
  const missing = [
    ...(closure ? [] : ["simulation-input-closure"]),
    ...(scenario.requiresConfirmation ? ["workload-confirmation"] : []),
    ...network.missing,
    ...heat.missing,
  ];
  const baseThermal = network.network
    ? evaluateSteadyStateThermal({ airflow: solveAirflowNetwork(network.network), environment, heatSources: heat.sources, blockedReasonCodes: missing })
    : {
      schemaVersion: "thermal-network-evaluation-v1" as const, ambientC: environment.ambientC,
      airflow: { schemaVersion: "airflow-network-result-v1" as const, fanOperatingPoints: [], chambers: [], blockedReasonCodes: [...new Set(missing)].sort(), assumptions: [] },
      chambers: [], components: [], peakTemperatureC: null, verdict: "blocked" as const,
      energyBalanceToleranceW: 0, energyBalanceResidualW: 0, blockedReasonCodes: [...new Set(missing)].sort(),
      assumptions: missing.map((code) => `blocked: ${code}`), evidence: "unknown" as const,
      displayNotice: "规划热场插值，非 CFD、非实测" as const,
    };
  const thermalCalibration = calibrateThermalEvaluation({
    evaluation: baseThermal,
    planId: input.planId,
    workloadId,
    observations: thermalCalibrationObservations(input, workloadId),
  });
  const acoustic = acousticV3Enabled
    ? acousticEvaluation(input, input.config, workloadId, thermalCalibration.evaluation, closure)
    : {
      evaluation: blockedAcousticEvaluation(workloadId, "acoustic-v3-disabled"),
      appliedObservationIds: [],
      rejectedObservationIds: acousticCalibrationObservations(input).map(({ observationId }) => observationId).sort(),
    };
  return {
    schemaVersion: "production-thermal-acoustic-evaluation-v1",
    simulationInputHash: input.snapshotHashes.simulationInputHash,
    simulationInputClosureHash: closure?.contentHash ?? null,
    workloadId,
    calibration: {
      appliedThermalObservationIds: thermalCalibration.appliedObservationIds,
      rejectedThermalObservationIds: thermalCalibration.rejectedObservationIds,
      appliedAcousticObservationIds: acoustic.appliedObservationIds,
      rejectedAcousticObservationIds: acoustic.rejectedObservationIds,
    },
    thermal: thermalCalibration.evaluation,
    acoustic: acoustic.evaluation,
  };
}
