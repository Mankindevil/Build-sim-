import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime";
import type { ProviderAdapter } from "../src/agent/contracts";
import { createPlanAgentContext, planAgentContextEnvelope } from "../src/agent/plan-context";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import type { BuildConfigDocument } from "../src/config/types";
import type { EvidenceClaim, EvidenceClaimScope } from "../src/evidence/contracts";
import type { BuildPlan, PlanAgentContext } from "../src/plans/contracts";
import { sha256Hex } from "../src/plans/canonical";
import { withServerDerivedPlanResolution } from "../src/server/workspace-routes";
import { ProductionPlanClaimScopeSummary } from "../src/server/plan-resolution-summary";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { buildN6Evaluation } from "./helpers/spatial";
import { makePlan } from "./helpers/workspace-ui";

const digest = (letter: string): string => letter.repeat(64);

function claim(letter: string, scope: EvidenceClaimScope, skuId = "cpu.selected", status: EvidenceClaim["status"] = "active"): EvidenceClaim {
  const hash = digest(letter);
  return {
    schemaVersion: "evidence-claim-v1",
    claimId: `claim-sha256-${hash}`,
    subject: {
      skuId,
      familyId: "cpu.family",
      modelId: "cpu.model",
      variantId: "cpu.variant",
      revision: "B0",
      region: "CN",
    },
    scope,
    fieldId: scope === "family" ? "cpu.socket" : "power.load",
    value: scope === "family" ? "LGA1700" : 154,
    ...(scope === "revision" ? { unit: "W" } : {}),
    authority: "official",
    source: {
      documentId: `doc-sha256-${digest("d")}`,
      documentSha256: digest("d"),
      captureId: `capture-sha256-${digest("e")}`,
      locator: { field: "fixture" },
    },
    retrievedAt: "2026-08-30T00:00:00.000Z",
    status,
    contentHash: hash,
  };
}

describe("U12 Agent claim scope canary", () => {
  it("projects only active claims for selected plan products and preserves family versus exact revision scope", async () => {
    const config = createEmptyBuildConfigV3("plan-scope", "Claim scope", "2026-08-30T00:00:00.000Z");
    config.components.push({
      instanceId: "cpu-1",
      kind: "cpu",
      role: "processor",
      state: "planned",
      identity: { status: "resolved", skuId: "cpu.selected", identityClaimIds: [] },
      source: "user",
    });
    const legacy = makePlan(config.id, config.name);
    const plan = { ...legacy, draft: { ...legacy.draft, config } } as BuildPlan<BuildConfigDocument>;
    const authority = new ProductionPlanClaimScopeSummary({
      plans: { getAtRoot: async () => structuredClone(plan) },
      claims: { listClaimsAtRoot: async () => {
        const replaced = claim("g", "model");
        const replacement = {
          ...claim("h", "model"),
          supersedesClaimId: replaced.claimId,
          supersededClaimHash: replaced.contentHash,
        } satisfies EvidenceClaim;
        return [
          claim("a", "family"),
          claim("b", "revision"),
          claim("c", "revision", "cpu.other"),
          claim("f", "revision", "cpu.selected", "superseded"),
          replaced,
          replacement,
        ];
      } },
    });

    const summary = await authority.forPlanAtRoot("/runtime/generations/1", plan.id);
    expect(summary).toMatchObject({
      count: 3,
      claims: [
        { claimId: `claim-sha256-${digest("a")}`, scope: "family", subject: { skuId: "cpu.selected" } },
        { claimId: `claim-sha256-${digest("b")}`, scope: "revision", subject: { revision: "B0" } },
        { claimId: `claim-sha256-${digest("h")}`, scope: "model", subject: { modelId: "cpu.model" } },
      ],
    });
  });

  it("adds a deterministic claim-scope section even when the provider omits it", async () => {
    const plan = makePlan("plan-agent-scope", "Agent claim scope");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id;
    evaluation.config.name = plan.name;
    plan.draft.config = structuredClone(evaluation.config);
    const base = await createPlanAgentContext({
      plan,
      snapshot: {
        schemaVersion: "1.0.0",
        planId: plan.id,
        planVersionId: plan.activeVersionId,
        draftRevision: plan.draftRevision,
        configHash: await sha256Hex(evaluation.config),
        evaluationHash: await sha256Hex(evaluation),
        evaluatedAt: "2026-08-30T00:00:00.000Z",
        evaluation,
      },
      selection: null,
      purchaseSummary: {},
      buildTaskSummary: {},
    });
    const family = claim("a", "family");
    const revision = claim("b", "revision");
    const context = withServerDerivedPlanResolution(base, {
      resolutions: [],
      inferences: [],
      claimScopeCount: 2,
      claimScopes: [family, revision].map(({ claimId, contentHash, authority, fieldId, scope, subject }) => ({
        schemaVersion: "plan-evidence-claim-scope-v1" as const,
        claimId,
        contentHash,
        authority,
        fieldId,
        scope,
        subject,
      })),
      price: null,
    });
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{
        provider: "deepseek", id: "fixture", label: "fixture",
        capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true },
      }],
      async createTurn(request) {
        expect(request.system).toContain("family is never an exact model");
        return {
          provider: "deepseek", providerRequestId: "scope-answer", model: request.model,
          content: [
            "证据阶梯：以受控摘要为准。",
            "官网未找到原因：unknown。",
            "第三方证据：unknown。",
            "可重放推断：unknown。",
            "下一步补证：按范围复核。",
          ].join("\n"),
          toolCalls: [], stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          latencyMs: 1,
        };
      },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore());
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, {
      content: planAgentContextEnvelope("说明 claim 适用范围", context),
      buildConfig: context.buildConfig,
    });
    await runtime.waitForRun(run.runId);
    const completed = await runtime.getSession(session.id);
    const answer = completed.messages.at(-1)?.content ?? "";
    expect(answer).toContain("### Claim 适用范围");
    expect(answer).toContain("family（家族范围，不代表精确型号/变体/修订）");
    expect(answer).toContain("revision（精确修订范围）");
    expect(answer).toContain(`claim-sha256-${digest("a")}`);
    expect(answer).toContain(`claim-sha256-${digest("b")}`);
  });

  it("rejects browser-forged claim scope content addresses before audit persistence", async () => {
    const context = {
      evidenceSummary: {
        count: 0,
        bindings: [],
        claimScopeCount: 1,
        claimScopes: [{
          schemaVersion: "plan-evidence-claim-scope-v1",
          claimId: `claim-sha256-${digest("a")}`,
          contentHash: digest("b"),
          authority: "official",
          fieldId: "power.load",
          scope: "revision",
          subject: { skuId: "cpu.selected", familyId: "cpu.family", revision: "B0" },
        }],
      },
    } as unknown as PlanAgentContext;
    const { validatePlanAgentContext } = await import("../src/plans/validation");
    expect(validatePlanAgentContext(context)).toContain("evidenceSummary.claimScopes.0 identity invalid");
  });
});
