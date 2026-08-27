import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobRepository } from "../src/jobs/repository";
import { DurableJobScheduler, DurableJobWorker, JobHandlerError } from "../src/jobs/worker";

const digest = (letter: string) => letter.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable job restart", () => {
  it("recovers expired work after restart without accepting the stale lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-job-restart-"));
    roots.push(root);
    let now = "2026-08-27T00:00:00.000Z";
    let token = 0;
    const options = { runtimeRoot: root, now: () => now, leaseToken: () => `lease-${++token}`, leaseDurationMs: 1_000 };
    const first = new FileJobRepository(options);
    await first.initialize("test");
    const created = await first.create({ type: "price.refresh", handlerVersion: "1", idempotencyKey: "restart-once", inputHash: digest("a"), payloadRef: "artifact:payload", maxAttempts: 3 });
    const stale = await first.claimNext("worker-old");
    await first.checkpoint(created.job.jobId, stale!.lease, "artifact:checkpoint");

    now = "2026-08-27T00:00:02.000Z";
    const restarted = new FileJobRepository(options);
    await restarted.initialize("test");
    expect((await restarted.get(created.job.jobId)).checkpointRef).toBe("artifact:checkpoint");
    expect(await restarted.recoverExpiredLeases()).toBe(1);
    expect(await restarted.promoteReadyRetries()).toBe(1);
    const fresh = await restarted.claimNext("worker-new");
    expect(fresh?.job).toMatchObject({ attempt: 2, leaseOwner: "worker-new" });
    await expect(first.succeed(created.job.jobId, stale!.lease, [], digest("b"))).rejects.toMatchObject({ code: "fenced" });
    await restarted.succeed(created.job.jobId, fresh!.lease, ["artifact:result"], digest("c"));
    expect((await restarted.create({ type: "price.refresh", handlerVersion: "1", idempotencyKey: "restart-once", inputHash: digest("a"), payloadRef: "artifact:payload", maxAttempts: 3 })).created).toBe(false);
  });

  it("runs versioned handlers with durable checkpoints and redacted retry state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-job-worker-"));
    roots.push(root);
    let now = "2026-08-27T00:00:00.000Z";
    const repo = new FileJobRepository({ runtimeRoot: root, now: () => now, leaseToken: () => "worker-lease", leaseDurationMs: 10_000 });
    await repo.initialize("test");
    const created = await repo.create({ type: "evidence.capture", handlerVersion: "2", idempotencyKey: "handler-once", inputHash: digest("d"), payloadRef: "artifact:input" });
    let calls = 0;
    const worker = new DurableJobWorker({
      repository: repo, workerId: "worker",
      handlers: {
        "evidence.capture@2": async (context) => {
          calls += 1;
          await context.checkpoint("artifact:downloaded", { stage: "capture", completed: 1, total: 1 });
          return { resultRefs: ["artifact:evidence"], resultCommitHash: digest("e") };
        },
      },
    });
    const scheduler = new DurableJobScheduler(repo, worker);
    expect((await scheduler.tick()).worker.outcome).toBe("succeeded");
    expect(calls).toBe(1);
    expect(await repo.get(created.job.jobId)).toMatchObject({ status: "succeeded", checkpointRef: "artifact:downloaded" });
    expect((await scheduler.tick()).worker.outcome).toBe("idle");

    now = "2026-08-27T00:01:00.000Z";
    const retry = await repo.create({ type: "catalog.search", handlerVersion: "1", idempotencyKey: "retry", inputHash: digest("f"), payloadRef: "artifact:retry" });
    const retryWorker = new DurableJobWorker({
      repository: repo, workerId: "retry-worker",
      handlers: new Map([["catalog.search@1", async () => { throw new JobHandlerError("temporary", "Remote catalog is temporarily unavailable", true, now); }]]),
    });
    expect((await retryWorker.runOnce()).outcome).toBe("retry_scheduled");
    expect(await repo.get(retry.job.jobId)).toMatchObject({ status: "waiting_retry", lastError: { redacted: true } });
  });
});
