import { isSnapshotHashes, type SnapshotHashes } from "../hash";
import {
  validateGovernedPatchOperation,
  type SimulationJsonPatchPath,
  type PatchActor,
  type PatchValidationContext,
  type TopologyV3PatchOperation,
} from "../contracts/registries";
import { isScenarioArtifactReference, validateScenarioPatchAuthority } from "./runtime-validation.mjs";

export type SimulationJsonPatchOperation =
  | { op: "add" | "replace"; path: SimulationJsonPatchPath; value: unknown }
  | { op: "remove"; path: SimulationJsonPatchPath };

/** Stable-selector V3 operation; deliberately not RFC 6902/JSON Pointer. */
export type TopologyV3StablePatchOperation = TopologyV3PatchOperation;

/** Backward-compatible name for callers that only patch simulation input. */
export type JsonPatchOperation = SimulationJsonPatchOperation;

export const SCENARIO_SCHEMA_VERSION = "1.0.0" as const;

export interface ScenarioFamily {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  familyId: string;
  planId: string;
  name: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioBranch {
  scenarioId: string;
  familyId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  patch: TopologyV3StablePatchOperation[];
  simulationInputPatch?: SimulationJsonPatchOperation[];
}

/** Repository-only metadata. The actor is integrity-bound so reads cannot
 * silently reinterpret an Agent-created patch with user privileges. */
export interface PersistedScenarioBranch extends ScenarioBranch {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  createdByActor: PatchActor;
  createdAt: string;
  patchHash: string;
  materializedConfigHash: string;
}

export interface WhatIfResult {
  scenarioId: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  decisionDiffRef: string;
  domainDiffRefs: string[];
  snapshotAttribution: "same_snapshots" | "refreshed";
}

export interface PersistedWhatIfResult extends WhatIfResult {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  createdAt: string;
  beforeConfigHash: string;
  afterConfigHash: string;
  patchHash: string;
}

export interface WhatIfSnapshotComparison {
  attribution: WhatIfResult["snapshotAttribution"];
  changedSnapshotFields: Array<keyof SnapshotHashes>;
}

export function compareWhatIfSnapshots(before: SnapshotHashes, after: SnapshotHashes): WhatIfSnapshotComparison {
  const fields = Object.keys(before) as Array<keyof SnapshotHashes>;
  const changedSnapshotFields = fields.filter((field) => before[field] !== after[field]);
  return {
    attribution: changedSnapshotFields.length === 0 ? "same_snapshots" : "refreshed",
    changedSnapshotFields,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function governedReference(value: unknown): value is string {
  return typeof value === "string" && isScenarioArtifactReference(value);
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateScenarioFamily(value: unknown): string[] {
  if (!isRecord(value)) return ["scenario family must be an object"];
  const errors: string[] = [];
  const fields = ["schemaVersion", "familyId", "planId", "name", "basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "createdAt", "updatedAt"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("scenario family contains topology, branch data or unknown fields");
  if (value.schemaVersion !== SCENARIO_SCHEMA_VERSION) errors.push("scenario family schemaVersion invalid");
  for (const field of ["familyId", "planId", "name", "basePlanVersionId"] as const) {
    if (!nonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (!sha256(value.baseConfigHash)) errors.push("baseConfigHash must be a sha256 digest");
  if (!isSnapshotHashes(value.baseSnapshotHashes)) errors.push("baseSnapshotHashes invalid");
  else if (value.baseConfigHash !== value.baseSnapshotHashes.configHash) errors.push("baseConfigHash must match baseSnapshotHashes.configHash");
  if (!isoTimestamp(value.createdAt) || !isoTimestamp(value.updatedAt)) errors.push("scenario family timestamps invalid");
  if (isoTimestamp(value.createdAt) && isoTimestamp(value.updatedAt) && value.updatedAt < value.createdAt) errors.push("scenario family updatedAt precedes createdAt");
  return errors;
}

/** Strict persisted branch validator; applying the patch still requires final BuildConfigV3 validation. */
export function validateScenarioBranch(value: unknown, context: PatchValidationContext = { actor: "user" }): string[] {
  if (!isRecord(value)) return ["scenario branch must be an object"];
  const errors: string[] = [];
  const allowedFields = ["scenarioId", "familyId", "basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "patch", "simulationInputPatch"];
  if (Object.keys(value).some((key) => !allowedFields.includes(key))) errors.push("scenario branch contains topology, evaluation or unknown fields");
  for (const field of ["scenarioId", "familyId", "basePlanVersionId", "baseConfigHash"] as const) {
    if (!nonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (!isSnapshotHashes(value.baseSnapshotHashes)) errors.push("baseSnapshotHashes invalid");
  else if (value.baseConfigHash !== value.baseSnapshotHashes.configHash) errors.push("baseConfigHash must match baseSnapshotHashes.configHash");

  if (!Array.isArray(value.patch)) errors.push("patch must be an array");
  else value.patch.forEach((operation, index) => {
    errors.push(...validateGovernedPatchOperation("plan-v3", operation, context).map((error) => `patch.${index}: ${error}`));
  });
  if (value.simulationInputPatch !== undefined) {
    if (!Array.isArray(value.simulationInputPatch)) errors.push("simulationInputPatch must be an array");
    else value.simulationInputPatch.forEach((operation, index) => {
      errors.push(...validateGovernedPatchOperation("simulation", operation).map((error) => `simulationInputPatch.${index}: ${error}`));
    });
  }
  if (Array.isArray(value.patch) && value.patch.length === 0
    && (!Array.isArray(value.simulationInputPatch) || value.simulationInputPatch.length === 0)) {
    errors.push("scenario branch must contain at least one governed patch operation");
  }
  return errors;
}

export function validatePersistedScenarioBranch(value: unknown): string[] {
  if (!isRecord(value)) return ["persisted scenario branch must be an object"];
  const persistedFields = ["schemaVersion", "createdByActor", "createdAt", "patchHash", "materializedConfigHash"];
  const branch = Object.fromEntries(Object.entries(value).filter(([key]) => !persistedFields.includes(key)));
  const errors: string[] = [];
  if (Object.keys(value).some((key) => ![
    "schemaVersion", "createdByActor", "createdAt", "patchHash", "materializedConfigHash", "scenarioId", "familyId", "basePlanVersionId",
    "baseConfigHash", "baseSnapshotHashes", "patch", "simulationInputPatch",
  ].includes(key))) errors.push("persisted scenario branch contains unknown fields");
  if (value.schemaVersion !== SCENARIO_SCHEMA_VERSION) errors.push("persisted scenario branch schemaVersion invalid");
  if (!(["user", "agent", "solver", "system"] as const).includes(value.createdByActor as PatchActor)) {
    errors.push("persisted scenario branch actor invalid");
  }
  if (!isoTimestamp(value.createdAt)) errors.push("persisted scenario branch createdAt invalid");
  if (!sha256(value.patchHash) || !sha256(value.materializedConfigHash)) errors.push("persisted scenario branch hashes invalid");
  const actor: PatchActor = (["user", "agent", "solver", "system"] as const).includes(value.createdByActor as PatchActor)
    ? value.createdByActor as PatchActor : "system";
  errors.push(...validateScenarioBranch(branch, { actor }));
  errors.push(...validateScenarioPatchAuthority(value.patch, value.simulationInputPatch, actor));
  return errors;
}

export function validateWhatIfResult(value: unknown): string[] {
  if (!isRecord(value)) return ["what-if result must be an object"];
  const errors: string[] = [];
  const fields = ["scenarioId", "beforeEvaluationHash", "afterEvaluationHash", "decisionDiffRef", "domainDiffRefs", "snapshotAttribution"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("what-if result contains topology, mutable plan data or unknown fields");
  if (!nonEmptyString(value.scenarioId) || !governedReference(value.decisionDiffRef)) errors.push("what-if result identity or governed decision diff missing");
  if (!sha256(value.beforeEvaluationHash) || !sha256(value.afterEvaluationHash)) errors.push("what-if evaluation hashes invalid");
  if (!Array.isArray(value.domainDiffRefs)
    || value.domainDiffRefs.some((ref) => !governedReference(ref))
    || new Set(value.domainDiffRefs).size !== value.domainDiffRefs.length) errors.push("what-if domain diff refs invalid");
  if (value.snapshotAttribution !== "same_snapshots" && value.snapshotAttribution !== "refreshed") errors.push("what-if snapshot attribution invalid");
  return errors;
}

export function validatePersistedWhatIfResult(value: unknown): string[] {
  if (!isRecord(value)) return ["persisted what-if result must be an object"];
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !["schemaVersion", "createdAt", "beforeConfigHash", "afterConfigHash", "patchHash"].includes(key)));
  const errors: string[] = [];
  if (Object.keys(value).some((key) => ![
    "schemaVersion", "createdAt", "beforeConfigHash", "afterConfigHash", "patchHash", "scenarioId", "beforeEvaluationHash", "afterEvaluationHash",
    "decisionDiffRef", "domainDiffRefs", "snapshotAttribution",
  ].includes(key))) errors.push("persisted what-if result contains unknown fields");
  if (value.schemaVersion !== SCENARIO_SCHEMA_VERSION) errors.push("persisted what-if result schemaVersion invalid");
  if (!isoTimestamp(value.createdAt)) errors.push("persisted what-if result createdAt invalid");
  if (!sha256(value.beforeConfigHash) || !sha256(value.afterConfigHash) || !sha256(value.patchHash)) errors.push("persisted what-if config/patch hashes invalid");
  errors.push(...validateWhatIfResult(result));
  return errors;
}
