import type { WorkspaceBackupSummary } from "../server/operations-production";

export interface BackupPanelController { refresh(): Promise<void>; dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}

function isSummary(value: unknown): value is WorkspaceBackupSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<WorkspaceBackupSummary>;
  return item.schemaVersion === "workspace-backup-summary-v1" && typeof item.backupId === "string"
    && typeof item.manifestHash === "string" && /^[a-f0-9]{64}$/.test(item.manifestHash)
    && typeof item.createdAt === "string" && typeof item.verifiedAt === "string"
    && Number.isSafeInteger(item.runtimeGeneration) && Number.isSafeInteger(item.entryCount) && item.result === "pass";
}

export function mountBackupPanel(host: HTMLElement, options: { readonly enabled: boolean; readonly fetchImpl?: typeof fetch }): BackupPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  let backups: WorkspaceBackupSummary[] = [];
  let error: string | null = null;
  let disposed = false;
  let generation = 0;
  const render = () => {
    host.replaceChildren(); host.hidden = !options.enabled;
    if (!options.enabled) return;
    host.className = "workspace-backup-panel"; host.dataset.backupPanel = "true";
    const header = element("header");
    const copy = element("div"); copy.append(element("p", "整站恢复"), element("h3", "完整备份"), element("span", "这里保存整个本地运行环境；单方案下载会使用独立的 .buildsim 入口。"));
    const refreshButton = element("button", "刷新状态"); refreshButton.type = "button"; refreshButton.dataset.refreshBackups = "true";
    header.append(copy, refreshButton); host.append(header);
    if (error) { const alert = element("p", error); alert.setAttribute("role", "alert"); host.append(alert); }
    const latest = backups[0];
    host.append(element("p", latest ? `最近校验：${latest.verifiedAt} · ${latest.entryCount} 个条目 · generation ${latest.runtimeGeneration}` : "还没有已校验的完整备份。"));
    if (latest) { const details = element("details"); details.append(element("summary", "查看最近备份标识"), element("small", `${latest.backupId} · manifest ${latest.manifestHash}`)); host.append(details); }
    const form = element("form"); form.dataset.createBackup = "true";
    const passwordLabel = element("label", "本次备份密码（至少 12 个 UTF-8 字节）");
    const password = element("input"); password.type = "password"; password.name = "password"; password.required = true; password.autocomplete = "new-password"; passwordLabel.append(password);
    const confirmationLabel = element("label");
    const confirmation = element("input"); confirmation.type = "checkbox"; confirmation.name = "confirmation"; confirmation.required = true;
    confirmationLabel.append(confirmation, document.createTextNode("我确认这是完整运行环境备份，不是单方案导出"));
    const submit = element("button", "创建并立即校验"); submit.type = "submit";
    const status = element("p"); status.setAttribute("role", "status"); status.dataset.backupStatus = "true";
    form.append(passwordLabel, confirmationLabel, submit, status); host.append(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        submit.disabled = true; status.textContent = "正在创建一致快照并校验…";
        try {
          const response = await fetchImpl("/api/workspace/backups", {
            method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ password: password.value, confirmation: confirmation.checked }),
          });
          const body: unknown = await response.json();
          if (!response.ok || !isSummary(body)) throw new Error("完整备份创建或校验失败");
          password.value = ""; confirmation.checked = false; backups = [body, ...backups.filter(({ manifestHash }) => manifestHash !== body.manifestHash)];
          render();
          host.querySelector<HTMLElement>("[data-backup-status]")!.textContent = `已创建并校验 ${body.backupId}`;
        } catch (cause) { status.textContent = cause instanceof Error ? cause.message : "完整备份创建失败"; submit.disabled = false; }
      })();
    });
  };
  const refresh = async () => {
    if (!options.enabled) { render(); return; }
    const current = ++generation; error = null;
    try {
      const response = await fetchImpl("/api/workspace/backups", { headers: { Accept: "application/json" } });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { backups?: unknown }).backups)
        || !(body as { backups: unknown[] }).backups.every(isSummary)) throw new Error("备份状态暂不可用");
      if (disposed || current !== generation) return;
      backups = (body as { backups: WorkspaceBackupSummary[] }).backups;
    } catch (cause) { if (!disposed && current === generation) { backups = []; error = cause instanceof Error ? cause.message : "备份状态暂不可用"; } }
    render();
  };
  host.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("[data-refresh-backups]")) void refresh(); });
  void refresh();
  return { refresh, dispose() { disposed = true; generation += 1; host.replaceChildren(); } };
}
