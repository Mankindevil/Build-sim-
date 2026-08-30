import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceJobWorker, type EvidencePipelineServices } from "../src/evidence/jobs/handlers";
import { EvidenceJobPipeline } from "../src/evidence/jobs/pipeline";
import { evidenceRequest, evidenceRuntime, evidenceServices } from "./helpers/evidence-job-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("background job idempotency", () => {
  it("deduplicates concurrent pipeline enqueue and permits only one side effect per stage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-idempotency-"));
    roots.push(root);
    let lease = 0;
    const runtime = await evidenceRuntime(root, { leaseToken: () => `lease-${++lease}` });
    const pipeline = new EvidenceJobPipeline(runtime);
    const [first, duplicate] = await Promise.all([
      pipeline.enqueue(evidenceRequest()),
      pipeline.enqueue(evidenceRequest()),
    ]);
    expect(duplicate).toEqual(first);
    expect(await runtime.jobs.list()).toHaveLength(10);

    const calls = new Map<keyof EvidencePipelineServices, number>();
    const base = evidenceServices();
    const counted = Object.fromEntries(Object.entries(base).map(([name, service]) => [name, async (...args: Parameters<typeof service>) => {
      calls.set(name as keyof EvidencePipelineServices, (calls.get(name as keyof EvidencePipelineServices) ?? 0) + 1);
      return service(...args);
    }])) as unknown as EvidencePipelineServices;
    const workers = ["a", "b"].map((workerId) => createEvidenceJobWorker({ ...runtime, services: counted, workerId }));
    for (let index = 0; index < 12; index += 1) await Promise.all(workers.map((worker) => worker.runOnce()));

    const jobs = await pipeline.jobsFor(first.pipelineId);
    expect(Object.values(jobs).every((job) => job.status === "succeeded")).toBe(true);
    // Fallback is deterministically skipped because official extraction succeeded.
    expect([...calls.entries()].filter(([name]) => name !== "thirdPartyFallback").every(([, count]) => count === 1)).toBe(true);
    expect(calls.get("thirdPartyFallback") ?? 0).toBe(0);

    const restarted = await evidenceRuntime(root);
    expect(await new EvidenceJobPipeline(restarted).enqueue(evidenceRequest())).toEqual(first);
    expect(await restarted.jobs.list()).toHaveLength(10);

    const governed = {
      bytes: Buffer.from("artifact-dedup-regression", "utf8"),
      mediaType: "application/octet-stream",
      privacyClass: "runtime_internal" as const,
      kind: "evidence-dedup-regression",
      references: [],
    };
    expect((await restarted.repository.put(governed)).created).toBe(true);
    expect((await restarted.repository.put(governed)).created).toBe(false);
    await expect(restarted.repository.put({ ...governed, kind: "evidence-forged-metadata" })).rejects.toMatchObject({ code: "conflict" });
    expect((await restarted.repository.list()).records.filter((record: { kind: string }) => record.kind === governed.kind)).toHaveLength(1);
  });
});
