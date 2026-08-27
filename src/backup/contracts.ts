import {
  hashContent,
  isContentAddressedRef,
  isSha256Hex,
  verifyArtifactLockfile,
  verifyContentAddressedRef,
  type ArtifactLockfile,
  type ContentAddressedRef,
} from "../hash";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";

export interface BackupEntry {
  logicalPath: string;
  kind: string;
  byteLength: number;
  sha256: string;
  privacyClass: "public_source" | "private_user" | "runtime_internal";
}

export interface BackupManifestBase {
  schemaVersion: "backup-v1";
  backupId: string;
  createdAt: string;
  appVersion: string;
  runtimeGeneration: number;
  entries: BackupEntry[];
  includedRoots: string[];
  excludedEntries: Array<{ kind: string; reason: string }>;
  planIds: string[];
  requirementSpecHashes: string[];
  factSnapshotIds: string[];
  userObservationSnapshotIds: string[];
  priceSnapshotIds: string[];
  evaluationHashes: string[];
  artifactLockfileRef: string;
  executionSessionIds: string[];
  manifestHash: string;
}

export type BackupManifest =
  | (BackupManifestBase & { mode: "plan_portable"; portableProfile: "slim" | "complete" })
  | (BackupManifestBase & { mode: "full_local_backup"; portableProfile?: never });

export type BackupEnvelope =
  | {
      formatVersion: string;
      manifestHash: string;
      payloadSha256: string;
      payloadSha256Basis: "ciphertext";
      encryption: { mode: "none"; formatVersion: string };
    }
  | {
      formatVersion: string;
      manifestHash: string;
      payloadSha256: string;
      payloadSha256Basis: "ciphertext";
      encryption: {
        mode: "authenticated";
        formatVersion: string;
        kdf: "scrypt";
        kdfParams: { n: number; r: number; p: number; saltBase64: string };
        cipher: "aes-256-gcm";
        keyLengthBits: 256;
        nonceBase64: string;
        authTagBase64: string;
        aadSha256: string;
      };
    };

export interface PortableReferenceEdge {
  fromRef: string;
  toRef: string;
  necessity: "required_for_replay" | "optional_for_audit";
}

/** Produced by a consistent Repository snapshot, never read from the package being checked. */
export interface TrustedPortableReferenceGraph {
  graphVersion: string;
  graphHash: string;
  nodes: readonly string[];
  edges: readonly PortableReferenceEdge[];
}

export interface PortableClosureVerificationContext {
  trustedRepositoryGraph: TrustedPortableReferenceGraph;
  requiredRoots: readonly string[];
  stagedIncludedRefs: readonly string[];
  artifactLockfile: ArtifactLockfile;
}

export interface ImportPlan {
  importPlanId: string;
  mode: "dry_run" | "apply";
  manifestHash: string;
  portableProfile: "slim" | "complete";
  resultMode: "exact_replay" | "reevaluate_with_current_runtime";
  conflicts: Array<{ existingId: string; incomingHash: string; existingHash: string }>;
  idRemap: Record<string, string>;
  action: "no_op_same_hash" | "copy_as_new_plan" | "replace_after_backup" | "reject";
  rollbackRef?: string;
}

export interface BackupEntryVerification {
  logicalPath: string;
  expectedByteLength: number;
  actualByteLength: number;
  expectedSha256: string;
  actualSha256: string;
}

export interface TemporaryRestoreVerification {
  artifactRef: ContentAddressedRef;
  reportRef: ContentAddressedRef;
  restoredManifestHash: string;
  runtimeGeneration: number;
}

export interface BackupVerificationReport {
  backupId: string;
  manifestHash: string;
  stagedPayloadSha256: string;
  verifiedAt: string;
  appVersion: string;
  schemaVersion: "backup-verification-v1";
  entryChecks: BackupEntryVerification[];
  temporaryRestore: TemporaryRestoreVerification;
  result: "pass" | "fail";
}

