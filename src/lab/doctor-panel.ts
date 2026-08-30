import { validateDoctorReport, type DoctorReport } from "../doctor/contracts";

export interface DoctorPanelController { refresh(): Promise<void>; dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}

export function mountDoctorPanel(host: HTMLElement, options: { readonly enabled: boolean; readonly fetchImpl?: typeof fetch }): DoctorPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  let report: DoctorReport | null = null; let error: string | null = null;
  let diagnostic: { downloadUrl: string; bundleHash: string } | null = null;
  let repairPreview: { repairPlanId: string; planHash: string; impactSummary: string; backupId: string } | null = null;
  let repairPassword = ""; let repairStatus: string | null = null; let disposed = false; let generation = 0;
  const render = () => {
    host.replaceChildren(); host.hidden = !options.enabled;
    if (!options.enabled) return;
    host.className = "workspace-doctor-panel"; host.dataset.doctorPanel = "true";
    const header = element("header");
    const copy = element("div"); copy.append(element("p", "只读检查"), element("h3", "运行环境诊断"), element("span", "页面只投影服务端报告；不会自动修改文件。"));
    const actions = element("div"); actions.className = "workspace-inline-actions";
    const refreshButton = element("button", "重新检查"); refreshButton.type = "button"; refreshButton.dataset.refreshDoctor = "true";
    const diagnosticButton = element("button", "导出脱敏诊断包"); diagnosticButton.type = "button"; diagnosticButton.dataset.exportDiagnostic = "true";
    actions.append(refreshButton, diagnosticButton); header.append(copy, actions); host.append(header);
    if (error) { const alert = element("p", error); alert.setAttribute("role", "alert"); host.append(alert); }
    if (diagnostic) {
      const row = element("p", `诊断包已验证 · ${diagnostic.bundleHash.slice(0, 12)}…`);
      const link = element("a", "下载诊断包"); link.href = diagnostic.downloadUrl; link.download = "buildsim-diagnostic.json"; row.append(" ", link); host.append(row);
    }
    if (repairStatus) { const status = element("p", repairStatus); status.setAttribute("role", "status"); host.append(status); }
    if (!report) return;
    const summary = element("p", `总体 ${report.overall} · generation ${report.runtimeGeneration} · ${report.generatedAt}`); summary.dataset.doctorOverall = report.overall; host.append(summary);
    const list = element("div"); list.className = "workspace-doctor-checks";
    for (const check of report.checks) {
      const article = element("article"); article.dataset.doctorCheck = check.checkId; article.dataset.doctorStatus = check.status;
      article.append(element("strong", `${check.checkId} · ${check.status}`), element("p", check.summary));
      if (check.evidence.length > 0) { const evidence = element("ul"); for (const item of check.evidence) evidence.append(element("li", `${item.code}${item.redactedDisplay ? ` · ${item.redactedDisplay}` : ""}`)); article.append(evidence); }
      if (check.remediation) article.append(element("small", `${check.remediation}${check.repairable ? "；执行前仍需影响预览、完整备份和再次确认。" : ""}`));
      list.append(article);
    }
    host.append(list);
    const repairable = report.checks.some(({ checkId, status, repairable }) => (
      checkId === "runtime.permissions" && status === "fail" && repairable
    ));
    if (repairable && !repairPreview) {
      const form = element("form"); form.dataset.prepareDoctorRepair = "true";
      form.append(element("h4", "受治理修复"), element("p", "仅支持收紧本地运行目录权限。预览前会先创建并验证完整加密备份。"));
      const password = element("input"); password.type = "password"; password.required = true; password.minLength = 12;
      password.autocomplete = "new-password"; password.placeholder = "备份密码（至少 12 字节）"; password.value = repairPassword;
      const confirm = element("input"); confirm.type = "checkbox"; confirm.required = true;
      const label = element("label"); label.append(confirm, " 我确认先创建完整备份并生成影响预览");
      const submit = element("button", "预览修复影响"); submit.type = "submit";
      form.append(password, label, submit); host.append(form);
    }
    if (repairPreview) {
      const preview = element("article"); preview.dataset.doctorRepairPreview = "true";
      preview.append(
        element("h4", "修复影响预览"),
        element("p", repairPreview.impactSummary),
        element("p", `已验证备份 ${repairPreview.backupId}`),
      );
      const confirm = element("button", "再次确认并执行修复"); confirm.type = "button"; confirm.dataset.applyDoctorRepair = "true";
      const cancel = element("button", "取消"); cancel.type = "button"; cancel.dataset.cancelDoctorRepair = "true";
      preview.append(confirm, cancel); host.append(preview);
    }
  };
  const refresh = async () => {
    if (!options.enabled) { render(); return; }
    const current = ++generation; error = null;
    try {
      const response = await fetchImpl("/api/workspace/doctor", { headers: { Accept: "application/json" } });
      const body: unknown = await response.json(); const errors = validateDoctorReport(body);
      if (!response.ok || errors.length > 0) throw new Error("诊断报告暂不可用");
      if (disposed || current !== generation) return; report = body as DoctorReport;
    } catch (cause) { if (!disposed && current === generation) { report = null; error = cause instanceof Error ? cause.message : "诊断报告暂不可用"; } }
    render();
  };
  host.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-refresh-doctor]")) { void refresh(); return; }
    if ((event.target as HTMLElement).closest("[data-cancel-doctor-repair]")) {
      repairPreview = null; repairPassword = ""; repairStatus = "已取消修复；未修改运行数据。"; render(); return;
    }
    if ((event.target as HTMLElement).closest("[data-apply-doctor-repair]")) {
      if (!repairPreview || !repairPassword) return;
      void fetchImpl("/api/workspace/doctor/repairs/apply", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ repairPlanId: repairPreview.repairPlanId, planHash: repairPreview.planHash, password: repairPassword, confirmation: true }),
      }).then(async (response) => {
        const body = await response.json() as { applied?: unknown; idempotentReplay?: unknown };
        if (!response.ok || (body.applied !== true && body.idempotentReplay !== true)) throw new Error("修复执行失败");
        repairPreview = null; repairPassword = ""; repairStatus = body.idempotentReplay === true ? "修复已在此前完成。" : "修复已完成并重新运行诊断。";
        await refresh();
      }).catch((cause) => { error = cause instanceof Error ? cause.message : "修复执行失败"; render(); });
      return;
    }
    if (!(event.target as HTMLElement).closest("[data-export-diagnostic]")) return;
    void fetchImpl("/api/workspace/diagnostics", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: true }),
    }).then(async (response) => {
      const body = await response.json() as { downloadUrl?: unknown; bundleHash?: unknown };
      if (!response.ok || typeof body.downloadUrl !== "string" || typeof body.bundleHash !== "string") throw new Error("诊断包生成失败");
      diagnostic = { downloadUrl: body.downloadUrl, bundleHash: body.bundleHash }; error = null; render();
    }).catch((cause) => { error = cause instanceof Error ? cause.message : "诊断包生成失败"; render(); });
  });
  host.addEventListener("submit", (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>("[data-prepare-doctor-repair]");
    if (!form) return;
    event.preventDefault();
    const password = form.querySelector<HTMLInputElement>("input[type='password']");
    const confirmation = form.querySelector<HTMLInputElement>("input[type='checkbox']");
    if (!password || !confirmation?.checked || new TextEncoder().encode(password.value).byteLength < 12) return;
    repairPassword = password.value;
    void fetchImpl("/api/workspace/doctor/repairs/preview", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ actionIds: ["restrict-runtime-permissions"], password: repairPassword, confirmation: true }),
    }).then(async (response) => {
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok || typeof body.repairPlanId !== "string" || typeof body.planHash !== "string"
        || typeof body.impactSummary !== "string" || typeof body.backupId !== "string") throw new Error("修复预览生成失败");
      repairPreview = {
        repairPlanId: body.repairPlanId,
        planHash: body.planHash,
        impactSummary: body.impactSummary,
        backupId: body.backupId,
      };
      repairStatus = "已生成影响预览；执行前需要再次确认。"; error = null; render();
    }).catch((cause) => { repairPassword = ""; error = cause instanceof Error ? cause.message : "修复预览生成失败"; render(); });
  });
  void refresh();
  return { refresh, dispose() { disposed = true; generation += 1; host.replaceChildren(); } };
}
