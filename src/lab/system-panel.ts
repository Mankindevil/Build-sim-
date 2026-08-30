import type { ProgressiveBuildEvaluation } from "../compatibility/contracts";
import type { BuildConfigV3, LogicalLayoutSelection, SystemSelection, VdevTopology } from "../topology/contracts";
import { recommendSystemForIntent, userSystemSelection } from "../system-profiles/defaults";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../system-profiles/registry";
import { createHelpButton } from "./help-link";

export interface SystemPanelOptions {
  readonly evaluation: ProgressiveBuildEvaluation | null;
  readonly onSelect: (selection: SystemSelection) => void;
  readonly onLayoutsChange?: (layouts: LogicalLayoutSelection[]) => void;
}

const VDEV_MINIMUM: Readonly<Record<VdevTopology, number>> = {
  stripe: 1, mirror: 2, raidz1: 3, raidz2: 4, raidz3: 5,
};

function selectedValues(select: HTMLSelectElement): string[] {
  return [...select.selectedOptions].map(({ value }) => value).filter(Boolean).sort();
}

function appendNasLayoutEditor(host: HTMLElement, config: BuildConfigV3, onChange: (layouts: LogicalLayoutSelection[]) => void): void {
  const disks = config.components.filter(({ kind }) => kind === "storage_drive").sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const existing = config.logicalLayouts[0] ?? null;
  const editor = document.createElement("article"); editor.className = "workspace-editor-field workspace-nas-layout-editor"; editor.dataset.nasLayoutEditor = "true";
  const heading = document.createElement("strong"); heading.textContent = "TrueNAS 物理盘与 vdev 选择";
  const warning = document.createElement("p"); warning.textContent = "这里只保存磁盘实例和 vdev 结构；容量、容错、控制器路径与风险由锁定事实派生。RAID/RAIDZ 不是备份。";
  editor.append(heading, warning);
  if (disks.length === 0) {
    const empty = document.createElement("p"); empty.textContent = "先在组件拓扑中加入并解析存储盘，布局不会自动添加购买项。"; editor.append(empty); host.append(editor); return;
  }
  const controls = document.createElement("div"); controls.className = "workspace-nas-layout-controls";
  const makeLabel = (text: string, select: HTMLSelectElement) => {
    const label = document.createElement("label"); const span = document.createElement("span"); span.textContent = text; label.append(span, select); return label;
  };
  const boot = document.createElement("select"); boot.dataset.nasBootDisk = "true"; boot.setAttribute("aria-label", "选择 TrueNAS 启动盘");
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "请选择启动盘"; boot.append(blank);
  const topology = document.createElement("select"); topology.dataset.nasTopology = "true"; topology.setAttribute("aria-label", "选择 TrueNAS vdev 类型");
  for (const value of ["mirror", "raidz1", "raidz2", "raidz3", "stripe"] as const) {
    const option = document.createElement("option"); option.value = value; option.textContent = value.toUpperCase(); option.selected = value === (existing?.vdevs[0]?.topology ?? "mirror"); topology.append(option);
  }
  const data = document.createElement("select"); data.multiple = true; data.size = Math.min(8, Math.max(3, disks.length)); data.dataset.nasDataDisks = "true"; data.setAttribute("aria-label", "选择 TrueNAS 数据盘");
  const spare = document.createElement("select"); spare.multiple = true; spare.size = data.size; spare.dataset.nasSpareDisks = "true"; spare.setAttribute("aria-label", "选择 TrueNAS 热备盘");
  const bootId = existing?.bootPoolDiskIds[0] ?? "";
  const dataIds = new Set(existing?.vdevs[0]?.diskInstanceIds ?? []);
  const spareIds = new Set(existing?.spareDiskIds ?? []);
  for (const disk of disks) {
    const label = disk.identity.status === "resolved" ? `${disk.instanceId} · ${disk.identity.skuId}` : `${disk.instanceId} · 身份待解析`;
    const bootOption = document.createElement("option"); bootOption.value = disk.instanceId; bootOption.textContent = label; bootOption.selected = disk.instanceId === bootId; boot.append(bootOption);
    const dataOption = document.createElement("option"); dataOption.value = disk.instanceId; dataOption.textContent = label; dataOption.selected = dataIds.has(disk.instanceId); data.append(dataOption);
    const spareOption = document.createElement("option"); spareOption.value = disk.instanceId; spareOption.textContent = label; spareOption.selected = spareIds.has(disk.instanceId); spare.append(spareOption);
  }
  controls.append(makeLabel("启动池磁盘", boot), makeLabel("数据 vdev 类型", topology), makeLabel("数据盘（可多选）", data), makeLabel("热备盘（可多选）", spare));
  const status = document.createElement("p"); status.dataset.nasLayoutStatus = "true"; status.setAttribute("role", "alert");
  const save = document.createElement("button"); save.type = "button"; save.dataset.saveNasLayout = "true"; save.textContent = "保存布局选择";
  save.addEventListener("click", () => {
    const bootDiskId = boot.value;
    const dataDiskIds = selectedValues(data);
    const spareDiskIds = selectedValues(spare);
    const chosen = [bootDiskId, ...dataDiskIds, ...spareDiskIds].filter(Boolean);
    const selectedTopology = topology.value as VdevTopology;
    if (!bootDiskId) { status.textContent = "请选择一个启动盘。"; return; }
    if (dataDiskIds.length < VDEV_MINIMUM[selectedTopology]) {
      status.textContent = `${selectedTopology.toUpperCase()} 至少需要 ${VDEV_MINIMUM[selectedTopology]} 块数据盘。`; return;
    }
    if (new Set(chosen).size !== chosen.length) { status.textContent = "同一磁盘不能同时属于启动池、数据 vdev 或热备。"; return; }
    const layout: LogicalLayoutSelection = {
      layoutId: existing?.layoutId ?? `layout.${config.id}.truenas-primary`,
      bootPoolDiskIds: [bootDiskId],
      vdevs: [{ vdevId: existing?.vdevs[0]?.vdevId ?? "vdev.data-primary", topology: selectedTopology, diskInstanceIds: dataDiskIds }],
      spareDiskIds,
    };
    status.textContent = "布局选择已提交；容量与控制器路径将在受治理评估后显示。";
    onChange([layout]);
  });
  editor.append(controls, save, status); host.append(editor);
}

