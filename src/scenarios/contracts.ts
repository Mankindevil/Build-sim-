import { isSnapshotHashes, type SnapshotHashes } from "../hash";
import {
  validateGovernedPatchOperation,
  type SimulationJsonPatchPath,
  type PatchValidationContext,
  type TopologyV3PatchOperation,
} from "../contracts/registries";

export type SimulationJsonPatchOperation =
  | { op: "add" | "replace"; path: SimulationJsonPatchPath; value: unknown }
  | { op: "remove"; path: SimulationJsonPatchPath };

/** Stable-selector V3 operation; deliberately not RFC 6902/JSON Pointer. */
export type TopologyV3StablePatchOperation = TopologyV3PatchOperation;

/** Backward-compatible name for callers that only patch simulation input. */
export type JsonPatchOperation = SimulationJsonPatchOperation;

export interface ScenarioBranch {
  scenarioId: string;
  familyId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  patch: TopologyV3StablePatchOperation[];
  simulationInputPatch?: SimulationJsonPatchOperation[];
}

export interface WhatIfResult {
  scenarioId: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  decisionDiffRef: string;
  domainDiffRefs: string[];
  snapshotAttribution: "same_snapshots" | "refreshed";
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
