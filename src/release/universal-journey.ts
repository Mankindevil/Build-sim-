import { canonicalize, sha256Hex } from "../hash";

export const UNIVERSAL_JOURNEY_EVIDENCE_SCHEMA_VERSION = "universal-journey-evidence-v1" as const;

export const UNIVERSAL_JOURNEY_RECOVERY_JOB_ROLES = Object.freeze([
  "evidence_download",
  "ocr",
  "solver",
  "price_recheck",
  "adapter_generation",
] as const);

export type UniversalJourneyRecoveryJobRole = (typeof UNIVERSAL_JOURNEY_RECOVERY_JOB_ROLES)[number];

export interface UniversalJourneyPlanBinding {
  planId: string;
  planVersionId: string;
  configHash: string;
  evaluationHash: string;
  evaluationLockHash: string;
  factSnapshotHash: string;
}

export interface UniversalJourneyStageBMaterial {
  plan: UniversalJourneyPlanBinding;
  solverJobId: string;
  recommendationSetRef: string;
  executionSessionId: string;
  nasPlan: UniversalJourneyPlanBinding;
}

export interface UniversalJourneyScenarioBindings {
  case: string;
  system: string;
  storage: string;
  nas: string;
}

export interface UniversalJourneyProvisionalCaseBinding {
  planId: string;
  caseInstanceId: string;
  candidateId: string;
  registryRef: string;
  skuId: string;
  region: string;
  revision: string;
}

export interface UniversalJourneyRecoveryJobBinding {
  role: UniversalJourneyRecoveryJobRole;
  jobId: string;
  expectedType: string;
}

export interface UniversalJourneyCrossProductMaterial {
  blankPlan: UniversalJourneyPlanBinding;
  acceptedPlan: UniversalJourneyPlanBinding;
  feasibleSolverJobId: string;
  unsatSolverJobId: string;
  scenarios: UniversalJourneyScenarioBindings;
  provisionalCase: UniversalJourneyProvisionalCaseBinding;
  priceTargetIds: string[];
  recoveryJobs: UniversalJourneyRecoveryJobBinding[];
}

export interface UniversalJourneyEvidenceMaterial {
  schemaVersion: typeof UNIVERSAL_JOURNEY_EVIDENCE_SCHEMA_VERSION;
  runtimeGeneration: number;
  createdAt: string;
  stageB: UniversalJourneyStageBMaterial;
  journey: UniversalJourneyCrossProductMaterial;
}