export interface TemporaryRestoreArtifact {
  schemaVersion: "temporary-restore-artifact-v1";
  backupId: string;
  manifestHash: string;
  runtimeGeneration: number;
  restoredRootHash: string;
  entryCount: number;
}

export interface TemporaryRestoreReportArtifact {
  schemaVersion: "temporary-restore-report-v1";
  backupId: string;
  manifestHash: string;
  runtimeGeneration: number;
  restoreArtifactRef: string;
  checkedEntryCount: number;
  result: "pass";
}

export interface TrustedBackupVerificationContext {
  /** Digest measured by the staging reader, not copied from envelope/report JSON. */
  stagedPayloadSha256: string;
  stagedEntries: readonly Pick<BackupEntry, "logicalPath" | "byteLength" | "sha256">[];
  temporaryRestoreArtifact: TemporaryRestoreArtifact;
  temporaryRestoreReport: TemporaryRestoreReportArtifact;
}

export interface BackupPointerSwitchAuthorization {
  verified: boolean;
  pointerSwitchAllowed: boolean;
  errors: string[];
}

export interface PortableProfileValidation {
  valid: boolean;
  exactReplayReady: boolean;
  missingRequiredRefs: string[];
  errors: string[];
}

const SECRET_EXCLUSION_KINDS = ["provider_key", "cookie", "browser_profile", "env_file"] as const;
export const FULL_LOCAL_BACKUP_REQUIRED_ROOTS = Object.freeze(["plans", "facts", "prices", "jobs", "artifacts", "config", "audit", "execution-sessions"] as const);

const MANIFEST_HASH_CONTRACT = Object.freeze({ domain: "backup-manifest", schemaVersion: "backup-v1" } as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsafeLogicalPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.split(/[\\/]/).some((segment) => segment === ".." || segment === "");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function decodedBase64Bytes(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function validateBackupManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["backup manifest must be an object"];
  const manifest = value;
  if (manifest.schemaVersion !== "backup-v1" || typeof manifest.backupId !== "string" || !manifest.backupId || typeof manifest.appVersion !== "string" || !manifest.appVersion || typeof manifest.artifactLockfileRef !== "string" || !manifest.artifactLockfileRef) errors.push("backup identity/reference fields invalid");
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) errors.push("backup createdAt invalid");
  if (!Number.isInteger(manifest.runtimeGeneration) || (manifest.runtimeGeneration as number) < 0) errors.push("runtimeGeneration invalid");

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!Array.isArray(manifest.entries)) errors.push("backup entries invalid");
  const paths: string[] = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`backup entry ${index} invalid`);
      return;
    }
    const path = typeof entry.logicalPath === "string" ? entry.logicalPath : "";
    paths.push(path);
    if (unsafeLogicalPath(path)) errors.push(`backup entry ${index} path invalid`);
    if (typeof entry.kind !== "string" || !entry.kind || !Number.isInteger(entry.byteLength) || (entry.byteLength as number) < 0 || !isSha256Hex(entry.sha256) || !["public_source", "private_user", "runtime_internal"].includes(entry.privacyClass as string)) errors.push(`backup entry ${index} metadata invalid`);
    if (entry.kind === "symlink") errors.push(`backup entry ${index} symlink forbidden`);
    if ((SECRET_EXCLUSION_KINDS as readonly string[]).includes(entry.kind as string)) errors.push(`backup entry ${index} secret-bearing kind forbidden`);
  });
  if (!unique(paths)) errors.push("backup contains duplicate logical paths");

  const includedRoots = stringArray(manifest.includedRoots) ? manifest.includedRoots : [];
  if (!stringArray(manifest.includedRoots) || includedRoots.length === 0 || includedRoots.some(unsafeLogicalPath) || !unique(includedRoots)) errors.push("backup includedRoots invalid");
  paths.forEach((path, index) => {
    if (!includedRoots.some((root) => path === root || path.startsWith(`${root}/`))) errors.push(`backup entry ${index} is outside included roots`);
  });

  const excludedEntries = Array.isArray(manifest.excludedEntries) ? manifest.excludedEntries : [];
  if (!Array.isArray(manifest.excludedEntries) || excludedEntries.some((entry) => !isRecord(entry) || typeof entry.kind !== "string" || !entry.kind || typeof entry.reason !== "string" || !entry.reason)) errors.push("excluded backup entries require kind and reason");
  const excludedKinds = excludedEntries.flatMap((entry) => isRecord(entry) && typeof entry.kind === "string" ? [entry.kind] : []);
  if (!unique(excludedKinds)) errors.push("excluded backup entry kinds must be unique");

  for (const field of ["planIds", "factSnapshotIds", "userObservationSnapshotIds", "priceSnapshotIds", "executionSessionIds"] as const) {
    if (!stringArray(manifest[field]) || !(manifest[field] as string[]).every(Boolean) || !unique(manifest[field] as string[])) errors.push(`backup ${field} invalid`);
  }
  for (const field of ["requirementSpecHashes", "evaluationHashes"] as const) {
    if (!stringArray(manifest[field]) || !(manifest[field] as string[]).every(isSha256Hex) || !unique(manifest[field] as string[])) errors.push(`backup ${field} invalid`);
  }

  if (manifest.mode === "full_local_backup") {
    for (const kind of SECRET_EXCLUSION_KINDS) if (!excludedKinds.includes(kind)) errors.push(`full backup secret exclusion missing: ${kind}`);
    for (const root of FULL_LOCAL_BACKUP_REQUIRED_ROOTS) if (!includedRoots.includes(root)) errors.push(`full backup required root missing: ${root}`);
    if (Object.prototype.hasOwnProperty.call(manifest, "portableProfile")) errors.push("full local backup must not use a portable profile");
  } else if (manifest.mode === "plan_portable") {
    if (manifest.portableProfile !== "slim" && manifest.portableProfile !== "complete") errors.push("portable backup requires slim or complete profile");
  } else {
    errors.push("backup mode invalid");
  }
  if (!isSha256Hex(manifest.manifestHash)) errors.push("manifestHash invalid");
  return errors;
}

