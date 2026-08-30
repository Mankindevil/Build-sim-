import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createBackup, persistBackupVerification, verifyBackup } from "../src/backup/runtime.mjs";
import { doctorProcessExitCode, runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { resolveDoctorRuntimeRoot } from "../scripts/doctor.mjs";

const run = promisify(execFile); const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U1 Doctor strict exit", () => {
  it("preserves frozen degraded/unhealthy exit codes and keeps strict skipped checks nonzero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-strict-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const result = await runDoctor({ coordinator, offline: true });
    expect(result.report.overall).toBe("degraded");
    expect(doctorProcessExitCode(result.report)).toBe(1);
    expect(doctorProcessExitCode(result.report, { strict: true })).toBe(1);
    await expect(run(process.execPath, ["scripts/doctor.mjs", "--runtime-root", root], { cwd: process.cwd() })).rejects.toMatchObject({ code: 1 });
    await expect(run(process.execPath, ["scripts/doctor.mjs", "--runtime-root", root, "--strict"], { cwd: process.cwd() })).rejects.toMatchObject({ code: 1 });
  });

  it("passes strict mode for an initialized runtime with current local capabilities and a fresh verified backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-strict-healthy-")); roots.push(root);
    const backupRoot = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-backup-")); roots.push(backupRoot);
    const backupFile = path.join(backupRoot, "strict.backup");
    const now = "2026-08-30T09:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    await coordinator.initialize("0.2.0-alpha");
    await new FileArtifactRepository({ coordinator, now: () => now }).initialize();
    await createBackup({ coordinator, outputFile: backupFile, password: "strict doctor backup password", now: () => now });
    const verification = await verifyBackup({ inputFile: backupFile, password: "strict doctor backup password", now: () => now });
    await persistBackupVerification({ coordinator, verification });

    const result = await runDoctor({
      coordinator,
      strict: true,
      offline: false,
      now: () => now,
      referenceClockMs: Date.parse(now),
      serviceVersionsVerified: true,
      browserWebglAvailable: true,
      searxngAvailable: true,
      pdfParserAvailable: true,
    });

    expect(result.report.overall).toBe("healthy");
    expect(result.report.checks.every((check: { status: string }) => check.status === "pass")).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(doctorProcessExitCode(result.report, { strict: true })).toBe(0);
  });

  it("uses RUNTIME_ROOT when --runtime-root is omitted without initializing or writing the runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-default-root-")); roots.push(root);
    const executionRoot = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-cwd-")); roots.push(executionRoot);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("0.2.0-alpha");
    expect(resolveDoctorRuntimeRoot([], { RUNTIME_ROOT: root }, executionRoot)).toBe(root);
    expect(resolveDoctorRuntimeRoot([], {}, executionRoot)).toBe(path.join(executionRoot, "runtime"));
    expect(resolveDoctorRuntimeRoot(["--runtime-root", root], {}, executionRoot)).toBe(root);
    expect((await coordinator.readState()).revision).toBe(0);
  });
});
