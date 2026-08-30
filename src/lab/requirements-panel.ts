import type { PlanStore, PlanStoreState } from "../plans/client-store";
import {
  validateRequirementSpec,
  type RequirementDraftField,
  type RequirementMetric,
  type RequirementSpec,
  type WorkloadRequirement,
} from "../requirements/contracts";
import type { BuildConfigV3 } from "../topology/contracts";

const GUIDED_WORKLOAD_ID = "guided-whole-build-goals";

const METRICS = Object.freeze([
  { metricId: "storage.usable_capacity", label: "可用存储容量", unitId: "tib", operator: "gte", step: "1" },
  { metricId: "storage.concurrent_disk_count", label: "同时工作的磁盘数量", unitId: "count", operator: "gte", step: "1" },
  { metricId: "network.throughput", label: "网络吞吐", unitId: "gbps", operator: "gte", step: "0.5" },
  { metricId: "physical.case_volume", label: "机箱体积上限", unitId: "liter", operator: "lte", step: "1" },
  { metricId: "acoustics.noise", label: "硬件噪声上限", unitId: "dba", operator: "lte", step: "0.5" },
  { metricId: "thermal.ambient", label: "规划环境温度", unitId: "celsius", operator: "eq", step: "0.5" },
] as const);

type MetricDefinition = (typeof METRICS)[number];
type FieldState = "unset" | "answered" | "deferred" | "not_applicable";

export interface RequirementsPanelController { dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  return value;
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const item = element("option", label);
  item.value = value;
  item.selected = selected;
  return item;
}

function fieldState(value: unknown): FieldState {
  if (!value || typeof value !== "object") return "unset";
  const state = (value as { state?: unknown }).state;
  return state === "answered" || state === "deferred" || state === "not_applicable" ? state : "unset";
}

function numberValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function activeV3(state: PlanStoreState): BuildConfigV3 | null {
  const config: unknown = state.activePlan?.draft.config;
  return config && typeof config === "object" && (config as { schemaVersion?: unknown }).schemaVersion === "3.0.0"
    ? structuredClone(config as BuildConfigV3) : null;
}

function statusLabel(confirmed: boolean, strength: "hard" | "soft"): string {
  return `${strength === "hard" ? "硬目标" : "偏好"} · ${confirmed ? "已确认" : "待确认"}`;
}

function draftStateSelect(name: string, current: FieldState): HTMLSelectElement {
  const select = element("select");
  select.name = name;
  select.append(
    option("unset", "尚未填写", current === "unset"),
    option("answered", "填写并保存", current === "answered"),
    option("deferred", "稍后再定", current === "deferred"),
    option("not_applicable", "不适用", current === "not_applicable"),
  );
  return select;
}

function labelled(label: string, control: HTMLElement, help?: string): HTMLLabelElement {
  const row = element("label");
  row.append(element("span", label), control);
  if (help) row.append(element("small", help));
  return row;
}

function currentGuidedWorkload(spec: RequirementSpec | null): WorkloadRequirement | null {
  return spec?.workloads.find(({ workloadId }) => workloadId === GUIDED_WORKLOAD_ID) ?? null;
}

function createMetricRow(definition: MetricDefinition, current: RequirementMetric | undefined): HTMLElement {
  const row = element("article");
  row.className = "workspace-requirement-metric";
  row.dataset.requirementMetric = definition.metricId;
  const header = element("header");
  header.append(element("strong", definition.label), element("small", `${definition.metricId} · ${definition.unitId}`));
  const state = draftStateSelect("metricState", fieldState(current));
  const input = element("input");
  input.name = "metricValue";
  input.type = "number";
  input.step = definition.step;
  input.min = "0";
  input.value = current && "value" in current ? numberValue(current.value) : "";
  const priority = element("select");
  priority.name = "metricPriority";
  const selectedPriority = current && "priority" in current ? current.priority : "important";
  priority.append(
    option("must", "硬目标", selectedPriority === "must"),
    option("important", "重要偏好", selectedPriority === "important"),
    option("nice_to_have", "可选偏好", selectedPriority === "nice_to_have"),
  );
  const confirmed = element("input");
  confirmed.type = "checkbox";
  confirmed.name = "metricConfirmed";
  confirmed.checked = current && "confirmedByUser" in current ? current.confirmedByUser : true;
  const confirmation = labelled("我已确认这项", confirmed);
  confirmation.className = "workspace-inline-check";
  row.append(header, labelled("状态", state), labelled("数值", input), labelled("约束级别", priority), confirmation);
  return row;
}

