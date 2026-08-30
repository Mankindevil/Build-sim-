import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installLocalCatalogRoute } from "./local-browser-fixtures.mjs";

const visualRoot = await mkdtemp(path.join(tmpdir(), "build-sim-r10-visual-"));
const webPort = Number(process.env.WEB_SERVER_PORT ?? 5173);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT is invalid");
const webOrigin = `http://127.0.0.1:${webPort}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await installLocalCatalogRoute(page);
page.setDefaultTimeout(25_000);
const errors = [];
const archives = [];
const workspaceTraffic = [];
const httpFailures = [];
const recordWorkspaceTraffic = (entry) => {
  workspaceTraffic.push(entry);
  if (workspaceTraffic.length > 40) workspaceTraffic.shift();
};
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() !== "error" || /500|502/.test(message.text()) || message.text().startsWith("Failed to load resource:")) return;
  errors.push(message.text());
});
page.on("dialog", (dialog) => dialog.accept());
const expectedOfflineHttpFailure = (response) => {
  const request = response.request();
  const { pathname } = new URL(response.url());
  if (response.status() === 500 && request.method() === "GET" && [
    "/api/price/catalog",
    "/api/price/state",
    "/api/advice/billing",
  ].includes(pathname)) return true;
  if (response.status() === 404 && request.method() === "POST" && /^\/api\/workspace\/plans\/[^/]+\/evaluations$/.test(pathname)) return true;
  if (response.status() === 400 && request.method() === "POST" && pathname === "/api/agent/evaluate") {
    const config = request.postDataJSON()?.buildConfig;
    return !config?.caseId || !config?.boardId || !config?.cpuId;
  }
  return false;
};
page.on("request", (request) => {
  if (!request.url().includes("/api/workspace/plans/") || request.method() !== "PATCH") return;
  const body = request.postDataJSON();
  recordWorkspaceTraffic({
    phase: "request",
    expectedRevision: body?.expectedRevision,
    idempotencyKey: body?.idempotencyKey,
    diskCount: body?.config?.selection?.diskCount,
    psuId: body?.config?.selection?.psuId,
    fanGroups: body?.config?.selection?.fanGroups,
  });
});
page.on("response", (response) => {
  const request = response.request();
  if (response.status() >= 400 && !expectedOfflineHttpFailure(response)) {
    const body = request.postDataJSON();
    const config = body?.buildConfig;
    httpFailures.push({
      method: request.method(), status: response.status(), url: response.url(),
      ...(config ? {
        config: {
          schemaVersion: config.schemaVersion,
          caseId: config.caseId,
          boardId: config.boardId,
          cpuId: config.cpuId,
          diskCount: config.selection?.diskCount,
          psuId: config.selection?.psuId,
          fanGroups: config.selection?.fanGroups,
        },
      } : {}),
    });
  }
  if (!request.url().includes("/api/workspace/plans/") || request.method() !== "PATCH") return;
  recordWorkspaceTraffic({ phase: "response", status: response.status() });
});

const routeTransactions = async (target) => target.route("**/api/price/transactions/**", async (route) => {
  const request = route.request(); const url = new URL(request.url());
  if (url.pathname.endsWith("/analyze")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    receiptId: "receipt-platform-r10", status: "matched-catalog",
    detected: { name: "Corsair SF750", brand: "Corsair", model: "SF750", category: "psu", qty: 1, unitPriceCny: 999 },
    catalogMatch: { skuId: "psu.corsair-sf750-atx31", kind: "exact-mpn", score: 1 },
    evidence: { receiptId: "receipt-platform-r10", fileName: "sf750.png", contentHash: "a".repeat(64), capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture-ocr", ocrConfidence: 98, excerpt: "Corsair SF750 CNY 999" }, catalogSearch: null,
  }) });
  if (url.pathname.endsWith("/archive") && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: archives }) });
  if (url.pathname.endsWith("/archive") && request.method() === "POST") {
    const body = request.postDataJSON(); const record = { schemaVersion: 2, receiptId: body.receiptId, storedAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z", item: body.item, link: body.link, image: null };
    archives.splice(0, archives.length, record); return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(record) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
await routeTransactions(page);

const revealCreateModes = async () => {
  const advanced = page.locator("[data-create-dialog] details");
  if (!await advanced.evaluate((details) => details.open)) await advanced.locator("summary").click();
};

const started = Date.now();
await page.goto(`${webOrigin}/index.html#/workspace`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluationSnapshot));
const firstLoadMs = Date.now() - started;
const browserHashGoldens = await page.evaluate(async () => {
  const { hashContent } = await import("/src/hash/browser.ts");
  const response = await fetch("/tests/fixtures/baseline/u0-content-hash-golden-vectors.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`cannot load U0 hash golden fixture: ${response.status}`);
  const fixture = await response.json();
  return Promise.all(fixture.vectors.map(async (vector) => ({
    id: vector.id,
    actual: await hashContent(vector.value, vector.contract),
    expected: vector.expectedSha256,
  })));
});
const browserHashMismatches = browserHashGoldens.filter(({ actual, expected }) => actual !== expected);
if (browserHashGoldens.length !== 7 || browserHashMismatches.length) {
  throw new Error(`browser HashSpec golden mismatch: ${JSON.stringify({ count: browserHashGoldens.length, browserHashMismatches })}`);
}

await page.click('[data-workspace-page="workspace"] > header [data-open-create]');
await page.fill("[data-create-name]", "R10 空白方案");
await page.click("[data-create-submit]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.name === "R10 空白方案");
const blankConfig = await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.config);
if (blankConfig?.caseId || blankConfig?.boardId || blankConfig?.cpuId || blankConfig?.selection.psuId || blankConfig?.selection.coolerId || blankConfig?.selection.gpuId || blankConfig?.selection.memoryId) {
  throw new Error(`new blank plan prefilled hardware: ${JSON.stringify(blankConfig)}`);
}
await page.click('[data-route="spatial"]');
await page.locator('[data-three-spatial-root].is-partial').waitFor({ state: "visible" });
if (await page.locator("[data-edit-finding]").isVisible()) throw new Error("blank plan exposed a spatial repair action before a scene exists");
await page.click('[data-route="workspace"]');

await page.click('[data-workspace-page="workspace"] > header [data-open-create]');
await revealCreateModes();
await page.selectOption("[data-create-mode]", "template");
await page.fill("[data-create-name]", "R10 完整验收方案");
await page.click("[data-create-submit]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.name === "R10 完整验收方案");
const firstPlan = await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id);
// Clear the front mount before changing to the SFX PSU. The authoritative
// repository refuses the conflicting intermediate instead of persisting a
// draft that the evaluator already knows cannot coexist.
await page.selectOption('[data-fan-mount="front"] [data-fan-count]', "0");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return !state?.activePlan?.draft.config.selection.fanGroups?.some((group) => group.mountId === "front");
});
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && !state.activePlan?.draft.config.selection.fanGroups?.some((group) => group.mountId === "front")
    && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision
    && !state.evaluationSnapshot.evaluation.config.selection.fanGroups?.some((group) => group.mountId === "front");
});

