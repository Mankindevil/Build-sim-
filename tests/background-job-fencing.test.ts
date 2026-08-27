import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobRepository } from "../src/jobs/repository";

const digest = (letter: string) => letter.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("job fencing", () => {
  it("rejects stale revision, token, expiry and old-generation commits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-job-fence-"));
    roots.push(root);
    let now = "2026-08-27T00:00:00.000Z";
    let token = 0;
    const repo = new FileJobRepository({ runtimeRoot: root, now: () => now, leaseToken: () => `lease-${++token}`, leaseDurationMs: 2_000 });
    await repo.initialize("test");
    const created = await repo.create({ type: "facts.resolve", handlerVersion: "1", idempotencyKey: "fenced", inputHash: digest("a"), payloadRef: "artifact:input" });
    const claim = await repo.claimNext("worker-a");
    expect(claim).not.toBeNull();
    const heartbeat = await repo.heartbeat(created.job.jobId, claim!.lease);
    await expect(repo.succeed(created.job.jobId, claim!.lease, [], digest("b"))).rejects.toMatchObject({ code: "fenced" });
    await expect(repo.succeed(created.job.jobId, { ...heartbeat.lease, leaseToken: "attacker" }, [], digest("b"))).rejects.toMatchObject({ code: "fenced" });

    now = "2026-08-27T00:00:03.000Z";
    await expect(repo.succeed(created.job.jobId, heartbeat.lease, [], digest("b"))).rejects.toMatchObject({ code: "fenced" });
    expect(await repo.recoverExpiredLeases()).toBe(1);
    expect(await repo.promoteReadyRetries()).toBe(1);
    const newClaim = await repo.claimNext("worker-b");
    await expect(repo.succeed(created.job.jobId, heartbeat.lease, [], digest("c"))).rejects.toMatchObject({ code: "fenced" });
    const committed = await repo.succeed(created.job.jobId, newClaim!.lease, [], digest("d"));
    expect(committed.status).toBe("succeeded");
    await expect(repo.succeed(created.job.jobId, {
      expectedRevision: 0, leaseToken: "forged-terminal-retry", runtimeGeneration: 999,
    }, committed.resultRefs, committed.resultCommitHash!)).rejects.toMatchObject({ code: "fenced" });
  });

  it("pauses network jobs offline and requires an explicit resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-job-offline-"));
    roots.push(root);
    const repo = new FileJobRepository({ runtimeRoot: root, now: () => "2026-08-27T00:00:00.000Z" });
    await repo.initialize("test");
    const created = await repo.create({ type: "price.search", handlerVersion: "1", idempotencyKey: "offline", inputHash: digest("e"), payloadRef: "artifact:input", networkRequired: true });
    expect(await repo.claimNext("worker", { online: false })).toBeNull();
    const paused = await repo.get(created.job.jobId);
    expect(paused.status).toBe("paused_offline");
    await repo.resume(paused.jobId, paused.revision);
    expect((await repo.claimNext("worker", { online: true }))?.job.status).toBe("running");
  });
});
