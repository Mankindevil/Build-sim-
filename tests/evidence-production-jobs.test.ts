import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const NOW = "2026-08-28T12:00:00.000Z";
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function request(overrides: Record<string, unknown> = {}) {
  return {
    planId: "plan-production-evidence",
    subject: {
      brand: "ASUS",
      category: "motherboard",
      skuId: "sku-board-production",
      familyId: "family-board-production",
      modelId: "model-board-production",
      variantId: "variant-board-production",
      revision: "rev-a",
      region: "US",
    },
    requestedFieldIds: ["dimensions.width_mm"],
    entry: { kind: "search_query", query: "model board production manual" },
    allowThirdPartyFallback: false,
    requestedAt: NOW,
    ...overrides,
  };
}

async function repositories(root: string) {
  const coordinator = new RuntimeCoordinator({ root, now: () => NOW });
  await coordinator.initialize("evidence-production-test");
  return {
    coordinator,
    evidenceRepository: new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => NOW }),
    artifactRepository: new FileArtifactRepository({ coordinator, now: () => NOW }),
  };
}

function officialFetcher(options: { deferAcquisition?: Promise<void>; onAcquisition?: () => void } = {}) {
  const documentUrl = "https://dlcdnets.asus.com/pub/ASUS/mb/manual/model-board-production-manual.pdf";
  const bytes = Buffer.from("dimensions.width_mm 244 mm\ninterfaces.pcie_slots 4", "utf8");
  return async (url: string, input: { includeBody?: boolean }) => {
    if (input.includeBody === true) {
      options.onAcquisition?.();
      await options.deferAcquisition;
      return {
        status: 200,
        finalUrl: documentUrl,
        redirects: [],
        rawBody: bytes,
        body: bytes.toString("utf8"),
        contentType: "text/plain",
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        retrievedAt: NOW,
      };
    }
    return {
      status: 200,
      finalUrl: url,
      redirects: [],
      body: `<a href="${documentUrl}">model board production manual</a>`,
      contentType: "text/html",
      retrievedAt: NOW,
    };
  };
}

const noWaitLimiter = Object.freeze({ acquire: async () => undefined });

