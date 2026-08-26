import { describe, expect, it } from "vitest";
import { createPlanAgentContext, isPlanAgentContextStale, planAgentContextEnvelope } from "../src/agent/plan-context";
import { makePlan } from "./helpers/workspace-ui";
import { buildN6Evaluation } from "./helpers/spatial";
import { sha256Hex } from "../src/plans/canonical";
import { MemoryPlanAgentContextAuditStore, recordPlanAgentRunContext } from "../src/plans/agent-context-audit";
import type { PlanRepository } from "../src/plans/contracts";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

describe("R7 plan-bound Agent context", () => {
  it("binds plan/revision/evaluation, 3D, purchase and task facts in one validated envelope", async () => {
    const plan = makePlan("plan-context-12345678", "Context plan");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id;
    evaluation.config.name = plan.name;
    plan.draft.config = structuredClone(evaluation.config);
    const context = createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: null, draftRevision: plan.draftRevision, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "2026-08-25T00:00:00.000Z", evaluation },
      selection: { partId: "psu.primary", view: "spatial", findingId: "physical.psu-clearance" },
      spatialViewContext: { cameraMode: "perspective", targetMm: [0, 0, 0] },
      purchaseSummary: { knownCny: evaluation.price.knownCny },
      buildTaskSummary: { todo: 3 },
    });
    expect(context).toMatchObject({ planId: plan.id, draftRevision: plan.draftRevision, spatialSelection: { partId: "psu.primary" }, spatialViewContext: { cameraMode: "perspective" }, buildTaskSummary: { todo: 3 } });
    const envelope = planAgentContextEnvelope("检查 PSU", context);
    expect(envelope).toContain("<plan_agent_context");
    expect(envelope).toContain(context.evaluationHash);
    expect(envelope).toContain("get_build_evaluation");
    expect(envelope).not.toContain('"evaluation":');
    expect(envelope).not.toContain('"buildConfig":');
    expect(envelope.length).toBeLessThan(20_000);
    expect(envelope).not.toContain("approvalToken");
  });

  it("marks a session context stale when revision or evaluation changes", async () => {
    const plan = makePlan("plan-context-87654321", "Context plan");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id; evaluation.config.name = plan.name; plan.draft.config = evaluation.config;
    const base = createPlanAgentContext({ plan, snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: null, draftRevision: 0, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "now", evaluation }, selection: null, purchaseSummary: {}, buildTaskSummary: {} });
    expect(isPlanAgentContextStale(base, structuredClone(base))).toBe(false);
    expect(isPlanAgentContextStale(base, { ...base, draftRevision: 1 })).toBe(true);
  });

  it("marks pending Agent plans as rendering scaffolds and routes them to atomic initialization", async () => {
    const plan = makePlan("plan-context-init-12345678", "待 Agent 初始化方案");
    plan.metadata.initialization = { status: "pending", source: "agent" };
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id; evaluation.config.name = plan.name; plan.draft.config = evaluation.config;
    const context = createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: null, draftRevision: 0, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "2026-08-25T00:00:00.000Z", evaluation },
      selection: null,
      purchaseSummary: {},
      buildTaskSummary: {},
    });
    expect(context.initialization).toEqual({ status: "pending", source: "agent" });
    const envelope = planAgentContextEnvelope("我想配一台游戏主机", context);
    expect(envelope).toContain("internal rendering scaffold");
    expect(envelope).toContain("propose_plan_initialization");
    expect(envelope).not.toContain("Only propose changes through the structured propose_plan_change tool");
  });

  it("records the exact authoritative plan and evaluation hashes for every run", async () => {
    const plan = makePlan("plan-audit-12345678", "Audited plan");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id; evaluation.config.name = plan.name; plan.draft.config = evaluation.config;
    const context = createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: null, draftRevision: plan.draftRevision, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "now", evaluation },
      selection: { partId: "psu.primary", view: "spatial", findingId: "physical.psu-clearance" },
      purchaseSummary: { linked: 1 },
      buildTaskSummary: { todo: 2 },
    });
    const repository = { get: async () => plan } as unknown as PlanRepository;
    const store = new MemoryPlanAgentContextAuditStore();
    const record = await recordPlanAgentRunContext(repository, store, { sessionId: "session-audit", runId: "run-audit", context }, () => "2026-08-25T02:00:00.000Z");
    expect(record).toMatchObject({ planId: plan.id, draftRevision: plan.draftRevision, configHash: context.configHash, evaluationHash: context.evaluationHash, spatialSelection: { partId: "psu.primary" } });
    expect(await store.get("run-audit")).toEqual(record);
    await expect(handleWorkspaceRoute("POST", "/api/workspace/agent-context", { sessionId: "session-route", runId: "run-route", context }, repository, { agentContextAuditStore: store })).resolves.toMatchObject({ status: 201, payload: { runId: "run-route", evaluationHash: context.evaluationHash } });
    await expect(handleWorkspaceRoute("GET", "/api/workspace/agent-context/run-route", {}, repository, { agentContextAuditStore: store })).resolves.toMatchObject({ status: 200, payload: { runId: "run-route", planId: plan.id } });
    await expect(recordPlanAgentRunContext(repository, store, { sessionId: "session-stale", runId: "run-stale", context: { ...context, draftRevision: context.draftRevision + 1 } })).rejects.toThrow(/stale_revision/);
  });
});
