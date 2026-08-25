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
