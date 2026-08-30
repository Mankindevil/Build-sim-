import { chromium } from "playwright";
import { installLocalCatalogRoute } from "./local-browser-fixtures.mjs";

const webPort = Number(process.env.WEB_SERVER_PORT ?? 5173);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT is invalid");
const webOrigin = `http://127.0.0.1:${webPort}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
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
try {
  await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan)
    && window.__N6_LAB__?.isConfigReady() === true);
} catch (error) {
  const state = await page.evaluate(() => ({
    activePlan: window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan ?? null,
    ready: window.__N6_LAB__?.isConfigReady() ?? null,
    authority: document.getElementById("n6-lab")?.getAttribute("data-evaluation-authority"),
    fit: document.getElementById("fit-chip")?.textContent,
  }));
  throw new Error(`G1 plan did not become ready: ${JSON.stringify(state)}`, { cause: error });
}
await page.click('[data-route="editor"]');
await page.waitForSelector('[data-workspace-page="editor"]:not([hidden])');
for (const selector of ["#fit-chip", "#kpi-wall", "#temperature-bars", "#port-map", "#price-table"]) {
  if (!(await page.$(selector))) throw new Error(`missing ${selector}`);
}

const initialFit = await page.locator("#fit-chip").textContent();
await page.selectOption('[data-config-field="selection.secondaryPsuId"]', "psu.corsair-sf750-atx31");
await page.waitForFunction(() => document.querySelector('[data-config-field="selection.psuTopology"]')?.value === "dual");
await page.selectOption('[data-config-field="selection.dualStart"]', "sync");
await page.selectOption('[data-fan-mount="front"] [data-fan-count]', "0");
await page.selectOption('[data-config-field="selection.coolerId"]', "cooler.aio-240-front");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && state.evaluationSnapshot?.draftRevision === state.activePlan?.draftRevision
    && document.getElementById("n6-lab")?.getAttribute("data-evaluation-authority") === "disabled"
    && document.querySelector("#wiring-title")?.textContent?.includes("HDD");
});
const dualWiring = await page.locator("#wiring-title").textContent();
const dualPrice = await page.locator("#price-table").textContent();
if (!dualWiring?.includes("HDD")) throw new Error(`dual PSU did not re-render wiring from BuildEvaluation: ${JSON.stringify(dualWiring)}`);
if (!dualPrice || dualPrice.includes("¥4,500") || dualPrice.includes("4500×")) throw new Error("price table contains legacy hardcoded disk price");

await page.selectOption('[data-config-field="selection.psuTopology"]', "auto");
await page.selectOption('[data-config-field="selection.coolerId"]', "cooler.thermalright-axp90-x53-full");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  const selection = state?.activePlan?.draft.config.schemaVersion === "2.0.0" ? state.activePlan.draft.config.selection : null;
  return state?.saveStatus === "saved"
    && state.evaluationSnapshot?.draftRevision === state.activePlan?.draftRevision
    && selection?.psuTopology === "auto"
    && selection?.coolerId === "cooler.thermalright-axp90-x53-full"
    && document.getElementById("fit-chip")?.textContent !== "—";
});
const currentFit = await page.locator("#fit-chip").textContent();
if (!currentFit || !initialFit) throw new Error("fit chip did not render");
const unexpectedResponses = responseErrors.filter((response) => !(response.status === 404
  && response.url.includes("/api/workspace/plans/")
  && response.url.endsWith("/evaluations")
  && response.body.includes("fact_graph_evaluation_disabled")));
if (errors.length || unexpectedResponses.length) {
  const state = await page.evaluate(() => {
    const current = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return { saveStatus: current?.saveStatus, error: current?.error, draftRevision: current?.activePlan?.draftRevision, config: current?.activePlan?.draft.config };
  });
  throw new Error(`page errors:\n${errors.join("\n")}\nresponses:\n${unexpectedResponses.map((response) => `${response.status} ${response.url}: ${response.body}`).join("\n")}\nstate: ${JSON.stringify(state)}`);
}
console.log("G1 browser smoke passed", { initialFit, currentFit });
await browser.close();
