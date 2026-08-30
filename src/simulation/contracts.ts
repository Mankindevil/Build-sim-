import { hashContent } from "../hash";
import type { LogicalLayoutSelection } from "../topology/contracts";

export interface SimulationInput {
  workloadMetricRefs: string[];
  ambientC: { min: number; max: number };
  fanPolicyId: string;
  storageActivity: Array<{ logicalLayoutId: string; dutyCycle: number; concurrentDiskCount: number }>;
  placementIds: string[];
  routeIds: string[];
  modelVersion: string;
}

export interface SimulationInputSource {
  fieldPath: string;
  source: "user" | "system_profile_default" | "model_default";
  userOverridable: true;
  sourceRef: string;
}

export interface SourcedSimulationInput {
  input: SimulationInput;
  sources: SimulationInputSource[];
}

/** Immutable, replay-required coefficients used by a versioned simulation engine. */
export interface SimulationModelArtifact {
  schemaVersion: "simulation-model-artifact-v1";
  modelId: string;
  modelVersion: string;
  assumptions: string[];
  coefficients: Record<string, number>;
  contentHash: string;
}

export interface SimulationLogicalLayoutClosure {
  readonly logicalLayoutId: string;
  readonly layoutHash: string;
}

export interface SimulationInputHashClosure {
  readonly schemaVersion: "simulation-input-hash-closure-v1";
  readonly sourcedInput: SourcedSimulationInput;
  readonly logicalLayouts: readonly SimulationLogicalLayoutClosure[];
  readonly contentHash: string;
}

const SIMULATION_INPUT_HASH_CLOSURE_FIELDS = ["schemaVersion", "sourcedInput", "logicalLayouts", "contentHash"] as const;

export async function logicalLayoutSimulationHash(
  layout: LogicalLayoutSelection,
  physicalPathHashes: Readonly<Record<string, string>>,
): Promise<string> {
  const diskIds = [
    ...layout.bootPoolDiskIds,
    ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
    ...layout.spareDiskIds,
  ];
  if (!layout.layoutId || new Set(diskIds).size !== diskIds.length
    || layout.vdevs.some((vdev) => !vdev.vdevId || vdev.diskInstanceIds.length === 0)
    || Object.entries(physicalPathHashes).some(([diskId, value]) => !diskIds.includes(diskId) || !/^[a-f0-9]{64}$/.test(value))
    || diskIds.some((diskId) => !/^[a-f0-9]{64}$/.test(physicalPathHashes[diskId] ?? ""))) {
    throw new TypeError("simulation logical layout authority invalid");
  }
  const normalized = {
    layoutId: layout.layoutId,
    bootPoolDiskIds: [...layout.bootPoolDiskIds].sort(),
    vdevs: [...layout.vdevs].map((vdev) => ({ ...vdev, diskInstanceIds: [...vdev.diskInstanceIds].sort() })).sort((left, right) => left.vdevId.localeCompare(right.vdevId)),
    spareDiskIds: [...layout.spareDiskIds].sort(),
    physicalPathHashes: Object.fromEntries(Object.entries(physicalPathHashes).sort(([left], [right]) => left.localeCompare(right))),
  };
  return hashContent(normalized, { domain: "simulation.logical-layout", schemaVersion: "1.0.0" });
}

