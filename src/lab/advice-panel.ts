import type { BuildAdviceInput, AdviceBillingSummary, AdviceJobResponse, BuildAdviceResult } from "../advice/types";

const API = "/api/advice";

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function esc(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c); }
function requestId(): string {
  return `advice-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function integer(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function cny(value: number): string { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value); }

export function renderBillingHtml(summary: AdviceBillingSummary): string {
  const total = summary.totals;
  const hitShare = total.promptTokens > 0 ? `${((total.promptCacheHitTokens / total.promptTokens) * 100).toFixed(1)}%` : "—";
  const bandSummary = summary.byPricingBand.map((band) => `<span>${esc(band.label)} <b>${integer(band.providerCalls)}</b> 次 / <b>${cny(band.estimatedCostCny)}</b></span>`).join("");
  const rows = summary.calls.map((call) => {
    const usage = call.billing.usage;
    const cost = call.billing.cost;
    const band = call.billing.pricing.pricingBand;
    const rates = call.billing.pricing.rates;
    const bandText = band ? `${esc(band.label)}<br><small>${esc(band.localDate)} ${esc(band.localTime)} 北京</small>${rates ? `<br><small>单价 ${rates.cacheHit}/${rates.cacheMiss}/${rates.output} 元/M</small>` : ""}` : `<span class="text-muted">unknown</span>`;
    const modelText = `${esc(call.providerModel ?? call.requestedModel ?? "unknown")}<br><small>${esc(call.callId)}</small>${call.providerRequestId ? `<br><small>provider ${esc(call.providerRequestId)}</small>` : ""}`;
    const costText = cost ? `${cny(cost.totalCny)}<br><small>命中 ${cny(cost.cacheHitCny)} · 未中 ${cny(cost.cacheMissCny)} · 输出 ${cny(cost.outputCny)}</small>` : `<span class="text-muted">unknown</span>`;
    return `<tr><td>${esc(new Date(call.startedAt).toLocaleString("zh-CN"))}</td><td>${bandText}</td><td>${modelText}</td><td>${esc(call.status)}${call.failureStage ? `<br><small>${esc(call.failureStage)}</small>` : ""}</td><td>${integer(usage?.promptCacheHitTokens ?? 0)}</td><td>${integer(usage?.promptCacheMissTokens ?? 0)}</td><td>${integer(usage?.completionTokens ?? 0)}${usage?.reasoningTokens ? `<br><small>推理 ${integer(usage.reasoningTokens)}</small>` : ""}</td><td>${costText}<br><small>${esc(call.billing.status)}</small></td><td>${call.latencyMs == null ? "—" : `${integer(call.latencyMs)}ms`}</td></tr>`;
  }).join("");
  return `<div class="billing-summary"><span>调用 <b>${integer(total.providerCalls)}</b></span><span>Token <b>${integer(total.totalTokens)}</b></span><span>缓存命中 <b>${integer(total.promptCacheHitTokens)}</b>（${hitShare}）</span><span>缓存未命中 <b>${integer(total.promptCacheMissTokens)}</b></span><span>输出 <b>${integer(total.completionTokens)}</b></span><span>估算费用 <b>${cny(total.estimatedCostCny)}</b></span>${bandSummary}</div><p class="lab-note">按 <a href="${esc(summary.pricing.sourceUrl)}" target="_blank" rel="noreferrer">${esc(summary.pricing.pricingVersion)}</a>（hash ${esc(summary.pricing.pricingHash.slice(0, 12))}）计算；以请求开始时的北京时间判定，工作日 09:00–12:00、14:00–18:00 为高峰，其余（含周末）为空闲。这是依据 API usage 的本地估算，不是 DeepSeek 余额账单。${total.unknownCostCalls ? ` ${integer(total.unknownCostCalls)} 次调用因 usage 不完整或模型未知而未估价。` : ""}</p><div class="table-responsive"><table class="table table-sm billing-table"><thead><tr><th>请求开始</th><th>计费时段</th><th>模型 / call</th><th>状态</th><th>输入缓存命中</th><th>输入未命中</th><th>输出</th><th>估算费用</th><th>延迟</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="text-muted">尚无 DeepSeek provider 调用记录；本地 advice cache 命中不会重复计费。</td></tr>`}</tbody></table></div>`;
}

function deterministicHtml(input: BuildAdviceInput): string {
  const findings = input.evaluation.findings;
  const unknown = input.evaluation.unknown;
  const findingHtml = findings.length
    ? `<ul class="compact-list">${findings.slice(0, 12).map((finding) => `<li class="status-${esc(finding.verdict)}"><b>${esc(finding.verdict)}</b> · ${esc(finding.message)} <small>[${esc(finding.id)}]</small></li>`).join("")}</ul>`
    : `<p class="text-muted">没有确定性 finding。</p>`;
  const unknownHtml = unknown.length ? `<p>unknown：${unknown.map(esc).join("、")}</p>` : `<p>当前没有额外 unknown。</p>`;
  return `<p>确定性引擎判定：<b>${findings.some((f) => f.verdict === "bad") ? "bad" : findings.some((f) => f.verdict === "warn") ? "warn" : "ok"}</b> · BOM ${input.evaluation.bom.length} 项</p><p><small>physical ${esc(input.evaluation.physical.rulesetVersion)} · hash ${esc(input.evaluation.physical.hash)} · provenance ${esc(input.evaluation.physical.provenance.join(","))} · calibration ${esc(input.evaluation.calibration.snapshot.calibrationVersion)} · hash ${esc(input.evaluation.calibration.hash)}</small></p>${findingHtml}${unknownHtml}`;
}

