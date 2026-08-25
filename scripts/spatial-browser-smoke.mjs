import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text());
});

await page.goto("http://127.0.0.1:5173/index.html#/spatial", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__BUILD_SIM_SPATIAL__?.getMode() === "three");
await page.locator("#spatial-stage").scrollIntoViewIfNeeded();
const canvas = page.locator(".three-spatial-canvas canvas");
await canvas.waitFor({ state: "visible" });
const facts = await page.evaluate(() => {
  const model = window.__BUILD_SIM_SPATIAL__?.getModel();
  return {
    units: model?.coordinateSystem.units,
    bounds: model?.bounds,
    parts: model?.nodes.map((node) => node.partId),
    driveCount: model?.nodes.filter((node) => node.kind === "drive").length,
  };
});
if (facts.units !== "mm" || facts.bounds?.w !== 305 || !facts.parts?.includes("board") || !facts.parts.includes("cpu")) throw new Error(`scene model is incomplete: ${JSON.stringify(facts)}`);

await page.click('[data-camera="orthographic"]');
if (await page.locator('[data-camera="orthographic"]').getAttribute("aria-pressed") !== "true") throw new Error("orthographic camera did not activate");
await page.click('[data-view="top"]');
await page.click("[data-explode]");
await canvas.hover({ position: { x: 600, y: 260 } });
await canvas.click({ position: { x: 600, y: 260 } });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.partId));
if (!(await page.locator(".three-spatial-inspector h4").isVisible())) throw new Error("raycast selection did not populate inspector");
await canvas.hover({ position: { x: 480, y: 300 } });
await page.mouse.wheel(0, -180);

const beforeDriveCount = facts.driveCount ?? 0;
await page.fill("#disk-range", String(Math.min(8, beforeDriveCount + 1)));
await page.locator("#disk-range").dispatchEvent("input");
await page.waitForFunction((count) => window.__BUILD_SIM_SPATIAL__?.getModel()?.nodes.filter((node) => node.kind === "drive").length === count + 1, beforeDriveCount);

const fallback = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await fallback.goto("http://127.0.0.1:5173/index.html?spatialFallback=1#/spatial", { waitUntil: "networkidle" });
await fallback.waitForFunction(() => window.__BUILD_SIM_SPATIAL__?.getMode() === "fallback");
if (!(await fallback.locator("#iso-svg").isVisible())) throw new Error("SVG fallback is not operable");
if (!(await fallback.locator("[data-three-fallback]").textContent())?.includes("SVG")) throw new Error("fallback reason is not shown");
await fallback.locator("#iso-svg").focus();
await fallback.keyboard.press("ArrowRight");
await fallback.close();

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Spatial browser smoke passed", { nodeCount: facts.parts.length, beforeDriveCount });
await browser.close();