const SIMULATION_INPUT_FIELDS = ["workloadMetricRefs", "ambientC", "fanPolicyId", "storageActivity", "placementIds", "routeIds", "modelVersion"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateSimulationModelArtifactValue(value: unknown): string[] {
  if (!isRecord(value)) return ["simulation model artifact must be an object"];
  const errors: string[] = [];
  const fields = ["schemaVersion", "modelId", "modelVersion", "assumptions", "coefficients", "contentHash"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("simulation model artifact contains unknown fields");
  if (value.schemaVersion !== "simulation-model-artifact-v1") errors.push("simulation model artifact schemaVersion invalid");
  if (typeof value.modelId !== "string" || value.modelId.trim().length === 0
    || typeof value.modelVersion !== "string" || value.modelVersion.trim().length === 0) errors.push("simulation model artifact identity invalid");
  if (!Array.isArray(value.assumptions)
    || value.assumptions.some((assumption) => typeof assumption !== "string" || assumption.trim().length === 0)
    || new Set(value.assumptions).size !== value.assumptions.length) errors.push("simulation model artifact assumptions invalid");
  if (!isRecord(value.coefficients) || Object.keys(value.coefficients).length === 0
    || Object.entries(value.coefficients).some(([key, coefficient]) => key.trim().length === 0 || typeof coefficient !== "number" || !Number.isFinite(coefficient))) errors.push("simulation model artifact coefficients invalid");
  if (!isSha256Hex(value.contentHash)) errors.push("simulation model artifact contentHash invalid");
  return errors;
}

/** Strict, total structural validator for the portable simulation-model artifact. */
export function validateSimulationModelArtifact(value: unknown): string[] {
  try {
    return validateSimulationModelArtifactValue(value);
  } catch {
    return ["simulation model artifact validation failed"];
  }
}

export function validateSimulationInput(value: unknown): string[] {
  if (!isRecord(value)) return ["simulation input must be an object"];
  const input = value as unknown as SimulationInput;
  const errors: string[] = [];
  if (!isRecord(value) || Object.keys(value).some((key) => !(SIMULATION_INPUT_FIELDS as readonly string[]).includes(key))) errors.push("simulation input contains unknown fields");
  if (!isRecord(input.ambientC) || !Number.isFinite(input.ambientC.min) || !Number.isFinite(input.ambientC.max) || input.ambientC.min > input.ambientC.max) errors.push("ambientC interval invalid");
  if (typeof input.fanPolicyId !== "string" || !input.fanPolicyId || typeof input.modelVersion !== "string" || !input.modelVersion) errors.push("fan policy and model version are required");
  if (!Array.isArray(input.workloadMetricRefs) || input.workloadMetricRefs.some((ref) => typeof ref !== "string" || !ref) || new Set(input.workloadMetricRefs).size !== input.workloadMetricRefs.length) errors.push("workloadMetricRefs must be non-empty and unique");
  if (!Array.isArray(input.placementIds) || !Array.isArray(input.routeIds)
    || input.placementIds.some((id) => typeof id !== "string" || !id) || input.routeIds.some((id) => typeof id !== "string" || !id)
    || new Set(input.placementIds).size !== input.placementIds.length || new Set(input.routeIds).size !== input.routeIds.length) errors.push("placementIds and routeIds must be non-empty and unique");
  if (!Array.isArray(input.storageActivity) || input.storageActivity.some((activity) => !isRecord(activity) || Object.keys(activity).some((key) => !["logicalLayoutId", "dutyCycle", "concurrentDiskCount"].includes(key)) || !activity.logicalLayoutId || !Number.isFinite(activity.dutyCycle) || activity.dutyCycle < 0 || activity.dutyCycle > 1 || !Number.isInteger(activity.concurrentDiskCount) || activity.concurrentDiskCount < 0 || (activity.dutyCycle > 0 && activity.concurrentDiskCount === 0))) errors.push("storage activity invalid");
  if (Array.isArray(input.storageActivity) && new Set(input.storageActivity.filter(isRecord).map((activity) => activity.logicalLayoutId)).size !== input.storageActivity.length) errors.push("storage activity logicalLayoutId must be unique");
  return errors;
}

export function simulationInputLeafPaths(input: SimulationInput): string[] {
  const indexedOrCollection = (field: "workloadMetricRefs" | "placementIds" | "routeIds", values: readonly string[]) => values.length === 0
    ? [`/${field}`]
    : values.map((_, index) => `/${field}/${index}`);
  const storage = input.storageActivity.length === 0
    ? ["/storageActivity"]
    : input.storageActivity.flatMap((_, index) => [
      `/storageActivity/${index}/logicalLayoutId`,
      `/storageActivity/${index}/dutyCycle`,
      `/storageActivity/${index}/concurrentDiskCount`,
    ]);
  return [
    ...indexedOrCollection("workloadMetricRefs", input.workloadMetricRefs),
    "/ambientC/min", "/ambientC/max", "/fanPolicyId",
    ...storage,
    ...indexedOrCollection("placementIds", input.placementIds),
    ...indexedOrCollection("routeIds", input.routeIds),
    "/modelVersion",
  ];
}

export function validateSimulationInputSources(value: unknown): string[] {
  if (!isRecord(value)) return ["sourced simulation input must be an object"];
  const errors = validateSimulationInput(value.input);
  if (errors.length > 0 || !isRecord(value.input)) return errors;
  if (!Array.isArray(value.sources)) return [...errors, "simulation input sources must be an array"];
  const input = value.input as unknown as SimulationInput;
  const sources = value.sources as unknown[];
  const legalPaths = new Set(simulationInputLeafPaths(input));
  if (sources.some((source) => !isRecord(source)
    || Object.keys(source).some((key) => !["fieldPath", "source", "userOverridable", "sourceRef"].includes(key))
    || source.userOverridable !== true
    || (source.source !== "user" && source.source !== "system_profile_default" && source.source !== "model_default")
    || typeof source.fieldPath !== "string" || !legalPaths.has(source.fieldPath)
    || typeof source.sourceRef !== "string" || !source.sourceRef)) errors.push("every simulation input source must use an exact governed leaf path and remain attributable");
  const sourcePaths = sources.filter(isRecord).map((source) => source.fieldPath).filter((path): path is string => typeof path === "string");
  if (new Set(sourcePaths).size !== sourcePaths.length) errors.push("simulation input source field paths must be unique");
  for (const path of legalPaths) if (!sourcePaths.includes(path)) errors.push(`simulation input source missing: ${path}`);
  return errors;
}

/** Stable attribution helper for what-if: omitted fields are locked, not silently refreshed. */
export function simulationInputChangedFields(before: SimulationInput, after: SimulationInput): string[] {
  return SIMULATION_INPUT_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map((field) => `/${field}`);
}

/**
 * Content-address the exact simulation closure. Price and scenario display
 * metadata are intentionally not parameters; workload/environment/layout and
 * model inputs are all explicit.
 */
export async function createSimulationInputHashClosure(
  sourcedInput: SourcedSimulationInput,
  logicalLayouts: readonly SimulationLogicalLayoutClosure[],
): Promise<SimulationInputHashClosure> {
  if (validateSimulationInputSources(sourcedInput).length > 0) throw new TypeError("simulation input hash closure source validation failed");
  const normalizedInput: SourcedSimulationInput = {
    input: {
      ...structuredClone(sourcedInput.input),
      workloadMetricRefs: [...sourcedInput.input.workloadMetricRefs].sort(),
      storageActivity: [...sourcedInput.input.storageActivity].sort((left, right) => left.logicalLayoutId.localeCompare(right.logicalLayoutId)),
      placementIds: [...sourcedInput.input.placementIds].sort(),
      routeIds: [...sourcedInput.input.routeIds].sort(),
    },
    sources: [...structuredClone(sourcedInput.sources)].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)),
  };
  const normalizedLayouts = [...structuredClone(logicalLayouts)].sort((left, right) => left.logicalLayoutId.localeCompare(right.logicalLayoutId));
  if (new Set(normalizedLayouts.map(({ logicalLayoutId }) => logicalLayoutId)).size !== normalizedLayouts.length
    || normalizedLayouts.some(({ logicalLayoutId, layoutHash }) => !logicalLayoutId || !/^[a-f0-9]{64}$/.test(layoutHash))) {
    throw new TypeError("simulation logical layout closure invalid");
  }
  for (const { logicalLayoutId } of normalizedInput.input.storageActivity) {
    if (!normalizedLayouts.some((layout) => layout.logicalLayoutId === logicalLayoutId)) {
      throw new TypeError("simulation activity lacks an exact logical layout hash");
    }
  }
  const material = { schemaVersion: "simulation-input-hash-closure-v1" as const, sourcedInput: normalizedInput, logicalLayouts: normalizedLayouts };
  return { ...material, contentHash: await hashContent(material, { domain: "simulation.input", schemaVersion: "1.0.0" }) };
}

