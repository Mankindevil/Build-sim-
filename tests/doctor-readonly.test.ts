import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { AttachmentRepository } from "../src/attachments/repository";
import { verifyDoctorReport } from "../src/doctor/contracts";
import { DOCTOR_CHECK_REGISTRY, DOCTOR_CHECK_REGISTRY_VERSION, DOCTOR_VERSION, runDoctor } from "../src/doctor/runner.mjs";
import { executeApprovedRepair } from "../src/doctor/repair.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createConsistentReferenceGraph } from "../src/runtime/reference-graph.mjs";
import { atomicWriteFile, atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function tree(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function walk(current: string) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); const info = await stat(target); const relative = path.relative(root, target); if (entry.isDirectory()) { result.push([relative, "d", info.mode & 0o777]); await walk(target); } else result.push([relative, "f", info.mode & 0o777, (await readFile(target)).toString("base64")]); } }
  await walk(root); return result;
}
async function exactTree(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function walk(current: string) {
    const info = await stat(current, { bigint: true });
    const relative = path.relative(root, current) || ".";
    if (info.isDirectory()) {
      const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      result.push([relative, "d", info.mode & 0o777n, info.mtimeNs.toString(), entries.map((entry) => [entry.name, entry.isDirectory() ? "d" : entry.isFile() ? "f" : "o"])]);
      for (const entry of entries) await walk(path.join(current, entry.name));
    } else {
      result.push([relative, "f", info.mode & 0o777n, info.mtimeNs.toString(), (await readFile(current)).toString("base64")]);
    }
  }
  await walk(root); return result;
}

