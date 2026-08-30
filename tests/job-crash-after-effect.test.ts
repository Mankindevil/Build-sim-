import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceStageRetryableError,
  createEvidenceJobWorker,
} from "../src/evidence/jobs/handlers";
import { EvidenceJobPipeline } from "../src/evidence/jobs/pipeline";
import { DurableJobScheduler } from "../src/jobs/worker";
import { evidenceRequest, evidenceRuntime, evidenceServices } from "./helpers/evidence-job-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("job crash after effect", () => {
  it("replays the stable checkpoint/idempotency key and deduplicates the already-written effect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-crash-effect-"));
    roots.push(root);
    let now = "2026-08-28T00:00:00.000Z";
    let token = 0;
    const first = await evidenceRuntime(root, { now: () => now, leaseToken: () => `lease-${++token}` });
    const descriptor = await new EvidenceJobPipeline(first).enqueue(evidenceRequest({ requestedAt: now }));
    const crashAfterEffect = evidenceServices({
      officialDiscovery: async (context) => {
        const effect = await context.putArtifact({
          kind: "evidence-official-discovery-effect",
          bytes: Buffer.from(`discovery:${context.idempotencyKey}`, "utf8"),
          mediaType: "application/octet-stream",
          privacyClass: "public_source",
        });
        if (effect.created) {
          throw new EvidenceStageRetryableError("worker_interrupted", "Worker stopped after the idempotent discovery effect");
        }
        return { status: "completed", output: { discoveryRef: effect.ref }, resultRefs: [effect.ref] };
      },
    });
    const firstRun = await createEvidenceJobWorker({ ...first, services: crashAfterEffect, workerId: "worker-before-crash", now: () => now }).runOnce();
    expect(firstRun.outcome).toBe("retry_scheduled");
    const waiting = await first.jobs.get(descriptor.jobIds.official_discovery);
    expect(waiting).toMatchObject({ status: "waiting_retry", attempt: 1 });
    expect(waiting.checkpointRef).toMatch(/^sha256:/);
    expect(Date.parse(waiting.runAfter)).toBeGreaterThan(Date.parse(now));

    // Simulate a fresh process. No service-side Map remembers the first call;
    // content addressing plus the durable attempt checkpoint supplies replay.
    const restarted = await evidenceRuntime(root, { now: () => now, leaseToken: () => `lease-${++token}` });
    now = waiting.runAfter;
    expect(await restarted.jobs.promoteReadyRetries()).toBe(1);
    const restartedPipeline = new EvidenceJobPipeline(restarted);
    const worker = createEvidenceJobWorker({ ...restarted, services: crashAfterEffect, workerId: "worker-after-crash", now: () => now });
    expect((await worker.runOnce()).outcome).toBe("succeeded");
    await new DurableJobScheduler(restarted.jobs, worker).drain(20);

    expect(await restartedPipeline.result(descriptor.pipelineId, "official_discovery")).toMatchObject({
      status: "completed",
      attemptStartedAt: "2026-08-28T00:00:00.000Z",
    });
    const artifactList = await restarted.repository.list();
    expect(artifactList.records.filter((record: { kind: string }) => record.kind === "evidence-official-discovery-effect")).toHaveLength(1);
    expect(Object.values(await restartedPipeline.jobsFor(descriptor.pipelineId)).every((job) => job.status === "succeeded")).toBe(true);
  });
});
