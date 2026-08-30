export const STORAGE_HELP = Object.freeze({
  capacity: {
    helpRef: "help.storage.capacity",
    title: "可用容量",
    body: "按活动布局中最小磁盘容量与校验/镜像宽度派生；混盘的多余容量不会被计入。",
  },
  faultTolerance: {
    helpRef: "help.storage.fault-tolerance",
    title: "容错不是备份",
    body: "RAID/RAIDZ 不是备份；容错不能替代离线、异地或版本化备份。",
  },
  destructive: {
    helpRef: "help.storage.destructive-action",
    title: "破坏性操作确认",
    body: "安装或清除前必须用当前观察唯一定位每块物理盘，并绑定当前方案、修订与 procedure safety hash。",
  },
  expansion: {
    helpRef: "help.storage.expansion",
    title: "扩容与重建风险",
    body: "扩容按整个 vdev 或逐盘替换建模；重建期间故障暴露、介质差异和控制器路径必须重新评估。",
  },
} as const);

export type StorageHelpRef = (typeof STORAGE_HELP)[keyof typeof STORAGE_HELP]["helpRef"];

export function storageHelp(ref: string): (typeof STORAGE_HELP)[keyof typeof STORAGE_HELP] | null {
  return Object.values(STORAGE_HELP).find(({ helpRef }) => helpRef === ref) ?? null;
}
