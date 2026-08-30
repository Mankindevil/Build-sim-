import type { PortableExportSummary, PortableImportPreview, PortableImportResult } from "../portability/contracts";

export interface PortabilityPanelController { dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exportSummary(value: unknown): value is PortableExportSummary {
  return record(value) && value.schemaVersion === "portable-export-summary-v1" && typeof value.exportId === "string"
    && typeof value.planId === "string" && typeof value.manifestHash === "string" && typeof value.downloadUrl === "string"
    && (value.portableProfile === "slim" || value.portableProfile === "complete")
    && (value.resultMode === "exact_replay" || value.resultMode === "reevaluate_with_current_runtime");
}
function importPreview(value: unknown): value is PortableImportPreview {
  return record(value) && value.schemaVersion === "portable-import-preview-v1" && typeof value.uploadId === "string"
    && typeof value.sourcePlanId === "string" && typeof value.sourcePlanName === "string" && typeof value.manifestHash === "string"
    && record(value.importPlan) && typeof value.importPlan.action === "string";
}
function importResult(value: unknown): value is PortableImportResult {
  return record(value) && value.schemaVersion === "portable-import-result-v1" && typeof value.importedPlanId === "string"
    && typeof value.manifestHash === "string" && Number.isSafeInteger(value.runtimeGeneration);
}

export function mountPortabilityPanel(host: HTMLElement, options: {
  readonly enabled: boolean;
  readonly getPlanId: () => string | null;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly fetchImpl?: typeof fetch;
  readonly onImported?: (planId: string) => void | Promise<void>;
}): PortabilityPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  let disposed = false; let preview: PortableImportPreview | null = null; let selectedFile: File | null = null;
  const render = () => {
    host.replaceChildren(); host.hidden = !options.enabled; if (!options.enabled) return;
    host.className = "workspace-portability-panel"; host.dataset.portabilityPanel = "true";
    const planId = options.getPlanId();
    const header = element("header"); const copy = element("div");
    copy.append(element("p", "单方案便携包"), element("h3", ".buildsim 导出与导入"), element("span", "完整模式携带精确重放所需材料；轻量模式会在目标环境重新评估。两者都与整站备份分开。"));
    header.append(copy); host.append(header);
    if (!planId) { host.append(element("p", "请先选择一个方案。")); return; }

    const exportForm = element("form"); exportForm.dataset.portableExport = "true";
    const profile = element("select"); profile.name = "portableProfile";
    for (const [value, label] of [["complete", "完整 · 可离线精确重放"], ["slim", "轻量 · 按目标环境重新评估"]] as const) { const option = element("option", label); option.value = value; profile.append(option); }
    const profileLabel = element("label", "导出模式"); profileLabel.append(profile);
    const redacted = element("input"); redacted.type = "checkbox"; redacted.name = "redacted"; redacted.checked = true;
    const redactedLabel = element("label"); redactedLabel.append(redacted, document.createTextNode("脱敏：不带仅供审计的原始材料"));
    const exportPassword = element("input"); exportPassword.type = "password"; exportPassword.name = "exportPassword"; exportPassword.required = true; exportPassword.autocomplete = "new-password";
    const exportPasswordLabel = element("label", "包密码（至少 12 个 UTF-8 字节）"); exportPasswordLabel.append(exportPassword);
    const exportConfirm = element("input"); exportConfirm.type = "checkbox"; exportConfirm.name = "exportConfirmation"; exportConfirm.required = true;
    const exportConfirmLabel = element("label"); exportConfirmLabel.append(exportConfirm, document.createTextNode("我确认导出当前方案，不是创建整站恢复备份"));
    const exportButton = element("button", "创建方案包"); exportButton.type = "submit";
    const exportStatus = element("p"); exportStatus.setAttribute("role", "status"); exportStatus.dataset.portableExportStatus = "true";
    exportForm.append(profileLabel, redactedLabel, exportPasswordLabel, exportConfirmLabel, exportButton, exportStatus); host.append(exportForm);
    exportForm.addEventListener("submit", (event) => {
      event.preventDefault(); void (async () => {
        exportButton.disabled = true; exportStatus.textContent = "正在计算方案闭包并校验…";
        try {
          const response = await fetchImpl("/api/workspace/portability/exports", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ planId, portableProfile: profile.value, redacted: redacted.checked, password: exportPassword.value, confirmation: exportConfirm.checked }) });
          const body: unknown = await response.json(); if (!response.ok || !exportSummary(body)) throw new Error("方案包创建失败");
          exportPassword.value = ""; exportConfirm.checked = false; exportStatus.replaceChildren();
          const link = element("a", `下载 ${body.portableProfile === "complete" ? "完整" : "轻量"} .buildsim`); link.href = body.downloadUrl; link.download = `${body.planId}.buildsim`; link.rel = "nofollow";
          exportStatus.append(document.createTextNode(body.resultMode === "exact_replay" ? "闭包校验通过。" : "导入后将重新评估。"), link);
        } catch (error) { exportStatus.textContent = error instanceof Error ? error.message : "方案包创建失败"; }
        finally { exportButton.disabled = false; }
      })();
    });

    const importForm = element("form"); importForm.dataset.portableImport = "true";
    const file = element("input"); file.type = "file"; file.accept = ".buildsim,application/vnd.buildsim.plan+json"; file.required = true;
    const fileLabel = element("label", "选择 .buildsim 文件"); fileLabel.append(file);
    const importPassword = element("input"); importPassword.type = "password"; importPassword.required = true; importPassword.autocomplete = "current-password";
    const importPasswordLabel = element("label", "包密码"); importPasswordLabel.append(importPassword);
    const conflict = element("select");
    for (const [value, label] of [["reject", "发现冲突时停止"], ["copy_as_new_plan", "冲突时复制为新方案"], ["replace_after_backup", "先完整备份再替换"]] as const) { const option = element("option", label); option.value = value; conflict.append(option); }
    const conflictLabel = element("label", "冲突策略"); conflictLabel.append(conflict);
    const newPlanId = element("input"); newPlanId.placeholder = "例如 plan-imported-copy"; newPlanId.pattern = "[a-z0-9][a-z0-9-]{7,79}";
    const newPlanLabel = element("label", "复制后的方案 ID（仅复制策略）"); newPlanLabel.append(newPlanId);
    const dryRun = element("button", "先预检，不写入"); dryRun.type = "submit";
    const importStatus = element("p"); importStatus.setAttribute("role", "status"); importStatus.dataset.portableImportStatus = "true";
    const apply = element("button", "确认导入"); apply.type = "button"; apply.disabled = !preview || preview.importPlan.action === "reject";
    const backupPassword = element("input"); backupPassword.type = "password"; backupPassword.autocomplete = "new-password"; backupPassword.placeholder = "替换策略需要新的完整备份密码";
    const backupPasswordLabel = element("label", "替换前完整备份密码"); backupPasswordLabel.append(backupPassword);
    if (preview) importStatus.textContent = preview.importPlan.action === "reject"
      ? `预检发现 ${preview.importPlan.conflicts.length} 个冲突；当前策略不会写入。`
      : `${preview.sourcePlanName}：${preview.importPlan.action} · ${preview.importPlan.resultMode === "exact_replay" ? "精确重放" : "导入后重新评估"}`;
    importForm.append(fileLabel, importPasswordLabel, conflictLabel, newPlanLabel, dryRun, importStatus, backupPasswordLabel, apply); host.append(importForm);
    file.addEventListener("change", () => { selectedFile = file.files?.[0] ?? null; preview = null; apply.disabled = true; importStatus.textContent = ""; });
    importForm.addEventListener("submit", (event) => {
      event.preventDefault(); void (async () => {
        selectedFile = file.files?.[0] ?? selectedFile; if (!selectedFile) { importStatus.textContent = "请选择 .buildsim 文件"; return; }
        dryRun.disabled = true; importStatus.textContent = "正在验证校验和、引用和冲突…";
        try {
          const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/vnd.buildsim.plan+json", "X-Buildsim-Package-Password": importPassword.value, "X-Buildsim-Conflict-Strategy": conflict.value };
          if (newPlanId.value) headers["X-Buildsim-New-Plan-Id"] = newPlanId.value;
          const response = await fetchImpl("/api/workspace/portability/imports/dry-run", { method: "POST", headers, body: selectedFile });
          const body: unknown = await response.json(); if (!response.ok || !importPreview(body)) throw new Error(record(body) && typeof body.message === "string" ? body.message : "方案包预检失败");
          preview = body; apply.disabled = body.importPlan.action === "reject";
          importStatus.textContent = body.importPlan.action === "reject" ? `预检发现 ${body.importPlan.conflicts.length} 个冲突；不会写入。` : `预检通过：${body.importPlan.resultMode === "exact_replay" ? "可精确重放" : "导入后重新评估"}`;
        } catch (error) { preview = null; apply.disabled = true; importStatus.textContent = error instanceof Error ? error.message : "方案包预检失败"; }
        finally { dryRun.disabled = false; }
      })();
    });
    apply.addEventListener("click", () => { void (async () => {
      if (!preview) return; apply.disabled = true; importStatus.textContent = "正在创建新运行代并验证，完成前不会切换…";
      try {
        const response = await fetchImpl("/api/workspace/portability/imports/apply", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ uploadId: preview.uploadId, password: importPassword.value, expectedManifestHash: preview.manifestHash, strategy: conflict.value, ...(newPlanId.value ? { newPlanId: newPlanId.value } : {}), confirmation: true, ...(conflict.value === "replace_after_backup" ? { backupPassword: backupPassword.value } : {}) }) });
        const body: unknown = await response.json(); if (!response.ok || !importResult(body)) throw new Error(record(body) && typeof body.message === "string" ? body.message : "方案导入失败");
        importPassword.value = ""; backupPassword.value = ""; importStatus.textContent = `已导入 ${body.importedPlanId}；runtime generation ${body.runtimeGeneration}`;
        await options.onImported?.(body.importedPlanId);
      } catch (error) { importStatus.textContent = error instanceof Error ? error.message : "方案导入失败"; apply.disabled = false; }
    })(); });
  };
  const unsubscribe = options.subscribe?.(() => { if (!disposed) render(); }) ?? (() => undefined);
  render();
  return { dispose() { disposed = true; unsubscribe(); host.replaceChildren(); } };
}
