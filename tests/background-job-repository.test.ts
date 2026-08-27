import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobRepository } from "../src/jobs/repository";

const digest = (letter: string) => letter.repeat(64);
const roots: string[] = [];

async function repository(now = () => "2026-08-27T00:00:00.000Z") {
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-jobs-"));
  roots.push(root);
  const repo = new FileJobRepository({ runtimeRoot: root, now, leaseToken: () => "lease-token-1" });
  await repo.initialize("test");
  return { root, repo };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileJobRepository", () => {
  it("persists idempotent jobs and rejects key reuse with different input", async () => {
    const { root, repo } = await repository();
    const input = {
      type: "catalog.search", handlerVersion: "1", idempotencyKey: "catalog:sku-1",
      inputHash: digest("a"), payloadRef: "sha256:payload", maxAttempts: 2,
    };
    const first = await repo.create(input);
    const duplicate = await repo.create(input);
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ job: first.job, created: false });
    await expect(repo.create({ ...input, inputHash: digest("b") })).rejects.toMatchObject({ code: "conflict" });
    expect(await repo.list()).toHaveLength(1);

    const state = await repo.coordinator.readState();
    const record = path.join(repo.coordinator.activeRoot(state), "jobs", "records", `${first.job.jobId}.json`);
    expect((await stat(record)).mode & 0o777).toBe(0o600);
    expect(await readFile(record, "utf8")).not.toContain("api_key");
  });

  it("enforces dependencies, revision CAS, checkpointing and rollback evidence", async () => {
    const { repo } = await repository();
    const parent = (await repo.create({
      type: "evidence.fetch", handlerVersion: "1", idempotencyKey: "parent", inputHash: digest("a"), payloadRef: "artifact:parent",
    })).job;
    const child = (await repo.create({
      type: "price.capture", handlerVersion: "1", idempotencyKey: "child", inputHash: digest("b"), payloadRef: "artifact:child",
      dependencyJobIds: [parent.jobId],
    })).job;

    const parentClaim = await repo.claimNext("worker-a");
    expect(parentClaim?.job.jobId).toBe(parent.jobId);
    const checkpointed = await repo.checkpoint(parent.jobId, parentClaim!.lease, "sha256:checkpoint", { stage: "fetch", completed: 1, total: 2 });
    await expect(repo.heartbeat(parent.jobId, parentClaim!.lease)).rejects.toMatchObject({ code: "fenced" });
    await repo.succeed(parent.jobId, checkpointed.lease, ["sha256:result"], digest("c"));

    const childClaim = await repo.claimNext("worker-b");
    expect(childClaim?.job.jobId).toBe(child.jobId);
    const state = await repo.coordinator.readState();
    const rollbackDirectory = path.join(repo.coordinator.activeRoot(state), "jobs", "rollback", parent.jobId);
    expect((await readFile(path.join(rollbackDirectory, "000000000000.json"), "utf8"))).toContain("job-rollback-v1");
  });

  it("serializes two repository instances so only one worker leases a job", async () => {
    const { root, repo } = await repository();
    await repo.create({ type: "facts.refresh", handlerVersion: "1", idempotencyKey: "once", inputHash: digest("d"), payloadRef: "artifact:input" });
    let token = 1;
    const second = new FileJobRepository({ runtimeRoot: root, now: () => "2026-08-27T00:00:00.000Z", leaseToken: () => `lease-${++token}` });
    await second.initialize("test");
    const claims = await Promise.all([repo.claimNext("worker-a"), second.claimNext("worker-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await repo.get((claims.find(Boolean)!).job.jobId)).status).toBe("running");
  });

  it("ignores an uncommitted temp file and fails closed on a corrupt committed envelope", async () => {
    const { repo } = await repository();
    const created = await repo.create({ type: "doctor.scan", handlerVersion: "1", idempotencyKey: "integrity", inputHash: digest("e"), payloadRef: "artifact:doctor" });
    const state = await repo.coordinator.readState();
    const records = path.join(repo.coordinator.activeRoot(state), "jobs", "records");
    await writeFile(path.join(records, `${created.job.jobId}.partial.tmp`), "{", { mode: 0o600 });
    expect((await repo.list()).map((job) => job.jobId)).toEqual([created.job.jobId]);
    const committed = path.join(records, `${created.job.jobId}.json`);
    const parsed = JSON.parse(await readFile(committed, "utf8")) as { payload: { attempt: number } };
    parsed.payload.attempt = 99;
    await writeFile(committed, JSON.stringify(parsed), { mode: 0o600 });
    await expect(repo.get(created.job.jobId)).rejects.toMatchObject({ code: "corrupt_data" });
  });
});
