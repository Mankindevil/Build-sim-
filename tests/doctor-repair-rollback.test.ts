import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { executeApprovedRepair } from "../src/doctor/repair.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { sha256Bytes } from "../src/runtime/fs.mjs";

const roots: string[] = [];
const now = "2026-08-30T00:00:00.000Z";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 Doctor repair rollback", () => {
  it("runs the exact rollback path and verifies the restored hash when a repair fails after writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-repair-rollback-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => now }); await coordinator.initialize("test");
    const target = path.join(root, "repair-target.txt"); const before = Buffer.from("before"); await writeFile(target, before);
    const backupFile = path.join(root, "pre-repair.backup");
    await createBackup({ coordinator, outputFile: backupFile, password: "doctor rollback backup password", now: () => now });
    const verifiedBackup = await verifyBackup({ inputFile: backupFile, password: "doctor rollback backup password", now: () => now });
    const doctorRun = await runDoctor({ coordinator, offline: true, now: () => now });
    const plan = {
      repairPlanId: "repair-rollback", reportHash: doctorRun.report.reportHash, doctorVersion: doctorRun.report.doctorVersion,
      checkRegistryVersion: doctorRun.report.checkRegistryVersion, runtimeGeneration: doctorRun.report.runtimeGeneration,
      actionIds: ["rewrite-derived-file"], impactSummary: "Rewrite a derived file and restore it on failure.",
      preconditionHashes: doctorRun.preconditionHashes, backupId: verifiedBackup.manifest.backupId,
      idempotencyKey: "repair-rollback-v1", approvedAt: now, rollbackRefs: [`sha256:${sha256Bytes(before)}`],
    };
    const result = await executeApprovedRepair({
      plan, doctorRun, verifiedBackup, allowRepair: true, coordinator,
      actionRunner: async () => { await writeFile(target, "after"); throw new Error("injected repair failure"); },
      rollbackRunner: async () => { await writeFile(target, before); },
      verifyRollback: async () => sha256Bytes(await readFile(target)) === sha256Bytes(before),
      idempotencyStore: { has: async () => false, mark: async () => { throw new Error("must not mark a failed repair"); } },
    });
    expect(result).toEqual({ applied: false, rolledBack: true, errors: ["repair failed; exact rollback was verified"] });
    expect(await readFile(target, "utf8")).toBe("before");
  });
});
