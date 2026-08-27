import {
  validateFacetPredicate,
  validateRequirementMetric,
  type GovernedFacetPredicate,
  type GovernedRequirementMetric,
} from "../contracts/registries";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";

export type MachineIntent = "pc" | "workstation" | "nas";
export type RequirementDraftSource = "user" | "defaulted" | "agent_proposed";

export type RequirementDraftField<T> =
  | { state: "answered"; value: T; source: RequirementDraftSource; confirmedByUser: boolean }
  | { state: "deferred"; value?: never; source: RequirementDraftSource; confirmedByUser: boolean }
  | { state: "not_applicable"; value?: never; source: RequirementDraftSource; confirmedByUser: boolean };

export interface RequirementMetric extends GovernedRequirementMetric {
  /** Optional only for migration compatibility; absence is never treated as confirmation. */
  readonly source?: "user" | "migration" | "agent_proposed";
  readonly confirmedByUser?: boolean;
}
export type FacetPredicate = GovernedFacetPredicate;

export interface RequirementBudget {
  targetCny?: number;
  hardCapCny?: number;
  reserveCny?: number;
}

export interface WorkloadRequirement {
  workloadId: string;
  name: string;
  metrics: RequirementMetric[];
  evidenceOrBenchmarkRefs?: string[];
}

export interface RequirementConstraint {
  constraintId: string;
  predicate: FacetPredicate;
  strength: "hard" | "soft";
  source: "user" | "migration" | "agent_proposed";
  confirmedByUser: boolean;
}

/** Persisted user goals. Evaluator-created RequirementNode records never belong here. */
export interface RequirementSpec {
  requirementSpecId: string;
  schemaVersion: "1.0.0";
  budget?: RequirementDraftField<RequirementBudget>;
  workloads: WorkloadRequirement[];
  constraints: RequirementConstraint[];
  horizonYears?: RequirementDraftField<number>;
}

export type RequirementKind =
  | "component"
  | "accessory"
  | "fastener"
  | "cable"
  | "consumable"
  | "tool"
  | "evidence"
  | "measurement"
  | "firmware_action"
  | "system_action"
  | "user_decision";

/** A derived evaluator gap. This is deliberately not a RequirementSpec member. */
export interface RequirementNode {
  requirementId: string;
  kind: RequirementKind;
  predicates: FacetPredicate[];
  quantity: number;
  criticality: "normal" | "boot" | "safety";
  requiredBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
  producedBy: { ruleId: string; ruleVersion: string; instanceIds: string[] };
  evidenceRefs: string[];
}

export interface RequirementAllocation {
  source: "component" | "package_content" | "user_resource" | "purchase";
  refId: string;
  ownerInstanceId?: string;
  quantity: number;
  availability: "planned" | "ordered" | "present_verified";
  verificationStatus: "unverified" | "verified";
  satisfiesBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
  evidenceRefs: string[];
  observationRefs: string[];
}

export interface RequirementSatisfaction {
  requirementId: string;
  status: "open" | "satisfied" | "blocked";
  allocations: RequirementAllocation[];
  residualQuantity: number;
}

/**
 * A safety checkpoint is an audited confirmation, never a caller supplied boolean.
 * Its hashes bind the confirmation to one plan/procedure dependency state.
 */
export interface SafetyCheckpointRecord {
  checkpointId: string;
  requirementId: string;
  planVersionId: string;
  procedureId: string;
  dependencyHash: string;
  procedureSafetyHash: string;
  confirmedAt: string;
  actor: "user";
}

export interface SafetyCheckpointContext {
  planVersionId: string;
  procedureId: string;
  expectedDependencyHash: string;
  expectedProcedureSafetyHash: string;
}

/** Available non-shareable inventory used to prove allocation conservation. */
export interface RequirementAllocationSupply {
  source: RequirementAllocation["source"];
  refId: string;
  ownerInstanceId?: string;
  quantity: number;
}