export function renderSystemPanel(host: HTMLElement, config: BuildConfigV3, options: SystemPanelOptions): void {
  host.replaceChildren();
  host.className = "workspace-editor-group workspace-system-panel";
  host.dataset.systemPanel = "true";
  const intent = config.intent?.state === "answered" ? config.intent.value : null;
  const recommendation = intent === null ? null : recommendSystemForIntent(intent);
  const selectedId = config.system?.profileId ?? recommendation?.selection.profileId ?? "";
  const selected = selectedId ? DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(selectedId) : null;
  const header = document.createElement("header");
  const badge = document.createElement("span"); badge.textContent = "系统";
  const copy = document.createElement("div");
  const title = document.createElement("h3"); title.textContent = "目标系统与首次启动";
  const description = document.createElement("p"); description.textContent = "系统可用性独立于机械兼容；缺驱动、启动链或固件路径时不会显示通过。";
  copy.append(title, description); header.append(badge, copy); host.append(header);
  const row = document.createElement("div"); row.className = "workspace-field-grid";
  const field = document.createElement("article"); field.className = "workspace-editor-field"; field.dataset.editorField = "system";
  const label = document.createElement("label");
  const labelText = document.createElement("span"); labelText.textContent = "目标系统";
  const select = document.createElement("select"); select.dataset.v3SystemProfile = "true"; select.setAttribute("aria-label", "选择目标系统");
  for (const profile of DEFAULT_SYSTEM_PROFILE_REGISTRY.list()) {
    const option = document.createElement("option"); option.value = profile.profileId; option.textContent = profile.label;
    option.selected = profile.profileId === selectedId; select.append(option);
  }
  label.append(labelText, select); field.append(label);
  const source = document.createElement("p");
  source.textContent = config.system?.source === "user" ? "用户选择已锁定；刷新、保存和重评估不会覆盖。"
    : recommendation?.reason ?? "先记录用途，系统才会给出可解释的默认建议。";
  field.append(source);
  if (selected) field.append(createHelpButton(selected.helpRef, selected.label));
  const status = document.createElement("article"); status.className = "workspace-editor-field";
  const mechanical = options.evaluation?.readiness.compatibilityVerdict ?? "unknown";
  const system = options.evaluation?.readiness.systemAvailabilityVerdict ?? "unknown";
  const heading = document.createElement("strong"); heading.textContent = "分开显示的结论";
  const values = document.createElement("p"); values.textContent = `机械兼容：${mechanical} · 系统可用：${system}`;
  status.append(heading, values); row.append(field, status); host.append(row);
  if (selected?.profileId === "system.truenas-scale" && options.onLayoutsChange) {
    appendNasLayoutEditor(host, config, options.onLayoutsChange);
  }
  select.addEventListener("change", () => options.onSelect(userSystemSelection(DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(select.value))));
}
