import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
page.setDefaultTimeout(20_000);
const errors = [];
const archives = [];
let transactionSearchBody = null;
let activePsuId = "psu.seasonic-focus-gx-850-v5";
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text()); });
page.on("dialog", (dialog) => dialog.accept());

await page.route("**/api/price/transactions/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith("/analyze")) {
    const requestBody = request.postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (requestBody.fileName === "gpu.png") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      receiptId: "receipt-browser-gpu", status: "catalog-search-required",
      detected: { name: "Intel I41-PO-15053045", brand: "Intel", model: "I41-PO-15053045", category: "gpu", qty: 1, unitPriceCny: 580.49 },
      catalogMatch: null, ocrText: "Intel I41-PO-15053045",
      evidence: { receiptId: "receipt-browser-gpu", fileName: "gpu.png", contentHash: "b".repeat(64), capturedAt: "2026-08-26T00:00:00.000Z", ocrEngine: "fixture-ocr", ocrConfidence: null, excerpt: "Intel I41-PO-15053045" }, catalogSearch: null,
    }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      receiptId: "receipt-browser-r8", status: "matched-catalog",
      detected: { name: "Seasonic FOCUS GX-850 V5", brand: "Seasonic", model: "FOCUS GX-850 V5", category: "psu", qty: 1, unitPriceCny: 899 },
      catalogMatch: { skuId: activePsuId, kind: "exact-mpn", score: 1 },
      evidence: { receiptId: "receipt-browser-r8", fileName: "order.png", contentHash: "a".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture-ocr", ocrConfidence: 97, excerpt: "FOCUS GX-850 V5 · CNY 899" }, catalogSearch: null,
    }) });
  }
  if (url.pathname.endsWith("/catalog-search")) {
    transactionSearchBody = request.postDataJSON();
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-browser-gpu", status: "queued", stage: "normalize" }) });
  }
  if (url.pathname.endsWith("/archive") && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: archives }) });
  if (url.pathname.endsWith("/archive") && request.method() === "POST") {
    const body = request.postDataJSON();
    const record = { schemaVersion: 2, receiptId: body.receiptId, storedAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z", item: body.item, link: body.link, image: { fileName: "order.png", mimeType: "image/png", bytes: 4, contentHash: body.item.transaction.contentHash, imageUrl: `/api/price/transactions/archive/${body.receiptId}/image` } };
    archives.splice(0, archives.length, record);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(record) });
  }
  if (url.pathname.endsWith("/image") && request.method() === "DELETE") {
    if (archives[0]) { archives[0].image = null; archives[0].updatedAt = "2026-08-25T01:01:00.000Z"; }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(archives[0]) });
  }
  if (request.method() === "PATCH") {
    const body = request.postDataJSON(); Object.assign(archives[0].item, body.item ?? {}); archives[0].link = body.link ?? archives[0].link;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(archives[0]) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

await page.route("**/api/catalog/search/job-browser-gpu", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-browser-gpu", status: "completed", stage: "score", candidates: [], summary: { discovered: 0, exact: 0 } }) }));

await page.goto("http://127.0.0.1:5173/index.html#/workspace", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation));
const plan = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  return { id: state.activePlan.id, versionId: state.activePlan.activeVersionId, psuId: state.activePlan.draft.config.selection.psuId };
});
activePsuId = plan.psuId;
const baselineKnownSpent = await page.evaluate(() => {
  const matches = [...(document.querySelector("#build-hero-progress")?.textContent?.matchAll(/¥([\d,]+)/g) ?? [])];
  return Number(matches.at(-1)?.[1]?.replaceAll(",", "") ?? 0);
});
await page.evaluate(() => {
  window.location.hash = "#/purchases";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});