export interface EvaluationDecision {
  decisionId: string;
  verdict: "pass" | "fail" | "blocked";
  domain:
    | "identity"
    | "mechanical"
    | "electrical"
    | "firmware"
    | "system"
    | "storage"
    | "assembly"
    | "commissioning"
    | "routing"
    | "thermal"
    | "acoustic"
    | "procurement";
  message: string;
  instanceIds: string[];
  factIds: string[];
  ruleId: string;
  ruleVersion: string;
  assumptions: string[];
  remediation: RequirementNode[];
}

export interface SolverReadiness {
  ready: boolean;
  blockerFieldIds: string[];
  deferredNonBlockingFieldIds: string[];
}

const DRAFT_SOURCES: readonly RequirementDraftSource[] = ["user", "defaulted", "agent_proposed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateRequirementDraftField<T>(
  value: unknown,
  validateAnsweredValue: (value: unknown) => value is T,
): string[] {
  if (!isRecord(value)) return ["draft field must be an object"];
  const errors: string[] = [];
  if (!DRAFT_SOURCES.includes(value.source as RequirementDraftSource)) errors.push("draft field source invalid");
  if (typeof value.confirmedByUser !== "boolean") errors.push("draft field confirmedByUser must be boolean");
  if (value.state === "answered") {
    if (!("value" in value) || !validateAnsweredValue(value.value)) errors.push("answered draft field requires a valid value");
  } else if (value.state === "deferred" || value.state === "not_applicable") {
    if ("value" in value) errors.push(`${value.state} draft field must not contain value`);
  } else {
    errors.push("draft field state invalid");
  }
  const allowedKeys = value.state === "answered"
    ? ["state", "value", "source", "confirmedByUser"]
    : ["state", "source", "confirmedByUser"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) errors.push("draft field contains unknown fields");
  return errors;
}

function validateBudget(value: unknown): value is RequirementBudget {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["targetCny", "hardCapCny", "reserveCny"].includes(key))) return false;
  if (Object.values(value).some((amount) => !finiteNonNegative(amount))) return false;
  if (value.targetCny === undefined && value.hardCapCny === undefined && value.reserveCny === undefined) return false;
  if (typeof value.targetCny === "number" && typeof value.hardCapCny === "number" && value.targetCny > value.hardCapCny) return false;
  return true;
}

function validateRequirementMetricContract(value: unknown): string[] {
  if (!isRecord(value)) return ["requirement metric must be an object"];
  const governed = Object.fromEntries(Object.entries(value).filter(([key]) => ["metricId", "operator", "value", "unitId", "priority", "benchmarkId", "benchmarkContext"].includes(key)));
  const errors = validateRequirementMetric(governed);
  if (Object.keys(value).some((key) => !["metricId", "operator", "value", "unitId", "priority", "benchmarkId", "benchmarkContext", "source", "confirmedByUser"].includes(key))) errors.push("requirement metric contains unknown fields");
  const hasConfirmationMetadata = "source" in value || "confirmedByUser" in value;
  if (hasConfirmationMetadata) {
    if (value.source !== "user" && value.source !== "migration" && value.source !== "agent_proposed") errors.push("requirement metric source invalid");
    if (typeof value.confirmedByUser !== "boolean") errors.push("requirement metric confirmedByUser must be boolean");
  }
  return errors;
}

