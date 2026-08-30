// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanStoreState } from "../src/plans/client-store";
import { mountSolverPanel } from "../src/lab/solver-panel";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const jobId = `job-${"a".repeat(64)}`;
const hash = (character: string) => character.repeat(64);

function planState(): PlanStoreState {
  const config = createEmptyBuildConfigV3("plan-solver-ui", "求解方案", "2026-08-30T00:00:00.000Z");
  config.requirementSpec = { requirementSpecId: "requirements-solver-ui", schemaVersion: "1.0.0", workloads: [], constraints: [] };
  config.components.push({
    instanceId: "case-ordered", kind: "case", role: "case", state: "ordered",
    identity: { status: "unresolved", userText: "case" }, source: "user",
  }, {
    instanceId: "cpu-planned", kind: "cpu", role: "cpu", state: "planned",
    identity: { status: "unresolved", userText: "cpu" }, source: "user",
  });
  return {
    initialized: true, plans: [],
    activePlan: {
      schemaVersion: "3.0.0", id: config.id, name: config.name, status: "active",
      createdAt: config.updatedAt, updatedAt: config.updatedAt, activeVersionId: "version-solver-ui", draftRevision: 2,
      draft: { schemaVersion: "3.0.0", baseVersionId: "version-solver-ui", config, dirty: false, updatedAt: config.updatedAt }, metadata: {},
    } as never,
    evaluation: null, evaluationSnapshot: null, saveStatus: "clean", selection: null, offline: false,
    localRevision: 0, error: null, canUndo: false, canRedo: false,
  };
}

function status() {
  return {
    job: {
      jobId, planId: "plan-solver-ui", status: "waiting_user", revision: 4, attempt: 1, maxAttempts: 3,
      progress: { stage: "waiting_candidate_approval", completed: 8, total: 8 },
    },
    result: {
      result: {
        status: "feasible_partial", solverVersion: "solver-v1", seed: hash("1"),
        effectiveLimits: { maxEvaluations: 32, maxDurationMs: 10000, maxCandidatesPerRequirement: 6 },
        explored: 8, pruned: 3, searchSummaryRef: `sha256:${hash("2")}`, unexploredRanges: [{ start: 8, end: 11 }],
        unsatisfiedHardConstraintIds: ["hard-storage"], irreducibleConflictSets: [],
        candidates: [{
          candidateId: "candidate-balanced", requirementSpecId: "requirements-solver-ui", basePlanVersionId: "version-solver-ui",
          baseConfigHash: hash("3"), candidateConfigRef: `sha256:${hash("4")}`, operationsRef: `sha256:${hash("5")}`,
          buildConfigHash: hash("6"), inputHashes: {}, evaluationHash: hash("7"), candidateKind: "feasibility_candidate",
          domainCoverage: [
            { domain: "identity", verdict: "pass", domainHash: hash("8"), evaluationHash: hash("7"), requiredForPurchase: true },
            { domain: "thermal", verdict: "blocked", domainHash: hash("9"), evaluationHash: hash("7"), requiredForPurchase: true },
          ],
          residualRequirementIds: ["thermal-input"], excludedReasonIds: ["thermal-blocked"],
        }],
      },
    },
  };
}

afterEach(() => { document.body.replaceChildren(); });

describe("U11 whole-build solver UI", () => {
  it("submits only saved-version authority, restores status, and routes candidate review through Agent", async () => {
    const state = planState(); const storage = new MemoryStorage(); const prompts: string[] = [];
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST" && url.endsWith("/solver-jobs")) return new Response(JSON.stringify({ job: { jobId, planId: "plan-solver-ui", status: "queued", revision: 0 } }), { status: 202 });
      return new Response(JSON.stringify(status()), { status: 200 });
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const panel = mountSolverPanel(host, {
      enabled: true, getState: () => structuredClone(state), subscribe: () => () => undefined,
      fetchImpl, storage, openAgent: (prompt) => prompts.push(prompt),
    });
    host.querySelector<HTMLFormElement>("[data-solver-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-solver-candidate='candidate-balanced']")).not.toBeNull());
    const enqueue = requests.find(({ method, url }) => method === "POST" && url.endsWith("/solver-jobs"))!;
    expect(enqueue.body).toEqual({
      basePlanVersionId: "version-solver-ui", lockedInstanceIds: ["case-ordered"], requirementSpecId: "requirements-solver-ui",
      limits: { maxEvaluations: 32, maxDurationMs: 10000, maxCandidatesPerRequirement: 6 },
    });
    expect(JSON.stringify(enqueue.body)).not.toContain("config");
    expect(host.textContent).toContain("partial");
    expect(host.textContent).toContain("Requirement coverage");
    expect(host.textContent).toContain("当前不可进入采购推荐");
    host.querySelector<HTMLButtonElement>("[data-review-solver-candidate]")!.click();
    expect(prompts[0]).toContain(jobId);
    expect(prompts[0]).toContain("candidate-balanced");
    panel.dispose();

    const restoredHost = document.createElement("section"); document.body.append(restoredHost);
    const restored = mountSolverPanel(restoredHost, { enabled: true, getState: () => structuredClone(state), subscribe: () => () => undefined, fetchImpl, storage });
    await vi.waitFor(() => expect(restoredHost.querySelector("[data-solver-candidate='candidate-balanced']")).not.toBeNull());
    expect(requests.some(({ method, url }) => method === "GET" && url.endsWith(`/solver-jobs/${jobId}`))).toBe(true);
    restored.dispose();
  });

  it("is absent when the production capability is disabled", () => {
    const host = document.createElement("section"); const fetchImpl = vi.fn();
    mountSolverPanel(host, { enabled: false, getState: planState, subscribe: () => () => undefined, fetchImpl: fetchImpl as typeof fetch });
    expect(host.hidden).toBe(true); expect(host.childElementCount).toBe(0); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
