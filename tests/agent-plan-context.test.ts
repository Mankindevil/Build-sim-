import { describe, expect, it } from "vitest";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlanAgentContext, isPlanAgentContextStale, planAgentContextEnvelope } from "../src/agent/plan-context";
import { makePlan } from "./helpers/workspace-ui";
import { buildN6Evaluation } from "./helpers/spatial";
import { sha256Hex } from "../src/plans/canonical";
import { hashPlanConfig } from "../src/plans/canonical";
import { FilePlanAgentContextAuditStore, MemoryPlanAgentContextAuditStore, recordPlanAgentRunContext, type PlanAgentRunContextAudit } from "../src/plans/agent-context-audit";
import type { BuildPlan, PlanAgentContext, PlanRepository } from "../src/plans/contracts";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { createPlanPartialEvaluationV3 } from "../src/plans/evaluation";
import type { BuildConfigDocument } from "../src/config/types";
import { agentRunIdForIdempotency } from "../src/agent/run-identity";
import { validatePlanAgentRunContextAuditRuntime } from "../src/plans/agent-context-audit-runtime.mjs";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createProductionWorkspaceAgentContextAuthority } from "../src/server/workspace-server";

describe("R7 plan-bound Agent context", () => {
  it("binds plan/revision/evaluation, 3D, purchase and task facts in one validated envelope", async () => {
    const plan = makePlan("plan-context-12345678", "Context plan");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id;
    evaluation.config.name = plan.name;
    plan.draft.config = structuredClone(evaluation.config);
    const context = await createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: plan.activeVersionId, draftRevision: plan.draftRevision, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "2026-08-25T00:00:00.000Z", evaluation },
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
    const base = await createPlanAgentContext({ plan, snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: plan.activeVersionId, draftRevision: 0, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "now", evaluation }, selection: null, purchaseSummary: {}, buildTaskSummary: {} });
    expect(isPlanAgentContextStale(base, structuredClone(base))).toBe(false);
    expect(isPlanAgentContextStale(base, { ...base, draftRevision: 1 })).toBe(true);
  });

  it("treats legacy pending Agent metadata as an ordinary progressive plan", async () => {
    const plan = makePlan("plan-context-init-12345678", "待 Agent 初始化方案");
    plan.metadata.initialization = { status: "pending", source: "agent" };
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id; evaluation.config.name = plan.name; plan.draft.config = evaluation.config;
    const context = await createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: plan.activeVersionId, draftRevision: 0, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "2026-08-25T00:00:00.000Z", evaluation },
      selection: null,
      purchaseSummary: {},
      buildTaskSummary: {},
    });
    expect(context.initialization).toEqual({ status: "pending", source: "agent" });
    const envelope = planAgentContextEnvelope("我想配一台游戏主机", context);
    expect(envelope).toContain("blank, partial, and legacy pending plans identically");
    expect(envelope).toContain("propose_plan_change");
    expect(envelope).not.toContain("propose_plan_initialization");
    expect(envelope).toContain("Never autofill missing hardware");
  });

  it("records the exact authoritative plan and evaluation hashes for every run", async () => {
    const plan = makePlan("plan-audit-12345678", "Audited plan");
    const { evaluation } = buildN6Evaluation();
    evaluation.config.id = plan.id; evaluation.config.name = plan.name; plan.draft.config = evaluation.config;
    const context = await createPlanAgentContext({
      plan,
      snapshot: { schemaVersion: "1.0.0", planId: plan.id, planVersionId: plan.activeVersionId, draftRevision: plan.draftRevision, configHash: await sha256Hex(evaluation.config), evaluationHash: await sha256Hex(evaluation), evaluatedAt: "now", evaluation },
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
    const forgedBrowserContext = structuredClone(context) as PlanAgentContext;
    (forgedBrowserContext as unknown as {
      evidenceSummary: { count: number; bindings: []; resolutions: unknown[]; inferences: unknown[] };
    }).evidenceSummary = {
      count: 0,
      bindings: [],
      resolutions: [{ rawExcerpt: "browser-forged-official-evidence" }],
      inferences: [{ value: 9_999, formula: "browser controlled" }],
    };
    const derived = await handleWorkspaceRoute("POST", "/api/workspace/agent-context", {
      sessionId: "session-route",
      runId: "run-derived-summary",
      context: forgedBrowserContext,
    }, repository, {
      agentContextAuditStore: store,
      planResolutionSummary: {
        forPlan: async (planId) => ({
          schemaVersion: "workspace-plan-resolution-summary-v1",
          planId,
          runtimeGeneration: 7,
          resolutions: [],
          inferences: [],
          claimScopeCount: 0,
          claimScopes: [],
          price: null,
        }),
      },
    });
    expect(derived).toMatchObject({ status: 201, payload: { context: { evidenceSummary: { resolutions: [], inferences: [] } } } });
    const derivedPayload = derived.payload as { context: PlanAgentContext; contextHash: string };
    expect(derivedPayload.contextHash).toBe(await sha256Hex(derivedPayload.context));
    expect(await store.get("run-derived-summary")).toMatchObject({ contextHash: derivedPayload.contextHash });
    await expect(recordPlanAgentRunContext(repository, store, { sessionId: "session-stale", runId: "run-stale", context: { ...context, draftRevision: context.draftRevision + 1 } })).rejects.toThrow(/stale_revision/);

    const idempotencyKey = "context-preflight-fixture";
    await expect(handleWorkspaceRoute("POST", "/api/workspace/agent-context", { sessionId: "session-route", idempotencyKey, context }, repository, { agentContextAuditStore: store })).resolves.toMatchObject({
      status: 201,
      payload: { runId: agentRunIdForIdempotency("session-route", idempotencyKey), planId: plan.id },
    });
  });

  it("binds a V3 partial evaluation to the active draft and rejects stale domain authority", async () => {
    const legacy = makePlan("plan-context-v3-12345678", "V3 context");
    const config = createEmptyBuildConfigV3(legacy.id, legacy.name, "2026-08-27T00:00:00.000Z");
    config.components = [{
      instanceId: "disk-v3-1", kind: "storage_drive", role: "data", state: "planned",
      identity: { status: "unresolved", userText: "用户提到的硬盘" }, source: "agent",
    }];
    const plan = { ...legacy, draft: { ...legacy.draft, config } } as BuildPlan<BuildConfigDocument>;
    const evaluation = createPlanPartialEvaluationV3(config);
    const snapshot = {
      schemaVersion: "1.0.0" as const,
      planId: plan.id,
      planVersionId: plan.activeVersionId,
      draftRevision: plan.draftRevision,
      configHash: await hashPlanConfig(config),
      evaluationHash: await sha256Hex(evaluation),
      evaluatedAt: "2026-08-27T00:00:00.000Z",
      evaluation,
    };
    const context = await createPlanAgentContext({ plan, snapshot, selection: null, purchaseSummary: { price: { status: "unknown" } }, buildTaskSummary: {} });
    expect(context.buildConfig).toEqual(config);
    expect(context.evaluation).toMatchObject({ kind: "topology-v3-partial", topologyBom: [{ instanceId: "disk-v3-1" }] });
    await expect(createPlanAgentContext({ plan, snapshot: { ...snapshot, configHash: "f".repeat(64) }, selection: null, purchaseSummary: {}, buildTaskSummary: {} })).rejects.toThrow(/domain hash is stale/);
    await expect(createPlanAgentContext({ plan, snapshot: { ...snapshot, draftRevision: plan.draftRevision + 1 }, selection: null, purchaseSummary: {}, buildTaskSummary: {} })).rejects.toThrow(/revision is stale/);

    const repository = { get: async () => plan } as unknown as PlanRepository;
    const store = new MemoryPlanAgentContextAuditStore();
    await expect(recordPlanAgentRunContext(repository, store, { sessionId: "session-v3", runId: "run-v3-valid", context })).resolves.toMatchObject({ configHash: snapshot.configHash, evaluationHash: snapshot.evaluationHash });
    const forgedEvaluation = { ...evaluation, topologyBom: [] };
    await expect(recordPlanAgentRunContext(repository, store, {
      sessionId: "session-v3",
      runId: "run-v3-forged",
      context: { ...context, evaluation: forgedEvaluation, evaluationHash: await sha256Hex(forgedEvaluation) },
    })).rejects.toThrow(/stale_v3_evaluation/);
  });

  it("stores plan Agent context audit in the active runtime generation", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plan-agent-audit-"));
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    await coordinator.initialize();
    const store = new FilePlanAgentContextAuditStore({ coordinator });
    const record: PlanAgentRunContextAudit = {
      schemaVersion: "1.0.0",
      sessionId: "session-runtime",
      runId: "run-runtime",
      planId: "plan-runtime",
      planVersionId: null,
      draftRevision: 0,
      configHash: "a".repeat(64),
      evaluationHash: "b".repeat(64),
      spatialSelection: null,
      contextHash: "c".repeat(64),
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await expect(store.put(record)).rejects.toThrow(/must be issued by recordPlanAgentRunContext/);
    const lease = await coordinator.acquireMaintenanceLease("test-plan-agent-context-import");
    await store.putWithMaintenanceLease(record, lease.token);
    await expect(store.get(record.runId)).resolves.toEqual(record);
    await expect(store.putWithMaintenanceLease({ ...record, contextHash: "d".repeat(64) }, lease.token)).rejects.toThrow(/run id conflict/);

    const staging = await coordinator.createStagingGeneration(lease.token);
    await coordinator.activateStagingGeneration(staging, 1, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    await expect(store.get(record.runId)).resolves.toBeNull();
  });

  it("serializes a same-content generation switch around server-derived summary and audit persistence", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plan-agent-root-bound-"));
    const now = () => "2026-08-28T09:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
    await coordinator.initialize();
    const repository = new FilePlanRepository({
      coordinator,
      now,
      id: () => "plan-root-bound-context",
    });
    const source = buildN6Evaluation().evaluation;
    const plan = await repository.create({ name: "Root-bound context", config: source.config });
    const evaluation = { ...source, config: structuredClone(plan.draft.config) };
    const context = await createPlanAgentContext({
      plan,
      snapshot: {
        schemaVersion: "1.0.0",
        planId: plan.id,
        planVersionId: plan.activeVersionId,
        draftRevision: plan.draftRevision,
        configHash: await hashPlanConfig(plan.draft.config),
        evaluationHash: await sha256Hex(evaluation),
        evaluatedAt: now(),
        evaluation,
      },
      selection: null,
      purchaseSummary: {},
      buildTaskSummary: {},
    });
    const store = new FilePlanAgentContextAuditStore({ coordinator });

    const initialState = await coordinator.readState();
    const initialRoot = coordinator.activeRoot(initialState);
    const stagingLease = await coordinator.acquireMaintenanceLease("plan-context-staging");
    const staging = await coordinator.createStagingGeneration(stagingLease.token);
    await cp(path.join(initialRoot, "plans", plan.id), path.join(staging, "plans", plan.id), { recursive: true });
    await coordinator.releaseMaintenanceLease(stagingLease.token);

    let enteredSummary!: () => void;
    const summaryEntered = new Promise<void>((resolve) => { enteredSummary = resolve; });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let observedGeneration = 0;
    const authority = createProductionWorkspaceAgentContextAuthority({
      coordinator,
      repository,
      auditStore: store,
      planResolutionSummary: {
        initialize: async () => undefined,
        forPlan: async () => { throw new Error("root-bound production path required"); },
        forPlanAtRoot: async (_activeRoot, runtimeGeneration, planId) => {
          observedGeneration = runtimeGeneration;
          enteredSummary();
          await summaryGate;
          return {
            schemaVersion: "workspace-plan-resolution-summary-v1",
            planId,
            runtimeGeneration,
            resolutions: [],
            inferences: [],
            claimScopeCount: 0,
            claimScopes: [],
            price: null,
          };
        },
      },
      now,
    });
    const route = handleWorkspaceRoute("POST", "/api/workspace/agent-context", {
      sessionId: "session-root-bound",
      runId: "run-root-bound",
      context,
    }, repository, { agentContextAuditStore: store, agentContextAuthority: authority });
    await summaryEntered;

    let switched = false;
    const generationSwitch = (async () => {
      const lease = await coordinator.acquireMaintenanceLease("plan-context-switch");
      await coordinator.activateStagingGeneration(staging, initialState.runtimeGeneration, lease.token);
      await coordinator.releaseMaintenanceLease(lease.token);
      switched = true;
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(switched).toBe(false);
    releaseSummary();

    await expect(route).resolves.toMatchObject({
      status: 201,
      payload: { runId: "run-root-bound", context: { evidenceSummary: { resolutions: [], inferences: [] } } },
    });
    expect(observedGeneration).toBe(initialState.runtimeGeneration);
    await generationSwitch;
    expect((await coordinator.readState()).runtimeGeneration).toBe(initialState.runtimeGeneration + 1);
    // The completed old-generation record is not allowed to appear in the
    // newly activated generation; summary and audit never straddle roots.
    await expect(store.get("run-root-bound")).resolves.toBeNull();
  });

  it("validates persisted context audit fields totally in both TypeScript and production runtime paths", () => {
    const record: PlanAgentRunContextAudit = {
      schemaVersion: "1.0.0",
      sessionId: "session-runtime",
      runId: "run-runtime",
      planId: "plan-runtime",
      planVersionId: null,
      draftRevision: 0,
      configHash: "a".repeat(64),
      evaluationHash: "b".repeat(64),
      spatialSelection: { partId: "psu.primary", view: "spatial", findingId: "physical.psu-clearance" },
      contextHash: "c".repeat(64),
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(validatePlanAgentRunContextAuditRuntime(record)).toEqual([]);
    expect(validatePlanAgentRunContextAuditRuntime({ ...record, browserAuthority: true })).toContain("plan Agent context audit fields invalid");
    expect(validatePlanAgentRunContextAuditRuntime({ ...record, recordedAt: "not-an-iso-time" })).toContain("plan Agent context audit timestamp invalid");
    expect(validatePlanAgentRunContextAuditRuntime({ ...record, spatialSelection: { ...record.spatialSelection, view: "bad\ud800" } }))
      .toContain("plan Agent context audit spatial selection invalid");
  });
});