/** Structural validation deliberately does not make a cryptographic claim. */
export async function verifyBackupManifestHash(manifest: unknown): Promise<string[]> {
  const errors = validateBackupManifest(manifest);
  if (!isRecord(manifest) || !isSha256Hex(manifest.manifestHash)) return errors;
  try {
    const expected = await hashContent(manifest, MANIFEST_HASH_CONTRACT);
    if (manifest.manifestHash !== expected) errors.push("manifestHash verification failed");
  } catch {
    errors.push("backup manifest canonical payload invalid");
  }
  return errors;
}

/** Structural-only profile validation; exact replay is only claimed by verifyPortableProfileClosure. */
export function validatePortableProfile(manifest: unknown): PortableProfileValidation {
  const errors = validateBackupManifest(manifest);
  if (!isRecord(manifest) || manifest.mode !== "plan_portable") errors.push("portable profile validation requires plan_portable mode");
  return { valid: errors.length === 0, exactReplayReady: false, missingRequiredRefs: [], errors };
}

/** Internal pure helper for an already repository-resolved closure context. */
export async function verifyPortableProfileClosure(
  manifest: unknown,
  context: PortableClosureVerificationContext,
): Promise<PortableProfileValidation> {
  const errors = await verifyBackupManifestHash(manifest);
  const missing = new Set<string>();
  if (!isRecord(manifest) || manifest.mode !== "plan_portable") errors.push("portable closure verification requires plan_portable mode");

  const graph = context.trustedRepositoryGraph;
  const nodes = stringArray(graph?.nodes) ? graph.nodes : [];
  const roots = stringArray(context.requiredRoots) ? context.requiredRoots : [];
  const included = stringArray(context.stagedIncludedRefs) ? context.stagedIncludedRefs : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!graph || typeof graph.graphVersion !== "string" || !graph.graphVersion || !isSha256Hex(graph.graphHash) || nodes.length === 0 || !unique(nodes)) errors.push("trusted repository reference graph invalid");
  if (roots.length === 0 || !unique(roots) || roots.some((root) => !nodes.includes(root))) errors.push("trusted required roots invalid");
  if (!unique(included)) errors.push("staged portable references must be unique");
  edges.forEach((edge, index) => {
    if (!isRecord(edge) || typeof edge.fromRef !== "string" || typeof edge.toRef !== "string" || edge.fromRef === edge.toRef || !nodes.includes(edge.fromRef) || !nodes.includes(edge.toRef) || typeof edge.necessity !== "string" || !["required_for_replay", "optional_for_audit"].includes(edge.necessity)) errors.push(`trusted reference edge ${index} invalid`);
  });
  const edgeKeys = edges.flatMap((edge) => isRecord(edge) && typeof edge.fromRef === "string" && typeof edge.toRef === "string" && typeof edge.necessity === "string" ? [`${edge.fromRef}\u0000${edge.toRef}\u0000${edge.necessity}`] : []);
  if (!unique(edgeKeys)) errors.push("trusted repository reference edges must be unique");

  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const edge of edges) {
      if (edge.fromRef === from && edge.necessity === "required_for_replay" && !reachable.has(edge.toRef)) {
        reachable.add(edge.toRef);
        queue.push(edge.toRef);
      }
    }
  }
  for (const required of reachable) if (!included.includes(required)) missing.add(required);

  const lockfile = context.artifactLockfile;
  const lockfileVerified = await verifyArtifactLockfile(lockfile).catch(() => false);
  if (!lockfileVerified) errors.push("artifact lockfile cryptographic verification failed");
  if (lockfileVerified) {
    const lockRef = `sha256:${lockfile.lockfileHash}`;
    if (!isRecord(manifest) || manifest.artifactLockfileRef !== lockRef) errors.push("portable manifest artifact lockfile binding invalid");
    if (!included.includes(lockRef)) missing.add(lockRef);
    for (const artifact of Object.values(lockfile.artifacts)) if (!included.includes(artifact.ref)) missing.add(artifact.ref);
  }

  const complete = isRecord(manifest) && manifest.mode === "plan_portable" && manifest.portableProfile === "complete";
  if (complete && missing.size > 0) errors.push("complete portable profile is missing trusted required_for_replay references");
  return {
    valid: errors.length === 0,
    exactReplayReady: complete && missing.size === 0 && errors.length === 0,
    missingRequiredRefs: [...missing].sort(),
    errors,
  };
}

