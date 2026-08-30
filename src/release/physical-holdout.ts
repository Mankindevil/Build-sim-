import { canonicalize, sha256Hex } from "../hash";

export const PHYSICAL_HOLDOUT_SCHEMA_VERSION = "physical-holdout-v1" as const;
export const PHYSICAL_HOLDOUT_LAYOUTS = Object.freeze(["atx", "mini_itx", "nas"] as const);

export type PhysicalHoldoutLayout = (typeof PHYSICAL_HOLDOUT_LAYOUTS)[number];

export interface HoldoutRange {
  lo: number;
  hi: number;
}

export interface HoldoutMeasurementMethod {
  protocolId: string;
  instrumentId: string;
  instrumentCalibrationRef: string;
  operatorId: string;
  capturedAt: string;
}

export interface PhysicalHoldoutMaterial {
  schemaVersion: typeof PHYSICAL_HOLDOUT_SCHEMA_VERSION;
  holdoutId: string;
  layout: PhysicalHoldoutLayout;
  tuningStatus: "not_used_for_tuning";
  caseIdentity: {
    skuId: string;
    modelId: string;
    revision: string;
    region: string;
  };
  authority: {
    planId: string;
    planVersionId: string;
    configHash: string;
    evaluationHash: string;
    adapterSnapshotHash: string;
    simulationInputHash: string;
  };
  method: HoldoutMeasurementMethod;
  measurements: {
    clearances: Array<{
      measurementId: string;
      instanceId: string;
      referenceId: string;
      predictedMm: HoldoutRange;
      measuredMm: number;
      uncertaintyMm: number;
    }>;
    cableLengths: Array<{
      measurementId: string;
      cableInstanceId: string;
      fromEndpointId: string;
      toEndpointId: string;
      suggestedMm: number;
      measuredRequiredMm: number;
      uncertaintyMm: number;
    }>;
    temperatures: Array<{
      measurementId: string;
      componentInstanceId: string;
      workloadId: string;
      ambientC: number;
      predictedC: HoldoutRange;
      measuredC: number;
      uncertaintyC: number;
    }>;
    acoustics: Array<{
      measurementId: string;
      sourceInstanceId: string;
      workloadId: string;
      testMethodId: string;
      referenceDistanceM: 1;
      predictedDba: HoldoutRange;
      measuredDba: number;
      uncertaintyDba: number;
    }>;
  };
}

export interface PhysicalHoldoutDataset extends PhysicalHoldoutMaterial {
  contentHash: string;
}

export interface PhysicalHoldoutReleaseReport {
  schemaVersion: "physical-holdout-release-report-v1";
  status: "pass" | "blocked";
  datasetHashes: string[];
  layouts: PhysicalHoldoutLayout[];
  errors: string[];
}

const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,199}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function finite(value: unknown, minimum = Number.NEGATIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validRange(value: unknown): value is HoldoutRange {
  return record(value) && exact(value, ["lo", "hi"])
    && finite(value.lo) && finite(value.hi) && value.lo <= value.hi;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function validateMethod(value: unknown): string[] {
  if (!record(value) || !exact(value, ["protocolId", "instrumentId", "instrumentCalibrationRef", "operatorId", "capturedAt"])) {
    return ["holdout method fields are invalid"];
  }
  const errors: string[] = [];
  for (const field of ["protocolId", "instrumentId", "instrumentCalibrationRef", "operatorId"] as const) {
    if (!validToken(value[field])) errors.push(`holdout method ${field} is invalid`);
  }
  if (!iso(value.capturedAt)) errors.push("holdout method capturedAt is invalid");
  return errors;
}

function validateMeasurementIds(groups: ReadonlyArray<readonly unknown[]>): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const entry of group) if (record(entry) && typeof entry.measurementId === "string") ids.push(entry.measurementId);
  }
  if (ids.some((id) => !validToken(id))) return ["holdout measurement ID is invalid"];
  return new Set(ids).size === ids.length ? [] : ["holdout measurement IDs must be globally unique"];
}