export interface UniversalJourneyEvidenceManifest extends UniversalJourneyEvidenceMaterial {
  contentHash: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const REF = /^sha256:[a-f0-9]{64}$/u;
const JOB_ID = /^job-[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CANDIDATE_ID = /^provisional-case-adapter-sha256-[a-f0-9]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function token(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function ref(value: unknown): value is string {
  return typeof value === "string" && REF.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validatePlanBinding(value: unknown, label: string): string[] {
  if (!record(value) || !exact(value, [
    "planId", "planVersionId", "configHash", "evaluationHash", "evaluationLockHash", "factSnapshotHash",
  ])) return [`${label} fields are invalid`];
  const errors: string[] = [];
  if (!token(value.planId) || !token(value.planVersionId)) errors.push(`${label} plan identity is invalid`);
  for (const field of ["configHash", "evaluationHash", "evaluationLockHash", "factSnapshotHash"] as const) {
    if (!hash(value[field])) errors.push(`${label} ${field} is invalid`);
  }
  return errors;
}

function validateStageB(value: unknown): string[] {
  if (!record(value) || !exact(value, ["plan", "solverJobId", "recommendationSetRef", "executionSessionId", "nasPlan"])) {
    return ["stage B fields are invalid"];
  }
  const errors = [
    ...validatePlanBinding(value.plan, "stage B plan"),
    ...validatePlanBinding(value.nasPlan, "stage B NAS plan"),
  ];
  if (!JOB_ID.test(String(value.solverJobId ?? ""))) errors.push("stage B solver job ID is invalid");
  if (!ref(value.recommendationSetRef)) errors.push("stage B recommendation set ref is invalid");
  if (!token(value.executionSessionId)) errors.push("stage B execution session ID is invalid");
  return errors;
}

function validateScenarios(value: unknown): string[] {
  if (!record(value) || !exact(value, ["case", "system", "storage", "nas"])) {
    return ["journey scenario fields are invalid"];
  }
  const values = [value.case, value.system, value.storage, value.nas];
  if (values.some((entry) => !token(entry))) return ["journey scenario identity is invalid"];
  return new Set(values).size === values.length ? [] : ["journey scenario identities must be unique"];
}

function validateProvisionalCase(value: unknown): string[] {
  if (!record(value) || !exact(value, [
    "planId", "caseInstanceId", "candidateId", "registryRef", "skuId", "region", "revision",
  ])) return ["journey provisional case fields are invalid"];
  const errors: string[] = [];
  for (const field of ["planId", "caseInstanceId", "skuId", "region", "revision"] as const) {
    if (!token(value[field])) errors.push(`journey provisional case ${field} is invalid`);
  }
  if (typeof value.candidateId !== "string" || !CANDIDATE_ID.test(value.candidateId)) {
    errors.push("journey provisional case candidate ID is invalid");
  }
  if (!ref(value.registryRef)) errors.push("journey provisional case registry ref is invalid");
  return errors;
}

function validateRecoveryJobs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== UNIVERSAL_JOURNEY_RECOVERY_JOB_ROLES.length) {
    return ["journey recovery jobs must bind every required role exactly once"];
  }
  const errors: string[] = [];
  const roles: string[] = [];
  const jobIds: string[] = [];
  for (const entry of value) {
    if (!record(entry) || !exact(entry, ["role", "jobId", "expectedType"])) {
      errors.push("journey recovery job fields are invalid");
      continue;
    }
    if (!UNIVERSAL_JOURNEY_RECOVERY_JOB_ROLES.includes(entry.role as UniversalJourneyRecoveryJobRole)) {
      errors.push("journey recovery job role is invalid");
    } else roles.push(entry.role as string);
    if (typeof entry.jobId !== "string" || !JOB_ID.test(entry.jobId)) errors.push("journey recovery job ID is invalid");
    else jobIds.push(entry.jobId);
    if (!token(entry.expectedType)) errors.push("journey recovery job expected type is invalid");
  }
  const expectedRoles = [...UNIVERSAL_JOURNEY_RECOVERY_JOB_ROLES].sort().join("\0");
  if ([...new Set(roles)].sort().join("\0") !== expectedRoles) errors.push("journey recovery job roles are incomplete or duplicated");
  if (new Set(jobIds).size !== jobIds.length) errors.push("journey recovery job IDs must be unique");
  return errors;
}

function validateJourney(value: unknown): string[] {
  if (!record(value) || !exact(value, [
    "blankPlan", "acceptedPlan", "feasibleSolverJobId", "unsatSolverJobId", "scenarios", "provisionalCase", "priceTargetIds", "recoveryJobs",
  ])) return ["cross-product journey fields are invalid"];
  const errors = [
    ...validatePlanBinding(value.blankPlan, "journey blank plan"),
    ...validatePlanBinding(value.acceptedPlan, "journey accepted plan"),
    ...validateScenarios(value.scenarios),
    ...validateProvisionalCase(value.provisionalCase),
    ...validateRecoveryJobs(value.recoveryJobs),
  ];
  if (!JOB_ID.test(String(value.feasibleSolverJobId ?? ""))) errors.push("journey feasible solver job ID is invalid");
  if (!JOB_ID.test(String(value.unsatSolverJobId ?? ""))) errors.push("journey unsat solver job ID is invalid");
  if (value.feasibleSolverJobId === value.unsatSolverJobId) errors.push("journey solver job IDs must be distinct");
  if (!Array.isArray(value.priceTargetIds) || value.priceTargetIds.length === 0
    || value.priceTargetIds.some((entry) => !token(entry))) {
    errors.push("journey price target IDs are invalid");
  } else if (new Set(value.priceTargetIds).size !== value.priceTargetIds.length) {
    errors.push("journey price target IDs must be unique");
  }
  if (record(value.blankPlan) && record(value.acceptedPlan)
    && (value.blankPlan.planId !== value.acceptedPlan.planId
      || value.blankPlan.planVersionId === value.acceptedPlan.planVersionId)) {
    errors.push("journey blank and accepted versions must be distinct versions of one plan");
  }
  if (record(value.provisionalCase) && record(value.acceptedPlan)
    && value.provisionalCase.planId !== value.acceptedPlan.planId) {
    errors.push("journey provisional case must belong to the accepted plan");
  }
  return errors;
}

export async function createUniversalJourneyEvidenceManifest(
  material: UniversalJourneyEvidenceMaterial,
): Promise<UniversalJourneyEvidenceManifest> {
  const contentHash = await sha256Hex(
    `buildsim\0${UNIVERSAL_JOURNEY_EVIDENCE_SCHEMA_VERSION}\0${canonicalize(material)}`,
  );
  return { ...structuredClone(material), contentHash };
}

export async function validateUniversalJourneyEvidenceManifest(value: unknown): Promise<string[]> {
  if (!record(value) || !exact(value, ["schemaVersion", "runtimeGeneration", "createdAt", "stageB", "journey", "contentHash"])) {
    return ["universal journey evidence fields are invalid"];
  }
  const errors: string[] = [];
  if (value.schemaVersion !== UNIVERSAL_JOURNEY_EVIDENCE_SCHEMA_VERSION) errors.push("universal journey evidence schemaVersion is invalid");
  if (!Number.isSafeInteger(value.runtimeGeneration) || Number(value.runtimeGeneration) < 1) {
    errors.push("universal journey evidence runtimeGeneration is invalid");
  }
  if (!iso(value.createdAt)) errors.push("universal journey evidence createdAt is invalid");
  errors.push(...validateStageB(value.stageB), ...validateJourney(value.journey));
  if (!hash(value.contentHash)) errors.push("universal journey evidence contentHash is invalid");
  else {
    const { contentHash: _contentHash, ...material } = value;
    const expected = await createUniversalJourneyEvidenceManifest(material as unknown as UniversalJourneyEvidenceMaterial);
    if (expected.contentHash !== value.contentHash) errors.push("universal journey evidence contentHash mismatch");
  }
  return [...new Set(errors)].sort();
}
