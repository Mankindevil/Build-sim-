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
  const overlays = window.__BUILD_SIM_SPATIAL__?.getOverlays();
  return {
    units: model?.coordinateSystem.units,
    bounds: model?.bounds,
    parts: model?.nodes.map((node) => node.partId),
    driveCount: model?.nodes.filter((node) => node.kind === "drive").length,
    routeCount: overlays?.routes.length,
    sourceRouteCount: window.__BUILD_SIM_PLAN_STORE__?.getState().evaluation?.routing.cables.length,
    findingCount: overlays?.findings.filter((finding) => finding.verdict !== "ok").length,
    findingIds: overlays?.findings.filter((finding) => finding.verdict !== "ok").map((finding) => finding.id),
    thermalAvailable: overlays?.thermal.available,
    assemblyCount: overlays?.assembly.length,
  };
});
if (facts.units !== "mm" || facts.bounds?.w !== 305 || !facts.parts?.includes("board") || !facts.parts.includes("cpu")) throw new Error(`scene model is incomplete: ${JSON.stringify(facts)}`);
if (facts.routeCount !== facts.sourceRouteCount || !facts.assemblyCount) throw new Error(`overlay model diverged from BuildEvaluation: ${JSON.stringify(facts)}`);

await page.click('[data-camera="orthographic"]');
if (await page.locator('[data-camera="orthographic"]').getAttribute("aria-pressed") !== "true") throw new Error("orthographic camera did not activate");
await page.click('[data-view="top"]');
await page.click(".three-spatial-display-menu > summary");
await page.click("[data-explode]");
await page.click("[data-routes]");
await page.click("[data-dimensions]");
if (facts.thermalAvailable) await page.click("[data-thermal]");
await page.waitForFunction((thermal) => {
  const context = window.__BUILD_SIM_SPATIAL__?.getContext();
  return context?.routesVisible === true && context?.dimensionsVisible === true && (!thermal || context?.thermalVisible === true);
}, facts.thermalAvailable);
await canvas.hover({ position: { x: 600, y: 260 } });
await canvas.click({ position: { x: 600, y: 260 } });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.partId));
if (!(await page.locator(".three-spatial-inspector h4").isVisible())) throw new Error("raycast selection did not populate inspector");
await canvas.hover({ position: { x: 480, y: 300 } });
await page.mouse.wheel(0, -180);

const beforeDriveCount = facts.driveCount ?? 0;
await page.click('[data-route="editor"]');
await page.fill('[data-config-field="selection.diskCount"]', String(Math.min(8, beforeDriveCount + 1)));
await page.locator('[data-config-field="selection.diskCount"]').dispatchEvent("change");
await page.waitForFunction((count) => window.__BUILD_SIM_SPATIAL__?.getModel()?.nodes.filter((node) => node.kind === "drive").length === count + 1, beforeDriveCount);
await page.click('[data-route="spatial"]');

if (facts.findingCount) {
  const findingId = await page.locator("[data-finding-select] option").nth(1).getAttribute("value");
  await page.selectOption("[data-finding-select]", findingId);
  await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.findingId === id, findingId);
  await page.click("[data-edit-finding]");
  await page.waitForFunction(() => location.hash === "#/editor");
  if (!(await page.evaluate(() => document.activeElement?.matches("[data-editor-field] input, [data-editor-field] select")))) throw new Error("finding did not return to its repair field");
  await page.locator('[data-editor-field="selection.psuId"]').hover();
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.view === "editor");
  await page.click('[data-route="workspace"]');
  const dashboardFinding = page.locator("[data-current-plan] [data-finding-id]").first();
  if (await dashboardFinding.count()) {
    await dashboardFinding.click();
    await page.waitForFunction(() => location.hash === "#/spatial" && Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.findingId));
  } else await page.click('[data-route="spatial"]');
}

await page.click('[data-route="editor"]');
await page.fill('[data-editor-field="selection.diskCount"] input', "9");
await page.locator('[data-editor-field="selection.diskCount"] input').dispatchEvent("change");
await page.selectOption('[data-editor-field="selection.boot"] select', "bay");
await page.waitForFunction(() => window.__BUILD_SIM_SPATIAL__?.getOverlays()?.findings.some((finding) => finding.id === "n6.bay9-boot-vs-9hdd" && finding.verdict === "bad"));
await page.click('[data-route="workspace"]');
const fixableFinding = page.locator('[data-workspace-page="workspace"] [data-finding-id="n6.bay9-boot-vs-9hdd"]').first();
if (!(await fixableFinding.isVisible())) throw new Error("fixable blocker was not surfaced on the workspace");
await fixableFinding.click();
await page.waitForFunction(() => location.hash === "#/spatial" && window.__BUILD_SIM_PLAN_STORE__?.getState().selection?.findingId === "n6.bay9-boot-vs-9hdd");
await page.click("[data-edit-finding]");
await page.waitForFunction(() => location.hash === "#/editor" && document.activeElement?.closest('[data-editor-field="selection.diskCount"]'));
await page.fill('[data-editor-field="selection.diskCount"] input', "8");
await page.locator('[data-editor-field="selection.diskCount"] input').dispatchEvent("change");
await page.waitForFunction(() => !window.__BUILD_SIM_SPATIAL__?.getOverlays()?.findings.some((finding) => finding.id === "n6.bay9-boot-vs-9hdd"));
await page.click('[data-route="spatial"]');

await page.selectOption("[data-assembly-select]", "0");
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_SPATIAL__?.getContext().assemblyStepId));
const agentContext = page.evaluate(() => new Promise((resolve) => document.addEventListener("build-sim:spatial-agent-context", (event) => resolve(event.detail), { once: true })));
await page.click("[data-ask-agent]");
const agentDetail = await agentContext;
if (!agentDetail?.planId || !agentDetail?.evaluationHash || !agentDetail?.camera) throw new Error(`Agent spatial context incomplete: ${JSON.stringify(agentDetail)}`);
await page.waitForFunction(() => location.hash === "#/agent");
await page.click('[data-route="spatial"]');
const [capture] = await Promise.all([page.waitForEvent("download"), page.click("[data-capture]")]);
if (!capture.suggestedFilename().endsWith(".png") || !(await capture.path())) throw new Error("current-view screenshot was not exported");

const fallback = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await fallback.goto("http://127.0.0.1:5173/index.html?spatialFallback=1#/spatial", { waitUntil: "networkidle" });
await fallback.waitForFunction(() => window.__BUILD_SIM_SPATIAL__?.getMode() === "fallback");
if (!(await fallback.locator("#iso-svg").isVisible())) throw new Error("SVG fallback is not operable");
if (!(await fallback.locator("[data-three-fallback]").textContent())?.includes("SVG")) throw new Error("fallback reason is not shown");
await fallback.locator("#iso-svg").focus();
await fallback.keyboard.press("ArrowRight");
await fallback.close();

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Spatial browser smoke passed", { nodeCount: facts.parts.length, beforeDriveCount, findingIds: facts.findingIds });
await browser.close();
