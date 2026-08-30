// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mountRequirementsPanel } from "../src/lab/requirements-panel";
import { PlanStore } from "../src/plans/client-store";
import { validateRequirementSpec } from "../src/requirements/contracts";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { MemoryStorage, makePlan, makeWorkspaceApi } from "./helpers/workspace-ui";

afterEach(() => { document.body.replaceChildren(); });

async function harness() {
  const plan = makePlan("plan-requirements-ui", "需求方案");
  const config = createEmptyBuildConfigV3(plan.id, plan.name, "2026-08-30T00:00:00.000Z");
  plan.draft.config = config as never;
  plan.activeVersionId = "version-requirements-ui";
  plan.draft.baseVersionId = plan.activeVersionId;
  const api = makeWorkspaceApi([plan]);
  const store = new PlanStore({ api, storage: new MemoryStorage(), debounceMs: 60_000 });
  await store.initialize();
  const host = document.createElement("section"); document.body.append(host);
  const controller = mountRequirementsPanel(host, store);
  return { host, store, controller };
}

describe("U11 progressive requirements UI", () => {
  it("persists skippable confirmed/pending requirements without adding hidden hardware", async () => {
    const { host, store, controller } = await harness();
    const form = host.querySelector<HTMLFormElement>("[data-requirements-form]")!;
    form.querySelector<HTMLSelectElement>('[name="machineIntent"]')!.value = "nas";
    form.querySelector<HTMLSelectElement>('[name="workloadState"]')!.value = "answered";
    form.querySelector<HTMLInputElement>('[name="workloadName"]')!.value = "家庭照片与备份";
    form.querySelector<HTMLSelectElement>('[name="budgetState"]')!.value = "answered";
    form.querySelector<HTMLInputElement>('[name="budgetTarget"]')!.value = "10000";
    form.querySelector<HTMLInputElement>('[name="budgetHardCap"]')!.value = "12000";
    form.querySelector<HTMLSelectElement>('[name="horizonState"]')!.value = "deferred";

    const capacity = form.querySelector<HTMLElement>('[data-requirement-metric="storage.usable_capacity"]')!;
    capacity.querySelector<HTMLSelectElement>('[name="metricState"]')!.value = "answered";
    capacity.querySelector<HTMLInputElement>('[name="metricValue"]')!.value = "16";
    capacity.querySelector<HTMLSelectElement>('[name="metricPriority"]')!.value = "must";
    capacity.querySelector<HTMLInputElement>('[name="metricConfirmed"]')!.checked = false;

    const network = form.querySelector<HTMLElement>('[data-requirement-metric="network.throughput"]')!;
    network.querySelector<HTMLSelectElement>('[name="metricState"]')!.value = "not_applicable";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const current = store.getState().activePlan!.draft.config as unknown as ReturnType<typeof createEmptyBuildConfigV3>;
    expect(current.intent).toEqual({ state: "answered", value: "nas", source: "user", confirmedByUser: true });
    expect(current.components).toEqual([]);
    expect(current.placements).toEqual([]);
    expect(current.connections).toEqual([]);
    expect(validateRequirementSpec(current.requirementSpec)).toEqual([]);
    expect(current.requirementSpec?.budget).toEqual(expect.objectContaining({
      state: "answered", value: { targetCny: 10000, hardCapCny: 12000 }, confirmedByUser: true,
    }));
    expect(current.requirementSpec?.horizonYears).toEqual({ state: "deferred", source: "user", confirmedByUser: true });
    const workload = current.requirementSpec?.workloads.find(({ workloadId }) => workloadId === "guided-whole-build-goals");
    expect(workload).toEqual(expect.objectContaining({ state: "answered", name: "家庭照片与备份" }));
    expect(workload?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricId: "storage.usable_capacity", priority: "must", confirmedByUser: false }),
      { metricId: "network.throughput", state: "not_applicable", source: "user", confirmedByUser: true },
    ]));
    expect(host.textContent).toContain("没有添加硬件");
    controller.dispose(); store.dispose();
  });

  it("shows hard/soft and confirmed/pending states for fine-grained constraints", async () => {
    const { host, store, controller } = await harness();
    const config = structuredClone(store.getState().activePlan!.draft.config) as unknown as ReturnType<typeof createEmptyBuildConfigV3>;
    config.requirementSpec = {
      requirementSpecId: "requirements-visible", schemaVersion: "1.0.0", workloads: [],
      constraints: [{
        constraintId: "small-case", state: "answered", predicate: { facetId: "case.side_panel", operator: "eq", value: "solid" },
        strength: "hard", source: "agent_proposed", confirmedByUser: false,
      }, {
        constraintId: "quiet-preference", state: "answered", predicate: { facetId: "acoustic.noise_class", operator: "eq", value: "quiet" },
        strength: "soft", source: "user", confirmedByUser: true,
      }],
    };
    store.replaceDraft(config as never);
    expect(host.textContent).toContain("硬目标 · 待确认");
    expect(host.textContent).toContain("偏好 · 已确认");
    controller.dispose(); store.dispose();
  });
});
