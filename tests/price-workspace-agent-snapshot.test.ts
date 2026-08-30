// @vitest-environment happy-dom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGovernedPricePanel } from "../src/lab/governed-price-panel";
import type { PlanAgentContext } from "../src/plans/contracts";
import type { PlanCurrentPriceView } from "../src/price/production";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { ProductionWorkspacePlanResolutionSummary } from "../src/server/plan-resolution-summary";
import { withServerDerivedPlanResolution } from "../src/server/workspace-routes";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const hash = "a".repeat(64);

function view(): PlanCurrentPriceView {
  return {
    schemaVersion: "plan-current-price-view-v1", planId: "plan-a", draftRevision: 3,
    configHash: "b".repeat(64), evaluationLockHash: "c".repeat(64), priceSnapshotHash: hash,
    priceSnapshotId: "price-snapshot-a", asOf: "2026-08-29", unresolvedInstanceIds: [],
    components: [{
      instanceId: "gpu-a", skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"],
      current: {
        schemaVersion: "current-price-projection-v1", skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"],
        status: "single", confidence: "low", minCny: 4_999, maxCny: 4_999, sampleCount: 1, sellerCount: 1,
        preferredObservationIds: ["observation-a"], usableObservationIds: [], expiredObservationIds: [],
        selectedObservationIds: ["observation-a"], platformCounts: { jd: 1 }, riskTags: [], conflict: null,
        alternativesRequired: false, validUntil: "2026-09-04T00:00:00.000Z",
      },
      currentObservations: [{
        observationId: "observation-a", platform: "jd", sellerId: "seller-a", sellerTier: "S1",
        stockStatus: "in_stock", comparableTotalCny: 4_999, invoiceStatus: "yes", warrantyStatus: "mainland",
        canonicalUrl: "https://item.jd.com/gpu.html", capturedAt: "2026-08-29T00:00:00.000Z",
      }],
      history: [],
      buyWait: {
        schemaVersion: "buy-wait-advice-v1", recommendation: "buy_if_needed", confidence: "low", currentPriceCny: 4_999,
        historicalPosition: null, historyWindow: null, validUntil: "2026-09-04T00:00:00.000Z",
        triggerConditions: ["recheck exact variant"], counterEvidence: [], evidenceRefs: [],
        uncertainty: "history coverage is insufficient; no historical-low or abnormal-cycle claim is made",
      },
      targets: [],
    }],
  };
}

