import type { PlanCurrentPriceView } from "../price/production";
import { escapeRuntimeHtml, safeHttpsUrl } from "./runtime-dom";

export interface GovernedPricePanelAuthority {
  readonly planId: string;
  readonly expectedPriceSnapshotHash: string;
}

export interface GovernedPricePanelController {
  refresh(): Promise<void>;
  dispose(): void;
}

function money(value: number | null): string {
  return value === null ? "暂无当前全新价" : `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function confidenceLabel(value: string): string {
  return value === "high" ? "高置信" : value === "medium" ? "中等置信" : value === "low" ? "低置信单点" : "价格不可用";
}

function buyWaitLabel(value: PlanCurrentPriceView["components"][number]["buyWait"]["recommendation"]): string {
  return value === "buy" ? "可考虑购买" : value === "wait" ? "建议等待" : value === "buy_if_needed" ? "按需购买" : "当前不可购买";
}

export function governedPriceViewMarkup(view: PlanCurrentPriceView, targetsEnabled = true, observationIntakeEnabled = true): string {
  const esc = escapeRuntimeHtml;
  const rows = view.components.map((component) => {
    const current = component.current;
    const range = current.minCny === null ? "暂无当前全新价"
      : current.minCny === current.maxCny ? money(current.minCny) : `${money(current.minCny)}–${money(current.maxCny)}`;
    const observations = component.currentObservations.map((observation) => {
      const href = safeHttpsUrl(observation.canonicalUrl);
      const label = `${observation.platform} · ${observation.sellerName ?? observation.sellerId ?? "卖家未标识"} · ${money(observation.comparableTotalCny)}`;
      const conditions = observation.requiredDiscountConditions?.length
        ? ` · 条件 ${observation.requiredDiscountConditions.map(esc).join("、")}` : "";
      return `<li><a${href ? ` href="${esc(href)}" target="_blank" rel="noreferrer"` : ""}>${esc(label)}</a><small>${esc(observation.sellerTier)} · 发票 ${esc(observation.invoiceStatus)} · 保修 ${esc(observation.warrantyStatus)}${conditions}</small></li>`;
    }).join("") || "<li><span>当前没有满足精确型号与时效要求的报价</span></li>";
    const target = component.targets[0]?.target;
    const targetRecord = component.targets[0];
    const advice = component.buyWait;
    const history = advice.historyWindow;
    const position = advice.historicalPosition === null ? "历史覆盖不足，不能判断价格位置" : `位于当前历史窗口约 ${Math.round(advice.historicalPosition * 100)}%`;
    const targetControls = target && targetRecord
      ? `<form data-price-target-edit data-instance-id="${esc(component.instanceId)}" data-target-id="${esc(target.targetId)}" data-revision="${targetRecord.revision}" data-record-hash="${esc(targetRecord.recordHash)}" data-target-revision-hash="${esc(target.revisionHash)}">
          <label>目标到手价<input name="targetTotalCny" type="number" min="0" step="1" value="${target.targetTotalCny}"></label>
          <label><input name="enabled" type="checkbox"${target.enabled ? " checked" : ""}>启用提醒</label>
          <button type="submit">保存目标</button>
        </form>`
      : `<form data-price-target-create data-instance-id="${esc(component.instanceId)}"><label>目标到手价<input name="targetTotalCny" type="number" min="0" step="1" placeholder="输入金额"></label><button type="submit">创建目标</button></form>`;
    const intakeControls = observationIntakeEnabled
      ? `<details><summary>归档已采集的精确规格价格</summary><form data-price-observation-intake data-instance-id="${esc(component.instanceId)}">
          <label>采集记录 ID<input name="listingCaptureId" required pattern="listing-capture-[a-f0-9]{20}" placeholder="listing-capture-…"></label>
          <label>已确认的规格标签<input name="variantLabel" required maxlength="160" placeholder="例如 32GB"></label>
          <button type="submit">归档并更新价格快照</button><small data-price-observation-status></small>
        </form></details>`
      : "";
    return `<article data-governed-price-instance="${esc(component.instanceId)}">
      <header><div><small>${esc(component.instanceId)}</small><strong>${esc(component.skuId)}</strong></div><span data-price-confidence="${esc(current.confidence)}">${esc(confidenceLabel(current.confidence))}</span></header>
      <p><b>${esc(range)}</b> · ${current.sellerCount} 个独立卖家 · ${current.sampleCount} 条当前样本</p>
      <p>${current.status === "conflict" ? "价格差异较大，需人工核对" : current.validUntil ? `建议在 ${esc(current.validUntil)} 前重新确认` : "没有可声明的有效期"} · 历史 ${component.history.length} 个时间桶</p>
      <section data-buy-wait><strong>${esc(buyWaitLabel(advice.recommendation))}</strong><p>${esc(position)}${history ? ` · ${history.coverageDays} 天 / ${history.sampleCount} 条样本` : ""}</p><p>${esc(advice.uncertainty)}</p><ul>${advice.triggerConditions.map((item) => `<li>${esc(item)}</li>`).join("")}${advice.counterEvidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>
      <ul>${observations}</ul>
      ${target ? `<footer>目标 ${money(target.targetTotalCny)} · ${esc(target.enabled ? target.status : "paused")}</footer>` : ""}
      ${targetsEnabled ? targetControls : ""}
      ${intakeControls}
    </article>`;
  }).join("");
  return `<header><div><small>受治理价格快照</small><h2>当前全新价格与历史</h2><p>页面和 Agent 均使用本次评估锁定的同一份快照。</p></div><span>${esc(view.asOf)} · ${esc(view.priceSnapshotId)}</span></header>
    <div class="workspace-governed-price-grid">${rows || "<p>当前方案没有已解析且可查价的组件。</p>"}</div>
    <small>priceSnapshotHash ${esc(view.priceSnapshotHash)}</small>`;
}

function validView(value: unknown, authority: GovernedPricePanelAuthority): value is PlanCurrentPriceView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Partial<PlanCurrentPriceView>;
  return view.schemaVersion === "plan-current-price-view-v1" && view.planId === authority.planId
    && view.priceSnapshotHash === authority.expectedPriceSnapshotHash
    && typeof view.priceSnapshotId === "string" && Array.isArray(view.components) && Array.isArray(view.unresolvedInstanceIds);
}

export function mountGovernedPricePanel(root: HTMLElement, options: {
  readonly enabled: boolean;
  readonly targetsEnabled?: boolean;
  readonly observationIntakeEnabled?: boolean;
  readonly getAuthority: () => GovernedPricePanelAuthority | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly fetchImpl?: typeof fetch;
}): GovernedPricePanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  let disposed = false;
  let requestGeneration = 0;
  let signature = "";
  let activeAuthority: GovernedPricePanelAuthority | null = null;
  const refresh = async (): Promise<void> => {
    const authority = options.getAuthority();
    activeAuthority = authority;
    root.hidden = !options.enabled || authority === null;
    if (!options.enabled || authority === null) { root.replaceChildren(); signature = ""; return; }
    const nextSignature = `${authority.planId}:${authority.expectedPriceSnapshotHash}`;
    if (nextSignature === signature && root.childElementCount > 0) return;
    signature = nextSignature;
    const generation = ++requestGeneration;
    root.textContent = "正在读取当前评估锁定的价格快照…";
    try {
      const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(authority.planId)}/prices`, { headers: { Accept: "application/json" } });
      const body: unknown = await response.json();
      if (!response.ok || !validView(body, authority)) throw new Error("价格视图与当前评估快照不一致");
      if (disposed || generation !== requestGeneration) return;
      root.innerHTML = governedPriceViewMarkup(body, options.targetsEnabled === true, options.observationIntakeEnabled !== false);
    } catch (error) {
      if (disposed || generation !== requestGeneration) return;
      root.textContent = error instanceof Error ? error.message : "价格视图暂不可用";
      root.dataset.level = "warn";
    }
  };
  const unsubscribe = options.subscribe(() => { void refresh(); });
  const submitTarget = async (event: Event): Promise<void> => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !activeAuthority) return;
    if (form.matches("[data-price-observation-intake]")) {
      event.preventDefault();
      if (options.observationIntakeEnabled === false) return;
      const input = new FormData(form);
      const listingCaptureId = String(input.get("listingCaptureId") ?? "").trim();
      const variantLabel = String(input.get("variantLabel") ?? "").trim();
      const status = form.querySelector<HTMLElement>("[data-price-observation-status]");
      if (!/^listing-capture-[a-f0-9]{20}$/.test(listingCaptureId) || !variantLabel) {
        if (status) status.textContent = "请填写有效的采集记录 ID 和规格标签";
        return;
      }
      try {
        const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(activeAuthority.planId)}/price-observations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ instanceId: form.dataset.instanceId, listingCaptureId, variantLabel }),
        });
        if (!response.ok) throw new Error("价格记录归档失败");
        if (status) status.textContent = "已归档并生成新价格快照；重新运行方案评估后会在当前视图生效。";
      } catch {
        if (status) status.textContent = "价格记录归档失败，请核对采集记录与规格后重试";
      }
      return;
    }
    if (!options.targetsEnabled) return;
    event.preventDefault();
    const amount = Number(new FormData(form).get("targetTotalCny"));
    if (!Number.isFinite(amount) || amount < 0) { form.dataset.error = "目标价无效"; return; }
    const targetId = form.dataset.targetId;
    const editing = Boolean(targetId);
    const body = editing ? {
      expectedRevision: Number(form.dataset.revision),
      expectedRecordHash: form.dataset.recordHash,
      expectedTargetRevisionHash: form.dataset.targetRevisionHash,
      targetTotalCny: amount,
      enabled: new FormData(form).get("enabled") === "on",
    } : { instanceId: form.dataset.instanceId, targetTotalCny: amount };
    try {
      const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(activeAuthority.planId)}/price-targets${editing ? `/${encodeURIComponent(targetId!)}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) { form.dataset.error = "目标价保存失败，请刷新后重试"; return; }
      signature = "";
      await refresh();
    } catch {
      form.dataset.error = "目标价保存失败，请刷新后重试";
    }
  };
  const onSubmit = (event: Event) => { void submitTarget(event); };
  root.addEventListener("submit", onSubmit);
  void refresh();
  return { refresh, dispose() { disposed = true; requestGeneration += 1; unsubscribe(); root.removeEventListener("submit", onSubmit); root.replaceChildren(); } };
}
