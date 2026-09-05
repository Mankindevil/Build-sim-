// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactOfficialQuery, initTransactionImport } from "../src/lab/transaction-import";

function mount(): void {
  document.body.innerHTML = `
    <label id="transaction-screenshot-drop" for="transaction-screenshot-input">
      <input id="transaction-screenshot-input" type="file">
    </label>
    <section id="transaction-screenshot-selection" hidden>
      <img id="transaction-screenshot-preview" role="button" tabindex="0" aria-expanded="false" hidden>
      <p id="transaction-screenshot-meta"></p>
      <button id="transaction-start-recognition" type="button">开始识别</button>
      <button id="transaction-replace-image" type="button">更换图片</button>
      <button id="transaction-manual-entry" type="button">手动录入</button>
    </section>
    <p id="transaction-screenshot-status"></p>
    <button id="transaction-retry" type="button" hidden>重试当前步骤</button>
    <button id="transaction-cancel" type="button" hidden>取消当前处理</button>
    <div id="transaction-screenshot-result" hidden></div>`;
}

function startRecognition(): void {
  document.querySelector<HTMLButtonElement>("#transaction-start-recognition")!.click();
}

const CONFIRMED_N6 = {
  status: "confirmed",
  draftId: "draft-commit-safety",
  skuId: "case.jonsbo-n6-commit-safety",
  sku: {
    id: "case.jonsbo-n6-commit-safety", category: "case", brand: "JONSBO", model: "N6", name: "JONSBO N6",
    dims: { lengthMm: 353, heightMm: 318, widthMm: 305, evidence: "official" }, power: { evidence: "unknown" },
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    appearance: { page: "https://www.jonsbo.com/en/products/N6Black.html" }, provenance: [],
  },
};

