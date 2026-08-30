import type { BackgroundJob } from "../jobs/contracts";
import type { PlanStoreState } from "../plans/client-store";
import type { SolverResultArtifact } from "../server/solver-service";
import type { ProductionWholeBuildSolverStatus } from "../server/solver-production";
import type { BuildConfigV3 } from "../topology/contracts";

const JOB_ID = /^job-[a-f0-9]{64}$/;

export interface SolverPanelController { refresh(): Promise<void>; dispose(): void; }

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

function statusLabel(status: BackgroundJob["status"]): string {
  return ({
    queued: "排队中", running: "正在探索", waiting_user: "等待选择候选", waiting_retry: "等待重试",
    paused_offline: "已离线暂停", paused_restore_review: "恢复后等待确认", succeeded: "已完成",
    failed: "失败", cancelled: "已取消", dead_letter: "需要人工处理",
  } satisfies Record<BackgroundJob["status"], string>)[status];
}

function resultLabel(result: SolverResultArtifact["result"]): string {
  return result.status === "feasible_complete" ? "已探索到完整可行候选"
    : result.status === "feasible_partial" ? "探索范围有限，当前候选为 partial"
      : result.status === "unsat_proven" ? "当前硬目标组合无解"
        : "输入不足，尚不能求解";
}

function renderCandidate(candidate: SolverResultArtifact["result"]["candidates"][number], index: number, jobId: string): HTMLElement {
  const card = element("article");
  card.dataset.solverCandidate = candidate.candidateId;
  const passed = candidate.domainCoverage.filter(({ verdict }) => verdict === "pass").length;
  const blocked = candidate.domainCoverage.filter(({ verdict }) => verdict === "blocked").length;
  const failed = candidate.domainCoverage.filter(({ verdict }) => verdict === "fail").length;
  card.append(element("h4", `候选 ${index + 1}`), element("p", candidate.candidateId));
  const summary = element("dl");
  for (const [label, value] of [
    ["通过领域", String(passed)], ["阻断领域", String(blocked)], ["失败领域", String(failed)],
    ["残余需求", String(candidate.residualRequirementIds.length)], ["排除原因", String(candidate.excludedReasonIds.length)],
  ]) {
    const item = element("div"); item.append(element("dt", label), element("dd", value)); summary.append(item);
  }
  const coverage = element("ul");
  coverage.dataset.solverCoverage = "";
  for (const domain of candidate.domainCoverage) coverage.append(element("li", `${domain.domain}：${domain.verdict}${domain.requiredForPurchase ? " · 采购必需" : ""}`));
  card.append(summary, element("h5", "Requirement coverage"), coverage);
  if (candidate.residualRequirementIds.length) card.append(element("p", `仍需解决：${candidate.residualRequirementIds.join("、")}`));
  if (candidate.excludedReasonIds.length) card.append(element("p", `当前不可进入采购推荐：${candidate.excludedReasonIds.join("、")}`));
  const review = element("button", "在助手中逐项审阅并批准");
  review.type = "button";
  review.dataset.reviewSolverCandidate = candidate.candidateId;
  review.dataset.solverJobId = jobId;
  card.append(review);
  return card;
}

