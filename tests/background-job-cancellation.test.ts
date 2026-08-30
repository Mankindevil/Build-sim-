import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceStageRetryableError,
  createEvidenceJobWorker,
} from "../src/evidence/jobs/handlers";
import { EvidenceJobPipeline } from "../src/evidence/jobs/pipeline";
import { currentJobLease } from "../src/jobs/repository";
import { evidenceRequest, evidenceRuntime, evidenceServices } from "./helpers/evidence-job-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("background job cancellation and offline control", () => {
  it("fences a cancelled worker after an immutable effect but before any active stage result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-cancel-"));
    roots.push(root);
    let lease = 0;
    const runtime = await evidenceRuntime(root, { leaseToken: () => `lease-${++lease}` });
    const pipeline = new EvidenceJobPipeline(runtime);
    const descriptor = await pipeline.enqueue(evidenceRequest());
    let entered!: () => void;
    let release!: () => void;
    const serviceEntered = new Promise<void>((resolve) => { entered = resolve; });
    const serviceReleased = new Promise<void>((resolve) => { release = resolve; });
    const services = evidenceServices({
      officialDiscovery: async (context) => {
        const artifact = await context.putArtifact({
          kind: "evidence-cancelled-worker-effect",
          bytes: Buffer.from("archived-but-never-activated", "utf8"),
          mediaType: "application/octet-stream",
        });
        entered();
        await serviceReleased;
        return { status: "completed", output: {}, resultRefs: [artifact.ref] };
      },
    });
    const worker = createEvidenceJobWorker({ ...runtime, services, workerId: "cancelled-worker" });
    const runningPromise = worker.runOnce();
    await serviceEntered;
    const running = await runtime.jobs.get(descriptor.jobIds.official_discovery);
    expect(running).toMatchObject({ status: "running", attempt: 1 });
    expect(running.checkpointRef).toMatch(/^sha256:/);
    await pipeline.cancelStage({
      pipelineId: descriptor.pipelineId,
      stage: "official_discovery",
      expectedRevision: running.revision,
      lease: currentJobLease(running),
    });
    release();
    expect((await runningPromise).outcome).toBe("fenced");
    expect((await runtime.jobs.get(running.jobId)).status).toBe("cancelled");
    expect(await pipeline.cancelRemaining(descriptor.pipelineId)).toBe(9);
    expect((await runtime.repository.list()).records.filter((record: { kind: string }) => record.kind === "evidence-cancelled-worker-effect")).toHaveLength(1);
    expect(await pipeline.result(descriptor.pipelineId, "official_discovery")).toBeNull();
  });

  it("rejects an offline transition from a stale revision/lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-stale-pause-"));
    roots.push(root);
    let lease = 0;
    const runtime = await evidenceRuntime(root, { leaseToken: () => `lease-${++lease}` });
    const pipeline = new EvidenceJobPipeline(runtime);
    const descriptor = await pipeline.enqueue(evidenceRequest());
    const claimed = await runtime.jobs.claimNext("stale-offline-worker", {
      types: ["evidence.official.discovery"],
    });
    expect(claimed).not.toBeNull();
    const current = await runtime.jobs.heartbeat(claimed!.job.jobId, claimed!.lease);
    await expect(runtime.jobs.pauseOffline(claimed!.job.jobId, claimed!.lease)).rejects.toMatchObject({ code: "fenced" });
    const paused = await runtime.jobs.pauseOffline(claimed!.job.jobId, current.lease);
    expect(paused).toMatchObject({ jobId: descriptor.jobIds.official_discovery, status: "paused_offline", attempt: 0 });
  });

  it("pauses offline without spending an attempt, resumes after restart, and keeps dead-letter terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-offline-"));
    roots.push(root);
    let online = false;
    let lease = 0;
    const first = await evidenceRuntime(root, { leaseToken: () => `lease-${++lease}` });
    const pipeline = new EvidenceJobPipeline({ ...first, maxAttempts: 1 });
    const descriptor = await pipeline.enqueue(evidenceRequest());
    const services = evidenceServices({
      officialDiscovery: async (context) => {
        if (!online) return context.pauseOffline();
        return { status: "completed", output: { officialUrl: "https://hardware.example/manual.pdf" } };
      },
    });
    expect((await createEvidenceJobWorker({ ...first, services, workerId: "offline-worker" }).runOnce()).outcome).toBe("paused_offline");
    const paused = await first.jobs.get(descriptor.jobIds.official_discovery);
    expect(paused).toMatchObject({ status: "paused_offline", attempt: 0 });

    online = true;
    const restarted = await evidenceRuntime(root, { leaseToken: () => `lease-${++lease}` });
    const restartedPipeline = new EvidenceJobPipeline({ ...restarted, maxAttempts: 1 });
    expect(await restartedPipeline.resumeOffline(descriptor.pipelineId)).toBe(1);
    expect((await createEvidenceJobWorker({ ...restarted, services, workerId: "online-worker" }).runOnce()).outcome).toBe("succeeded");
    expect(await restartedPipeline.cancelRemaining(descriptor.pipelineId)).toBe(9);

    const deadDescriptor = await restartedPipeline.enqueue(evidenceRequest({ requestedAt: "2026-08-28T00:00:01.000Z" }));
    const deadServices = evidenceServices({
      officialDiscovery: async () => { throw new EvidenceStageRetryableError("remote_unavailable", "Official source is temporarily unavailable"); },
    });
    const deadRun = await createEvidenceJobWorker({ ...restarted, services: deadServices, workerId: "dead-worker" }).runOnce();
    expect(deadRun.outcome).toBe("dead_letter");
    const dead = await restarted.jobs.get(deadDescriptor.jobIds.official_discovery);
    expect(dead.status).toBe("dead_letter");
    expect((await restarted.jobs.cancel(dead.jobId, dead.revision)).status).toBe("dead_letter");
    await expect(restarted.jobs.resume(dead.jobId, dead.revision)).rejects.toMatchObject({ code: "invalid_input" });
  });
});
