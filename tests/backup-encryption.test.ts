import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupFileMode, createBackup, isVerifiedBackupResult, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { AttachmentRepository } from "../src/attachments/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, confined, readJson, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { hashPlanConfigRuntime } from "../src/plans/canonical-runtime.mjs";

const roots: string[] = [];
const fixedHash = (letter: string) => letter.repeat(64);
async function writePlanFixture(activeRoot: string, options: { evaluationHash?: string; marker?: string } = {}): Promise<void> {
  const at = "2026-08-27T00:00:00.000Z"; const planId = "plan-fixture";
  const config = createEmptyBuildConfigV3(planId, "Private plan", at);
  const versionId = options.evaluationHash ? "version-plan-v1" : null;
  const plan = { schemaVersion: "1.0.0", id: planId, name: "Private plan", status: "active", createdAt: at, updatedAt: at, activeVersionId: versionId, draftRevision: 0, draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [], dirty: versionId === null, updatedAt: at }, metadata: options.marker ? { tags: [options.marker] } : {} };
  await atomicWriteJson(confined(activeRoot, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
  if (versionId && options.evaluationHash) {
    const version = { schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: at, reason: "manual-save", config, configHash: hashPlanConfigRuntime(config), evaluationHash: options.evaluationHash, evaluatedAt: at, parentVersionId: null, evidenceBindings: [], evidenceHash: sha256Json([]) };
    await atomicWriteJson(confined(activeRoot, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version });
  }
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U1 encrypted backup and staged restore", () => {
  it("uses scrypt + AES-256-GCM, 0600, and rejects wrong passwords or tampering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-backup-encryption-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const state = await coordinator.initialize("test");
    await writePlanFixture(coordinator.activeRoot(state), { marker: "UNIQUE_PRIVATE_MARKER_94b2" });
    const backup = path.join(root, "encrypted.backup");
    const created = await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    const raw = await readFile(backup, "utf8");
    expect(raw).not.toContain("UNIQUE_PRIVATE_MARKER_94b2");
    expect(raw).not.toContain("private.json");
    expect(await backupFileMode(backup)).toBe(0o600);
    expect(created.envelope.encryption).toMatchObject({ mode: "authenticated", kdf: "scrypt", cipher: "aes-256-gcm", keyLengthBits: 256 });
    const verified = await verifyBackup({ inputFile: backup, password: "a sufficiently long password" });
    expect(isVerifiedBackupResult(verified)).toBe(true);
    expect(isVerifiedBackupResult(JSON.parse(JSON.stringify(verified)))).toBe(false);
    await expect(verifyBackup({ inputFile: backup, password: "the wrong long password" })).rejects.toThrow("authentication failed");

    const parsed = JSON.parse(raw); parsed.ciphertextBase64 = `${parsed.ciphertextBase64.slice(0, -4)}AAAA`;
    const tampered = path.join(root, "tampered.backup"); await writeFile(tampered, JSON.stringify(parsed), { mode: 0o600 });
    await expect(verifyBackup({ inputFile: tampered, password: "a sufficiently long password" })).rejects.toThrow("ciphertext hash mismatch");
  });

  it("rejects a checksum-valid but structurally forged job before producing a backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-backup-forged-job-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const state = await coordinator.initialize("test");
    const forged = { status: "running", revision: 0, runtimeGeneration: state.runtimeGeneration };
    await atomicWriteJson(confined(coordinator.activeRoot(state), "jobs", "records", `job-${"f".repeat(64)}.json`), { schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(forged), payload: forged });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "forged.backup"), password: "a sufficiently long password" })).rejects.toThrow(/job record is invalid/);
    expect(await coordinator.readState()).toMatchObject({ activeRoot: state.activeRoot, runtimeGeneration: state.runtimeGeneration });
  });

  it("never switches the active pointer on a pre-commit failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-backup-restore-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const initial = await coordinator.initialize("test");
    await writePlanFixture(coordinator.activeRoot(initial), { evaluationHash: fixedHash("c"), marker: "restore-me" });
    const artifacts = new FileArtifactRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    const jobPayload = await artifacts.put({ bytes: Buffer.from("job-payload"), mediaType: "application/json", privacyClass: "runtime_internal", kind: "job-payload", references: [] });
    const job = { schemaVersion: "background-job-v1", jobId: `job-${"a".repeat(64)}`, type: "fixture", handlerVersion: "1", idempotencyKey: "fixture", inputHash: "b".repeat(64), payloadRef: jobPayload.record.ref, status: "running", revision: 1, attempt: 1, maxAttempts: 3, runAfter: "2026-08-27T00:00:00.000Z", leaseOwner: "old-worker", leaseToken: "old-lease", leaseExpiresAt: "2026-08-27T01:00:00.000Z", runtimeGeneration: initial.runtimeGeneration, networkRequired: false, dependencyJobIds: [], resultRefs: [], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" };
    await atomicWriteJson(confined(coordinator.activeRoot(initial), "jobs", "records", `${job.jobId}.json`), { schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(job), payload: job });
    const catalogRunningJob = { ...job, jobId: "catalog-search-0123456789abcdefabcd", type: "catalog.search", networkRequired: true };
    const catalogRunning = { job: catalogRunningJob, catalog: { stage: "fetch" } };
    await atomicWriteJson(confined(coordinator.activeRoot(initial), "jobs", "catalog-search", "records", `${catalogRunningJob.jobId}.json`), { schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-job", checksum: sha256Json(catalogRunning), payload: catalogRunning });
    const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...terminalBase } = catalogRunningJob;
    const catalogTerminalJob = { ...terminalBase, jobId: "catalog-search-fedcba9876543210abcd", status: "failed", revision: 2, lastError: { code: "fixture_failed", message: "Fixture failure", redacted: true } };
    const catalogTerminal = { job: catalogTerminalJob, catalog: { stage: "score" } };
    await atomicWriteJson(confined(coordinator.activeRoot(initial), "jobs", "catalog-search", "records", `${catalogTerminalJob.jobId}.json`), { schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-job", checksum: sha256Json(catalogTerminal), payload: catalogTerminal });
    const evaluator = await artifacts.put({ bytes: Buffer.from("evaluator"), mediaType: "application/json", privacyClass: "runtime_internal", kind: "evaluator", references: [] });
    const session = { executionSessionId: "execution-1", planVersionId: "version-plan-v1", procedureId: "procedure-v1", evaluationHash: fixedHash("c"), procedureSafetyHash: fixedHash("d"), status: "active", results: [] };
    const procedure = { procedureId: "procedure-v1", inputEvaluationHash: fixedHash("c"), procedureSafetyHash: fixedHash("d"), phases: ["mechanical"], steps: [{ stepId: "mount", phase: "mechanical", action: "mount", dependsOn: [], instanceIds: [], requirementIds: [], expectedResult: "mounted", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [], confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: {}, dependencyHash: fixedHash("e"), evidenceRefs: [] }] };
    const dependencyContext = { evaluatorArtifactRef: evaluator.record.ref, evaluatorArtifactHash: evaluator.record.sha256, evaluatorVersion: "1", expectedInputEvaluationHash: fixedHash("c"), expectedProcedureSafetyHash: fixedHash("d"), expectedStepDependencyHashes: { mount: fixedHash("e") } };
    const replayContext = { procedure, dependencyContext, references: { planVersionRef: "plan-version:version-plan-v1", evaluationRef: `evaluation:${fixedHash("c")}`, procedureRef: `execution-procedure:sha256:${sha256Json(procedure)}`, procedureSafetyRef: `procedure-safety:${fixedHash("d")}`, evaluatorArtifactRef: evaluator.record.ref } };
    const executionBase = { schemaVersion: "execution-repository-v1", revision: 3, runtimeGeneration: initial.runtimeGeneration, leaseToken: "old-execution-lease", leaseExpiresAt: "2026-08-27T01:00:00.000Z", session, replayContext };
    const execution = { ...executionBase, recordHash: sha256Json(executionBase) };
    await atomicWriteJson(confined(coordinator.activeRoot(initial), "execution-sessions", "sessions", "execution-1.json"), { schemaVersion: "execution-repository-v1", kind: "execution-session", checksum: sha256Json(execution), payload: execution });
    const backup = path.join(root, "restore.backup"); await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    await expect(restoreBackup({ coordinator, inputFile: backup, password: "a sufficiently long password", beforePointerSwitch: () => { throw new Error("injected failure"); } })).rejects.toThrow("injected failure");
    expect(await coordinator.readState()).toMatchObject({ runtimeGeneration: initial.runtimeGeneration, activeRoot: initial.activeRoot });
    const restored = await restoreBackup({ coordinator, inputFile: backup, password: "a sufficiently long password" });
    expect(restored.state.runtimeGeneration).toBe(initial.runtimeGeneration + 1);
    expect(await readFile(confined(coordinator.activeRoot(restored.state), "plans", "plan-fixture", "plan.json"), "utf8")).toContain("restore-me");
    const restoredJob = (await readJson(confined(coordinator.activeRoot(restored.state), "jobs", "records", `${job.jobId}.json`))).payload;
    expect(restoredJob).toMatchObject({ status: "paused_restore_review", runtimeGeneration: initial.runtimeGeneration + 1, revision: 2 });
    expect(restoredJob).not.toHaveProperty("leaseToken");
    const restoredCatalogRunning = (await readJson(confined(coordinator.activeRoot(restored.state), "jobs", "catalog-search", "records", `${catalogRunningJob.jobId}.json`))).payload;
    expect(restoredCatalogRunning).toMatchObject({ job: { status: "paused_restore_review", runtimeGeneration: initial.runtimeGeneration + 1, revision: 2 }, catalog: { stage: "paused_restore_review" } });
    expect(restoredCatalogRunning.job).not.toHaveProperty("leaseToken");
    const restoredCatalogTerminal = (await readJson(confined(coordinator.activeRoot(restored.state), "jobs", "catalog-search", "records", `${catalogTerminalJob.jobId}.json`))).payload;
    expect(restoredCatalogTerminal).toMatchObject({ job: { status: "failed", runtimeGeneration: initial.runtimeGeneration + 1, revision: 3 }, catalog: { stage: "score" } });
    const restoredExecution = (await readJson(confined(coordinator.activeRoot(restored.state), "execution-sessions", "sessions", "execution-1.json"))).payload;
    expect(restoredExecution).toMatchObject({ runtimeGeneration: initial.runtimeGeneration + 1, revision: 4, session: { status: "stale", staleReason: "runtime_restored_requires_review" } });
    expect(restoredExecution.leaseToken).not.toBe("old-execution-lease");
    expect(restoredExecution.recordHash).toBe(sha256Json({ ...restoredExecution, recordHash: undefined }));
    expect((await stat(coordinator.activeRoot(restored.state))).isDirectory()).toBe(true);

    // A restored generation contains the synthetic snapshot record from the
    // source package. The next backup must replace it, rather than append a
    // duplicate logical path that only fails during verification.
    const postRestoreBackup = path.join(root, "post-restore.backup");
    await createBackup({ coordinator, outputFile: postRestoreBackup, password: "a sufficiently long password" });
    await expect(verifyBackup({ inputFile: postRestoreBackup, password: "a sufficiently long password" }))
      .resolves.toMatchObject({ valid: true, report: { result: "pass" } });

    const emptyRoot = await mkdtemp(path.join(tmpdir(), "buildsim-empty-restore-")); roots.push(emptyRoot);
    const emptyCoordinator = new RuntimeCoordinator({ root: emptyRoot });
    const emptyRestore = await restoreBackup({ coordinator: emptyCoordinator, inputFile: backup, password: "a sufficiently long password" });
    expect(emptyRestore.state.runtimeGeneration).toBe(initial.runtimeGeneration + 1);
    expect(await readFile(confined(emptyCoordinator.activeRoot(emptyRestore.state), "plans", "plan-fixture", "plan.json"), "utf8")).toContain("restore-me");
  });

  it("excludes explicitly deleted attachment bytes even if crash debris remains", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-backup-deleted-attachment-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const attachments = new AttachmentRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    const saved = await attachments.put({ attachmentId: "attachment-private", planId: "plan-a", content: Buffer.from("DELETED_PRIVATE_ATTACHMENT"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    await attachments.delete("attachment-private", { expectedRevision: 0, expectedHash: saved.metadataHash });
    const state = await coordinator.readState();
    const orphan = confined(coordinator.activeRoot(state), "attachments", "blobs", "sha256", saved.contentHash.slice(0, 2), saved.contentHash);
    await atomicWriteFile(orphan, "DELETED_PRIVATE_ATTACHMENT");
    const backup = path.join(root, "deleted-attachment.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    const verified = await verifyBackup({ inputFile: backup, password: "a sufficiently long password" });
    expect(verified.manifest.entries.some((entry: { logicalPath: string }) => entry.logicalPath.includes(saved.contentHash))).toBe(false);
    expect(verified.manifest.excludedEntries).toContainEqual(expect.objectContaining({ kind: "deleted_attachment_bytes" }));
  });
});
