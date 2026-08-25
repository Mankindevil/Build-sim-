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

    initTransactionImport({ onImport });
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

    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ name: "Seasonic VERTEX GX-1000", category: "psu", qty: 2, unitPriceCny: 1250, stage: "purchased" }));
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("保存基座");
  });
});