function catalogDraftFlowFetch(confirm: (init?: RequestInit) => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
      receiptId: "receipt-commit-safety", status: "catalog-search-required",
      detected: { name: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case", qty: 1, unitPriceCny: 799 }, catalogMatch: null,
      evidence: { receiptId: "receipt-commit-safety", fileName: "commit.png", contentHash: "c".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "JONSBO N6" }, catalogSearch: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-commit-safety", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
    if (url === "/api/catalog/search/job-commit-safety") return new Response(JSON.stringify({
      jobId: "job-commit-safety", status: "completed", stage: "score", candidates: [{
        candidateId: "candidate-commit-safety", expectedHash: "e".repeat(64), title: "JONSBO N6", canonicalUrl: "https://www.jonsbo.com/en/products/N6Black.html",
        official: { trustStatus: "trusted", pageKind: "product" }, identity: { verdict: "exact", score: 1, reasons: [], unknowns: [], criticalConflicts: [] },
        match: { kind: "brand-model", score: 1 }, extraction: { status: "partial", fieldsFound: 2 },
        fields: [{ field: "brand", value: "JONSBO", evidence: "official" }, { field: "model", value: "N6", evidence: "official" }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/catalog/candidates/candidate-commit-safety/enrich") return new Response(JSON.stringify({
      status: "draft", candidateId: "candidate-commit-safety", draftId: "draft-commit-safety", inputHash: "f".repeat(64), writeEnabled: true,
      draft: {
        draftId: "draft-commit-safety", candidateId: "candidate-commit-safety", inputHash: "f".repeat(64), status: "draft", missing: [], conflicts: [],
        fields: [{ field: "brand", value: "JONSBO", evidence: "official" }, { field: "model", value: "N6", evidence: "official" }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/price/transactions/catalog-drafts/draft-commit-safety/confirm") return confirm(init);
    throw new Error(`unexpected request ${url}`);
  });
}

async function reachAcceptableCatalogDraft(): Promise<HTMLButtonElement> {
  const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["n6"], "commit.png", { type: "image/png" })] });
  input.dispatchEvent(new Event("change"));
  startRecognition();
  await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
  document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
  await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-draft-review")?.textContent).toContain("已生成可审核"));
  const approval = document.querySelector<HTMLInputElement>(".transaction-candidate-approval")!;
  approval.checked = true;
  approval.dispatchEvent(new Event("change"));
  const accept = [...document.querySelectorAll<HTMLButtonElement>(".transaction-catalog-draft-review button")].find((button) => button.textContent?.includes("接纳 SKU"))!;
  expect(accept.disabled).toBe(false);
  return accept;
}

describe("transaction screenshot review UI", () => {
  beforeEach(mount);
  afterEach(() => vi.unstubAllGlobals());

  it("reduces verbose GPU marketplace titles to a focused official query", () => {
    expect(compactOfficialQuery("MSI GeForce RTX 3070 Ventus 2X Overclocked Dual-Fan 8GB GDDR6 PCIe 4.0", "MSI", "gpu"))
      .toBe("MSI RTX 3070 Ventus 2X OC 8GB GDDR6");
  });

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
    expect(document.querySelector<HTMLElement>("#transaction-screenshot-selection")?.hidden).toBe(false);
    const preview = document.querySelector<HTMLImageElement>("#transaction-screenshot-preview")!;
    const selection = document.querySelector<HTMLElement>("#transaction-screenshot-selection")!;
    expect(preview.src).toContain("blob:");
    preview.click();
    expect(selection.classList.contains("is-expanded")).toBe(true);
    expect(preview.getAttribute("aria-expanded")).toBe("true");
    preview.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(selection.classList.contains("is-expanded")).toBe(false);
    expect(preview.getAttribute("aria-expanded")).toBe("false");
    expect(fetch).not.toHaveBeenCalled();
    startRecognition();

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
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("保存采购记录");
  });

  it("allows direct manual entry from the retained preview without OCR or official lookup", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    const file = new File(["manual receipt"], "manual.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>("#transaction-manual-entry")!.click();

    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(".transaction-review-name")?.value).toBe("待填写交易部件"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>("#transaction-screenshot-selection")?.hidden).toBe(false);
    document.querySelector<HTMLInputElement>(".transaction-review-name")!.value = "人工记录电源";
    document.querySelector<HTMLSelectElement>(".transaction-review-category")!.value = "psu";
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!.click();
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ name: "人工记录电源", category: "psu", evidence: expect.objectContaining({ verification: "identity-review-required", ocrEngine: "人工录入" }) }), file);
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
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("failed"));
    const retry = document.querySelector<HTMLButtonElement>("#transaction-retry")!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-fields")).not.toBeNull());
    expect(attempts).toBe(2);
  });

  it("offers a fresh OCR attempt even when the provider returned a low-quality success", async () => {
    const onImport = vi.fn();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        receiptId: "receipt-manual-retry", status: "identity-review-required",
        detected: { name: attempts === 1 ? "Intel I41-PO-15053045" : "MSI RTX 3070", brand: attempts === 1 ? "Intel" : "MSI", model: attempts === 1 ? "I41-PO-15053045" : "RTX 3070", category: "gpu", qty: 1, unitPriceCny: null },
        catalogMatch: null, evidence: { receiptId: "receipt-manual-retry", fileName: "retry-success.png", contentHash: "b".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "evidence" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["gpu"], "retry-success.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(".transaction-review-name")?.value).toBe("Intel I41-PO-15053045"));
    document.querySelector<HTMLButtonElement>(".transaction-review-retry-ocr")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(".transaction-review-name")?.value).toBe("MSI RTX 3070"));
    expect(attempts).toBe(2);
    expect(onImport).not.toHaveBeenCalled();
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
    startRecognition();

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-link")).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>(".transaction-review-name")?.readOnly).toBe(false);
    expect(document.querySelector<HTMLSelectElement>(".transaction-review-category")?.disabled).toBe(false);
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

  it("offers only same-category plan positions and rebuilds them when category changes", async () => {
    const onImport = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      receiptId: "receipt-board-position",
      status: "matched-catalog",
      detected: { name: "ASUS Pro WS W680M-ACE SE", brand: "ASUS", model: "Pro WS W680M-ACE SE", category: "motherboard", qty: 1, unitPriceCny: 2799 },
      catalogMatch: { skuId: "board.asus-w680m-ace-se", kind: "exact-mpn", score: 1 },
      evidence: { receiptId: "receipt-board-position", fileName: "board.png", contentHash: "8".repeat(64), capturedAt: "2026-08-31T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "ASUS Pro WS W680M-ACE SE" },
      catalogSearch: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    initTransactionImport({
      onImport,
      getPlanContext: () => ({
        planId: "plan-board-position-12345678", planVersionId: null, planName: "Board plan",
        items: [
          { id: "motherboard.primary", skuId: "board.asus-w680m-ace-se", name: "ASUS Pro WS W680M-ACE SE", category: "motherboard" },
          { id: "gpu.primary", skuId: "gpu.none", name: "显卡未配置（可关联本次购买）", category: "gpu", placeholder: true },
        ],
      }),
    });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["board"], "board.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(".transaction-review-link")?.value).toBe("motherboard.primary"));

    const link = document.querySelector<HTMLSelectElement>(".transaction-review-link")!;
    expect([...link.options].map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("主板 · ASUS Pro WS W680M-ACE SE")]));
    expect([...link.options].some((option) => option.textContent?.includes("显卡"))).toBe(false);
    const category = document.querySelector<HTMLSelectElement>(".transaction-review-category")!;
    category.value = "gpu";
    category.dispatchEvent(new Event("change"));
    expect(link.value).toBe("gpu.primary");
    expect([...link.options].some((option) => option.textContent?.includes("主板"))).toBe(false);
    expect([...link.options].some((option) => option.textContent?.includes("显卡 · 显卡未配置"))).toBe(true);
  });

  it("shows an exact SKU as a directory match without presenting bundled data as official", async () => {
    const onImport = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      receiptId: "receipt-fx", status: "matched-catalog",
      detected: { name: "Seasonic FOCUS Plus Gold 850 (SSR-850FX)", brand: "Seasonic", model: "GX-850 FX", category: "psu", qty: 1, unitPriceCny: 400 },
      catalogMatch: { skuId: "psu.seasonic-focus-plus-gold-850-fx", kind: "exact-mpn", score: 1 },
      evidence: { receiptId: "receipt-fx", fileName: "fx.png", contentHash: "7".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "SSR-850FX" }, catalogSearch: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["fx"], "fx.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-match")?.textContent).toContain("psu.seasonic-focus-plus-gold-850-fx"));
    expect(document.querySelector(".transaction-catalog-match")?.textContent).toContain("本地目录匹配");
    expect(document.querySelector(".transaction-candidate-review")).toBeNull();
    const confirm = document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe("加入待保存采购清单");
    expect(onImport).not.toHaveBeenCalled();
  });

  it("passes governed catalog model identity to official lookup without inventing an MPN", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-asus-board", status: "matched-catalog",
        detected: { name: "ASUS Pro WS W680M-ACE SE", brand: "ASUS", model: "Pro WS W680M-ACE SE", category: "motherboard", qty: 1, unitPriceCny: 2799 },
        catalogMatch: { skuId: "board.asus-w680m-ace-se", kind: "exact-mpn", score: 1 },
        evidence: { receiptId: "receipt-asus-board", fileName: "board.png", contentHash: "8".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "ASUS Pro WS W680M-ACE SE" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-asus-board", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-asus-board") return new Response(JSON.stringify({
        jobId: "job-asus-board", status: "partial", stage: "score", candidates: [],
        summary: { discovered: 0, inspected: 0, fetchSucceeded: 0, productPages: 0, exact: 0, sameFamily: 0, conflicts: 0 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({
      onImport,
      getCatalogSku: (skuId) => skuId === "board.asus-w680m-ace-se" ? ({
        id: skuId, category: "motherboard", brand: "ASUS", model: "Pro WS W680M-ACE SE", name: "ASUS Pro WS W680M-ACE SE", mpn: "Pro WS W680M-ACE SE",
        dims: { evidence: "unknown" }, power: { evidence: "unknown" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: {},
      }) : null,
    });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["board"], "board.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/price/transactions/catalog-search")).toBe(true));
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/price/transactions/catalog-search");
    expect(JSON.parse(String(searchCall?.[1]?.body))).toMatchObject({
      query: "ASUS Pro WS W680M-ACE SE",
      brand: "ASUS",
      model: "Pro WS W680M-ACE SE",
      mpn: "Pro WS W680M-ACE SE",
      expectedSkuId: "board.asus-w680m-ace-se",
      category: "motherboard",
    });
  });

  it.each(["name", "category"] as const)("keeps an exact zero-field official source but makes it stale after editing %s", async (editedField) => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-jonsbo-n6", status: "catalog-search-required",
        detected: { name: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case", qty: 1, unitPriceCny: 799 },
        catalogMatch: null,
        evidence: { receiptId: "receipt-jonsbo-n6", fileName: "n6.png", contentHash: "6".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "JONSBO N6" },
        catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-jonsbo-n6", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-jonsbo-n6") return new Response(JSON.stringify({
        jobId: "job-jonsbo-n6", status: "completed", stage: "score",
        candidates: [{
          skuId: "case.jonsbo-n6", candidateId: "candidate-jonsbo-n6", expectedHash: "e".repeat(64), title: "JONSBO N6",
          canonicalUrl: "https://www.jonsbo.com/en/products/N6Black.html",
          official: { trustStatus: "trusted", pageKind: "product", reasons: ["official product page"] },
          identity: { verdict: "exact", score: 1, reasons: ["official brand and model exactly match"], unknowns: [], criticalConflicts: [] },
          match: { kind: "brand-model", score: 1 },
          extraction: { status: "partial", fieldsFound: 0, error: "missing official fields: dimensions" },
          fields: [],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["n6"], "n6.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();

    await vi.waitFor(() => expect(document.querySelector<HTMLAnchorElement>(".transaction-candidate-review a")?.href).toBe("https://www.jonsbo.com/en/products/N6Black.html"));
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("参数读取说明 · missing official fields: dimensions");
    expect(document.querySelector(".transaction-candidate-warning")?.textContent).toContain("missing official fields: dimensions");
    const approval = document.querySelector<HTMLInputElement>(".transaction-candidate-approval")!;
    expect(approval.disabled).toBe(false);

    if (editedField === "name") {
      const name = document.querySelector<HTMLInputElement>(".transaction-review-name")!;
      name.value = "JONSBO N5";
      name.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const category = document.querySelector<HTMLSelectElement>(".transaction-review-category")!;
      category.value = "accessory";
      category.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(document.querySelector<HTMLElement>(".transaction-candidate-review")?.dataset.state).toBe("stale");
    expect(document.querySelector(".transaction-candidate-warning")?.textContent).toContain("官网候选已失效");
    expect(approval.disabled).toBe(true);
    expect(approval.checked).toBe(false);
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    expect(approval.checked).toBe(false);
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!.click();
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ candidateId: null, officialUrl: null }),
    }), expect.any(File));
    expect(onImport.mock.calls[0]?.[0].evidence).not.toHaveProperty("sourceReview");
  });

  it("does not let a late SKU draft re-enable a candidate after its name changed", async () => {
    const onImport = vi.fn();
    let resolveDraft: ((response: Response) => void) | undefined;
    const draftResponse = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-late-draft", status: "catalog-search-required",
        detected: { name: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case", qty: 1, unitPriceCny: 799 }, catalogMatch: null,
        evidence: { receiptId: "receipt-late-draft", fileName: "late.png", contentHash: "7".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "JONSBO N6" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-late-draft", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-late-draft") return new Response(JSON.stringify({
        jobId: "job-late-draft", status: "completed", stage: "score", candidates: [{
          candidateId: "candidate-late-draft", expectedHash: "e".repeat(64), title: "JONSBO N6", canonicalUrl: "https://www.jonsbo.com/en/products/N6Black.html",
          official: { trustStatus: "trusted", pageKind: "product" }, identity: { verdict: "exact", score: 1, reasons: [], unknowns: [], criticalConflicts: [] },
          match: { kind: "brand-model", score: 1 }, extraction: { status: "partial", fieldsFound: 1 },
          fields: [{ field: "brand", value: "JONSBO", evidence: "official" }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/candidates/candidate-late-draft/enrich") return draftResponse;
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["late"], "late.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/enrich"))).toBe(true));

    const name = document.querySelector<HTMLInputElement>(".transaction-review-name")!;
    name.value = "JONSBO N5";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const draftReview = document.querySelector<HTMLElement>(".transaction-catalog-draft-review")!;
    expect(draftReview.textContent).toContain("已停用");
    resolveDraft!(new Response(JSON.stringify({
      status: "draft", candidateId: "candidate-late-draft", draftId: "draft-late", inputHash: "f".repeat(64), writeEnabled: true,
      draft: { draftId: "draft-late", candidateId: "candidate-late-draft", inputHash: "f".repeat(64), status: "draft", missing: [], conflicts: [], fields: [{ field: "brand", value: "JONSBO", evidence: "official" }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(draftReview.textContent).toContain("已停用");
    expect(draftReview.textContent).not.toContain("已生成可审核");
    for (const button of draftReview.querySelectorAll<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>(".transaction-candidate-approval")?.disabled).toBe(true);
    expect(onImport).not.toHaveBeenCalled();
  });

  it("clears the old governed identity after correction and keeps later searches clean", async () => {
    const onImport = vi.fn();
    const searchBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-corrected-sku", status: "matched-catalog",
        detected: { name: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case", qty: 1, unitPriceCny: 799 },
        catalogMatch: { skuId: "case.jonsbo-n6", kind: "brand-model", score: 1 },
        evidence: { receiptId: "receipt-corrected-sku", fileName: "correct.png", contentHash: "8".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "JONSBO N6" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") {
        searchBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ jobId: `job-corrected-sku-${searchBodies.length}`, status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/catalog/search/job-corrected-sku-")) return new Response(JSON.stringify({ jobId: url.split("/").at(-1), status: "completed", stage: "score", candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({
      onImport,
      getCatalogSku: (skuId) => skuId === "case.jonsbo-n6" ? ({
        id: skuId, category: "case", brand: "JONSBO", model: "N6", mpn: "N6", name: "JONSBO N6",
        dims: { evidence: "unknown" }, power: { evidence: "unknown" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: {},
      }) : null,
    });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["correct"], "correct.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLInputElement>(".transaction-review-name")!.value = "JONSBO N5";
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(searchBodies).toHaveLength(1));
    await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-match")).toBeNull());
    expect(searchBodies[0]).toMatchObject({ query: "JONSBO N5", brand: "JONSBO", category: "case" });
    expect(searchBodies[0]).not.toHaveProperty("model");
    expect(searchBodies[0]).not.toHaveProperty("mpn");
    expect(searchBodies[0]).not.toHaveProperty("expectedSkuId");

    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(searchBodies).toHaveLength(2));
    expect(searchBodies[1]).not.toHaveProperty("model");
    expect(searchBodies[1]).not.toHaveProperty("mpn");
    expect(searchBodies[1]).not.toHaveProperty("expectedSkuId");
  });

  it("treats a cancelled catalog job as a failed terminal result", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-cancelled-job", status: "catalog-search-required",
        detected: { name: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case", qty: 1, unitPriceCny: 799 }, catalogMatch: null,
        evidence: { receiptId: "receipt-cancelled-job", fileName: "cancelled.png", contentHash: "9".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 99, excerpt: "JONSBO N6" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-cancelled", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-cancelled") return new Response(JSON.stringify({ jobId: "job-cancelled", status: "cancelled", stage: "fetch", candidates: [], errors: ["worker cancelled"] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["cancelled"], "cancelled.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("官网核验未完成"));
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("服务错误 · worker cancelled");
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("任务终止 · 已取消");
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!.click();
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ evidence: expect.objectContaining({ verification: "search-failed", officialUrl: null }) }), expect.any(File));
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
          candidates: [{ skuId: "psu.seasonic-focus-plus-gold-850-fx", candidateId: "candidate-user-review", expectedHash: "e".repeat(64), title: "Seasonic FOCUS Plus Gold 850 SSR-850FX", canonicalUrl: "https://seasonic.com/product/focus-plus-gold/", match: { kind: "brand-model", score: 0.85 }, extraction: { status: "partial", fieldsFound: 1 }, fields: [{ field: "power.ratedW", value: 850, evidence: "official" }] }],
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
    startRecognition();

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")?.hidden).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>(".transaction-review-ocr textarea")?.value).toContain("SSR-850FX");
    document.querySelector<HTMLInputElement>(".transaction-review-name")!.value = "Seasonic GX-850 FX";
    document.querySelector<HTMLSelectElement>(".transaction-review-category")!.value = "psu";
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();

    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")?.textContent).toContain("重新核验官网"));
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/price/transactions/catalog-search");
    expect(JSON.parse(String(searchCall?.[1]?.body))).toMatchObject({ query: "Seasonic GX-850 FX", category: "psu" });
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("候选发现完成");
    expect(document.querySelector(".transaction-candidate-fields")?.textContent).toContain("850");
    const finalConfirm = document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!;
    expect(finalConfirm.hidden).toBe(false);
    expect(finalConfirm.disabled).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/enrich"))).toBe(false);
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

  it("turns an exact no-MPN GPU result into an Agent draft that the user can review and add to the plan", async () => {
    const onImport = vi.fn();
    const onCatalogSkuAccepted = vi.fn(async () => ({ appliedToPlan: true, message: "已加入当前方案" }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-stale-brand", status: "catalog-search-required",
        detected: { name: "Intel I41-PO-15053045", brand: "Intel", model: "I41-PO-15053045", category: "gpu", qty: 1, unitPriceCny: 580.49 },
        catalogMatch: null, ocrText: "Intel I41-PO-15053045",
        evidence: { receiptId: "receipt-stale-brand", fileName: "gpu.png", contentHash: "9".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "Intel I41-PO-15053045" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-stale-brand", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-stale-brand") return new Response(JSON.stringify({
        jobId: "job-stale-brand",
        status: "partial",
        stage: "score",
        candidates: [{
          candidateId: "candidate-msi-3070",
          expectedHash: "e".repeat(64),
          title: "GeForce RTX 3070 VENTUS 2X OC",
          canonicalUrl: "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification",
          official: { trustStatus: "trusted", pageKind: "spec", reasons: ["official specification path with identity fields"] },
          identity: { verdict: "exact", score: 0.9167, reasons: ["all supplied category discriminators match"], unknowns: [], criticalConflicts: [] },
          match: { kind: "brand-model", score: 0.9167 },
          extraction: { status: "partial", fieldsFound: 4 },
          fields: [
            { field: "attrs.capacity", value: "8GB GDDR6", evidence: "official" },
            { field: "power.tgpW", value: 220, evidence: "official" },
            { field: "dims.lengthMm", value: 232, evidence: "official" },
            { field: "dims.thicknessMm", value: 52, evidence: "official" },
          ],
        }],
        summary: { discovered: 1, inspected: 1, fetchSucceeded: 1, productPages: 1, exact: 1, sameFamily: 0, conflicts: 0 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/candidates/candidate-msi-3070/enrich") return new Response(JSON.stringify({
        status: "draft", candidateId: "candidate-msi-3070", draftId: "sku-draft-msi-3070", inputHash: "f".repeat(64), writeEnabled: true,
        draft: {
          draftId: "sku-draft-msi-3070", candidateId: "candidate-msi-3070", inputHash: "f".repeat(64), status: "draft", missing: [], conflicts: [],
          fields: [
            { field: "brand", value: "MSI", evidence: "official", sourceKind: "official-page" },
            { field: "model", value: "GeForce RTX 3070 VENTUS 2X OC", evidence: "official", sourceKind: "official-page" },
            { field: "attrs.capacity", value: "8GB GDDR6", evidence: "official", sourceKind: "official-page" },
            { field: "power.tgpW", value: 220, evidence: "official", sourceKind: "official-page" },
            { field: "dims.lengthMm", value: 232, evidence: "official", sourceKind: "official-page" },
            { field: "dims.slots", value: 3, evidence: "inferred", sourceKind: "official-page", note: "由官网 52mm 厚度按 PCI 槽距保守换算" },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-drafts/sku-draft-msi-3070/confirm") return new Response(JSON.stringify({
        status: "confirmed", draftId: "sku-draft-msi-3070", skuId: "gpu.msi-geforce-rtx-3070-ventus-2x-oc",
        sku: {
          id: "gpu.msi-geforce-rtx-3070-ventus-2x-oc", category: "gpu", brand: "MSI", model: "GeForce RTX 3070 VENTUS 2X OC", name: "MSI GeForce RTX 3070 VENTUS 2X OC",
          dims: { lengthMm: 232, heightMm: 124, thicknessMm: 52, slots: 3, evidence: "inferred", note: "长度/厚度来自官网；槽位由厚度保守换算" },
          power: { tgpW: 220, evidence: "official" },
          price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
          attrs: { capacity: "8GB GDDR6", vramGb: 8 }, appearance: { page: "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification" }, provenance: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({
      onImport,
      onCatalogSkuAccepted,
      getPlanContext: () => ({
        planId: "plan-gpu-slot-12345678", planVersionId: null, localRevision: 7, planName: "GPU plan",
        items: [{ id: "gpu.primary", skuId: "gpu.none", name: "显卡未配置（可关联本次购买）", category: "gpu", placeholder: true }],
      }),
    });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["gpu"], "gpu.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    expect(document.querySelector<HTMLSelectElement>(".transaction-review-link")?.value).toBe("gpu.primary");
    expect(document.querySelector(".transaction-review-link-hint")?.textContent).toContain("尚未配置");
    document.querySelector<HTMLInputElement>(".transaction-review-name")!.value = "MSI GeForce RTX 3070 Ventus 2X Overclocked Dual-Fan 8GB GDDR6 PCIe 4.0";
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(document.querySelector(".transaction-candidate-fields")?.textContent).toContain("8GB GDDR6"));
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/price/transactions/catalog-search");
    const searchBody = JSON.parse(String(searchCall?.[1]?.body));
    expect(searchBody).toMatchObject({ query: "MSI RTX 3070 Ventus 2X OC 8GB GDDR6", category: "gpu", trigger: "user-confirmed-review" });
    expect(searchBody).not.toHaveProperty("brand");
    expect(searchBody.query).not.toContain("Intel");
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("已忽略冲突的 OCR 品牌 · Intel");
    expect(document.querySelector<HTMLAnchorElement>(".transaction-candidate-review a")?.href).toBe("https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification");
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-draft-review")?.textContent).toContain("无需填写料号"));
    expect(document.querySelector(".transaction-catalog-draft-review")?.textContent).toContain("Agent 推导");
    expect(document.querySelector(".transaction-catalog-planning-summary")?.textContent).toContain("发热");
    expect(document.querySelector(".transaction-catalog-planning-summary")?.textContent).toContain("噪音：官网未公布可靠声学值");
    const approval = document.querySelector<HTMLInputElement>(".transaction-candidate-approval")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    const accept = [...document.querySelectorAll<HTMLButtonElement>(".transaction-catalog-draft-review button")].find((button) => button.textContent?.includes("接纳 SKU"))!;
    expect(accept.disabled).toBe(false);
    accept.click();
    await vi.waitFor(() => expect(onCatalogSkuAccepted).toHaveBeenCalled());
    expect(onCatalogSkuAccepted).toHaveBeenCalledWith(expect.objectContaining({
      sku: expect.objectContaining({ id: "gpu.msi-geforce-rtx-3070-ventus-2x-oc", category: "gpu" }),
      planId: "plan-gpu-slot-12345678", localRevisionAtReview: 7, planItemId: "gpu.primary",
    }));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      skuId: "gpu.msi-geforce-rtx-3070-ventus-2x-oc",
      evidence: expect.objectContaining({ verification: "matched-catalog", draftId: "sku-draft-msi-3070" }),
    }), expect.any(File));
  });

  it("blocks a category-conflicted search, corrects it, and requires a second confirmation", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-category-conflict", status: "catalog-search-required",
        detected: { name: "GX-850", brand: null, model: "GX-850", category: "motherboard", qty: 1, unitPriceCny: 400 },
        catalogMatch: null, evidence: { receiptId: "receipt-category-conflict", fileName: "psu.png", contentHash: "a".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: null, excerpt: "GX-850" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-category-corrected", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-category-corrected") return new Response(JSON.stringify({ jobId: "job-category-corrected", status: "completed", stage: "score", candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["psu"], "psu.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    const enrich = document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!;
    enrich.click();
    expect(document.querySelector<HTMLSelectElement>(".transaction-review-category")?.value).toBe("psu");
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("已阻止");
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/price/transactions/catalog-search")).toHaveLength(0);
    enrich.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/price/transactions/catalog-search")).toHaveLength(1));
  });

  it("shows an explicit zero-candidate result instead of silently omitting official parameters", async () => {
    const onImport = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-msi", status: "catalog-search-required",
        detected: { name: "MSI GeForce RTX 3070 Ventus 2X Overclocked Dual-Fan 8GB GDDR6 PCIe 4.0", brand: "MSI", model: "RTX 3070 Ventus 2X", category: "gpu", qty: 1, unitPriceCny: 1800 },
        catalogMatch: null, evidence: { receiptId: "receipt-msi", fileName: "gpu.png", contentHash: "8".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 90, excerpt: "RTX 3070" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-msi", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-msi") return new Response(JSON.stringify({ jobId: "job-msi", status: "completed", stage: "score", candidates: [], summary: { discovered: 3, fetchSucceeded: 1, productPages: 1, exact: 0, sameFamily: 1, conflicts: 1 }, warnings: ["未找到官方候选"] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["gpu"], "gpu.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-state="empty"]')?.textContent).toContain("0 个可用候选"));
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("官网查询词 · MSI RTX 3070 Ventus 2X OC 8GB GDDR6");
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("服务警告 · 未找到官方候选");
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("候选漏斗 · 发现 3 · 成功读取 1 · 产品/规格页 1 · 精确型号 0 · 同系列 1 · 冲突 1");
    expect(document.querySelector<HTMLButtonElement>(".transaction-review-enrich")?.textContent).toContain("重新核验官网");
    expect(document.querySelector<HTMLButtonElement>(".transaction-review-retry-ocr")?.textContent).toBe("重新识别");
    const finalConfirm = document.querySelector<HTMLButtonElement>(".transaction-review-actions button:last-child")!;
    expect(finalConfirm.hidden).toBe(false);
    finalConfirm.click();
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      name: "MSI GeForce RTX 3070 Ventus 2X Overclocked Dual-Fan 8GB GDDR6 PCIe 4.0",
      category: "gpu",
      evidence: expect.objectContaining({ verification: "search-no-result" }),
    }), expect.any(File));
  });

  it("submits an editable official URL and automatically starts a parameter refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-manual-site", status: "catalog-search-required",
        detected: { name: "ExampleBrand Model X", brand: "ExampleBrand", model: "Model X", category: "storage", qty: 1, unitPriceCny: 499 },
        catalogMatch: null, evidence: { receiptId: "receipt-manual-site", fileName: "manual-site.png", contentHash: "b".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 90, excerpt: "Model X" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-manual-site", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-manual-site") return new Response(JSON.stringify({ jobId: "job-manual-site", status: "completed", stage: "score", candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport: vi.fn() });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["product"], "manual-site.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(".transaction-review-official-url")).not.toBeNull());
    const officialUrl = document.querySelector<HTMLInputElement>(".transaction-review-official-url")!;
    officialUrl.value = "https://products.example.org/model-x#specifications";
    officialUrl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector<HTMLButtonElement>(".transaction-review-enrich")?.textContent).toContain("保存官网链接并更新参数");
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([request]) => String(request) === "/api/price/transactions/catalog-search")).toBe(true));
    const searchCall = fetchMock.mock.calls.find(([request]) => String(request) === "/api/price/transactions/catalog-search");
    expect(JSON.parse(String(searchCall?.[1]?.body))).toMatchObject({
      brand: "ExampleBrand",
      officialUrl: "https://products.example.org/model-x",
      trigger: "user-confirmed-review",
    });
  });

  it("lets the user approve the closest untrusted official site and then re-runs parameter extraction", async () => {
    let searchCount = 0;
    const searchBodies: Array<Record<string, unknown>> = [];
    const proposalId = "domain-proposal-1234567890abcdef1234";
    const proposalHash = "d".repeat(64);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-site-choice", status: "catalog-search-required",
        detected: { name: "ExampleBrand Model X", brand: "ExampleBrand", model: "Model X", category: "storage", qty: 1, unitPriceCny: 499 },
        catalogMatch: null, evidence: { receiptId: "receipt-site-choice", fileName: "site-choice.png", contentHash: "a".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 90, excerpt: "Model X" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") {
        searchCount += 1;
        searchBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ jobId: `job-site-choice-${searchCount}`, status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/catalog/search/job-site-choice-1") return new Response(JSON.stringify({
        jobId: "job-site-choice-1", status: "completed", stage: "score", candidates: [],
        officialSiteSuggestions: [{ proposalId, inputHash: proposalHash, brand: "ExampleBrand", domain: "products.example.org", url: "https://products.example.org/model-x", title: "ExampleBrand Model X", matchScore: 0.93, reasons: ["域名或标题包含制造商品牌", "命中 2 个型号/关键词"] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === `/api/catalog/domain-proposals/${proposalId}/approve`) return new Response(JSON.stringify({ status: "trusted", proposalId }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-site-choice-2") return new Response(JSON.stringify({ jobId: "job-site-choice-2", status: "completed", stage: "score", candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport: vi.fn() });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["product"], "site-choice.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(document.querySelector(".transaction-official-site-list")?.textContent).toContain("ExampleBrand Model X"));
    expect(document.querySelector(".transaction-official-site-list")?.textContent).toContain("匹配 93%");
    const approval = document.querySelector<HTMLInputElement>(".transaction-official-site-approval")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".transaction-approve-official-site")!.click();
    await vi.waitFor(() => expect(searchBodies).toHaveLength(2));
    expect(fetchMock.mock.calls.some(([request]) => String(request) === `/api/catalog/domain-proposals/${proposalId}/approve`)).toBe(true);
    expect(searchBodies[1]).toMatchObject({ brand: "ExampleBrand", officialUrl: "https://products.example.org/model-x" });
  });

  it("distinguishes a blocked official page from finding no official URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/price/transactions/analyze") return new Response(JSON.stringify({
        receiptId: "receipt-seasonic-blocked", status: "catalog-search-required",
        detected: { name: "Seasonic FOCUS Plus Gold 850 FX", brand: "Seasonic", model: "FOCUS Plus Gold 850 FX", category: "psu", qty: 1, unitPriceCny: 400 },
        catalogMatch: null, evidence: { receiptId: "receipt-seasonic-blocked", fileName: "psu.png", contentHash: "6".repeat(64), capturedAt: "now", ocrEngine: "fixture", ocrConfidence: 98, excerpt: "FOCUS Plus Gold 850 FX" }, catalogSearch: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/price/transactions/catalog-search") return new Response(JSON.stringify({ jobId: "job-seasonic-blocked", status: "queued", stage: "normalize" }), { status: 202, headers: { "Content-Type": "application/json" } });
      if (url === "/api/catalog/search/job-seasonic-blocked") return new Response(JSON.stringify({
        jobId: "job-seasonic-blocked", status: "partial", stage: "score",
        candidates: [{
          candidateId: "candidate-seasonic-blocked", title: "Seasonic FOCUS PLUS Gold", canonicalUrl: "https://seasonic.com/product/focus-plus-gold/",
          official: { trustStatus: "trusted", pageKind: "blocked", reasons: ["HTTP 403"] }, identity: { verdict: "same-family", score: 0.53, reasons: ["suffix unknown"], unknowns: ["psuMpnSuffix"], criticalConflicts: [] },
          extraction: { status: "failed", fieldsFound: 0, error: "official page returned HTTP 403" },
        }], summary: { discovered: 1, inspected: 1, fetchSucceeded: 0, productPages: 0, exact: 0, sameFamily: 1, conflicts: 0, blocked: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport: vi.fn() });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["psu"], "psu.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector(".transaction-review-enrich")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".transaction-review-enrich")!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-state="empty"]')?.textContent).toContain("官网拒绝自动读取"));
    expect(document.querySelector('[data-state="empty"]')?.textContent).toContain("当成事实");
    expect(document.querySelector<HTMLAnchorElement>('[data-state="empty"] a')?.href).toBe("https://seasonic.com/product/focus-plus-gold/");
    expect(document.querySelector(".transaction-search-log")?.textContent).toContain("首个读取失败 · official page returned HTTP 403");
  });

  it("locks every candidate-invalidating or review-leaving control while SKU confirmation is in flight", async () => {
    let resolveConfirm: ((response: Response) => void) | undefined;
    const pendingConfirm = new Promise<Response>((resolve) => { resolveConfirm = resolve; });
    const confirmInits: Array<RequestInit | undefined> = [];
    const fetchMock = catalogDraftFlowFetch((init) => {
      confirmInits.push(init);
      return pendingConfirm;
    });
    const onImport = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport });
    const accept = await reachAcceptableCatalogDraft();
    accept.click();
    await vi.waitFor(() => expect(confirmInits).toHaveLength(1));

    expect(confirmInits[0]?.signal).toBeUndefined();
    expect(document.querySelector<HTMLElement>(".transaction-candidate-review")?.dataset.state).not.toBe("stale");
    for (const selector of [
      ".transaction-review-name", ".transaction-review-category", ".transaction-review-qty", ".transaction-review-price",
      ".transaction-review-stage", ".transaction-review-link", ".transaction-candidate-approval",
      "#transaction-screenshot-input", "#transaction-start-recognition", "#transaction-replace-image", "#transaction-manual-entry",
      "#transaction-retry", "#transaction-cancel",
    ]) expect(document.querySelector<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector)?.disabled).toBe(true);
    for (const button of document.querySelectorAll<HTMLButtonElement>(".transaction-candidate-review button, .transaction-review-actions button")) {
      expect(button.disabled, button.textContent ?? "unnamed control").toBe(true);
    }

    const name = document.querySelector<HTMLInputElement>(".transaction-review-name")!;
    name.value = "JONSBO N5";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".transaction-candidate-review button:last-child")?.click();
    document.querySelector<HTMLButtonElement>(".transaction-review-actions button:first-child")?.click();
    expect(document.querySelector<HTMLElement>(".transaction-candidate-review")?.dataset.state).not.toBe("stale");
    expect(document.querySelector<HTMLElement>("#transaction-screenshot-result")?.hidden).toBe(false);

    resolveConfirm!(new Response(JSON.stringify(CONFIRMED_N6), { status: 200, headers: { "Content-Type": "application/json" } }));
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/confirm"))).toHaveLength(1);
  });

  it("treats a successful confirm as committed and retries only failed plan/import reconciliation", async () => {
    const fetchMock = catalogDraftFlowFetch(() => new Response(JSON.stringify(CONFIRMED_N6), { status: 200, headers: { "Content-Type": "application/json" } }));
    const onCatalogSkuAccepted = vi.fn()
      .mockRejectedValueOnce(new Error("plan projection unavailable"))
      .mockResolvedValue({ appliedToPlan: true, message: "已加入当前方案" });
    const onImport = vi.fn()
      .mockImplementationOnce(() => { throw new Error("staging unavailable"); })
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({ onImport, onCatalogSkuAccepted });
    const accept = await reachAcceptableCatalogDraft();
    accept.click();

    await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-draft-review")?.textContent).toContain("方案同步失败"));
    expect(document.querySelector<HTMLElement>(".transaction-candidate-review")?.dataset.state).toBe("committed");
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("SKU 已确认，但方案同步失败");
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).not.toContain("SKU 接纳失败");
    expect(accept.textContent).toContain("重试方案同步");
    expect(accept.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/confirm"))).toHaveLength(1);
    expect(onImport).not.toHaveBeenCalled();

    accept.click();
    await vi.waitFor(() => expect(document.querySelector(".transaction-catalog-draft-review")?.textContent).toContain("采购记录暂存失败"));
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("SKU 已确认，但采购记录暂存失败");
    expect(accept.textContent).toContain("重试采购记录暂存");
    expect(onCatalogSkuAccepted).toHaveBeenCalledTimes(2);
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/confirm"))).toHaveLength(1);

    accept.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#transaction-screenshot-result")?.hidden).toBe(true));
    expect(onCatalogSkuAccepted).toHaveBeenCalledTimes(2);
    expect(onImport).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/confirm"))).toHaveLength(1);
    expect(document.querySelector("#transaction-screenshot-status")?.textContent).toContain("采购记录已加入待保存清单");
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
    startRecognition();
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("recognizing"));
    document.querySelector<HTMLButtonElement>("#transaction-cancel")!.click();
    await vi.waitFor(() => expect(document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase")).toBe("cancelled"));
    expect(onImport).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>("#transaction-retry")!.hidden).toBe(false);
  });
});
