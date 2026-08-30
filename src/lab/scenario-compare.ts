import type { PlanStore, PlanStoreState } from "../plans/client-store";
import type { PlanChangeProposal } from "../plans/contracts";
import type { PersistedScenarioBranch, PersistedWhatIfResult, ScenarioFamily } from "../scenarios/contracts";
import type { GovernedWhatIfArtifact } from "../solver/what-if";
import type { BuildConfigV3 } from "../topology/contracts";

const SAFE_SCENARIO_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;

interface ScenarioView {
  family: ScenarioFamily;
  branch: PersistedScenarioBranch;
  config: BuildConfigV3;
  result: PersistedWhatIfResult | null;
}

interface EvaluatedScenario {
  artifactRef: string;
  artifact: GovernedWhatIfArtifact;
  result: PersistedWhatIfResult;
}

export interface ScenarioCompareController { refresh(): Promise<void>; dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  return value;
}

function activeV3(state: PlanStoreState): { planId: string; versionId: string | null; config: BuildConfigV3 } | null {
  const plan = state.activePlan;
  const config: unknown = plan?.draft.config;
  return plan && config && typeof config === "object" && (config as { schemaVersion?: unknown }).schemaVersion === "3.0.0"
    ? { planId: plan.id, versionId: plan.activeVersionId, config: structuredClone(config as BuildConfigV3) }
    : null;
}

function describeOperation(operation: unknown): string {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return "无法显示的操作";
  const item = operation as { op?: unknown; selector?: { collection?: unknown; id?: unknown; field?: unknown }; value?: unknown };
  const target = [item.selector?.collection, item.selector?.id, item.selector?.field].filter((part) => typeof part === "string").join(" / ");
  return `${String(item.op ?? "change")} ${target}${"value" in item ? ` → ${JSON.stringify(item.value)}` : ""}`;
}

function responseError(response: Response, fallback: string): Promise<Error> {
  return response.json().catch(() => null).then((body: unknown) => {
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    return new Error(typeof record?.message === "string" ? record.message : `${fallback}（HTTP ${response.status}）`);
  });
}

