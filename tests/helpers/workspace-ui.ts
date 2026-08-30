import type { BuildConfig, BuildConfigDocument } from "../../src/config/types";
import type { WorkspacePlanApi } from "../../src/plans/client";
import { PlanStore } from "../../src/plans/client-store";
import { PLAN_SCHEMA_VERSION, type BuildPlan, type BuildPlanSummary, type PlanVersion } from "../../src/plans/contracts";
import { createDefaultN6Config } from "../../src/plans/default-plan";

export class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

export function makePlan(id: string, name = id, diskCount = 1): BuildPlan {
  const now = "2026-08-25T00:00:00.000Z";
  const config = createDefaultN6Config(id, now);
  config.name = name;
  config.selection.diskCount = diskCount;
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id,
    name,
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeVersionId: "version-12345678",
    draftRevision: 0,
    draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: "version-12345678", config, dirty: false, updatedAt: now },
    metadata: {},
  };
}

export function makeWorkspaceApi(initialPlans: BuildPlan[], initialVersions: PlanVersion[] = []): WorkspacePlanApi & { plans: BuildPlan[]; versions: PlanVersion[] } {
  const api = {
    plans: initialPlans.map((plan) => structuredClone(plan)),
    versions: initialVersions.map((version) => structuredClone(version)),
    async list() { return this.plans.map((plan) => ({ schemaVersion: plan.schemaVersion, id: plan.id, name: plan.name, status: plan.status, updatedAt: plan.updatedAt, activeVersionId: plan.activeVersionId, draftRevision: plan.draftRevision, dirty: plan.draft.dirty, ...(plan.metadata.initialization ? { initializationStatus: plan.metadata.initialization.status } : {}) } satisfies BuildPlanSummary)); },
    async get(id: string) { return structuredClone(this.plans.find((plan) => plan.id === id)!); },
    async create(input: { name: string; config: BuildConfigDocument; metadata?: BuildPlan["metadata"] }) {
      const created = makePlan(
        `plan-${String(this.plans.length + 10).padStart(8, "0")}`,
        input.name,
        input.config.schemaVersion === "2.0.0" ? input.config.selection.diskCount : 1,
      );
      created.draft.config = structuredClone(input.config) as BuildConfig;
      created.draft.config.id = created.id;
      created.draft.config.name = input.name;
      created.activeVersionId = null;
      created.draft.baseVersionId = null;
      created.draft.dirty = true;
      created.metadata = structuredClone(input.metadata ?? {});
      this.plans.push(created);
      return structuredClone(created);
    },
    async updateInfo(id: string, input: { expectedRevision: number; name: string }) {
      const plan = this.plans.find((item) => item.id === id)!;
      plan.name = input.name;
      plan.draft.config.name = input.name;
      plan.draftRevision += 1;
      plan.draft.dirty = true;
      return structuredClone(plan);
    },
    async updateDraft(id: string, input: { expectedRevision: number; config: BuildConfig }) {
      const plan = this.plans.find((item) => item.id === id)!;
      plan.draftRevision += 1;
      plan.draft.config = structuredClone(input.config);
      plan.draft.dirty = true;
      return structuredClone(plan);
    },
    async saveVersion(id: string, input: { summary?: string }) {
      const plan = this.plans.find((item) => item.id === id)!;
      const version: PlanVersion = { schemaVersion: PLAN_SCHEMA_VERSION, id: `version-${String(this.versions.length + 10).padStart(8, "0")}`, planId: id, versionNumber: this.versions.length + 1, createdAt: "2026-08-25T01:00:00.000Z", reason: "manual-save", ...(input.summary ? { summary: input.summary } : {}), config: structuredClone(plan.draft.config), configHash: "a".repeat(64), parentVersionId: plan.activeVersionId };
      this.versions.push(version);
      plan.activeVersionId = version.id;
      plan.draft.baseVersionId = version.id;
      plan.draft.dirty = false;
      return structuredClone(version);
    },
    async duplicate(id: string, input: { name: string }) { return this.create({ name: input.name, config: this.plans.find((plan) => plan.id === id)!.draft.config }); },
    async archive(id: string) { this.plans.find((plan) => plan.id === id)!.status = "archived"; },
    async restore(id: string) { this.plans.find((plan) => plan.id === id)!.status = "active"; },
    async delete(id: string) { this.plans = this.plans.filter((plan) => plan.id !== id); },
    async listVersions(id: string) { return this.versions.filter((version) => version.planId === id).map((version) => structuredClone(version)); },
  } satisfies WorkspacePlanApi & { plans: BuildPlan[]; versions: PlanVersion[] };
  return api;
}

export function mountWorkspaceDom(): HTMLElement {
  document.body.innerHTML = `<div id="n6-lab"><section class="workspace-global-shell"></section></div>
    <select id="psu-select"><option value="psu.seasonic-focus-gx-850-v5">GX-850</option><option value="psu.corsair-sf750-atx31">SF750</option></select>
    <select id="psu-position"><option value="auto">Auto</option><option value="dual">Dual</option></select>
    <select id="secondary-psu-select"><option value="psu.corsair-sf750-atx31">SF750</option></select>
    <select id="dual-start-select"><option value="sync">Sync</option><option value="none">None</option></select>
    <select id="cooler-select"><option value="cooler.thermalright-axp90-x53-full">AXP90</option></select>
    <select id="boot-select"><option value="bay">Bay</option><option value="m2">M.2</option></select>
    <select id="nvme-select"><option value="2">2</option><option value="3">3</option></select>
    <select id="hba-select"><option value="auto">Auto</option><option value="always">Always</option></select>
    <select id="gpu-select"><option value="gpu.none">None</option><option value="gpu.rtx-a2000-12gb">A2000</option></select>
    <select id="ram-select"><option value="memory.kingston-ksm48e40bd8km-32hm-x2">Kingston</option></select>`;
  return document.getElementById("n6-lab")!;
}

export async function initializedStore(plans = [makePlan("plan-12345678", "主方案")], versions: PlanVersion[] = []) {
  const api = makeWorkspaceApi(plans, versions);
  const store = new PlanStore({ api, storage: new MemoryStorage(), debounceMs: 60_000 });
  await store.initialize();
  return { api, store };
}