/** Contract validation permits empty arrays and independently saved/deferred draft fields. */
export function validateRequirementSpec(value: unknown): string[] {
  if (!isRecord(value)) return ["requirement spec must be an object"];
  const errors: string[] = [];
  const allowedKeys = ["requirementSpecId", "schemaVersion", "budget", "workloads", "constraints", "horizonYears"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) errors.push("requirement spec contains derived or unknown fields");
  if (typeof value.requirementSpecId !== "string" || value.requirementSpecId.length === 0) errors.push("requirementSpecId missing");
  if (value.schemaVersion !== "1.0.0") errors.push("requirement spec schemaVersion invalid");
  if ("budget" in value) errors.push(...validateRequirementDraftField(value.budget, validateBudget).map((error) => `budget: ${error}`));
  if ("horizonYears" in value) {
    errors.push(...validateRequirementDraftField(
      value.horizonYears,
      (input): input is number => typeof input === "number" && Number.isFinite(input) && input > 0,
    ).map((error) => `horizonYears: ${error}`));
  }
  if (!Array.isArray(value.workloads)) {
    errors.push("workloads must be an array");
  } else {
    const ids = new Set<string>();
    for (const [index, workload] of value.workloads.entries()) {
      if (!isRecord(workload)) { errors.push(`workloads.${index} must be an object`); continue; }
      if (typeof workload.workloadId !== "string" || workload.workloadId.length === 0 || ids.has(workload.workloadId)) errors.push(`workloads.${index}.workloadId invalid or duplicate`);
      else ids.add(workload.workloadId);
      if (typeof workload.name !== "string" || workload.name.length === 0) errors.push(`workloads.${index}.name missing`);
      if (!Array.isArray(workload.metrics)) errors.push(`workloads.${index}.metrics must be an array`);
      else {
        const metricIds: string[] = [];
        workload.metrics.forEach((metric, metricIndex) => {
          if (isRecord(metric) && typeof metric.metricId === "string" && metric.metricId.length > 0) metricIds.push(metric.metricId);
          errors.push(...validateRequirementMetricContract(metric).map((error) => `workloads.${index}.metrics.${metricIndex}: ${error}`));
        });
        if (new Set(metricIds).size !== metricIds.length) errors.push(`workloads.${index}.metricId must be unique for stable selection`);
      }
      if (workload.evidenceOrBenchmarkRefs !== undefined && (!Array.isArray(workload.evidenceOrBenchmarkRefs) || workload.evidenceOrBenchmarkRefs.some((ref) => typeof ref !== "string" || ref.length === 0))) errors.push(`workloads.${index}.evidenceOrBenchmarkRefs invalid`);
      if (Object.keys(workload).some((key) => !["workloadId", "name", "metrics", "evidenceOrBenchmarkRefs"].includes(key))) errors.push(`workloads.${index} contains unknown fields`);
    }
  }
  if (!Array.isArray(value.constraints)) {
    errors.push("constraints must be an array");
  } else {
    const ids = new Set<string>();
    for (const [index, constraint] of value.constraints.entries()) {
      if (!isRecord(constraint)) { errors.push(`constraints.${index} must be an object`); continue; }
      if (typeof constraint.constraintId !== "string" || constraint.constraintId.length === 0 || ids.has(constraint.constraintId)) errors.push(`constraints.${index}.constraintId invalid or duplicate`);
      else ids.add(constraint.constraintId);
      errors.push(...validateFacetPredicate(constraint.predicate).map((error) => `constraints.${index}.predicate: ${error}`));
      if (constraint.strength !== "hard" && constraint.strength !== "soft") errors.push(`constraints.${index}.strength invalid`);
      if (constraint.source !== "user" && constraint.source !== "migration" && constraint.source !== "agent_proposed") errors.push(`constraints.${index}.source invalid`);
      if (typeof constraint.confirmedByUser !== "boolean") errors.push(`constraints.${index}.confirmedByUser must be boolean`);
      if (Object.keys(constraint).some((key) => !["constraintId", "predicate", "strength", "source", "confirmedByUser"].includes(key))) errors.push(`constraints.${index} contains unknown fields`);
    }
  }
  return errors;
}

/** Every hard constraint remains a persisted draft until the user explicitly confirms it. */
export function solverActiveConstraints(spec: RequirementSpec): RequirementConstraint[] {
  return spec.constraints.filter((constraint) => constraint.strength === "hard"
    ? constraint.confirmedByUser === true
    : true);
}

export function solverHardMetrics(spec: RequirementSpec): Array<{ workloadId: string; metric: RequirementMetric }> {
  return spec.workloads.flatMap((workload) => workload.metrics
    .filter((metric) => metric.priority === "must" && metric.confirmedByUser === true)
    .map((metric) => ({ workloadId: workload.workloadId, metric })));
}

