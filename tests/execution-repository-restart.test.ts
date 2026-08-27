import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionRepository } from "../src/build-execution/repository";
import type { BuildProcedure, ExecutionSession, ProcedureDependencyContext } from "../src/build-execution/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = []; const hash = (letter: string) => letter.repeat(64);
const procedure = (): BuildProcedure => ({ procedureId: "procedure", inputEvaluationHash: hash("a"), procedureSafetyHash: hash("b"), phases: ["mechanical"], steps: [{ stepId: "mount", phase: "mechanical", action: "Mount", dependsOn: [], instanceIds: ["board"], requirementIds: [], expectedResult: "mounted", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [], confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: { spatialHash: hash("c") }, dependencyHash: hash("d"), evidenceRefs: ["manual"] }] });
const context = (value: BuildProcedure): ProcedureDependencyContext => ({ evaluatorArtifactRef: `sha256:${hash("e")}`, evaluatorArtifactHash: hash("e"), evaluatorVersion: "1", expectedInputEvaluationHash: value.inputEvaluationHash, expectedProcedureSafetyHash: value.procedureSafetyHash, expectedStepDependencyHashes: { mount: hash("d") } });
const session = (): ExecutionSession => ({ executionSessionId: "session-a", planVersionId: "version-a", procedureId: "procedure", evaluationHash: hash("a"), procedureSafetyHash: hash("b"), status: "active", results: [] });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U1 ExecutionRepository restart and fencing", () => {
  it("persists a session across restart with 0600 atomically checksummed records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-execution-")); roots.push(root); let generation = 7; const options = { root, now: () => "2026-08-27T00:00:00.000Z", runtimeGeneration: () => generation }; const store = new ExecutionRepository(options); const proc = procedure();
    const saved = await store.create({ session: session(), procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });
    const file = path.join(root, "sessions", "session-a.json"); expect((await (await import("node:fs/promises")).stat(file)).mode & 0o777).toBe(0o600);
    const restarted = new ExecutionRepository(options); await expect(restarted.get("session-a")).resolves.toMatchObject({ revision: 0, runtimeGeneration: 7, recordHash: saved.recordHash });
    generation = 8;
    await expect(restarted.commit("session-a", { session: session(), procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 7 })).rejects.toMatchObject({ code: "fenced" });
  });

  it("rejects old leases, stale revisions and corrupted/partial records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-execution-")); roots.push(root); const store = new ExecutionRepository({ root, now: () => "2026-08-27T00:00:00.000Z", runtimeGeneration: () => 1 }); const proc = procedure(); const saved = await store.create({ session: session(), procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });
    await expect(store.commit("session-a", { session: session(), procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-old", runtimeGeneration: 1 })).rejects.toMatchObject({ code: "fenced" });
    const file = path.join(root, "sessions", "session-a.json"); await writeFile(path.join(root, "sessions", "session-interrupted.json.tmp"), "partial"); await expect(store.get("session-a")).resolves.toMatchObject({ revision: 0 }); const raw = JSON.parse(await readFile(file, "utf8")); raw.payload.revision = 9; await writeFile(file, JSON.stringify(raw));
    await expect(store.get("session-a")).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("fences two repository instances and restored runtime generations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-execution-runtime-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-27T00:00:00.000Z" }); await coordinator.initialize("test");
    const first = new ExecutionRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" }); const second = new ExecutionRepository({ coordinator, now: () => "2026-08-27T00:00:00.000Z" }); const proc = procedure();
    const saved = await first.create({ session: session(), procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });
    const changed: ExecutionSession = { ...session(), results: [{ stepId: "mount", result: "confirmed", at: "2026-08-27T00:10:00.000Z", actor: "user", confirmedAgainstDependencyHash: hash("d") }] };
    const race = await Promise.allSettled([
      first.commit("session-a", { session: changed, procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1 }),
      second.commit("session-a", { session: changed, procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1 }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    await expect(first.create({ session: { ...session(), executionSessionId: "session-fenced" }, procedure: proc, dependencyContext: context(proc), leaseToken: "lease-next", leaseExpiresAt: "2026-08-27T01:00:00.000Z" })).rejects.toThrow(/maintenance lease/);
    const staging = await coordinator.createStagingGeneration(lease.token); await coordinator.activateStagingGeneration(staging, 1, lease.token);
    await expect(first.create({ session: { ...session(), executionSessionId: "session-old-generation" }, procedure: proc, dependencyContext: context(proc), leaseToken: "lease-next", leaseExpiresAt: "2026-08-27T01:00:00.000Z", runtimeGeneration: 1, maintenanceLeaseToken: lease.token })).rejects.toMatchObject({ code: "fenced" });
  });

  it("binds an ID to immutable identity and rejects mismatched commit IDs or identity mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-execution-")); roots.push(root);
    const store = new ExecutionRepository({ root, now: () => "2026-08-27T00:00:00.000Z", runtimeGeneration: () => 1 });
    const proc = procedure();
    const saved = await store.create({ session: session(), procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });
    await expect(store.create({ session: { ...session(), planVersionId: "version-other" }, procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.commit("session-other", { session: session(), procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.commit("session-a", { session: { ...session(), evaluationHash: hash("f") }, procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("prevents terminal reactivation and lease-expiry regression", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-execution-")); roots.push(root);
    const store = new ExecutionRepository({ root, now: () => "2026-08-27T00:00:00.000Z", runtimeGeneration: () => 1 });
    const proc = procedure();
    await expect(store.create({ session: { ...session(), executionSessionId: "session-expired" }, procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T00:00:00.000Z" })).rejects.toMatchObject({ code: "invalid_input" });
    const saved = await store.create({ session: session(), procedure: proc, dependencyContext: context(proc), leaseToken: "lease-current", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });
    await expect(store.commit("session-a", { session: session(), procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1, leaseExpiresAt: "2026-08-27T00:30:00.000Z" })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.commit("session-a", { session: session(), procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1, leaseExpiresAt: "2026-08-27T00:00:00.000Z" })).rejects.toMatchObject({ code: "invalid_input" });

    const completedSession: ExecutionSession = { ...session(), status: "completed", results: [{ stepId: "mount", result: "confirmed", at: "2026-08-27T00:10:00.000Z", actor: "user", confirmedAgainstDependencyHash: hash("d") }] };
    const completed = await store.commit("session-a", { session: completedSession, procedure: proc, dependencyContext: context(proc), expectedRevision: 0, expectedHash: saved.recordHash, leaseToken: "lease-current", runtimeGeneration: 1, leaseExpiresAt: "2026-08-27T02:00:00.000Z" });
    await expect(store.commit("session-a", { session: { ...completedSession, status: "active" }, procedure: proc, dependencyContext: context(proc), expectedRevision: 1, expectedHash: completed.recordHash, leaseToken: "lease-current", runtimeGeneration: 1, leaseExpiresAt: "2026-08-27T02:00:00.000Z" })).rejects.toMatchObject({ code: "conflict" });
  });
});
