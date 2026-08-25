import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors = [];
let unloadPrompts = 0;
page.on("dialog", async (dialog) => {
  if (dialog.type() === "beforeunload") unloadPrompts += 1;
  await dialog.accept();
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text());
});

await page.goto("http://127.0.0.1:5173/index.html#/editor", { waitUntil: "networkidle" });
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

await page.fill("#disk-range", "2");
await page.locator("#disk-range").dispatchEvent("input");
await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") === "saved");
await page.reload({ waitUntil: "networkidle" });
if (await page.locator("#disk-range").inputValue() !== "2") throw new Error("autosaved active draft did not survive refresh");
if (unloadPrompts < 1) throw new Error("dirty draft refresh protection did not prompt");

await page.click("[data-new-plan]");
await page.waitForFunction((id) => {
  const select = document.querySelector("[data-plan-switcher]");
  return select instanceof HTMLSelectElement && select.options.length >= 2 && select.value !== id;
}, initialPlanId);
const secondPlanId = await page.locator("[data-plan-switcher]").inputValue();
if (secondPlanId === initialPlanId) throw new Error("new plan did not become active");
if (await page.locator("#disk-range").inputValue() !== "1") throw new Error("new plan inherited transient DOM state");

await page.click("[data-save-version]");
await page.waitForFunction(() => document.querySelector("[data-save-status]")?.getAttribute("data-status") === "clean");
await page.selectOption("[data-plan-switcher]", initialPlanId);
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, initialPlanId);
if (await page.locator("#disk-range").inputValue() !== "2") throw new Error("switching plans leaked the second plan config");

await page.reload({ waitUntil: "networkidle" });
if (await page.locator("[data-plan-switcher]").inputValue() !== initialPlanId) throw new Error("active plan id did not survive refresh");
if (await page.locator("#disk-range").inputValue() !== "2") throw new Error("active plan config did not survive second refresh");
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);

console.log("Workspace browser smoke passed", { initialPlanId, secondPlanId });
await browser.close();
