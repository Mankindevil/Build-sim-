import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { executeApprovedRepair } from "../src/doctor/repair.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
const now = "2026-08-30T00:00:00.000Z";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 Doctor repair idempotency", () => {
  it("requires a runner-issued report and verified backup, then applies one effect for repeated approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-repair-once-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => now }); await coordinator.initialize("test");
    const backupFile = path.join(root, "pre-repair.backup");
    await createBackup({ coordinator, outputFile: backupFile, password: "doctor repair backup password", now: () => now });
    const verifiedBackup = await verifyBackup({ inputFile: backupFile, password: "doctor repair backup password", now: () => now });
    const doctorRun = await runDoctor({ coordinator, offline: true, now: () => now });
    const plan = {
      repairPlanId: "repair-once", reportHash: doctorRun.report.reportHash, doctorVersion: doctorRun.report.doctorVersion,
      checkRegistryVersion: doctorRun.report.checkRegistryVersion, runtimeGeneration: doctorRun.report.runtimeGeneration,
      actionIds: ["rebuild-derived-index"], impactSummary: "Rebuild a derived index from immutable authorities.",
      preconditionHashes: doctorRun.preconditionHashes, backupId: verifiedBackup.manifest.backupId,
      idempotencyKey: "repair-once-v1", approvedAt: now, rollbackRefs: ["backup:pre-repair"],
    };
    const committed = new Set<string>();
    const actionRunner = vi.fn(async () => undefined);
    const idempotencyStore = { has: async (key: string) => committed.has(key), mark: async (key: string) => { committed.add(key); } };
    await expect(executeApprovedRepair({ plan, doctorRun, verifiedBackup, allowRepair: true, coordinator, actionRunner, idempotencyStore }))
      .resolves.toEqual({ applied: true, rolledBack: false, errors: [] });
    await expect(executeApprovedRepair({ plan, doctorRun, verifiedBackup, allowRepair: true, coordinator, actionRunner, idempotencyStore }))
      .resolves.toEqual({ applied: false, idempotentReplay: true, errors: [] });
    expect(actionRunner).toHaveBeenCalledTimes(1);
  });
});
