import { parseConfig, type BuildConfig } from "../config/types";
import {
  PLAN_PATCH_PATHS,
  PLAN_SCHEMA_VERSION,
  type BuildPlan,
  type BuildTask,
  type PlanAgentContext,
  type PlanChangeProposal,
  type PlanDraft,
  type PlanEvaluationSnapshot,
  type PlanPatchOperation,
  type PlanTransactionLink,
  type PlanVersion,
} from "./contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{64}$/;
const patchPaths = new Set<string>(PLAN_PATCH_PATHS);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "string" || !String(input[key]).trim()) errors.push(`${key} must be a non-empty string`);
}

function isoDate(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "string" || !ISO_DATE.test(String(input[key]))) errors.push(`${key} must be an ISO UTC date`);
}

function schema(input: Record<string, unknown>, errors: string[]): void {
  if (input.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
}

function validConfig(value: unknown): value is BuildConfig {
  try {
    parseConfig(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function validatePlanDraft(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["draft must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  if (input.baseVersionId !== null && (typeof input.baseVersionId !== "string" || !input.baseVersionId)) errors.push("baseVersionId invalid");
  if (!validConfig(input.config)) errors.push("config must be a valid BuildConfig");
  if (typeof input.dirty !== "boolean") errors.push("dirty must be boolean");
  isoDate(input, "updatedAt", errors);
  return errors;
}

export function validateBuildPlan(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["plan must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  requiredString(input, "id", errors);
  requiredString(input, "name", errors);
  if (input.status !== "active" && input.status !== "archived") errors.push("status invalid");
  isoDate(input, "createdAt", errors);
  isoDate(input, "updatedAt", errors);
  if (input.activeVersionId !== null && (typeof input.activeVersionId !== "string" || !input.activeVersionId)) errors.push("activeVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  errors.push(...validatePlanDraft(input.draft).map((error) => `draft.${error}`));
  if (!record(input.metadata)) errors.push("metadata must be an object");
  return errors;
}

export function validatePlanVersion(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["version must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["id", "planId"]) requiredString(input, key, errors);
  if (!Number.isSafeInteger(input.versionNumber) || Number(input.versionNumber) < 1) errors.push("versionNumber invalid");
  isoDate(input, "createdAt", errors);
  if (!["initial", "manual-save", "agent-proposal", "import", "restore"].includes(String(input.reason))) errors.push("reason invalid");
  if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 500)) errors.push("summary invalid");
  if (!validConfig(input.config)) errors.push("config must be a valid BuildConfig");
  if (typeof input.configHash !== "string" || !HASH.test(input.configHash)) errors.push("configHash must be a sha256 hex digest");
  if (input.evaluationHash !== undefined && (typeof input.evaluationHash !== "string" || !HASH.test(input.evaluationHash))) errors.push("evaluationHash invalid");
  if (input.evaluatedAt !== undefined) isoDate(input, "evaluatedAt", errors);
  if (input.parentVersionId !== null && (typeof input.parentVersionId !== "string" || !input.parentVersionId)) errors.push("parentVersionId invalid");
  return errors;
}

export function validatePlanEvaluationSnapshot(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["evaluation snapshot must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  requiredString(input, "planId", errors);
  if (input.planVersionId !== null && (typeof input.planVersionId !== "string" || !input.planVersionId)) errors.push("planVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  for (const key of ["configHash", "evaluationHash"]) {
    if (typeof input[key] !== "string" || !HASH.test(input[key])) errors.push(`${key} invalid`);
  }
  isoDate(input, "evaluatedAt", errors);
  if (!record(input.evaluation)) errors.push("evaluation must be an object");
  return errors;
}

export function validatePlanAgentContext(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["agent context must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  requiredString(input, "planId", errors);
  if (input.planVersionId !== null && (typeof input.planVersionId !== "string" || !input.planVersionId)) errors.push("planVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  for (const key of ["configHash", "evaluationHash"]) {
    if (typeof input[key] !== "string" || !HASH.test(input[key])) errors.push(`${key} invalid`);
  }
  if (!validConfig(input.buildConfig)) errors.push("buildConfig must be a valid BuildConfig");
  if (!record(input.evaluation)) errors.push("evaluation must be an object");
  const selection = input.spatialSelection;
  if (selection !== undefined && selection !== null) {
    const spatial = record(selection);
    if (!spatial || typeof spatial.partId !== "string" || !spatial.partId || typeof spatial.view !== "string" || !spatial.view) errors.push("spatialSelection invalid");
  }
  if ("spatialViewContext" in input && input.spatialViewContext !== null && !record(input.spatialViewContext)) errors.push("spatialViewContext invalid");
  if (!("purchaseSummary" in input)) errors.push("purchaseSummary missing");
  if (!("buildTaskSummary" in input)) errors.push("buildTaskSummary missing");
  return errors;
}

export function validatePlanPatchOperation(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["operation must be an object"];
  const errors: string[] = [];
  if (input.op !== "add" && input.op !== "replace" && input.op !== "remove") errors.push("operation op invalid");
  if (typeof input.path !== "string" || !patchPaths.has(input.path)) errors.push("operation path is not allowlisted");
  if ((input.op === "add" || input.op === "replace") && !("value" in input)) errors.push("operation value missing");
  if (input.op === "remove" && "value" in input) errors.push("remove operation cannot contain value");
  return errors;
}

export function validatePlanChangeProposal(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["proposal must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["id", "planId", "summary"]) requiredString(input, key, errors);
  if (!Number.isSafeInteger(input.expectedDraftRevision) || Number(input.expectedDraftRevision) < 0) errors.push("expectedDraftRevision invalid");
  if (typeof input.expectedConfigHash !== "string" || !HASH.test(input.expectedConfigHash)) errors.push("expectedConfigHash invalid");
  isoDate(input, "createdAt", errors);
  if (!Array.isArray(input.rationale) || input.rationale.some((item) => typeof item !== "string")) errors.push("rationale invalid");
  if (!Array.isArray(input.operations) || input.operations.length === 0) errors.push("operations must not be empty");
  else input.operations.forEach((operation, index) => errors.push(...validatePlanPatchOperation(operation).map((error) => `operations.${index}.${error}`)));
  if (!["proposed", "applied", "rejected", "stale"].includes(String(input.status))) errors.push("status invalid");
  return errors;
}

export function validatePlanTransactionLink(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["transaction link must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["planId", "planVersionIdAtCapture", "planItemId"]) {
    if (input[key] !== null && (typeof input[key] !== "string" || !input[key])) errors.push(`${key} invalid`);
  }
  if (!["linked", "unlinked", "stale"].includes(String(input.linkStatus))) errors.push("linkStatus invalid");
  if (input.linkStatus === "linked" && (!input.planId || !input.planItemId)) errors.push("linked transaction requires planId and planItemId");
  return errors;
}

export function validateBuildTask(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["task must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["id", "planId", "sourceVersionId", "sourceRef", "title"]) requiredString(input, key, errors);
  if (!["purchase", "assembly", "wiring", "verification"].includes(String(input.kind))) errors.push("kind invalid");
  if (!["todo", "doing", "done", "blocked", "obsolete"].includes(String(input.status))) errors.push("status invalid");
  if (input.statusSource !== undefined && input.statusSource !== "derived" && input.statusSource !== "manual") errors.push("statusSource invalid");
  if (input.order !== undefined && (!Number.isSafeInteger(input.order) || Number(input.order) < 0)) errors.push("order invalid");
  if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.some((item) => typeof item !== "string" || !item))) errors.push("dependsOn invalid");
  for (const key of ["relatedPartId", "cableId", "findingId", "note", "staleReason"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") errors.push(`${key} invalid`);
  }
  if (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((item) => typeof item !== "string" || !item))) errors.push("evidenceRefs invalid");
  for (const key of ["updatedAt", "completedAt"]) if (input[key] !== undefined) isoDate(input, key, errors);
  return errors;
}

export function assertValidBuildPlan(value: unknown): asserts value is BuildPlan {
  const errors = validateBuildPlan(value);
  if (errors.length) throw new Error(`Invalid BuildPlan: ${errors.join("; ")}`);
}

export function assertValidPlanVersion(value: unknown): asserts value is PlanVersion {
  const errors = validatePlanVersion(value);
  if (errors.length) throw new Error(`Invalid PlanVersion: ${errors.join("; ")}`);
}

export function assertValidPlanChangeProposal(value: unknown): asserts value is PlanChangeProposal {
  const errors = validatePlanChangeProposal(value);
  if (errors.length) throw new Error(`Invalid PlanChangeProposal: ${errors.join("; ")}`);
}

export function assertValidPlanEvaluationSnapshot(value: unknown): asserts value is PlanEvaluationSnapshot {
  const errors = validatePlanEvaluationSnapshot(value);
  if (errors.length) throw new Error(`Invalid PlanEvaluationSnapshot: ${errors.join("; ")}`);
}

export function assertValidPlanAgentContext(value: unknown): asserts value is PlanAgentContext {
  const errors = validatePlanAgentContext(value);
  if (errors.length) throw new Error(`Invalid PlanAgentContext: ${errors.join("; ")}`);
}

export type ValidatedPlanTypes = BuildPlan | PlanDraft | PlanVersion | PlanChangeProposal | PlanPatchOperation | PlanTransactionLink | BuildTask;