function allocationKey(value: Pick<RequirementAllocation, "source" | "refId" | "ownerInstanceId">): string {
  return `${value.source}\u0000${value.ownerInstanceId ?? ""}\u0000${value.refId}`;
}

export function validateRequirementSatisfaction(
  requirement: RequirementNode,
  satisfaction: RequirementSatisfaction,
  safetyCheckpoint?: SafetyCheckpointRecord,
  checkpointContext?: SafetyCheckpointContext,
): string[] {
  const errors: string[] = [];
  if (satisfaction.requirementId !== requirement.requirementId) errors.push("requirementId does not match requirement");
  if (!finiteNonNegative(requirement.quantity) || requirement.quantity === 0) errors.push("requirement quantity must be positive");
  if (!finiteNonNegative(satisfaction.residualQuantity)) errors.push("residualQuantity must be non-negative");
  let allocated = 0;
  for (const allocation of satisfaction.allocations) {
    if (!finiteNonNegative(allocation.quantity) || allocation.quantity === 0) errors.push("allocation quantity must be positive");
    else allocated += allocation.quantity;
    if (allocation.availability === "present_verified" && allocation.verificationStatus !== "verified") errors.push("present_verified allocation must be verified");
    const gated = requirement.criticality === "boot" || requirement.criticality === "safety"
      || requirement.requiredBefore === "pre_power" || requirement.requiredBefore === "first_boot";
    if (gated && !isCurrentSafetyCheckpoint(requirement, safetyCheckpoint, checkpointContext) && (allocation.availability !== "present_verified" || allocation.verificationStatus !== "verified")) {
      errors.push("boot/safety allocation must be present_verified or covered by a safety checkpoint");
    }
  }
  if (Math.abs(requirement.quantity - allocated - satisfaction.residualQuantity) > Number.EPSILON) errors.push("allocation quantity is not conserved");
  if (satisfaction.status === "satisfied" && satisfaction.residualQuantity !== 0) errors.push("satisfied requirement must have zero residualQuantity");
  if (satisfaction.status === "open" && satisfaction.residualQuantity === 0) errors.push("open requirement must retain residual quantity");
  return errors;
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateSafetyCheckpointRecord(
  checkpoint: unknown,
  requirement: RequirementNode,
  context: SafetyCheckpointContext,
): string[] {
  if (!isRecord(checkpoint)) return ["safety checkpoint must be an audited record"];
  const errors: string[] = [];
  const allowed = ["checkpointId", "requirementId", "planVersionId", "procedureId", "dependencyHash", "procedureSafetyHash", "confirmedAt", "actor"];
  if (Object.keys(checkpoint).some((key) => !allowed.includes(key))) errors.push("safety checkpoint contains unknown fields");
  if (typeof checkpoint.checkpointId !== "string" || checkpoint.checkpointId.length === 0) errors.push("safety checkpoint identity missing");
  if (checkpoint.requirementId !== requirement.requirementId) errors.push("safety checkpoint requirement binding mismatch");
  if (checkpoint.planVersionId !== context.planVersionId) errors.push("safety checkpoint plan binding is stale");
  if (checkpoint.procedureId !== context.procedureId) errors.push("safety checkpoint procedure binding is stale");
  if (checkpoint.dependencyHash !== context.expectedDependencyHash || !/^[a-f0-9]{64}$/.test(String(checkpoint.dependencyHash))) errors.push("safety checkpoint dependency binding is stale or invalid");
  if (checkpoint.procedureSafetyHash !== context.expectedProcedureSafetyHash || !/^[a-f0-9]{64}$/.test(String(checkpoint.procedureSafetyHash))) errors.push("safety checkpoint procedureSafetyHash binding is stale or invalid");
  if (!isStrictIsoTimestamp(checkpoint.confirmedAt) || checkpoint.actor !== "user") errors.push("safety checkpoint confirmation audit is invalid");
  return errors;
}

/** Server-facing checkpoint gate; expected hashes are repository-resolved. */
export async function validateSafetyCheckpointRecordAuthoritatively(
  checkpoint: unknown,
  requirement: RequirementNode,
  contextRef: string,
  resolver: AuthoritativeResolver<SafetyCheckpointContext, "safety-checkpoint-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<SafetyCheckpointContext, "safety-checkpoint-context">(
    resolver,
    "safety-checkpoint-context",
    contextRef,
  );
  if (!resolved.ok) return [`safety checkpoint authoritative context resolution failed: ${resolved.error}`];
  return validateSafetyCheckpointRecord(checkpoint, requirement, resolved.value);
}

