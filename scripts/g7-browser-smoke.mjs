import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { installLocalCatalogRoute } from "./local-browser-fixtures.mjs";

const webPort = Number(process.env.WEB_SERVER_PORT ?? 5173);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT is invalid");
const webOrigin = `http://127.0.0.1:${webPort}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
await installLocalCatalogRoute(page);
const errors = [];
const responseErrors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", async (response) => {
  if (response.status() >= 400) responseErrors.push({ status: response.status(), url: response.url(), body: await response.text().catch(() => "") });
});
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("404 (Not Found)")) errors.push(message.text());
});

await page.goto(`${webOrigin}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#fit-chip");
await page.waitForSelector("[data-new-plan]");
if (!await page.evaluate(() => window.__N6_LAB__?.isConfigReady() === true)) {
  await page.click("[data-new-plan]");
  await page.click("[data-create-dialog] details > summary");
  await page.selectOption("[data-create-mode]", "template");
  await page.click("[data-create-submit]");
}
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan)
  && window.__N6_LAB__?.isConfigReady() === true);
await page.click('[data-route="editor"]');
await page.waitForSelector('[data-workspace-page="editor"]:not([hidden])');
for (const selector of ["#fit-chip", "#price-table", "#advice-deterministic", "#advice-billing", "#calibration-status", "#cfg-export-checklist"]) {
  if (!(await page.$(selector))) throw new Error(`missing ${selector}`);
}

const calibration = await page.locator("#calibration-status").textContent();
const deterministicBefore = await page.locator("#advice-deterministic").textContent();
if (!calibration?.includes("n6-calibration-1.0.0") || !calibration.includes("unknown")) throw new Error("calibration snapshot is not visible");
if (!deterministicBefore?.includes("physical-rules-1.0.0") || !deterministicBefore.includes("n6-calibration-1.0.0")) throw new Error("advice input does not display physical/calibration provenance");

await page.selectOption('[data-config-field="selection.nvmeCount"]', "3");
await page.selectOption('[data-config-field="selection.boot"]', "m2");
await page.selectOption('[data-config-field="selection.hbaSkuId"]', "hba.lsi-9300-8i-it");
await page.fill('[data-config-field="selection.diskCount"]', "9");
await page.selectOption('[data-config-field="selection.secondaryPsuId"]', "psu.corsair-sf750-atx31");
await page.waitForFunction(() => document.querySelector('[data-config-field="selection.psuTopology"]')?.value === "dual");
await page.selectOption('[data-config-field="selection.dualStart"]', "sync");
await page.waitForTimeout(300);
const evaluation = await page.evaluate(() => window.__N6_LAB__.evaluate());
if (evaluation.config.selection.diskCount !== 9 || evaluation.config.selection.nvmeCount !== 3) throw new Error("parameterized config did not reach BuildEvaluation");
if (!evaluation.physical.hash || !evaluation.calibration.hash) throw new Error("cross-layer hashes missing from BuildEvaluation");

// Checklist exports are deliberately bound to an immutable saved version.
// Persist the parameterized draft before asserting its evidence hashes.
await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") !== "saving");
await page.click("[data-save-version]");
try {
  await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") === "clean");
} catch (error) {
  const state = await page.evaluate(() => {
    const current = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return { saveStatus: current?.saveStatus, error: current?.error, draftRevision: current?.activePlan?.draftRevision, dirty: current?.activePlan?.draft.dirty, config: current?.activePlan?.draft.config };
  });
  throw new Error(`G7 version did not become clean: ${JSON.stringify(state)}`, { cause: error });
}

await page.click('[data-route="build"]');
await page.waitForSelector('[data-workspace-page="build"]:not([hidden])');
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click("[data-export-saved-checklist]"),
]);
const exportPath = await download.path();
if (!exportPath) throw new Error("checklist download did not produce a file");
const exported = await readFile(exportPath, "utf8");
if (!exported.includes(evaluation.physical.hash) || !exported.includes(evaluation.calibration.hash)) throw new Error("export diverged from BuildEvaluation hashes");

const liveAdvice = process.env.BUILD_SIM_BROWSER_LIVE_ADVICE === "1";
let adviceStatus = await page.locator("#advice-status").textContent();
if (liveAdvice) {
  await page.click("#advice-generate");
  await page.waitForFunction(() => !document.querySelector("#advice-generate")?.hasAttribute("disabled"), null, { timeout: 130_000 });
  adviceStatus = await page.locator("#advice-status").textContent();
  const deterministicAfter = await page.locator("#advice-deterministic").textContent();
  if (!adviceStatus?.includes("建议已生成") && !adviceStatus?.includes("AI 建议已关闭") && !adviceStatus?.includes("AI 建议暂不可用")) throw new Error(`unexpected advice status: ${adviceStatus}`);
  if (!deterministicAfter?.includes(evaluation.physical.hash) || !deterministicAfter.includes(evaluation.calibration.hash)) throw new Error("advice request lost deterministic hashes");
}
const billing = await page.locator("#advice-billing").textContent();
if (!billing?.includes("Token") || !billing.includes("估算费用") || !billing.includes("北京时间") || (!billing.includes("计费时段") && !billing.includes("provider 调用记录"))) throw new Error("billing summary did not render pricing provenance and call state");
const unexpectedResponses = responseErrors.filter((response) => !(response.status === 404
  && ((response.url.includes("/api/workspace/plans/") && response.url.endsWith("/evaluations") && response.body.includes("fact_graph_evaluation_disabled"))
    || response.body.includes("disabled"))));
if (errors.length || unexpectedResponses.length) {
  throw new Error(`page errors:\n${errors.join("\n")}\nresponses:\n${unexpectedResponses.map((response) => `${response.status} ${response.url}: ${response.body}`).join("\n")}`);
}

console.log("G7 browser cross-layer smoke passed", {
  physicalHash: evaluation.physical.hash,
  calibrationHash: evaluation.calibration.hash,
  adviceStatus,
  liveAdvice,
});
await browser.close();
