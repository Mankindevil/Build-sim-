import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createBackup, restoreBackup } from "../src/backup/runtime.mjs";
import { FileJobRepository } from "../src/jobs/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
const now = "2026-08-30T00:00:00.000Z";
const digest = (letter: string): string => letter.repeat(64);

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 restore generation fencing", () => {
  it("preserves the pointer on failed restore and fences every pre-restore job lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-restore-generation-fencing-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    await coordinator.initialize("test");
    const artifacts = new FileArtifactRepository({ coordinator, now: () => now });
    const payload = await artifacts.put({
      bytes: Buffer.from("restore fencing input", "utf8"),
      mediaType: "application/json",
      privacyClass: "runtime_internal",
      kind: "job-payload",
      references: [],
    });
    const jobs = new FileJobRepository({ coordinator, now: () => now, leaseToken: () => "pre-restore-lease" });
    const created = await jobs.create({
      type: "fixture.restore-fence", handlerVersion: "1", idempotencyKey: "restore-fence",
      inputHash: digest("a"), payloadRef: payload.record.ref,
    });
    const claimed = await jobs.claimNext("pre-restore-worker");
    expect(claimed?.job.jobId).toBe(created.job.jobId);

    const backup = path.join(root, "generation-fence.buildsim-backup");
    const password = "generation fencing password";
    await createBackup({ coordinator, outputFile: backup, password, now: () => now });
    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: backup, password, now: () => now,
      beforePointerSwitch: () => { throw new Error("injected before pointer switch"); },
    })).rejects.toThrow("injected before pointer switch");
    expect(await coordinator.readState()).toEqual(before);

    const restored = await restoreBackup({ coordinator, inputFile: backup, password, now: () => now });
    expect(restored.state.runtimeGeneration).toBeGreaterThan(before.runtimeGeneration);
    await expect(jobs.succeed(created.job.jobId, claimed!.lease, [], digest("b"))).rejects.toMatchObject({ code: "fenced" });
    const quarantined = await jobs.get(created.job.jobId);
    expect(quarantined).toMatchObject({
      status: "paused_restore_review",
      runtimeGeneration: restored.state.runtimeGeneration,
    });
    expect(quarantined).not.toHaveProperty("leaseOwner");
    expect(quarantined).not.toHaveProperty("leaseToken");
  });
});
