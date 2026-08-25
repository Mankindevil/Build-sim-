// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { BuildEvaluation } from "../src/core/evaluate";
import { BUILD_PROGRESS_PLAN_STORAGE_PREFIX, BUILD_PROGRESS_STORAGE_KEY, initBuildProgress, type BuildProgressPlanContext } from "../src/lab/build-progress";
import type { TransactionScreenshotArchive } from "../src/lab/transaction-archive";

function mount(): void {
  document.body.innerHTML = `
    <div id="build-base-summary"></div><div id="build-hero-progress"></div>
    <div id="build-progress-summary"></div><ol id="next-buy-list"></ol>
    <dialog id="build-base-dialog">
      <button id="build-review-current-tab"></button><span id="build-review-current-count"></span>
      <button id="build-review-transactions-tab"></button><span id="build-review-transaction-count">0 笔</span>
      <section id="build-review-current-panel"><div id="build-review-current-summary"></div><div id="build-base-editor"></div></section>
      <section id="build-review-transactions-panel" hidden><p id="transaction-history-status"></p><div id="transaction-history-list"></div><button id="transaction-history-refresh"></button></section>
    </dialog>
    <button id="build-base-edit"></button><button id="build-base-close"></button>
    <p id="build-base-save-status"></p>
    <button id="build-base-cancel"></button><button id="build-base-save"></button>
    <button id="build-add-custom"></button><button id="build-lock-current"></button>`;
}

function evaluation(): BuildEvaluation {
  return { bom: [{ skuId: "case.jonsbo-n6", qty: 1, bucket: "owned" }] } as unknown as BuildEvaluation;
}

