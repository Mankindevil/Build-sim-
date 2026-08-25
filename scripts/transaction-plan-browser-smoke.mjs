import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
page.setDefaultTimeout(20_000);
const errors = [];
const archives = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text()); });
page.on("dialog", (dialog) => dialog.accept());

await page.route("**/api/price/transactions/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith("/analyze")) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      receiptId: "receipt-browser-r8", status: "matched-catalog",
      detected: { name: "Seasonic FOCUS GX-850 V5", brand: "Seasonic", model: "FOCUS GX-850 V5", category: "psu", qty: 1, unitPriceCny: 899 },
      catalogMatch: { skuId: "psu.seasonic-focus-gx-850-v5", kind: "exact-mpn", score: 1 },
      evidence: { receiptId: "receipt-browser-r8", fileName: "order.png", contentHash: "a".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture-ocr", ocrConfidence: 97, excerpt: "FOCUS GX-850 V5 · CNY 899" }, catalogSearch: null,
    }) });
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

await page.goto("http://127.0.0.1:5173/index.html#/workspace", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation));
const plan = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  return { id: state.activePlan.id, versionId: state.activePlan.activeVersionId };
});
const baselineKnownSpent = await page.evaluate(() => {
  const matches = [...(document.querySelector("#build-hero-progress")?.textContent?.matchAll(/¥([\d,]+)/g) ?? [])];
  return Number(matches.at(-1)?.[1]?.replaceAll(",", "") ?? 0);
});
await page.click('[data-route-action="purchases"]');
await page.waitForFunction(() => document.querySelector("#build-base-dialog")?.hasAttribute("open"));
await page.setInputFiles("#transaction-screenshot-input", { name: "order.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
if (!(await page.locator(".transaction-review-evidence").textContent()).includes("97%")) throw new Error("OCR confidence/evidence was not shown in review");
if (await page.locator(".transaction-review-link").inputValue() !== "psu.seasonic-focus-gx-850-v5") throw new Error("matched PSU was not linked to the active plan item by default");
await page.click(".transaction-review-actions button:last-child");
if (await page.locator("#transaction-screenshot-status").getAttribute("data-phase") !== "staged") throw new Error("review confirmation did not remain visibly staged");
if (archives.length) throw new Error("staged transaction was archived before Save");
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (archives.length !== 1 || archives[0].link.planId !== plan.id || archives[0].link.planItemId !== "psu.seasonic-focus-gx-850-v5" || archives[0].link.linkStatus !== "linked") throw new Error(`archived plan link is wrong: ${JSON.stringify(archives[0]?.link)}`);
const purchase = await page.evaluate((planId) => JSON.parse(localStorage.getItem(`build-sim.progress.v2:${planId}`) ?? "null"), plan.id);
if (purchase?.items?.["psu.seasonic-focus-gx-850-v5"]?.unitPriceCny !== 899) throw new Error("active plan purchase budget was not persisted");
await page.waitForFunction((baseline) => {
  const matches = [...(document.querySelector("#build-hero-progress")?.textContent?.matchAll(/¥([\d,]+)/g) ?? [])];
  const current = Number(matches.at(-1)?.[1]?.replaceAll(",", "") ?? 0);
  return current === baseline + 899 && document.querySelector("#next-buy-list")?.textContent?.includes("¥899");
}, baselineKnownSpent);

await page.click("#build-base-edit");
await page.click("#build-review-transactions-tab");
await page.waitForSelector('[data-archive-receipt="receipt-browser-r8"]');
if (!(await page.locator('[data-archive-receipt="receipt-browser-r8"] [data-link-status="linked"]').isVisible())) throw new Error("linked archive was not visible for active plan");
await page.click('[data-archive-delete-image="receipt-browser-r8"]');
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (archives[0].image !== null || archives[0].item.name !== "Seasonic FOCUS GX-850 V5") throw new Error("privacy image deletion removed the transaction summary");

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Transaction plan browser smoke passed", { planId: plan.id, receiptId: archives[0].receiptId, planItemId: archives[0].link.planItemId, imageDeleted: archives[0].image === null });
await browser.close();
