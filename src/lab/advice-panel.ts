import type { BuildAdviceInput, AdviceJobResponse, BuildAdviceResult } from "../advice/types";

const API = "/api/advice";

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function esc(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c); }
function requestId(): string {
  return `advice-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function deterministicHtml(input: BuildAdviceInput): string {
  const findings = input.evaluation.findings;
  const unknown = input.evaluation.unknown;
  const findingHtml = findings.length
    ? `<ul class="compact-list">${findings.slice(0, 12).map((finding) => `<li class="status-${esc(finding.verdict)}"><b>${esc(finding.verdict)}</b> · ${esc(finding.message)} <small>[${esc(finding.id)}]</small></li>`).join("")}</ul>`
    : `<p class="text-muted">没有确定性 finding。</p>`;
  const unknownHtml = unknown.length ? `<p>unknown：${unknown.map(esc).join("、")}</p>` : `<p>当前没有额外 unknown。</p>`;
  return `<p>确定性引擎判定：<b>${findings.some((f) => f.verdict === "bad") ? "bad" : findings.some((f) => f.verdict === "warn") ? "warn" : "ok"}</b> · BOM ${input.evaluation.bom.length} 项</p>${findingHtml}${unknownHtml}`;
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
  for (let i = 0; i < 80 && (latest.status === "queued" || latest.status === "running"); i++) {
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
  if (!button || !status || !deterministic || !output) return;

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
    } catch (error) {
      status.dataset.level = "warn";
      status.textContent = "AI 建议暂不可用；确定性评估未受影响。";
      output.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    } finally {
      button.removeAttribute("disabled");
    }
  });
}
