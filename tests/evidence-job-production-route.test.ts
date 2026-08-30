import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const NOW = "2026-08-28T14:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(extra: Record<string, unknown> = {}) {
  return {
    planId: "plan-http-evidence",
    subject: {
      brand: "ASUS",
      category: "motherboard",
      skuId: "sku-http-board",
      familyId: "family-http-board",
      modelId: "model-http-board",
      revision: "rev-a",
      region: "US",
    },
    requestedFieldIds: ["dimensions.width_mm"],
    entry: { kind: "search_query", query: "model http board manual" },
    allowThirdPartyFallback: false,
    requestedAt: NOW,
    ...extra,
  };
}

describe("production evidence job HTTP boundary", () => {
  it("exposes only enqueue/status/cancel/resume IDs and rejects a transport fetcher seam", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-route-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => NOW });
    await coordinator.initialize("evidence-route-test");
    let online = false;
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository: new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => NOW }),
      artifactRepository: new FileArtifactRepository({ coordinator, now: () => NOW }),
      online: () => online,
      now: () => NOW,
    });
    await runtime.initialize();
    const route = (method: string, pathname: string, body: unknown = {}) => handleWorkspaceRoute(
      method, pathname, body, {} as never, { evidenceJobs: runtime, evidenceJobsEnabled: true },
    );
    expect((await route("POST", "/api/workspace/evidence-jobs", input({ fetcher: "test-seam" }))).status).toBe(400);

    const enqueued = await route("POST", "/api/workspace/evidence-jobs", input());
    expect(enqueued.status).toBe(202);
    const descriptor = enqueued.payload as { pipelineId: string };
    expect((await runtime.tick()).worker.outcome).toBe("paused_offline");

    const statusResponse = await route("GET", `/api/workspace/evidence-jobs/${descriptor.pipelineId}`);
    expect(statusResponse.status).toBe(200);
    const status = statusResponse.payload as { stages: Array<{ stage: string; status: string; revision: number }> };
    const paused = status.stages[0]!;
    expect(paused).toMatchObject({ stage: "official_discovery", status: "paused_offline" });

    online = true;
    const resumedResponse = await route("POST", `/api/workspace/evidence-jobs/${descriptor.pipelineId}/resume`, {
      stage: paused.stage, expectedRevision: paused.revision,
    });
    expect(resumedResponse.status).toBe(200);
    const resumed = resumedResponse.payload as { revision: number; status: string };
    expect(resumed.status).toBe("queued");

    const cancelledResponse = await route("POST", `/api/workspace/evidence-jobs/${descriptor.pipelineId}/cancel`, {
      stage: paused.stage, expectedRevision: resumed.revision,
    });
    expect(cancelledResponse.status).toBe(200);
    expect(cancelledResponse.payload).toMatchObject({ status: "cancelled" });
  });

  it("is composed by the production repository factory only behind the durable-jobs flag", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-composition-"));
    roots.push(root);
    const disabled = createWorkspaceRepositories({ RUNTIME_ROOT: root });
    expect(disabled.evidenceJobs).toBeUndefined();
    expect((await handleWorkspaceRoute("POST", "/api/workspace/evidence-jobs", input(), disabled.repository, {
      evidenceJobsEnabled: false,
    })).status).toBe(404);

    const enabled = createWorkspaceRepositories({
      RUNTIME_ROOT: root,
      BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
      SEARXNG_BASE_URL: "http://127.0.0.1:18080",
      SEARXNG_TIMEOUT_MS: "12000",
      SEARXNG_RESULT_LIMIT: "4",
    });
    expect(enabled.evidenceJobs).toBeDefined();
    const evidenceJobs = enabled.evidenceJobs;
    if (!evidenceJobs) throw new Error("production evidence jobs were not composed");
    await evidenceJobs.initialize();
    expect((await handleWorkspaceRoute("POST", "/api/workspace/evidence-jobs", input(), enabled.repository, {
      evidenceJobs,
      evidenceJobsEnabled: true,
    })).status).toBe(202);

    expect(() => createWorkspaceRepositories({
      RUNTIME_ROOT: root,
      BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
      SEARXNG_BASE_URL: "http://search.example:8080",
    })).toThrow(/loopback/);
  });
});