function adviceHtml(advice: BuildAdviceResult): string {
  const claim = (item: { text: string; refs: string[] }) => `<li>${esc(item.text)} <small>引用：${item.refs.map(esc).join(", ")}</small></li>`;
  const risks = advice.risks.length ? `<h5>风险</h5><ul class="compact-list">${advice.risks.map((risk) => `<li class="status-${risk.level === "high" ? "bad" : risk.level === "unknown" ? "warn" : "ok"}"><b>${esc(risk.level)}</b> · ${esc(risk.text)}${risk.mitigation ? ` · ${esc(risk.mitigation)}` : ""} <small>[${risk.refs.map(esc).join(", ")}]</small></li>`).join("")}</ul>` : "";
  const actions = advice.actions.length ? `<h5>行动</h5><ol class="compact-list">${advice.actions.map((action) => `<li>${esc(action.action)}${action.blocking ? " · 阻断项" : ""} <small>[${action.refs.map(esc).join(", ")}]</small></li>`).join("")}</ol>` : "";
  return `<p><b>${esc(advice.recommendation.verdict)}</b> · ${esc(advice.summary)}</p><h5>理由</h5><ul class="compact-list">${advice.recommendation.reasons.map(claim).join("") || "<li>模型未提供理由。</li>"}</ul>${risks}${actions}<p>unknown：${advice.unknowns.map(esc).join("、") || "无"}</p>`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok && response.status !== 503) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function poll(request: AdviceJobResponse): Promise<AdviceJobResponse> {
  let latest = request;
  // Covers two provider attempts at the maximum configured timeout plus audit persistence.
  for (let i = 0; i < 520 && (latest.status === "queued" || latest.status === "running"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await api<AdviceJobResponse>(`/build/${encodeURIComponent(request.requestId)}`);
  }
  return latest;
}

export function initAdvicePanel(args: { getInput: () => BuildAdviceInput }): void {
  const button = $("advice-generate");
  const status = $("advice-status");
  const deterministic = $("advice-deterministic");
  const output = $("advice-output");
  const billing = $("advice-billing");
  const billingStatus = $("advice-billing-status");
  const billingRefresh = $("advice-billing-refresh");
  if (!button || !status || !deterministic || !output) return;

  const refreshBilling = async (): Promise<void> => {
    if (!billing) return;
    try {
      const summary = await api<AdviceBillingSummary>("/billing?limit=100");
      billing.innerHTML = renderBillingHtml(summary);
      if (billingStatus) billingStatus.textContent = `${summary.returnedCalls}/${summary.totalCalls} 次 provider 调用 · ${summary.cacheServedJobs} 次本地 cache`;
    } catch (error) {
      billing.innerHTML = `<p class="text-muted">billing 暂不可用：${esc((error as Error).message)}</p>`;
      if (billingStatus) billingStatus.textContent = "读取失败";
    }
  };
  billingRefresh?.addEventListener("click", () => void refreshBilling());

  const showFacts = (): BuildAdviceInput => {
    const input = args.getInput();
    deterministic.innerHTML = deterministicHtml(input);
    return input;
  };
  showFacts();
  button.addEventListener("click", async () => {
    button.setAttribute("disabled", "true");
    output.innerHTML = "";
    try {
      const base = showFacts();
      const input = { ...base, requestId: requestId() };
      status.textContent = "请求已提交，等待建议…";
      let job = await api<AdviceJobResponse>("/build", { method: "POST", body: JSON.stringify(input) });
      if (job.status === "queued" || job.status === "running") job = await poll(job);
      if (job.status === "completed" && job.advice) {
        status.dataset.level = "ok";
        status.textContent = `DeepSeek 建议已生成 · ${job.model ?? "unknown"} · input ${job.inputHash.slice(0, 12)}`;
        output.innerHTML = adviceHtml(job.advice);
      } else if (job.status === "disabled") {
        status.dataset.level = "warn";
        status.textContent = "AI 建议已关闭；基础装机评估继续可用。";
        output.innerHTML = "<p>AI 建议暂不可用。上方确定性引擎判定仍是唯一事实来源。</p>";
      } else {
        status.dataset.level = "warn";
        status.textContent = "AI 建议暂不可用；确定性评估未受影响。";
        output.innerHTML = `<p>失败阶段：${esc(job.failureStage ?? "unknown")}。${(job.validationErrors ?? []).map(esc).join("；")}</p>`;
      }
      await refreshBilling();
    } catch (error) {
      status.dataset.level = "warn";
      status.textContent = "AI 建议暂不可用；确定性评估未受影响。";
      output.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    } finally {
      button.removeAttribute("disabled");
    }
  });
  void refreshBilling();
}
