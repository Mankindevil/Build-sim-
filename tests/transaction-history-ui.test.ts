// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initBuildProgress, type BuildProgressPlanContext } from "../src/lab/build-progress";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { TransactionArchiveRecord, TransactionScreenshotArchive } from "../src/lab/transaction-archive";

function mount(): void {
  document.body.innerHTML = `<div id="build-base-summary"></div><div id="build-hero-progress"></div><div id="build-progress-summary"></div><ol id="next-buy-list"></ol>
  <dialog id="build-base-dialog"><button id="build-base-close"></button><button id="build-review-current-tab"></button><span id="build-review-current-count"></span><button id="build-review-transactions-tab"></button><span id="build-review-transaction-count">0 笔</span>
  <section id="build-review-current-panel"><div id="build-review-current-summary"></div><div id="build-base-editor"></div></section><section id="build-review-transactions-panel" hidden><button id="transaction-history-refresh"></button><p id="transaction-history-status"></p><div id="transaction-history-list"></div></section>
  <p id="build-base-save-status"></p><button id="build-base-cancel"></button><button id="build-base-save"></button><button id="build-add-custom"></button></dialog><button id="build-base-edit"></button><button id="build-lock-current"></button>`;
}

function record(id: string, planId: string | null, planItemId: string | null): TransactionArchiveRecord {
  return {
    schemaVersion: 2, receiptId: id, storedAt: "2026-08-25T00:00:00.000Z", updatedAt: `2026-08-25T00:00:0${id.at(-1)}.000Z`,
    item: { id: `transaction-${id}`, skuId: planItemId, name: `交易 ${id}`, category: planItemId ? "psu" : "accessory", qty: 1, unitPriceCny: planItemId ? 899 : null, stage: "purchased", source: "transaction", transaction: { receiptId: id, fileName: `${id}.png`, contentHash: "a".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "evidence", verification: "identity-review-required" } },
    link: { schemaVersion: "1.0.0", planId, planVersionIdAtCapture: null, planItemId, linkStatus: planId && planItemId ? "linked" : "unlinked" }, image: null,
  };
}

describe("R8 transaction history UI", () => {
  beforeEach(() => { localStorage.clear(); mount(); });

  it("defaults to the active plan, exposes the unlinked inbox, filters, and relinks a record", async () => {
    const context = { planId: "plan-active-12345678", planVersionId: "version-active-12345678", planName: "Active", evaluation: { bom: [{ skuId: "psu.seasonic-focus-gx-850-v5", qty: 1, bucket: "required" }] } } as unknown as BuildProgressPlanContext;
    const records = [record("receipt-1", context.planId, "psu.seasonic-focus-gx-850-v5"), record("receipt-2", "plan-other-12345678", "psu.other"), record("receipt-3", null, null)];
    const updateRecord = vi.fn(async (receiptId: string) => records.find((entry) => entry.receiptId === receiptId)!);
    const archive: TransactionScreenshotArchive = {
      stage: vi.fn(), discard: vi.fn(), commit: vi.fn(async () => ({ archived: [], failures: [] })), list: vi.fn(async () => records), pendingRecord: vi.fn(() => null),
      deleteScreenshot: vi.fn(async () => undefined), deleteRecord: vi.fn(async () => undefined), updateRecord,
    };
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: [], getPlanContext: () => context, getPlans: () => [{ id: context.planId, name: "Active" }, { id: "plan-other-12345678", name: "Other" }], screenshotArchive: archive });
    controller.activatePlan(context);
    document.querySelector<HTMLButtonElement>("#build-base-edit")!.click();
    document.querySelector<HTMLButtonElement>("#build-review-transactions-tab")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll("[data-archive-receipt]")).toHaveLength(1));
    expect(document.querySelector("[data-archive-receipt]")?.getAttribute("data-archive-receipt")).toBe("receipt-1");
    const planFilter = document.querySelector<HTMLSelectElement>("#transaction-history-plan-filter")!;
    planFilter.value = "unlinked"; planFilter.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.querySelector("[data-archive-receipt='receipt-3']")).not.toBeNull());
    const card = document.querySelector<HTMLElement>("[data-archive-receipt='receipt-3']")!;
    const link = card.querySelector<HTMLSelectElement>("[data-archive-link-item]")!;
    link.value = "psu.seasonic-focus-gx-850-v5";
    card.querySelector<HTMLButtonElement>("[data-archive-update]")!.click();
    await vi.waitFor(() => expect(updateRecord).toHaveBeenCalledWith("receipt-3", expect.objectContaining({ link: expect.objectContaining({ planId: context.planId, planItemId: "psu.seasonic-focus-gx-850-v5", linkStatus: "linked" }) })));
  });
});
