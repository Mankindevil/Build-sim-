import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogSearchJobRepository } from "../scripts/price-server/catalog/catalog-job-repository.mjs";

const roots: string[] = [];
const digest = (letter: string) => letter.repeat(64);

async function repository(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-catalog-jobs-"));
  roots.push(root);
  const repo = new CatalogSearchJobRepository({ persistRoot: root, now: () => "2026-08-27T00:00:00.000Z", leaseToken: () => "catalog-lease-1", ...options });
  await repo.initialize("test");
  return { root, repo };
}

async function create(repo: CatalogSearchJobRepository, idempotencyKey = "catalog durable once") {
  const inputHash = digest("a");
  return repo.create({
    jobId: `catalog-search-${digest("b").slice(0, 20)}`,
    idempotencyKey,
    inputHash,
    payloadRef: `catalog-search-payload:${inputHash}`,
    catalog: { query: { raw: "Durable Board", normalized: "Durable Board" }, limit: 1 },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable catalog search jobs", () => {
  it("keeps terminal jobs and candidates discoverable after a process restart", async () => {
    const { root, repo } = await repository();
    const created = await create(repo);
    const claim = await repo.claimNext("worker-a");
    const candidate = { candidateId: "catalog-candidate-0123456789abcdef", title: "Durable Board", extraction: { status: "ok" } };
    await repo.complete(created.record.job.jobId, claim!.fence, { status: "completed", candidates: [candidate], summary: { exact: 1 } });

    const restarted = new CatalogSearchJobRepository({ persistRoot: root, now: () => "2026-08-27T00:01:00.000Z", restoreReview: true });
    await restarted.initialize("test");
    expect((await restarted.get(created.record.job.jobId)).job.status).toBe("succeeded");
    expect(await restarted.findCandidate(candidate.candidateId)).toEqual(candidate);
    const state = await restarted.coordinator.readState();
    const recordPath = path.join(restarted.coordinator.activeRoot(state), "jobs", "catalog-search", "records", `${created.record.job.jobId}.json`);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it("quarantines every non-terminal record after restart rather than auto-running it", async () => {
    const { root, repo } = await repository();
    const created = await create(repo);
    await repo.claimNext("worker-a");
    const restarted = new CatalogSearchJobRepository({ persistRoot: root, now: () => "2026-08-27T00:01:00.000Z", restoreReview: true });
    await restarted.initialize("test");
    const restored = (await restarted.get(created.record.job.jobId)).job;
    expect(restored.status).toBe("paused_restore_review");
    expect(restored.leaseToken).toBeUndefined();
    expect(await restarted.claimNext("worker-b")).toBeNull();
  });

  it("allows one worker to claim and fences stale state commits", async () => {
    const { root, repo } = await repository({ leaseToken: () => "lease-a" });
    const created = await create(repo);
    const second = new CatalogSearchJobRepository({ persistRoot: root, now: () => "2026-08-27T00:00:00.000Z", leaseToken: () => "lease-b" });
    await second.initialize("test");
    const claims = await Promise.all([repo.claimNext("worker-a"), second.claimNext("worker-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    const advanced = await repo.checkpoint(created.record.job.jobId, claim.fence, { stage: "fetch", progress: { stage: "fetch", completed: 1, total: 1 } });
    await expect(second.complete(created.record.job.jobId, claim.fence, { status: "completed", candidates: [] })).rejects.toMatchObject({ code: "fenced" });
    await repo.complete(created.record.job.jobId, advanced.fence, { status: "completed", candidates: [] });
    expect((await repo.get(created.record.job.jobId)).job.status).toBe("succeeded");
  });

  it("renews a long-running worker lease at durable checkpoints", async () => {
    let current = "2026-08-27T00:00:00.000Z";
    const { repo } = await repository({ now: () => current, leaseDurationMs: 30_000 });
    const created = await create(repo, "catalog renewable lease");
    const claim = await repo.claimNext("worker-a");
    expect(claim?.record.job.leaseExpiresAt).toBe("2026-08-27T00:00:30.000Z");

    current = "2026-08-27T00:00:20.000Z";
    const renewed = await repo.checkpoint(created.record.job.jobId, claim!.fence, { stage: "fetch" });
    expect(renewed.record.job.leaseExpiresAt).toBe("2026-08-27T00:00:50.000Z");

    // This commit is after the original lease but before the renewed lease.
    current = "2026-08-27T00:00:35.000Z";
    await expect(repo.complete(created.record.job.jobId, renewed.fence, { status: "completed", candidates: [] })).resolves.toBeDefined();
  });
});