describe("build progress transaction import", () => {
  beforeEach(() => { localStorage.clear(); mount(); });

  it("updates a matched catalog row to purchased and persists receipt evidence", () => {
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: ["case.jonsbo-n6"] });
    controller.syncEvaluation(evaluation());
    controller.importTransaction({
      receiptId: "receipt-known",
      skuId: "case.jonsbo-n6",
      name: "JONSBO N6",
      category: "case",
      qty: 1,
      unitPriceCny: 699,
      evidence: { receiptId: "receipt-known", fileName: "order.png", contentHash: "a".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 90, excerpt: "识别结果", verification: "matched-catalog" },
    });
    expect(document.querySelector("#next-buy-list")?.textContent).toContain("交易截图 · 已匹配正式 SKU");
    expect(document.querySelector("#build-hero-progress")?.textContent).toContain("¥699");
    expect(JSON.parse(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY) ?? "{}").items["case.jonsbo-n6"]).toMatchObject({ stage: "purchased", unitPriceCny: 699, transaction: { receiptId: "receipt-known", verification: "matched-catalog" } });
  });

  it("adds an unknown model as a provisional purchased record without changing the deterministic BOM", () => {
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: ["case.jonsbo-n6"] });
    controller.syncEvaluation(evaluation());
    controller.importTransaction({
      receiptId: "receipt-new",
      skuId: null,
      name: "Seasonic VERTEX-GX-1000",
      category: "psu",
      qty: 1,
      unitPriceCny: 1299,
      evidence: { receiptId: "receipt-new", fileName: "order.png", contentHash: "b".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 88, excerpt: "识别结果", verification: "online-searching", catalogJobId: "job-1" },
    });
    expect(document.querySelector("#next-buy-list")?.textContent).toContain("Seasonic VERTEX-GX-1000");
    expect(document.querySelector("#next-buy-list")?.textContent).toContain("联网补参中");
    const stored = JSON.parse(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY) ?? "{}");
    expect(stored.items["transaction-receipt-new"]).toMatchObject({ source: "transaction", skuId: null, stage: "purchased", transaction: { catalogJobId: "job-1" } });
  });

  it("stages an OCR result for editing and persists only after Save base", async () => {
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: ["case.jonsbo-n6"] });
    controller.syncEvaluation(evaluation());
    document.querySelector<HTMLButtonElement>("#build-base-edit")?.click();
    controller.stageTransaction({
      receiptId: "receipt-review",
      skuId: null,
      name: "OCR 未校正名称",
      category: "psu",
      qty: 1,
      unitPriceCny: 1299,
      stage: "purchased",
      evidence: { receiptId: "receipt-review", fileName: "order.png", contentHash: "c".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 81, excerpt: "识别结果", verification: "identity-review-required" },
    });

    expect(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY)).toBeNull();
    expect(document.querySelector("#build-base-save")?.textContent).toContain("1 项待保存");
    const row = document.querySelector<HTMLElement>('[data-progress-id="transaction-receipt-review"]');
    expect(row?.classList.contains("is-pending")).toBe(true);
    const name = row?.querySelector<HTMLInputElement>(".build-editor-name");
    const category = row?.querySelector<HTMLSelectElement>(".build-editor-category");
    const price = row?.querySelector<HTMLInputElement>(".build-editor-price");
    if (name) name.value = "Seasonic VERTEX GX-1000";
    if (category) category.value = "psu";
    if (price) price.value = "1250";

    document.querySelector<HTMLButtonElement>("#build-base-save")?.click();
    await vi.waitFor(() => expect(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY)).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY) ?? "{}");
    expect(stored.items["transaction-receipt-review"]).toMatchObject({ name: "Seasonic VERTEX GX-1000", category: "psu", unitPriceCny: 1250, source: "transaction" });
  });

  it("discards a staged screenshot result when the editor is cancelled", () => {
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: ["case.jonsbo-n6"] });
    controller.syncEvaluation(evaluation());
    document.querySelector<HTMLButtonElement>("#build-base-edit")?.click();
    controller.stageTransaction({
      receiptId: "receipt-cancelled",
      skuId: null,
      name: "Should not persist",
      category: "其他",
      qty: 1,
      unitPriceCny: null,
      evidence: { receiptId: "receipt-cancelled", fileName: "order.png", contentHash: "d".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: null, excerpt: "", verification: "identity-review-required" },
    });
    document.querySelector<HTMLButtonElement>("#build-base-cancel")?.click();
    document.querySelector<HTMLButtonElement>("#build-base-edit")?.click();
    expect(document.querySelector('[data-progress-id="transaction-receipt-cancelled"]')).toBeNull();
    expect(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY)).toBeNull();
  });

  it("archives a staged screenshot on the server only when Save base succeeds", async () => {
    const commit = vi.fn(async () => ({ archived: [{
      schemaVersion: 2 as const,
      receiptId: "receipt-server",
      storedAt: "2026-08-25T01:00:00.000Z",
      updatedAt: "2026-08-25T01:00:00.000Z",
      item: {} as never,
      link: { schemaVersion: "1.0.0" as const, planId: null, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" as const },
      image: { fileName: "order.png", mimeType: "image/png", bytes: 4, contentHash: "e".repeat(64), imageUrl: "/api/price/transactions/archive/receipt-server/image" },
    }], failures: [] }));
    const archive: TransactionScreenshotArchive = {
      stage: vi.fn(), discard: vi.fn(), commit,
      list: vi.fn(async () => []), pendingRecord: vi.fn(() => null),
      deleteScreenshot: vi.fn(async () => undefined), deleteRecord: vi.fn(async () => undefined),
      updateRecord: vi.fn(async () => { throw new Error("unused"); }),
    };
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: ["case.jonsbo-n6"], screenshotArchive: archive });
    controller.syncEvaluation(evaluation());
    document.querySelector<HTMLButtonElement>("#build-base-edit")?.click();
    const file = new File([new Uint8Array([137, 80, 78, 71])], "order.png", { type: "image/png" });
    controller.stageTransaction({
      receiptId: "receipt-server", skuId: null, name: "Server saved PSU", category: "psu", qty: 1, unitPriceCny: 1250,
      evidence: { receiptId: "receipt-server", fileName: "order.png", contentHash: "e".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "deepseek-vision:fixture", ocrConfidence: null, excerpt: "识别结果", verification: "identity-review-required" },
    }, file);
    expect(archive.stage).toHaveBeenCalledWith("receipt-server", file, "e".repeat(64), "2026-08-25T00:00:00.000Z");
    expect(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY)).toBeNull();

    document.querySelector<HTMLButtonElement>("#build-base-save")?.click();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY)).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY) ?? "{}");
    expect(stored.items["transaction-receipt-server"].transaction).toMatchObject({ screenshotArchive: "server", screenshotStoredAt: "2026-08-25T01:00:00.000Z", screenshotMimeType: "image/png", screenshotSize: 4 });
  });

  it("isolates purchase state per active plan and restores it when switching back", () => {
    const evaluation = { bom: [{ skuId: "case.jonsbo-n6", qty: 1, bucket: "required" }] } as unknown as BuildEvaluation;
    const planA = { planId: "plan-purchase-a", planVersionId: null, planName: "A", evaluation } satisfies BuildProgressPlanContext;
    const planB = { planId: "plan-purchase-b", planVersionId: null, planName: "B", evaluation } satisfies BuildProgressPlanContext;
    let active = planA;
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: [], getPlanContext: () => active });
    controller.activatePlan(planA);
    controller.importTransaction({ receiptId: "receipt-plan-a", skuId: "case.jonsbo-n6", name: "N6", category: "case", qty: 1, unitPriceCny: 699, evidence: { receiptId: "receipt-plan-a", fileName: "a.png", contentHash: "f".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "evidence", verification: "matched-catalog" } });
    expect(controller.summary()).toMatchObject({ purchased: 1, knownSpentCny: 699 });
    expect(localStorage.getItem(`${BUILD_PROGRESS_PLAN_STORAGE_PREFIX}${planA.planId}`)).toBeTruthy();
    active = planB; controller.activatePlan(planB);
    expect(controller.summary()).toMatchObject({ candidate: 1, purchased: 0, knownSpentCny: 0 });
    active = planA; controller.activatePlan(planA);
    expect(controller.summary()).toMatchObject({ purchased: 1, knownSpentCny: 699 });
  });

  it("keeps only failed receipts staged when a batch archive partially succeeds", async () => {
    const archive: TransactionScreenshotArchive = {
      stage: vi.fn(), discard: vi.fn(), list: vi.fn(async () => []), pendingRecord: vi.fn(() => null), deleteScreenshot: vi.fn(async () => undefined), deleteRecord: vi.fn(async () => undefined), updateRecord: vi.fn(async () => { throw new Error("unused"); }),
      commit: vi.fn(async () => ({ archived: [{ schemaVersion: 2 as const, receiptId: "receipt-ok", storedAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z", item: {} as never, link: { schemaVersion: "1.0.0" as const, planId: null, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" as const }, image: null }], failures: [{ receiptId: "receipt-failed", message: "fixture unavailable" }] })),
    };
    const controller = initBuildProgress({ getCatalog: loadBundledCatalog, baseSkuIds: [], screenshotArchive: archive });
    controller.syncEvaluation({ bom: [] } as unknown as BuildEvaluation);
    document.querySelector<HTMLButtonElement>("#build-base-edit")!.click();
    const evidence = (receiptId: string) => ({ receiptId, fileName: `${receiptId}.png`, contentHash: "a".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "evidence", verification: "identity-review-required" as const });
    controller.stageTransaction({ receiptId: "receipt-ok", skuId: null, name: "OK", category: "psu", qty: 1, unitPriceCny: 800, evidence: evidence("receipt-ok") });
    controller.stageTransaction({ receiptId: "receipt-failed", skuId: null, name: "Failed", category: "gpu", qty: 1, unitPriceCny: 900, evidence: evidence("receipt-failed") });
    document.querySelector<HTMLButtonElement>("#build-base-save")!.click();
    await vi.waitFor(() => expect(document.querySelector("#build-base-save-status")?.textContent).toContain("部分保存"));
    const stored = JSON.parse(localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY) ?? "{}");
    expect(stored.items["transaction-receipt-ok"]).toBeTruthy();
    expect(stored.items["transaction-receipt-failed"]).toBeUndefined();
    expect(document.querySelector("[data-progress-id='transaction-receipt-failed']")).not.toBeNull();
  });
});