const evaluationStarted = Date.now();
await page.fill('[data-config-field="selection.diskCount"]', "2");
await page.locator('[data-config-field="selection.diskCount"]').dispatchEvent("change");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.config.selection.diskCount === 2);
try {
  await page.waitForFunction(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return state?.saveStatus === "saved"
      && state.activePlan?.draft.config.selection.diskCount === 2
      && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision
      && state.evaluationSnapshot.evaluation.config.selection.diskCount === 2;
  });
} catch (error) {
  const diagnostic = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return {
      saveStatus: state?.saveStatus,
      error: state?.error,
      activeRevision: state?.activePlan?.draftRevision,
      activeDirty: state?.activePlan?.draft.dirty,
      activeDiskCount: state?.activePlan?.draft.config.selection.diskCount,
      snapshotRevision: state?.evaluationSnapshot?.draftRevision,
      snapshotDiskCount: state?.evaluationSnapshot?.evaluation.config.selection.diskCount,
      evaluationDiskCount: state?.evaluation?.config.selection.diskCount,
      evaluationAuthority: document.querySelector("#n6-lab")?.getAttribute("data-evaluation-authority"),
    };
  });
  throw new Error(`disk evaluation did not converge: ${JSON.stringify({ diagnostic, workspaceTraffic })}`, { cause: error });
}
await page.selectOption('[data-config-field="selection.psuId"]', "psu.corsair-sf750-atx31");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.config.selection.psuId === "psu.corsair-sf750-atx31");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && state.activePlan?.draft.config.selection.psuId === "psu.corsair-sf750-atx31"
    && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision
    && state.evaluationSnapshot.evaluation.config.selection.diskCount === 2
    && state.evaluationSnapshot.evaluation.config.selection.psuId === "psu.corsair-sf750-atx31";
});
const reevaluationMs = Date.now() - evaluationStarted;
await page.click("[data-open-save]");
await page.fill("[data-version-summary]", "R10 v1 · 双盘与 SF750");
await page.click("[data-version-submit]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.dirty === false);

await page.click('[data-route="workspace"]');
await page.click('[data-workspace-page="workspace"] > header [data-open-create]');
await revealCreateModes();
await page.selectOption("[data-create-mode]", "duplicate");
await page.fill("[data-create-name]", "R10 独立副本");
await page.click("[data-create-submit]");
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id !== id, firstPlan);
const secondPlan = await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id);
await page.selectOption("[data-plan-switcher]", firstPlan);
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, firstPlan);
if (await page.locator('[data-config-field="selection.diskCount"]').inputValue() !== "2") throw new Error("source plan was polluted by duplicate");
const switchStarted = Date.now();
await page.selectOption("[data-plan-switcher]", secondPlan);
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, secondPlan);
await page.waitForFunction((id) => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.activePlan?.id === id
    && state.evaluationSnapshot?.planId === id
    && state.evaluationSnapshot.draftRevision === state.activePlan.draftRevision;
}, secondPlan);
const planSwitchMs = Date.now() - switchStarted;

