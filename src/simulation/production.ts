import type { CaseInstanceOverrides } from "../adapters/instance-overrides";
import { hashContent } from "../hash";
import type { BuildConfigV3, ConnectionEdge } from "../topology/contracts";
import { resolveThermalEnvironment, resolveThermalScenario } from "../thermal/scenarios";
import {
  createSimulationInputHashClosure,
  logicalLayoutSimulationHash,
  simulationInputLeafPaths,
  type SimulationInput,
  type SimulationInputHashClosure,
  type SimulationInputSource,
} from "./contracts";

export interface ProductionSimulationInputPayload extends SimulationInputHashClosure {
  readonly caseInstanceOverrides: readonly CaseInstanceOverrides[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function connectedStoragePath(config: BuildConfigV3, diskInstanceId: string): ConnectionEdge[] {
  const allowedKinds = new Set(["storage_drive", "backplane", "hba", "raid_controller", "storage_expander", "motherboard"]);
  const componentById = new Map(config.components.map((component) => [component.instanceId, component]));
  if (componentById.get(diskInstanceId)?.kind !== "storage_drive") throw new TypeError(`logical layout member is not a storage drive: ${diskInstanceId}`);
  const reached = new Set([diskInstanceId]);
  const selected = new Map<string, ConnectionEdge>();
  const queue = [diskInstanceId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of config.connections) {
      if (edge.from.instanceId !== current && edge.to.instanceId !== current) continue;
      selected.set(edge.connectionId, edge);
      const other = edge.from.instanceId === current ? edge.to.instanceId : edge.from.instanceId;
      const kind = componentById.get(other)?.kind;
      if (kind && allowedKinds.has(kind) && kind !== "motherboard" && !reached.has(other)) {
        reached.add(other);
        queue.push(other);
      }
    }
  }
  return [...selected.values()].sort((left, right) => compare(left.connectionId, right.connectionId));
}

async function physicalPathHash(config: BuildConfigV3, diskInstanceId: string): Promise<string> {
  const connections = connectedStoragePath(config, diskInstanceId);
  const instanceIds = new Set([diskInstanceId, ...connections.flatMap((edge) => [edge.from.instanceId, edge.to.instanceId])]);
  const placements = config.placements.filter((placement) => instanceIds.has(placement.componentInstanceId))
    .sort((left, right) => compare(left.placementId, right.placementId));
  return hashContent({ diskInstanceId, placements, connections }, { domain: "simulation.physical-path", schemaVersion: "1.0.0" });
}

function inputSource(path: string, input: SimulationInput, config: BuildConfigV3, simulationModelHash: string): SimulationInputSource {
  const scenario = resolveThermalScenario({ requirementSpec: config.requirementSpec });
  const environment = resolveThermalEnvironment(config.requirementSpec);
  if (path.startsWith("/workloadMetricRefs")) return {
    fieldPath: path, source: scenario.source === "requirement" ? "user" : "model_default", userOverridable: true,
    sourceRef: scenario.workloadMetricRefs[Number(path.split("/").at(-1))] ?? `scenario:${scenario.scenarioId}`,
  };
  if (path.startsWith("/ambientC")) return {
    fieldPath: path, source: environment.source === "requirement" ? "user" : "model_default", userOverridable: true,
    sourceRef: environment.sourceRef,
  };
  if (path.startsWith("/storageActivity")) {
    const index = Number(path.split("/")[2]);
    return { fieldPath: path, source: "system_profile_default", userOverridable: true, sourceRef: `logical-layout:${input.storageActivity[index]?.logicalLayoutId ?? "collection"}` };
  }
  if (path === "/modelVersion") return { fieldPath: path, source: "model_default", userOverridable: true, sourceRef: `simulation-model:sha256:${simulationModelHash}` };
  if (path === "/fanPolicyId") return { fieldPath: path, source: "model_default", userOverridable: true, sourceRef: "fan-policy:balanced-v1" };
  return { fieldPath: path, source: "system_profile_default", userOverridable: true, sourceRef: `plan-config:${config.id}` };
}

/**
 * Creates the exact, replayable U9 input from the current V3 topology. The
 * model does not inspect SKU names or case-specific profiles.
 */
export async function createProductionSimulationInput(input: {
  readonly config: BuildConfigV3;
  readonly simulationModelHash: string;
  readonly caseInstanceOverrides: readonly CaseInstanceOverrides[];
}): Promise<ProductionSimulationInputPayload> {
  if (!/^[a-f0-9]{64}$/.test(input.simulationModelHash)) throw new TypeError("simulation model hash invalid");
  const scenario = resolveThermalScenario({ requirementSpec: input.config.requirementSpec });
  const environment = resolveThermalEnvironment(input.config.requirementSpec);
  const storageActivity = input.config.logicalLayouts.map((layout) => {
    const diskIds = [...layout.bootPoolDiskIds, ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds), ...layout.spareDiskIds];
    return {
      logicalLayoutId: layout.layoutId,
      dutyCycle: scenario.scenarioId === "nas-scrub" ? 0.85 : scenario.scenarioId === "idle" ? 0.05 : 0.4,
      concurrentDiskCount: diskIds.length === 0 ? 0 : scenario.scenarioId === "nas-scrub" ? diskIds.length : Math.max(1, Math.ceil(diskIds.length / 2)),
    };
  }).filter(({ concurrentDiskCount }) => concurrentDiskCount > 0).sort((left, right) => compare(left.logicalLayoutId, right.logicalLayoutId));
  const simulationInput: SimulationInput = {
    workloadMetricRefs: [...scenario.workloadMetricRefs].sort(compare),
    ambientC: { min: environment.ambientC.lo, max: environment.ambientC.hi },
    fanPolicyId: "balanced-v1",
    storageActivity,
    placementIds: input.config.placements.map(({ placementId }) => placementId).sort(compare),
    routeIds: input.config.connections.map(({ connectionId }) => connectionId).sort(compare),
    modelVersion: `sha256:${input.simulationModelHash}`,
  };
  const sourcedInput = {
    input: simulationInput,
    sources: simulationInputLeafPaths(simulationInput).map((path) => inputSource(path, simulationInput, input.config, input.simulationModelHash)),
  };
  const logicalLayouts = await Promise.all(input.config.logicalLayouts.map(async (layout) => {
    const diskIds = [...layout.bootPoolDiskIds, ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds), ...layout.spareDiskIds];
    const pathHashes = Object.fromEntries(await Promise.all(diskIds.map(async (diskId) => [diskId, await physicalPathHash(input.config, diskId)] as const)));
    return { logicalLayoutId: layout.layoutId, layoutHash: await logicalLayoutSimulationHash(layout, pathHashes) };
  }));
  const closure = await createSimulationInputHashClosure(sourcedInput, logicalLayouts);
  return {
    ...closure,
    caseInstanceOverrides: [...input.caseInstanceOverrides].map((entry) => structuredClone(entry)).sort((left, right) => compare(left.instanceId, right.instanceId)),
  };
}