export function mountScenarioCompare(host: HTMLElement, options: {
  enabled: boolean;
  store: PlanStore;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): ScenarioCompareController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? globalThis.localStorage;
  let disposed = false;
  let planId: string | null = null;
  let scenarioId: string | null = null;
  let scenario: ScenarioView | null = null;
  let evaluation: EvaluatedScenario | null = null;
  let proposal: PlanChangeProposal<BuildConfigV3> | null = null;
  let loadSequence = 0;

  host.hidden = !options.enabled;
  if (!options.enabled) return { async refresh() {}, dispose() { disposed = true; } };

  const shell = element("section"); shell.className = "workspace-scenario-panel"; shell.dataset.scenarioCompare = "";
  const header = element("header"); const copy = element("div");
  copy.append(element("small", "What-if 实验区"), element("h2", "先比较，再决定是否写入方案"), element("p", "情景分支在服务端独立保存和评估。只有你再次审阅普通方案提案并明确批准，活动草稿才会变化。")); header.append(copy);
  const badge = element("strong", "尚未写入方案"); badge.dataset.scenarioIsolation = ""; header.append(badge);
  const form = element("form"); form.dataset.scenarioForm = "";
  const name = element("input"); name.name = "scenarioName"; name.maxLength = 120; name.value = "组件状态对比";
  const component = element("select"); component.name = "scenarioComponent";
  const state = element("select"); state.name = "scenarioState";
  state.append(Object.assign(element("option", "计划中 planned"), { value: "planned" }), Object.assign(element("option", "已下单 ordered"), { value: "ordered" }));
  const refresh = element("input"); refresh.type = "checkbox"; refresh.name = "refreshSnapshots";
  const labelled = (label: string, control: HTMLElement, help?: string) => { const row = element("label"); row.append(element("span", label), control); if (help) row.append(element("small", help)); return row; };
  const submit = element("button", "创建并评估情景"); submit.type = "submit";
  const message = element("p"); message.setAttribute("role", "status"); message.dataset.scenarioMessage = "";
  form.append(labelled("情景名称", name), labelled("要比较的实例", component), labelled("假设状态", state), labelled("同时刷新事实/市场快照", refresh, "关闭时只比较输入变化；开启后会单独标出快照变化。"), submit, message);
  const output = element("section"); output.dataset.scenarioOutput = "";
  const proposalHost = element("section"); proposalHost.dataset.scenarioProposal = "";
  shell.append(header, form, output, proposalHost); host.replaceChildren(shell);

  const key = (id: string) => `buildsim.what-if-scenario.${id}`;

  const renderPlanOptions = () => {
    const current = activeV3(options.store.getState());
    component.replaceChildren();
    if (!current?.versionId || !current.config.components.length) {
      const empty = element("option", !current?.versionId ? "先保存一个方案版本" : "当前没有可比较的实例"); empty.value = ""; component.append(empty); submit.disabled = true; return;
    }
    submit.disabled = false;
    for (const item of [...current.config.components].sort((left, right) => left.instanceId.localeCompare(right.instanceId))) {
      const row = element("option", `${item.instanceId} · ${item.kind} · ${item.state}`); row.value = item.instanceId; component.append(row);
    }
  };

  const renderScenario = () => {
    output.replaceChildren(); proposalHost.replaceChildren();
    if (!scenario) return;
    const head = element("header"); const title = element("div");
    title.append(element("small", scenario.branch.scenarioId), element("h3", scenario.family.name));
    head.append(title, element("span", scenario.result ? "已评估" : "等待评估")); output.append(head);
    const changes = element("ul"); changes.dataset.scenarioInputChanges = "";
    for (const operation of scenario.branch.patch) changes.append(element("li", describeOperation(operation)));
    output.append(element("h4", "输入变化"), changes);
    if (scenario.result) {
      const attribution = scenario.result.snapshotAttribution === "same_snapshots" ? "事实与市场快照未刷新" : "包含事实或市场刷新影响";
      output.append(element("h4", "事实 / 市场影响"), element("p", attribution));
      const hashes = element("dl");
      for (const [label, value] of [["之前评估", scenario.result.beforeEvaluationHash], ["之后评估", scenario.result.afterEvaluationHash], ["决策差异", scenario.result.decisionDiffRef]]) {
        const row = element("div"); row.append(element("dt", label), element("dd", value)); hashes.append(row);
      }
      output.append(hashes);
      if (evaluation?.artifact.snapshotChangedFields.length) output.append(element("p", `变化的快照字段：${evaluation.artifact.snapshotChangedFields.join("、")}`));
      const prepare = element("button", "转换为普通方案提案"); prepare.type = "button"; prepare.dataset.prepareScenarioProposal = ""; output.append(prepare);
    }
  };

  const renderProposal = () => {
    proposalHost.replaceChildren();
    if (!proposal) return;
    proposalHost.append(element("h3", proposal.summary), element("p", "仍未写入方案。请逐项检查并选择要应用的变化。"));
    const list = element("ol");
    for (const [index, operation] of proposal.operations.entries()) {
      const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.checked = true; checkbox.value = String(index); checkbox.name = "scenarioOperation";
      const label = element("label"); label.append(checkbox, element("span", describeOperation(operation))); const row = element("li"); row.append(label); list.append(row);
    }
    const apply = element("button", "批准所选变化并写入草稿"); apply.type = "button"; apply.dataset.applyScenarioProposal = "";
    proposalHost.append(list, apply);
  };

  const load = async (id: string) => {
    const targetPlanId = planId; const sequence = ++loadSequence;
    if (!targetPlanId || !SAFE_SCENARIO_ID.test(id)) return;
    const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(targetPlanId)}/scenarios/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw await responseError(response, "情景读取失败");
    const view = await response.json() as ScenarioView;
    if (disposed || sequence !== loadSequence || planId !== targetPlanId || view.family.planId !== targetPlanId) return;
    scenarioId = id; scenario = view; evaluation = null; proposal = null; renderScenario();
  };

  const sync = () => {
    const current = activeV3(options.store.getState()); const nextPlanId = current?.planId ?? null;
    renderPlanOptions();
    if (nextPlanId === planId) return;
    planId = nextPlanId; scenarioId = null; scenario = null; evaluation = null; proposal = null; loadSequence += 1; output.replaceChildren(); proposalHost.replaceChildren(); message.textContent = "";
    const saved = planId ? storage.getItem(key(planId)) : null;
    if (planId && saved && SAFE_SCENARIO_ID.test(saved)) void load(saved).catch((error) => { message.textContent = error instanceof Error ? error.message : "情景读取失败"; });
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = activeV3(options.store.getState());
    const selected = current?.config.components.find(({ instanceId }) => instanceId === component.value);
    if (!current?.versionId || !selected) { message.textContent = "请先选择已保存版本中的一个实例"; return; }
    const nextState = state.value as "planned" | "ordered";
    if (selected.state === nextState) { message.textContent = "假设状态与当前状态相同，请选择另一项"; return; }
    const familyId = `family-${crypto.randomUUID()}`; const nextScenarioId = `scenario-${crypto.randomUUID()}`;
    const beforeConfig = JSON.stringify(current.config);
    submit.disabled = true; message.textContent = "正在创建只读情景并重新评估…";
    void (async () => {
      const familyResponse = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(current.planId)}/scenario-families`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ familyId, name: name.value.trim() || "组件状态对比", basePlanVersionId: current.versionId }),
      });
      if (!familyResponse.ok) throw await responseError(familyResponse, "情景组创建失败");
      const branchResponse = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(current.planId)}/scenarios`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioId: nextScenarioId, familyId,
          patch: [{ op: "replace", selector: { collection: "components", id: selected.instanceId, field: "state" }, value: nextState }],
        }),
      });
      if (!branchResponse.ok) throw await responseError(branchResponse, "情景分支创建失败");
      const evaluatedResponse = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(current.planId)}/scenarios/${encodeURIComponent(nextScenarioId)}/evaluate`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refreshSnapshots: refresh.checked }),
      });
      if (!evaluatedResponse.ok) throw await responseError(evaluatedResponse, "情景评估失败");
      const evaluated = await evaluatedResponse.json() as EvaluatedScenario;
      if (JSON.stringify(activeV3(options.store.getState())?.config) !== beforeConfig) throw new Error("活动方案在只读情景期间发生变化；结果未显示");
      storage.setItem(key(current.planId), nextScenarioId);
      evaluation = evaluated;
      await load(nextScenarioId);
      evaluation = evaluated;
      renderScenario();
      message.textContent = "情景已保存并完成比较；活动方案没有变化";
    })().catch((error) => { message.textContent = error instanceof Error ? error.message : "情景评估失败"; })
      .finally(() => { if (!disposed) submit.disabled = false; });
  });

  output.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest("[data-prepare-scenario-proposal]") || !planId || !scenarioId) return;
    message.textContent = "正在生成普通方案提案…";
    const url = `/api/workspace/plans/${encodeURIComponent(planId)}/scenarios/${encodeURIComponent(scenarioId)}/proposal`;
    void fetchImpl(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}" })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response, "提案生成失败");
        const candidate = await response.json() as PlanChangeProposal<BuildConfigV3>;
        const validatedResponse = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(planId!)}/proposals/validate`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ proposal: candidate }),
        });
        if (!validatedResponse.ok) throw await responseError(validatedResponse, "提案校验失败");
        const validated = await validatedResponse.json() as { proposal: PlanChangeProposal<BuildConfigV3> };
        proposal = validated.proposal; renderProposal(); message.textContent = "提案已准备，仍未写入方案";
      }).catch((error) => { message.textContent = error instanceof Error ? error.message : "提案生成失败"; });
  });

  proposalHost.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest("[data-apply-scenario-proposal]") || !proposal || !planId) return;
    const indexes = [...proposalHost.querySelectorAll<HTMLInputElement>('[name="scenarioOperation"]:checked')].map(({ value }) => Number(value));
    if (!indexes.length) { message.textContent = "请至少选择一项变化"; return; }
    const approved = proposal; const targetPlanId = planId;
    message.textContent = "正在应用已批准的普通提案…";
    void fetchImpl(`/api/workspace/plans/${encodeURIComponent(targetPlanId)}/proposals/apply`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ proposal: approved, operationIndexes: indexes, approvalConfirmed: true, approvedBy: "workspace-user" }),
    }).then(async (response) => {
      if (!response.ok) throw await responseError(response, "提案应用失败");
      const applied = await response.json() as { plan: Parameters<PlanStore["acceptServerPlan"]>[0] };
      options.store.acceptServerPlan(applied.plan);
      proposal = null; renderProposal(); message.textContent = "所选变化已通过普通提案写入草稿；请重新评估并保存版本";
    }).catch((error) => { message.textContent = error instanceof Error ? error.message : "提案应用失败"; });
  });

  const unsubscribe = options.store.subscribe(sync); sync();
  return {
    async refresh() { if (scenarioId) await load(scenarioId); },
    dispose() { disposed = true; unsubscribe(); host.replaceChildren(); },
  };
}
