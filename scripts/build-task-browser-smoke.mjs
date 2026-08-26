import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(20_000);
const errors = [];
const archives = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text()); });
page.on("dialog", (dialog) => dialog.accept());

await page.route("**/api/price/transactions/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith("/analyze")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    receiptId: "receipt-browser-r9", status: "matched-catalog",
    detected: { name: "Seasonic FOCUS GX-850 V5", brand: "Seasonic", model: "FOCUS GX-850 V5", category: "psu", qty: 1, unitPriceCny: 899 },
    catalogMatch: { skuId: "psu.seasonic-focus-gx-850-v5", kind: "exact-mpn", score: 1 },
    evidence: { receiptId: "receipt-browser-r9", fileName: "order.png", contentHash: "9".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture-ocr", ocrConfidence: 99, excerpt: "FOCUS GX-850 V5" }, catalogSearch: null,
  }) });
  if (url.pathname.endsWith("/archive") && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: archives }) });
  if (url.pathname.endsWith("/archive") && request.method() === "POST") {
    const body = request.postDataJSON();
    archives.push({ schemaVersion: 2, receiptId: body.receiptId, storedAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z", item: body.item, link: body.link, image: null });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(archives.at(-1)) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

await page.goto("http://127.0.0.1:5173/index.html#/workspace", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation));
if (await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.config.selection.psuId) !== "psu.seasonic-focus-gx-850-v5") {
  await page.click('[data-route="editor"]');
  await page.selectOption('[data-config-field="selection.psuId"]', "psu.seasonic-focus-gx-850-v5");
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.config.selection.psuId === "psu.seasonic-focus-gx-850-v5");
  await page.click('[data-route="workspace"]');
}
await page.click('[data-route-action="purchases"]');
await page.setInputFiles("#transaction-screenshot-input", { name: "order.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.click("#transaction-start-recognition");
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
await page.click(".transaction-review-actions button:last-child");
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (await page.locator("#build-base-close").isVisible()) await page.click("#build-base-close");
await page.click('[data-route="build"]');

const oldRef = "purchase:sku:psu.seasonic-focus-gx-850-v5";
const oldTaskSuffix = encodeURIComponent(oldRef);
const oldRow = page.locator(`[data-task-id][data-task-kind="purchase"]`).filter({ hasText: "psu.seasonic-focus-gx-850-v5" });
await oldRow.waitFor();
if (await oldRow.getAttribute("data-task-status-value") !== "done") throw new Error("archived exact transaction did not complete its purchase task");
await oldRow.locator("[data-task-status]").selectOption("todo");
if (await oldRow.getAttribute("data-task-status-value") !== "todo") throw new Error("manual purchase correction was not retained");
await oldRow.locator("[data-task-status]").selectOption("done");

const assembly = page.locator('[data-task-kind="assembly"][data-task-status-value="todo"]').filter({ has: page.locator("[data-task-spatial]") }).first();
const assemblyTitle = await assembly.locator("h3").textContent();
const assemblyId = await assembly.getAttribute("data-task-id");
await assembly.locator("[data-task-status]").selectOption("doing");
await page.click('[data-route="workspace"]');
await page.click('[data-route="build"]');
if (await page.locator(`[data-task-id="${assemblyId}"]`).getAttribute("data-task-status-value") !== "doing") throw new Error(`task state was lost after route change: ${assemblyTitle}`);
await page.locator(`[data-task-id="${assemblyId}"] [data-task-spatial]`).click();
await page.waitForFunction(() => location.hash === "#/spatial");
if (!await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.partId)) throw new Error("build task did not select a spatial part");

await page.click('[data-route="editor"]');
await page.selectOption('[data-config-field="selection.psuId"]', "psu.corsair-sf750-atx31");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.config.selection.psuId === "psu.corsair-sf750-atx31");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.config.selection.psuId === "psu.corsair-sf750-atx31");
await page.click('[data-route="build"]');
try {
  await page.waitForFunction((suffix) => [...document.querySelectorAll("[data-task-id]")].some((row) => row.getAttribute("data-task-id")?.endsWith(suffix) && row.getAttribute("data-task-status-value") === "obsolete"), oldTaskSuffix);
} catch {
  const diagnostic = await page.evaluate(() => ({
    psu: window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.config.selection.psuId,
    bom: window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.bom.map((line) => line.skuId),
    tasks: [...document.querySelectorAll("[data-task-id]")].filter((row) => row.getAttribute("data-task-kind") === "purchase").map((row) => ({ text: row.textContent, status: row.getAttribute("data-task-status-value") })),
  }));
  throw new Error(`old PSU task did not become obsolete: ${JSON.stringify(diagnostic)}`);
}
const replacement = page.locator('[data-task-kind="purchase"]').filter({ hasText: "psu.corsair-sf750-atx31" });
if (await replacement.getAttribute("data-task-status-value") !== "todo") throw new Error("replacement PSU inherited the old SKU completion state");

await page.click('[data-save-version]');
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.dirty === false);
const downloadPromise = page.waitForEvent("download");
await page.click("[data-export-saved-checklist]");
const download = await downloadPromise;
const stream = await download.createReadStream();
let checklist = "";
for await (const chunk of stream) checklist += chunk.toString();
if (!checklist.includes("## Saved plan trace") || !checklist.includes("Config hash:") || !checklist.includes("Evaluation hash:") || !checklist.includes("purchase:sku:psu.corsair-sf750-atx31")) throw new Error("saved-version checklist is not traceable to its hashes/tasks");

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Build task browser smoke passed", { oldRef, replacement: "purchase:sku:psu.corsair-sf750-atx31", archived: archives.length, checklist: download.suggestedFilename() });
await browser.close();
