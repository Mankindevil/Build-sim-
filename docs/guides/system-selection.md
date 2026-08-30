# 目标系统选择

目标系统不是机械兼容的别名。机箱、主板、处理器和线材“装得上”，不代表固件路径、启动设备、驱动和安装目标已经可用。Build Sim 因此把机械兼容与系统可用性分开显示，并让两者引用相同的受治理说明条目。

## Windows 11

- 适合普通 PC 与工作站的默认建议；默认记录为 `source: defaulted`，不会添加任何购买项。
- 用户选择后记录为 `source: user` 且锁定，刷新、保存、版本恢复和 Agent 重评估都不能覆盖。
- 首启检查 UEFI、TPM、Secure Boot、受支持平台、启动介质、存储/网络/显示驱动，以及当前可执行的固件路径。
- 修改固件或安全设置前先确认 BitLocker/设备加密恢复密钥。

说明标识：`help.system.windows-11`。

## TrueNAS SCALE

- 适合 NAS intent 的默认建议。
- 启动池与数据 vdev 必须分离；每块盘只能属于一个活动角色。
- 数据盘需要直接、可审计的 AHCI/HBA IT 路径，不把硬件 RAID 的不透明虚拟盘当作直接磁盘。
- 安装或清除前必须通过当前方案内的观察唯一定位每块物理盘，并单独确认绑定当前 `procedureSafetyHash` 的破坏性操作。
- RAID/RAIDZ 不是备份。

说明标识：`help.system.truenas-scale`。

## 主流 Linux 桌面

- 是 PC/工作站的相关替代方案，不在用户未选择发行版和版本时假定驱动可用。
- 启动、存储、网络和显示路径仍必须由所选发行版/版本的资料证明。

说明标识：`help.system.linux-desktop`。

## Unraid

- 可作为 NAS 场景的比较对象，但首发 registry 尚未把它作为可执行 profile。
- 未登记 profile 不会被偷偷替换为 TrueNAS，也不能得到系统可用 verdict。

## Proxmox VE

- 面向虚拟化/超融合用途；需要可执行固件路径、虚拟化/IOMMU 设置、启动和存储/网络驱动闭包。
- 若存储由来宾系统直通管理，控制器与物理盘路径必须明确，不能与宿主安装目标混淆。

说明标识：`help.system.proxmox-ve`。

## 比较原则

1. 默认建议必须可解释、可修改；用户选择优先。
2. 系统版本是精确事实，不把“当前最新”写死在代码里；版本变化走事实更新提示。
3. 缺关键驱动、启动链或固件路径时结果为 `blocked`/`fail`，不显示绿色。
4. 容量、容错、扩容与风险是从 `LogicalLayoutSelection` 派生的评估，不写回配置。
5. UI 问号和 Agent 回答使用同一 `helpRef`，避免旁路文案漂移。