describe("U1 read-only Doctor", () => {
  it("does not initialize an ArtifactRepository from a read or bypass a maintenance lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-artifact-readonly-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    const before = await tree(root);
    const repository = new FileArtifactRepository({ coordinator });

    await expect(repository.get(`sha256:${"a".repeat(64)}`)).resolves.toBeNull();
    await expect(repository.list()).rejects.toMatchObject({ code: "missing_manifest" });
    expect(await tree(root)).toEqual(before);
    await coordinator.releaseMaintenanceLease(lease.token);
  });

  it("preserves every runtime mtime, directory entry, and file byte while emitting verifiable evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-readonly-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const repository = new FileArtifactRepository({ coordinator, now: () => "2026-08-20T00:00:00.000Z" });
    const artifact = await repository.put({ bytes: Buffer.from("artifact"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "active_snapshot", references: [] });
    const graph = await createConsistentReferenceGraph({ coordinator, providers: [repository], requiredRoots: [artifact.record.ref], now: () => "2026-08-27T00:00:00.000Z" });
    const before = await exactTree(root);
    const result = await runDoctor({ coordinator, referenceGraph: graph, now: () => "2026-08-27T00:00:00.000Z" });
    expect(await exactTree(root)).toEqual(before);
    expect(await readdir(coordinator.controlRoot)).not.toContain(".runtime-lock");
    expect(JSON.stringify(result.report)).not.toMatch(/\/tmp\/|\/home\/|https?:\/\/|UNIQUE_SECRET/i);
    const verified = await verifyDoctorReport(result.report, { doctorVersion: DOCTOR_VERSION, checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION, runtimeGeneration: result.report.runtimeGeneration, checkRegistry: DOCTOR_CHECK_REGISTRY, evidenceArtifacts: result.evidenceArtifacts });
    expect(verified).toEqual({ verified: true, errors: [] });
    let actions = 0;
    const repair = await executeApprovedRepair({
      plan: { approvedAt: "2026-08-27T00:00:00.000Z" }, doctorRun: JSON.parse(JSON.stringify(result)), verifiedBackup: {}, allowRepair: true, coordinator,
      actionRunner: async () => { actions += 1; }, idempotencyStore: { has: async () => false, mark: async () => undefined },
    });
    expect(repair.errors).toEqual(expect.arrayContaining(["repair requires runner-issued Doctor state", "repair requires runner-issued backup verification"]));
    expect(actions).toBe(0);
  });

  it("detects a corrupted blob without repairing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-corrupt-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const repository = new FileArtifactRepository({ coordinator });
    const artifact = await repository.put({ bytes: Buffer.from("good"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "fact", references: [] });
    const state = await coordinator.readState(); const blob = path.join(coordinator.activeRoot(state), "artifacts", "blobs", "sha256", artifact.record.sha256.slice(0, 2), artifact.record.sha256);
    await writeFile(blob, "bad", { mode: 0o600 }); const before = await readFile(blob, "utf8");
    await atomicWriteJson(coordinator.leaseFile, { schemaVersion: "maintenance-lease-v1", token: "expired", owner: "fixture", acquiredAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T00:01:00.000Z" });
    const catalogJob = { schemaVersion: "background-job-v1", jobId: "catalog-search-0123456789abcdefabcd", type: "catalog.search", handlerVersion: "1", idempotencyKey: "doctor", inputHash: "a".repeat(64), payloadRef: "catalog-search-payload:test", status: "queued", revision: 0, attempt: 0, maxAttempts: 3, runAfter: "2026-08-27T00:00:00.000Z", runtimeGeneration: 2, networkRequired: true, dependencyJobIds: [], resultRefs: [], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" };
    const catalogPayload = { job: catalogJob, catalog: { stage: "normalize" } };
    await atomicWriteJson(confined(coordinator.activeRoot(await coordinator.readState()), "jobs", "catalog-search", "records", `${catalogJob.jobId}.json`), { schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-job", checksum: sha256Json(catalogPayload), payload: catalogPayload });
    const result = await runDoctor({ coordinator, referenceGraph: { graphVersion: "portable-reference-graph-v1", graphHash: "0".repeat(64), nodes: ["root"], edges: [{ fromRef: "root", toRef: "missing", necessity: "required_for_replay" }] }, now: () => "2026-08-27T00:00:00.000Z" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "jobs.stuck_lease")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(await readFile(blob, "utf8")).toBe(before);
  });

  it("fails closed when the revision changes during an optimistic read-only snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-revision-race-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const writer = new RuntimeCoordinator({ root });
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = coordinator.withReadOnlySnapshot(async () => { entered(); await releasePromise; return "captured"; });
    await enteredPromise;
    await writer.withWrite(async () => undefined);
    release();
    await expect(snapshot).rejects.toThrow(/changed during read-only snapshot/);
    expect(await readdir(coordinator.controlRoot)).not.toContain(".runtime-lock");
  });

  it("fails closed when the active pointer changes during an optimistic read-only snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-pointer-race-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const initial = await coordinator.initialize("test");
    const writer = new RuntimeCoordinator({ root });
    const lease = await writer.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    const staging = await writer.createStagingGeneration(lease.token);
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = coordinator.withReadOnlySnapshot(async () => { entered(); await releasePromise; return "captured"; });
    await enteredPromise;
    await writer.activateStagingGeneration(staging, initial.runtimeGeneration, lease.token);
    release();
    await expect(snapshot).rejects.toThrow(/changed during read-only snapshot/);
    expect((await writer.readState()).activeRoot).toBe("generations/2");
    await writer.releaseMaintenanceLease(lease.token);
  });

  it("reports concurrent Doctor revision drift as blocking", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-concurrent-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const writer = new RuntimeCoordinator({ root });
    const currentLease = coordinator.currentLease.bind(coordinator);
    let changed = false;
    coordinator.currentLease = async () => {
      if (!changed) { changed = true; await writer.withWrite(async () => undefined); }
      return currentLease();
    };
    const result = await runDoctor({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(result.report.overall).toBe("unhealthy");
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(await readdir(coordinator.controlRoot)).not.toContain(".runtime-lock");
  });

  it("fails closed while a writer is still inside its barrier at the end of the Doctor scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-active-writer-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const writer = new RuntimeCoordinator({ root });
    const currentLease = coordinator.currentLease.bind(coordinator);
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let write: Promise<unknown> | undefined;
    coordinator.currentLease = async () => {
      if (!write) {
        write = writer.withWrite(async () => { entered(); await releasePromise; });
        await enteredPromise;
      }
      return currentLease();
    };
    let result;
    try { result = await runDoctor({ coordinator, now: () => "2026-08-27T00:00:00.000Z" }); }
    finally { release(); await write; }
    expect(result.report.overall).toBe("unhealthy");
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure")).toMatchObject({ status: "fail", severity: "blocking" });
  });

  it("detects deleted attachment byte debris and an unhashed runtime price snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-runtime-records-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const attachments = new AttachmentRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    const saved = await attachments.put({ attachmentId: "attachment-deleted", planId: "plan-a", content: Buffer.from("deleted body"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    await attachments.delete("attachment-deleted", { expectedRevision: 0, expectedHash: saved.metadataHash });
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    const debris = path.join(activeRoot, "attachments", "blobs", "sha256", saved.contentHash.slice(0, 2), saved.contentHash);
    await atomicWriteJson(path.join(activeRoot, "prices", "latest.json"), { schemaVersion: "1.0.0", asOf: "2026-08-27", quotes: [] });
    await atomicWriteFile(debris, "deleted body");
    const before = await tree(root);
    const result = await runDoctor({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(await tree(root)).toEqual(before);
  });

  it("rejects a checksum-valid job envelope whose governed payload is incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-forged-job-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const state = await coordinator.initialize("test");
    const forged = { status: "queued", revision: 0, runtimeGeneration: state.runtimeGeneration };
    await atomicWriteJson(confined(coordinator.activeRoot(state), "jobs", "records", `job-${"f".repeat(64)}.json`), { schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(forged), payload: forged });
    const before = await tree(root);
    const result = await runDoctor({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(await tree(root)).toEqual(before);
  });

  it("accepts valid catalog job and candidate rollback history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-catalog-rollback-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const activeRoot = coordinator.activeRoot(await coordinator.readState());
    const jobId = "catalog-search-0123456789abcdefabcd";
    const previous = {
      job: { schemaVersion: "background-job-v1", jobId, type: "catalog.search", handlerVersion: "1", idempotencyKey: "doctor-rollback", inputHash: "a".repeat(64), payloadRef: "catalog-search-payload:test", status: "queued", revision: 0, attempt: 0, maxAttempts: 3, runAfter: "2026-08-27T00:00:00.000Z", runtimeGeneration: 1, networkRequired: true, dependencyJobIds: [], resultRefs: [], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" },
      catalog: { stage: "normalize" },
    };
    const jobRollback = { schemaVersion: "catalog-search-job-rollback-v1", jobId, fromRevision: 0, toRevision: 1, previousChecksum: sha256Json(previous), createdAt: "2026-08-27T00:01:00.000Z", previous };
    await atomicWriteJson(confined(activeRoot, "jobs", "catalog-search", "rollback", jobId, "000000000000.json"), { schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-job-rollback", checksum: sha256Json(jobRollback), payload: jobRollback });
    const candidateId = "catalog-candidate-0123456789abcdef";
    const priorCandidate = { schemaVersion: "catalog-search-candidate-v1", candidateId, candidate: { candidateId }, updatedAt: "2026-08-27T00:00:00.000Z", revision: 0 };
    const candidateRollback = { schemaVersion: "catalog-search-candidate-rollback-v1", candidateId, fromRevision: 0, toRevision: 1, previousChecksum: sha256Json(priorCandidate), createdAt: "2026-08-27T00:01:00.000Z", previous: priorCandidate };
    await atomicWriteJson(confined(activeRoot, "jobs", "catalog-search", "rollback", "candidates", candidateId, "000000000000.json"), { schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-candidate-rollback", checksum: sha256Json(candidateRollback), payload: candidateRollback });
    const result = await runDoctor({ coordinator, now: () => "2026-08-27T00:02:00.000Z" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")?.status).not.toBe("fail");
  });
});
