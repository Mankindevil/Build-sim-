import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdviceInput, validateAdviceInput, validateAdviceResult } from "../src/advice/validate";
import type { BuildAdviceInput, BuildAdviceResult } from "../src/advice/types";
import { createAdviceJob, restoreAdviceRollback, waitForAdviceJob } from "../scripts/deepseek/advice.mjs";
import { parseDeepSeekConfig } from "../scripts/deepseek/config.mjs";

function input(): BuildAdviceInput {
  return {
    requestId: "advice-fixture",
    locale: "zh-CN",
    userGoal: "NAS 优先",
    buildConfig: {
      schemaVersion: "2.0.0",
      id: "fixture",
      name: "Fixture",
      updatedAt: "2026-08-23",
      caseId: "case.fixture",
      boardId: "board.fixture",
      cpuId: "cpu.fixture",
      selection: { psuId: "psu.fixture", psuTopology: "auto", coolerId: "cooler.fixture", gpuId: "gpu.none", memoryId: "memory.fixture", diskCount: 9, boot: "m2", hbaMode: "auto" },
      bom: [{ skuId: "memory.fixture", qty: 1, bucket: "buy_now" }],
    },
    evaluation: {
      findings: [{ id: "fit.bad", verdict: "bad", evidence: "official", message: "fixture conflict", related: ["case.fixture"] }],
      occupancy: { verdict: "bad", findings: [], conflicts: [] },
      wiring: {} as BuildAdviceInput["evaluation"]["wiring"],
      routing: {} as BuildAdviceInput["evaluation"]["routing"],
      bom: [{ skuId: "memory.fixture", qty: 1, bucket: "buy_now" }],
      unknown: ["thermal.evidence"],
    },
    selectedSkuFacts: [{ skuId: "memory.fixture", name: "Fixture Memory", fields: { capacityGb: 32 }, provenance: [{ provenanceId: "sku-prov-1", field: "capacityGb", value: 32, evidence: "official", sourceUrl: "https://example.com/memory", sourceKind: "official-page", retrievedAt: "2026-08-23T00:00:00.000Z", extractor: "fixture" }] }],
    constraints: { cannotDowngradeBad: true, unknownMustStayUnknown: true, citeSourceFields: true },
  };
}

function advice(verdict: BuildAdviceResult["recommendation"]["verdict"] = "conditional"): BuildAdviceResult {
  return {
    schemaVersion: "1.0.0",
    model: "deepseek-chat",
    generatedAt: "2026-08-23T00:00:00.000Z",
    summary: "基于确定性冲突和已确认字段给出条件建议。",
    recommendation: { verdict, reasons: [{ text: "存在确定性冲突，需先处理。", kind: "engine-finding", refs: ["fit.bad"] }] },
    risks: [{ level: "high", category: "mechanical", text: "装机冲突保持为阻断风险。", refs: ["fit.bad"] }],
    actions: [{ priority: 1, action: "先复核冲突来源。", blocking: true, refs: ["fit.bad"] }],
    alternatives: [],
    unknowns: ["thermal.evidence"],
    sourceRefs: ["fit.bad", "sku-prov-1"],
  };
}

describe("G6 structured DeepSeek advice", () => {
  it("validates server-only environment settings without exposing a key", async () => {
    expect(() => parseDeepSeekConfig({ DEEPSEEK_ENABLED: "true" })).toThrow(/API_KEY/);
    expect(() => parseDeepSeekConfig({ DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-secret", DEEPSEEK_API_URL: "file:///tmp/deepseek" })).toThrow(/http/);
    expect(() => parseDeepSeekConfig({ DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-secret", DEEPSEEK_TIMEOUT_MS: "999999" })).toThrow(/TIMEOUT/);
    expect(parseDeepSeekConfig({})).toMatchObject({ enabled: false, model: "deepseek-chat", timeoutMs: 30_000 });
  });

  it("builds a bounded input from the same BuildEvaluation facts", () => {
    const base = input();
    const built = buildAdviceInput({ requestId: base.requestId, buildConfig: base.buildConfig, evaluation: { ...base.evaluation, power: { unknown: ["power.cpu"] } } as never, selectedSkuFacts: base.selectedSkuFacts });
    expect(validateAdviceInput(built)).toEqual([]);
    expect(built.evaluation.unknown).toContain("power.cpu");
    expect(built.constraints.cannotDowngradeBad).toBe(true);
  });

  it("rejects unsupported numbers, refs, and recommended over bad", () => {
    const current = input();
    expect(validateAdviceResult(advice("recommended"), current).ok).toBe(false);
    expect(validateAdviceResult({ ...advice(), summary: "凭空声称 999W" }, current).ok).toBe(false);
    expect(validateAdviceResult({ ...advice(), recommendation: { ...advice().recommendation, reasons: [{ ...advice().recommendation.reasons[0], refs: ["not-a-ref"] }] } }, current).ok).toBe(false);
    expect(validateAdviceResult(advice(), current).ok).toBe(true);
  });

  it("keeps deterministic findings when advice is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-disabled-"));
    const job = await createAdviceJob(input(), { flags: { adviceEnabled: false }, config: { enabled: false, model: "deepseek-chat" }, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    expect(job.status).toBe("disabled");
    expect(job.deterministic.verdict).toBe("bad");
    expect((job as any).advice).toBeUndefined();
  });

  it("runs a valid provider response, caches it, and stores only hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-success-"));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(advice()) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret-fixture-key", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") };
    const first = await createAdviceJob(input(), options);
    const done = await waitForAdviceJob(first.requestId, options as never) as any;
    expect(done?.status).toBe("completed");
    expect(done?.advice?.recommendation.verdict).toBe("conditional");
    const second = await createAdviceJob({ ...input(), requestId: "advice-fixture-2" }, options);
    expect(second.status).toBe("completed");
    expect(calls).toBe(1);
    const audit = JSON.parse(await readFile(path.join(root, "events", "2026-08-23.json"), "utf8"));
    expect(audit.events[0].responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(audit)).not.toContain("secret-fixture-key");
    const manifestPath = path.join(root, "rollback", "advice-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.entries.some((entry: { operation: string }) => entry.operation === "advice-job")).toBe(true);
    await restoreAdviceRollback(path.join(root, "jobs", `${first.requestId}.json`), { manifestPath });
  });

  it("retries invalid JSON and degrades without blocking deterministic output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-invalid-"));
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }); };
    const first = await createAdviceJob({ ...input(), userGoal: "invalid-json-fixture" }, { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    const done = await waitForAdviceJob(first.requestId, { timeoutMs: 2_000, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") } as never) as any;
    expect(done?.status).toBe("advice-unavailable");
    expect(done?.deterministic.verdict).toBe("bad");
    expect(calls).toBe(2);
  });

  it("rejects a provider verdict that would downgrade bad", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-verdict-"));
    const unsafe = advice("recommended");
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(unsafe) } }] }), { status: 200 });
    const first = await createAdviceJob({ ...input(), userGoal: "unsafe-verdict" }, { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    const done = await waitForAdviceJob(first.requestId, { timeoutMs: 2_000, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") } as never) as any;
    expect(done?.status).toBe("advice-unavailable");
    expect(done?.failureStage).toBe("validation");
    expect(done?.deterministic.verdict).toBe("bad");
  });
});
