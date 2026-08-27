import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { doctorProcessExitCode, runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

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
});
