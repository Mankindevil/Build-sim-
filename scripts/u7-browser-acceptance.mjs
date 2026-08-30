import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-u7-browser-"));
const seed = 6200 + Math.floor(Math.random() * 300);
const ports = { web: seed, workspace: seed + 1, price: seed + 2, agent: seed + 3 };
const children = [];
const logs = [];

function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(`[${label}] ${String(chunk)}`));
  child.stderr.on("data", (chunk) => logs.push(`[${label}:err] ${String(chunk)}`));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Local service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${logs.join("")}`);
}

async function createBlank(page, name, useCase) {
  try {
    await page.locator('[data-workspace-page="workspace"] [data-open-create]').click({ timeout: 45_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText.slice(0, 4_000),
      bodyHtml: document.body.innerHTML.slice(0, 4_000),
      bodyChildren: document.body.children.length,
      workspacePages: document.querySelectorAll("[data-workspace-page]").length,
      labRoot: (() => {
        const root = document.getElementById("n6-lab");
        return root === null ? null : { hidden: root.hidden, className: root.className, ariaHidden: root.getAttribute("aria-hidden") };
      })(),
      hasLegacyData: Boolean(window.__N6_LAB__),
      hasLegacyApi: Boolean(window.__N6_LAB_API__),
      hasSpatial: Boolean(window.__BUILD_SIM_SPATIAL__),
      store: window.__BUILD_SIM_PLAN_STORE__?.getState(),
    }));
    throw new Error(`U7 workspace creation surface unavailable: ${JSON.stringify({ diagnostic, logs })}`, { cause: error });
  }
  await page.locator("[data-create-name]").fill(name);
  await page.locator("[data-create-use-case]").selectOption({ label: useCase });
  await page.locator("[data-create-submit]").click();
  try {
    await page.waitForFunction((expectedName) => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.name === expectedName, name);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      createError: document.querySelector("[data-create-error]")?.textContent,
      createMode: document.querySelector("[data-create-mode]")?.value,
      state: window.__BUILD_SIM_PLAN_STORE__?.getState(),
    }));
    throw new Error(`U7 blank plan was not created: ${JSON.stringify({ diagnostic, logs })}`, { cause: error });
  }
  try {
    await page.waitForFunction(() => {
      const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
      return state?.saveStatus === "saved"
        && state.activePlan?.draft.config.schemaVersion === "3.0.0"
        && state.evaluationSnapshot?.planId === state.activePlan.id
        && state.evaluationSnapshot.draftRevision === state.activePlan.draftRevision
        && state.evaluationSnapshot.evaluation.schemaVersion === "progressive-build-evaluation-v1";
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
      return {
        saveStatus: state?.saveStatus,
        error: state?.error,
        planId: state?.activePlan?.id,
        draftRevision: state?.activePlan?.draftRevision,
        configSchemaVersion: state?.activePlan?.draft.config.schemaVersion,
        system: state?.activePlan?.draft.config.system,
        snapshotPlanId: state?.evaluationSnapshot?.planId,
        snapshotRevision: state?.evaluationSnapshot?.draftRevision,
        snapshotSchemaVersion: state?.evaluationSnapshot?.evaluation.schemaVersion,
      };
    });
    throw new Error(`U7 blank evaluation did not converge: ${JSON.stringify({ diagnostic, logs })}`, { cause: error });
  }
  return page.evaluate(() => structuredClone(window.__BUILD_SIM_PLAN_STORE__.getState().activePlan));
}

let browser;
try {
  const workspaceEnvironment = {
    RUNTIME_ROOT: runtimeRoot,
    WORKSPACE_SERVER_PORT: String(ports.workspace),
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
    BUILD_SIM_FACT_GRAPH_ENABLED: "true",
    BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
    BUILD_SIM_SYSTEM_PROFILES_ENABLED: "true",
    BUILD_SIM_EVIDENCE_NETWORK_ENABLED: "false",
  };
  // Seed one V3 plan before the production entrypoint runs, so its legacy
  // rollback bootstrap never becomes the active browser plan during this gate.
  const { createWorkspaceRepositories } = await import("../dist-workspace/workspace-server.js");
  const { initializeRuntimeCatalog } = await import("./price-server/catalog/repository.mjs");
  const { hashPlanConfigRuntime } = await import("../src/plans/canonical-runtime.mjs");
  const seeded = createWorkspaceRepositories(workspaceEnvironment);
  await seeded.coordinator.initialize();
  await initializeRuntimeCatalog({ coordinator: seeded.coordinator, generationAware: true });
  const priceInputHash = createHash("sha256").update("u7-browser-empty-price").digest("hex");
  const priceMaterial = {
    schemaVersion: "1.1.0",
    asOf: "2026-08-29",
    snapshotId: `price-snapshot-${priceInputHash.slice(0, 20)}`,
    generatedAt: "2026-08-29T00:00:00.000Z",
    catalogVersion: "u7-browser",
    inputHash: priceInputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  await seeded.coordinator.withWrite(async ({ activeRoot }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...priceMaterial,
      contentHash: createHash("sha256").update(JSON.stringify(priceMaterial)).digest("hex"),
    })}\n`, "utf8");
  });
  const seedPlan = await seeded.repository.create({
    name: "U7 浏览器基线",
    config: {
      schemaVersion: "3.0.0",
      id: "u7-browser-seed",
      name: "U7 浏览器基线",
      updatedAt: new Date().toISOString(),
      intent: { state: "answered", value: "pc", source: "user", confirmedByUser: true },
      requirementSpec: null,
      system: {
        profileId: "system.windows-11",
        versionFactId: "system-release.windows-11.24h2",
        source: "defaulted",
        lockedByUser: false,
      },
      components: [],
      roleDecisions: [],
      placements: [],
      connections: [],
      logicalLayouts: [],
      firmwareTargets: [],
    },
  });
  await seeded.evaluationPipeline.evaluateCurrent({
    planId: seedPlan.id,
    target: {
      kind: "draft",
      expectedDraftRevision: seedPlan.draftRevision,
      expectedConfigHash: hashPlanConfigRuntime(seedPlan.draft.config),
    },
  });
  start("workspace", ["dist-workspace/workspace-server.js"], workspaceEnvironment);
  start("web", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
    WEB_SERVER_PORT: String(ports.web),
    WORKSPACE_SERVER_PORT: String(ports.workspace),
    PRICE_SERVER_PORT: String(ports.price),
    AGENT_SERVER_PORT: String(ports.agent),
  });
  await Promise.all([
    waitFor(`http://127.0.0.1:${ports.workspace}/api/workspace/capabilities`),
    waitFor(`http://127.0.0.1:${ports.web}/index.html`),
  ]);
  const routeStartedAt = Date.now();
  const routeResponse = await fetch(
    `http://127.0.0.1:${ports.workspace}/api/workspace/plans/${encodeURIComponent(seedPlan.id)}/evaluations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: {
          kind: "draft",
          expectedDraftRevision: seedPlan.draftRevision,
          expectedConfigHash: hashPlanConfigRuntime(seedPlan.draft.config),
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!routeResponse.ok) {
    throw new Error(`U7 production evaluation route failed: ${routeResponse.status} ${await routeResponse.text()}`);
  }
  logs.push(`[acceptance] initial production evaluation ${Date.now() - routeStartedAt}ms\n`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const browserCatalog = JSON.parse(await readFile(path.join(root, "data/skus/catalog.json"), "utf8"));
  await page.route("**/api/price/catalog", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(browserCatalog),
  }));
  await page.route("**/api/price/state", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "offline_fixture" }),
  }));
  const pageErrors = [];
  page.on("pageerror", (error) => {
    const message = error.stack ?? String(error);
    pageErrors.push(message);
    logs.push(`[browser:error] ${message}\n`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") logs.push(`[browser:console] ${message.text()}\n`);
  });
  page.on("requestfailed", (request) => logs.push(`[browser:requestfailed] ${request.url()} ${request.failure()?.errorText ?? "unknown"}\n`));
  page.on("request", (request) => {
    if (request.url().includes("/evaluations")) logs.push(`[browser:request] ${request.method()} ${request.url()}\n`);
  });
  page.on("response", (response) => {
    if (response.url().includes("v1-runtime") || response.url().includes("/evaluations") || response.status() >= 400) {
      logs.push(`[browser:response] ${response.status()} ${response.url()}\n`);
    }
  });
  await page.goto(`http://127.0.0.1:${ports.web}/index.html#/workspace`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().initialized === true);

  const pc = await createBlank(page, "U7 空白 PC", "安静办公");
  if (pc.draft.config.components.length !== 0
    || pc.draft.config.system?.profileId !== "system.windows-11"
    || pc.draft.config.system?.source !== "defaulted") {
    throw new Error(`PC default is not an empty explainable Windows plan: ${JSON.stringify(pc.draft.config)}`);
  }
  const systemPanel = page.locator("[data-system-panel]");
  await systemPanel.waitFor();
  if (!(await systemPanel.textContent()).includes("机械兼容") || !(await systemPanel.textContent()).includes("系统可用")) {
    throw new Error("mechanical and system availability are not shown separately");
  }

  const helpButton = systemPanel.locator('[data-help-ref="help.system.windows-11"]');
  const helpLabel = await helpButton.getAttribute("aria-label");
  if (!helpLabel?.includes("Windows 11")) throw new Error("system help button lacks its accessible label");
  await helpButton.focus();
  await helpButton.press("Enter");
  const helpDialog = page.locator("[data-buildsim-help-dialog]");
  await helpDialog.waitFor({ state: "visible" });
  await helpDialog.locator('button[aria-label="关闭说明"]').press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-help-ref") === "help.system.windows-11");

  await page.locator("[data-v3-system-profile]").selectOption("system.linux-desktop");
  await page.waitForFunction(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return state?.saveStatus === "saved"
      && state.activePlan?.draft.config.system?.profileId === "system.linux-desktop"
      && state.activePlan.draft.config.system.source === "user"
      && state.activePlan.draft.config.system.lockedByUser === true
      && state.evaluationSnapshot?.draftRevision === state.activePlan.draftRevision;
  });
  await page.locator("[data-open-save]").click();
  await page.locator("[data-version-summary]").fill("锁定 Linux 系统选择");
  await page.locator("[data-version-submit]").click();
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.draft.dirty === false);
  const pcPlanId = await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.id);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((planId) => {
    const plan = window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan;
    return plan?.id === planId
      && plan.draft.config.system?.profileId === "system.linux-desktop"
      && plan.draft.config.system.lockedByUser === true;
  }, pcPlanId);

  try {
    await page.getByRole("link", { name: /从这里开始/ }).click();
    await page.waitForFunction(() => location.hash === "#/workspace");
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText.slice(0, 4_000),
      shell: Boolean(document.querySelector(".workspace-global-shell")),
      initialized: window.__BUILD_SIM_PLAN_STORE__?.getState().initialized,
    })).catch(() => null);
    throw new Error(`U7 workspace navigation unavailable after reload: ${JSON.stringify({ diagnostic, logs })}`, { cause: error });
  }
  const nas = await createBlank(page, "U7 空白 NAS", "家庭存储 / NAS");
  if (nas.draft.config.components.length !== 0
    || nas.draft.config.system?.profileId !== "system.truenas-scale"
    || nas.draft.config.system?.source !== "defaulted") {
    throw new Error(`NAS default is not an empty explainable TrueNAS plan: ${JSON.stringify(nas.draft.config)}`);
  }
  const nasEditor = page.locator("[data-nas-layout-editor]");
  await nasEditor.waitFor();
  const nasCopy = await nasEditor.textContent();
  if (!nasCopy.includes("RAID/RAIDZ 不是备份") || !nasCopy.includes("不会自动添加购买项")) {
    throw new Error("empty NAS editor does not preserve the logical-layout and no-auto-purchase boundary");
  }
  if (pageErrors.length) throw new Error(`browser page errors: ${JSON.stringify(pageErrors)}`);

  console.log("U7 browser acceptance passed", {
    pcPlanId,
    nasPlanId: nas.id,
    pcProfileAfterReload: "system.linux-desktop",
    nasProfile: nas.draft.config.system.profileId,
    hardwareCounts: { pc: pc.draft.config.components.length, nas: nas.draft.config.components.length },
    helpFocusReturned: true,
  });
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000).unref();
  })));
  await rm(runtimeRoot, { recursive: true, force: true });
}
