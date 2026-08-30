// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountScenarioCompare } from "../src/lab/scenario-compare";
import { PlanStore } from "../src/plans/client-store";
import type { PlanChangeProposal } from "../src/plans/contracts";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { MemoryStorage, makePlan, makeWorkspaceApi } from "./helpers/workspace-ui";

const hash = (character: string) => character.repeat(64);
const scenarioId = "scenario-11111111-1111-4111-8111-111111111111";
const familyId = "family-11111111-1111-4111-8111-111111111111";

afterEach(() => { document.body.replaceChildren(); });

async function harness() {
  const plan = makePlan("plan-what-if-ui", "对比方案");
  const config = createEmptyBuildConfigV3(plan.id, plan.name, "2026-08-30T00:00:00.000Z");
  config.components.push({
    instanceId: "case-one", kind: "case", role: "case", state: "planned",
    identity: { status: "unresolved", userText: "generic case" }, source: "user",
  });
  config.requirementSpec = { requirementSpecId: "requirements-what-if", schemaVersion: "1.0.0", workloads: [], constraints: [] };
  plan.draft.config = config as never; plan.activeVersionId = "version-what-if-ui"; plan.draft.baseVersionId = plan.activeVersionId; plan.draftRevision = 2;
  const api = makeWorkspaceApi([plan]);
  const store = new PlanStore({ api, storage: new MemoryStorage(), debounceMs: 60_000 }); await store.initialize();
  return { api, store };
}

function scenarioView(config: BuildConfigV3) {
  const changed = structuredClone(config); changed.components[0]!.state = "ordered";
  const result = {
    schemaVersion: "1.0.0", createdAt: "2026-08-30T00:01:00.000Z", scenarioId,
    beforeConfigHash: hash("1"), afterConfigHash: hash("2"), patchHash: hash("3"),
    beforeEvaluationHash: hash("4"), afterEvaluationHash: hash("5"),
    decisionDiffRef: `sha256:${hash("6")}`, domainDiffRefs: [`sha256:${hash("7")}`], snapshotAttribution: "same_snapshots",
  } as const;
  return {
    family: { familyId, planId: config.id, name: "组件状态对比", basePlanVersionId: "version-what-if-ui" },
    branch: {
      scenarioId, familyId,
      patch: [{ op: "replace", selector: { collection: "components", id: "case-one", field: "state" }, value: "ordered" }],
    },
    config: changed,
    result,
  };
}

describe("U11 what-if comparison UI", () => {
  it("keeps the active plan unchanged until a separately reviewed ordinary proposal is approved", async () => {
    const { api, store } = await harness(); const storage = new MemoryStorage();
    const base = structuredClone(store.getState().activePlan!.draft.config) as unknown as BuildConfigV3;
    const operation = { op: "replace" as const, selector: { collection: "components" as const, id: "case-one", field: "state" }, value: "ordered" };
    const proposal: PlanChangeProposal<BuildConfigV3> = {
      schemaVersion: "1.0.0", id: `proposal-${scenarioId}`, planId: base.id, expectedDraftRevision: 2,
      expectedConfigHash: hash("1"), createdAt: "2026-08-30T00:01:00.000Z", summary: "采用情景：组件状态对比",
      rationale: ["尚未写入"], configSchemaVersion: "3.0.0", operations: [operation],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null }, status: "proposed",
    };
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (method === "POST" && url.endsWith("/scenario-families")) return new Response(JSON.stringify({ familyId }), { status: 201 });
      if (method === "POST" && url.endsWith("/scenarios")) return new Response(JSON.stringify({ scenarioId }), { status: 201 });
      if (method === "POST" && url.endsWith("/evaluate")) return new Response(JSON.stringify({
        artifactRef: `sha256:${hash("8")}`,
        artifact: { snapshotChangedFields: [], proposalOnly: true },
        result: scenarioView(base).result,
      }), { status: 200 });
      if (method === "GET" && url.endsWith(`/scenarios/${scenarioId}`)) return new Response(JSON.stringify(scenarioView(base)), { status: 200 });
      if (method === "POST" && url.endsWith("/proposal")) return new Response(JSON.stringify(proposal), { status: 200 });
      if (method === "POST" && url.endsWith("/proposals/validate")) return new Response(JSON.stringify({ proposal }), { status: 200 });
      if (method === "POST" && url.endsWith("/proposals/apply")) {
        const applied = structuredClone(api.plans[0]!); const config = applied.draft.config as unknown as BuildConfigV3;
        config.components[0]!.state = "ordered"; applied.draftRevision = 3; applied.draft.dirty = true;
        return new Response(JSON.stringify({ proposal: { ...proposal, status: "applied" }, plan: applied, audit: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const originalRandomUUID = crypto.randomUUID;
    let uuidCall = 0;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => (++uuidCall === 1 ? familyId.slice("family-".length) : scenarioId.slice("scenario-".length)) });
    const host = document.createElement("section"); document.body.append(host);
    const panel = mountScenarioCompare(host, { enabled: true, store, fetchImpl, storage });
    host.querySelector<HTMLSelectElement>('[name="scenarioState"]')!.value = "ordered";
    host.querySelector<HTMLFormElement>("[data-scenario-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("活动方案没有变化"));
    expect((store.getState().activePlan!.draft.config as unknown as BuildConfigV3).components[0]!.state).toBe("planned");
    expect(host.textContent).toContain("尚未写入方案");
    expect(host.textContent).toContain("事实与市场快照未刷新");
    const branchBody = requests.find(({ method, url }) => method === "POST" && url.endsWith("/scenarios"))!.body as Record<string, unknown>;
    expect(branchBody).toEqual({ scenarioId, familyId, patch: [operation] });
    expect(branchBody).not.toHaveProperty("config");

    host.querySelector<HTMLButtonElement>("[data-prepare-scenario-proposal]")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-apply-scenario-proposal]")).not.toBeNull());
    expect(host.textContent).toContain("仍未写入方案");
    host.querySelector<HTMLButtonElement>("[data-apply-scenario-proposal]")!.click();
    await vi.waitFor(() => expect((store.getState().activePlan!.draft.config as unknown as BuildConfigV3).components[0]!.state).toBe("ordered"));
    const apply = requests.find(({ url }) => url.endsWith("/proposals/apply"))!.body as Record<string, unknown>;
    expect(apply).toEqual(expect.objectContaining({ operationIndexes: [0], approvalConfirmed: true, approvedBy: "workspace-user" }));
    panel.dispose(); store.dispose();
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID });
  });

  it("restores a server-owned scenario by ID only after remount", async () => {
    const { store } = await harness(); const storage = new MemoryStorage(); storage.setItem("buildsim.what-if-scenario.plan-what-if-ui", scenarioId);
    const base = store.getState().activePlan!.draft.config as unknown as BuildConfigV3;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(scenarioView(base)), { status: 200 })) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const panel = mountScenarioCompare(host, { enabled: true, store, fetchImpl, storage });
    await vi.waitFor(() => expect(host.textContent).toContain("组件状态对比"));
    expect(fetchImpl).toHaveBeenCalledWith(`/api/workspace/plans/plan-what-if-ui/scenarios/${scenarioId}`, expect.any(Object));
    panel.dispose(); store.dispose();
  });
});
