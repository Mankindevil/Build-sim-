// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTransactionImport } from "../src/lab/transaction-import";

function mount(): void {
  document.body.innerHTML = `
    <label id="transaction-screenshot-drop" for="transaction-screenshot-input">
      <input id="transaction-screenshot-input" type="file">
      <img id="transaction-screenshot-preview" hidden>
    </label>
    <p id="transaction-screenshot-status"></p>
    <div id="transaction-screenshot-result" hidden></div>`;
}

describe("transaction screenshot review UI", () => {
  beforeEach(mount);
  afterEach(() => vi.unstubAllGlobals());

  it("requires editable review and explicit confirmation before staging a record", async () => {
    const onImport = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      receiptId: "receipt-ui",
      status: "identity-review-required",
      detected: { name: "待确认交易部件", brand: null, model: null, category: "accessory", qty: 1, unitPriceCny: null },
      catalogMatch: null,
      evidence: { receiptId: "receipt-ui", fileName: "order.png", contentHash: "a".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "deepseek-ocr:fixture", ocrConfidence: null, excerpt: "识别结果" },
      catalogSearch: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    initTransactionImport({ onImport, getPlanContext: () => ({ planId: "plan-ui-12345678", planVersionId: "version-ui-12345678", planName: "UI plan", items: [{ id: "psu.primary", skuId: "psu.seasonic-focus-gx-850-v5", name: "FOCUS GX", category: "psu" }] }) });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "order.png", { type: "image/png", lastModified: Date.now() });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-fields")).not.toBeNull());
    expect(onImport).not.toHaveBeenCalled();
    const name = document.querySelector<HTMLInputElement>(".transaction-review-name")!;
    const category = document.querySelector<HTMLSelectElement>(".transaction-review-category")!;
    const qty = document.querySelector<HTMLInputElement>(".transaction-review-qty")!;
    const price = document.querySelector<HTMLInputElement>(".transaction-review-price")!;
    name.value = "Seasonic VERTEX GX-1000";
    category.value = "psu";
    qty.value = "2";
    price.value = "1250";
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!.click();

    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ name: "Seasonic VERTEX GX-1000", category: "psu", qty: 2, unitPriceCny: 1250, stage: "purchased", planLink: expect.objectContaining({ planId: "plan-ui-12345678", planItemId: null, linkStatus: "unlinked" }) }), expect.any(File));
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("保存基座");
  });

  it("keeps the selected screenshot available for retry after service failure", async () => {
    const onImport = vi.fn();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("price service unavailable");
      return new Response(JSON.stringify({ receiptId: "receipt-retry", status: "identity-review-required", detected: { name: "Retry item", brand: null, model: null, category: "accessory", qty: 1, unitPriceCny: null }, catalogMatch: null, evidence: { receiptId: "receipt-retry", fileName: "retry.png", contentHash: "b".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "evidence" }, catalogSearch: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "retry.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("failed"));
    const retry = document.querySelector<HTMLButtonElement>("#transaction-retry")!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-fields")).not.toBeNull());
    expect(attempts).toBe(2);
  });

  it("explains how a different purchased model maps to an optional plan position", async () => {
    const onImport = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      receiptId: "receipt-alternate-model",
      status: "matched-catalog",
      detected: { name: "Corsair RM850x", brand: "Corsair", model: "RM850x", category: "psu", qty: 1, unitPriceCny: 899 },
      catalogMatch: { skuId: "psu.corsair-rm850x", kind: "exact-mpn", score: 1 },
      evidence: { receiptId: "receipt-alternate-model", fileName: "alternate.png", contentHash: "c".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "RM850x" },
      catalogSearch: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    initTransactionImport({
      onImport,
      getPlanContext: () => ({
        planId: "plan-alternate-12345678",
        planVersionId: "version-alternate-12345678",
        planName: "Alternate plan",
        items: [
          { id: "gpu.primary", skuId: "gpu.example", name: "Example GPU", category: "gpu" },
          { id: "psu.primary", skuId: "psu.seasonic-focus-gx-850-v5", name: "Seasonic FOCUS GX-850 V5", category: "psu" },
        ],
      }),
    });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "alternate.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-link")).not.toBeNull());
    const link = document.querySelector<HTMLSelectElement>(".transaction-review-link")!;
    expect(link.closest("label")?.textContent).toContain("对应方案位置（可选）");
    expect(link.options[0]?.textContent).toBe("不对应方案（作为额外采购）");
    expect(link.value).toBe("");
    link.value = "psu.primary";
    link.dispatchEvent(new Event("change"));
    expect(document.querySelector(".transaction-review-link-hint")?.textContent).toContain("买了不同型号时");
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!.click();

    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      skuId: "psu.corsair-rm850x",
      name: "Corsair RM850x",
      planLink: expect.objectContaining({ planItemId: "psu.primary", linkStatus: "linked" }),
    }), expect.any(File));
  });

  it("waits for corrected identity and category before starting catalog search", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") {
        return new Response(JSON.stringify({
          receiptId: "receipt-two-phase",
          status: "catalog-search-required",
          detected: { name: "GX-850", brand: null, model: "GX-850", category: "psu", qty: 1, unitPriceCny: 400 },
          catalogMatch: null,
          searchQuery: "GX-850",
          ocrText: "订单商品：Seasonic FOCUS GX-850 FX\n型号：SSR-850FX\n实付：¥400",
          evidence: { receiptId: "receipt-two-phase", fileName: "two-phase.png", contentHash: "d".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "GX-850" },
          catalogSearch: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/price/transactions/catalog-search") {
        return new Response(JSON.stringify({ jobId: "job-corrected", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/catalog/search/job-corrected") {
        return new Response(JSON.stringify({
          jobId: "job-corrected",
          status: "completed",
          candidates: [{ skuId: "psu.seasonic-focus-plus-gold-850-fx", title: "Seasonic FOCUS Plus Gold 850 SSR-850FX", canonicalUrl: "https://seasonic.com/product/focus-plus-gold/", match: { kind: "brand-model", score: 0.85 }, extraction: { status: "partial", fieldsFound: 1 }, fields: [{ field: "power.ratedW", value: 850, evidence: "official" }] }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "two-phase.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLTextAreaElement>(".transaction-review-ocr textarea")?.value).toContain("SSR-850FX");
    document.querySelector<HTMLInputElement>(".transaction-review-name")!.value = "Seasonic GX-850 FX";
    document.querySelector<HTMLSelectElement>(".transaction-review-category")!.value = "psu";
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).toBeNull());
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/price/transactions/catalog-search");
    expect(JSON.parse(String(searchCall?.[1]?.body))).toMatchObject({ query: "Seasonic GX-850 FX", category: "psu" });
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("候选发现完成");
    expect(document.querySelector(".transaction-candidate-fields")?.textContent).toContain("850");
    const finalConfirm = document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!;
    expect(finalConfirm.disabled).toBe(true);
    const approval = document.querySelector<HTMLInputElement>(".transaction-candidate-approval")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    finalConfirm.click();
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      skuId: "psu.seasonic-focus-plus-gold-850-fx",
      name: "Seasonic GX-850 FX",
      category: "psu",
      evidence: expect.objectContaining({ officialUrl: "https://seasonic.com/product/focus-plus-gold/", sourceReview: "user-confirmed" }),
    }), expect.any(File));
  });

  it("cancels an in-flight OCR request without staging or losing retry state", async () => {
    const onImport = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "cancel.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("recognizing"));
    document.querySelector<HTMLButtonElement>("[data-transaction-cancel]")!.click();
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("cancelled"));
    expect(onImport).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>("#transaction-retry")!.hidden).toBe(false);
  });
});
