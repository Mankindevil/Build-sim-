import { readFile, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { validatePersistedBackupVerificationRecord } from "../backup/runtime.mjs";
import { canonicalJson, confined, listRegularFiles, pathExists, readJson, sha256Bytes, sha256Json } from "../runtime/fs.mjs";
import { createProductionReferenceGraphAtSnapshot, verifyProductionReferenceGraph } from "../runtime/production-reference-graph.mjs";
import { validateRuntimeBackgroundJob } from "../jobs/runtime-validation.mjs";

export const DOCTOR_VERSION = "doctor-v1";
export const DOCTOR_CHECK_REGISTRY_VERSION = "doctor-check-registry-v1";
/** @type {readonly Readonly<{ checkId: string, checkVersion: string, category: "storage" | "integrity" | "migration" | "services" | "network" | "security" | "jobs" | "backup" | "runtime" }>[] } */
export const DOCTOR_CHECK_REGISTRY = Object.freeze([
  { checkId: "runtime.permissions", checkVersion: "1", category: "runtime" },
  { checkId: "storage.free_space", checkVersion: "1", category: "storage" },
  { checkId: "integrity.repository_hashes", checkVersion: "1", category: "integrity" },
  { checkId: "integrity.reference_closure", checkVersion: "1", category: "integrity" },
  { checkId: "migration.pending", checkVersion: "1", category: "migration" },
  { checkId: "services.versions", checkVersion: "1", category: "services" },
  { checkId: "jobs.stuck_lease", checkVersion: "1", category: "jobs" },
  { checkId: "jobs.dead_letter", checkVersion: "1", category: "jobs" },
  { checkId: "backup.recent_verified", checkVersion: "1", category: "backup" },
  { checkId: "runtime.browser_webgl", checkVersion: "1", category: "runtime" },
  { checkId: "services.searxng", checkVersion: "1", category: "services" },
  { checkId: "services.pdf_parser", checkVersion: "1", category: "services" },
  { checkId: "network.offline", checkVersion: "1", category: "network" },
  { checkId: "runtime.clock_skew", checkVersion: "1", category: "runtime" },
  { checkId: "security.log_redaction", checkVersion: "1", category: "security" },
].map((entry) => Object.freeze(entry)));

const REPORT_PREFIX = "buildsim\0hash-spec-v1\0doctor-report\0doctor-v1\0";
const ARTIFACT_PREFIX = "buildsim\0hash-spec-v1\0artifact\0artifact-payload-v1\0";
const DOCTOR_RUN_RESULTS = new WeakSet();

function reportHash(report) {
  return sha256Bytes(Buffer.from(`${REPORT_PREFIX}${canonicalJson({ ...report, reportHash: undefined }).normalize("NFC")}`, "utf8"));
}
function artifactRef(value) {
  const contentHash = sha256Bytes(Buffer.from(`${ARTIFACT_PREFIX}${canonicalJson({ ...value, contentHash: undefined }).normalize("NFC")}`, "utf8"));
  return { ref: `sha256:${contentHash}`, hashSpecVersion: "hash-spec-v1", algorithm: "sha256", contentHash, domain: "artifact", schemaVersion: "artifact-payload-v1", canonicalizationPolicyId: "artifact-payload-v1" };
}
function status(statusValue, summary, measurement, extra = {}) {
  const severity = statusValue === "pass" ? "info" : statusValue === "fail" ? "blocking" : statusValue === "warn" ? "degraded" : (extra.degraded ? "degraded" : "info");
  return { status: statusValue, severity, summary, measurement, repairable: false, ...extra, degraded: undefined };
}
function overall(checks) {
  if (checks.some((check) => check.status === "fail")) return "unhealthy";
  if (checks.some((check) => check.status === "warn" || check.status === "skipped" || check.severity === "degraded")) return "degraded";
  return "healthy";
}
async function findJsonRecords(root) {
  const result = [];
  for (const file of await listRegularFiles(root)) {
    if (file.symlink || !file.logicalPath.endsWith(".json")) continue;
    try { result.push({ logicalPath: file.logicalPath, absolutePath: file.absolutePath, value: await readJson(file.absolutePath) }); }
    catch { result.push({ logicalPath: file.logicalPath, absolutePath: file.absolutePath, invalid: true }); }
  }
  return result;
}
function sensitiveText(value) {
  return /(?:https?:\/\/|\/(?:home|root|etc|var|tmp)\/|[A-Za-z]:\\|\b(?:token|secret|bearer|api[-_]?key)[-:=_A-Za-z0-9]{8,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(value);
}
const JOB_STATUSES = new Set(["queued", "running", "waiting_user", "waiting_retry", "paused_offline", "paused_restore_review", "succeeded", "failed", "cancelled", "dead_letter"]);
function catalogJob(record) {
  return record.logicalPath.startsWith("jobs/catalog-search/records/")
    && record.value?.schemaVersion === "catalog-search-store-envelope-v1"
    && record.value?.kind === "catalog-search-job" ? record.value.payload?.job : undefined;
}

/** Executes all mandatory checks without creating or changing any runtime file. */
export async function runDoctor(options) {
  const { coordinator } = options ?? {};
  if (!coordinator) throw new TypeError("Doctor requires a RuntimeCoordinator");
  const generatedAt = (options.now ?? (() => new Date().toISOString()))();
  let state;
  let activeRoot;
  let productionGraph;
  let productionGraphError = false;
  let runtimeTraversalError = false;
  try {
    const captured = await coordinator.withReadOnlySnapshot(async ({ state: snapshotState, activeRoot: snapshotRoot }) => ({
      activeRoot: snapshotRoot,
      graph: await createProductionReferenceGraphAtSnapshot({ state: snapshotState, activeRoot: snapshotRoot, now: options.now }),
    }));
    state = captured.state;
    activeRoot = captured.result.activeRoot;
    productionGraph = captured.result.graph;
  } catch {
    productionGraphError = true;
    try { state = await coordinator.readState(); activeRoot = coordinator.activeRoot(state); }
    catch { state = { runtimeGeneration: 0, appVersion: options.appVersion ?? "unknown", revision: 0 }; activeRoot = undefined; }
  }
  const measurements = new Map();

  const permission = await (async () => {
    if (!activeRoot) return status("fail", "Runtime pointer is unavailable or corrupt.", { pointerReadable: false }, { repairable: true, remediation: "Review the runtime pointer using an approved repair plan." });
    try {
      const files = await listRegularFiles(coordinator.root);
      const regular = files.filter((file) => !file.symlink);
      const targets = new Set([coordinator.root, coordinator.controlRoot, activeRoot, ...regular.map((file) => file.absolutePath), ...regular.map((file) => path.dirname(file.absolutePath))]);
      const modes = await Promise.all([...targets].map(async (target) => (await stat(target)).mode & 0o777));
      const safe = modes.every((mode) => (mode & 0o077) === 0);
      return safe ? status("pass", "Runtime directories use private permissions.", { private: true, readable: true })
        : status("fail", "Runtime permissions are broader than allowed.", { private: false, readable: true }, { repairable: true, remediation: "Restrict permissions after an approved backup and repair plan." });
    } catch {
      runtimeTraversalError = true;
      return status("fail", "Runtime permissions prevent a complete read-only inspection.", { private: null, readable: false }, { repairable: true, remediation: "Restore runtime ownership and private read access after an approved backup and repair plan." });
    }
  })();

  const freeSpace = await (async () => {
    try {
      const fs = await statfs(activeRoot ?? coordinator.root);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      return freeBytes >= (options.minimumFreeBytes ?? 64 * 1024 * 1024)
        ? status("pass", "Runtime storage has sufficient free space.", { sufficient: true, thresholdClass: "normal" })
        : status("warn", "Runtime storage free space is below the operating threshold.", { sufficient: false, thresholdClass: "low" });
    } catch { return status("fail", "Runtime free space could not be measured.", { measurable: false }); }
  })();

  let records = [];
  if (activeRoot) {
    try { records = await findJsonRecords(activeRoot); }
    catch { runtimeTraversalError = true; }
  }
  let controlMigrationInvalid = false;
  let controlMigrationPending = false;
  if (activeRoot) {
    const migrationJournal = confined(coordinator.controlRoot, "legacy-runtime-v1.json");
    if (await pathExists(migrationJournal)) {
      try {
        const journal = await readJson(migrationJournal);
        const unsigned = { ...journal }; delete unsigned.journalHash;
        if (journal?.schemaVersion !== "legacy-runtime-migration-v1" || journal.migrationId !== "legacy-runtime-v1"
          || !["preparing", "prepared", "committed", "rolled_back"].includes(journal.status)
          || journal.journalHash !== sha256Json(unsigned)) throw new Error("invalid migration control journal");
        controlMigrationPending = ["preparing", "prepared"].includes(journal.status);
        if (journal.status === "committed") {
          if (journal.targetActiveRoot !== state.activeRoot || journal.targetRuntimeGeneration !== state.runtimeGeneration
            || !/^[a-f0-9]{64}$/.test(String(journal.committedManifestHash ?? ""))) throw new Error("stale migration control journal");
          const marker = await readJson(confined(activeRoot, "migrations", "legacy-runtime-v1", "manifest.json"));
          if (marker?.status !== "committed" || marker.manifestHash !== journal.committedManifestHash) throw new Error("migration control/active marker mismatch");
        }
      } catch { controlMigrationInvalid = true; }
    }
  }
  let invalidRuntimeRecords = records.filter(({ logicalPath, value, invalid }) => {
    if (invalid) return true;
    if (logicalPath.startsWith("attachments/metadata/")) {
      const stored = value?.payload;
      const base = stored && typeof stored === "object" ? { ...stored, metadataHash: undefined } : undefined;
      return value?.schemaVersion !== "attachment-repository-v1" || value.kind !== "attachment"
        || value.checksum !== sha256Json(stored) || stored?.metadataHash !== sha256Json(base)
        || stored?.attachmentId !== path.posix.basename(logicalPath, ".json")
        || !/^[a-f0-9]{64}$/.test(String(stored?.contentHash ?? ""))
        || !["available", "deleted_tombstone"].includes(stored?.status);
    }
    if (logicalPath.startsWith("observations/plans/") && logicalPath.includes("/records/")) {
      const stored = value?.payload;
      return value?.schemaVersion !== "observation-repository-v1" || value.kind !== "observation"
        || value.checksum !== sha256Json(stored) || stored?.schemaVersion !== "observation-repository-v1"
        || stored?.recordHash !== sha256Json(stored?.observation)
        || stored?.observation?.observationId !== path.posix.basename(logicalPath, ".json");
    }
    if (logicalPath === "prices/latest.json") {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.quotes)
        || !/^[a-f0-9]{64}$/.test(String(value.contentHash ?? ""))) return true;
      const { contentHash, ...material } = value;
      return contentHash !== sha256Bytes(Buffer.from(JSON.stringify(material), "utf8"));
    }
    if (logicalPath.startsWith("jobs/catalog-search/")) {
      const expectedKind = logicalPath.startsWith("jobs/catalog-search/records/") ? "catalog-search-job"
        : logicalPath.startsWith("jobs/catalog-search/idempotency/") ? "catalog-search-idempotency"
          : logicalPath.startsWith("jobs/catalog-search/candidates/") ? "catalog-search-candidate"
            : logicalPath.startsWith("jobs/catalog-search/rollback/candidates/") ? "catalog-search-candidate-rollback"
              : logicalPath.startsWith("jobs/catalog-search/rollback/") ? "catalog-search-job-rollback" : undefined;
      if (!expectedKind || value?.schemaVersion !== "catalog-search-store-envelope-v1" || value.kind !== expectedKind
        || typeof value.checksum !== "string" || value.checksum !== sha256Json(value.payload)) return true;
      if (expectedKind === "catalog-search-job") {
        const job = value.payload?.job;
        const leaseCount = [job?.leaseOwner, job?.leaseToken, job?.leaseExpiresAt].filter((entry) => entry !== undefined).length;
        return job?.schemaVersion !== "background-job-v1" || job.jobId !== path.posix.basename(logicalPath, ".json")
          || !JOB_STATUSES.has(job.status) || !Number.isInteger(job.revision) || job.revision < 0
          || !Number.isInteger(job.runtimeGeneration) || job.runtimeGeneration !== state.runtimeGeneration
          || (job.status === "running" ? leaseCount !== 3 || !Number.isFinite(Date.parse(job.leaseExpiresAt)) : leaseCount !== 0);
      }
      if (expectedKind === "catalog-search-job-rollback") {
        const rollback = value.payload;
        return rollback?.schemaVersion !== "catalog-search-job-rollback-v1" || !rollback?.jobId
          || !Number.isInteger(rollback.fromRevision) || rollback.fromRevision < 0
          || rollback.toRevision !== rollback.fromRevision + 1 || rollback.previous?.job?.jobId !== rollback.jobId
          || rollback.previous?.job?.revision !== rollback.fromRevision
          || rollback.previousChecksum !== sha256Json(rollback.previous);
      }
      if (expectedKind === "catalog-search-candidate-rollback") {
        const rollback = value.payload;
        return rollback?.schemaVersion !== "catalog-search-candidate-rollback-v1" || !rollback?.candidateId
          || !Number.isInteger(rollback.fromRevision) || rollback.fromRevision < 0
          || rollback.toRevision !== rollback.fromRevision + 1 || rollback.previous?.candidateId !== rollback.candidateId
          || rollback.previous?.revision !== rollback.fromRevision
          || rollback.previousChecksum !== sha256Json(rollback.previous);
      }
      return false;
    }
    if (logicalPath.startsWith("jobs/records/")) {
      const job = value?.payload;
      return value?.schemaVersion !== "job-store-envelope-v1" || value.kind !== "background-job"
        || typeof value.checksum !== "string" || value.checksum !== sha256Json(job)
        || job?.jobId !== path.posix.basename(logicalPath, ".json")
        || validateRuntimeBackgroundJob(job, { expectedRuntimeGeneration: state.runtimeGeneration }).length > 0;
    }
    if (logicalPath.startsWith("jobs/idempotency/")) {
      const index = value?.payload;
      return value?.schemaVersion !== "job-store-envelope-v1" || value.kind !== "job-idempotency"
        || typeof value.checksum !== "string" || value.checksum !== sha256Json(index)
        || index?.schemaVersion !== "job-idempotency-v1" || !/^[a-f0-9]{64}$/.test(String(index?.idempotencyKeyHash ?? ""))
        || index.idempotencyKeyHash !== path.posix.basename(logicalPath, ".json")
        || !/^job-[a-f0-9]{64}$/.test(String(index?.jobId ?? "")) || typeof index?.type !== "string" || !index.type
        || typeof index?.handlerVersion !== "string" || !index.handlerVersion || !/^[a-f0-9]{64}$/.test(String(index?.inputHash ?? ""))
        || typeof index?.payloadRef !== "string" || !index.payloadRef || !Number.isFinite(Date.parse(index?.createdAt));
    }
    if (logicalPath.startsWith("jobs/rollback/")) {
      const rollback = value?.payload;
      return value?.schemaVersion !== "job-store-envelope-v1" || value.kind !== "job-rollback"
        || typeof value.checksum !== "string" || value.checksum !== sha256Json(rollback)
        || rollback?.schemaVersion !== "job-rollback-v1" || !/^job-[a-f0-9]{64}$/.test(String(rollback?.jobId ?? ""))
        || !Number.isInteger(rollback?.fromRevision) || rollback.fromRevision < 0 || rollback.toRevision !== rollback.fromRevision + 1
        || rollback.previous?.jobId !== rollback.jobId || rollback.previous?.revision !== rollback.fromRevision
        || rollback.previousChecksum !== sha256Json(rollback.previous)
        // Rollback bytes are immutable historical audit authority. Restore
        // advances live jobs to the new generation, but must not rewrite their
        // signed prior states; accept current/older history and reject future
        // generation forgery.
        || validateRuntimeBackgroundJob(rollback.previous, { maxRuntimeGenerationExclusive: state.runtimeGeneration + 1 }).length > 0;
    }
    if (logicalPath.startsWith("jobs/") && logicalPath.endsWith(".json")) {
      return true;
    }
    if (logicalPath.startsWith("execution-sessions/sessions/")) {
      const stored = value?.payload;
      const base = stored && typeof stored === "object" ? { ...stored, recordHash: undefined } : undefined;
      return value?.schemaVersion !== "execution-repository-v1" || value.kind !== "execution-session"
        || value.checksum !== sha256Json(stored) || stored?.schemaVersion !== "execution-repository-v1"
        || stored?.recordHash !== sha256Json(base) || stored?.runtimeGeneration !== state.runtimeGeneration
        || stored?.session?.executionSessionId !== path.posix.basename(logicalPath, ".json")
        || !["active", "completed", "stale", "abandoned"].includes(stored?.session?.status)
        || (stored?.session?.status === "stale" && typeof stored.session.staleReason !== "string");
    }
    return false;
  }).length;

  if (activeRoot) {
    const availableAttachmentHashes = new Set(records.flatMap((record) => {
      const value = record.logicalPath.startsWith("attachments/metadata/") ? record.value?.payload : undefined;
      return value?.status === "available" && /^[a-f0-9]{64}$/.test(String(value.contentHash ?? "")) ? [value.contentHash] : [];
    }));
    const tombstonedAttachmentHashes = new Set(records.flatMap((record) => {
      const value = record.logicalPath.startsWith("attachments/metadata/") ? record.value?.payload : undefined;
      return value?.status === "deleted_tombstone" && /^[a-f0-9]{64}$/.test(String(value.contentHash ?? "")) ? [value.contentHash] : [];
    }));
    for (const hash of availableAttachmentHashes) {
      const blob = confined(activeRoot, "attachments", "blobs", "sha256", hash.slice(0, 2), hash);
      try { if (sha256Bytes(await readFile(blob)) !== hash) invalidRuntimeRecords += 1; }
      catch { invalidRuntimeRecords += 1; }
    }
    for (const hash of tombstonedAttachmentHashes) {
      if (!availableAttachmentHashes.has(hash)
        && await pathExists(confined(activeRoot, "attachments", "blobs", "sha256", hash.slice(0, 2), hash))) invalidRuntimeRecords += 1;
    }
  }

  let repositoryHashes = await (async () => {
    if (!activeRoot) return status("fail", "Repository integrity cannot be checked without an active runtime.", { active: false });
    if (invalidRuntimeRecords || productionGraphError || controlMigrationInvalid || runtimeTraversalError) return status("fail", "A runtime repository record, migration marker, or required path could not be verified.", { ok: false, readable: !runtimeTraversalError, invalidRecordCount: invalidRuntimeRecords + Number(productionGraphError) + Number(controlMigrationInvalid) + Number(runtimeTraversalError) });
    const artifactRoot = confined(activeRoot, "artifacts");
    if (!await pathExists(confined(artifactRoot, "repository-manifest.json"))) return status("warn", "Artifact repository is not initialized.", { initialized: false });
    const inspected = await new FileArtifactRepository({ root: artifactRoot }).inspect();
    return inspected.ok ? status("pass", "Repository manifests and blobs pass integrity checks.", { ok: true, manifestHash: inspected.manifestHash })
      : status("fail", "A repository manifest, metadata record, or blob failed integrity checks.", { ok: false, errorCode: inspected.code });
  })();

  let referenceClosure = await (async () => {
    if (!activeRoot) return status("fail", "Reference closure cannot be checked without an active runtime.", { active: false });
    if (runtimeTraversalError) return status("fail", "Reference closure cannot be verified while runtime paths are unreadable.", { valid: false, readable: false });
    if (!productionGraph || productionGraphError) return status("fail", "The production reference graph could not be composed from runtime authorities.", { valid: false, generated: false });
    const generatedErrors = verifyProductionReferenceGraph(productionGraph, state);
    if (generatedErrors.length) return status("fail", "The generated production reference graph is invalid.", { valid: false, generated: true, errorCodes: generatedErrors.map((_, index) => `graph_error_${index + 1}`) });
    const graphFile = confined(activeRoot, "audit", "runtime-reference-graph.json");
    if (await pathExists(graphFile)) {
      let stored;
      try { stored = await readJson(graphFile); } catch { return status("fail", "The stored reference graph cannot be read.", { readable: false }); }
      const storedErrors = verifyProductionReferenceGraph(stored, state);
      if (storedErrors.length) return status("fail", "The stored reference graph generation, revision, or provider coverage is stale.", { valid: false, errorCodes: storedErrors.map((_, index) => `stored_graph_error_${index + 1}`) });
      if (canonicalJson(stored.providerSnapshots) !== canonicalJson(productionGraph.providerSnapshots)
        || canonicalJson(stored.nodes) !== canonicalJson(productionGraph.nodes)
        || canonicalJson(stored.edges) !== canonicalJson(productionGraph.edges)) {
        return status("fail", "The stored reference graph does not match current runtime authorities.", { valid: false, current: false });
      }
    }
    return status("pass", "The production reference graph hash and closure are valid.", { valid: true, graphHash: productionGraph.graphHash });
  })();

  const effectiveValue = (record) => record.value?.schemaVersion === "job-store-envelope-v1" ? record.value.payload : record.value;
  const effectiveJob = (record) => catalogJob(record) ?? (record.logicalPath.startsWith("jobs/records/") ? effectiveValue(record) : undefined);
  const pendingMigration = controlMigrationPending || records.some((record) => record.logicalPath.startsWith("migrations/") && ["pending", "prepared", "applying", "rolling_back"].includes(effectiveValue(record)?.status));
  const nowMs = Date.parse(generatedAt);
  const expiredJobs = records.filter((record) => {
    const value = effectiveJob(record);
    return value?.status === "running" && typeof value.leaseExpiresAt === "string" && Date.parse(value.leaseExpiresAt) <= nowMs;
  }).length;
  const staleCatalogGeneration = records.filter((record) => {
    const job = catalogJob(record);
    return job && !["succeeded", "failed", "cancelled", "dead_letter"].includes(job.status) && job.runtimeGeneration !== state.runtimeGeneration;
  }).length;
  const expiredExecutions = records.filter((record) => {
    const stored = record.logicalPath.startsWith("execution-sessions/sessions/") ? record.value?.payload : undefined;
    return stored?.session?.status === "active" && typeof stored.leaseExpiresAt === "string" && Date.parse(stored.leaseExpiresAt) <= nowMs;
  }).length;
  let expiredMaintenanceLease = false;
  try { const lease = await coordinator.currentLease(); expiredMaintenanceLease = !!lease && Date.parse(lease.expiresAt) <= nowMs; } catch { expiredMaintenanceLease = true; }
  let staleCoordinationLock = false;
  try {
    if (await pathExists(coordinator.lockDirectory)) staleCoordinationLock = Date.now() - (await stat(coordinator.lockDirectory)).mtimeMs > (options.staleLockThresholdMs ?? 5 * 60_000);
  } catch { staleCoordinationLock = true; }
  const deadLetters = records.filter((record) => effectiveJob(record)?.status === "dead_letter").length;
  const verifiedBackups = records.filter(({ logicalPath, value }) => logicalPath.startsWith("backups/verifications/") && validatePersistedBackupVerificationRecord(value));
  const freshBackup = verifiedBackups.some(({ value }) => nowMs - Date.parse(value.payload.report.verifiedAt) <= (options.backupFreshnessMs ?? 7 * 24 * 60 * 60 * 1000));
  let invalidLogs = records.some(({ logicalPath, value }) => /(?:^|\/)logs?\//.test(logicalPath) && sensitiveText(JSON.stringify(value)));
  if (activeRoot && !invalidLogs) {
    try {
      for (const file of await listRegularFiles(activeRoot)) {
        if (file.symlink || !/(?:^|\/)(?:logs?)(?:\/|$)|\.log$/i.test(file.logicalPath)) continue;
        const info = await stat(file.absolutePath);
        if (info.size > 8 * 1024 * 1024) { invalidLogs = true; break; }
        if (sensitiveText(await readFile(file.absolutePath, "utf8"))) { invalidLogs = true; break; }
      }
    } catch { runtimeTraversalError = true; }
  }

  const versions = options.serviceVersionsVerified === true
    ? status("pass", "Runtime and service versions are verified.", { versionBound: true })
    : status("warn", "External service versions were not verified in this Doctor run.", { versionBound: false });
  const pdfParser = options.pdfParserAvailable === true ? status("pass", "PDF parser capability is available.", { available: true })
    : options.pdfParserAvailable === false ? status("warn", "PDF parser capability is unavailable.", { available: false })
      : status("skipped", "PDF parser capability was not probed in offline Doctor mode.", { probed: false });
  const browserWebgl = options.browserWebglAvailable === true
    ? status("pass", "Browser WebGL capability is available.", { available: true })
    : options.browserWebglAvailable === false
      ? status("warn", "Browser WebGL capability is unavailable.", { available: false })
      : status("skipped", "Browser WebGL capability was not probed.", { probed: false });
  const searxng = options.searxngAvailable === true
    ? status("pass", "The local search service is available.", { available: true })
    : options.searxngAvailable === false
      ? status("warn", "The local search service is unavailable.", { available: false })
      : status("skipped", "The local search service was not probed.", { probed: false, degraded: options.offline === true });
  const network = options.offline === true ? status("skipped", "Network checks were skipped because runtime is offline.", { offline: true, degraded: true })
    : options.offline === false ? status("pass", "Runtime network state was explicitly reported online.", { offline: false })
      : status("skipped", "Runtime network state was not probed.", { probed: false });
  const clock = Number.isFinite(options.referenceClockMs)
    ? Math.abs(nowMs - options.referenceClockMs) <= (options.maximumClockSkewMs ?? 300_000)
      ? status("pass", "Runtime clock is within the configured skew limit.", { withinLimit: true })
      : status("warn", "Runtime clock exceeds the configured skew limit.", { withinLimit: false })
    : status("skipped", "Clock skew was not checked without an independent time reference.", { referenceAvailable: false });
  try {
    const after = await coordinator.readState();
    const lockedAfter = await coordinator.coordinationLockExists();
    const confirmedAfter = await coordinator.readState();
    if (lockedAfter || canonicalJson(after) !== canonicalJson(state) || canonicalJson(confirmedAfter) !== canonicalJson(state)) {
      repositoryHashes = status("fail", "Runtime changed during the read-only integrity scan; retry is required.", { consistent: false });
      referenceClosure = status("fail", "Runtime changed during the read-only reference scan; retry is required.", { consistent: false });
    }
  } catch {
    repositoryHashes = status("fail", "Runtime pointer became unreadable during the integrity scan.", { consistent: false });
    referenceClosure = status("fail", "Runtime pointer became unreadable during the reference scan.", { consistent: false });
  }

  const results = new Map([
    ["runtime.permissions", permission], ["storage.free_space", freeSpace],
    ["integrity.repository_hashes", repositoryHashes], ["integrity.reference_closure", referenceClosure],
    ["migration.pending", runtimeTraversalError ? status("fail", "Migration state cannot be verified while runtime paths are unreadable.", { readable: false })
      : pendingMigration ? status("fail", "A runtime migration is pending.", { pending: true }) : status("pass", "No pending runtime migration is recorded.", { pending: false })],
    ["services.versions", state.appVersion && state.appVersion !== "unknown" ? versions : status("fail", "Runtime application version is unavailable.", { versionBound: false })],
    ["jobs.stuck_lease", runtimeTraversalError ? status("fail", "Job leases cannot be verified while runtime paths are unreadable.", { readable: false })
      : expiredJobs || expiredExecutions || expiredMaintenanceLease || staleCoordinationLock || staleCatalogGeneration ? status("fail", "An expired active lease, stale runtime generation, or stale coordination lock was detected.", { expiredLeaseCount: expiredJobs + expiredExecutions + Number(expiredMaintenanceLease), staleCatalogGenerationCount: staleCatalogGeneration, staleCoordinationLock }) : status("pass", "No expired active lease, stale runtime generation, or stale coordination lock was detected.", { expiredLeaseCount: 0, staleCatalogGenerationCount: 0, staleCoordinationLock: false })],
    ["jobs.dead_letter", runtimeTraversalError ? status("fail", "Dead-letter state cannot be verified while runtime paths are unreadable.", { readable: false })
      : deadLetters ? status("warn", "Dead-letter jobs require review.", { count: deadLetters }) : status("pass", "No dead-letter jobs were found.", { count: 0 })],
    ["backup.recent_verified", runtimeTraversalError ? status("fail", "Backup verification history cannot be read completely.", { readable: false })
      : freshBackup ? status("pass", "A recent verified backup is recorded.", { fresh: true }) : status("warn", "No recent verified backup is recorded.", { fresh: false })],
    ["runtime.browser_webgl", browserWebgl],
    ["services.searxng", searxng],
    ["services.pdf_parser", pdfParser],
    ["network.offline", network],
    ["runtime.clock_skew", clock],
    ["security.log_redaction", runtimeTraversalError ? status("fail", "Log records cannot be inspected completely while runtime paths are unreadable.", { readable: false })
      : invalidLogs ? status("fail", "A log record failed the sensitive-detail policy.", { redacted: false }) : status("pass", "Inspected log records satisfy the redaction policy.", { redacted: true })],
  ]);

  const evidenceArtifacts = new Map();
  const checks = [];
  for (const registered of DOCTOR_CHECK_REGISTRY) {
    const result = results.get(registered.checkId);
    const measurementHash = sha256Bytes(Buffer.from(canonicalJson(result.measurement), "utf8"));
    const artifact = {
      schemaVersion: "doctor-check-evidence-v1", doctorVersion: DOCTOR_VERSION,
      checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION, runtimeGeneration: state.runtimeGeneration,
      checkId: registered.checkId, checkVersion: registered.checkVersion, status: result.status,
      severity: result.severity, measurementHash, measuredAt: generatedAt,
    };
    const ref = artifactRef(artifact);
    evidenceArtifacts.set(ref.ref, artifact);
    checks.push({
      checkId: registered.checkId, checkVersion: registered.checkVersion, category: registered.category,
      status: result.status, severity: result.severity, summary: result.summary,
      evidence: [{ code: `${registered.checkId.replaceAll(".", "_")}_${result.status}`, valueHash: measurementHash }],
      evidenceArtifactRefs: [ref], ...(result.remediation ? { remediation: result.remediation } : {}), repairable: result.repairable,
    });
  }
  const base = {
    schemaVersion: "doctor-v1", doctorVersion: DOCTOR_VERSION, checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION,
    runtimeGeneration: state.runtimeGeneration, generatedAt, appVersion: state.appVersion, overall: overall(checks), checks,
  };
  const report = { ...base, reportHash: reportHash(base) };
  const runResult = {
    report, evidenceArtifacts,
    preconditionHashes: [...new Set([...evidenceArtifacts.values()].map((artifact) => artifact.measurementHash))].sort(),
    exitCode: doctorProcessExitCode(report, { strict: options.strict === true }),
  };
  DOCTOR_RUN_RESULTS.add(runResult);
  return runResult;
}

export function doctorProcessExitCode(report, { strict = false } = {}) {
  if (report.overall === "unhealthy") return 2;
  if (report.overall === "degraded") return 1;
  if (strict && report.checks?.some((check) => check.status === "skipped")) return 1;
  return 0;
}

/** Runtime identity check; serialized or caller-fabricated Doctor state fails. */
export function isDoctorRunResult(value) { return !!value && typeof value === "object" && DOCTOR_RUN_RESULTS.has(value); }
