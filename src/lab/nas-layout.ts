import type { ProductionStorageLayoutProjection } from "../storage/production";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value; let index = 0;
  while (amount >= 1_000 && index < units.length - 1) { amount /= 1_000; index += 1; }
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

export function renderNasLayouts(host: HTMLElement, layouts: readonly ProductionStorageLayoutProjection[]): void {
  const section = element("section");
  section.className = "workspace-system-storage";
  section.dataset.systemStorageLayout = "true";
  section.append(element("h4", "TrueNAS 存储布局"), element("p", "RAID/RAIDZ 不是备份。容量、容错和物理路径来自该保存版本的锁定输入。"));
  if (layouts.length === 0) section.append(element("p", "尚未保存明确的启动池和数据 vdev 选择。"));
  for (const layout of layouts) {
    const article = element("article"); article.dataset.storageLayout = layout.layoutId;
    article.append(element("strong", layout.layoutId));
    if (layout.status === "blocked") {
      const list = element("ul");
      for (const reason of layout.reasons) list.append(element("li", reason));
      article.append(element("p", "当前布局不可执行："), list);
    } else {
      article.append(element("p", `可用容量 ${bytes(layout.evaluation.usableBytes.min)} · ${layout.evaluation.assumptions.join(" ")}`));
      for (const vdev of layout.evaluation.vdevResults) {
        const card = element("div"); card.className = "workspace-system-vdev"; card.dataset.vdevId = vdev.vdevId;
        card.append(
          element("strong", `${vdev.vdevId} · 可容忍 ${vdev.faultTolerance.diskFailures} 块盘故障`),
          element("p", `可用 ${bytes(vdev.estimatedUsableBytes.min)} · 混盘损失 ${bytes(vdev.mixedCapacityLossBytes ?? 0)}`),
        );
        const paths = element("ul");
        for (const path of vdev.controllerPaths ?? []) paths.append(element("li", `${path.diskInstanceId} → ${path.controllerInstanceId}/${path.controllerPortId} (${path.transport})`));
        card.append(paths); article.append(card);
      }
    }
    section.append(article);
  }
  host.append(section);
}
