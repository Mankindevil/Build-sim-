import { describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { authoritativeEvaluationPayload } from "../src/agent/evaluation-contract";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { handleAgentRoute } from "../src/server/agent-server";
import { evaluateBuildAuthoritatively, sha256AgentValue } from "../src/server/evaluation-service";

describe("A1 authoritative server evaluation", () => {
  it("hashes exactly the same BuildEvaluation payload the browser consumes", () => {
    const browserEvaluation = evaluateBuild(baseline as never, loadBundledCatalog());
    const serverEvaluation = evaluateBuildAuthoritatively(baseline);
    expect(serverEvaluation.evaluationHash).toBe(sha256AgentValue(authoritativeEvaluationPayload(browserEvaluation)));
    expect(serverEvaluation.evaluation).toEqual(browserEvaluation);
    expect(serverEvaluation.catalogVersion).toMatch(/^2\.0\.0:/);
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
});
