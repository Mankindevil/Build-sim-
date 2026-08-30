import type { BuildProcedureStep } from "../build-execution/contracts";
import type { StoredExecutionSession } from "../build-execution/repository";
import type { PlanStoreState } from "../plans/client-store";
import type { SystemProcedurePreview } from "../server/system-execution-production";
import { renderProcedurePreview } from "./build-procedure";
import { renderNasLayouts } from "./nas-layout";

export interface SystemExecutionPanelOptions {
  readonly getState: () => PlanStoreState;
  readonly subscribePlan: (listener: () => void) => () => void;
  readonly fetchImpl?: typeof fetch;
}

export interface SystemExecutionPanelController {
  refresh(): Promise<void>;
  dispose(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function responsePayload<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({ error: "invalid_response", message: "服务返回了无效 JSON" }));
  if (!response.ok) {
    const error = body as { message?: string; error?: string };
    throw new Error(error.message ?? error.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export function mountSystemExecutionPanel(host: HTMLElement, options: SystemExecutionPanelOptions): SystemExecutionPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  let preview: SystemProcedurePreview | null = null;
  let sessions: StoredExecutionSession[] = [];
  let loading = false;
  let error: string | null = null;
  let signature = "";
  let requestRevision = 0;
  let disposed = false;

  const current = () => {
    const state = options.getState();
    const plan = state.activePlan;
    const config = plan?.draft.config as unknown as { schemaVersion?: string } | undefined;
    return config?.schemaVersion === "3.0.0" && plan?.activeVersionId
      ? { planId: plan.id, planVersionId: plan.activeVersionId }
      : null;
  };

  const renderSession = (container: HTMLElement, stored: StoredExecutionSession) => {
    const article = element("article"); article.className = "workspace-execution-session"; article.dataset.executionSession = stored.session.executionSessionId;
    const header = element("header");
    const copy = element("div"); copy.append(element("strong", `执行会话 ${stored.session.executionSessionId}`), element("p", `状态 ${stored.session.status} · 修订 ${stored.revision} · safety ${stored.session.procedureSafetyHash.slice(0, 12)}…`));
    header.append(copy);
    if (stored.session.planVersionId !== preview?.planVersionId && stored.session.status !== "stale" && stored.session.status !== "abandoned") {
      const revalidate = element("button", "对当前保存版本重新核验");
      revalidate.type = "button";
      revalidate.dataset.revalidateExecutionSession = stored.session.executionSessionId;
      header.append(revalidate);
    }
    article.append(header);
    if (stored.session.staleReason) {
      const stale = element("p", stored.session.staleReason); stale.dataset.executionStaleReason = "true"; stale.setAttribute("role", "status"); article.append(stale);
    }
    const resultByStep = new Map(stored.session.results.map((result) => [result.stepId, result]));
    const list = element("ol");
    for (const step of stored.replayContext.procedure.steps) {
      const row = element("li"); row.dataset.executionStep = step.stepId;
      const result = resultByStep.get(step.stepId);
      row.append(element("strong", `${step.phase} · ${step.stepId}`), element("p", step.action), element("small", `预期：${step.expectedResult}；失败时：${step.failureAction}`));
      if (result) {
        const status = element("p", `${result.result} · ${result.at}`); status.dataset.stepResult = result.result; row.append(status);
      } else {
        const dependenciesReady = step.dependsOn.every((id) => resultByStep.get(id)?.result === "confirmed");
        const destructive = preview?.destructiveActions.find((item) => item.stepId === step.stepId);
        const destructiveConfirmed = (stored.session.destructiveActionConfirmations ?? []).some((action) => (
          action.actionId === `destructive.${step.stepId}` && action.confirmation === "confirmed"
        ));
        if (step.riskLevel === "destructive") {
          const authority = element("p"); authority.dataset.destructiveActionAuthority = step.stepId;
          authority.textContent = destructive?.plan
            ? `精确目标：${destructive.plan.diskInstanceIds.join(", ")}；定位观察：${destructive.plan.locatorObservationIds.join(", ")}；safety ${destructive.plan.inputProcedureSafetyHash.slice(0, 12)}…`
            : `尚不可确认：${destructive?.blockedReason ?? "缺少精确磁盘 authority"}`;
          row.append(authority);
          if (destructive?.plan && !destructiveConfirmed) {
            const confirm = element("button", "单独确认这些磁盘目标"); confirm.type = "button";
            confirm.dataset.confirmDestructiveAction = step.stepId;
            confirm.dataset.executionSessionId = stored.session.executionSessionId;
            confirm.disabled = !dependenciesReady || stored.session.status !== "active";
            row.append(confirm);
          } else if (destructiveConfirmed) row.append(element("p", "精确磁盘目标已单独确认。"));
        }
        if (step.confirmationPolicy === "observation_required") {
          const input = element("input"); input.dataset.stepObservationIds = step.stepId; input.placeholder = "观察 ID，多个用逗号分隔"; input.setAttribute("aria-label", `${step.stepId} 的观察 ID`); row.append(input);
        }
        const button = element("button", step.riskLevel === "destructive" && !destructiveConfirmed ? "需要单独确认精确磁盘" : "确认完成");
        button.type = "button"; button.dataset.confirmExecutionStep = step.stepId; button.dataset.executionSessionId = stored.session.executionSessionId;
        button.disabled = !dependenciesReady || (step.riskLevel === "destructive" && !destructiveConfirmed) || stored.session.status !== "active";
        row.append(button);
      }
      list.append(row);
    }
    article.append(list); container.append(article);
  };

  const render = () => {
    host.replaceChildren(); host.hidden = false; host.className = "workspace-system-execution-panel"; host.dataset.systemExecutionPanel = "true";
    const header = element("header");
    const copy = element("div"); copy.append(element("p", "版本绑定执行"), element("h3", "BIOS、首次启动与系统安装"), element("span", "步骤、checkpoint 和 safety hash 绑定当前保存版本；刷新后从持久会话恢复。"));
    header.append(copy); host.append(header);
    const authority = current();
    if (!authority) { host.append(element("p", "请先保存一个带受治理评估回执的 V3 方案版本。")); return; }
    if (loading) host.append(element("p", "正在读取当前保存版本的执行清单…"));
    if (error) { const alert = element("p", error); alert.setAttribute("role", "alert"); alert.dataset.systemExecutionError = "true"; host.append(alert); }
    if (!preview) return;
    renderProcedurePreview(host, preview);
    if (preview.profile?.profileId === "system.truenas-scale") renderNasLayouts(host, preview.storageLayouts);
    if (preview.generated) {
      const start = element("button", preview.mode === "preparation_only"
        ? (sessions.length ? "建立新的仅准备会话" : "开始仅准备流程")
        : (sessions.length ? "建立新的执行会话" : "开始版本绑定执行"));
      start.type = "button"; start.dataset.startSystemExecution = "true"; host.append(start);
    } else host.append(element("p", "当前锁定输入仍有阻断，不能建立执行会话。"));
    const sessionsHost = element("section"); sessionsHost.dataset.executionSessions = "true";
    sessionsHost.append(element("h4", `执行会话（${sessions.length}）`));
    for (const session of [...sessions].sort((left, right) => right.session.executionSessionId.localeCompare(left.session.executionSessionId))) renderSession(sessionsHost, session);
    host.append(sessionsHost);
  };

  const refresh = async (force = false) => {
    const authority = current();
    const nextSignature = authority ? `${authority.planId}:${authority.planVersionId}` : "";
    // PlanStore emits several notifications while a saved version is settling.
    // Re-entering the same expensive version preview while its first request is
    // still running creates duplicate coordinator readers/writers and can make
    // an unrelated plan creation time out. One signature owns one in-flight
    // refresh; explicit user actions may still force a refresh afterwards.
    if (!force && nextSignature === signature && (loading || preview !== null)) return;
    signature = nextSignature; preview = null; sessions = []; error = null;
    if (!authority) { render(); return; }
    const revision = ++requestRevision; loading = true; render();
    try {
      const plan = encodeURIComponent(authority.planId); const version = encodeURIComponent(authority.planVersionId);
      const [nextPreview, collection] = await Promise.all([
        responsePayload<SystemProcedurePreview>(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/versions/${version}/system-procedure`, { headers: { Accept: "application/json" } })),
        responsePayload<{ sessions: StoredExecutionSession[] }>(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/execution-sessions`, { headers: { Accept: "application/json" } })),
      ]);
      if (disposed || revision !== requestRevision) return;
      preview = nextPreview; sessions = collection.sessions;
    } catch (cause) {
      if (disposed || revision !== requestRevision) return;
      error = cause instanceof Error ? cause.message : "无法读取系统执行清单";
    } finally {
      if (!disposed && revision === requestRevision) { loading = false; render(); }
    }
  };

  host.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement; const authority = current(); if (!authority) return;
    try {
      const plan = encodeURIComponent(authority.planId); const version = encodeURIComponent(authority.planVersionId);
      if (target.closest("[data-start-system-execution]")) {
        await responsePayload(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/versions/${version}/system-procedure`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}",
        }));
        await refresh(true); return;
      }
      const revalidateButton = target.closest<HTMLButtonElement>("[data-revalidate-execution-session]");
      if (revalidateButton) {
        const stored = sessions.find(({ session }) => session.executionSessionId === revalidateButton.dataset.revalidateExecutionSession);
        if (!stored) throw new Error("执行会话已经变化，请刷新后重试");
        await responsePayload(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/execution-sessions/${encodeURIComponent(stored.session.executionSessionId)}/revalidate`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            againstPlanVersionId: authority.planVersionId,
            expectedRevision: stored.revision,
            expectedHash: stored.recordHash,
          }),
        }));
        await refresh(true); return;
      }
      const destructiveButton = target.closest<HTMLButtonElement>("[data-confirm-destructive-action]");
      if (destructiveButton) {
        const stored = sessions.find(({ session }) => session.executionSessionId === destructiveButton.dataset.executionSessionId);
        const stepId = destructiveButton.dataset.confirmDestructiveAction;
        if (!stored || !stepId) throw new Error("破坏性步骤已经变化，请刷新后重试");
        await responsePayload(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/execution-sessions/${encodeURIComponent(stored.session.executionSessionId)}/destructive-actions/${encodeURIComponent(stepId)}/confirm`, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: stored.revision, expectedHash: stored.recordHash, confirmed: true }),
        }));
        await refresh(true); return;
      }
      const button = target.closest<HTMLButtonElement>("[data-confirm-execution-step]");
      if (!button) return;
      const stored = sessions.find(({ session }) => session.executionSessionId === button.dataset.executionSessionId);
      const stepId = button.dataset.confirmExecutionStep; const step = stored?.replayContext.procedure.steps.find((item: BuildProcedureStep) => item.stepId === stepId);
      if (!stored || !stepId || !step) throw new Error("执行步骤已经变化，请刷新后重试");
      const sessionHost = [...host.querySelectorAll<HTMLElement>("[data-execution-session]")]
        .find((item) => item.dataset.executionSession === stored.session.executionSessionId);
      const observationText = [...(sessionHost?.querySelectorAll<HTMLInputElement>("[data-step-observation-ids]") ?? [])]
        .find((item) => item.dataset.stepObservationIds === stepId)?.value ?? "";
      const observationIds = [...new Set(observationText.split(",").map((value) => value.trim()).filter(Boolean))].sort();
      if (step.confirmationPolicy === "observation_required" && observationIds.length === 0) throw new Error("该步骤必须先记录至少一个观察 ID");
      await responsePayload(await fetchImpl.call(globalThis, `/api/workspace/plans/${plan}/execution-sessions/${encodeURIComponent(stored.session.executionSessionId)}`, {
        method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: stored.revision, expectedHash: stored.recordHash, stepId, result: "confirmed",
          ...(observationIds.length ? { observationIds } : {}),
        }),
      }));
      await refresh(true);
    } catch (cause) { error = cause instanceof Error ? cause.message : "执行操作失败"; render(); }
  });

  const unsubscribe = options.subscribePlan(() => { void refresh(); });
  void refresh();
  return { refresh: () => refresh(true), dispose() { disposed = true; requestRevision += 1; unsubscribe(); host.replaceChildren(); } };
}