/** Server-facing portable closure gate with a recomputed repository graph hash. */
export async function verifyPortableProfileClosureAuthoritatively(
  manifest: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<PortableClosureVerificationContext, "portable-closure-context">,
): Promise<PortableProfileValidation> {
  const resolved = await resolveAuthoritativeContext<PortableClosureVerificationContext, "portable-closure-context">(
    resolver,
    "portable-closure-context",
    contextRef,
  );
  if (!resolved.ok) return { valid: false, exactReplayReady: false, missingRequiredRefs: [], errors: [`portable closure authoritative context resolution failed: ${resolved.error}`] };
  const result = await verifyPortableProfileClosure(manifest, resolved.value);
  try {
    const expected = await hashContent(resolved.value.trustedRepositoryGraph, {
      domain: "portable-reference-graph",
      schemaVersion: "portable-reference-graph-v1",
    });
    if (resolved.value.trustedRepositoryGraph.graphHash !== expected) result.errors.push("trusted repository reference graphHash verification failed");
  } catch {
    result.errors.push("trusted repository reference graph canonical payload invalid");
  }
  if (result.errors.length > 0) {
    result.valid = false;
    result.exactReplayReady = false;
  }
  return result;
}

export function validateImportPlan(value: unknown): string[] {
  if (!isRecord(value)) return ["import plan must be an object"];
  const plan = value;
  const errors: string[] = [];
  if (typeof plan.importPlanId !== "string" || !plan.importPlanId || !isSha256Hex(plan.manifestHash)) errors.push("import plan identity/manifest hash invalid");
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  if (!Array.isArray(plan.conflicts) || conflicts.some((conflict) => !isRecord(conflict) || typeof conflict.existingId !== "string" || !conflict.existingId || !isSha256Hex(conflict.incomingHash) || !isSha256Hex(conflict.existingHash) || conflict.incomingHash === conflict.existingHash)) errors.push("import conflicts must describe different valid hashes");
  const conflictIds = conflicts.flatMap((conflict) => isRecord(conflict) && typeof conflict.existingId === "string" ? [conflict.existingId] : []);
  if (!unique(conflictIds)) errors.push("import conflict IDs must be unique");
  if (plan.mode === "apply" && conflicts.length > 0 && plan.action === "no_op_same_hash") errors.push("different-hash conflicts cannot be silently treated as no-op");
  const idRemap = isRecord(plan.idRemap) ? plan.idRemap : {};
  if (plan.action === "copy_as_new_plan" && conflicts.some((conflict) => isRecord(conflict) && typeof conflict.existingId === "string" && (typeof idRemap[conflict.existingId] !== "string" || idRemap[conflict.existingId] === conflict.existingId))) errors.push("copy import conflicts require explicit new plan-scoped ID remaps");
  if (plan.action === "replace_after_backup" && (typeof plan.rollbackRef !== "string" || !plan.rollbackRef)) errors.push("replacement import requires prior backup rollbackRef");
  if (plan.portableProfile === "slim" && plan.resultMode === "exact_replay") errors.push("slim portable imports must reevaluate with the current runtime");
  if (plan.mode === "apply" && plan.action === "reject") errors.push("a rejected import cannot be applied");
  return errors;
}

