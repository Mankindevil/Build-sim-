import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobRepository, quarantineRestoredJobs } from "../src/jobs/repository";

const digest = (letter: string) => letter.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("restored job quarantine", () => {
  it("advances generation, drops leases and never auto-runs restored nonterminal work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-job-restore-"));
    roots.push(root);
    let now = "2026-08-27T00:00:00.000Z";
    const repo = new FileJobRepository({ runtimeRoot: root, now: () => now, leaseToken: () => "old-lease" });
    await repo.initialize("test");
    const running = await repo.create({ type: "evidence.fetch", handlerVersion: "1", idempotencyKey: "running", inputHash: digest("a"), payloadRef: "artifact:a" });
    const queued = await repo.create({ type: "price.fetch", handlerVersion: "1", idempotencyKey: "queued", inputHash: digest("b"), payloadRef: "artifact:b" });
    const terminal = await repo.create({ type: "catalog.refresh", handlerVersion: "1", idempotencyKey: "terminal", inputHash: digest("c"), payloadRef: "artifact:c" });
    const firstClaim = await repo.claimNext("old-worker");
    expect(firstClaim).not.toBeNull();
    // Complete the second claim so one terminal record is present in the backup.
    const secondClaim = await repo.claimNext("finisher");
    expect(secondClaim).not.toBeNull();
    await repo.succeed(secondClaim!.job.jobId, secondClaim!.lease, [], digest("d"));
    const remaining = (await repo.list()).find((job) => job.status === "queued");
    expect(remaining).toBeDefined();

    const state = await repo.coordinator.readState();
    const oldActive = repo.coordinator.activeRoot(state);
    const lease = await repo.coordinator.acquireMaintenanceLease("restore-test");
    const staging = await repo.coordinator.createStagingGeneration(lease.token);
    await cp(path.join(oldActive, "jobs"), path.join(staging, "jobs"), { recursive: true, force: true });
    now = "2026-08-27T00:00:10.000Z";
    expect(await quarantineRestoredJobs(staging, 2, now)).toEqual({ restored: 2, terminal: 1 });
    await repo.coordinator.activateStagingGeneration(staging, 1, lease.token);
    await repo.coordinator.releaseMaintenanceLease(lease.token);

    const restoredRunning = await repo.get(firstClaim!.job.jobId);
    const restoredQueued = await repo.get(remaining!.jobId);
    const restoredTerminal = await repo.get(secondClaim!.job.jobId);
    expect(restoredRunning).toMatchObject({ status: "paused_restore_review", runtimeGeneration: 2 });
    expect(restoredRunning).not.toHaveProperty("leaseToken");
    expect(restoredQueued).toMatchObject({ status: "paused_restore_review", runtimeGeneration: 2 });
    expect(restoredTerminal).toMatchObject({ status: "succeeded", runtimeGeneration: 2 });
    await expect(repo.succeed(firstClaim!.job.jobId, firstClaim!.lease, [], digest("e"))).rejects.toMatchObject({ code: "fenced" });
    expect(await repo.claimNext("new-worker")).toBeNull();
    const approved = await repo.resume(restoredRunning.jobId, restoredRunning.revision);
    expect((await repo.claimNext("new-worker"))?.job.jobId).toBe(approved.jobId);
  });
});