await page.click('[data-route="workspace"]');
const finding = page.locator("[data-current-plan] [data-finding-id]").first();
if (await finding.count()) {
  await finding.click();
  await page.waitForFunction(() => location.hash === "#/spatial");
  await page.click("[data-edit-finding]");
  await page.waitForFunction(() => location.hash === "#/editor");
}
const spatialStarted = Date.now();
await page.click('[data-route="spatial"]');
await page.waitForFunction(() => document.querySelector("#spatial-stage")?.classList.contains("spatial-three-active") || !document.querySelector("[data-three-fallback]")?.classList.contains("is-hidden"));
const spatialInitMs = Date.now() - spatialStarted;

await page.click('[data-route="agent"]');
await page.waitForSelector("[data-agent-plan-proposals]", { state: "attached" });
const proposal = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  return { planId: state.activePlan.id, revision: state.activePlan.draftRevision, configHash: state.evaluationSnapshot.configHash, diskCount: state.activePlan.draft.config.selection.diskCount };
});
await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
  schemaVersion: "1.0.0", id: "proposal-platform-r10", planId: value.planId, expectedDraftRevision: value.revision, expectedConfigHash: value.configHash, createdAt: "2026-08-25T02:00:00.000Z",
  configSchemaVersion: "2.0.0",
  summary: "R10 人工批准增加一块数据盘", rationale: ["完整路径 fixture"], operations: [{ op: "replace", path: "/selection/diskCount", value: value.diskCount + 1 }],
  predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null }, status: "proposed",
} } })), proposal);
const proposalCard = page.locator('[data-plan-proposal="proposal-platform-r10"]');
try { await proposalCard.waitFor(); }
catch (error) {
  const proposalHostText = await page.locator("[data-agent-plan-proposals]").innerText();
  throw new Error(`plan proposal did not render: ${proposalHostText}`, { cause: error });
}
if (!await proposalCard.locator("[data-apply-proposal]").isDisabled()) throw new Error("proposal bypassed approval gate");
await proposalCard.locator("[data-proposal-approval]").check();
await proposalCard.locator("[data-apply-proposal]").click();
await page.waitForFunction((diskCount) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.config.selection.diskCount === diskCount + 1, proposal.diskCount);
await page.click("[data-save-version]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.dirty === false);
const saved = await page.evaluate(() => ({ id: window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id, versionId: window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.activeVersionId }));

await page.click('[data-route="purchases"]');
await page.setInputFiles("#transaction-screenshot-input", { name: "sf750.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.click("#transaction-start-recognition");
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
if (await page.locator(".transaction-review-link").inputValue() !== "psu.corsair-sf750-atx31") throw new Error("transaction was not linked to the v2 PSU");
await page.click(".transaction-review-actions button:last-child");
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (await page.locator("#build-base-close").isVisible()) await page.click("#build-base-close");
await page.click('[data-route="build"]');
const purchaseTask = page.locator('[data-task-kind="purchase"]').filter({ hasText: "psu.corsair-sf750-atx31" });
await purchaseTask.waitFor();
if (await purchaseTask.getAttribute("data-task-status-value") !== "done") throw new Error("archived transaction did not update build task");

const a11y = await page.evaluate(() => ({
  unnamedButtons: [...document.querySelectorAll("button")].filter((button) => button.getClientRects().length && !(button.textContent?.trim() || button.getAttribute("aria-label"))).length,
  brokenDialogs: [...document.querySelectorAll("dialog")].filter((dialog) => { const id = dialog.getAttribute("aria-labelledby"); return !id || !document.getElementById(id); }).length,
  liveRegions: document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]').length,
}));
if (a11y.unnamedButtons || a11y.brokenDialogs || a11y.liveRegions < 5) throw new Error(`accessibility audit failed: ${JSON.stringify(a11y)}`);

const screenshots = [];
for (const [name, width, height, route] of [["desktop", 1440, 1000, "workspace"], ["tablet", 1024, 768, "build"], ["mobile", 390, 844, "editor"]]) {
  await page.setViewportSize({ width, height }); await page.click(`[data-route="${route}"]`); await page.waitForTimeout(80);
  const layout = await page.evaluate(() => {
    const active = document.querySelector('.workspace-global-shell [aria-current="page"]')?.getBoundingClientRect();
    const nav = document.querySelector(".workspace-global-shell nav")?.getBoundingClientRect();
    return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, activeLeft: active?.left, activeRight: active?.right, navLeft: nav?.left, navRight: nav?.right };
  });
  if (layout.scrollWidth > layout.clientWidth + 1) throw new Error(`${name} layout overflows horizontally: ${JSON.stringify(layout)}`);
  if (layout.activeLeft !== undefined && layout.navLeft !== undefined && (layout.activeLeft < layout.navLeft - 4 || layout.activeRight > layout.navRight + 4)) throw new Error(`${name} active route is outside the visible navigation: ${JSON.stringify(layout)}`);
  const file = path.join(visualRoot, `${name}.png`); await page.screenshot({ path: file, fullPage: true });
  const buffer = await readFile(file); screenshots.push({ name, width, height, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), layout });
}