/** Strict structural validation for persisted/replayed simulation input closures. */
export function validateSimulationInputHashClosure(value: unknown): string[] {
  try {
    if (!isRecord(value)) return ["simulation input hash closure must be an object"];
    const errors: string[] = [];
    if (Object.keys(value).length !== SIMULATION_INPUT_HASH_CLOSURE_FIELDS.length
      || Object.keys(value).some((key) => !(SIMULATION_INPUT_HASH_CLOSURE_FIELDS as readonly string[]).includes(key))) {
      errors.push("simulation input hash closure fields invalid");
    }
    if (value.schemaVersion !== "simulation-input-hash-closure-v1") errors.push("simulation input hash closure schemaVersion invalid");
    errors.push(...validateSimulationInputSources(value.sourcedInput));
    if (!Array.isArray(value.logicalLayouts)
      || value.logicalLayouts.some((layout) => !isRecord(layout)
        || Object.keys(layout).length !== 2
        || Object.keys(layout).some((key) => !["logicalLayoutId", "layoutHash"].includes(key))
        || typeof layout.logicalLayoutId !== "string" || layout.logicalLayoutId.length === 0
        || !isSha256Hex(layout.layoutHash))) errors.push("simulation logical layout closure invalid");
    else {
      const ids = value.logicalLayouts.map((layout) => (layout as { logicalLayoutId: string }).logicalLayoutId);
      if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
        errors.push("simulation logical layouts must be unique and canonical");
      }
      if (isRecord(value.sourcedInput) && isRecord(value.sourcedInput.input)
        && Array.isArray(value.sourcedInput.input.storageActivity)) {
        const activeIds = value.sourcedInput.input.storageActivity.flatMap((activity) => isRecord(activity)
          && typeof activity.logicalLayoutId === "string" ? [activity.logicalLayoutId] : []);
        if (activeIds.some((id) => !ids.includes(id))) errors.push("simulation activity lacks an exact logical layout hash");
      }
    }
    if (!isSha256Hex(value.contentHash)) errors.push("simulation input hash closure contentHash invalid");
    return errors;
  } catch {
    return ["simulation input hash closure validation failed"];
  }
}

/** Recomputes canonical ordering and content identity; no caller-declared hash is trusted. */
export async function verifySimulationInputHashClosure(value: unknown): Promise<boolean> {
  if (validateSimulationInputHashClosure(value).length > 0) return false;
  const closure = value as unknown as SimulationInputHashClosure;
  const rebuilt = await createSimulationInputHashClosure(closure.sourcedInput, closure.logicalLayouts);
  return JSON.stringify(rebuilt) === JSON.stringify(closure);
}
