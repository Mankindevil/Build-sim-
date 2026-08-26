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
    expect(confirm.textContent).toBe("按当前内容保存");
    expect(onImport).not.toHaveBeenCalled();
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

  it("drops a stale OCR brand after manual correction and exposes an empty GPU plan slot", async () => {
    const onImport = vi.fn();
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
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    initTransactionImport({
      onImport,
      getPlanContext: () => ({
        planId: "plan-gpu-slot-12345678", planVersionId: null, planName: "GPU plan",
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
