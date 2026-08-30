import type { FirmwarePathEvaluation } from "../firmware/contracts";
import type { SystemProcedurePreview } from "../server/system-execution-production";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function firmwareReason(reason: FirmwarePathEvaluation["reason"]): string {
  const labels: Record<FirmwarePathEvaluation["reason"], string> = {
    already_at_target: "当前版本已经满足目标",
    path_available: "存在可复现的升级路径",
    requirements_missing: "仍缺临时硬件或文件",
    recovery_unavailable: "缺少恢复路径",
    cpu_support_unknown: "CPU 支持仍待确认",
    target_release_unknown: "目标版本仍待确认",
    target_does_not_support_cpu: "目标版本不支持当前 CPU",
    current_release_observation_missing: "尚未记录当前 BIOS 版本",
    current_release_observation_method_invalid: "当前版本识别方法不可用",
    current_release_unknown: "当前版本不在锁定版本图中",
    no_directed_path: "没有找到有向升级路径",
  };
  return labels[reason];
}

function leadCounts(value: { sata: number | null; molex: number | null; total: number | null } | null): string {
  if (value === null) return "待确定";
  return `共 ${value.total ?? "?"} 根（SATA ${value.sata ?? "?"} / Molex ${value.molex ?? "?"}）`;
}

function renderBackplaneCapacity(host: HTMLElement, preview: SystemProcedurePreview): void {
  const capacities = preview.backplaneCapacities ?? [];
  if (capacities.length === 0) return;
  const section = element("section");
  section.className = "workspace-backplane-capacity";
  section.dataset.backplaneCapacity = "true";
  section.append(
    element("h4", "背板与电源线束范围"),
    element("p", "当前方案需求与未来填满背板的能力分开显示；未来能力不会自动添加硬盘或线材。"),
  );
  for (const capacity of capacities) {
    const article = element("article");
    article.dataset.caseInstanceId = capacity.caseInstanceId;
    article.append(element("strong", `${capacity.caseInstanceId} · ${capacity.psuInstanceId ?? "电源未唯一确定"}`));
    const scopes = element("dl");
    const add = (label: string, value: string, status: string) => {
      const row = element("div");
      row.dataset.capacityStatus = status;
      row.append(element("dt", label), element("dd", value));
      scopes.append(row);
    };
    add(
      "当前盘位需求",
      `${capacity.currentDemand.occupiedBayCount}/${capacity.currentDemand.totalBayCount} 个盘位 · 需要 ${leadCounts(capacity.currentDemand.requiredPowerLeads)}${capacity.currentDemand.pendingStorageInstanceIds.length ? ` · ${capacity.currentDemand.pendingStorageInstanceIds.length} 个存储实例待定盘位` : ""}`,
      capacity.currentDemand.status,
    );
    add(
      "全背板未来能力",
      `${capacity.fullBackplaneCapability.occupiedBayCount}/${capacity.fullBackplaneCapability.totalBayCount} 个盘位 · 需要 ${leadCounts(capacity.fullBackplaneCapability.requiredPowerLeads)} · 电源已确认 ${leadCounts(capacity.fullBackplaneCapability.confirmedPsuPowerLeads)}`,
      capacity.fullBackplaneCapability.status,
    );
    article.append(scopes, element("small", capacity.notes.join(" ")));
    section.append(article);
  }
  host.append(section);
}

export function renderFirmwarePlan(host: HTMLElement, evaluations: readonly FirmwarePathEvaluation[]): void {
  const section = element("section");
  section.className = "workspace-firmware-plan";
  section.dataset.firmwarePlan = "true";
  section.append(element("h4", "BIOS / 固件路径"), element("p", "只展示锁定版本图中的有向路径；不会提供自动刷写按钮。"));
  if (evaluations.length === 0) section.append(element("p", "当前保存版本没有可执行的固件路径。"));
  for (const evaluation of evaluations) {
    const article = element("article");
    article.dataset.firmwareInstance = evaluation.instanceId;
    article.dataset.firmwareVerdict = evaluation.verdict;
    article.append(
      element("strong", `${evaluation.instanceId} · ${evaluation.verdict === "pass" ? "路径可用" : "暂不可执行"}`),
      element("p", firmwareReason(evaluation.reason)),
      element("small", `当前 ${evaluation.currentObservation?.releaseFactId ?? "未知"} · 最低 ${evaluation.minimumReleaseFactId ?? "未知"} · 目标 ${evaluation.targetReleaseFactId ?? "未知"}`),
    );
    if (evaluation.selectedTransitions.length > 0) {
      const list = element("ol");
      for (const transition of evaluation.selectedTransitions) {
        const item = element("li");
        item.append(
          element("strong", `${transition.fromReleaseFactId} → ${transition.toReleaseFactId}`),
          element("span", `${transition.method} · 文件 ${transition.requiredFilename} · 介质 ${transition.mediaFormat}`),
          element("small", transition.resetsSettings ? "升级后需要重新核对设置" : "不会声明自动保留所有设置"),
        );
        list.append(item);
      }
      article.append(list);
    }
    if (evaluation.missingRequirementIds.length > 0 || evaluation.missingPowerPrerequisiteFactIds.length > 0) {
      const missing = element("ul");
      for (const id of evaluation.missingRequirementIds) missing.append(element("li", `待满足：${id}`));
      for (const id of evaluation.missingPowerPrerequisiteFactIds) missing.append(element("li", `待确认供电前提：${id}`));
      article.append(missing);
    }
    const recovery = element("p", `恢复能力：${evaluation.recovery.status}`);
    recovery.dataset.firmwareRecovery = evaluation.recovery.status;
    article.append(recovery);
    section.append(article);
  }
  host.append(section);
}

export function renderProcedurePreview(host: HTMLElement, preview: SystemProcedurePreview): void {
  const section = element("section");
  section.className = "workspace-procedure-preview";
  section.dataset.procedurePreview = "true";
  const summary = element("article");
  summary.className = "workspace-system-procedure-summary";
  summary.append(
    element("strong", preview.mode === "preparation_only"
      ? "仅准备 / 测量 / 补充资料 · 不允许首次通电"
      : `${preview.profile?.label ?? "系统未选择"} · 系统可用性 ${preview.systemEvaluation?.verdict ?? "unknown"}`),
    element("p", `版本 ${preview.planVersionId} · evaluation ${preview.evaluationHash.slice(0, 12)}… · lock ${preview.evaluationLockHash.slice(0, 12)}…`),
  );
  if (preview.blockers.length > 0) {
    const list = element("ul");
    for (const blocker of preview.blockers) list.append(element("li", blocker));
    summary.append(list);
  }
  section.append(summary);
  const procedure = preview.generated?.procedure;
  if (procedure) {
    const phaseList = element("ol");
    phaseList.dataset.procedurePhases = "true";
    for (const phase of procedure.phases) {
      const steps = procedure.steps.filter((step) => step.phase === phase);
      const item = element("li");
      item.append(element("strong", phase), element("span", `${steps.length} 个步骤`));
      const stopConditions = [...new Set(steps.flatMap((step) => step.stopConditions))];
      if (stopConditions.length > 0) item.append(element("small", `停止条件：${stopConditions.join("；")}`));
      phaseList.append(item);
    }
    section.append(phaseList);
  } else section.append(element("p", "当前锁定输入仍有阻断，不能建立执行会话。"));
  host.append(section);
  renderBackplaneCapacity(host, preview);
  renderFirmwarePlan(host, preview.firmwareEvaluations ?? []);
}
