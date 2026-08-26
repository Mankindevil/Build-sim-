import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdviceInput, validateAdviceInput, validateAdviceResult } from "../src/advice/validate";
import type { BuildAdviceInput, BuildAdviceResult } from "../src/advice/types";
import { createAdviceJob, getAdviceBillingSummary, restoreAdviceRollback, waitForAdviceJob } from "../scripts/deepseek/advice.mjs";
import { loadDeepSeekConfig, parseDeepSeekConfig } from "../scripts/deepseek/config.mjs";

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
      physical: { schemaVersion: "1.0.0", rulesetVersion: "physical-rules-1.0.0", hash: "physical-fixture", provenance: ["fixture"], plugSweeps: [], bendRadius: [], slotWidth: { gpuSlots: null, hbaSlots: 0, totalSlots: 0, evidence: "unknown" }, lane: { nvmeCount: 0, m2Slots: 2, slimSasClaimed: false, hbaPresent: false, evidence: "standard" }, serviceSpace: { minimumInsertionMm: null, blockedPorts: [], evidence: "unknown" }, findings: [] },
      calibration: { snapshot: {} as BuildAdviceInput["evaluation"]["calibration"]["snapshot"], unknown: ["wallPowerW"], provenance: [], narrowedRanges: {}, hash: "calibration-fixture" },
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
    expect(parseDeepSeekConfig({})).toMatchObject({ enabled: false, model: "deepseek-v4-flash", timeoutMs: 30_000 });
  });

  it("uses deployed process environment values ahead of local fallbacks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-deepseek-config-"));
    await writeFile(path.join(root, ".env.local"), "DEEPSEEK_ENABLED=false\nDEEPSEEK_MODEL=local-model\n", "utf8");
    const config = await loadDeepSeekConfig({
      rootDir: root,
      processEnv: {
        DEEPSEEK_ENABLED: "true",
        DEEPSEEK_API_KEY: "deployed-secret",
        DEEPSEEK_MODEL: "deployed-model",
      },
    });
    expect(config).toMatchObject({ enabled: true, model: "deployed-model", apiKey: "deployed-secret" });
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
    const job = await createAdviceJob({ ...input(), requestId: "advice-disabled-fixture" }, { flags: { adviceEnabled: false }, config: { enabled: false, model: "deepseek-chat" }, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    expect(job.status).toBe("disabled");
    expect(job.deterministic.verdict).toBe("bad");
    expect((job as any).advice).toBeUndefined();
  });

  it("runs a valid provider response, caches it, and stores only hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-success-"));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "deepseek-call-success", model: "deepseek-v4-flash", usage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 2000, completion_tokens: 500, total_tokens: 3500, completion_tokens_details: { reasoning_tokens: 125 } }, choices: [{ message: { content: JSON.stringify(advice()) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret-fixture-key", apiUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, now: () => new Date("2026-08-24T00:59:00.000Z"), auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") };
    const first = await createAdviceJob(input(), options);
    const done = await waitForAdviceJob(first.requestId, options as never) as any;
    expect(done?.status).toBe("completed");
    expect(done?.advice?.recommendation.verdict).toBe("conditional");
    expect(done?.billing).toMatchObject({ providerCalls: 1, promptCacheHitTokens: 1000, promptCacheMissTokens: 2000, completionTokens: 500, reasoningTokens: 125, estimatedCostCny: 0.0053 });
    expect(done?.calls?.[0]).toMatchObject({ providerRequestId: "deepseek-call-success", status: "completed", startedAt: "2026-08-24T00:59:00.000Z", billing: { pricing: { pricingBand: { id: "off-peak" } } } });
    const second = await createAdviceJob({ ...input(), requestId: "advice-fixture-2" }, options);
    expect(second.status).toBe("completed");
    expect(calls).toBe(1);
    expect(second.billing).toMatchObject({ providerCalls: 0, estimatedCostCny: 0, cacheServed: true });
    const billing = await getAdviceBillingSummary({ auditRoot: path.join(root, "events") } as never);
    expect(billing.totals).toMatchObject({ providerCalls: 1, estimatedCostCny: 0.0053 });
    expect(billing.byPricingBand).toEqual([expect.objectContaining({ pricingBand: "off-peak", providerCalls: 1, estimatedCostCny: 0.0053 })]);
    expect(billing.calls[0]).toMatchObject({ callId: `${first.requestId}:1`, providerRequestId: "deepseek-call-success" });
    const auditFile = (await readdir(path.join(root, "events"))).find((file) => file.endsWith(".json"))!;
    const audit = JSON.parse(await readFile(path.join(root, "events", auditFile), "utf8"));
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
    const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ id: `invalid-${calls}`, model: "deepseek-v4-flash", usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36, completion_tokens: 10, total_tokens: 110 }, choices: [{ message: { content: "not-json" } }] }), { status: 200 }); };
    const first = await createAdviceJob({ ...input(), requestId: "advice-invalid-json-fixture", userGoal: "invalid-json-fixture" }, { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret", apiUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, now: () => new Date("2026-08-24T02:00:00.000Z"), auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    const done = await waitForAdviceJob(first.requestId, { timeoutMs: 2_000, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") } as never) as any;
    expect(done?.status).toBe("advice-unavailable");
    expect(done?.deterministic.verdict).toBe("bad");
    expect(calls).toBe(2);
    expect(done?.billing).toMatchObject({ providerCalls: 2, pricedCalls: 2, promptCacheHitTokens: 128, promptCacheMissTokens: 72 });
    expect(done?.calls?.every((call: { status: string }) => call.status === "failed")).toBe(true);
  });

  it("rejects a provider verdict that would downgrade bad", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g6-verdict-"));
    const unsafe = advice("recommended");
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(unsafe) } }] }), { status: 200 });
    const first = await createAdviceJob({ ...input(), requestId: "advice-unsafe-verdict", userGoal: "unsafe-verdict" }, { flags: { adviceEnabled: true }, config: { enabled: true, apiKey: "secret", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 }, fetchImpl, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") });
    const done = await waitForAdviceJob(first.requestId, { timeoutMs: 2_000, auditRoot: path.join(root, "events"), jobRoot: path.join(root, "jobs") } as never) as any;
    expect(done?.status).toBe("advice-unavailable");
    expect(done?.failureStage).toBe("validation");
    expect(done?.deterministic.verdict).toBe("bad");
  });
});
