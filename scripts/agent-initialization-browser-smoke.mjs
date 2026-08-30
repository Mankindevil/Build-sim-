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
    RUNTIME_ROOT: runtimeRoot,
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
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
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
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
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404") && !message.text().includes("409") && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${ports.web}/index.html#/workspace`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluationSnapshot));

  await page.locator("[data-new-plan]").click();
  await page.locator("[data-create-dialog]").waitFor({ state: "visible" });
  await page.locator("[data-create-name]").fill("Agent 渐进方案");
  await page.locator("[data-create-submit]").click();
  await page.waitForFunction(() => window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan?.name === "Agent 渐进方案");
  await page.locator('[data-route="agent"]').click();
  await page.waitForFunction(() => window.location.hash === "#/agent");
  await page.locator(".agent-controls-details summary").click();
  await page.locator("#agent-skill").selectOption("plan-initializer");
  await page.waitForFunction(() => document.querySelector("#agent-skill")?.value === "plan-initializer");
  try {
    await page.waitForFunction(() => document.querySelector("[data-agent-plan-context]")?.textContent?.includes("已同步当前装机方案"));
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
      return {
        badge: document.querySelector("[data-agent-plan-context]")?.textContent,
        planId: state?.activePlan?.id,
        schemaVersion: state?.activePlan?.draft.config.schemaVersion,
        revision: state?.activePlan?.draftRevision,
        snapshotRevision: state?.evaluationSnapshot?.draftRevision,
        saveStatus: state?.saveStatus,
        error: state?.error,
        authority: document.getElementById("n6-lab")?.getAttribute("data-evaluation-authority"),
      };
    });
    throw new Error(`progressive blank plan context did not synchronize: ${JSON.stringify(diagnostic)}\n${logs.join("")}`, { cause: error });
  }
  if (!(await page.locator("[data-agent-plan-context]").textContent()).includes("已同步当前装机方案")) throw new Error("progressive blank plan context is not visible");
  if (await page.locator("[data-save-version]").isDisabled()) throw new Error("progressive blank plan cannot be versioned");
  const blank = await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan);
  if (blank.metadata.initialization?.status === "pending") throw new Error("Agent blank still uses a special pending initialization state");
  const blankConfig = blank.draft.config;
  const blankHasHardware = blankConfig.schemaVersion === "3.0.0"
    ? blankConfig.components.length > 0
      || blankConfig.roleDecisions.length > 0
      || blankConfig.placements.length > 0
      || blankConfig.connections.length > 0
      || blankConfig.logicalLayouts.length > 0
      || blankConfig.firmwareTargets.length > 0
    : Boolean(blankConfig.caseId || blankConfig.boardId || blankConfig.cpuId || blankConfig.selection.gpuId || blankConfig.bom.length);
  if (blankHasHardware) {
    throw new Error("Agent blank contains implicit hardware");
  }

  const firstBaseline = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__.getState();
    return { planId: state.activePlan.id, revision: state.activePlan.draftRevision, configHash: state.evaluationSnapshot.configHash };
  });
  const firstProposalId = `proposal-agent-progressive-1-${Date.now()}`;
  await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
    host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
      schemaVersion: "1.0.0",
      id: value.proposalId,
      planId: value.planId,
      expectedDraftRevision: value.revision,
      expectedConfigHash: value.configHash,
      createdAt: new Date().toISOString(),
      summary: "第一轮只保留用户描述的需求",
      rationale: ["浏览器渐进式 V3 闭环验收"],
      configSchemaVersion: "3.0.0",
      operations: [
        {
          op: "replace",
          selector: { collection: "config", field: "requirementSpec" },
          value: {
            requirementSpecId: "requirements-browser-progressive",
            schemaVersion: "1.0.0",
            workloads: [{
              workloadId: "workload-photo-library",
              state: "answered",
              name: "照片归档",
              metrics: [],
              source: "agent_proposed",
              confirmedByUser: false,
            }],
            constraints: [],
          },
        },
        {
          op: "add",
          selector: { collection: "components", id: "unmentioned-gpu" },
          value: {
            instanceId: "unmentioned-gpu",
            kind: "gpu",
            role: "display_adapter",
            state: "planned",
            identity: { status: "unresolved", userText: "未被用户提到的显卡" },
            source: "agent",
          },
        },
      ],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
      status: "proposed",
    } } }));
  }, { ...firstBaseline, proposalId: firstProposalId });

  const firstCard = page.locator(`[data-plan-proposal="${firstProposalId}"]`);
  try {
    await firstCard.waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(`first progressive proposal was not rendered: ${await page.locator("[data-agent-plan-proposals]").textContent()}${errors.length ? `\n${errors.join("\n")}` : ""}\n${logs.join("")}`);
  }
  if (!(await firstCard.textContent()).includes("方案修改")) throw new Error("progressive proposal is not labelled as an ordinary change");
  if (await firstCard.locator("[data-proposal-operation]:not(:disabled)").count() !== 2) throw new Error("progressive fields cannot be reviewed independently");
  await firstCard.locator('[data-proposal-operation="1"]').uncheck();
  if (!(await firstCard.locator("[data-apply-proposal]").isDisabled())) throw new Error("proposal can be applied without approval");
  await firstCard.locator("[data-proposal-approval]").check();
  await firstCard.locator("[data-apply-proposal]").click();
  await page.waitForFunction(() => {
    const plan = window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan;
    return plan?.draft.config.schemaVersion === "3.0.0"
      && plan.draft.config.requirementSpec?.workloads?.[0]?.workloadId === "workload-photo-library"
      && plan.draft.config.components.length === 0;
  });
  try {
    await page.waitForFunction((proposalId) => document.querySelector(`[data-plan-proposal="${proposalId}"] [data-proposal-state]`)?.textContent?.includes("修改已应用"), firstProposalId, { timeout: 10_000 });
  } catch {
    throw new Error(`first progressive proposal did not settle: ${await firstCard.locator("[data-proposal-state]").textContent()}${errors.length ? `\n${errors.join("\n")}` : ""}`);
  }

  const secondBaseline = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__.getState();
    return { planId: state.activePlan.id, revision: state.activePlan.draftRevision, configHash: state.evaluationSnapshot.configHash };
  });
  const secondProposalId = `proposal-agent-progressive-2-${Date.now()}`;
  await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
    host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
      schemaVersion: "1.0.0", id: value.proposalId, planId: value.planId,
      expectedDraftRevision: value.revision, expectedConfigHash: value.configHash,
      createdAt: new Date().toISOString(), summary: "第二轮只加入用户刚提到的一块 8TB 硬盘",
      rationale: ["型号尚未确认；不覆盖第一轮需求，也不补造其他部件"],
      configSchemaVersion: "3.0.0",
      operations: [{
        op: "add",
        selector: { collection: "components", id: "drive-user-mentioned-1" },
        value: {
          instanceId: "drive-user-mentioned-1",
          kind: "storage_drive",
          role: "data_disk",
          state: "planned",
          identity: { status: "unresolved", userText: "一块 8TB 硬盘，型号待确认" },
          source: "agent",
        },
      }],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
      status: "proposed",
    } } }));
  }, { ...secondBaseline, proposalId: secondProposalId });
  const secondCard = page.locator(`[data-plan-proposal="${secondProposalId}"]`);
  await secondCard.waitFor();
  await secondCard.locator("[data-proposal-approval]").check();
  await secondCard.locator("[data-apply-proposal]").click();
  await page.waitForFunction(() => {
    const plan = window.__BUILD_SIM_PLAN_STORE__?.getState().activePlan;
    return plan?.draft.config.schemaVersion === "3.0.0"
      && plan.draft.config.requirementSpec?.workloads?.[0]?.workloadId === "workload-photo-library"
      && plan.draft.config.components.length === 1
      && plan.draft.config.components[0]?.instanceId === "drive-user-mentioned-1"
      && plan.draft.config.components[0]?.identity?.status === "unresolved";
  });
  if (await page.locator("[data-save-version]").isDisabled()) throw new Error("progressively edited draft cannot be saved as a version");
  try {
    await page.waitForFunction((proposalId) => document.querySelector(`[data-plan-proposal="${proposalId}"] [data-proposal-state]`)?.textContent?.includes("修改已应用"), secondProposalId, { timeout: 10_000 });
  } catch {
    throw new Error(`second progressive proposal did not settle: ${await secondCard.locator("[data-proposal-state]").textContent()}${errors.length ? `\n${errors.join("\n")}` : ""}`);
  }
  const beforeReload = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__.getState();
    return {
      planId: state.activePlan.id,
      revision: state.activePlan.draftRevision,
      configHash: state.evaluationSnapshot.configHash,
      evaluationHash: state.evaluationSnapshot.evaluationHash,
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((expected) => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return state?.activePlan?.id === expected.planId
      && state.activePlan.draftRevision === expected.revision
      && state.activePlan.draft.config.schemaVersion === "3.0.0"
      && state.evaluationSnapshot?.configHash === expected.configHash
      && state.evaluationSnapshot?.evaluationHash === expected.evaluationHash
      && state.evaluationSnapshot?.evaluation?.kind === "topology-v3-partial";
  }, beforeReload);
  try {
    await page.waitForFunction(() => document.querySelector("[data-agent-plan-context]")?.textContent?.includes("已同步当前装机方案"), undefined, { timeout: 10_000 });
  } catch {
    const diagnostic = await page.evaluate(() => ({
      hash: window.location.hash,
      contextText: document.querySelector("[data-agent-plan-context]")?.textContent ?? null,
      state: (() => {
        const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
        return state ? {
          planId: state.activePlan?.id ?? null,
          revision: state.activePlan?.draftRevision ?? null,
          schemaVersion: state.activePlan?.draft.config.schemaVersion ?? null,
          snapshotRevision: state.evaluationSnapshot?.draftRevision ?? null,
          snapshotKind: state.evaluationSnapshot?.evaluation && "kind" in state.evaluationSnapshot.evaluation
            ? state.evaluationSnapshot.evaluation.kind : "legacy-v2",
          configHash: state.evaluationSnapshot?.configHash ?? null,
        } : null;
      })(),
    }));
    throw new Error(`Agent context did not recover after reload: ${JSON.stringify(diagnostic)}${errors.length ? `\n${errors.join("\n")}` : ""}\n${logs.join("")}`);
  }
  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("Agent progressive initialization browser smoke passed", { planId: firstBaseline.planId, proposalIds: [firstProposalId, secondProposalId] });
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  })));
  await fs.rm(runtimeRoot, { recursive: true, force: true });
}
