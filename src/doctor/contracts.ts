import {
  hashContent,
  isContentAddressedRef,
  isSha256Hex,
  verifyContentAddressedRef,
  type ContentAddressedRef,
} from "../hash";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";

export type DoctorCategory = "storage" | "integrity" | "migration" | "services" | "network" | "security" | "jobs" | "backup" | "runtime";
export type DoctorStatus = "pass" | "warn" | "fail" | "skipped";
export type DoctorSeverity = "info" | "degraded" | "blocking";

export interface DoctorCheckResult {
  checkId: string;
  checkVersion: string;
  category: DoctorCategory;
  status: DoctorStatus;
  severity: DoctorSeverity;
  summary: string;
  evidence: Array<{ code: string; redactedDisplay?: string; valueHash?: string }>;
  evidenceArtifactRefs: ContentAddressedRef[];
  remediation?: string;
  repairable: boolean;
}

export interface DoctorReport {
  schemaVersion: "doctor-v1";
  doctorVersion: string;
  checkRegistryVersion: string;
  runtimeGeneration: number;
  generatedAt: string;
  appVersion: string;
  overall: "healthy" | "degraded" | "unhealthy";
  checks: DoctorCheckResult[];
  reportHash: string;
}

export interface DoctorCheckRegistryEntry {
  checkId: string;
  checkVersion: string;
  category: DoctorCategory;
}

export interface DoctorCheckEvidenceArtifact {
  schemaVersion: "doctor-check-evidence-v1";
  doctorVersion: string;
  checkRegistryVersion: string;
  runtimeGeneration: number;
  checkId: string;
  checkVersion: string;
  status: DoctorStatus;
  severity: DoctorSeverity;
  measurementHash: string;
  measuredAt: string;
}

export interface TrustedDoctorVerificationContext {
  doctorVersion: string;
  checkRegistryVersion: string;
  runtimeGeneration: number;
  checkRegistry: readonly DoctorCheckRegistryEntry[];
  /** Artifact values loaded from the trusted ArtifactRepository by their ref. */
  evidenceArtifacts: ReadonlyMap<string, DoctorCheckEvidenceArtifact>;
}

export interface DoctorReportVerification {
  verified: boolean;
  errors: string[];
}

export interface RepairPlan {
  repairPlanId: string;
  reportHash: string;
  doctorVersion: string;
  checkRegistryVersion: string;
  runtimeGeneration: number;
  actionIds: string[];
  impactSummary: string;
  preconditionHashes: string[];
  backupId: string;
  idempotencyKey: string;
  approvedAt?: string;
  rollbackRefs: string[];
}

export const DOCTOR_VERSION = "doctor-v1";
export const DOCTOR_CHECK_REGISTRY_VERSION = "doctor-check-registry-v1";

export const DOCTOR_MANDATORY_CHECK_IDS = Object.freeze([
  "runtime.permissions",
  "storage.free_space",
  "integrity.repository_hashes",
  "integrity.reference_closure",
  "migration.pending",
  "services.versions",
  "jobs.stuck_lease",
  "jobs.dead_letter",
  "backup.recent_verified",
  "runtime.browser_webgl",
  "services.searxng",
  "services.pdf_parser",
  "network.offline",
  "runtime.clock_skew",
  "security.log_redaction",
] as const);

const MANDATORY_CHECK_CATEGORIES: Readonly<Record<(typeof DOCTOR_MANDATORY_CHECK_IDS)[number], DoctorCategory>> = Object.freeze({
  "runtime.permissions": "runtime", "storage.free_space": "storage", "integrity.repository_hashes": "integrity",
  "integrity.reference_closure": "integrity", "migration.pending": "migration", "services.versions": "services",
  "jobs.stuck_lease": "jobs", "jobs.dead_letter": "jobs", "backup.recent_verified": "backup",
  "runtime.browser_webgl": "runtime", "services.searxng": "services", "services.pdf_parser": "services",
  "network.offline": "network", "runtime.clock_skew": "runtime", "security.log_redaction": "security",
});

export const DEFAULT_DOCTOR_CHECK_REGISTRY: readonly DoctorCheckRegistryEntry[] = Object.freeze(
  DOCTOR_MANDATORY_CHECK_IDS.map((checkId) => Object.freeze({ checkId, checkVersion: "1", category: MANDATORY_CHECK_CATEGORIES[checkId] })),
);

