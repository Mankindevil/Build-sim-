import { chown, chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import {
  OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION,
  OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION,
  applyOwnershipBootstrapPlan,
  createOwnershipBootstrapPlan,
  readOwnershipBootstrapRollback,
  rollbackOwnershipBootstrap,
  validateOwnershipBootstrapPlan,
  validateOwnershipBootstrapRollback,
  writeOwnershipBootstrapArtifact,
} from "../src/runtime/ownership-bootstrap.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import { runOwnershipBootstrapCli } from "../scripts/runtime/bootstrap-access.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const now = () => "2026-08-30T15:00:00.000Z";

async function fixture(): Promise<{
  root: string;
  runtimeRoot: string;
  outputRoot: string;
  coordinator: RuntimeCoordinator;
  uid: number;
  gid: number;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-ownership-bootstrap-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const outputRoot = path.join(root, "operator-artifacts");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await chmod(outputRoot, 0o700);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
  const state = await coordinator.initialize("ownership-bootstrap-test");
  const activeRoot = coordinator.activeRoot(state);
  await mkdir(path.join(activeRoot, "plans", ".locks", "nested"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(activeRoot, "plans", ".locks", "nested", "lease.json"), "{}\n", { mode: 0o600 });
  await mkdir(path.join(runtimeRoot, "plans", ".agent-context-audit"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(runtimeRoot, "plans", ".agent-context-audit", "audit.json"), "{}\n", { mode: 0o600 });
  await mkdir(path.join(runtimeRoot, "transactions"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(runtimeRoot, "transactions", "transaction.json"), "{}\n", { mode: 0o600 });
  const currentUid = process.getuid?.() ?? 1000;
  const currentGid = process.getgid?.() ?? 1000;
  const uid = currentUid === 0 ? 1000 : currentUid;
  const gid = currentGid === 0 ? 1000 : currentGid;
  return { root, runtimeRoot, outputRoot, coordinator, uid, gid };
}

function resignPlan(value: Record<string, unknown>): Record<string, unknown> {
  const { contentHash: _contentHash, ...material } = value;
  return { ...material, contentHash: sha256Json({ domain: "runtime-ownership-bootstrap-plan", material }) };
}

function resignRollback(value: Record<string, unknown>): Record<string, unknown> {
  const { contentHash: _contentHash, ...material } = value;
  return { ...material, contentHash: sha256Json({ domain: "runtime-ownership-bootstrap-rollback", material }) };
}

describe("runtime ownership bootstrap", () => {
  it("plans without writes, persists only to an explicit private external file, then applies and rolls back exact metadata", async () => {
    const test = await fixture();
    const before = await test.coordinator.readState();
    const preview = await runOwnershipBootstrapCli([
      "--runtime-root", test.runtimeRoot, "--uid", String(test.uid), "--gid", String(test.gid),
    ], { now });
    expect(preview).toMatchObject({ mode: "plan", runtimeGeneration: 1, targetCount: 3, written: false });
    expect(await test.coordinator.readState()).toEqual(before);
    expect(await readFile(path.join(test.runtimeRoot, "control", "active-pointer.json"), "utf8")).toContain('"runtimeGeneration": 1');

    const planFile = path.join(test.outputRoot, "access-plan.json");
    const written = await runOwnershipBootstrapCli([
      "--runtime-root", test.runtimeRoot, "--uid", String(test.uid), "--gid", String(test.gid), "--output", planFile,
    ], { now });
    expect(written).toMatchObject({ mode: "plan", planHash: preview.planHash, written: true });
    expect((await lstat(planFile)).mode & 0o777).toBe(0o600);
    const plan = JSON.parse(await readFile(planFile, "utf8"));
    expect(validateOwnershipBootstrapPlan(plan)).toEqual([]);
    expect(plan.targets.map(({ relativePath }: { relativePath: string }) => relativePath)).toEqual([
      "generations/1/plans/.locks", "plans/.agent-context-audit", "transactions",
    ]);

    const rollbackFile = path.join(test.outputRoot, "access-rollback.json");
    const writer = vi.fn(async (target: string, uid: number, gid: number) => chown(target, uid, gid));
    const applied = await runOwnershipBootstrapCli([
      "--apply", "--runtime-root", test.runtimeRoot, "--plan", planFile, "--expected-plan-hash", plan.contentHash, "--rollback-output", rollbackFile,
      "--confirmation", OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION,
    ], { requirePrivileged: false, ownershipWriter: writer, now });
    if (!("entryCount" in applied)) throw new Error("expected apply result");
    expect(applied).toMatchObject({
      planHash: plan.contentHash,
      runtimeGeneration: 1,
      changedEntryCount: plan.targets.some(({ ownershipChangeRequired }: { ownershipChangeRequired: boolean }) => ownershipChangeRequired)
        ? expect.any(Number) : 0,
    });
    expect(applied.entryCount).toBeGreaterThan(3);
    expect(writer).toHaveBeenCalledTimes(applied.entryCount);
    const rollback = await readOwnershipBootstrapRollback(rollbackFile);
    expect(validateOwnershipBootstrapRollback(rollback)).toEqual([]);
    expect(rollback.entries).toHaveLength(applied.entryCount);
    expect((await lstat(rollbackFile)).mode & 0o777).toBe(0o600);

    const restored = await runOwnershipBootstrapCli([
      "--rollback", "--runtime-root", test.runtimeRoot, "--plan", planFile, "--expected-plan-hash", plan.contentHash,
      "--manifest", rollbackFile, "--expected-rollback-hash", rollback.contentHash,
      "--confirmation", OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION,
    ], { requirePrivileged: false, ownershipWriter: writer });
    expect(restored).toMatchObject({ planHash: plan.contentHash, rollbackHash: rollback.contentHash, restoredEntryCount: applied.entryCount });
    expect(await test.coordinator.readState()).toEqual(before);
    await chmod(planFile, 0o644);
    await expect(runOwnershipBootstrapCli([
      "--apply", "--runtime-root", test.runtimeRoot, "--plan", planFile,
      "--expected-plan-hash", plan.contentHash,
      "--rollback-output", path.join(test.outputRoot, "untrusted-rollback.json"),
      "--confirmation", OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION,
    ], { requirePrivileged: false, ownershipWriter: writer, now })).rejects.toThrow(/private permissions/);
  });

  it("rejects path escape, changed target identity and artifacts stored inside runtime", async () => {
    const test = await fixture();
    const plan = await createOwnershipBootstrapPlan({ runtimeRoot: test.runtimeRoot, targetUid: test.uid, targetGid: test.gid, now });
    const forged = structuredClone(plan) as unknown as Record<string, unknown>;
    (forged.targets as Array<Record<string, unknown>>)[0]!.relativePath = "../outside";
    const resigned = resignPlan(forged);
    expect(validateOwnershipBootstrapPlan(resigned)).toContain("ownership bootstrap target is invalid");
    const crossDevice = structuredClone(plan) as unknown as Record<string, unknown>;
    (crossDevice.targets as Array<Record<string, unknown>>)[0]!.device = "999999";
    expect(validateOwnershipBootstrapPlan(resignPlan(crossDevice))).toContain("ownership bootstrap target crosses the runtime device boundary");
    await expect(writeOwnershipBootstrapArtifact(path.join(test.runtimeRoot, "forbidden-plan.json"), plan, test.runtimeRoot))
      .rejects.toThrow(/outside the runtime root/);
    await expect(applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: "0".repeat(64),
      rollbackOutput: path.join(test.outputRoot, "wrong-hash-rollback.json"),
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false,
    })).rejects.toThrow(/expected plan hash mismatch/);

    const target = path.join(test.coordinator.activeRoot(await test.coordinator.readState()), "plans", ".locks");
    const moved = `${target}-old`;
    await rm(moved, { recursive: true, force: true });
    await rename(target, moved);
    await mkdir(target, { mode: 0o700 });
    const rollbackFile = path.join(test.outputRoot, "must-not-exist.json");
    await expect(applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollbackOutput: rollbackFile,
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false,
    })).rejects.toThrow(/target precondition changed/);
    await expect(lstat(rollbackFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks, hard links and checksum-correct rollback entry forgery before changing ownership", async () => {
    const test = await fixture();
    const plan = await createOwnershipBootstrapPlan({ runtimeRoot: test.runtimeRoot, targetUid: test.uid, targetGid: test.gid, now });
    const target = path.join(test.coordinator.activeRoot(await test.coordinator.readState()), "plans", ".locks");
    const outside = path.join(test.root, "outside.txt");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await symlink(outside, path.join(target, "linked"));
    const symlinkRollback = path.join(test.outputRoot, "symlink-rollback.json");
    const writer = vi.fn();
    await expect(applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollbackOutput: symlinkRollback,
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false, ownershipWriter: writer,
    })).rejects.toThrow(/symlinks and special files/);
    expect(writer).not.toHaveBeenCalled();
    await expect(lstat(symlinkRollback)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path.join(target, "linked"));

    await link(outside, path.join(target, "hard-linked"));
    await expect(applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollbackOutput: path.join(test.outputRoot, "hardlink-rollback.json"),
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false, ownershipWriter: writer,
    })).rejects.toThrow(/hard-linked files/);
    expect(writer).not.toHaveBeenCalled();
    await rm(path.join(target, "hard-linked"));

    const rollbackFile = path.join(test.outputRoot, "valid-rollback.json");
    await applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollbackOutput: rollbackFile,
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false,
      ownershipWriter: async (file: string, uid: number, gid: number) => chown(file, uid, gid), now,
    });
    const rollback = await readOwnershipBootstrapRollback(rollbackFile);
    const forged = structuredClone(rollback) as unknown as Record<string, unknown>;
    (forged.entries as Array<Record<string, unknown>>)[0]!.relativePath = "transactions/../outside";
    const resigned = resignRollback(forged);
    expect(validateOwnershipBootstrapRollback(resigned)).toContain("ownership bootstrap rollback entry is invalid");
    const foreignPlan = await createOwnershipBootstrapPlan({ runtimeRoot: test.runtimeRoot, targetUid: test.uid, targetGid: test.gid, now: () => "2026-08-30T15:01:00.000Z" });
    await expect(rollbackOwnershipBootstrap({
      runtimeRoot: test.runtimeRoot, plan: foreignPlan, expectedPlanHash: foreignPlan.contentHash, rollback, expectedRollbackHash: rollback.contentHash,
      confirmation: OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION, requirePrivileged: false,
    })).rejects.toThrow(/does not match its reviewed plan/);
    await expect(rollbackOwnershipBootstrap({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollback, expectedRollbackHash: "0".repeat(64),
      confirmation: OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION, requirePrivileged: false,
    })).rejects.toThrow(/expected manifest hash mismatch/);
  });

  it("rolls back already changed entries when the ownership writer fails mid-apply", async () => {
    const test = await fixture();
    const plan = await createOwnershipBootstrapPlan({ runtimeRoot: test.runtimeRoot, targetUid: test.uid, targetGid: test.gid, now });
    const rollbackFile = path.join(test.outputRoot, "fault-rollback.json");
    let calls = 0;
    const writer = vi.fn(async (target: string, uid: number, gid: number) => {
      calls += 1;
      if (calls === 2) throw new Error("fault after first ownership write");
      await chown(target, uid, gid);
    });
    await expect(applyOwnershipBootstrapPlan({
      runtimeRoot: test.runtimeRoot, plan, expectedPlanHash: plan.contentHash, rollbackOutput: rollbackFile,
      confirmation: OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION, requirePrivileged: false, ownershipWriter: writer, now,
    })).rejects.toThrow(/fault after first ownership write/);
    expect(writer.mock.calls.length).toBeGreaterThanOrEqual(3);
    const rollback = await readOwnershipBootstrapRollback(rollbackFile);
    for (const entry of rollback.entries) {
      const info = await lstat(path.join(test.runtimeRoot, entry.relativePath));
      expect({ uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 }).toEqual({ uid: entry.uid, gid: entry.gid, mode: entry.mode });
    }
  });
});