describe("U10 workspace, Agent and evaluation price snapshot identity", () => {
  it("renders the exact server view and rejects a response from another price snapshot", async () => {
    const host = document.createElement("section"); document.body.replaceChildren(host);
    let listener: () => void = () => undefined;
    let expectedHash = hash;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(view()), { status: 200, headers: { "Content-Type": "application/json" } }));
    const controller = mountGovernedPricePanel(host, {
      enabled: true, getAuthority: () => ({ planId: "plan-a", expectedPriceSnapshotHash: expectedHash }),
      subscribe: (next) => { listener = next; return () => undefined; }, fetchImpl: fetchImpl as typeof fetch,
    });
    await vi.waitFor(() => expect(host.textContent).toContain("低置信单点"));
    expect(host.textContent).toContain("price-snapshot-a");
    expect(host.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://item.jd.com/gpu.html");

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ...view(), priceSnapshotHash: "d".repeat(64) }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expectedHash = "e".repeat(64);
    listener();
    await vi.waitFor(() => expect(host.textContent).toContain("价格视图与当前评估快照不一致"));
    controller.dispose();
  });

  it("creates and revises a target through bounded server-owned controls", async () => {
    const host = document.createElement("section"); document.body.replaceChildren(host);
    const stored = {
      revision: 0,
      recordHash: "d".repeat(64),
      target: {
        targetId: "target-a", planId: "plan-a", instanceId: "gpu-a", skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"],
        targetTotalCny: 4_500, enabled: true, status: "watching" as const, revisionHash: "e".repeat(64), updatedAt: "2026-08-29T00:00:00.000Z",
      },
    };
    let current = view();
    const requests: Array<{ method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        requests.push({ method, body: JSON.parse(String(init?.body)) });
        if (method === "POST") current = { ...view(), components: [{ ...view().components[0]!, targets: [stored] }] };
        return new Response(JSON.stringify(stored), { status: method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(current), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const controller = mountGovernedPricePanel(host, {
      enabled: true, targetsEnabled: true, getAuthority: () => ({ planId: "plan-a", expectedPriceSnapshotHash: hash }),
      subscribe: () => () => undefined, fetchImpl: fetchImpl as typeof fetch,
    });
    await vi.waitFor(() => expect(host.querySelector("[data-price-target-create]")).not.toBeNull());
    const create = host.querySelector<HTMLFormElement>("[data-price-target-create]")!;
    create.querySelector<HTMLInputElement>('input[name="targetTotalCny"]')!.value = "4500";
    create.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-price-target-edit]")).not.toBeNull());
    expect(requests[0]).toEqual({ method: "POST", body: { instanceId: "gpu-a", targetTotalCny: 4_500 } });

    const edit = host.querySelector<HTMLFormElement>("[data-price-target-edit]")!;
    edit.querySelector<HTMLInputElement>('input[name="targetTotalCny"]')!.value = "4400";
    edit.querySelector<HTMLInputElement>('input[name="enabled"]')!.checked = false;
    edit.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({ method: "PATCH", body: {
      expectedRevision: 0, expectedRecordHash: "d".repeat(64), expectedTargetRevisionHash: "e".repeat(64),
      targetTotalCny: 4_400, enabled: false,
    } });
    controller.dispose();
  });

  it("archives a collected listing using only the server IDs and selected captured label", async () => {
    const host = document.createElement("section"); document.body.replaceChildren(host);
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ schemaVersion: "price-observation-intake-result-v1" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(view()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const controller = mountGovernedPricePanel(host, {
      enabled: true,
      getAuthority: () => ({ planId: "plan-a", expectedPriceSnapshotHash: hash }),
      subscribe: () => () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await vi.waitFor(() => expect(host.querySelector("[data-price-observation-intake]")).not.toBeNull());
    const form = host.querySelector<HTMLFormElement>("[data-price-observation-intake]")!;
    form.querySelector<HTMLInputElement>('input[name="listingCaptureId"]')!.value = `listing-capture-${"a".repeat(20)}`;
    form.querySelector<HTMLInputElement>('input[name="variantLabel"]')!.value = "12GB";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(form.textContent).toContain("重新运行方案评估后"));
    expect(requests).toEqual([{
      url: "/api/workspace/plans/plan-a/price-observations",
      body: { instanceId: "gpu-a", listingCaptureId: `listing-capture-${"a".repeat(20)}`, variantLabel: "12GB" },
    }]);
    controller.dispose();
  });

  it("derives the Agent price summary from the same root-pinned plan price authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-summary-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const expected = view();
    const summary = new ProductionWorkspacePlanResolutionSummary({
      coordinator,
      planPrices: { initialize: async () => undefined, forPlanAtRoot: async () => structuredClone(expected) },
    });
    const resolved = await summary.forPlan("plan-a");
    expect(resolved.price?.priceSnapshotHash).toBe(hash);
    const submitted = {
      planId: "plan-a", purchaseSummary: { price: { priceSnapshotHash: "browser-value" }, note: "keep" },
      evidenceSummary: { count: 0, bindings: [] },
    } as unknown as PlanAgentContext;
    const derived = withServerDerivedPlanResolution(submitted, resolved);
    expect(derived.purchaseSummary).toMatchObject({ note: "keep", price: { priceSnapshotHash: hash, priceSnapshotId: "price-snapshot-a" } });
  });
});
