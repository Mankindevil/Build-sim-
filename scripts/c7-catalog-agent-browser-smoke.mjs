import { chromium } from "playwright";
import { loadEnv } from "./price-server/env.mjs";

const env = await loadEnv();
const webPort = Number(env.WEB_SERVER_PORT ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT must be an integer between 1 and 65535");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const pageErrors = [];
const responseFailures = [];
let auditedRunId = null;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("response", (response) => { if (response.status() >= 400) responseFailures.push({ status: response.status(), url: response.url() }); });

await page.addInitScript(() => {
  class FixtureEventSource {
    listeners = new Map();

    constructor(url) {
      const runId = decodeURIComponent(String(url).match(/\/runs\/([^/]+)\/events/)?.[1] ?? "run-c7");
      setTimeout(() => {
        const at = "2026-08-24T00:00:00.000Z";
        this.emit("tool_result", { type: "tool_result", runId, callId: "search", toolName: "search_official_catalog", result: { ok: true, content: { status: "partial", candidates: [{ trustStatus: "trusted" }, { trustStatus: "trusted" }], domainProposals: [{ trustStatus: "proposed" }], discovery: { providerIds: ["fixture-searxng"] } }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId, callId: "inspect", toolName: "inspect_catalog_candidate", result: { ok: true, content: { extraction: { status: "ok", fieldsFound: 5 }, source: { domain: "asus.com" }, expectedHash: "a".repeat(64) }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId, callId: "proposal", toolName: "list_official_domain_proposals", result: { ok: true, content: { proposals: [{ trustStatus: "proposed" }] }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId, callId: "enrich", toolName: "enrich_official_catalog", result: { ok: true, content: { status: "draft", changedFields: ["dims", "power"], rollbackManifest: "catalog-rollback-fixture.json" }, provenance: ["fixture"] }, at });
        this.emit("run_status", { type: "run_status", runId, status: "completed", at });
      }, 50);
    }

    addEventListener(type, listener) {
      const entries = this.listeners.get(type) ?? [];
      entries.push(listener);
      this.listeners.set(type, entries);
    }

    emit(type, payload) {
      for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }

    close() {}
  }

  Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEventSource });
});

await page.route("**/api/workspace/agent-context", async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  auditedRunId = body.runId;
  return route.fulfill({ response, body: JSON.stringify(body) });
});

await page.route("**/api/agent/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (pathname === "/api/agent/evaluate") return route.continue();
  if (pathname === "/api/agent/models") return json({ models: [{ provider: "deepseek", id: "fixture-model", label: "C7 Fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: false } }] });
  if (pathname === "/api/agent/skills") return json({ skills: [{ manifest: { id: "shopping-research", name: "Shopping Research", description: "C7 fixture", version: "1.1.0", allowedTools: ["search_official_catalog", "inspect_catalog_candidate", "list_official_domain_proposals", "enrich_official_catalog"], readOnly: false }, definitionHash: "b".repeat(64) }] });
  if (pathname === "/api/agent/sessions" && request.method() === "POST") return json({ id: "session-c7", provider: "deepseek", model: "fixture-model", messages: [], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }, 201);
  if (pathname === "/api/agent/sessions/session-c7/messages") {
    if (!auditedRunId) return json({ error: "missing_audited_run" }, 409);
    return json({ runId: auditedRunId, status: "queued" }, 202);
  }
  if (pathname === "/api/agent/sessions/session-c7") return json({ id: "session-c7", provider: "deepseek", model: "fixture-model", messages: [{ id: "assistant-c7", role: "assistant", content: "C7 fixture flow completed.", createdAt: "2026-08-24T00:00:00.000Z" }], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  if (auditedRunId && pathname === `/api/agent/runs/${auditedRunId}/audit`) return json({ schemaVersion: "1.0.0", runId: auditedRunId, sessionId: "session-c7", status: "completed", startedAt: "2026-08-24T00:00:00.000Z", finishedAt: "2026-08-24T00:00:01.000Z", provider: "deepseek", model: "fixture-model", skill: null, toolCalls: [], usage: [], previousRecordHash: null, recordHash: "c".repeat(64) });
  return json({ error: "fixture_route_not_found", pathname }, 404);
});

await page.goto(`http://127.0.0.1:${webPort}/index.html#/agent`, { waitUntil: "domcontentloaded" });
await page.locator('[data-panel="agent"]').waitFor({ state: "visible" });
try {
  await page.waitForFunction(() => document.querySelector("[data-agent-plan-context]")?.textContent?.includes("已同步当前装机方案"));
} catch (error) {
  const diagnostic = await page.evaluate(() => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return {
      badge: document.querySelector("[data-agent-plan-context]")?.textContent ?? null,
      plan: state?.activePlan ? { id: state.activePlan.id, draftRevision: state.activePlan.draftRevision, dirty: state.activePlan.draft.dirty } : null,
      evaluation: state?.evaluationSnapshot ? { planId: state.evaluationSnapshot.planId, draftRevision: state.evaluationSnapshot.draftRevision, hasLock: Boolean(state.evaluationSnapshot.evaluationLock) } : null,
      mode: document.documentElement.dataset.workspaceEvaluationMode ?? null,
    };
  });
  throw new Error(`plan context did not become ready: ${JSON.stringify({ diagnostic, responseFailures })}`, { cause: error });
}
await page.click(".agent-controls-details > summary");
await page.selectOption("#agent-skill", "shopping-research");
await page.fill("#agent-input", "执行本地 exact MPN fixture 的治理型目录补齐流程");
await page.click("#agent-send");
try {
  await page.waitForFunction(() => document.querySelector("#agent-status")?.textContent?.includes("回答完成"));
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    status: document.querySelector("#agent-status")?.textContent ?? null,
    events: [...document.querySelectorAll("#agent-events > *")].map((node) => node.textContent),
    messages: document.querySelector("#agent-messages")?.textContent ?? null,
    context: document.querySelector("#agent-plan-context")?.textContent ?? null,
  }));
  throw new Error(`catalog Agent run did not finish: ${JSON.stringify(diagnostic)}`, { cause: error });
}

const events = await page.locator("#agent-events").allTextContents();
const expected = [
  "搜索候选 2",
  "provider fixture-searxng",
  "待治理域名 1",
  "官方检查 ok",
  "expected hash 已生成",
  "proposed 1",
  "目录补齐 · draft",
  "2 个字段差异",
  "catalog-rollback-fixture.json",
  "审计记录 · completed",
];
for (const fragment of expected) {
  if (!events.some((entry) => entry.includes(fragment))) throw new Error(`missing governed catalog UI state: ${fragment}\n${events.join("\n")}`);
}
if (events.some((entry) => entry.includes("已写 catalog"))) throw new Error("draft fixture was rendered as a formal catalog write");
if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join("\n")}`);

console.log("C7 governed catalog Agent browser fixture passed", { eventCount: events.length, expectedStates: expected.length });
await browser.close();