export function mountSolverPanel(host: HTMLElement, options: {
  enabled: boolean;
  getState(): PlanStoreState;
  subscribe(listener: () => void): () => void;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  openAgent?(prompt: string): void;
}): SolverPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? globalThis.localStorage;
  let disposed = false;
  let planId: string | null = null;
  let currentJobId: string | null = null;
  let currentStatus: ProductionWholeBuildSolverStatus | null = null;
  let loadSequence = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  host.hidden = !options.enabled;
  if (!options.enabled) return { async refresh() {}, dispose() { disposed = true; } };

  const shell = element("section"); shell.className = "workspace-solver-panel"; shell.dataset.solverPanel = "";
  const header = element("header"); const copy = element("div");
  copy.append(element("small", "整机自动求解"), element("h2", "在明确边界内探索整套配置"), element("p", "只读取已保存版本、当前 RequirementSpec 和你锁定的实例；候选不会直接写入活动方案。"));
  header.append(copy);
  const form = element("form"); form.dataset.solverForm = "";
  const locked = element("fieldset"); locked.dataset.solverLockedInstances = ""; locked.append(element("legend", "保留当前实例"));
  const limits = element("fieldset"); limits.append(element("legend", "探索上限"));
  const maxEvaluations = element("input"); maxEvaluations.type = "number"; maxEvaluations.name = "maxEvaluations"; maxEvaluations.min = "1"; maxEvaluations.max = "256"; maxEvaluations.value = "32";
  const maxDurationMs = element("input"); maxDurationMs.type = "number"; maxDurationMs.name = "maxDurationMs"; maxDurationMs.min = "1000"; maxDurationMs.max = "60000"; maxDurationMs.step = "1000"; maxDurationMs.value = "10000";
  const maxCandidates = element("input"); maxCandidates.type = "number"; maxCandidates.name = "maxCandidatesPerRequirement"; maxCandidates.min = "1"; maxCandidates.max = "32"; maxCandidates.value = "6";
  const labelled = (label: string, control: HTMLElement) => { const row = element("label"); row.append(element("span", label), control); return row; };
  limits.append(labelled("最多评估", maxEvaluations), labelled("最长毫秒", maxDurationMs), labelled("每项最多候选", maxCandidates));
  const submit = element("button", "开始受限求解"); submit.type = "submit";
  const message = element("p"); message.setAttribute("role", "status"); message.dataset.solverMessage = "";
  form.append(locked, limits, submit, message);
  const statusHost = element("section"); statusHost.dataset.solverStatus = "";
  shell.append(header, form, statusHost); host.replaceChildren(shell);

  const key = (id: string) => `buildsim.solver-job.${id}`;
  const clearPoll = () => { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; };

  const renderPlan = () => {
    const current = activeV3(options.getState());
    locked.replaceChildren(element("legend", "保留当前实例"));
    if (!current) {
      submit.disabled = true;
      locked.append(element("p", "整机求解只用于 V3 方案。"));
      return;
    }
    if (!current.versionId || !current.config.requirementSpec) {
      submit.disabled = true;
      locked.append(element("p", !current.config.requirementSpec ? "请先保存需求草稿。" : "请先保存一个带评估回执的方案版本。"));
      return;
    }
    submit.disabled = false;
    const components = [...current.config.components].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    if (!components.length) locked.append(element("p", "当前没有硬件实例；求解器会从需求开始探索。"));
    for (const component of components) {
      const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.name = "lockedInstanceIds"; checkbox.value = component.instanceId; checkbox.checked = component.state === "ordered";
      const row = element("label"); row.append(checkbox, element("span", `${component.instanceId} · ${component.kind} · ${component.state === "ordered" ? "已下单，默认锁定" : "计划中"}`)); locked.append(row);
    }
  };

  const renderStatus = (view: ProductionWholeBuildSolverStatus) => {
    statusHost.replaceChildren();
    const job = view.job;
    const head = element("header"); const title = element("div");
    title.append(element("small", job.jobId), element("h3", statusLabel(job.status)));
    head.append(title, element("span", `尝试 ${job.attempt}/${job.maxAttempts} · 修订 ${job.revision}`));
    statusHost.append(head);
    if (job.progress) {
      const progress = element("progress"); progress.value = job.progress.completed; progress.max = job.progress.total ?? Math.max(job.progress.completed, 1);
      statusHost.append(progress, element("p", `${job.progress.stage} · ${job.progress.completed}${job.progress.total === undefined ? "" : `/${job.progress.total}`}`));
    }
    if (job.lastError) statusHost.append(element("p", `${job.lastError.code}：${job.lastError.message}`));
    const controls = element("div"); controls.className = "workspace-inline-actions";
    if (["queued", "running", "waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"].includes(job.status)) {
      const cancel = element("button", "取消任务"); cancel.type = "button"; cancel.dataset.solverAction = "cancel"; controls.append(cancel);
    }
    if (["waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"].includes(job.status)) {
      const resume = element("button", "继续任务"); resume.type = "button"; resume.dataset.solverAction = "resume"; controls.append(resume);
    }
    const refresh = element("button", "刷新状态"); refresh.type = "button"; refresh.dataset.solverRefresh = ""; controls.append(refresh);
    statusHost.append(controls);
    if (view.result) {
      const result = view.result.result;
      statusHost.append(element("h3", resultLabel(result)), element("p", `已探索 ${result.explored} · 已剪枝 ${result.pruned} · 未探索区间 ${result.unexploredRanges?.length ?? 0}`));
      if (result.unsatisfiedHardConstraintIds.length) statusHost.append(element("p", `未满足硬目标：${result.unsatisfiedHardConstraintIds.join("、")}`));
      if (result.irreducibleConflictSets.length) {
        const conflicts = element("ul");
        for (const set of result.irreducibleConflictSets) conflicts.append(element("li", `冲突集：${set.join(" + ")}`));
        statusHost.append(element("h4", "无解说明"), conflicts);
      }
      const candidates = element("div"); candidates.className = "workspace-solver-candidates";
      for (const [index, candidate] of result.candidates.entries()) candidates.append(renderCandidate(candidate, index, job.jobId));
      if (candidates.childElementCount) statusHost.append(candidates);
    }
  };

  const schedulePoll = (job: BackgroundJob) => {
    clearPoll();
    if (["queued", "running", "waiting_retry"].includes(job.status)) {
      pollTimer = setTimeout(() => { void load(job.jobId); }, 1000);
    }
  };

  const load = async (jobId: string) => {
    const targetPlanId = planId;
    const sequence = ++loadSequence;
    if (!targetPlanId || !JOB_ID.test(jobId)) return;
    const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(targetPlanId)}/solver-jobs/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`求解状态读取失败（HTTP ${response.status}）`);
    const view = await response.json() as ProductionWholeBuildSolverStatus;
    if (disposed || sequence !== loadSequence || planId !== targetPlanId || view.job.planId !== targetPlanId) return;
    currentJobId = jobId; currentStatus = view; renderStatus(view); schedulePoll(view.job);
  };

  const sync = () => {
    const current = activeV3(options.getState());
    const nextPlanId = current?.planId ?? null;
    renderPlan();
    if (nextPlanId === planId) return;
    clearPoll(); loadSequence += 1; planId = nextPlanId; currentJobId = null; currentStatus = null; statusHost.replaceChildren(); message.textContent = "";
    const saved = planId ? storage.getItem(key(planId)) : null;
    if (planId && saved && JOB_ID.test(saved)) void load(saved).catch((error) => { message.textContent = error instanceof Error ? error.message : "求解状态读取失败"; });
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = activeV3(options.getState());
    if (!current?.versionId || !current.config.requirementSpec) { message.textContent = "请先保存需求和方案版本"; return; }
    const integer = (input: HTMLInputElement, label: string) => {
      const value = Number(input.value); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数`); return value;
    };
    try {
      const lockedInstanceIds = [...form.querySelectorAll<HTMLInputElement>('[name="lockedInstanceIds"]:checked')].map(({ value }) => value).sort();
      const body = {
        basePlanVersionId: current.versionId,
        lockedInstanceIds,
        requirementSpecId: current.config.requirementSpec.requirementSpecId,
        limits: {
          maxEvaluations: integer(maxEvaluations, "最多评估"),
          maxDurationMs: integer(maxDurationMs, "最长时间"),
          maxCandidatesPerRequirement: integer(maxCandidates, "每项候选数"),
        },
      };
      submit.disabled = true; message.textContent = "正在创建持久求解任务…";
      void fetchImpl(`/api/workspace/plans/${encodeURIComponent(current.planId)}/solver-jobs`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`求解任务创建失败（HTTP ${response.status}）`);
        const created = await response.json() as { job: BackgroundJob };
        if (!JOB_ID.test(created.job.jobId)) throw new Error("求解服务返回了无效任务 ID");
        storage.setItem(key(current.planId), created.job.jobId);
        currentJobId = created.job.jobId; message.textContent = "求解任务已保存，可在刷新后继续查看";
        await load(created.job.jobId);
      }).catch((error) => { message.textContent = error instanceof Error ? error.message : "求解任务创建失败"; })
        .finally(() => { if (!disposed) submit.disabled = false; });
    } catch (error) { message.textContent = error instanceof Error ? error.message : "求解输入无效"; }
  });

  statusHost.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-solver-refresh]") && currentJobId) void load(currentJobId).catch((error) => { message.textContent = error instanceof Error ? error.message : "刷新失败"; });
    const review = target.closest<HTMLButtonElement>("[data-review-solver-candidate]");
    if (review) {
      const prompt = `请读取整机求解任务 ${review.dataset.solverJobId}，逐项解释候选 ${review.dataset.reviewSolverCandidate} 的需求覆盖、阻断和变化；只有我确认后才发起普通方案提案。`;
      options.openAgent?.(prompt);
      return;
    }
    const action = target.closest<HTMLButtonElement>("[data-solver-action]")?.dataset.solverAction;
    if (!action || !currentJobId || !currentStatus || !planId) return;
    const jobId = currentJobId; const expectedRevision = currentStatus.job.revision;
    void fetchImpl(`/api/workspace/plans/${encodeURIComponent(planId)}/solver-jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`${action === "cancel" ? "取消" : "继续"}失败（HTTP ${response.status}）`);
      message.textContent = action === "cancel" ? "任务已取消" : "任务已继续";
      await load(jobId);
    }).catch((error) => { message.textContent = error instanceof Error ? error.message : "任务操作失败"; });
  });

  const unsubscribe = options.subscribe(sync); sync();
  return {
    async refresh() { if (currentJobId) await load(currentJobId); },
    dispose() { disposed = true; clearPoll(); unsubscribe(); host.replaceChildren(); },
  };
}
