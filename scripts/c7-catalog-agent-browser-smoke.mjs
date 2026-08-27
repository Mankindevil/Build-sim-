import { chromium } from "playwright";
import { loadEnv } from "./price-server/env.mjs";

const env = await loadEnv();
const webPort = Number(env.WEB_SERVER_PORT ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_SERVER_PORT must be an integer between 1 and 65535");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

await page.addInitScript(() => {
  class FixtureEventSource {
    listeners = new Map();

    constructor() {
      setTimeout(() => {
        const at = "2026-08-24T00:00:00.000Z";
        this.emit("tool_result", { type: "tool_result", runId: "run-c7", callId: "search", toolName: "search_official_catalog", result: { ok: true, content: { status: "partial", candidates: [{ trustStatus: "trusted" }, { trustStatus: "trusted" }], domainProposals: [{ trustStatus: "proposed" }], discovery: { providerIds: ["fixture-searxng"] } }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId: "run-c7", callId: "inspect", toolName: "inspect_catalog_candidate", result: { ok: true, content: { extraction: { status: "ok", fieldsFound: 5 }, source: { domain: "asus.com" }, expectedHash: "a".repeat(64) }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId: "run-c7", callId: "proposal", toolName: "list_official_domain_proposals", result: { ok: true, content: { proposals: [{ trustStatus: "proposed" }] }, provenance: ["fixture"] }, at });
        this.emit("tool_result", { type: "tool_result", runId: "run-c7", callId: "enrich", toolName: "enrich_official_catalog", result: { ok: true, content: { status: "draft", changedFields: ["dims", "power"], rollbackManifest: "catalog-rollback-fixture.json" }, provenance: ["fixture"] }, at });
        this.emit("run_status", { type: "run_status", runId: "run-c7", status: "completed", at });
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

await page.route("**/api/agent/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (pathname === "/api/agent/models") return json({ models: [{ provider: "deepseek", id: "fixture-model", label: "C7 Fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: false } }] });
  if (pathname === "/api/agent/skills") return json({ skills: [{ manifest: { id: "shopping-research", name: "Shopping Research", description: "C7 fixture", version: "1.1.0", allowedTools: ["search_official_catalog", "inspect_catalog_candidate", "list_official_domain_proposals", "enrich_official_catalog"], readOnly: false }, definitionHash: "b".repeat(64) }] });
  if (pathname === "/api/agent/sessions" && request.method() === "POST") return json({ id: "session-c7", provider: "deepseek", model: "fixture-model", messages: [], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" }, 201);
  if (pathname === "/api/agent/sessions/session-c7/messages") return json({ runId: "run-c7", status: "queued" }, 202);
  if (pathname === "/api/agent/sessions/session-c7") return json({ id: "session-c7", provider: "deepseek", model: "fixture-model", messages: [{ id: "assistant-c7", role: "assistant", content: "C7 fixture flow completed.", createdAt: "2026-08-24T00:00:00.000Z" }], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  if (pathname === "/api/agent/runs/run-c7/audit") return json({ schemaVersion: "1.0.0", runId: "run-c7", sessionId: "session-c7", status: "completed", startedAt: "2026-08-24T00:00:00.000Z", finishedAt: "2026-08-24T00:00:01.000Z", provider: "deepseek", model: "fixture-model", skill: null, toolCalls: [], usage: [], previousRecordHash: null, recordHash: "c".repeat(64) });
  return json({ error: "fixture_route_not_found", pathname }, 404);
});

await page.goto(`http://127.0.0.1:${webPort}/index.html#/agent`, { waitUntil: "networkidle" });
await page.locator('[data-panel="agent"]').waitFor({ state: "visible" });
await page.click(".agent-controls-details > summary");
await page.selectOption("#agent-skill", "shopping-research");
await page.fill("#agent-input", "执行本地 exact MPN fixture 的治理型目录补齐流程");
await page.click("#agent-send");
await page.waitForFunction(() => document.querySelector("#agent-status")?.textContent?.includes("回答完成"));

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
