// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCatalogToolResult, initAgentPanel } from "../src/lab/agent-panel";
import type { PlanAgentContext, PlanChangeProposal } from "../src/plans/contracts";
import { hashPlanConfig } from "../src/plans/canonical";
import { makePlan } from "./helpers/workspace-ui";

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: Event) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close(): void { this.closed = true; }
}

function fixtureHtml(): void {
  document.body.innerHTML = `
    <p id="agent-status" data-level="warn"></p>
    <select id="agent-model"></select><select id="agent-skill"></select>
    <button id="agent-new-session"></button>
    <div id="agent-transcript"></div><ul id="agent-events"></ul><p id="agent-usage"></p>
    <form id="agent-form"><textarea id="agent-input"></textarea><button id="agent-cancel" type="button" disabled></button><button id="agent-send" type="submit"></button></form>`;
}

function payload(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const model = { provider: "deepseek", id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } };
const skill = { manifest: { id: "build-diagnosis", name: "装机诊断", description: "fixture", version: "1.0.0", allowedTools: ["get_build_evaluation", "get_sku_facts"], readOnly: true }, definitionHash: "a".repeat(64) };
const initializerSkill = { manifest: { id: "plan-initializer", name: "渐进式装机档案", description: "fixture", version: "2.0.0", allowedTools: ["search_catalog_skus", "propose_plan_change"], readOnly: true }, definitionHash: "b".repeat(64) };
const session = { contractVersion: "1.0.0", id: "session-fixture", provider: "deepseek", model: model.id, buildConfig: null, messages: [], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" };

describe("A5 Agent panel", () => {
  it("labels catalog candidate, proposal, official inspection and write states distinctly", () => {
    expect(formatCatalogToolResult("search_official_catalog", { status: "partial", candidates: [{}, {}], domainProposals: [{}], discovery: { providerIds: ["searxng"] } })).toContain("搜索候选 2");
    expect(formatCatalogToolResult("inspect_catalog_candidate", { extraction: { status: "ok", fieldsFound: 5 }, source: { domain: "asus.com" }, expectedHash: "a".repeat(64) })).toContain("expected hash 已生成");
    expect(formatCatalogToolResult("list_official_domain_proposals", { proposals: [{ trustStatus: "proposed" }, { trustStatus: "rejected" }] })).toContain("proposed 1");
    expect(formatCatalogToolResult("enrich_official_catalog", { status: "draft", changedFields: [], rollbackManifest: "manifest.json" })).toContain("目录补齐 · draft");
  });
  beforeEach(fixtureHtml);

  it("shows provider-neutral model and metadata-only Skill catalogs", async () => {
    const pro = { ...model, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 深度推理" };
    const vision = { ...model, id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp · 视觉" };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/models") ? payload({ models: [model, pro, vision] }) : payload({ skills: [skill] }));
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(model.id);
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("");
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).selectedOptions[0]?.textContent).toContain("安全读取与审核提案");
    expect((document.querySelector("#agent-model") as HTMLSelectElement).options).toHaveLength(3);
    expect(document.querySelector("#agent-status")?.textContent).toContain("3 个模型 · 1 项能力");
    expect(document.body.textContent).not.toContain("装机诊断工作流");
  });

  it("treats legacy pending metadata as an ordinary progressively editable plan", async () => {
    const active = makePlan("plan-agent-init-12345678", "待 Agent 初始化方案");
    active.metadata.initialization = { status: "pending", source: "agent" };
    let context = {
      schemaVersion: "1.0.0", planId: active.id, planVersionId: null, draftRevision: 0,
      configHash: "1".repeat(64), evaluationHash: "2".repeat(64), buildConfig: active.draft.config,
      evaluation: { config: active.draft.config }, purchaseSummary: {}, buildTaskSummary: {},
      initialization: active.metadata.initialization,
    } as unknown as PlanAgentContext;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/models") ? payload({ models: [model] }) : payload({ skills: [skill, initializerSkill] }));
    await initAgentPanel({ getBuildConfig: () => active.draft.config, getPlanContext: () => context, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("");
    expect(document.querySelector("[data-agent-plan-context]")?.textContent).toContain("已同步当前装机方案");
    expect(document.querySelector("[data-agent-plan-context]")?.textContent).not.toContain("初始化脚手架");
    expect((document.querySelector("#agent-input") as HTMLTextAreaElement).placeholder).toContain("逐项问我");
  });

  it("refreshes a stale model catalog and retries session creation once", async () => {
    const current = { ...model, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 深度推理" };
    let modelReads = 0;
    let sessionCreates = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: modelReads++ === 0 ? [model] : [current] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") {
        sessionCreates += 1;
        if (sessionCreates === 1) return payload({ error: "model_not_found", message: `Unknown Agent model: ${model.id}` }, 404);
        return payload({ ...session, model: current.id }, 201);
      }
      if (url.endsWith("/messages")) return payload({ runId: "run-refreshed", status: "queued" }, 202);
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect(document.querySelector("#agent-status")?.textContent).toContain("1 个模型");
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(model.id);
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "刷新模型";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sessionCreates).toBe(2));
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(current.id);
    expect(document.querySelector("#agent-events")?.textContent).toContain("模型目录已自动刷新");
  });

  it("streams text, Tool audit events, usage, and the persisted final assistant message", async () => {
    const stream = new FakeEventSource();
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && method === "POST") return payload(session, 201);
      if (url.endsWith("/sessions/session-fixture/messages")) return payload({ runId: "run-fixture", status: "queued" }, 202);
      if (url.endsWith("/sessions/session-fixture")) return payload({ ...session, messages: [{ id: "a1", role: "assistant", content: "最终持久化回答", createdAt: "2026-08-24T00:00:01.000Z" }] });
      if (url.endsWith("/runs/run-fixture/audit")) return payload({ status: "completed", recordHash: "c".repeat(64) });
      throw new Error(`unexpected ${method} ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({ schemaVersion: "2.0.0", id: "live" }), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-skill") as HTMLSelectElement).value = "build-diagnosis";
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "诊断当前配置";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/messages"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/messages"))?.body).toMatchObject({ content: "诊断当前配置", skillId: "build-diagnosis", buildConfig: { schemaVersion: "2.0.0", id: "live" } });

    stream.emit("skill_activated", { type: "skill_activated", runId: "run-fixture", skillId: "build-diagnosis", definitionHash: "a".repeat(64), at: "now" });
    stream.emit("tool_call", { type: "tool_call", runId: "run-fixture", call: { id: "c1", name: "get_build_evaluation", input: {} }, toolDefinitionHash: "b".repeat(64), at: "now" });
    stream.emit("tool_result", { type: "tool_result", runId: "run-fixture", callId: "c1", toolName: "get_build_evaluation", result: { ok: true, content: {}, provenance: ["BuildEvaluation"] }, at: "now" });
    stream.emit("text_delta", { type: "text_delta", runId: "run-fixture", text: "流式回答", at: "now" });
    stream.emit("usage", { type: "usage", runId: "run-fixture", provider: "deepseek", model: model.id, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, billing: { status: "priced", pricing: { billedModel: model.id, pricingVersion: "fixture", sourceUrl: "https://api-docs.deepseek.com", pricingBand: { id: "off-peak", label: "空闲时段" }, rates: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 } }, cost: { cacheHitCny: 0, cacheMissCny: 0.000015, outputCny: 0.0000135, totalCny: 0.0000285, currency: "CNY", estimated: true } }, at: "now" });
    stream.emit("run_status", { type: "run_status", runId: "run-fixture", status: "completed", at: "now" });

    await vi.waitFor(() => expect(document.querySelector("#agent-transcript")?.textContent).toContain("最终持久化回答"));
    expect(document.querySelector("#agent-events")?.textContent).toContain("Skill · build-diagnosis");
    expect(document.querySelector("#agent-events")?.textContent).toContain("Tool 结果 · get_build_evaluation · ok");
    expect(document.querySelector("#agent-events")?.textContent).toContain("审计记录 · completed · cccccccccccc");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("total 13");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("估算费用");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("非余额账单");
    expect(stream.closed).toBe(true);
  });

  it("reviews and confirms one exact pending write without sending caller-authored approvals", async () => {
    const stream = new FakeEventSource();
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const writeSkill = {
      manifest: { ...skill.manifest, id: "evidence-and-attachments", name: "附件与事实治理", readOnly: false, allowedTools: ["archive_user_attachment"] },
      definitionHash: "f".repeat(64),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [writeSkill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-write-review", status: "queued" }, 202);
      if (url.endsWith("/runs/run-write-review/approvals/approval-write-review/confirm")) {
        return payload({ runId: "run-write-review", status: "queued", approvalId: "approval-write-review", alreadyConfirmed: false }, 202);
      }
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-skill") as HTMLSelectElement).value = "evidence-and-attachments";
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "归档刚上传的附件";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/messages"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/messages"))?.body).not.toHaveProperty("approvals");

    const pending = {
      contractVersion: "1.0.0", status: "pending", approvalId: "approval-write-review", nonce: `nonce-${"1".repeat(64)}`,
      runId: "run-write-review", sessionId: session.id,
      call: { id: "call-write-review", name: "archive_user_attachment", input: { uploadId: "upload-write-review", deletionPolicy: "retain_until_user_deletes" } },
      toolTitle: "归档用户附件", toolDefinitionHash: "a".repeat(64), inputHash: "b".repeat(64), idempotencyKey: "agent-write-review",
      requestedAt: "2026-08-28T08:00:00.000Z", expiresAt: "2026-08-28T08:10:00.000Z",
      backup: { required: true, target: "active-runtime-generation" }, rollback: { required: true, strategy: "governed rollback" },
    };
    stream.emit("approval_required", { type: "approval_required", runId: "run-write-review", pending, at: "now" });
    stream.emit("run_status", { type: "run_status", runId: "run-write-review", status: "waiting_approval", at: "now" });
    await vi.waitFor(() => expect(document.querySelector("[data-agent-write-approval='approval-write-review']")).not.toBeNull());
    const card = document.querySelector<HTMLElement>("[data-agent-write-approval='approval-write-review']")!;
    expect(card.textContent).toContain("尚未执行任何写入");
    expect(card.textContent).toContain("archive_user_attachment");
    expect(card.textContent).toContain("upload-write-review");
    const confirm = card.querySelector<HTMLButtonElement>("[data-confirm-agent-write]")!;
    expect(confirm.disabled).toBe(true);
    const checkbox = card.querySelector<HTMLInputElement>("[data-agent-write-approval-check]")!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event("change"));
    confirm.click();
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/confirm"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/confirm"))?.body).toEqual({ nonce: pending.nonce, approvedBy: "local-human" });
    await vi.waitFor(() => expect(card.dataset.state).toBe("confirmed"));
  });

  it("rejects a pending write from its review card and cancels without an approval envelope", async () => {
    const stream = new FakeEventSource();
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const writeSkill = {
      manifest: { ...skill.manifest, id: "evidence-and-attachments", name: "附件与事实治理", readOnly: false, allowedTools: ["archive_user_attachment"] },
      definitionHash: "f".repeat(64),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [writeSkill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-write-reject", status: "queued" }, 202);
      if (url.endsWith("/runs/run-write-reject/approvals/approval-write-reject/reject")) {
        return payload({ runId: "run-write-reject", status: "cancelled", approvalId: "approval-write-reject" }, 202);
      }
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-skill") as HTMLSelectElement).value = "evidence-and-attachments";
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "不要归档这个附件";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/messages"))).toBe(true));
    const pending = {
      contractVersion: "1.0.0", status: "pending", approvalId: "approval-write-reject", nonce: `nonce-${"2".repeat(64)}`,
      runId: "run-write-reject", sessionId: session.id,
      call: { id: "call-write-reject", name: "archive_user_attachment", input: { uploadId: "upload-write-reject", deletionPolicy: "retain_until_user_deletes" } },
      toolTitle: "归档用户附件", toolDefinitionHash: "a".repeat(64), inputHash: "b".repeat(64), idempotencyKey: "agent-write-reject",
      requestedAt: "2026-08-28T08:00:00.000Z", expiresAt: "2026-08-28T08:10:00.000Z",
      backup: { required: true, target: "active-runtime-generation" }, rollback: { required: true, strategy: "governed rollback" },
    };
    stream.emit("approval_required", { type: "approval_required", runId: pending.runId, pending, at: "now" });
    const card = document.querySelector<HTMLElement>("[data-agent-write-approval='approval-write-reject']")!;
    card.querySelector<HTMLButtonElement>("[data-reject-agent-write]")!.click();
    await vi.waitFor(() => expect(card.dataset.state).toBe("rejected"));
    expect(requests.find((entry) => entry.url.endsWith("/reject"))?.body).toEqual({ nonce: pending.nonce });
    expect(card.textContent).toContain("未执行写入");
  });

  it("renders and confirms a governed catalog review from normal Agent conversation", async () => {
    const stream = new FakeEventSource();
    const onCatalogSkuAccepted = vi.fn();
    const candidateInputHash = "d".repeat(64);
    const inputHash = "e".repeat(64);
    const sourceUrl = "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC";
    const sku = {
      id: "gpu.msi-geforce-rtx-3070-ventus-2x-oc", category: "gpu", brand: "MSI", model: "GeForce RTX 3070 VENTUS 2X OC", name: "MSI GeForce RTX 3070 VENTUS 2X OC",
      dims: { lengthMm: 232, thicknessMm: 52, slots: 3, evidence: "inferred" }, power: { tgpW: 220, evidence: "official" }, attrs: { noiseDba: 35, maxOperatingTempC: 93 },
      price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    };
    const official = (field: string, value: unknown) => ({
      provenanceId: `prov-${field}`, field, value, evidence: "official", sourceUrl, sourceKind: "official-page",
      retrievedAt: "2026-08-26T00:00:00.000Z", extractor: "msi-v1",
    });
    const preview = {
      status: "preview", schemaVersion: "1.0.0", draftId: "sku-draft-agent-review", operation: "update", baseSkuId: "gpu.fixture-existing",
      baseSkuHash: "b".repeat(64), baseCatalogVersion: "2.0.1", candidateId: "catalog-candidate-agent-review", candidateInputHash,
      proposed: sku,
      fields: [
        official("brand", "MSI"), official("model", sku.model),
        { ...official("dims.lengthMm", 232), before: undefined }, official("dims.thicknessMm", 52),
        { ...official("dims.slots", 3), evidence: "inferred", extractor: "inferred-pcie-slot-pitch-v1", derivedFromProvenanceId: "prov-dims.thicknessMm" },
        official("power.tgpW", 220), official("attrs.noiseDba", 35), official("attrs.maxOperatingTempC", 93),
      ],
      conflicts: [], missing: [], changedFields: ["dims.lengthMm", "dims.thicknessMm", "dims.slots", "power.tgpW", "attrs.noiseDba", "attrs.maxOperatingTempC"],
      inputHash, expectedHash: inputHash, writeEnabled: true,
      candidateSnapshot: { canonicalUrl: sourceUrl, official: { trustStatus: "trusted", pageKind: "product" } },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-catalog-review", status: "queued" }, 202);
      if (url.endsWith("/api/price/catalog/candidates/catalog-candidate-agent-review/draft")) return payload({ ...preview, status: "draft" });
      if (url.endsWith("/api/price/catalog-drafts/sku-draft-agent-review/confirm")) return payload({ status: "confirmed", skuId: sku.id, sku, catalogChanged: true, created: false, changedFields: preview.changedFields });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), onCatalogSkuAccepted, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("");
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "把这个显卡补充为配置选项";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/messages"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/messages"))?.body).not.toHaveProperty("skillId");

    const toolResult = { type: "tool_result", runId: "run-catalog-review", callId: "review", toolName: "propose_catalog_review", result: { ok: true, content: { preview, writeEnabled: true }, provenance: ["catalog-review"] }, at: "now" };
    stream.emit("tool_result", toolResult);
    stream.emit("tool_result", toolResult);
    await vi.waitFor(() => expect(document.querySelectorAll("[data-catalog-review='sku-draft-agent-review']")).toHaveLength(1));
    const card = document.querySelector<HTMLElement>("[data-catalog-review='sku-draft-agent-review']")!;
    expect(card.textContent).toContain("补充现有配置选项");
    expect(card.textContent).toContain("制造商料号（可选）");
    expect(card.textContent).toContain("官网未提供");
    expect(card.textContent).toContain("未知 → 232 mm");
    expect(card.textContent).toContain("规则推导");
    expect(card.textContent).toContain("热包络评估");
    expect(card.textContent).toContain("35 dBA");
    expect(card.textContent).toContain("93 °C");
    expect(card.querySelector<HTMLAnchorElement>("a")?.href).toBe(sourceUrl);
    expect(card.querySelector("input:not([type='checkbox']), textarea")).toBeNull();
    const accept = card.querySelector<HTMLButtonElement>("[data-accept-catalog-review]")!;
    expect(accept.disabled).toBe(true);
    const approval = card.querySelector<HTMLInputElement>("[data-catalog-approval]")!;
    approval.checked = true; approval.dispatchEvent(new Event("change"));
    expect(accept.disabled).toBe(false);
    accept.click();
    await vi.waitFor(() => expect(onCatalogSkuAccepted).toHaveBeenCalledWith(expect.objectContaining({ id: sku.id })));
    expect(requests.find((entry) => entry.url.endsWith("/catalog-candidates/catalog-candidate-agent-review/draft"))).toBeUndefined();
    expect(requests.find((entry) => entry.url.endsWith("/catalog/candidates/catalog-candidate-agent-review/draft"))?.body).toEqual({ expectedHash: candidateInputHash, expectedDraftHash: inputHash, selections: {} });
    expect(requests.find((entry) => entry.url.endsWith("/catalog-drafts/sku-draft-agent-review/confirm"))?.body).toEqual({ approved: true, expectedHash: inputHash });
    expect(card.textContent).toContain("当前方案没有自动改变");
  });

  it("keeps a server-confirmed catalog review terminal when browser synchronization fails", async () => {
    const stream = new FakeEventSource();
    const candidateInputHash = "7".repeat(64);
    const inputHash = "8".repeat(64);
    const sku = {
      id: "gpu.confirmed-sync-failure", category: "gpu", brand: "Fixture", model: "Confirmed GPU", name: "Fixture Confirmed GPU",
      dims: { lengthMm: 220, slots: 2, evidence: "official" }, power: { tgpW: 180, evidence: "official" },
      price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    };
    const preview = {
      status: "preview", draftId: "sku-draft-confirmed-sync-failure", operation: "create", candidateId: "catalog-candidate-confirmed-sync-failure",
      candidateInputHash, inputHash, proposed: sku,
      fields: [{ field: "brand", value: "Fixture", evidence: "official", sourceKind: "official-page" }], conflicts: [], missing: [], changedFields: ["new SKU"], writeEnabled: true,
    };
    const onCatalogSkuAccepted = vi.fn(async () => { throw new Error("browser refresh failed"); });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-confirmed-sync-failure", status: "queued" }, 202);
      if (url.endsWith("/draft")) return payload({ ...preview, status: "draft" });
      if (url.endsWith("/confirm")) return payload({ status: "confirmed", skuId: sku.id, sku, catalogChanged: true, created: true });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), onCatalogSkuAccepted, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "新增这个配置选项";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect((document.querySelector("#agent-cancel") as HTMLButtonElement).disabled).toBe(false));
    stream.emit("tool_result", { type: "tool_result", runId: "run-confirmed-sync-failure", callId: "review", toolName: "propose_catalog_review", result: { ok: true, content: preview, provenance: [] }, at: "now" });
    const card = document.querySelector<HTMLElement>("[data-catalog-review='sku-draft-confirmed-sync-failure']")!;
    const approval = card.querySelector<HTMLInputElement>("[data-catalog-approval]")!;
    approval.checked = true; approval.dispatchEvent(new Event("change"));
    card.querySelector<HTMLButtonElement>("[data-accept-catalog-review]")!.click();
    await vi.waitFor(() => expect(card.textContent).toContain("已写入正式目录；本页同步失败，请刷新页面"));
    expect(card.dataset.state).toBe("confirmed");
    expect(onCatalogSkuAccepted).toHaveBeenCalledWith(expect.objectContaining({ id: sku.id }));
    expect([...card.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")].every((control) => control.disabled)).toBe(true);
  });

  it("blocks catalog confirmation on a disabled write gate or a changed persistent draft hash", async () => {
    const stream = new FakeEventSource();
    const onCatalogSkuAccepted = vi.fn();
    const basePreview = {
      status: "preview", draftId: "sku-draft-disabled", operation: "create", candidateId: "catalog-candidate-disabled",
      candidateInputHash: "a".repeat(64), inputHash: "b".repeat(64), proposed: { id: "psu.disabled", category: "psu", brand: "Fixture", model: "Disabled 850", name: "Fixture Disabled 850", power: { ratedW: 850 } },
      fields: [
        { field: "brand", value: "Fixture", evidence: "official", sourceKind: "official-page" },
        { field: "power.ratedW", value: 850, evidence: "official", sourceKind: "official-page" },
      ], conflicts: [], missing: [], changedFields: ["brand", "power.ratedW"], writeEnabled: false,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-catalog-blocked", status: "queued" }, 202);
      if (url.endsWith("/draft")) return payload({
        ...basePreview,
        status: "draft",
        draftId: url.includes("mismatch") ? "sku-draft-mismatch" : basePreview.draftId,
        candidateId: url.includes("mismatch") ? "catalog-candidate-mismatch" : basePreview.candidateId,
        inputHash: "c".repeat(64),
        writeEnabled: true,
      });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), onCatalogSkuAccepted, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "补充";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect((document.querySelector("#agent-cancel") as HTMLButtonElement).disabled).toBe(false));

    stream.emit("tool_result", { type: "tool_result", runId: "run-catalog-blocked", callId: "disabled", toolName: "propose_catalog_review", result: { ok: true, content: { preview: basePreview }, provenance: [] }, at: "now" });
    const disabledCard = document.querySelector<HTMLElement>("[data-catalog-review='sku-draft-disabled']")!;
    const disabledApproval = disabledCard.querySelector<HTMLInputElement>("[data-catalog-approval]")!;
    disabledApproval.checked = true; disabledApproval.dispatchEvent(new Event("change"));
    expect(disabledCard.querySelector<HTMLButtonElement>("[data-accept-catalog-review]")?.disabled).toBe(true);
    expect(disabledCard.textContent).toContain("关闭了正式目录写入");
    expect(disabledCard.textContent).toContain("额定输出容量，不等于发热");

    const mismatch = { ...basePreview, draftId: "sku-draft-mismatch", candidateId: "catalog-candidate-mismatch", writeEnabled: true };
    stream.emit("tool_result", { type: "tool_result", runId: "run-catalog-blocked", callId: "mismatch", toolName: "propose_catalog_review", result: { ok: true, content: { preview: mismatch }, provenance: [] }, at: "now" });
    const mismatchCard = document.querySelector<HTMLElement>("[data-catalog-review='sku-draft-mismatch']")!;
    const mismatchApproval = mismatchCard.querySelector<HTMLInputElement>("[data-catalog-approval]")!;
    mismatchApproval.checked = true; mismatchApproval.dispatchEvent(new Event("change"));
    mismatchCard.querySelector<HTMLButtonElement>("[data-accept-catalog-review]")!.click();
    await vi.waitFor(() => expect(mismatchCard.textContent).toContain("不可变哈希不一致"));
    expect(onCatalogSkuAccepted).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/confirm"))).toBe(false);

    mismatchCard.querySelector<HTMLButtonElement>("[data-reject-catalog-review]")!.click();
    expect(document.querySelector("[data-catalog-review='sku-draft-mismatch']")).toBeNull();

    const conflicted = {
      ...basePreview,
      draftId: "sku-draft-conflicted",
      candidateId: "catalog-candidate-conflicted",
      writeEnabled: true,
      conflicts: [{ field: "power.tgpW", existing: 200, proposed: 220, reason: "两个官网规格值不一致" }],
      missing: ["dims.slots"],
    };
    stream.emit("tool_result", { type: "tool_result", runId: "run-catalog-blocked", callId: "conflicted", toolName: "propose_catalog_review", result: { ok: true, content: { preview: conflicted }, provenance: [] }, at: "now" });
    const conflictCard = document.querySelector<HTMLElement>("[data-catalog-review='sku-draft-conflicted']")!;
    expect(conflictCard.textContent).toContain("200 W → 220 W");
    expect(conflictCard.textContent).toContain("两个官网规格值不一致");
    expect(conflictCard.textContent).toContain("占用槽位");
    const conflictApproval = conflictCard.querySelector<HTMLInputElement>("[data-catalog-approval]")!;
    conflictApproval.checked = true; conflictApproval.dispatchEvent(new Event("change"));
    expect(conflictCard.querySelector<HTMLButtonElement>("[data-accept-catalog-review]")?.disabled).toBe(true);

    (document.querySelector("#agent-model") as HTMLSelectElement).dispatchEvent(new Event("change"));
    expect(document.querySelector("[data-catalog-review]")).toBeNull();
  });

  it("sends cancellation for the active run", async () => {
    const stream = new FakeEventSource();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-cancel", status: "queued" }, 202);
      if (url.endsWith("/runs/run-cancel/cancel")) return payload({ runId: "run-cancel", status: "running" }, 202);
      return payload({ ...session, messages: [] });
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "取消测试";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect((document.querySelector("#agent-cancel") as HTMLButtonElement).disabled).toBe(false));
    (document.querySelector("#agent-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith("/api/agent/runs/run-cancel/cancel", expect.objectContaining({ method: "POST" })));
  });

  it("binds run context and applies a structured proposal only after explicit human approval", async () => {
    const stream = new FakeEventSource();
    const active = makePlan("plan-agent-12345678", "Agent plan");
    const configHash = "1".repeat(64);
    const evaluationHash = "2".repeat(64);
    let context = {
      schemaVersion: "1.0.0",
      planId: active.id,
      planVersionId: active.activeVersionId,
      draftRevision: active.draftRevision,
      configHash,
      evaluationHash,
      buildConfig: active.draft.config,
      evaluation: { config: active.draft.config, findings: [], price: { knownCny: 0 } },
      spatialSelection: { partId: "psu.primary", view: "spatial", findingId: "physical.psu-clearance" },
      spatialViewContext: { cameraMode: "perspective" },
      purchaseSummary: { linked: 0 },
      buildTaskSummary: { todo: 1 },
    } as unknown as PlanAgentContext;
    const proposal: PlanChangeProposal = {
      schemaVersion: "1.0.0", id: "proposal-panel", planId: active.id, expectedDraftRevision: active.draftRevision, expectedConfigHash: configHash,
      createdAt: "2026-08-25T00:00:00.000Z", summary: "改为两块硬盘", rationale: ["用户要求"],
      operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }],
      predictedImpact: { resolvedFindingIds: ["storage.fixture"], introducedFindingIds: [], budgetDeltaCny: 100 }, status: "proposed",
    };
    const appliedPlan = structuredClone(active);
    appliedPlan.draftRevision += 1;
    appliedPlan.draft.config.selection.diskCount = 2;
    const appliedConfigHash = await hashPlanConfig(appliedPlan.draft.config);
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const auditedContext = {
      ...context,
      evidenceSummary: {
        count: 0,
        bindings: [],
        resolutions: [],
        inferences: [{ lifecycle: "active", marker: "server-derived-inference-summary" }],
      },
    } as unknown as PlanAgentContext;
    const acceptServerPlan = vi.fn(async () => {
      context = { ...context, draftRevision: appliedPlan.draftRevision, configHash: appliedConfigHash, buildConfig: structuredClone(appliedPlan.draft.config) };
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [{ ...skill, manifest: { ...skill.manifest, allowedTools: [...skill.manifest.allowedTools, "propose_plan_change"] } }] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-plan", status: "queued" }, 202);
      if (url.endsWith("/agent-context")) return payload({ runId: "run-plan", contextHash: "3".repeat(64), context: auditedContext }, 201);
      if (url.endsWith("/proposals/validate")) return payload({ proposal });
      if (url.endsWith("/proposals/apply")) return payload({ proposal: { ...proposal, status: "applied" }, plan: appliedPlan, audit: { approvalId: "approval-panel" } });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => active.draft.config, getPlanContext: () => context, acceptServerPlan, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    expect(document.querySelector("[data-agent-plan-context]")?.textContent).toContain(evaluationHash.slice(0, 12));
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "根据当前 PSU 提出修复";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/agent-context"))).toBe(true));
    const messageBody = requests.find((entry) => entry.url.endsWith("/messages"))?.body;
    expect(messageBody?.content).toContain("<plan_agent_context");
    expect(messageBody?.content).toContain(evaluationHash);
    expect(messageBody?.content).toContain("psu.primary");
    expect(messageBody?.content).toContain("server-derived-inference-summary");
    expect(messageBody?.content).not.toContain("approvalToken");
    const contextRequest = requests.find((entry) => entry.url.endsWith("/agent-context"))!;
    expect(contextRequest.body).toMatchObject({ sessionId: session.id, idempotencyKey: expect.stringMatching(/^context-/), context: { planId: active.id, evaluationHash } });
    const messageRequest = requests.find((entry) => entry.url.endsWith("/messages"))!;
    expect(messageRequest.body?.idempotencyKey).toBe(contextRequest.body?.idempotencyKey);
    expect(requests.indexOf(contextRequest)).toBeLessThan(requests.indexOf(messageRequest));

    stream.emit("text_delta", { type: "text_delta", runId: "run-plan", text: "我已经修复。", at: "now" });
    expect(acceptServerPlan).not.toHaveBeenCalled();
    stream.emit("tool_result", { type: "tool_result", runId: "run-plan", callId: "proposal", toolName: "propose_plan_change", result: { ok: true, content: { proposal }, provenance: [] }, at: "now" });
    await vi.waitFor(() => expect(document.querySelector("[data-plan-proposal='proposal-panel']")).not.toBeNull());
    const apply = document.querySelector<HTMLButtonElement>("[data-apply-proposal]")!;
    expect(apply.disabled).toBe(true);
    expect(acceptServerPlan).not.toHaveBeenCalled();
    const approval = document.querySelector<HTMLInputElement>("[data-proposal-approval]")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    apply.click();
    await vi.waitFor(() => expect(acceptServerPlan).toHaveBeenCalledWith(expect.objectContaining({ draftRevision: active.draftRevision + 1 })));
    expect(requests.find((entry) => entry.url.endsWith("/proposals/apply"))?.body).toMatchObject({ operationIndexes: [0], approvalConfirmed: true, approvedBy: "local-human" });
  });

  it("shows unchecked requirement confirmations only for selected operations and sends only explicit choices", async () => {
    const active = makePlan("plan-agent-confirm-12345678", "Agent confirmations");
    const configHash = "4".repeat(64);
    const evaluationHash = "5".repeat(64);
    let context = {
      schemaVersion: "1.0.0", planId: active.id, planVersionId: active.activeVersionId, draftRevision: active.draftRevision,
      configHash, evaluationHash, buildConfig: active.draft.config,
      evaluation: { config: active.draft.config }, purchaseSummary: {}, buildTaskSummary: {},
    } as unknown as PlanAgentContext;
    const budgetId = "requirement:budget";
    const horizonId = "requirement:horizonYears";
    const proposal = {
      schemaVersion: "1.0.0", id: "proposal-panel-requirements", planId: active.id,
      expectedDraftRevision: active.draftRevision, expectedConfigHash: configHash, configSchemaVersion: "3.0.0",
      createdAt: "2026-08-27T00:00:00.000Z", summary: "补充需求", rationale: ["待用户逐项确认"],
      operations: [
        { op: "replace", selector: { collection: "config", field: "requirementBudget" }, value: { state: "answered", value: { hardCapCny: 9000 }, source: "agent_proposed", confirmedByUser: false } },
        { op: "replace", selector: { collection: "config", field: "requirementHorizonYears" }, value: { state: "answered", value: 5, source: "agent_proposed", confirmedByUser: false } },
      ],
      confirmableRequirementFieldIds: [budgetId, horizonId],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null }, status: "proposed",
    } as unknown as PlanChangeProposal;
    const appliedPlan = structuredClone(active);
    appliedPlan.draftRevision += 1;
    const appliedConfigHash = await hashPlanConfig(appliedPlan.draft.config);
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/proposals/validate")) return payload({ proposal });
      if (url.endsWith("/proposals/apply")) return payload({ proposal: { ...proposal, status: "applied" }, plan: appliedPlan, audit: { approvalId: "approval-confirm" } });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({
      getBuildConfig: () => active.draft.config,
      getPlanContext: () => context,
      acceptServerPlan: async () => {
        context = { ...context, draftRevision: appliedPlan.draftRevision, configHash: appliedConfigHash, buildConfig: appliedPlan.draft.config };
      },
      fetchImpl: fetchImpl as typeof fetch,
      eventSourceFactory: () => new FakeEventSource(),
    });
    document.querySelector("[data-agent-plan-proposals]")?.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal } }));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-proposal-requirement-confirmation]")).toHaveLength(2));
    const budget = document.querySelector<HTMLInputElement>(`[data-proposal-requirement-confirmation='${budgetId}']`)!;
    const horizon = document.querySelector<HTMLInputElement>(`[data-proposal-requirement-confirmation='${horizonId}']`)!;
    expect([budget.checked, horizon.checked]).toEqual([false, false]);

    const horizonOperation = document.querySelector<HTMLInputElement>("[data-proposal-operation='1']")!;
    horizonOperation.checked = false;
    horizonOperation.dispatchEvent(new Event("change"));
    expect(horizon.disabled).toBe(true);
    expect(horizon.parentElement?.hidden).toBe(true);
    budget.checked = true;
    budget.dispatchEvent(new Event("change"));
    const approval = document.querySelector<HTMLInputElement>("[data-proposal-approval]")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>("[data-apply-proposal]")!.click();

    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/proposals/apply"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/proposals/apply"))?.body).toMatchObject({
      operationIndexes: [0], confirmedRequirementFieldIds: [budgetId], approvalConfirmed: true,
    });
  });

  it("does not start an Agent run when plan-context preflight fails", async () => {
    const active = makePlan("plan-agent-audit-fail-12345678", "Agent audit failure");
    const context = {
      schemaVersion: "1.0.0", planId: active.id, planVersionId: active.activeVersionId, draftRevision: active.draftRevision,
      configHash: "1".repeat(64), evaluationHash: "2".repeat(64), buildConfig: active.draft.config,
      evaluation: { config: active.draft.config }, purchaseSummary: {}, buildTaskSummary: {},
    } as unknown as PlanAgentContext;
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/agent-context")) return payload({ error: "stale_revision", message: "stale" }, 409);
      if (url.endsWith("/messages")) throw new Error("run must not start after failed context preflight");
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => active.draft.config, getPlanContext: () => context, requirePlanContext: () => true, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "不要绕过审计";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#agent-status")?.textContent).toContain("发送失败"));
    expect(requests.filter((url) => url.endsWith("/messages"))).toEqual([]);
  });

  it.each([
    {
      label: "switched plan",
      nextContext: (value: PlanAgentContext): PlanAgentContext => ({ ...value, planId: "plan-other-12345678" }),
      message: "当前方案已经切换",
    },
    {
      label: "stale draft",
      nextContext: (value: PlanAgentContext): PlanAgentContext => ({ ...value, draftRevision: value.draftRevision + 1, configHash: "4".repeat(64) }),
      message: "当前草稿已发生变化",
    },
  ])("does not POST an approved proposal card after a $label", async ({ nextContext, message }) => {
    const stream = new FakeEventSource();
    const active = makePlan("plan-agent-preflight-12345678", "Agent preflight plan");
    let context = {
      schemaVersion: "1.0.0",
      planId: active.id,
      planVersionId: active.activeVersionId,
      draftRevision: active.draftRevision,
      configHash: "1".repeat(64),
      evaluationHash: "2".repeat(64),
      buildConfig: active.draft.config,
      evaluation: { config: active.draft.config },
      purchaseSummary: {},
      buildTaskSummary: {},
    } as unknown as PlanAgentContext;
    const proposal: PlanChangeProposal = {
      schemaVersion: "1.0.0",
      id: `proposal-${nextContext(context).planId}`,
      planId: active.id,
      expectedDraftRevision: active.draftRevision,
      expectedConfigHash: context.configHash,
      createdAt: "2026-08-27T06:00:00.000Z",
      summary: "修改硬盘数量",
      rationale: ["用户审核"],
      operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
      status: "proposed",
    };
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/proposals/validate")) return payload({ proposal });
      if (url.endsWith("/proposals/apply")) throw new Error("apply must not be requested");
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({
      getBuildConfig: () => active.draft.config,
      getPlanContext: () => context,
      fetchImpl: fetchImpl as typeof fetch,
      eventSourceFactory: () => stream,
    });
    document.querySelector("[data-agent-plan-proposals]")?.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal } }));
    await vi.waitFor(() => expect(document.querySelector(`[data-plan-proposal='${proposal.id}']`)).not.toBeNull());
    context = nextContext(context);
    const approval = document.querySelector<HTMLInputElement>("[data-proposal-approval]")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>("[data-apply-proposal]")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-proposal-state]")?.textContent).toContain(message));
    expect(requests.filter((url) => url.endsWith("/proposals/apply"))).toEqual([]);
  });
});
