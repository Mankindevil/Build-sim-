// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, makePlan, mountWorkspaceDom } from "./helpers/workspace-ui";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { BuildConfigDocument } from "../src/config/types";
import type { BuildPlan } from "../src/plans/contracts";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import type { BuildTaskStore } from "../src/plans/build-task-store";
import type { BuildProgressController } from "../src/lab/build-progress";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { authoritativeEvaluationHash } from "../src/plans/evaluation";
import {
  progressiveInput,
  progressivePriceSnapshot,
  resolvedComponent,
} from "./helpers/progressive-evaluation-fixture";
import { createProductionSimulationInput } from "../src/simulation/production";

describe("R3 workspace dashboard", () => {
  it("persists an explicit standard workload and ambient range into the V3 SimulationInput", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const config = createEmptyBuildConfigV3("plan-12345678", "Thermal inputs", "2026-08-29T00:00:00.000Z");
    const accepted = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    accepted.name = config.name;
    accepted.draft.config = config;
    accepted.draftRevision += 1;
    store.acceptServerPlan(accepted);
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    router.navigate("editor");
    expect(root.querySelector<HTMLInputElement>("[data-v3-ambient-min]")?.value).toBe("20");
    expect(root.querySelector<HTMLInputElement>("[data-v3-ambient-max]")?.value).toBe("30");
    root.querySelector<HTMLSelectElement>("[data-v3-thermal-scenario]")!.value = "nas-scrub";
    root.querySelector<HTMLInputElement>("[data-v3-ambient-min]")!.value = "22";
    root.querySelector<HTMLInputElement>("[data-v3-ambient-max]")!.value = "28";
    root.querySelector<HTMLButtonElement>("[data-v3-thermal-apply]")!.click();

    const updated = store.getState().activePlan!.draft.config as BuildConfigDocument;
    expect(updated).toMatchObject({
      schemaVersion: "3.0.0",
      requirementSpec: {
        workloads: [{ metrics: expect.arrayContaining([
          expect.objectContaining({ metricId: "thermal.scenario", value: "nas-scrub", confirmedByUser: true }),
          expect.objectContaining({ metricId: "thermal.ambient", value: [22, 28], confirmedByUser: true }),
        ]) }],
      },
    });
    if (updated.schemaVersion !== "3.0.0") throw new TypeError("test requires BuildConfig V3");
    const simulationInput = await createProductionSimulationInput({
      config: updated,
      simulationModelHash: "d".repeat(64),
      caseInstanceOverrides: [],
    });
    expect(simulationInput.sourcedInput.input).toMatchObject({
      workloadMetricRefs: ["requirement:planning-thermal-environment:thermal.ambient", "requirement:planning-thermal-environment:thermal.scenario"],
      ambientC: { min: 22, max: 28 },
    });
    pages.dispose(); store.dispose();
  });

  it("renders active, alternate and archived plans with explicit next actions", async () => {
    const root = mountWorkspaceDom();
    const archived = makePlan("plan-87654321", "归档方案");
    archived.status = "archived";
    const { store } = await initializedStore([makePlan("plan-12345678", "主方案"), archived]);
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    expect(root.querySelector("[data-current-plan]")?.textContent).toContain("主方案");
    expect(root.querySelectorAll("[data-plan-card]")).toHaveLength(2);
    expect(root.textContent).toContain("继续编辑");
    expect(root.textContent).toContain("恢复");
    pages.dispose(); store.dispose();
  });

  it("opens the guided purchases page before asking a beginner for a file", async () => {
    const root = mountWorkspaceDom();
    const input = document.createElement("input");
    input.id = "transaction-screenshot-input";
    input.type = "file";
    root.append(input);
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    root.querySelector<HTMLButtonElement>('[data-route-action="purchases"]')!.click();
    expect(router.current()).toBe("purchases");
    expect(click).not.toHaveBeenCalled();
    pages.dispose(); store.dispose();
  });

  it("renders every primary destination as one isolated route page", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    for (const route of ["workspace", "editor", "evaluation", "spatial", "purchases", "build", "agent"] as const) {
      router.navigate(route);
      const visible = [...root.querySelectorAll<HTMLElement>("[data-workspace-page]")].filter((page) => !page.hidden);
      expect(visible).toHaveLength(1);
      expect(visible[0]?.dataset.workspacePage).toBe(route);
    }
    expect(root.querySelector("#workspace-page-evaluation")?.textContent).toContain("买之前，把风险查清楚");
    expect(root.querySelector("#workspace-page-purchases")?.textContent).toContain("只买已经确认需要的硬件");
    root.querySelector<HTMLButtonElement>('[data-evaluation-view="wiring"]')!.click();
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="wiring"]')!.hidden).toBe(false);
    router.navigate("workspace");
    router.navigate("evaluation");
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="summary"]')!.hidden).toBe(false);
    expect(root.querySelector('[data-evaluation-view="summary"]')?.getAttribute("aria-pressed")).toBe("true");
    pages.dispose(); store.dispose();
  });

  it("includes non-SKU fan requirements in the visible pending-price count", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const active = store.getState().activePlan!;
    const evaluation = evaluateBuild(active.draft.config, loadBundledCatalog());
    expect(evaluation.price.unresolvedRequirements).toHaveLength(1);
    store.setEvaluation(evaluation);
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    router.navigate("evaluation");

    const pricePending = [...root.querySelectorAll("dt")].find((item) => item.textContent === "价格待补")?.nextElementSibling;
    expect(pricePending?.textContent).toBe(`${evaluation.price.unknownSkuIds.length + evaluation.price.unresolvedRequirements.length} 项`);
    pages.dispose(); store.dispose();
  });

  it("renders requirements-only and resolved-instance V3 drafts safely after authoritative re-renders", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    root.insertAdjacentHTML("beforeend", `<section class="lab-kpis">旧 V2 兼容性结论</section><section class="verdict-card">旧 V2 verdict</section><section data-panel="thermal" class="is-hidden">旧 V2 thermal</section><section data-panel="wiring" class="is-hidden">旧 V2 wiring</section><section data-panel="gpu" class="is-hidden">旧 V2 gpu</section><section class="lab-case-card">旧 V2 scene</section><section class="product-reference">旧 V2 product evidence</section><section data-panel="price" class="is-hidden">旧 V2 price</section><section data-panel="checklist" class="is-hidden">旧 V2 checklist</section>`);
    const legacyExport = document.createElement("button");
    legacyExport.id = "cfg-export-checklist";
    root.append(legacyExport);
    const legacyExportClick = vi.spyOn(legacyExport, "click");
    const staleTaskState = { planId: "plan-12345678", sourceVersionId: "version-v2", tasks: [{ schemaVersion: "1.0.0", id: "task-v2", planId: "plan-12345678", sourceVersionId: "version-v2", kind: "purchase", sourceRef: "sku:v2", title: "旧 V2 采购任务", status: "todo" }] };
    const staleTaskStore = {
      getState: () => structuredClone(staleTaskState),
      subscribe: (listener: (state: typeof staleTaskState) => void) => { listener(structuredClone(staleTaskState)); return () => undefined; },
    } as unknown as BuildTaskStore;
    const staleProgress = {
      summary: () => ({ total: 1, candidate: 0, locked: 0, purchased: 1, installed: 0, knownSpentCny: 999, unknownPurchasedPrice: 0 }),
      items: () => [{ id: "v2-item", skuId: "psu.seasonic-focus-gx-850-v5", name: "旧 V2 总价 ¥999", category: "psu", qty: 1, unitPriceCny: 999, stage: "purchased", source: "catalog" as const }],
      subscribe: () => () => undefined,
    } as unknown as BuildProgressController;
    store.setEvaluation(evaluateBuild(store.getState().activePlan!.draft.config, loadBundledCatalog()));
    const pages = mountWorkspacePages(root, store, router, staleTaskStore, staleProgress);
    root.querySelector<HTMLElement>("[data-purchase-content]")!.innerHTML = "<p>旧 V2 采购总价 ¥999</p>";
    root.querySelector<HTMLElement>("[data-build-parts]")!.innerHTML = "<p>旧 V2 BOM</p>";
    const requirementsOnly = createEmptyBuildConfigV3("plan-12345678", "V3 需求方案", "2026-08-27T13:00:00.000Z");
    requirementsOnly.requirementSpec = { requirementSpecId: "requirements", schemaVersion: "1.0.0", workloads: [], constraints: [] };
    const oneResolvedInstance = createEmptyBuildConfigV3("plan-12345678", "V3 部分方案", "2026-08-27T13:01:00.000Z");
    oneResolvedInstance.components = [
      {
        instanceId: "psu-aaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "psu",
        role: "primary",
        state: "planned",
        identity: { status: "resolved", skuId: "psu.seasonic-focus-gx-850-v5", identityClaimIds: ["claim-psu-aaaaaaaaaaaaaaaaaaaaaaaa"] },
        source: "agent",
      },
    ];
    for (const v3 of [requirementsOnly, oneResolvedInstance]) {
      const accepted = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
      accepted.name = v3.name;
      accepted.draft.config = v3;
      accepted.draftRevision += 1;
      expect(() => store.acceptServerPlan(accepted)).not.toThrow();
      expect(() => pages.refreshCatalog()).not.toThrow();
      for (const route of ["workspace", "editor", "evaluation", "spatial", "purchases", "build", "agent"] as const) {
        expect(() => router.navigate(route)).not.toThrow();
      }
    }
    expect(root.textContent).toContain("V3 部分拓扑");
    expect(root.textContent).toContain("暂不生成采购核准；保留已知单项价格");
    expect(root.querySelector("[data-v3-evidence-partial]")?.textContent).toContain("已解析身份的组件实例");
    expect(root.querySelector<HTMLSelectElement>("[data-evidence-sku]")?.value).toBe("psu-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(root.querySelector("[data-v3-partial-editor]")).not.toBeNull();
    expect(root.querySelector("[data-v3-partial-evaluation]")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("[data-evaluation-summary] .lab-kpis")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="thermal"] > [data-panel="thermal"]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="wiring"] > [data-panel="wiring"]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="gpu"] > [data-panel="gpu"]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-spatial-content] .lab-case-card")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-spatial-evidence] .product-reference")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-purchase-market] > [data-panel=price]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-build-checklist] > [data-panel=checklist]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>(".workspace-evaluation-technical")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-purchase-content]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-build-parts]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-v3-build-parts]")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("[data-v3-partial-progress]")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("[data-v3-partial-tasks]")).not.toBeNull();
    root.querySelector<HTMLButtonElement>("[data-export-saved-checklist]")!.click();
    expect(legacyExportClick).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>("[data-v3-checklist-export-status]")?.textContent).toContain("已阻止调用旧版 V2 评估器");
    root.querySelector<HTMLButtonElement>('[data-evaluation-view="summary"]')!.click();
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="thermal"]')?.hidden).toBe(true);
    pages.dispose(); store.dispose();
  });

  it("shows locked known prices, unknown instances, requirements, and local conclusions for an incomplete V3 plan", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const config = createEmptyBuildConfigV3("plan-12345678", "V3 渐进方案", "2026-08-28T12:00:00.000Z");
    config.components = [
      resolvedComponent("psu-aaaaaaaaaaaaaaaaaaaaaaaa", "psu", "psu.fixture.850w"),
      {
        instanceId: "memory-bbbbbbbbbbbbbbbbbbbb",
        kind: "memory_module",
        role: "system-memory",
        state: "planned",
        identity: { status: "unresolved", userText: "32GB ECC memory" },
        source: "user",
      },
    ];
    const accepted = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    accepted.name = config.name;
    accepted.draft.config = config;
    accepted.draftRevision += 1;
    store.acceptServerPlan(accepted);
    const input = await progressiveInput(config, [], [], [], progressivePriceSnapshot([{
      skuId: "psu.fixture.850w",
      platform: "official",
      priceCny: 899,
      currency: "CNY",
      listingUrl: "https://example.invalid/psu.fixture.850w",
      match: "mpn",
      evidence: "audited",
      priceKind: "variant",
      variantLabel: "850W",
    }]));
    const evaluation = await evaluateProgressiveCompatibility(input);
    store.setEvaluationSnapshot({
      schemaVersion: accepted.schemaVersion,
      planId: accepted.id,
      planVersionId: null,
      draftRevision: accepted.draftRevision,
      configHash: input.snapshotHashes.configHash,
      evaluationHash: await authoritativeEvaluationHash(evaluation, input.evaluationLock),
      evaluationLock: input.evaluationLock,
      evaluatedAt: "2026-08-28T12:00:00.000Z",
      evaluation,
    });
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);

    expect(root.querySelector("[data-v3-progressive-evaluation]")?.textContent).toContain("局部规则");
    expect(root.querySelector("[data-v3-thermal-acoustic]")?.textContent).toContain(evaluation.thermalAcousticEvaluation.workloadId);
    expect(root.querySelector("[data-v3-thermal-acoustic]")?.textContent).toContain("规划热场插值，非 CFD、非实测");
    expect(root.querySelector("[data-v3-thermal-acoustic]")?.textContent).toContain("标准化硬件声源结果，不代表房间或用户位置的实际噪音");
    expect(root.querySelector("[data-v3-thermal-acoustic]")?.textContent).toContain("关键输入不足");
    expect(root.querySelector("[data-v3-price-projection]")?.textContent).toContain("¥899");
    expect(root.querySelector("[data-v3-price-projection]")?.textContent).toContain("1 项待补");
    expect(root.querySelectorAll('[data-v3-price-projection] [data-price-status="known"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-v3-price-projection] [data-price-status="unknown"]')).toHaveLength(1);
    expect(root.querySelector("[data-v3-topology-bom]")?.textContent).toContain("psu.fixture.850w");
    expect(root.querySelector("[data-purchase-gate]")?.textContent).not.toContain("整套可购买");
    expect(root.querySelector("[data-purchase-gate]")?.textContent).toContain("暂不生成采购核准");
    pages.dispose(); store.dispose();
  });

  it("captures beginner goals before creating a new plan", async () => {
    const root = mountWorkspaceDom();
    const { api, store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    root.querySelector<HTMLButtonElement>("[data-open-create]")!.click();
    root.querySelector<HTMLInputElement>("[data-create-name]")!.value = "卧室静音 NAS";
    root.querySelector<HTMLSelectElement>("[data-create-use-case]")!.value = "家庭存储 / NAS";
    root.querySelector<HTMLInputElement>("[data-create-budget]")!.value = "9000";
    root.querySelector<HTMLSelectElement>("[data-create-location]")!.value = "卧室或安静房间";
    root.querySelector<HTMLSelectElement>("[data-create-priority]")!.value = "低噪音";
    root.querySelector<HTMLInputElement>("[data-create-owned]")!.value = "两块 NVMe";
    root.querySelector<HTMLButtonElement>("[data-create-submit]")!.click();
    await vi.waitFor(() => expect(api.plans).toHaveLength(2));
    expect(api.plans.at(-1)?.draft.config).toMatchObject({
      caseId: "", boardId: "", cpuId: "",
      selection: { psuId: "", coolerId: "", gpuId: "", memoryId: "", diskCount: 0, fanGroups: [] },
      bom: [],
    });
    expect(api.plans.at(-1)?.metadata).toMatchObject({
      useCase: "家庭存储 / NAS",
      budgetCny: 9000,
      initialization: { status: "initialized", intent: { preferences: ["低噪音", "卧室或安静房间", "已有硬件：两块 NVMe"] } },
    });
    pages.dispose(); store.dispose();
  });
});
