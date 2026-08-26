import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-agent-init-browser-"));
const seed = 5300 + Math.floor(Math.random() * 300);
const ports = { web: seed, agent: seed + 1, workspace: seed + 2, fixture: seed + 3, price: seed + 4 };
const children = [];
const logs = [];

function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`[${label}:err] ${chunk}`));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${logs.join("")}`);
}

let browser;
try {
  start("fixture", ["scripts/agent-provider-fixture.mjs"], { AGENT_FIXTURE_PORT: String(ports.fixture) });
  start("workspace", ["dist-workspace/workspace-server.js"], {
    WORKSPACE_SERVER_PORT: String(ports.workspace),
    PLAN_REPOSITORY_ROOT: path.join(runtimeRoot, "plans"),
  });
  start("agent", ["dist-agent/agent-server.js"], {
    BUILD_SIM_AGENT_ENABLED: "true",
    DEEPSEEK_ENABLED: "true",
    DEEPSEEK_API_KEY: "fixture",
    DEEPSEEK_API_URL: `http://127.0.0.1:${ports.fixture}`,
    DEEPSEEK_AGENT_MODELS: "deepseek-v4-flash",
    AGENT_SERVER_PORT: String(ports.agent),
    PRICE_SERVER_PORT: String(ports.price),
    AGENT_SESSION_ROOT: path.join(runtimeRoot, "sessions"),
    AGENT_AUDIT_ROOT: path.join(runtimeRoot, "audit"),
  });
  start("web", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
    WEB_SERVER_PORT: String(ports.web),
    AGENT_SERVER_PORT: String(ports.agent),
    WORKSPACE_SERVER_PORT: String(ports.workspace),
    PRICE_SERVER_PORT: String(ports.price),
  });

  await Promise.all([
    waitFor(`http://127.0.0.1:${ports.workspace}/api/workspace/plans`),
    waitFor(`http://127.0.0.1:${ports.agent}/api/agent/models`),
    waitFor(`http://127.0.0.1:${ports.web}/index.html`),
  ]);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("409") && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${ports.web}/index.html#/workspace`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluationSnapshot));

  await page.locator("[data-new-plan]").click();
  await page.locator("[data-new-plan-dialog]").waitFor({ state: "visible" });
  await page.locator("[data-new-agent-plan]").click();
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.metadata.initialization?.status === "pending");
  await page.waitForFunction(() => window.location.hash === "#/agent" && document.querySelector("#agent-skill")?.value === "plan-initializer");
  if (!(await page.locator("[data-agent-plan-context]").textContent()).includes("当前配置仅为内部脚手架")) throw new Error("pending scaffold boundary is not visible");
  if (!(await page.locator("[data-save-version]").isDisabled())) throw new Error("pending scaffold can be versioned before initialization");

  const baseline = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__.getState();
    return { planId: state.activePlan.id, revision: state.activePlan.draftRevision, configHash: state.evaluationSnapshot.configHash };
  });
  const proposalId = `proposal-agent-init-${Date.now()}`;
  await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
    host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
      schemaVersion: "1.0.0",
      id: value.proposalId,
      planId: value.planId,
      expectedDraftRevision: value.revision,
      expectedConfigHash: value.configHash,
      createdAt: new Date().toISOString(),
      summary: "初始化当前目录内的 2K 游戏方案",
      rationale: ["浏览器闭环验收"],
      operations: [
        { op: "replace", path: "/name", value: "Agent 初始化游戏方案" },
        { op: "replace", path: "/selection/gpuId", value: "gpu.rtx-a2000-12gb" },
        { op: "replace", path: "/notes", value: ["当前目录覆盖有限，游戏性能仍需外部基准核验"] },
      ],
      predictedImpact: { resolvedFindingIds: ["untrusted"], introducedFindingIds: ["untrusted"], budgetDeltaCny: 999999 },
      status: "proposed",
      kind: "initialization",
      intent: { useCase: "游戏", budgetCny: 8000, targetResolution: "1440p", targetFps: 60, region: "中国大陆" },
    } } }));
  }, { ...baseline, proposalId });

  const card = page.locator(`[data-plan-proposal="${proposalId}"]`);
  await card.waitFor();
  if (!(await card.textContent()).includes("完整初始化")) throw new Error("initialization proposal is not labelled atomically");
  if (await card.locator("[data-proposal-operation]:not(:disabled)").count()) throw new Error("initialization fields can be partially selected");
  if (!(await card.locator("[data-apply-proposal]").isDisabled())) throw new Error("initialization can be applied without approval");
  await card.locator("[data-proposal-approval]").check();
  await card.locator("[data-apply-proposal]").click();
  await page.waitForFunction(() => {
    const plan = window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan;
    return plan?.metadata.initialization?.status === "initialized" && plan.name === "Agent 初始化游戏方案";
  });
  if (await page.locator("[data-save-version]").isDisabled()) throw new Error("initialized draft cannot be saved as a version");
  if (!(await card.locator("[data-proposal-state]").textContent()).includes("初始化完成")) throw new Error("approved initialization state is not visible");
  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("Agent initialization browser smoke passed", { planId: baseline.planId, proposalId });
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  })));
  await fs.rm(runtimeRoot, { recursive: true, force: true });
}