export function validateBackupEnvelope(value: unknown, manifestValue: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["backup envelope must be an object"];
  const encryptionValue = value.encryption;
  if (!isRecord(encryptionValue)) return ["backup envelope must be an object"];
  const envelope = value;
  const encryption = encryptionValue;
  if (typeof envelope.formatVersion !== "string" || !envelope.formatVersion || typeof encryption.formatVersion !== "string" || !encryption.formatVersion) errors.push("backup envelope format versions missing");
  if (!isRecord(manifestValue) || envelope.manifestHash !== manifestValue.manifestHash) errors.push("envelope manifestHash mismatch");
  if (!isSha256Hex(envelope.payloadSha256) || envelope.payloadSha256Basis !== "ciphertext") errors.push("payload ciphertext hash invalid");
  const entries = isRecord(manifestValue) && Array.isArray(manifestValue.entries) ? manifestValue.entries : [];
  const hasPrivate = entries.some((entry) => isRecord(entry) && entry.privacyClass === "private_user");
  if ((hasPrivate || (isRecord(manifestValue) && manifestValue.mode === "full_local_backup")) && encryption.mode !== "authenticated") errors.push("private_user/full backup payload requires authenticated encryption");
  if (encryption.mode === "authenticated") {
    if (encryption.kdf !== "scrypt" || encryption.cipher !== "aes-256-gcm" || encryption.keyLengthBits !== 256 || !isSha256Hex(encryption.aadSha256)) errors.push("authenticated envelope algorithm parameters invalid");
    const params = isRecord(encryption.kdfParams) ? encryption.kdfParams : {};
    const n = params.n;
    const r = params.r;
    const p = params.p;
    if (!Number.isInteger(n) || (n as number) < 32_768 || (n as number) > 1_048_576 || ((n as number) & ((n as number) - 1)) !== 0 || !Number.isInteger(r) || (r as number) < 8 || (r as number) > 32 || !Number.isInteger(p) || (p as number) < 1 || (p as number) > 16 || (decodedBase64Bytes(params.saltBase64) ?? 0) < 16 || decodedBase64Bytes(encryption.nonceBase64) !== 12 || decodedBase64Bytes(encryption.authTagBase64) !== 16) errors.push("authenticated envelope production KDF/cipher parameters invalid");
  } else if (encryption.mode !== "none") {
    errors.push("backup envelope encryption mode invalid");
  }
  return errors;
}