function readFinite(form: HTMLFormElement, selector: string, label: string, required: boolean): number | undefined {
  const raw = form.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";
  if (!raw) {
    if (required) throw new Error(`${label}需要填写数值`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必须是非负数`);
  return value;
}

function budgetFrom(form: HTMLFormElement): RequirementSpec["budget"] | undefined {
  const state = form.elements.namedItem("budgetState") as HTMLSelectElement;
  if (state.value === "unset") return undefined;
  const confirmedByUser = (form.elements.namedItem("budgetConfirmed") as HTMLInputElement).checked;
  if (state.value !== "answered") return {
    state: state.value as "deferred" | "not_applicable", source: "user", confirmedByUser,
  };
  const targetCny = readFinite(form, '[name="budgetTarget"]', "目标预算", false);
  const hardCapCny = readFinite(form, '[name="budgetHardCap"]', "预算上限", false);
  const reserveCny = readFinite(form, '[name="budgetReserve"]', "预留金额", false);
  if (targetCny === undefined && hardCapCny === undefined && reserveCny === undefined) throw new Error("预算至少填写一项");
  if (targetCny !== undefined && hardCapCny !== undefined && targetCny > hardCapCny) throw new Error("目标预算不能高于硬上限");
  return {
    state: "answered", source: "user", confirmedByUser,
    value: {
      ...(targetCny === undefined ? {} : { targetCny }),
      ...(hardCapCny === undefined ? {} : { hardCapCny }),
      ...(reserveCny === undefined ? {} : { reserveCny }),
    },
  };
}

function horizonFrom(form: HTMLFormElement): RequirementSpec["horizonYears"] | undefined {
  const state = form.elements.namedItem("horizonState") as HTMLSelectElement;
  if (state.value === "unset") return undefined;
  const confirmedByUser = (form.elements.namedItem("horizonConfirmed") as HTMLInputElement).checked;
  if (state.value !== "answered") return {
    state: state.value as "deferred" | "not_applicable", source: "user", confirmedByUser,
  };
  const value = readFinite(form, '[name="horizonValue"]', "使用周期", true)!;
  if (value <= 0) throw new Error("使用周期必须大于 0");
  return { state: "answered", value, source: "user", confirmedByUser };
}

function metricFrom(row: HTMLElement, definition: MetricDefinition): RequirementMetric | null {
  const state = row.querySelector<HTMLSelectElement>('[name="metricState"]')!.value as FieldState;
  if (state === "unset") return null;
  const confirmedByUser = row.querySelector<HTMLInputElement>('[name="metricConfirmed"]')!.checked;
  if (state !== "answered") return {
    metricId: definition.metricId, state, source: "user", confirmedByUser,
  };
  const input = row.querySelector<HTMLInputElement>('[name="metricValue"]')!;
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(value) || value < 0) throw new Error(`${definition.label}需要填写非负数值`);
  const priority = row.querySelector<HTMLSelectElement>('[name="metricPriority"]')!.value as "must" | "important" | "nice_to_have";
  return {
    metricId: definition.metricId,
    state: "answered",
    operator: definition.operator,
    value,
    unitId: definition.unitId,
    priority,
    source: "user",
    confirmedByUser,
  };
}

function intentFrom(form: HTMLFormElement): BuildConfigV3["intent"] {
  const value = (form.elements.namedItem("machineIntent") as HTMLSelectElement).value;
  if (value === "unset") return null;
  const confirmedByUser = (form.elements.namedItem("intentConfirmed") as HTMLInputElement).checked;
  if (value === "deferred" || value === "not_applicable") return { state: value, source: "user", confirmedByUser };
  return { state: "answered", value: value as "pc" | "workstation" | "nas", source: "user", confirmedByUser };
}

function render(host: HTMLElement, store: PlanStore, state: PlanStoreState): void {
  const config = activeV3(state);
  host.hidden = config === null;
  host.replaceChildren();
  if (!config) return;
  const spec = config.requirementSpec;
  const guided = currentGuidedWorkload(spec);
  const guidedMetrics = guided && "metrics" in guided ? new Map(guided.metrics.map((metric) => [metric.metricId, metric])) : new Map();

  const section = element("section");
  section.className = "workspace-requirements-panel";
  section.dataset.requirementsPanel = "";
  const heading = element("header");
  const headingCopy = element("div");
  headingCopy.append(element("small", "渐进需求向导"), element("h2", "先写需求，也可以暂时跳过"), element("p", "硬目标只有在明确确认后才进入求解；偏好和待确认项会单独显示。这里不会自动添加任何硬件。"));
  heading.append(headingCopy);
  section.append(heading);

  const form = element("form");
  form.dataset.requirementsForm = "";
  const intent = element("select");
  intent.name = "machineIntent";
  const currentIntent = config.intent?.state === "answered" ? config.intent.value : config.intent?.state ?? "unset";
  intent.append(
    option("unset", "尚未填写", currentIntent === "unset"),
    option("deferred", "稍后再定", currentIntent === "deferred"),
    option("not_applicable", "不适用", currentIntent === "not_applicable"),
    option("pc", "个人电脑", currentIntent === "pc"),
    option("workstation", "工作站", currentIntent === "workstation"),
    option("nas", "NAS / 家庭存储", currentIntent === "nas"),
  );
  const intentConfirmed = element("input");
  intentConfirmed.type = "checkbox"; intentConfirmed.name = "intentConfirmed";
  intentConfirmed.checked = config.intent?.confirmedByUser ?? true;
  const workloadName = element("input");
  workloadName.name = "workloadName";
  workloadName.maxLength = 120;
  workloadName.placeholder = "例如：安静办公 + 家庭照片存储";
  workloadName.value = guided && "name" in guided ? guided.name : "";
  const workloadState = draftStateSelect("workloadState", fieldState(guided));
  const workloadConfirmed = element("input");
  workloadConfirmed.type = "checkbox"; workloadConfirmed.name = "workloadConfirmed";
  workloadConfirmed.checked = guided && "confirmedByUser" in guided ? guided.confirmedByUser : true;
  const basics = element("fieldset");
  basics.append(element("legend", "用途与工作负载"), labelled("机器用途", intent), labelled("用途已确认", intentConfirmed), labelled("工作负载状态", workloadState), labelled("工作负载说明", workloadName), labelled("工作负载已确认", workloadConfirmed));

  const budget = element("fieldset");
  const budgetState = draftStateSelect("budgetState", fieldState(spec?.budget));
  const budgetValue = spec?.budget?.state === "answered" ? spec.budget.value : {};
  const budgetInput = (name: string, value: number | undefined) => {
    const input = element("input"); input.type = "number"; input.min = "0"; input.step = "100"; input.name = name; input.value = numberValue(value); return input;
  };
  const budgetConfirmed = element("input"); budgetConfirmed.type = "checkbox"; budgetConfirmed.name = "budgetConfirmed"; budgetConfirmed.checked = spec?.budget?.confirmedByUser ?? true;
  budget.append(element("legend", "预算"), labelled("状态", budgetState), labelled("目标预算（元）", budgetInput("budgetTarget", budgetValue.targetCny)), labelled("硬上限（元）", budgetInput("budgetHardCap", budgetValue.hardCapCny), "超过这项会成为硬目标。"), labelled("预留金额（元）", budgetInput("budgetReserve", budgetValue.reserveCny)), labelled("预算已确认", budgetConfirmed));

  const metrics = element("fieldset");
  metrics.append(element("legend", "容量、吞吐、体积、热噪"));
  for (const definition of METRICS) metrics.append(createMetricRow(definition, guidedMetrics.get(definition.metricId)));

  const horizon = element("fieldset");
  const horizonState = draftStateSelect("horizonState", fieldState(spec?.horizonYears));
  const horizonValue = element("input"); horizonValue.type = "number"; horizonValue.min = "0.5"; horizonValue.step = "0.5"; horizonValue.name = "horizonValue";
  horizonValue.value = spec?.horizonYears?.state === "answered" ? numberValue(spec.horizonYears.value) : "";
  const horizonConfirmed = element("input"); horizonConfirmed.type = "checkbox"; horizonConfirmed.name = "horizonConfirmed"; horizonConfirmed.checked = spec?.horizonYears?.confirmedByUser ?? true;
  horizon.append(element("legend", "使用周期"), labelled("状态", horizonState), labelled("计划使用年数", horizonValue), labelled("周期已确认", horizonConfirmed));

  const constraints = element("section");
  constraints.dataset.requirementConstraints = "";
  constraints.append(element("h3", "已有细粒度约束"));
  const constraintList = element("ul");
  for (const constraint of spec?.constraints ?? []) {
    const item = element("li");
    if (constraint.state === "answered" || constraint.state === undefined) {
      item.append(element("strong", constraint.constraintId), element("span", statusLabel(constraint.confirmedByUser, constraint.strength)), element("small", `${constraint.predicate.facetId} ${constraint.predicate.operator} ${String(constraint.predicate.value)}`));
    } else item.append(element("strong", constraint.constraintId), element("span", constraint.state === "deferred" ? "稍后再定" : "不适用"));
    constraintList.append(item);
  }
  if (!constraintList.childElementCount) constraintList.append(element("li", "暂无额外硬件约束；Agent 提议的约束会在这里等待逐项确认。"));
  constraints.append(constraintList);

  const message = element("p"); message.setAttribute("role", "status"); message.dataset.requirementsMessage = "";
  const submit = element("button", "保存需求草稿"); submit.type = "submit";
  form.append(basics, budget, metrics, horizon, constraints, submit, message);
  section.append(form);
  host.append(section);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const current = activeV3(store.getState());
      if (!current) throw new Error("当前方案不是 V3 方案");
      const previous = current.requirementSpec;
      const next: RequirementSpec = {
        requirementSpecId: previous?.requirementSpecId ?? `requirements-${current.id}`,
        schemaVersion: "1.0.0",
        workloads: (previous?.workloads ?? []).filter(({ workloadId }) => workloadId !== GUIDED_WORKLOAD_ID).map((value) => structuredClone(value)),
        constraints: (previous?.constraints ?? []).map((value) => structuredClone(value)),
      };
      const nextBudget = budgetFrom(form); if (nextBudget) next.budget = nextBudget;
      const nextHorizon = horizonFrom(form); if (nextHorizon) next.horizonYears = nextHorizon;
      const workloadStateValue = (form.elements.namedItem("workloadState") as HTMLSelectElement).value as FieldState;
      if (workloadStateValue !== "unset") {
        const confirmedByUser = (form.elements.namedItem("workloadConfirmed") as HTMLInputElement).checked;
        if (workloadStateValue === "answered") {
          const name = (form.elements.namedItem("workloadName") as HTMLInputElement).value.trim();
          if (!name) throw new Error("填写工作负载时需要简短说明");
          const guidedWorkload: WorkloadRequirement = {
            workloadId: GUIDED_WORKLOAD_ID, state: "answered", name, source: "user", confirmedByUser,
            metrics: METRICS.flatMap((definition) => {
              const row = form.querySelector<HTMLElement>(`[data-requirement-metric="${definition.metricId}"]`)!;
              const metric = metricFrom(row, definition);
              return metric ? [metric] : [];
            }),
          };
          next.workloads.push(guidedWorkload);
        } else next.workloads.push({ workloadId: GUIDED_WORKLOAD_ID, metrics: [], state: workloadStateValue, source: "user", confirmedByUser });
      }
      const errors = validateRequirementSpec(next);
      if (errors.length) throw new Error(errors.join("；"));
      current.intent = intentFrom(form) as RequirementDraftField<"pc" | "workstation" | "nas"> | null;
      current.requirementSpec = next;
      current.updatedAt = new Date().toISOString();
      const successMessage = `已保存：${next.workloads.length} 个工作负载、${next.constraints.length} 个细粒度约束；没有添加硬件。`;
      store.replaceDraft(current as never);
      const renderedMessage = host.querySelector<HTMLElement>("[data-requirements-message]");
      if (renderedMessage) renderedMessage.textContent = successMessage;
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "需求保存失败";
    }
  });
}

export function mountRequirementsPanel(host: HTMLElement, store: PlanStore): RequirementsPanelController {
  let disposed = false;
  let signature = "";
  const sync = (state: PlanStoreState) => {
    if (disposed) return;
    const config = activeV3(state);
    const next = config ? JSON.stringify({ id: config.id, intent: config.intent, requirementSpec: config.requirementSpec }) : "none";
    if (next === signature) return;
    signature = next;
    render(host, store, state);
  };
  const unsubscribe = store.subscribe(sync);
  return { dispose() { disposed = true; unsubscribe(); host.replaceChildren(); } };
}
