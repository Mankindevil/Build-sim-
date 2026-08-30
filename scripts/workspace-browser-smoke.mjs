import { chromium } from "playwright";
import { installLocalCatalogRoute } from "./local-browser-fixtures.mjs";

const webPort = Number(process.env.WEB_SERVER_PORT ?? 5173);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT is invalid");
const webOrigin = `http://127.0.0.1:${webPort}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await installLocalCatalogRoute(page);
page.setDefaultTimeout(15_000);
const errors = [];
const responseErrors = [];
let unloadPrompts = 0;
page.on("dialog", async (dialog) => {
  if (dialog.type() === "beforeunload") unloadPrompts += 1;
  await dialog.accept();
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", async (response) => {
  if (response.status() >= 400) responseErrors.push({ status: response.status(), url: response.url(), body: await response.text().catch(() => "") });
});
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502") && !message.text().includes("404 (Not Found)")) errors.push(message.text());
});

await page.goto(`${webOrigin}/index.html#/editor`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".workspace-global-shell [data-plan-switcher]");
try {
  await page.waitForFunction(() => document.querySelector("[data-plan-switcher]")?.value.startsWith("plan-"));
} catch {
  const diagnostic = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    const switcher = document.querySelector("[data-plan-switcher]");
    return {
      value: switcher instanceof HTMLSelectElement ? switcher.value : null,
      options: switcher instanceof HTMLSelectElement ? [...switcher.options].map((option) => option.value) : [],
      saveStatus: state?.saveStatus,
      offline: state?.offline,
      error: state?.error,
      planIds: state?.plans.map((plan) => plan.id),
      activePlanId: state?.activePlan?.id,
    };
  });
  throw new Error(`default active plan was not rendered: ${JSON.stringify(diagnostic)}`);
}
const initialPlanId = await page.locator("[data-plan-switcher]").inputValue();
if (!initialPlanId.startsWith("plan-")) throw new Error("default active plan was not restored");
if (!(await page.$('[data-workspace-page="editor"] [data-config-field="selection.diskCount"]'))) throw new Error("R3 grouped editor did not render");
await page.waitForFunction(() => Boolean(document.querySelector("#n6-lab")?.getAttribute("data-evaluation-hash")));
const initialEvaluationHashes = await page.evaluate(() => ["n6-lab", "spatial-stage", "build-base-dialog", "agent-title"].map((id) => document.getElementById(id)?.getAttribute("data-evaluation-hash")).filter(Boolean));
if (new Set(initialEvaluationHashes).size !== 1 || !initialEvaluationHashes[0]) throw new Error("major panels do not share one evaluation hash");

const diskCountField = '[data-config-field="selection.diskCount"]';
await page.fill(diskCountField, "2");
await page.locator(diskCountField).dispatchEvent("change");
await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") === "saved");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, initialPlanId);
if (await page.locator(diskCountField).inputValue() !== "2") throw new Error("autosaved active draft did not survive refresh");
if (unloadPrompts < 1) throw new Error("dirty draft refresh protection did not prompt");

await page.click('[data-route="workspace"]');
await page.click('[data-workspace-page="workspace"] > header [data-open-create]');
await page.fill("[data-create-name]", "E2E second plan");
await page.click("[data-create-submit]");
await page.waitForFunction((id) => {
  const select = document.querySelector("[data-plan-switcher]");
  return select instanceof HTMLSelectElement && select.options.length >= 2 && select.value !== id;
}, initialPlanId);
const secondPlanId = await page.locator("[data-plan-switcher]").inputValue();
if (secondPlanId === initialPlanId) throw new Error("new plan did not become active");
if (await page.locator(diskCountField).inputValue() !== "0") throw new Error("new blank plan inherited transient DOM state");

await page.click("[data-open-save]");
await page.fill("[data-version-summary]", "E2E initial version");
await page.click("[data-version-submit]");
await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") === "clean");
const savedVersionContext = await page.evaluate(async () => {
  const planId = window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id;
  const response = await fetch(`/api/workspace/plans/${encodeURIComponent(planId ?? "")}/versions`);
  const payload = await response.json();
  return { versions: payload.versions, evaluationHash: window.__BUILD_SIM_PLAN_STORE__?.getState().evaluationSnapshot?.evaluationHash ?? null };
});
if (savedVersionContext.versions.at(-1)?.evaluationHash !== savedVersionContext.evaluationHash) throw new Error(`saved version lost evaluation hash binding: ${JSON.stringify(savedVersionContext)}`);
await page.click("[data-open-history]");
await page.waitForFunction(() => document.querySelector("[data-version-list]")?.textContent?.includes("E2E initial version"));
await page.click("[data-close-history]");
await page.selectOption("[data-plan-switcher]", initialPlanId);
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, initialPlanId);
if (await page.locator(diskCountField).inputValue() !== "2") throw new Error("switching plans leaked the second plan config");

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, initialPlanId);
if (await page.locator("[data-plan-switcher]").inputValue() !== initialPlanId) throw new Error("active plan id did not survive refresh");
if (await page.locator(diskCountField).inputValue() !== "2") throw new Error("active plan config did not survive second refresh");
const legacyEvaluationFallbackReady = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return document.getElementById("n6-lab")?.getAttribute("data-evaluation-authority") === "disabled"
    && state?.evaluationSnapshot?.draftRevision === state.activePlan?.draftRevision;
});
const unexpectedResponses = responseErrors.filter((response) => {
  const pathname = new URL(response.url).pathname;
  return !(response.status === 404 && legacyEvaluationFallbackReady
    && /^\/api\/workspace\/plans\/[^/]+\/evaluations$/.test(pathname));
});
if (errors.length || unexpectedResponses.length) throw new Error(`page errors:\n${errors.join("\n")}\nresponses:\n${unexpectedResponses.map((response) => `${response.status} ${response.url}: ${response.body}`).join("\n")}`);

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await installLocalCatalogRoute(mobile);
await mobile.goto(`${webOrigin}/index.html#/workspace`, { waitUntil: "domcontentloaded" });
await mobile.waitForFunction(() => document.querySelector("[data-plan-switcher]")?.value.startsWith("plan-"));
await mobile.locator('[data-route="editor"]').focus();
await mobile.keyboard.press("Enter");
await mobile.waitForFunction(() => location.hash === "#/editor");
if (!(await mobile.locator('[data-config-field="selection.diskCount"]').isVisible())) throw new Error("mobile keyboard route did not expose the editor");
await mobile.locator('[data-route="workspace"]').click();
await mobile.locator('[data-workspace-page="workspace"] > header [data-open-create]').click();
if (!(await mobile.locator("[data-create-dialog]").isVisible())) throw new Error("mobile create dialog is not operable");
await mobile.locator('[data-create-dialog] button[value="cancel"]').first().click();
await mobile.close();

console.log("Workspace browser smoke passed", { initialPlanId, secondPlanId });
await browser.close();