export function validateBackupVerification(value: unknown): string[] {
  if (!isRecord(value)) return ["backup verification must be an object"];
  const report = value;
  const errors: string[] = [];
  if (typeof report.backupId !== "string" || !report.backupId || typeof report.appVersion !== "string" || !report.appVersion || report.schemaVersion !== "backup-verification-v1" || !isSha256Hex(report.manifestHash) || !isSha256Hex(report.stagedPayloadSha256) || typeof report.verifiedAt !== "string" || !Number.isFinite(Date.parse(report.verifiedAt))) errors.push("backup verification identity/hash/timestamp invalid");
  const checks = Array.isArray(report.entryChecks) ? report.entryChecks : [];
  if (!Array.isArray(report.entryChecks) || checks.length === 0) errors.push("backup verification requires per-entry checks");
  const paths: string[] = [];
  let entriesMatch = checks.length > 0;
  checks.forEach((check, index) => {
    if (!isRecord(check)) {
      entriesMatch = false;
      errors.push(`backup verification entry ${index} invalid`);
      return;
    }
    if (typeof check.logicalPath === "string") paths.push(check.logicalPath);
    const valid = typeof check.logicalPath === "string" && !unsafeLogicalPath(check.logicalPath)
      && Number.isInteger(check.expectedByteLength) && (check.expectedByteLength as number) >= 0
      && Number.isInteger(check.actualByteLength) && (check.actualByteLength as number) >= 0
      && isSha256Hex(check.expectedSha256) && isSha256Hex(check.actualSha256);
    if (!valid) errors.push(`backup verification entry ${index} invalid`);
    if (!valid || check.expectedByteLength !== check.actualByteLength || check.expectedSha256 !== check.actualSha256) entriesMatch = false;
  });
  if (!unique(paths)) errors.push("backup verification entry paths must be unique");
  const restore = isRecord(report.temporaryRestore) ? report.temporaryRestore : undefined;
  const restoreValid = restore !== undefined && isContentAddressedRef(restore.artifactRef) && isContentAddressedRef(restore.reportRef) && isSha256Hex(restore.restoredManifestHash) && Number.isInteger(restore.runtimeGeneration) && (restore.runtimeGeneration as number) >= 0;
  if (!restoreValid) errors.push("temporary restore artifacts invalid");
  const derivablePass = entriesMatch && restoreValid;
  if ((report.result === "pass") !== derivablePass) errors.push("verification result must derive from staged entry and temporary restore artifacts");
  return errors;
}

function validateTemporaryRestoreValues(
  artifact: TemporaryRestoreArtifact,
  restoreReport: TemporaryRestoreReportArtifact,
  report: BackupVerificationReport,
  manifest: BackupManifest,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== "temporary-restore-artifact-v1" || artifact.backupId !== manifest.backupId || artifact.manifestHash !== manifest.manifestHash || artifact.runtimeGeneration !== report.temporaryRestore.runtimeGeneration || !isSha256Hex(artifact.restoredRootHash) || artifact.entryCount !== manifest.entries.length) errors.push("temporary restore artifact binding invalid");
  if (restoreReport.schemaVersion !== "temporary-restore-report-v1" || restoreReport.backupId !== manifest.backupId || restoreReport.manifestHash !== manifest.manifestHash || restoreReport.runtimeGeneration !== artifact.runtimeGeneration || restoreReport.restoreArtifactRef !== report.temporaryRestore.artifactRef.ref || restoreReport.checkedEntryCount !== manifest.entries.length || restoreReport.result !== "pass") errors.push("temporary restore report binding invalid");
  return errors;
}