function isCurrentSafetyCheckpoint(
  requirement: RequirementNode,
  checkpoint?: SafetyCheckpointRecord,
  context?: SafetyCheckpointContext,
): boolean {
  return checkpoint !== undefined
    && context !== undefined
    && validateSafetyCheckpointRecord(checkpoint, requirement, context).length === 0;
}

export function validateRequirementNode(value: unknown): string[] {
  if (!isRecord(value)) return ["derived requirement must be an object"];
  const errors: string[] = [];
  const allowed = ["requirementId", "kind", "predicates", "quantity", "criticality", "requiredBefore", "producedBy", "evidenceRefs"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("derived requirement contains persisted-draft, observation, procedure or unknown fields");
  if (typeof value.requirementId !== "string" || value.requirementId.length === 0) errors.push("requirementId missing");
  if (!["component", "accessory", "fastener", "cable", "consumable", "tool", "evidence", "measurement", "firmware_action", "system_action", "user_decision"].includes(String(value.kind))) errors.push("requirement kind invalid");
  if (typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity <= 0) errors.push("requirement quantity must be positive");
  if (!["normal", "boot", "safety"].includes(String(value.criticality))) errors.push("requirement criticality invalid");
  if (value.requiredBefore !== undefined && !["assembly", "pre_power", "first_boot", "os_install"].includes(String(value.requiredBefore))) errors.push("requiredBefore invalid");
  if (!Array.isArray(value.predicates)) errors.push("requirement predicates must be an array");
  else value.predicates.forEach((predicate, index) => errors.push(...validateFacetPredicate(predicate).map((error) => `predicates.${index}: ${error}`)));
  if (!isRecord(value.producedBy)
    || Object.keys(value.producedBy).some((key) => !["ruleId", "ruleVersion", "instanceIds"].includes(key))
    || typeof value.producedBy.ruleId !== "string" || value.producedBy.ruleId.length === 0
    || typeof value.producedBy.ruleVersion !== "string" || value.producedBy.ruleVersion.length === 0
    || !Array.isArray(value.producedBy.instanceIds)
    || value.producedBy.instanceIds.some((id) => typeof id !== "string" || id.length === 0)) errors.push("requirement producedBy invalid");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)) errors.push("requirement evidenceRefs invalid");
  return errors;
}

/** Checks that one physical supply is not allocated beyond its available quantity. */
export function validateRequirementAllocationConservation(
  satisfactions: readonly RequirementSatisfaction[],
  supplies: readonly RequirementAllocationSupply[],
): string[] {
  const available = new Map<string, number>();
  for (const supply of supplies) available.set(allocationKey(supply), (available.get(allocationKey(supply)) ?? 0) + supply.quantity);
  const consumed = new Map<string, number>();
  for (const satisfaction of satisfactions) {
    for (const allocation of satisfaction.allocations) consumed.set(allocationKey(allocation), (consumed.get(allocationKey(allocation)) ?? 0) + allocation.quantity);
  }
  const errors: string[] = [];
  for (const [key, quantity] of consumed) {
    if (quantity > (available.get(key) ?? 0)) errors.push(`allocation exceeds available non-shareable supply: ${key}`);
  }
  return errors;
}

export function verdictForMissingRequirement(_requirement: RequirementNode): EvaluationDecision["verdict"] {
  return "blocked";
}
