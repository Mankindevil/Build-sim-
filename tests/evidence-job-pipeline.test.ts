import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceClaim } from "../src/evidence/claims";
import {
  createEvidenceSearchAttempt,
  createEvidenceSearchOutcome,
} from "../src/evidence/search-outcome.mjs";
import { EVIDENCE_PIPELINE_STAGES } from "../src/evidence/jobs/contracts";
import { createEvidenceJobWorker } from "../src/evidence/jobs/handlers";
import { EvidenceJobPipeline } from "../src/evidence/jobs/pipeline";
import { DurableJobScheduler } from "../src/jobs/worker";
import {
  FIXED_NOW,
  claimCandidate,
  evidenceRequest,
  evidenceRuntime,
  evidenceServices,
  thirdPartyClosure,
} from "./helpers/evidence-job-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable evidence job pipeline", () => {
  it("runs official discovery through binding as a restart-safe governed DAG", async () => {
    await expect(createEvidenceClaim(claimCandidate("official"))).resolves.toMatchObject({ authority: "official" });
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-pipeline-"));
    roots.push(root);
    const first = await evidenceRuntime(root);
    const pipeline = new EvidenceJobPipeline(first);
    const descriptor = await pipeline.enqueue(evidenceRequest());
    const worker = createEvidenceJobWorker({ ...first, services: evidenceServices(), workerId: "evidence-worker-a" });
    const scheduler = new DurableJobScheduler(first.jobs, worker);

    for (let index = 0; index < 5; index += 1) expect((await scheduler.tick()).worker.outcome).toBe("succeeded");

    // A new process has no in-memory pipeline map; request, dependency and
    // checkpoint authority is reconstructed solely from jobs + artifacts.
    const restarted = await evidenceRuntime(root);
    const restartedPipeline = new EvidenceJobPipeline(restarted);
    const restartedWorker = createEvidenceJobWorker({ ...restarted, services: evidenceServices(), workerId: "evidence-worker-b" });
    const results = await new DurableJobScheduler(restarted.jobs, restartedWorker).drain(20);
    expect(results.filter((result) => result.worker.outcome === "succeeded")).toHaveLength(5);

    const jobs = await restartedPipeline.jobsFor(descriptor.pipelineId);
    expect(EVIDENCE_PIPELINE_STAGES.map((stage) => jobs[stage].status)).toEqual(Array(10).fill("succeeded"));
    expect(await restartedPipeline.result(descriptor.pipelineId, "claim_extraction")).toMatchObject({
      status: "completed",
      output: { claimCandidates: [{ authority: "official" }] },
    });
    expect(await restartedPipeline.result(descriptor.pipelineId, "third_party_fallback")).toMatchObject({
      status: "skipped",
      output: { reason: "official_evidence_sufficient" },
    });
    expect(await restartedPipeline.result(descriptor.pipelineId, "fact_impact")).toMatchObject({ status: "completed" });
    expect(await restartedPipeline.result(descriptor.pipelineId, "adapter_generation")).toMatchObject({ status: "completed" });
    expect(await restartedPipeline.result(descriptor.pipelineId, "binding_proposal")).toMatchObject({ status: "completed" });

    const acquisition = await restartedPipeline.result(descriptor.pipelineId, "official_acquisition");
    await restarted.repository.quarantine(acquisition!.resultRefs[0]);
    await expect(restartedPipeline.result(descriptor.pipelineId, "official_acquisition")).rejects.toThrow(/dangling artifact/);
  });

  it("audits an official failure before accepting a third-party candidate and never relabels its authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-fallback-"));
    roots.push(root);
    const runtime = await evidenceRuntime(root);
    const pipeline = new EvidenceJobPipeline(runtime);
    const descriptor = await pipeline.enqueue(evidenceRequest());
    const attempt = createEvidenceSearchAttempt({
      authority: "official",
      stage: "discovery",
      result: "not_published",
      officialUrl: "https://hardware.example/manual.pdf",
      evidenceRefs: [],
      detail: "The manufacturer does not publish this field for the exact revision.",
      attemptedAt: FIXED_NOW,
    });
    const searchOutcome = createEvidenceSearchOutcome({
      subject: { kind: "product", skuId: "sku-universal-board-1", revision: "rev-a", region: "CN" },
      field: "dimensions.width_mm",
      attempts: [attempt],
      exhaustive: true,
      detail: "Official discovery was exhausted without a published document.",
      manualAction: "Confirm the exact revision or provide a manufacturer document.",
      searchedAt: FIXED_NOW,
    });
    let fallbackCalls = 0;
    const services = evidenceServices({
      officialDiscovery: async () => ({
        status: "needs_review",
        output: { searchOutcome },
        officialSearchReason: searchOutcome.reason,
      }),
      thirdPartyFallback: async () => {
        fallbackCalls += 1;
        return { status: "completed", output: { claimCandidates: [claimCandidate("third_party")], ...thirdPartyClosure() } };
      },
    });
    const scheduler = new DurableJobScheduler(runtime.jobs, createEvidenceJobWorker({
      ...runtime, services, workerId: "evidence-fallback-worker",
    }));
    await scheduler.drain(20);

    expect(fallbackCalls).toBe(1);
    expect(await pipeline.result(descriptor.pipelineId, "official_acquisition")).toMatchObject({
      status: "skipped",
      officialSearchReason: "official_not_published",
    });
    expect(await pipeline.result(descriptor.pipelineId, "third_party_fallback")).toMatchObject({
      status: "completed",
      output: { claimCandidates: [{ authority: "third_party" }] },
    });
  });
});
