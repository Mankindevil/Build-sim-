import type { ProductionRecommendationView } from "../recommendation/production";

const JOB_ID = /^job-[a-f0-9]{64}$/;

export interface GovernedRecommendationPanelController { dispose(): void; }

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  return value;
}

function cny(value: number | undefined): string {
  return value === undefined ? "价格不完整" : `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function tierLabel(value: "economy" | "balanced" | "long_term"): string {
  return value === "economy" ? "经济方案" : value === "balanced" ? "平衡方案" : "长期方案";
}

function render(host: HTMLElement, view: ProductionRecommendationView): void {
  host.replaceChildren();
  const head = node("header");
  const title = node("div");
  title.append(node("small", "服务端整机重评"), node("h3", "经济、平衡与长期方案"));
  head.append(title, node("strong", view.current ? "当前输入有效" : "输入已变化，请重新生成"));
  host.append(head);
  if (!view.current) {
    const warning = node("p", `已有记录仅供回看；变化候选：${view.staleCandidateIds.join("、") || "运行代已更新"}`);
    warning.dataset.level = "warn";
    host.append(warning);
  }
  if (view.set.status !== "ranked") {
    host.append(node("p", "当前不足两个通过全部采购门槛且具备工作负载依据的整机候选。"));
    const excluded = node("ul");
    for (const item of view.set.excluded) excluded.append(node("li", `${item.candidateId}：${item.reasonIds.join("；")}`));
    host.append(excluded);
    return;
  }
  const cards = node("div");
  cards.className = "workspace-recommendation-grid";
  for (const recommendation of view.set.recommendations) {
    const context = view.contexts.find(({ candidate }) => candidate.candidateId === recommendation.solution.candidateId);
    const explanation = view.explanations.find(({ candidateId }) => candidateId === recommendation.solution.candidateId);
    const card = node("article");
    card.dataset.recommendationTier = recommendation.tier;
    card.append(node("h4", tierLabel(recommendation.tier)), node("strong", cny(recommendation.totalCny)));
    card.append(node("p", `${recommendation.solution.candidateId} · ${recommendation.priceConfidence} 价格置信度 · ${recommendation.searchCompleteness === "complete" ? "搜索范围完整" : "仍有未探索范围"}`));
    const gates = node("ul");
    gates.dataset.recommendationGates = "";
    for (const coverage of context?.eligibilityContext.coverage ?? []) {
      gates.append(node("li", `${coverage.domain}：${coverage.verdict}`));
    }
    card.append(node("h5", "采购硬门槛"), gates);
    const scores = node("ul");
    scores.dataset.recommendationScores = "";
    for (const [key, value] of Object.entries(context?.score.objectiveScores ?? recommendation.solution.objectiveScores)) {
      scores.append(node("li", `${key}：${Number(value).toFixed(3)}`));
    }
    for (const penalty of context?.score.penalties ?? []) scores.append(node("li", `${penalty.kind}：-${penalty.amount.toFixed(3)} · ${penalty.explanation}`));
    card.append(node("h5", "分项得分与独立惩罚"), scores);
    card.append(node("p", explanation?.priceStatement ?? "价格说明待读取"));
    card.append(node("p", explanation?.upgradeStatement ?? "升级影响待读取"));
    const alternatives = node("p", `备选：${recommendation.alternativeCandidateIds.join("、")}`);
    alternatives.dataset.recommendationAlternatives = "";
    card.append(alternatives);
    cards.append(card);
  }
  host.append(cards);
}

export function mountGovernedRecommendationPanel(host: HTMLElement, options: {
  enabled: boolean;
  getPlanId(): string | null;
  subscribe(listener: () => void): () => void;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): GovernedRecommendationPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? globalThis.localStorage;
  let disposed = false;
  let activePlanId: string | null = null;
  host.hidden = !options.enabled;
  if (!options.enabled) return { dispose() { disposed = true; } };
  const shell = node("section");
  const form = node("form");
  const input = node("input");
  input.name = "solverJobId";
  input.placeholder = "求解任务 ID";
  input.autocomplete = "off";
  const button = node("button", "生成/刷新三档推荐");
  button.type = "submit";
  const message = node("p");
  message.setAttribute("role", "status");
  const output = node("section");
  output.dataset.recommendationOutput = "";
  form.append(input, button);
  shell.append(node("h2", "整机推荐"), node("p", "只排名经过当前完整评估的整套方案；锁定和已下单部件不会为了分数被替换。"), form, message, output);
  host.replaceChildren(shell);

  const key = (planId: string) => `buildsim.recommendation-job.${planId}`;
  const load = async (planId: string, jobId: string) => {
    if (!JOB_ID.test(jobId)) throw new TypeError("求解任务 ID 格式无效");
    const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(planId)}/recommendations/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`推荐记录读取失败（HTTP ${response.status}）`);
    const view = await response.json() as ProductionRecommendationView;
    if (!disposed && activePlanId === planId) render(output, view);
  };
  const sync = () => {
    const planId = options.getPlanId();
    if (planId === activePlanId) return;
    activePlanId = planId;
    output.replaceChildren();
    message.textContent = "";
    input.value = planId ? storage.getItem(key(planId)) ?? "" : "";
    if (planId && JOB_ID.test(input.value)) void load(planId, input.value).catch((error) => { message.textContent = error instanceof Error ? error.message : "推荐记录读取失败"; });
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const planId = options.getPlanId();
    const jobId = input.value.trim();
    if (!planId) { message.textContent = "请先选择方案"; return; }
    if (!JOB_ID.test(jobId)) { message.textContent = "请输入有效的求解任务 ID"; return; }
    button.disabled = true;
    message.textContent = "正在用当前快照重新检查候选…";
    void fetchImpl(`/api/workspace/plans/${encodeURIComponent(planId)}/recommendations`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ solverJobId: jobId }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`推荐生成失败（HTTP ${response.status}）`);
      const view = await response.json() as ProductionRecommendationView;
      storage.setItem(key(planId), jobId);
      if (!disposed && activePlanId === planId) { render(output, view); message.textContent = "推荐已按当前输入更新"; }
    }).catch((error) => { if (!disposed) message.textContent = error instanceof Error ? error.message : "推荐生成失败"; })
      .finally(() => { if (!disposed) button.disabled = false; });
  };
  form.addEventListener("submit", submit);
  const unsubscribe = options.subscribe(sync);
  sync();
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      form.removeEventListener("submit", submit);
      host.replaceChildren();
    },
  };
}