const REPORT_HASH_CONTRACT = Object.freeze({ domain: "doctor-report", schemaVersion: "doctor-v1" } as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function appearsToContainSensitiveDetail(value: string): boolean {
  return /(?:^|\s)(?:\/(?:home|root|etc|var|srv|opt|tmp)\/|[A-Za-z]:\\|\.\.\/)/.test(value)
    || /(?:https?|file):\/\//i.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    || /\b(?:sk|pk|token|secret|bearer)[-_A-Za-z0-9]{12,}\b/i.test(value);
}

function validCombination(status: unknown, severity: unknown): boolean {
  return (status === "pass" && severity === "info")
    || (status === "warn" && severity === "degraded")
    || (status === "fail" && severity === "blocking")
    || (status === "skipped" && (severity === "info" || severity === "degraded"));
}

export function deriveDoctorOverall(checks: readonly DoctorCheckResult[]): DoctorReport["overall"] {
  if (checks.some((check) => check.status === "fail" || check.severity === "blocking")) return "unhealthy";
  if (checks.some((check) => check.status === "warn" || check.status === "skipped" || check.severity === "degraded")) return "degraded";
  return "healthy";
}

export function doctorExitCode(overall: DoctorReport["overall"]): 0 | 1 | 2 {
  return overall === "healthy" ? 0 : overall === "degraded" ? 1 : 2;
}

/** Structural validation only. Use verifyDoctorReport before trusting any check result. */
export function validateDoctorReport(value: unknown): string[] {
  if (!isRecord(value)) return ["doctor report must be an object"];
  const report = value;
  const errors: string[] = [];
  if (report.schemaVersion !== "doctor-v1" || typeof report.doctorVersion !== "string" || !report.doctorVersion || typeof report.checkRegistryVersion !== "string" || !report.checkRegistryVersion || typeof report.appVersion !== "string" || !report.appVersion || !isSha256Hex(report.reportHash) || typeof report.generatedAt !== "string" || !Number.isFinite(Date.parse(report.generatedAt)) || !Number.isInteger(report.runtimeGeneration) || (report.runtimeGeneration as number) < 0) errors.push("doctor report identity/version/hash/timestamp invalid");
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (!Array.isArray(report.checks)) errors.push("doctor checks invalid");
  const ids = checks.flatMap((check) => isRecord(check) && typeof check.checkId === "string" ? [check.checkId] : []);
  for (const checkId of DOCTOR_MANDATORY_CHECK_IDS) if (!ids.includes(checkId)) errors.push(`mandatory doctor check missing: ${checkId}`);
  if (!unique(ids) || ids.length !== checks.length) errors.push("doctor checkId must be unique and non-empty");
  checks.forEach((check, index) => {
    if (!isRecord(check)) {
      errors.push(`doctor check ${index} invalid`);
      return;
    }
    if (typeof check.checkId !== "string" || !check.checkId || typeof check.checkVersion !== "string" || !check.checkVersion || typeof check.summary !== "string" || !check.summary) errors.push(`doctor check ${index} identity/summary invalid`);
    const expectedCategory = typeof check.checkId === "string" ? MANDATORY_CHECK_CATEGORIES[check.checkId as keyof typeof MANDATORY_CHECK_CATEGORIES] : undefined;
    if (expectedCategory !== undefined && check.category !== expectedCategory) errors.push(`doctor check ${index} mandatory category invalid`);
    if (!validCombination(check.status, check.severity)) errors.push(`doctor check ${index} status/severity combination invalid`);
    if (typeof check.summary === "string" && appearsToContainSensitiveDetail(check.summary)) errors.push(`doctor check ${index} summary contains sensitive detail`);
    if (typeof check.remediation === "string" && appearsToContainSensitiveDetail(check.remediation)) errors.push(`doctor check ${index} remediation contains sensitive detail`);
    const evidence = Array.isArray(check.evidence) ? check.evidence : [];
    if (!Array.isArray(check.evidence) || evidence.some((item) => !isRecord(item) || typeof item.code !== "string" || !item.code || Object.keys(item).some((key) => !["code", "redactedDisplay", "valueHash"].includes(key)))) errors.push(`doctor check ${index} evidence must be structured and redacted`);
    if (evidence.some((item) => isRecord(item) && item.valueHash !== undefined && !isSha256Hex(item.valueHash))) errors.push(`doctor check ${index} evidence valueHash invalid`);
    if (evidence.some((item) => isRecord(item) && typeof item.redactedDisplay === "string" && appearsToContainSensitiveDetail(item.redactedDisplay))) errors.push(`doctor check ${index} evidence contains sensitive detail`);
    const refs = Array.isArray(check.evidenceArtifactRefs) ? check.evidenceArtifactRefs : [];
    if (!Array.isArray(check.evidenceArtifactRefs) || refs.length === 0 || refs.some((ref) => !isContentAddressedRef(ref)) || !unique(refs.flatMap((ref) => isContentAddressedRef(ref) ? [ref.ref] : []))) errors.push(`doctor check ${index} evidence artifact refs invalid`);
    if (check.repairable === true && (typeof check.remediation !== "string" || !check.remediation)) errors.push(`doctor check ${index} repairable result requires remediation`);
    if (typeof check.repairable !== "boolean") errors.push(`doctor check ${index} repairable invalid`);
  });
  if (Array.isArray(report.checks) && report.overall !== deriveDoctorOverall(report.checks as DoctorCheckResult[])) errors.push("doctor overall must derive only from checks");
  return errors;
}

/** Internal pure helper for context already loaded from the Doctor runner/artifact repository. */
export async function verifyDoctorReport(value: unknown, context: TrustedDoctorVerificationContext): Promise<DoctorReportVerification> {
  const errors = validateDoctorReport(value);
  if (!isRecord(value)) return { verified: false, errors };
  const report = value as unknown as DoctorReport;
  try {
    const expected = await hashContent(report, REPORT_HASH_CONTRACT);
    if (report.reportHash !== expected) errors.push("doctor reportHash verification failed");
  } catch {
    errors.push("doctor report canonical payload invalid");
  }
  if (report.doctorVersion !== context.doctorVersion || report.checkRegistryVersion !== context.checkRegistryVersion || report.runtimeGeneration !== context.runtimeGeneration) errors.push("doctor report runtime/version binding invalid");

  const registryIds = context.checkRegistry.map((entry) => entry.checkId);
  if (!context.doctorVersion || !context.checkRegistryVersion || !Number.isInteger(context.runtimeGeneration) || context.runtimeGeneration < 0 || !unique(registryIds) || DOCTOR_MANDATORY_CHECK_IDS.some((id) => !registryIds.includes(id))) errors.push("trusted doctor check registry invalid");
  const registry = new Map(context.checkRegistry.map((entry) => [entry.checkId, entry]));
  for (const [index, check] of report.checks.entries()) {
    const registered = registry.get(check.checkId);
    if (!registered || registered.checkVersion !== check.checkVersion || registered.category !== check.category) errors.push(`doctor check ${index} is not bound to trusted registry`);
    for (const ref of check.evidenceArtifactRefs) {
      const artifact = context.evidenceArtifacts.get(ref.ref);
      if (!artifact) {
        errors.push(`doctor check ${index} trusted evidence artifact missing`);
        continue;
      }
      const verified = await verifyContentAddressedRef(artifact, ref).catch(() => false);
      if (!verified) errors.push(`doctor check ${index} evidence artifact hash invalid`);
      if (artifact.schemaVersion !== "doctor-check-evidence-v1" || artifact.doctorVersion !== report.doctorVersion || artifact.checkRegistryVersion !== report.checkRegistryVersion || artifact.runtimeGeneration !== report.runtimeGeneration || artifact.checkId !== check.checkId || artifact.checkVersion !== check.checkVersion || artifact.status !== check.status || artifact.severity !== check.severity || !isSha256Hex(artifact.measurementHash) || !Number.isFinite(Date.parse(artifact.measuredAt))) errors.push(`doctor check ${index} evidence artifact binding invalid`);
    }
  }
  return { verified: errors.length === 0, errors };
}

/** Server-facing Doctor gate; registry and content-addressed measurements are resolver-issued. */
export async function verifyDoctorReportAuthoritatively(
  value: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<TrustedDoctorVerificationContext, "doctor-verification-context">,
): Promise<DoctorReportVerification> {
  const resolved = await resolveAuthoritativeContext<TrustedDoctorVerificationContext, "doctor-verification-context">(
    resolver,
    "doctor-verification-context",
    contextRef,
  );
  if (!resolved.ok) return { verified: false, errors: [`Doctor authoritative context resolution failed: ${resolved.error}`] };
  return verifyDoctorReport(value, resolved.value);
}

export function validateRepairPlan(value: unknown): string[] {
  if (!isRecord(value)) return ["repair plan must be an object"];
  const plan = value;
  const errors: string[] = [];
  if (typeof plan.repairPlanId !== "string" || !plan.repairPlanId || !isSha256Hex(plan.reportHash) || typeof plan.doctorVersion !== "string" || !plan.doctorVersion || typeof plan.checkRegistryVersion !== "string" || !plan.checkRegistryVersion || !Number.isInteger(plan.runtimeGeneration) || (plan.runtimeGeneration as number) < 0 || typeof plan.backupId !== "string" || !plan.backupId || typeof plan.idempotencyKey !== "string" || !plan.idempotencyKey || typeof plan.impactSummary !== "string" || !plan.impactSummary || appearsToContainSensitiveDetail(plan.impactSummary)) errors.push("repair plan identity/version/binding fields invalid");
  const actionIds = Array.isArray(plan.actionIds) ? plan.actionIds : [];
  if (!actionIds.every((id) => typeof id === "string" && id) || actionIds.length === 0 || !unique(actionIds)) errors.push("repair plan actionIds invalid");
  const preconditions = Array.isArray(plan.preconditionHashes) ? plan.preconditionHashes : [];
  if (preconditions.length === 0 || !preconditions.every(isSha256Hex) || !unique(preconditions)) errors.push("repair plan requires unique version-bound SHA-256 preconditions");
  const rollbackRefs = Array.isArray(plan.rollbackRefs) ? plan.rollbackRefs : [];
  if (rollbackRefs.length === 0 || !rollbackRefs.every((ref) => typeof ref === "string" && ref) || !unique(rollbackRefs)) errors.push("repair plan must be rollback-capable");
  if (plan.approvedAt !== undefined && (typeof plan.approvedAt !== "string" || !Number.isFinite(Date.parse(plan.approvedAt)))) errors.push("repair plan approvedAt invalid");
  return errors;
}

export interface RepairExecutionContext {
  currentReportHash: string;
  currentDoctorVersion: string;
  currentCheckRegistryVersion: string;
  currentRuntimeGeneration: number;
  currentPreconditionHashes: readonly string[];
  verifiedBackupIds: ReadonlySet<string>;
}

/** Execution authorization is separate from draft validation and always rechecks current state. */
export function validateRepairExecution(value: unknown, context: RepairExecutionContext): string[] {
  const errors = validateRepairPlan(value);
  if (!isRecord(value)) return errors;
  const plan = value as unknown as RepairPlan;
  if (!plan.approvedAt) errors.push("repair execution requires explicit approval");
  if (!isSha256Hex(context.currentReportHash) || plan.reportHash !== context.currentReportHash) errors.push("repair report binding is stale");
  if (plan.doctorVersion !== context.currentDoctorVersion || plan.checkRegistryVersion !== context.currentCheckRegistryVersion || plan.runtimeGeneration !== context.currentRuntimeGeneration) errors.push("repair runtime/version binding is stale");
  if (!context.verifiedBackupIds.has(plan.backupId)) errors.push("repair execution requires a verified pre-repair backup");
  if (context.currentPreconditionHashes.some((hash) => !isSha256Hex(hash))) errors.push("current repair preconditions contain invalid hashes");
  const expected = [...plan.preconditionHashes].sort();
  const current = [...context.currentPreconditionHashes].sort();
  if (expected.length !== current.length || expected.some((hash, index) => hash !== current[index])) errors.push("repair preconditions changed after plan creation");
  return errors;
}

export interface TrustedRepairExecutionContext extends RepairExecutionContext {
  currentReport: DoctorReport;
  doctorVerification: TrustedDoctorVerificationContext;
}

/** A cryptographically unverified Doctor report can never authorize repair. */
export async function verifyRepairExecution(value: unknown, context: TrustedRepairExecutionContext): Promise<string[]> {
  const errors = validateRepairExecution(value, context);
  const verification = await verifyDoctorReport(context.currentReport, context.doctorVerification);
  if (!verification.verified) errors.push("repair execution requires a cryptographically verified Doctor report");
  return errors;
}

/** Server-facing repair gate; current report, backup and preconditions come from the runner. */
export async function verifyRepairExecutionAuthoritatively(
  value: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<TrustedRepairExecutionContext, "repair-execution-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<TrustedRepairExecutionContext, "repair-execution-context">(
    resolver,
    "repair-execution-context",
    contextRef,
  );
  if (!resolved.ok) return [`repair authoritative context resolution failed: ${resolved.error}`];
  return verifyRepairExecution(value, resolved.value);
}