function validateMeasurements(value: unknown): string[] {
  if (!record(value) || !exact(value, ["clearances", "cableLengths", "temperatures", "acoustics"])) {
    return ["holdout measurement groups are invalid"];
  }
  const errors: string[] = [];
  const arrays = [value.clearances, value.cableLengths, value.temperatures, value.acoustics];
  if (arrays.some((entries) => !Array.isArray(entries) || entries.length === 0)) {
    return ["holdout requires clearance, cable, temperature, and acoustic measurements"];
  }
  const clearances = value.clearances as unknown[];
  const cableLengths = value.cableLengths as unknown[];
  const temperatures = value.temperatures as unknown[];
  const acoustics = value.acoustics as unknown[];
  errors.push(...validateMeasurementIds([clearances, cableLengths, temperatures, acoustics]));
  for (const entry of clearances) {
    if (!record(entry) || !exact(entry, ["measurementId", "instanceId", "referenceId", "predictedMm", "measuredMm", "uncertaintyMm"])
      || !validToken(entry.measurementId) || !validToken(entry.instanceId) || !validToken(entry.referenceId)
      || !validRange(entry.predictedMm) || !finite(entry.measuredMm, 0) || !finite(entry.uncertaintyMm, 0)) {
      errors.push("holdout clearance measurement is invalid");
      continue;
    }
    if (entry.measuredMm - entry.uncertaintyMm < entry.predictedMm.lo
      || entry.measuredMm + entry.uncertaintyMm > entry.predictedMm.hi) {
      errors.push(`holdout clearance ${entry.measurementId} is outside the predicted interval`);
    }
  }
  for (const entry of cableLengths) {
    if (!record(entry) || !exact(entry, ["measurementId", "cableInstanceId", "fromEndpointId", "toEndpointId", "suggestedMm", "measuredRequiredMm", "uncertaintyMm"])
      || !validToken(entry.measurementId) || !validToken(entry.cableInstanceId)
      || !validToken(entry.fromEndpointId) || !validToken(entry.toEndpointId)
      || !finite(entry.suggestedMm, 0) || !finite(entry.measuredRequiredMm, 0) || !finite(entry.uncertaintyMm, 0)) {
      errors.push("holdout cable-length measurement is invalid");
      continue;
    }
    if (entry.suggestedMm < entry.measuredRequiredMm + entry.uncertaintyMm) {
      errors.push(`holdout cable ${entry.measurementId} is shorter than the measured requirement`);
    }
  }
  for (const entry of temperatures) {
    if (!record(entry) || !exact(entry, ["measurementId", "componentInstanceId", "workloadId", "ambientC", "predictedC", "measuredC", "uncertaintyC"])
      || !validToken(entry.measurementId) || !validToken(entry.componentInstanceId) || !validToken(entry.workloadId)
      || !finite(entry.ambientC) || !validRange(entry.predictedC) || !finite(entry.measuredC) || !finite(entry.uncertaintyC, 0)) {
      errors.push("holdout temperature measurement is invalid");
      continue;
    }
    if (entry.measuredC - entry.uncertaintyC < entry.predictedC.lo
      || entry.measuredC + entry.uncertaintyC > entry.predictedC.hi) {
      errors.push(`holdout temperature ${entry.measurementId} is outside the predicted interval`);
    }
  }
  for (const entry of acoustics) {
    if (!record(entry) || !exact(entry, ["measurementId", "sourceInstanceId", "workloadId", "testMethodId", "referenceDistanceM", "predictedDba", "measuredDba", "uncertaintyDba"])
      || !validToken(entry.measurementId) || !validToken(entry.sourceInstanceId)
      || !validToken(entry.workloadId) || !validToken(entry.testMethodId) || entry.referenceDistanceM !== 1
      || !validRange(entry.predictedDba) || !finite(entry.measuredDba, 0) || !finite(entry.uncertaintyDba, 0)) {
      errors.push("holdout acoustic measurement is invalid");
      continue;
    }
    if (entry.measuredDba - entry.uncertaintyDba < entry.predictedDba.lo
      || entry.measuredDba + entry.uncertaintyDba > entry.predictedDba.hi) {
      errors.push(`holdout acoustic ${entry.measurementId} is outside the predicted interval`);
    }
  }
  return errors;
}