describe("production durable evidence jobs", () => {
  it("archives official bytes, stops honestly at review, and replays idempotently after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-production-"));
    roots.push(root);
    const stores = await repositories(root);
    const first = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => true,
      now: () => NOW,
      officialFetcher: officialFetcher(),
      rateLimiter: noWaitLimiter,
    });
    await first.initialize();
    const descriptor = await first.enqueue(request());
    await first.scheduler.drain(20);

    const status = await first.status(descriptor.pipelineId);
    expect(status.stages.map((entry) => entry.status)).toEqual(Array(10).fill("succeeded"));
    expect(status.stages.find((entry) => entry.stage === "archive")?.result).toMatchObject({ status: "completed" });
    expect(status.stages.find((entry) => entry.stage === "excerpt")?.result).toMatchObject({ status: "completed" });
    expect(status.stages.find((entry) => entry.stage === "claim_extraction")?.result).toMatchObject({
      status: "needs_review",
      officialSearchReason: "official_page_found_field_missing",
    });
    expect(status.stages.find((entry) => entry.stage === "adapter_generation")?.result).toMatchObject({ status: "blocked" });

    const acquisition = status.stages.find((entry) => entry.stage === "official_acquisition")?.result;
    const documentId = acquisition?.output.documentId as string;
    expect((await stores.evidenceRepository.getDocumentContent(documentId))?.bytes.toString("utf8")).toContain("dimensions.width_mm");

    const restartedStores = await repositories(root);
    const restarted = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...restartedStores,
      online: () => true,
      now: () => NOW,
      officialFetcher: officialFetcher(),
      rateLimiter: noWaitLimiter,
    });
    await restarted.initialize();
    const replayed = await restarted.enqueue(request());
    expect(replayed).toEqual(descriptor);
    expect((await restarted.scheduler.drain(20)).at(-1)?.worker.outcome).toBe("idle");
    expect(await restarted.status(descriptor.pipelineId)).toEqual(status);
  });

  it("pauses offline without spending an attempt, then resumes under an optimistic revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-offline-"));
    roots.push(root);
    const stores = await repositories(root);
    let online = false;
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => online,
      now: () => NOW,
      officialFetcher: officialFetcher(),
      rateLimiter: noWaitLimiter,
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request());
    expect((await runtime.tick()).worker.outcome).toBe("paused_offline");
    const paused = (await runtime.status(descriptor.pipelineId)).stages[0]!;
    expect(paused).toMatchObject({ stage: "official_discovery", status: "paused_offline", attempt: 0 });

    online = true;
    const resumed = await runtime.resume({ pipelineId: descriptor.pipelineId, stage: paused.stage, expectedRevision: paused.revision });
    expect(resumed).toMatchObject({ status: "queued", attempt: 0 });
    expect((await runtime.tick()).worker.outcome).toBe("succeeded");
  });

  it("turns a mid-attempt network loss into an attempt-neutral durable offline pause", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-network-loss-"));
    roots.push(root);
    const stores = await repositories(root);
    let healthy = false;
    const successful = officialFetcher();
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => true,
      now: () => NOW,
      officialFetcher: async (url: string, options: { includeBody?: boolean }) => {
        if (!healthy) throw new Error("ENETUNREACH: network is unreachable");
        return successful(url, options);
      },
      rateLimiter: noWaitLimiter,
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request());
    expect((await runtime.tick()).worker.outcome).toBe("paused_offline");
    const paused = (await runtime.status(descriptor.pipelineId)).stages[0]!;
    expect(paused).toMatchObject({ status: "paused_offline", attempt: 0 });
    healthy = true;
    await runtime.resume({ pipelineId: descriptor.pipelineId, stage: paused.stage, expectedRevision: paused.revision });
    expect((await runtime.tick()).worker.outcome).toBe("succeeded");
  });

  it("schedules a bounded durable backoff for transient service failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-retry-"));
    roots.push(root);
    const stores = await repositories(root);
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => true,
      now: () => NOW,
      officialFetcher: async () => { throw new Error("temporary service unavailable"); },
      rateLimiter: noWaitLimiter,
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request());
    expect((await runtime.tick()).worker.outcome).toBe("retry_scheduled");
    const retry = (await runtime.status(descriptor.pipelineId)).stages[0]!;
    expect(retry).toMatchObject({ status: "waiting_retry", attempt: 1 });
    expect(Date.parse(retry.runAfter)).toBeGreaterThan(Date.parse(NOW));
  });

  it("fences a cancelled worker before official capture persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-cancel-"));
    roots.push(root);
    const stores = await repositories(root);
    let release!: () => void;
    let started!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const acquisitionStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = officialFetcher({ deferAcquisition: deferred, onAcquisition: started });
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => true,
      now: () => NOW,
      officialFetcher: fetcher,
      rateLimiter: noWaitLimiter,
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request());
    expect((await runtime.tick()).worker.outcome).toBe("succeeded");
    const runningTick = runtime.tick();
    await acquisitionStarted;
    const running = (await runtime.status(descriptor.pipelineId)).stages[1]!;
    expect(running.status).toBe("running");
    await runtime.cancel({ pipelineId: descriptor.pipelineId, stage: running.stage, expectedRevision: running.revision });
    release();
    expect((await runningTick).worker.outcome).toBe("fenced");
    expect(await stores.evidenceRepository.getLatestCaptureForUrl(
      "https://dlcdnets.asus.com/pub/ASUS/mb/manual/model-board-production-manual.pdf",
    )).toBeNull();
  });

  it("audits unknown brands and archives approved third-party bytes without making an official capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-evidence-third-party-"));
    roots.push(root);
    const stores = await repositories(root);
    const thirdPartyRegistry = {
      schemaVersion: "third-party-registry-v1",
      updatedAt: NOW,
      sources: [{
        publisherId: "review-lab",
        name: "Independent Review Lab",
        domains: ["review.example"],
        sourceType: "professional_measurement",
        independenceGroupId: "review-lab",
        editorialControl: "independent",
        fundingDisclosure: "independent",
        enabled: true,
        approvedAt: NOW,
      }],
    };
    const thirdPartyUrl = "https://review.example/test/unknown-board";
    let fetchCount = 0;
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      ...stores,
      online: () => true,
      now: () => NOW,
      thirdPartyRegistry,
      thirdPartyDiscovery: async () => [{ url: thirdPartyUrl }],
      thirdPartyFetcher: async () => {
        fetchCount += 1;
        return {
          status: 200,
          finalUrl: thirdPartyUrl,
          redirects: [],
          rawBody: Buffer.from("independent measurement 244 mm", "utf8"),
          contentType: "text/plain",
          retrievedAt: NOW,
        };
      },
      rateLimiter: noWaitLimiter,
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request({
      subject: { ...(request().subject as object), brand: "Unknown Hardware Brand" },
      allowThirdPartyFallback: true,
    }));
    await runtime.scheduler.drain(20);
    const status = await runtime.status(descriptor.pipelineId);
    expect(status.stages[0]?.result).toMatchObject({
      status: "needs_review",
      officialSearchReason: "official_identity_unresolved",
    });
    const fallback = status.stages.find((entry) => entry.stage === "third_party_fallback")?.result;
    expect(fallback).toMatchObject({ status: "needs_review", output: { reason: "third_party_extractor_not_configured" } });
    expect(fetchCount).toBe(1);
    const artifactRef = (fallback?.output.thirdPartyArtifactRefs as string[])[0]!;
    expect((await stores.artifactRepository.get(artifactRef))?.record.kind).toBe("evidence-third-party-document");
    const thirdPartyCapture = await stores.evidenceRepository.getLatestCaptureForUrl(thirdPartyUrl);
    expect(thirdPartyCapture).toMatchObject({
      acquisitionMethod: "third-party-fetch",
      kindBasis: "user-asserted",
      canonicalUrl: thirdPartyUrl,
      productIdentities: [expect.objectContaining({ basis: "governed-sku-user-asserted" })],
    });
    expect(thirdPartyCapture?.productIdentities.some((identity: { basis: string }) => identity.basis === "official-document-explicit")).toBe(false);
  });
});