await page.waitForFunction(() => document.querySelector("#build-base-dialog")?.hasAttribute("open"));
await page.setInputFiles("#transaction-screenshot-input", { name: "order.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.click("#transaction-start-recognition");
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
if (!(await page.locator(".transaction-review-evidence").textContent()).includes("97%")) throw new Error("OCR confidence/evidence was not shown in review");
if (await page.locator(".transaction-review-link").inputValue() !== activePsuId) throw new Error("matched PSU was not linked to the active plan item by default");
if (await page.locator(".transaction-candidate-approval").count()) await page.check(".transaction-candidate-approval");
await page.click(".transaction-review-actions button:last-child");
if (await page.locator("#transaction-screenshot-status").getAttribute("data-phase") !== "staged") throw new Error("review confirmation did not remain visibly staged");
if (archives.length) throw new Error("staged transaction was archived before Save");
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (archives.length !== 1 || archives[0].link.planId !== plan.id || archives[0].link.planItemId !== activePsuId || archives[0].link.linkStatus !== "linked") throw new Error(`archived plan link is wrong: ${JSON.stringify(archives[0]?.link)}`);
const purchase = await page.evaluate((planId) => JSON.parse(localStorage.getItem(`build-sim.progress.v2:${planId}`) ?? "null"), plan.id);
if (purchase?.items?.[activePsuId]?.unitPriceCny !== 899) throw new Error("active plan purchase budget was not persisted");
await page.waitForFunction((baseline) => {
  const matches = [...(document.querySelector("#build-hero-progress")?.textContent?.matchAll(/¥([\d,]+)/g) ?? [])];
  const current = Number(matches.at(-1)?.[1]?.replaceAll(",", "") ?? 0);
  return current === baseline + 899 && document.querySelector("#next-buy-list")?.textContent?.includes("¥899");
}, baselineKnownSpent);

await page.click("#build-review-transactions-tab");
await page.waitForSelector('[data-archive-receipt="receipt-browser-r8"]');
if (!(await page.locator('[data-archive-receipt="receipt-browser-r8"] [data-link-status="linked"]').isVisible())) throw new Error("linked archive was not visible for active plan");
await page.click('[data-archive-delete-image="receipt-browser-r8"]');
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (archives[0].image !== null || archives[0].item.name !== "Seasonic FOCUS GX-850 V5") throw new Error("privacy image deletion removed the transaction summary");

await page.evaluate(() => {
  window.location.hash = "#/purchases";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});
await page.waitForFunction(() => document.querySelector("#build-base-dialog")?.hasAttribute("open"));
await page.click("#build-review-current-tab");
await page.setInputFiles("#transaction-screenshot-input", { name: "gpu.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.click("#transaction-start-recognition");
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
const gpuLink = await page.locator(".transaction-review-link").evaluate((select) => ({ value: select.value, options: [...select.options].map((option) => ({ value: option.value, text: option.textContent })) }));
const gpuPlanOption = gpuLink.options.find((option) => option.value === "gpu.primary" || option.text?.startsWith("显卡 ·"));
if (!gpuPlanOption) throw new Error(`GPU plan position was omitted: ${JSON.stringify(gpuLink)}`);
if (gpuPlanOption.value === "gpu.primary" && gpuLink.value !== "gpu.primary") throw new Error(`empty GPU plan slot was not selected by default: ${JSON.stringify(gpuLink)}`);
await page.locator(".transaction-review-name").fill("MSI GeForce RTX 3070 Ventus 2X Overclocked Dual-Fan 8GB GDDR6 PCIe 4.0");
await page.click(".transaction-review-enrich");
await page.waitForSelector('.transaction-candidate-review[data-state="empty"]');
if (transactionSearchBody?.query !== "MSI RTX 3070 Ventus 2X OC 8GB GDDR6" || transactionSearchBody?.brand) throw new Error(`stale OCR brand polluted corrected search: ${JSON.stringify(transactionSearchBody)}`);
if (transactionSearchBody?.trigger !== "user-confirmed-review") throw new Error("transaction search trigger was not audited");
if (!(await page.locator(".transaction-search-log").textContent()).includes("已忽略冲突的 OCR 品牌 · Intel")) throw new Error("stale OCR brand removal was not visible");
if (!(await page.locator(".transaction-review-enrich").textContent()).includes("重新核验官网")) throw new Error("catalog search retry was not offered");
if (!(await page.locator(".transaction-review-retry-ocr").isVisible())) throw new Error("successful OCR could not be retried");

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Transaction plan browser smoke passed", { planId: plan.id, receiptId: archives[0].receiptId, planItemId: archives[0].link.planItemId, imageDeleted: archives[0].image === null });
await browser.close();
