import { describe, expect, it, vi } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { authoritativeEvaluationPayload } from "../src/agent/evaluation-contract";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { handleAgentRoute } from "../src/server/agent-server";
import { evaluateBuildAuthoritatively, evaluateBuildDocumentAuthoritatively, sha256AgentValue } from "../src/server/evaluation-service";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { sha256Hex } from "../src/plans/canonical";

describe("A1 authoritative server evaluation", () => {
  it("hashes exactly the same BuildEvaluation payload the browser consumes", () => {
    const browserEvaluation = evaluateBuild(baseline as never, loadBundledCatalog());
    const serverEvaluation = evaluateBuildAuthoritatively(baseline);
    expect(serverEvaluation.evaluationHash).toBe(sha256AgentValue(authoritativeEvaluationPayload(browserEvaluation)));
    expect(serverEvaluation.evaluation).toEqual(browserEvaluation);
    expect(serverEvaluation.catalogVersion).toBe("2.0.0");
    expect(serverEvaluation.priceSnapshotVersion).toBe("1.0.0:2026-08-21");
  });

  it("rejects a malformed or unknown configuration before evaluation", () => {
    expect(() => evaluateBuildAuthoritatively({ ...baseline, selection: { ...baseline.selection, gpuId: "gpu.model-invented" } })).toThrow(/Unknown SKU|invalid/i);
    expect(() => evaluateBuildAuthoritatively({ selection: {} })).toThrow(/schema|Malformed/i);
  });

  it("serves the authoritative result through the HTTP route contract", () => {
    const response = handleAgentRoute("POST", "/api/agent/evaluate", { buildConfig: baseline });
    expect(response.status).toBe(200);
    const payload = response.payload as { evaluationHash: string; evaluation: { config: unknown } };
    expect(payload.evaluationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.evaluation.config).toEqual(baseline);
    expect(handleAgentRoute("GET", "/api/agent/health").status).toBe(200);
    expect(handleAgentRoute("GET", "/missing").status).toBe(404);
  });

  it("returns only topology BOM plus explicit unknown domains for BuildConfig V3", async () => {
    const config = createEmptyBuildConfigV3("plan-agent-eval-v3", "V3 partial", "2026-08-27T00:00:00.000Z");
    config.components = [{
      instanceId: "drive-user-mentioned-1",
      kind: "storage_drive",
      role: "data_disk",
      state: "planned",
      identity: { status: "unresolved", userText: "一块 8TB 硬盘，型号待确认" },
      source: "agent",
    }];
    const result = evaluateBuildDocumentAuthoritatively(config, loadBundledCatalog(), { topologyV3Enabled: true });
    expect(() => evaluateBuildDocumentAuthoritatively(config, loadBundledCatalog(), { topologyV3Enabled: false })).toThrow(/disabled|enable/i);
    expect(result.configHash).toBe(await configV3Hash(config));
    expect(result.evaluationHash).toBe(await sha256Hex(result.evaluation));
    expect(result.priceSnapshotVersion).toBeNull();
    expect(result.evaluation).toMatchObject({
      kind: "topology-v3-partial",
      configSchemaVersion: "3.0.0",
      topologyBom: [{ instanceId: "drive-user-mentioned-1", identityStatus: "unresolved", quantity: 1 }],
      unknownDomains: expect.arrayContaining(["compatibility", "geometry", "power", "price", "thermal"]),
    });
    expect(result.evaluation).not.toHaveProperty("price");
    expect(result.evaluation).not.toHaveProperty("findings");

    vi.stubEnv("BUILD_SIM_TOPOLOGY_V3_ENABLED", "true");
    try {
      expect(handleAgentRoute("POST", "/api/agent/evaluate", { buildConfig: config })).toMatchObject({
        status: 200,
        payload: { configHash: result.configHash, evaluation: { kind: "topology-v3-partial" } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