/** Internal pure helper for already runner-resolved staged/restore evidence. */
export async function verifyBackupForPointerSwitch(
  reportValue: unknown,
  manifestValue: unknown,
  envelopeValue: unknown,
  context: TrustedBackupVerificationContext,
): Promise<BackupPointerSwitchAuthorization> {
  const errors = [
    ...validateBackupVerification(reportValue),
    ...await verifyBackupManifestHash(manifestValue),
    ...validateBackupEnvelope(envelopeValue, manifestValue),
  ];
  if (!isRecord(reportValue) || !isRecord(manifestValue) || !isRecord(envelopeValue)) return { verified: false, pointerSwitchAllowed: false, errors };
  const report = reportValue as unknown as BackupVerificationReport;
  const manifest = manifestValue as unknown as BackupManifest;
  const envelope = envelopeValue as unknown as BackupEnvelope;
  if (report.backupId !== manifest.backupId || report.manifestHash !== manifest.manifestHash || report.temporaryRestore.restoredManifestHash !== manifest.manifestHash) errors.push("backup verification manifest binding invalid");
  if (!isSha256Hex(context.stagedPayloadSha256) || report.stagedPayloadSha256 !== context.stagedPayloadSha256 || envelope.payloadSha256 !== context.stagedPayloadSha256) errors.push("staged payload hash binding invalid");

  const reportChecks = new Map(report.entryChecks.map((entry) => [entry.logicalPath, entry]));
  const stagedEntries = new Map(context.stagedEntries.map((entry) => [entry.logicalPath, entry]));
  if (reportChecks.size !== manifest.entries.length || stagedEntries.size !== manifest.entries.length) errors.push("backup entry verification coverage incomplete");
  manifest.entries.forEach((entry) => {
    const check = reportChecks.get(entry.logicalPath);
    const staged = stagedEntries.get(entry.logicalPath);
    if (!check || !staged || entry.byteLength !== staged.byteLength || entry.sha256 !== staged.sha256 || check.expectedByteLength !== entry.byteLength || check.actualByteLength !== staged.byteLength || check.expectedSha256 !== entry.sha256 || check.actualSha256 !== staged.sha256) errors.push("backup entry byte/hash verification failed");
  });

  errors.push(...validateTemporaryRestoreValues(context.temporaryRestoreArtifact, context.temporaryRestoreReport, report, manifest));
  const restoreArtifactValid = await verifyContentAddressedRef(context.temporaryRestoreArtifact, report.temporaryRestore.artifactRef).catch(() => false);
  const restoreReportValid = await verifyContentAddressedRef(context.temporaryRestoreReport, report.temporaryRestore.reportRef).catch(() => false);
  if (!restoreArtifactValid || !restoreReportValid) errors.push("temporary restore content-addressed evidence verification failed");
  if (report.result !== "pass") errors.push("failed backup verification cannot switch active pointer");
  return { verified: errors.length === 0, pointerSwitchAllowed: errors.length === 0, errors };
}


/** Only this server-facing resolver gate may authorize an active root-pointer switch. */
export async function verifyBackupForPointerSwitchAuthoritatively(
  reportValue: unknown,
  manifestValue: unknown,
  envelopeValue: unknown,
  contextRef: string,
  resolver: AuthoritativeResolver<TrustedBackupVerificationContext, "backup-verification-context">,
): Promise<BackupPointerSwitchAuthorization> {
  const resolved = await resolveAuthoritativeContext<TrustedBackupVerificationContext, "backup-verification-context">(
    resolver,
    "backup-verification-context",
    contextRef,
  );
  if (!resolved.ok) return { verified: false, pointerSwitchAllowed: false, errors: [`backup authoritative context resolution failed: ${resolved.error}`] };
  return verifyBackupForPointerSwitch(reportValue, manifestValue, envelopeValue, resolved.value);
}
