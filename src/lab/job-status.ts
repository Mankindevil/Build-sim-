import type { BackgroundJobStatus } from "../jobs/contracts";
import type { WorkspaceJobStatus } from "../server/job-center-production";

export interface JobStatusPanelController { refresh(): Promise<void>; dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const statusLabels: Record<BackgroundJobStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_user: "等待用户确认",
  waiting_retry: "等待重试",
  paused_offline: "离线暂停",
  paused_restore_review: "恢复后待审阅",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  dead_letter: "需要人工处理",
};

const resumable = new Set<BackgroundJobStatus>(["waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"]);
const terminal = new Set<BackgroundJobStatus>(["succeeded", "failed", "cancelled", "dead_letter"]);

function isStatus(value: unknown): value is WorkspaceJobStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<WorkspaceJobStatus>;
  return job.schemaVersion === "workspace-job-status-v1" && typeof job.jobId === "string" && typeof job.planId === "string"
    && typeof job.type === "string" && typeof job.status === "string" && job.status in statusLabels
    && Number.isSafeInteger(job.revision) && Number.isSafeInteger(job.attempt) && Number.isSafeInteger(job.maxAttempts)
    && typeof job.updatedAt === "string";
}

export function mountJobStatusPanel(host: HTMLElement, options: {
  readonly enabled: boolean;
  readonly getPlanId: () => string | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
}): JobStatusPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  let jobs: WorkspaceJobStatus[] = [];
  let planId: string | null = null;
  let disposed = false;
  let request = 0;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let error: string | null = null;

  const schedule = () => {
    if (poll) clearTimeout(poll);
    poll = null;
    if (!disposed && pollIntervalMs > 0 && jobs.some((job) => ["queued", "running", "waiting_retry"].includes(job.status))) {
      poll = setTimeout(() => { void refresh(); }, pollIntervalMs);
    }
  };
  const render = () => {
    host.replaceChildren();
    host.hidden = !options.enabled || planId === null;
    if (host.hidden) return;
    host.className = "workspace-job-center";
    host.dataset.jobCenter = "true";
    const header = element("header");
    const copy = element("div"); copy.append(element("p", "后台任务"), element("h3", "任务中心"), element("span", "状态、阶段、重试与错误均来自持久任务记录；刷新页面后仍可恢复。"));
    const refreshButton = element("button", "刷新"); refreshButton.type = "button"; refreshButton.dataset.refreshJobs = "true";
    header.append(copy, refreshButton); host.append(header);
    if (error) { const alert = element("p", error); alert.setAttribute("role", "alert"); host.append(alert); }
    if (jobs.length === 0) { host.append(element("p", "当前方案还没有后台任务。")); return; }
    const list = element("div"); list.className = "workspace-job-list";
    for (const job of jobs) {
      const article = element("article"); article.dataset.jobId = job.jobId; article.dataset.jobStatus = job.status;
      const jobHeader = element("header");
      const title = element("div"); title.append(element("strong", job.type), element("small", job.jobId));
      const state = element("span", statusLabels[job.status]); state.dataset.status = job.status;
      jobHeader.append(title, state); article.append(jobHeader);
      article.append(element("p", `阶段 ${job.progress?.stage ?? "尚未报告"} · ${job.progress ? `${job.progress.completed}${job.progress.total === undefined ? "" : `/${job.progress.total}`}` : "—"} · 尝试 ${job.attempt}/${job.maxAttempts}`));
      if (job.dependencyJobIds.length > 0) article.append(element("small", `依赖：${job.dependencyJobIds.join("、")}`));
      if (job.lastError) { const failure = element("p", `${job.lastError.code}：${job.lastError.message}`); failure.dataset.jobError = "true"; article.append(failure); }
      const actions = element("footer");
      if (resumable.has(job.status)) { const resume = element("button", "继续"); resume.type = "button"; resume.dataset.resumeJob = job.jobId; actions.append(resume); }
      if (!terminal.has(job.status) && job.status !== "running") { const cancel = element("button", "取消"); cancel.type = "button"; cancel.dataset.cancelJob = job.jobId; actions.append(cancel); }
      if (actions.childElementCount > 0) article.append(actions);
      list.append(article);
    }
    host.append(list);
  };
  const refresh = async () => {
    const nextPlanId = options.getPlanId();
    planId = nextPlanId;
    error = null;
    if (!options.enabled || !nextPlanId) { jobs = []; render(); return; }
    const currentRequest = ++request;
    try {
      const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(nextPlanId)}/jobs`, { headers: { Accept: "application/json" } });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { jobs?: unknown }).jobs)
        || !(body as { jobs: unknown[] }).jobs.every(isStatus)) throw new Error("任务列表与当前方案不一致");
      if (disposed || currentRequest !== request || options.getPlanId() !== nextPlanId) return;
      jobs = (body as { jobs: WorkspaceJobStatus[] }).jobs.filter((job) => job.planId === nextPlanId);
    } catch (cause) {
      if (disposed || currentRequest !== request) return;
      jobs = []; error = cause instanceof Error ? cause.message : "任务列表暂不可用";
    }
    render(); schedule();
  };
  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-refresh-jobs]")) { void refresh(); return; }
    const actionButton = target.closest<HTMLButtonElement>("[data-resume-job], [data-cancel-job]");
    const activePlanId = options.getPlanId();
    if (!actionButton || !activePlanId) return;
    const action = actionButton.dataset.resumeJob ? "resume" : "cancel";
    const jobId = actionButton.dataset.resumeJob ?? actionButton.dataset.cancelJob;
    const job = jobs.find((entry) => entry.jobId === jobId);
    if (!job) return;
    void (async () => {
      try {
        const response = await fetchImpl(`/api/workspace/plans/${encodeURIComponent(activePlanId)}/jobs/${encodeURIComponent(job.jobId)}/${action}`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: job.revision }),
        });
        if (!response.ok) throw new Error("任务状态已经变化，请刷新后重试");
        await refresh();
      } catch (cause) { error = cause instanceof Error ? cause.message : "任务操作失败"; render(); }
    })();
  });
  const unsubscribe = options.subscribe(() => { void refresh(); });
  void refresh();
  return { refresh, dispose() { disposed = true; request += 1; if (poll) clearTimeout(poll); unsubscribe(); host.replaceChildren(); } };
}