// Mobile completion path: create, edit, save a version, review and archive a transaction.
await page.click('[data-route="workspace"]');
await page.click('[data-workspace-page="workspace"] > header [data-open-create]');
await revealCreateModes();
await page.selectOption("[data-create-mode]", "template");
await page.fill("[data-create-name]", "R10 手机方案");
await page.click("[data-create-submit]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.name === "R10 手机方案");
await page.selectOption('[data-fan-mount="front"] [data-fan-count]', "0");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && !state.activePlan?.draft.config.selection.fanGroups?.some((group) => group.mountId === "front")
    && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision;
});
await page.fill('[data-config-field="selection.diskCount"]', "3");
await page.locator('[data-config-field="selection.diskCount"]').dispatchEvent("change");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && state.activePlan?.draft.config.selection.diskCount === 3
    && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision
    && state.evaluationSnapshot.evaluation.config.selection.diskCount === 3;
});
await page.selectOption('[data-config-field="selection.psuId"]', "psu.corsair-sf750-atx31");
await page.waitForFunction(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.saveStatus === "saved"
    && state.activePlan?.draft.config.selection.psuId === "psu.corsair-sf750-atx31"
    && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision
    && state.evaluationSnapshot.evaluation.config.selection.diskCount === 3
    && state.evaluationSnapshot.evaluation.config.selection.psuId === "psu.corsair-sf750-atx31";
});
await page.click("[data-open-save]");
await page.fill("[data-version-summary]", "R10 mobile version");
await page.click("[data-version-submit]");
await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.dirty === false);
await page.click('[data-route="purchases"]');
await page.setInputFiles("#transaction-screenshot-input", { name: "sf750-mobile.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await page.click("#transaction-start-recognition");
await page.waitForFunction(() => document.querySelector("#transaction-screenshot-status")?.getAttribute("data-phase") === "reviewing");
if (!await page.locator(".transaction-review-fields").isVisible()) throw new Error("mobile transaction review is not operable");
await page.click(".transaction-review-actions button:last-child");
await page.click("#build-base-save");
await page.waitForFunction(() => document.querySelector("#build-base-save-status")?.getAttribute("data-phase") === "archived");
if (await page.locator("#build-base-close").isVisible()) await page.click("#build-base-close");
await page.selectOption("[data-plan-switcher]", saved.id);
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, saved.id);

const cdp = await page.context().newCDPSession(page);
await cdp.send("HeapProfiler.collectGarbage");
const heapBeforeReload = await cdp.send("Runtime.getHeapUsage");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction((id) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.id === id, saved.id);
await cdp.send("HeapProfiler.collectGarbage");
const heapAfterReload = await cdp.send("Runtime.getHeapUsage");
const restored = await page.evaluate(() => ({ versionId: window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.activeVersionId, task: localStorage.getItem(`build-sim.tasks.v1:${window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id}`), progress: localStorage.getItem(`build-sim.progress.v2:${window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id}`) }));
if (restored.versionId !== saved.versionId || !restored.task || !restored.progress) throw new Error("refresh did not restore version/task/progress state");
const apiPayloadBytes = await page.evaluate(async (planId) => {
  const paths = ["/api/workspace/plans", `/api/workspace/plans/${encodeURIComponent(planId)}`];
  const entries = await Promise.all(paths.map(async (pathname) => {
    const response = await fetch(pathname);
    if (!response.ok) throw new Error(`API baseline request failed: ${pathname} -> ${response.status}`);
    return [pathname, (await response.arrayBuffer()).byteLength];
  }));
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  entries.push(["in-memory:evaluationSnapshot", new TextEncoder().encode(JSON.stringify(state.evaluationSnapshot)).byteLength]);
  return Object.fromEntries(entries);
}, saved.id);
if (errors.length || httpFailures.length) throw new Error(`page errors: ${JSON.stringify({ errors, httpFailures })}`);

console.log("Platform acceptance browser passed", {
  plans: [firstPlan, secondPlan],
  savedVersion: saved.versionId,
  archives: archives.length,
  browserHashGoldens,
  performance: { firstLoadMs, reevaluationMs, planSwitchMs, spatialInitMs },
  memoryRelease: {
    heapBeforeReloadBytes: heapBeforeReload.usedSize,
    heapAfterReloadBytes: heapAfterReload.usedSize,
    deltaBytes: heapAfterReload.usedSize - heapBeforeReload.usedSize,
  },
  apiPayloadBytes,
  accessibility: a11y,
  screenshots,
});
await browser.close();
await rm(visualRoot, { recursive: true, force: true });
