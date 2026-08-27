import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, persistBackupVerification, verifyBackup } from "../src/backup/runtime.mjs";
import { validateBackupEnvelope, verifyBackupManifestHash } from "../src/backup/contracts";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { ExecutionRepository } from "../src/build-execution/repository";
import type { BuildProcedure, ExecutionSession, ProcedureDependencyContext } from "../src/build-execution/contracts";
import { RuntimeCoordinator, RUNTIME_REQUIRED_ROOTS } from "../src/runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";

const roots: string[] = [];
const hash = (letter: string) => letter.repeat(64);
async function writePlanFixture(activeRoot: string, evaluationHash: string): Promise<void> {
  const at = "2026-08-27T00:00:00.000Z";
  const planId = "plan-fixture"; const versionId = "version-plan-v1"; const config = {};
  const version = { schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: at, reason: "manual", config, configHash: sha256Json(config), evaluationHash, evaluatedAt: at, parentVersionId: null, evidenceBindings: [], evidenceHash: sha256Json([]) };
  const plan = { schemaVersion: "1.0.0", id: planId, name: "Private plan", status: "active", createdAt: at, updatedAt: at, activeVersionId: versionId, draftRevision: 0, draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [], dirty: false, updatedAt: at }, metadata: {} };
  await atomicWriteJson(confined(activeRoot, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
  await atomicWriteJson(confined(activeRoot, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version });
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U1 full runtime backup manifest", () => {
  it("captures every required repository root and the consistent runtime pointer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-backup-manifest-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const state = await coordinator.initialize("1.2.3");
    await writePlanFixture(coordinator.activeRoot(state), hash("a"));
    const artifacts = new FileArtifactRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    const evaluator = await artifacts.put({ bytes: Buffer.from("evaluator"), mediaType: "application/json", privacyClass: "runtime_internal", kind: "evaluator", references: [] });
    const procedure: BuildProcedure = { procedureId: "procedure-1", inputEvaluationHash: hash("a"), procedureSafetyHash: hash("b"), phases: ["mechanical"], steps: [{ stepId: "mount", phase: "mechanical", action: "mount", dependsOn: [], instanceIds: [], requirementIds: [], expectedResult: "mounted", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [], confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: {}, dependencyHash: hash("d"), evidenceRefs: [] }] };
    const dependencyContext: ProcedureDependencyContext = { evaluatorArtifactRef: evaluator.record.ref, evaluatorArtifactHash: evaluator.record.sha256, evaluatorVersion: "1", expectedInputEvaluationHash: hash("a"), expectedProcedureSafetyHash: hash("b"), expectedStepDependencyHashes: { mount: hash("d") } };
    const session: ExecutionSession = { executionSessionId: "session-1", planVersionId: "version-plan-v1", procedureId: "procedure-1", evaluationHash: hash("a"), procedureSafetyHash: hash("b"), status: "active", results: [] };
    const executions = new ExecutionRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    await executions.create({ session, procedure, dependencyContext, leaseToken: "lease-1", leaseExpiresAt: "2026-08-28T00:00:00.000Z" });
    await atomicWriteFile(confined(coordinator.activeRoot(state), "config", ".env"), "API_KEY=must-not-leak");
    await atomicWriteJson(confined(coordinator.activeRoot(state), "config", "provider.json"), { apiKey: "also-must-not-leak" });
    const outputFile = path.join(root, "outside-active.backup");
    const created = await createBackup({ coordinator, outputFile, password: "correct horse battery staple", backupId: "backup-test", now: () => "2026-08-27T00:00:00.000Z" });
    const verified = await verifyBackup({ inputFile: outputFile, password: "correct horse battery staple", now: () => "2026-08-27T00:01:00.000Z" });

    expect(await verifyBackupManifestHash(created.manifest)).toEqual([]);
    expect(validateBackupEnvelope(created.envelope, created.manifest)).toEqual([]);
    expect(created.manifest.includedRoots).toEqual(expect.arrayContaining([...RUNTIME_REQUIRED_ROOTS]));
    expect(created.manifest.entries.map((entry: { logicalPath: string }) => entry.logicalPath)).toEqual(expect.arrayContaining(["plans/plan-fixture/plan.json", "execution-sessions/sessions/session-1.json", "audit/backup-runtime-snapshot.json"]));
    expect(created.manifest.executionSessionIds).toEqual(["session-1"]);
    expect(created.manifest.entries.some((entry: { logicalPath: string }) => entry.logicalPath.includes(".env"))).toBe(false);
    expect(created.manifest.entries.some((entry: { logicalPath: string }) => entry.logicalPath.endsWith("provider.json"))).toBe(false);
    expect(created.manifest.excludedEntries.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(["provider_key", "cookie", "browser_profile", "env_file"]));
    expect(verified.snapshot).toMatchObject({ runtimeGeneration: state.runtimeGeneration, runtimeRevision: created.snapshot.runtimeRevision, activeRoot: state.activeRoot, closureLimitations: [] });
    expect(verified.snapshot.executionReferenceClosure[0].replayRefs).toEqual(expect.arrayContaining(["plan-version:version-plan-v1", `evaluation:${hash("a")}`, evaluator.record.ref]));
    expect(verified.snapshot.snapshotPointers).toHaveLength(created.manifest.includedRoots.length);
    expect(await readFile(outputFile, "utf8")).not.toContain("Private plan");
    await persistBackupVerification({ coordinator, verification: verified });
    const doctor = await runDoctor({ coordinator, now: () => "2026-08-27T00:02:00.000Z" });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "backup.recent_verified")).toMatchObject({ status: "pass" });
    await expect(createBackup({ coordinator, outputFile: `${outputFile}.portable`, password: "correct horse battery staple", mode: "plan_portable", portableProfile: "complete" })).rejects.toThrow("U12 scoped closure exporter");
    await expect(createBackup({ coordinator, outputFile: `${outputFile}.wrong-ids`, password: "correct horse battery staple", executionSessionIds: ["invented-session"] })).rejects.toThrow("exact-match");
  });
});