export async function createPhysicalHoldoutDataset(material: PhysicalHoldoutMaterial): Promise<PhysicalHoldoutDataset> {
  const contentHash = await sha256Hex(`buildsim\0${PHYSICAL_HOLDOUT_SCHEMA_VERSION}\0${canonicalize(material)}`);
  return { ...structuredClone(material), contentHash };
}

export async function validatePhysicalHoldoutDataset(value: unknown): Promise<string[]> {
  if (!record(value) || !exact(value, ["schemaVersion", "holdoutId", "layout", "tuningStatus", "caseIdentity", "authority", "method", "measurements", "contentHash"])) {
    return ["holdout dataset fields are invalid"];
  }
  const errors: string[] = [];
  if (value.schemaVersion !== PHYSICAL_HOLDOUT_SCHEMA_VERSION) errors.push("holdout schemaVersion is invalid");
  if (!validToken(value.holdoutId)) errors.push("holdout ID is invalid");
  if (!PHYSICAL_HOLDOUT_LAYOUTS.includes(value.layout as PhysicalHoldoutLayout)) errors.push("holdout layout is invalid");
  if (value.tuningStatus !== "not_used_for_tuning") errors.push("holdout was used for tuning");
  if (!record(value.caseIdentity) || !exact(value.caseIdentity, ["skuId", "modelId", "revision", "region"])
    || [value.caseIdentity.skuId, value.caseIdentity.modelId, value.caseIdentity.revision, value.caseIdentity.region].some((entry) => !validToken(entry))) {
    errors.push("holdout case identity is invalid");
  }
  if (!record(value.authority) || !exact(value.authority, ["planId", "planVersionId", "configHash", "evaluationHash", "adapterSnapshotHash", "simulationInputHash"])
    || !validToken(value.authority.planId) || !validToken(value.authority.planVersionId)
    || [value.authority.configHash, value.authority.evaluationHash, value.authority.adapterSnapshotHash, value.authority.simulationInputHash]
      .some((entry) => typeof entry !== "string" || !HASH.test(entry))) {
    errors.push("holdout authority closure is invalid");
  }
  errors.push(...validateMethod(value.method), ...validateMeasurements(value.measurements));
  if (typeof value.contentHash !== "string" || !HASH.test(value.contentHash)) errors.push("holdout contentHash is invalid");
  else {
    const { contentHash: _contentHash, ...material } = value;
    const expected = await createPhysicalHoldoutDataset(material as unknown as PhysicalHoldoutMaterial);
    if (expected.contentHash !== value.contentHash) errors.push("holdout contentHash mismatch");
  }
  return [...new Set(errors)].sort();
}

export async function validatePhysicalHoldoutReleaseSet(values: readonly unknown[]): Promise<PhysicalHoldoutReleaseReport> {
  const errors: string[] = [];
  const valid: PhysicalHoldoutDataset[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const entryErrors = await validatePhysicalHoldoutDataset(values[index]);
    if (entryErrors.length) errors.push(...entryErrors.map((error) => `dataset ${index}: ${error}`));
    else valid.push(structuredClone(values[index]) as PhysicalHoldoutDataset);
  }
  const ids = valid.map(({ holdoutId }) => holdoutId);
  if (new Set(ids).size !== ids.length) errors.push("holdout IDs must be unique");
  const hashes = valid.map(({ contentHash }) => contentHash);
  if (new Set(hashes).size !== hashes.length) errors.push("holdout dataset hashes must be unique");
  const layouts = [...new Set(valid.map(({ layout }) => layout))].sort() as PhysicalHoldoutLayout[];
  for (const layout of PHYSICAL_HOLDOUT_LAYOUTS) if (!layouts.includes(layout)) errors.push(`missing independent ${layout} holdout`);
  return {
    schemaVersion: "physical-holdout-release-report-v1",
    status: errors.length === 0 ? "pass" : "blocked",
    datasetHashes: hashes.sort(),
    layouts,
    errors: [...new Set(errors)].sort(),
  };
}
