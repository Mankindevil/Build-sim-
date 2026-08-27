# Build Sim 通用消费级硬件平台 Follow Plan

日期：2026-08-27

状态：待执行

阶段编号：`U0-U12`

适用范围：本地部署、单用户、PC / 工作站 / NAS 内部硬件装机规划

建议分支：`codex/universal-hardware-platform`

关联现有计划：

- [Build Sim 升级优化 Follow Plan](./2026-08-23-build-sim-upgrade-follow-plan.md)
- [Agent 官网目录补齐 Follow Plan](./2026-08-24-agent-official-catalog-enrichment-follow-plan.md)
- [方案全生命周期平台重设计 Follow Plan](./2026-08-25-build-sim-plan-lifecycle-platform-redesign-follow-plan.md)

本文件是一份可以由后续 Agent 或开发者逐项 follow、逐阶段测试、逐阶段回滚的实施计划。它描述的是目标和待完成工作，不代表这些能力已经上线。

本计划不继续把 JONSBO N6 当作产品边界。N6 只保留为第一套回归夹具和第一份完整 case adapter；所有新核心模块都必须面向普通 PC、工作站、NAS 以及后续未预置机箱。

---

## 0. 最终目标

完成本计划后，平台应当支持以下完整路径：

1. 用户新建一个真正空白的方案；空白方案不包含任何隐藏机箱、主板、SSD、线材、BOM 或采购状态。
2. 用户可用自然语言逐步描述已有想法或计划，例如机箱、主板、CPU、两块同型号 SSD 和电源；每轮只保存本轮已经明确的事实，不要求一次补齐整机。
3. Agent 将用户原话解析成独立部件实例；型号尚未确认时保留原话并继续搜索，不用默认 SKU 顶替。
4. 对未预置硬件，Agent 依次搜索官网产品页、官网手册、支持页、QVL、BIOS/固件页；官网缺失时再搜索合格第三方证据，最后才允许产生可重放的 Agent 推断。
5. Agent 必须解释为什么未取得官网事实：官网没有公开、找到页面但缺少字段、身份不明确、访问受阻、解析失败、官网来源冲突或搜索已经穷尽。
6. 每一条参与兼容、3D、走线、热、噪音、价格和推荐的事实都能追溯到不可变证据，或追溯到完整推导链。
7. 平台按当前已知子图渐进评估，不因内存、散热器、GPU 或其他部件尚未选择而清空已有证据、价格、BOM、3D 或局部兼容结论。
8. 兼容性覆盖机械、电气、接口、卡槽、固件/BIOS、启动链路和目标操作系统；目标是装好后能够真实通电、启动并运行目标系统。
9. 未支持机箱不继承 N6 数据。平台从该机箱官网资料生成可审计的 provisional case model；只有空间余量大于推断误差、公差和服务余量时才允许通过相关空间判定。
10. 3D 的主要目标是装配与走线预演：端点、接口方向、具体线材、线长、弯折、穿线孔容量、侧板净空、服务空间和装配顺序必须可解释。
11. 热模型输出基于工作负载和输入假设的保守区间；噪音只计算可标准化的硬件声源，不声称预测房间实际听感。
12. 采购只关注中国平台、优先全新；一条有效报价可低置信展示，两条以上可形成市场区间，并提供精确变体和购买链接。
13. 推荐先经过安全与兼容硬门槛，再按照用户确认的性价比哲学排序，展示排名依据、经济方案、平衡方案和长期方案。
14. 官网事实出现更新时，平台展示具体差异和影响，用户决定是否让当前方案采用；决定可记忆、可撤销，旧方案仍可复现。
15. 在推荐具体部件前先建立结构化需求/工作负载模型，覆盖预算、用途、性能目标、容量、冗余、网络吞吐、体积、噪音、功耗、扩展周期以及硬约束/偏好；显示器等外设仍不进入装机拓扑。
16. 平台能够从空白需求出发求解整机，而不只对单件 SKU 排名；求解结果至少给出经济、平衡、长期三套可启动方案，并证明全部硬约束已满足。
17. 用户可以从任意不可变版本建立 what-if 分支，对预算、系统、机箱、GPU、存储布局等做情景修改，并并排查看成本、兼容、热噪、走线、风险和升级路径差异。
18. 随盒附件、螺丝、螺柱、转接架、支架、线材和装机工具成为一等数据；平台区分“随盒已含”“需要另购”“需复用但未确认”，避免硬件都选齐却无法装配。
19. 平台按当前 topology、目标系统和机箱 assembly constraints 生成个性化装机与首次通电指南，包含装配顺序、接线检查、最小化首启、故障分支和完成证据。
20. BIOS/固件不只检查最低版本，还检查当前版本如何获知、是否支持无 CPU 刷写、所需临时 CPU/内存/显示路径、文件系统与文件名、断电风险、设置项和回退条件。
21. NAS/TrueNAS 方案必须具有存储布局规划器，显式建模 boot pool、data vdev、mirror/RAIDZ、可用容量、冗余、故障域、HBA/直通、盘型风险、扩容路径和破坏性操作警告。
22. 用户的照片、量尺、接口观察、BIOS 版本和装配验证可作为 plan/subject-revision-scoped `user_observation` 证据，记录方法、时间、误差和附件 hash；换槽/接口/固件后自动失效，不得外推为全局产品事实。
23. 价格能力包含不可变历史、目标价、观察清单和买/等建议；建议必须显示时间窗、样本覆盖、当前历史位置、促销条件和不确定性，而不是只看当前最低价。
24. 方案能够导出可携带的 `.buildsim` 包；本地部署能够做完整备份、校验、演练恢复和版本兼容检查，恢复后仍能重现原结论。
25. 联网搜证、PDF 解析、价格刷新、adapter 生成、全方案求解和全量重算使用可持久后台任务；刷新/重启后可继续、重试或取消，并保留进度、错误和产物引用。
26. 本地部署提供只读 Doctor，检查目录权限、存储空间、runtime schema、repository 完整性、浏览器/WebGL、搜索/抓取服务、模型配置、任务队列和备份可恢复性；修复动作必须单独征得确认。

---

## 1. 已冻结的产品契约

后续执行者不得重新解释或静默改变本节。若确实需要变更，必须先修改本文件并记录原因、影响和迁移策略。

### 1.1 产品范围

纳入同一装机拓扑：

- 机箱、主板、CPU、内存、GPU、存储、电源；
- 风冷、AIO、冷排、泵、风扇、风扇/RGB Hub；
- HBA、RAID 控制器、NIC、采集卡及其他内部 PCIe 扩展卡；
- 背板、转接器、扩展板、内部必要线材和安装附件。

明确不纳入同一装机拓扑：

- 显示器；
- 键盘、鼠标；
- 路由器、交换机；
- UPS；
- USB 外设。

这些外部设备不得阻塞内部装机方案，也不进入本计划的兼容、3D、走线和采购完整性判定。

外部设备相关的目标可以作为工作负载输入，例如目标分辨率/FPS、局域网吞吐或 USB 设备数量；它们只形成内部主机的接口/性能需求，不创建外设节点、不推荐外设，也不把外设计入装机 BOM。

### 1.2 档案与部件状态

方案必须支持真正渐进式建档。部件/需求状态只有：

```ts
type PlanItemState = "not_needed" | "planned" | "ordered";
```

语义：

- `not_needed`：用户明确不需要，例如核显方案明确不安装独显；
- `planned`：默认状态，处于方案选择、补证或待采购阶段；
- `ordered`：已经做出采购承诺；不表示平台验证了实物状态、成色或健康。

规则：

- 新建空白方案不预建任何部件节点，因此“空节点”表示用户尚未描述；
- 用户界面仍展示上述三种选择，但 canonical topology 中 `not_needed` 保存为独立 `RoleDecision`，不创建带假 identity 的 `ComponentInstance`；真实实例状态只允许 `planned/ordered`；
- 用户一旦添加部件，若未显式选择状态，默认 `planned`；
- `ordered` 可回退到 `planned`；
- 本计划不追踪收到、安装、损坏、退货、序列号、SMART 或实物健康；
- 个性化装机指南使用独立的 `ExecutionSession` 记录步骤是否确认完成，不新增第四种 `PlanItemState`，也不据此声称实物健康；
- 旧 `owned` 数据迁移到 `ordered`，并附迁移说明，不能继续污染全局产品目录；
- 旧 `buy_now`、`upgrade_later`、`optional` 不再作为事实状态；它们迁为 `planned`，优先级由推荐/任务层单独表达。

### 1.3 结论状态与 false-green

最终用户可见结论采用：

```ts
type DecisionVerdict = "pass" | "fail" | "blocked";
```

- `pass`：在已声明证据、公差和推断范围内可以证明满足要求；
- `fail`：明确违反接口、标准、尺寸、供电、系统或安全条件；
- `blocked`：无法证明安全或可用，必须补证、改方案或请求用户测量；
- 内部可以存在 `unresolved`，但不得为了消灭 unknown 而伪造数值；
- 推断是证据来源，不是 verdict；推断区间在所有合理情况下都满足约束时才可以 `pass`；
- 安全关键规则的 false-green 目标为 0；宁可保守 `blocked`，不能将未验证显示为兼容。

仅靠一般 Agent 推断不得绿色放行：

- 模组电源 PSU 端 pinout 和跨型号线材；
- CPU/socket、芯片组与 BIOS 最低版本；
- 额定电流、线径和关键供电能力；
- EPS、PCIe、12V-2x6 等高功率连接；
- 误差范围可能发生干涉的临界机械间隙。

### 1.4 身份确认

身份按 claim/字段确认，而不是一次性把整件产品永久标为“已确认”：

- 家族级不变量可由产品家族身份支持；
- 容量、功耗、尺寸、散热片版本、随盒线材、保修、地区 SKU、revision 和购买链接等变体敏感字段必须继续解析；
- 当下游新规则需要变体敏感字段时，身份解析必须重新打开；
- 安全字段不得跨型号、revision 或模组线家族继承。

### 1.5 证据优先级

默认解析阶梯：

1. 精确型号/revision 的官网手册、勘误、支持页、QVL、BIOS/固件页；
2. 精确型号的官网技术规格/产品页；
3. 精确家族且已证明该字段为家族不变量的官网资料；
4. 一份方法明确、对象明确的高质量第三方实测；
5. 两份或更多真正独立、相互一致的第三方来源；
6. Agent 基于已解析事实做出的可重放推断。

额外规则：

- 官网手册属于官方证据；
- 电商详情页只能证明商品声明、变体和报价，默认不能证明技术规格；
- 论坛、评论和转载只作为线索；
- 第三方永远不能显示成 official；
- 官网与实测冲突时保留 `conflict`，不能静默选一个；
- Agent 推断必须记录输入事实、规则/模型版本、假设、置信度和失效条件。
- `user_observation` 只证明用户当前方案中的特定实例或安装关系，例如量尺、照片可见端口、当前 BIOS 版本和首启现象；其可信度由方法、附件、时间和误差决定。
- 用户观察在其声明 scope 内可优先于一般 Agent 推断并用于解除几何/装配 blocker，但不能变成全局 SKU 规格，不能替代额定电流、pinout、安全认证等官方安全证据。

### 1.6 系统默认与说明

```ts
type MachineIntent = "pc" | "workstation" | "nas";
```

- `pc` 默认建议 Windows；
- `workstation` 默认建议 Windows，Agent 可根据工作负载建议 Linux 等替代；
- `nas` 默认建议 TrueNAS；
- 默认只设置系统建议，不自动添加任何硬件、许可证或购买项；
- Agent 必须说明为什么给出默认建议，并展示相关替代系统的差异；
- UI 必须提供一个可键盘访问、带 `aria-label` 的问号入口，连接到系统比较说明；
- 用户手动确认系统后，后续重评估不得静默覆盖；
- 系统 profile 必须解析并锁定具体受支持版本，不把“Windows”或“TrueNAS”当成永不变化的事实。
- 系统可用性包含安装前 firmware 路径：当前 BIOS/固件版本、目标版本、升级方法、升级前置硬件、校验、断电/回退风险和升级后关键设置都必须可执行；仅知道“有兼容 BIOS”不等于当前方案可首启。
- NAS/TrueNAS 的默认建议必须进入存储布局问答，不得根据磁盘数量静默选择 vdev；任何初始化、重建或布局变更都先展示数据破坏风险，并明确 RAID/RAIDZ 不是备份。

系统比较至少覆盖：

- 硬件和驱动支持；
- 文件系统与数据保护；
- 游戏/生产力软件；
- 虚拟化和容器；
- HBA/磁盘直通、ECC、IPMI；
- 更新、恢复、维护难度；
- 许可证和学习成本。

### 1.7 3D、热与噪音边界

3D：

- 允许 Agent 从官网手册、产品图和标准尺寸推导接口位置与方向；
- 所有推导坐标都必须带误差范围和来源；
- 只有净空大于双方误差、公差、弯折和服务余量时才通过；
- 临界情况必须 `blocked` 并请求用户照片或量尺；
- 3D 可以使用方盒/包络 fallback，不冒充厂商 CAD。

热：

- 输出工作负载下的区间和最坏场景，不输出伪精确单点；
- 默认规划环境为 `20-30°C` 区间，用户可覆盖；
- 3D 热场只是模型结果的展示，不声称 CFD。

噪音：

- 只计算硬件自身声源：风扇、泵、PSU、GPU、HDD 等；
- 统一到声明的参考距离、负载和 RPM 后才能聚合；
- 不考虑房间、摆放距离、机箱遮挡和机箱共振；
- coil whine 只能显示为发生风险，不能确定预测；
- 输出标准化声学区间和来源贡献，不声称实际房间听感。

### 1.8 中国价格的放宽口径

范围：

- 中国平台；
- 优先全新；
- 二手、预售和缺货不得混入“当前全新价格”；
- 跨境、无大陆保修、无发票可以低优先级展示，但必须明确标记，不作为默认首选。

时效：

- `age <= 72h`：`preferred`；
- `72h < age <= 7d`：`usable`；
- `age > 7d`：`expired`，不得进入当前预算，只可进入历史记录。

样本：

- 一条精确变体、全新、可打开且有价格的有效观察即可展示，置信度为 `low`；
- 两条及以上独立卖家观察才形成市场区间；
- 不强制要求三条报价；
- 普通淘宝/PDD 店铺可以作为低置信价格或备选购买渠道，不因渠道等级自动删除；
- 发票、授权、保修和卖家等级是排序信号，不是所有报价的硬门槛；
- 无有效全新报价时输出“当前未找到符合口径的新货”，并建议替代型号，不能沿用过期价格。
- 过期 observation 仍保留在历史序列；历史比较必须使用同一精确变体、统一到可比到手价，并标出样本缺口、券/会员/跨店条件和异常值处理。
- 用户可以设置目标价和观察期限；“买/等”是带有效期的建议，不是保证，必须显示当前价在可用历史窗口中的位置和使建议失效的条件。

### 1.9 推荐哲学

硬门槛：

1. 红线不兼容、系统不可用和安全 `blocked` 候选不能进入可购买排名；
2. 必须满足当前真实工作负载；
3. 价格和性能证据不足时不能声称“性价比胜出”。

排序原则：

- 长期不易替换的骨架件，可以为真正有用的可靠性、扩展性、维护便利和避免未来推倒重来支付合理溢价；
- 价格处于异常周期、未来容易扩容或替换的部件，降低当前投入；
- 不为“新”、品牌或暂时用不到的性能自动加分；
- 推荐必须展示分项依据和至少两个备选；
- 默认评估周期：骨架件 5 年，易替换/扩容件 2-3 年，用户可覆盖；
- 输出至少三档：经济方案、平衡方案、长期方案。
- 推荐入口先读取结构化需求，而不是从已选 SKU 反推用户需求；需求缺失时 Agent 先问最少必要问题，并允许其余字段保持未定。
- 整机求解器先做兼容/安全/系统/预算硬约束剪枝，再按上述哲学优化软目标；不得把一组分别排名靠前但无法共同启动的单件拼成“方案”。
- 情景分支必须共享不可变父版本和证据快照，显示 changed inputs、受影响结论、总价差和敏感性；比较时不能用不同时间或不同变体口径的价格冒充差异。

### 1.10 更新、记忆与部署

- 事实库保留新旧版本；
- 每个方案锁定采用的 fact snapshot 和 price snapshot；
- 官网更新展示字段级差异、证据和下游影响；
- 用户可以针对当前方案接受、拒绝或延后；
- 决策按 `subject + claim + revision` 记忆，避免相同更新反复询问；
- 后续 revision 或事实内容改变时可以再次提醒；
- 用户可以撤销决定，撤销后重新评估；
- 即使用户拒绝安全修正，平台仍保留显著警告；
- 当前只考虑开源、本地部署、单用户；不在本计划中实现公网账号、租户和共享权限；
- 外部网页、PDF 和模型输出仍是非可信输入，SSRF、重定向、prompt injection、文件解析和内容大小限制必须保留。
- 长任务必须持久化为可恢复 job；UI 关闭、浏览器刷新或进程重启不得让已归档证据、已完成子步骤或用户批准丢失，重试必须幂等。
- `.buildsim` 便携包与整站备份是两种不同产品：前者用于单方案携带/复现，后者覆盖 runtime repositories、配置、任务、审计和密钥引用；两者都要 manifest、schema 版本、hash 校验、导入预检和路径穿越防护。
- Doctor 默认只读且可离线运行；任何迁移、删除缓存、重新抓取或修复权限等有状态动作都必须展示影响、备份位置和 rollback，并由用户确认。

---

## 2. 当前基线与必须关闭的缺口

开始执行前必须承认以下现状，不能用已有 N6 演示代替通用能力验收：

1. `createEmptyBuildConfig()` 已能生成真实空白方案，这是可保留基础。
2. `BuildSelection` 仍是单 PSU、单 GPU、单内存 SKU、单磁盘 SKU 和 NVMe 数量模型，不能表达实例拓扑。
3. `buildReadiness()` 会在核心字段未齐全时停止 geometry、routing、BOM 和大部分评估。
4. `deriveBom()` 会注入 N6 profile 默认的两块 Samsung 980 PRO，并推断 owned/buy_now 状态。
5. 核心评估、空间、物理、热和接线仍直接依赖 N6 adapter/profile。
6. 当前 catalog 的产品事实、用户 owned 标签和成交价混在同一个全局 SKU 文件中。
7. 当前基础 SKU 缺少字段级 provenance；`evidence: official` 标签不能定位到原文 claim。
8. 证据归档、SKU catalog、constraint、case geometry/routing 和评估器是平行数据岛；绑定新手册不会自动更新评估。
9. Catalog writer 主要补空，不具备完整的 supersession/update 模型。
10. Agent 可以发现文档和读取已有摘录，但尚无完整的“归档 → claim → 更新 → 方案重算”工具闭环。
11. 当前 price audit 可接受客户端提供的价格和 hash，未强制绑定服务端 listing capture。
12. 生产 runtime 持久目录与静态导入的 catalog/price snapshot 没有完全收敛。
13. 当前噪音总值固定 unknown；热模型是 N6 两腔 0D 规划模型。
14. 当前通用兼容规则缺少 CPU/BIOS、内存、通用电源连接、PCIe lane、前置接口、风扇 header、系统驱动等大量域。
15. 当前没有独立的需求/工作负载 schema，推荐容易从已有 SKU 反推目的，也没有能够保证整套方案共同满足硬约束的求解器。
16. 当前版本历史不能表达情景族和可比较的 what-if 分支，无法稳定说明一次输入变化造成的全链路差异。
17. 当前 BOM/走线未系统建模随盒附件、紧固件、转接件和工具，也没有由拓扑生成的装配/首次通电程序。
18. 当前 BIOS/固件和 TrueNAS 检查偏向静态兼容，缺少“现有硬件能否完成升级”的路径以及 vdev/容量/故障域/扩容的存储布局规划。
19. 当前 fact authority 没有受治理的用户观察；价格没有统一历史、目标价和买/等策略。
20. 当前导出不足以作为可携带复现包；完整 runtime 备份/恢复、持久后台任务和本地部署 Doctor 也尚未形成发布级闭环。

---

## 3. 目标架构

```text
用户自然语言 / 手动编辑 / 需求向导
          │
          ▼
RequirementSpec + ScenarioFamily
          │
          ▼
BuildConfig V3：部件实例 + 安装 + 连接 + 用户需求 + 系统目标
          │
          ├───────────────┐
          ▼               ▼
Identity Resolver      Evidence Resolver
          │         官网 → 第三方 → Agent 推断
          └───────┬───────┘
                  ▼
       FactSnapshot + ConflictSet
                  │
          ┌───────┼────────┐
          ▼       ▼        ▼
   Capability   Standards  System Profiles
          └───────┬────────┘
                  ▼
        Progressive BuildEvaluation
                  │
     ┌────────────┼─────────────┬───────────┐
     ▼            ▼             ▼           ▼
 compatibility  3D/routing  thermal/noise  BOM/price
     └────────────┴─────────────┴───────────┘
                  │
                  ▼
 whole-build solver + recommendation + explanations
                  │
                  ▼
 UI / Agent / version / portable bundle / update inbox
                  │
                  ▼
 persistent jobs / backup-restore / local Doctor
```

权威边界：

- `PlanRepository` 继续保存方案、草稿和不可变版本；
- `FactRepository` 保存产品 claim、证据引用、冲突、supersession 和快照；
- `PriceRepository` 保存 listing capture、价格观察和价格快照；
- `JobRepository` 保存长任务状态、去重键、checkpoint、重试、错误和产物引用；
- `ArtifactRepository` 保存便携包、备份、恢复报告、Doctor 报告和长期任务产物，不把大文件塞入方案 JSON；
- `BuildEvaluation` 必须由 `configHash + requirementSpecHash + factSnapshotHash + userObservationSnapshotHash + priceSnapshotHash + ruleSetHash + systemProfileHash + adapterSnapshotHash + engineHash + simulationModelHash + simulationInputHash` 唯一决定；`ruleSetHash` 定义为 evaluator rules + standards + policy 的传递闭包，不允许实现者把 adapter/model 版本藏在进程状态中；
- 完整 evaluation 另输出 `compatibilityHash`、`spatialHash`、`simulationHash`、`procedureSafetyHash` 和 `priceHash`；装机/首启步骤按各自 dependency hash 失效，价格或无关声学刷新不得作废机械/供电安全确认；
- 整机 solver 只能生成候选；每个候选仍提交给同一权威 `BuildEvaluation`，不得在 solver 内复制或弱化兼容规则；
- UI、3D、Agent、BOM、采购和推荐只消费同一份 evaluation；
- N6 adapter 只能由通用 registry 加载，核心模块不得静态 import N6 JSON/常量。

---

## 4. 目标核心契约

本节给出执行起点。实现阶段可以调整字段命名，但不能减少语义或可追溯性。

### 4.0 Canonical hash、domain hash 与 artifact lock

所有 repository、浏览器、Node worker、导出和恢复共享一份 `HashSpec`：

```ts
interface HashSpec {
  version: "hash-spec-v1";
  algorithm: "sha256";
  canonicalization: "rfc8785-jcs-with-buildsim-domain-prefix";
  unicode: "utf8-nfc";
  numberPolicy: "finite-json-number";
  excludes: ["the-hash-field-itself"];
}

interface SnapshotHashes {
  configHash: string;
  requirementSpecHash: string;
  factSnapshotHash: string;
  userObservationSnapshotHash: string;
  priceSnapshotHash: string;
  ruleSetHash: string;
  systemProfileHash: string;
  adapterSnapshotHash: string;
  engineHash: string;
  simulationModelHash: string;
  simulationInputHash: string;
}

interface DomainHashes {
  compatibilityHash: string;
  spatialHash: string;
  simulationHash: string;
  procedureSafetyHash: string;
  priceHash: string;
}
```

- hash 输入带 schema/domain 前缀；对象 key、集合顺序、单位规范化、Unicode 和数字表示必须唯一；hash 字段本身不参与自己的 hash；
- `ArtifactLockfile` 保存 rule/standard/system/adapter/engine/model 的内容寻址 artifact refs，而不只保存 hash 字符串；旧 evaluation 缺任一 replay-required artifact 时必须明确不可重放；
- U0 提供黄金向量，由 Node 与浏览器分别计算；跨 runtime mismatch 为发布阻断。

### 4.1 BuildConfig V3

建议新增 `src/topology/contracts.ts`：

```ts
interface BuildConfigV3 {
  schemaVersion: "3.0.0";
  id: string;
  name: string;
  updatedAt: string;
  intent: RequirementDraftField<MachineIntent> | null;
  requirementSpec: RequirementSpec | null;
  system: SystemSelection | null;
  components: ComponentInstance[];
  roleDecisions: RoleDecision[];
  placements: PlacementEdge[];
  connections: ConnectionEdge[];
  logicalLayouts: LogicalLayoutSelection[];
  firmwareTargets: FirmwareTarget[];
  notes?: string[];
}

interface ComponentInstance {
  instanceId: string;
  kind: string;
  role: string;
  state: "planned" | "ordered";
  identity:
    | { status: "unresolved"; userText: string; candidateIds?: string[] }
    | { status: "resolved"; skuId: string; identityClaimIds: string[] };
  source: "user" | "agent" | "migration";
}

interface RoleDecision {
  roleDecisionId: string;
  role: string;
  decision: "not_needed";
  source: "user" | "migration";
  confirmedAt: string;
}

interface SystemSelection {
  profileId: string;
  versionFactId: string;
  source: "defaulted" | "user";
  lockedByUser: boolean;
}

interface FirmwareTarget {
  instanceId: string;
  targetReleaseFactId: string;
  requestedSettings: Array<{ settingId: string; desiredValue: string }>;
  source: "user" | "system_requirement";
}

type VdevTopology = "mirror" | "raidz1" | "raidz2" | "raidz3" | "stripe";

interface LogicalLayoutSelection {
  layoutId: string;
  bootPoolDiskIds: string[];
  vdevs: Array<{ vdevId: string; topology: VdevTopology; diskInstanceIds: string[] }>;
  spareDiskIds: string[];
}

interface PlacementEdge {
  placementId: string;
  componentInstanceId: string;
  mountOwnerInstanceId: string;
  mountId: string;
}

interface ConnectionEdge {
  connectionId: string;
  from: { instanceId: string; portId: string };
  to: { instanceId: string; portId: string };
  cableInstanceId?: string;
  status: "required" | "planned" | "satisfied" | "blocked";
}
```

约束：

- 每块 SSD、DIMM、GPU、扩展卡、风扇和关键线材是独立实例；
- UI 可以聚合相同实例，评估器不得只保留 `SKU × qty`；
- 数量输入必须在 canonicalization 时展开成稳定 `instanceId`；
- 未解析身份也能保存；
- `requirementSpec` 持久表达用户希望达成的目标；评估器发现的 `RequirementNode[]` 只存在于 `BuildEvaluation` 并按输入重算，不得写回 config；
- what-if 分支属于独立 ScenarioRepository，不写入 `BuildConfigV3`，避免相同硬件因情景标签产生不同 topology hash；
- BOM 是组件和 requirement 的投影视图，不再反向成为安装拓扑；
- 空白方案的数组（包括 `roleDecisions`）全部为空。
- NAS 物理盘始终是 component instance；pool/vdev/mirror/RAIDZ 存在于 `logicalLayouts`，不能用一个假“RAID 部件”替代；
- 当前 BIOS 版本属于 observation，用户希望采用的版本/设置才进入 `firmwareTargets`；附件 blob、观察正文、job 状态和派生装机步骤只保存稳定引用或完全不进入 config。

### 4.2 FactRecord 与快照

建议新增 `src/facts/contracts.ts`：

```ts
interface FactRecord {
  factId: string;
  subject:
    | {
        kind: "product";
        skuId: string;
        revision?: string;
        region?: string;
        familyId?: string;
      }
    | {
        kind: "plan_subject";
        planId: string;
        subjectRef: ObservationSubjectRef;
      };
  field: string;
  value: unknown;
  unit?: string;
  scope: "family" | "model" | "variant" | "revision" | "plan_subject";
  authority: "official" | "third_party" | "user_observation" | "agent_inference";
  safetyClass: "normal" | "compatibility_critical" | "electrical_safety";
  status: "active" | "superseded" | "conflicted" | "unresolved_blocker";
  evidenceRefs: string[];
  derivedFromFactIds: string[];
  extractorOrRuleVersion?: string;
  assumptions?: string[];
  confidence: number;
  retrievedAt: string;
  validFrom?: string;
  supersedesFactId?: string;
}
```

必须同时定义：

- `FactSnapshot`；
- `ConflictSet`；
- `IdentityResolution`；
- `UpdateDecision`；
- `InferenceTrace`；
- `EvidenceSearchOutcome`。

### 4.3 Decision 与 Requirement

```ts
interface EvaluationDecision {
  decisionId: string;
  verdict: "pass" | "fail" | "blocked";
  domain: "identity" | "mechanical" | "electrical" | "firmware" | "system" | "storage" | "assembly" | "commissioning" | "routing" | "thermal" | "acoustic" | "procurement";
  message: string;
  instanceIds: string[];
  factIds: string[];
  ruleId: string;
  ruleVersion: string;
  assumptions: string[];
  remediation: RequirementNode[];
}
```

`RequirementNode` 必须表达：缺少的部件、缺少的线材、缺少的证据、需要的测量、需要的系统选择和需要的用户决定。缺件不是 `fail`；只有已知违反约束才是 `fail`。

```ts
interface RequirementNode {
  requirementId: string;
  kind: "component" | "accessory" | "fastener" | "cable" | "consumable" | "tool" | "evidence" | "measurement" | "firmware_action" | "system_action" | "user_decision";
  predicates: FacetPredicate[];
  quantity: number;
  criticality: "normal" | "boot" | "safety";
  requiredBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
  producedBy: { ruleId: string; ruleVersion: string; instanceIds: string[] };
  evidenceRefs: string[];
}

interface RequirementSatisfaction {
  requirementId: string;
  status: "open" | "satisfied" | "blocked";
  allocations: Array<{
    source: "component" | "package_content" | "user_resource" | "purchase";
    refId: string;
    ownerInstanceId?: string;
    quantity: number;
    availability: "planned" | "ordered" | "present_verified";
    verificationStatus: "unverified" | "verified";
    satisfiesBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
    evidenceRefs: string[];
    observationRefs: string[];
  }>;
  residualQuantity: number;
}
```

`FacetPredicate` 必须是可验证的白名单 JSON DSL，不允许执行任意表达式。requirement closure 运行到固定点并检测循环，因为一个候选部件可能继续产生支架、螺丝、导热材料或工具需求；安全 requirement 不能通过普通用户勾选绕过。

分配器必须守恒：同一件不可共享的螺丝、线材或工具占用不能重复满足两个同时需求。`ordered` 和官网“随盒包含”只证明采购/包装声明，不证明物品仍在用户手边；`pre_power/first_boot` 的 boot/safety requirement 只允许 `present_verified` allocation 或对应安全 checkpoint 满足。

### 4.4 Adapter 与 capability facets

```ts
interface HardwareAdapter {
  adapterId: string;
  adapterVersion: string;
  subjectSkuId: string;
  capabilities(): CapabilityFacet[];
  geometry(): GeometryManifest | null;
  routing(): RoutingManifest | null;
  assembly(): AssemblyManifest | null;
  thermal(): ThermalManifest | null;
  provenance(): string[];
}
```

Capability facets 至少覆盖：

- identity/revision；
- dimensions/form-factor/mount；
- CPU socket/chipset；
- memory type/capacity/population；
- ports/endpoints/headers；
- power source/load/cable family；
- PCIe slots/lanes/sharing；
- storage interfaces/boot；
- cooling/fan/radiator；
- firmware/BIOS；
- OS/driver support；
- thermal/acoustic curves。

### 4.5 PriceObservation

```ts
interface PriceObservation {
  observationId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  platform: "jd" | "tmall" | "taobao" | "pdd" | "official" | "other_cn";
  sellerId?: string;
  sellerName?: string;
  sellerTier: "S1" | "S2" | "S3" | "S4" | "unknown";
  condition: "new";
  stockStatus: "in_stock" | "seller_claimed" | "unknown";
  priceCny: number;
  shippingCny?: number;
  comparableTotalCny: number;
  requiredDiscountConditions?: string[];
  invoiceStatus: "yes" | "no" | "unknown";
  warrantyStatus: "mainland" | "seller" | "cross_border" | "unknown";
  canonicalUrl: string;
  listingCaptureId: string;
  capturedAt: string;
  recheckedAt?: string;
}
```

价格不能由客户端直接提交并自称 audited；正式 observation 必须从服务端不可变 listing capture 派生。

### 4.6 需求、工作负载、情景与整机求解

建议新增 `src/requirements/contracts.ts` 和 `src/solver/contracts.ts`：

```ts
type RequirementDraftField<T> =
  | { state: "answered"; value: T; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean }
  | { state: "deferred"; value?: never; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean }
  | { state: "not_applicable"; value?: never; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean };

interface RequirementMetric {
  metricId: string; // governed metric registry
  operator: "eq" | "gte" | "lte" | "between" | "includes";
  value: number | string | boolean | [number, number];
  unitId?: string;
  priority: "must" | "important" | "nice_to_have";
}

interface RequirementSpec {
  requirementSpecId: string;
  schemaVersion: "1.0.0";
  budget?: RequirementDraftField<{
    targetCny?: number;
    hardCapCny?: number;
    reserveCny?: number;
  }>;
  workloads: Array<{
    workloadId: string;
    name: string;
    metrics: RequirementMetric[];
    evidenceOrBenchmarkRefs?: string[];
  }>;
  constraints: Array<{
    constraintId: string;
    predicate: FacetPredicate;
    strength: "hard" | "soft";
    source: "user" | "migration" | "agent_proposed";
    confirmedByUser: boolean;
  }>;
  horizonYears?: RequirementDraftField<number>;
}

interface SolverReadiness {
  ready: boolean;
  blockerFieldIds: string[];
  deferredNonBlockingFieldIds: string[];
}

interface ScenarioBranch {
  scenarioId: string;
  familyId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  patch: PlanPatchOperation[];
  simulationInputPatch?: JsonPatchOperation[];
}

interface WhatIfResult {
  scenarioId: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  decisionDiffRef: string;
  domainDiffRefs: string[];
  snapshotAttribution: "same_snapshots" | "refreshed";
}

interface SolverCandidate {
  candidateId: string;
  requirementSpecId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  candidateConfigRef: string;
  operationsRef: string;
  buildConfigHash: string;
  inputHashes: SnapshotHashes;
  evaluationHash: string;
  candidateKind: "feasibility_candidate";
  domainCoverage: DomainCoverage[];
  residualRequirementIds: string[];
  excludedReasonIds: string[];
}

interface DomainCoverage {
  domain: EvaluationDecision["domain"];
  verdict: "pass" | "fail" | "blocked";
  domainHash: string;
  evaluationHash: string;
  requiredForPurchase: boolean;
}

interface CandidatePromotionRecord {
  promotionRecordId: string;
  candidateId: string;
  candidateBuildConfigHash: string;
  revalidatedInputHashes: SnapshotHashes;
  coverageHash: string;
  outcome: "purchase_eligible" | "excluded";
  residualMustRequirementIds: string[];
  createdAt: string;
}

interface SolveRequest {
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  lockedInstanceIds: string[];
  requirementSpecId: string;
  limits: { maxEvaluations: number; maxDurationMs: number; maxCandidatesPerRequirement: number };
}

interface SolveResult {
  status: "feasible_complete" | "feasible_partial" | "unsat_proven" | "blocked_inputs";
  solverVersion: string;
  seed: string;
  effectiveLimits: SolveRequest["limits"];
  explored: number;
  pruned: number;
  candidates: SolverCandidate[];
  unsatisfiedHardConstraintIds: string[];
  irreducibleConflictSets: string[][];
  searchSummaryRef: string;
}

interface RankedSolution {
  candidateId: string;
  promotionRecordId: string;
  scoringVersion: string;
  objectiveScores: Record<string, number>;
  rank: number;
  explanationRef: string;
}
```

约束：

- `must` 与 hard constraint 未满足的候选必须排除，不允许用综合分抵消；
- 所有 draft 字段都可单独保存；`agent_proposed` hard constraint 未经用户确认不得进入求解，solver-ready 由明确规则派生，关键未知产生 `blocked_inputs` 而不是填默认值；
- workload target 使用该用途的 benchmark/能力量纲，不建立跨用途“万能性能分”；
- solver 只能组合已经过身份/兼容候选生成策略约束的实例，不做 SKU 全量笛卡尔积；
- U6 只能产生带结构化 `DomainCoverage` 的 `feasibility_candidate`；U7-U9 完成并用相同 evaluator 重验证所有 `requiredForPurchase` domains 后，由 U10 生成绑定最新 input/domain hashes 的 `CandidatePromotionRecord(purchase_eligible)` 才能排名；eligibility 不允许直接写入候选；
- 三档结果是完整可启动 topology，不是互不兼容的单件推荐列表；
- what-if 比较默认锁定相同 fact/price/rule/system snapshots；若用户选择刷新，必须把“输入变化”和“市场变化”分开归因；
- 每次求解保存候选配置/operations、base version/hash、候选集合摘要、剪枝原因、随机种子/算法版本、实际时间/数量上限和未探索空间；重启后可复算并形成 proposal，stale base 必须拒绝。
- 只有穷尽或形式证明后使用 `unsat_proven`；`irreducibleConflictSets` 不得标成全局最小，除非另有最小性证明。
- U0 冻结 metric/facet/unit registry、允许的比较符和 JSON Patch path allowlist；`must` metric 只有在用户确认后映射成 hard constraint，`important/nice_to_have` 默认只进入软目标。

### 4.7 随盒附件、装配、首启与 firmware 路径

```ts
interface BundleItem {
  bundleItemId: string;
  ownerSkuId: string;
  kind: "cable" | "fastener" | "standoff" | "bracket" | "adapter" | "tool" | "consumable";
  specification: FacetPredicate[];
  quantity: number;
  region?: string;
  revision?: string;
  variantScopeFactIds: string[];
  evidenceFactIds: string[];
}

interface AssemblyRequirement {
  requirementId: string;
  neededByStepId: string;
}

interface BuildProcedure {
  procedureId: string;
  inputEvaluationHash: string;
  procedureSafetyHash: string;
  phases: Array<"prepare" | "bench_test" | "mechanical" | "wiring" | "firmware" | "first_power" | "system_install" | "verification">;
  steps: BuildProcedureStep[];
}

interface BuildProcedureStep {
  stepId: string;
  phase: BuildProcedure["phases"][number];
  action: string;
  dependsOn: string[];
  instanceIds: string[];
  requirementIds: string[];
  expectedResult: string;
  failureAction: string;
  riskLevel: "normal" | "caution" | "safety_critical" | "destructive";
  stopConditions: string[];
  failureBranchStepIds: string[];
  confirmationPolicy: "none" | "user_confirm" | "measurement" | "observation_required";
  safetyCritical: boolean;
  dependencyHashes: Partial<DomainHashes>;
  dependencyHash: string;
  evidenceRefs: string[];
}

interface ExecutionSession {
  executionSessionId: string;
  planVersionId: string;
  procedureId: string;
  evaluationHash: string;
  procedureSafetyHash: string;
  status: "active" | "completed" | "stale" | "abandoned";
  staleReason?: string;
  results: Array<{
    stepId: string;
    result: "confirmed" | "failed" | "skipped_non_safety";
    at: string;
    actor: "user";
    confirmedAgainstDependencyHash: string;
    note?: string;
    observationIds?: string[];
  }>;
}

interface BuildReadiness {
  assemblyReady: boolean;
  powerReady: boolean;
  postReady: boolean;
  systemInstallReady: boolean;
  workloadReady: boolean;
  destructiveActionReady: boolean;
}

interface FirmwarePlan {
  firmwarePlanId: string;
  instanceId: string;
  status: "pass" | "fail" | "blocked";
  inputHash: string;
  currentVersionObservationId?: string;
  minimumVersionFactIds: string[];
  targetVersionFactIds: string[];
  transitions: FirmwareTransition[];
  derivedRequirementIds: string[];
  requiredSettings: Array<{ key: string; value: string; reason: string; evidenceRefs: string[] }>;
}

interface FirmwareTransition {
  fromReleaseFactId: string;
  toReleaseFactId: string;
  method: "uefi" | "usb_flashback" | "bmc" | "os_tool";
  requiresWorkingCpu: boolean;
  requirementIds: string[];
  firmwareFileFactId: string;
  recoveryTransitionIds: string[];
  resetsSettings: boolean;
  releaseFactIds: string[];
}
```

`BuildProcedureStep` 必须包含前置步骤、受影响实例、需要的附件/工具、操作、预期结果、风险等级、停止条件、失败分支、证据/推断引用和确认策略。每个结果保存确认当时的 step dependency hash；`ExecutionSession.evaluationHash` 只用于审计，不参与整段失效。价格刷新保留机械/供电确认，更换主板、EPS 线、安装位或 BIOS target 只使 dependency hash 改变的步骤 stale。安全步骤不能 `skipped_non_safety`。`BuildReadiness` 全部由 requirement/checkpoint 派生，不是可写布尔字段。

Firmware 路径至少表达当前/最低/目标 release fact、版本识别方法、显式有向 transition、普通升级与无 CPU flashback 能力、所需临时 CPU/RAM/GPU、介质格式、文件名/校验、供电前置、升级后设置、失败恢复和官方步骤引用。BIOS 版本按厂商事实 ID/边比较，不假设 semver。缺少可执行升级路径时，即使目标 BIOS 理论支持 CPU，首次启动结论仍为 `blocked`。

### 4.8 NAS 存储布局

```ts
interface StorageLayoutEvaluation {
  layoutSelectionHash: string;
  systemProfileId: string;
  usableBytes: { min: number; max: number };
  vdevResults: Array<{
    vdevId: string;
    estimatedUsableBytes: { min: number; max: number };
    faultTolerance: { diskFailures: number; conditions: string[] };
  }>;
  hbaAndPathDecisionIds: string[];
  expansionOptions: Array<{
    optionId: string;
    operation: "add_vdev" | "replace_drives" | "add_spare";
    requiredInstanceCount: number;
    constraints: FacetPredicate[];
    riskDecisionIds: string[];
  }>;
  decisions: EvaluationDecision[];
  assumptions: string[];
}

interface DestructiveActionPlan {
  actionId: string;
  diskInstanceIds: string[];
  locatorObservationIds: string[];
  inputProcedureSafetyHash: string;
  confirmation: "required" | "confirmed";
  confirmationAt?: string;
}
```

config 只保存 `LogicalLayoutSelection`；容量、容错、路径、风险、扩容和 destructive action 全部由 evaluation 派生，禁止写回 selection。布局器必须检查磁盘实际容量差异、CMR/SMR、扇区格式、同一故障域、端口/HBA/expander 路径、HBA IT mode、启动池隔离、换盘与 resilver 风险；不能把 RAIDZ 当备份。任何清盘/安装操作要求 plan-scoped locator observation 唯一指向每块盘并单独确认，确认绑定 `procedureSafetyHash`，输入变化后不得复用。

### 4.9 用户观察

```ts
interface UserObservation {
  observationId: string;
  planId: string;
  subjectRef: ObservationSubjectRef;
  fieldId: string; // governed observation-field registry
  value: unknown;
  unit?: string;
  uncertainty?: { plusMinus?: number; min?: number; max?: number };
  method: "measurement" | "photo" | "label" | "visual_confirmation" | "user_assertion";
  attachmentRefs: string[];
  confirmedByUser: boolean;
  observedAgainstConfigHash: string;
  subjectRevisionHash: string;
  capturedAt: string;
  validatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
  status: "proposed" | "active" | "superseded" | "retracted";
  supersedesObservationId?: string;
  contentHash: string;
}

type ObservationSubjectRef =
  | { kind: "plan" }
  | { kind: "instance"; instanceId: string }
  | { kind: "placement"; placementId: string }
  | { kind: "connection"; connectionId: string }
  | { kind: "port"; instanceId: string; portId: string }
  | { kind: "mount"; ownerInstanceId: string; mountId: string }
  | { kind: "firmware_instance"; instanceId: string };
```

用户观察存入 plan-scoped repository。只有用户确认、subject 在当前 config 中存在、field schema/单位/误差校验通过且 subject revision 仍匹配的 `active` observation，才可投影为 `authority: "user_observation"` 的 fact。UI 的 `stale` 是由 subject hash mismatch 或 `invalidatedAt` 派生的只读状态，不写入 status 枚举。临界量尺必须有误差；换槽、换 port、改 route、刷 BIOS 或 subject revision 变化会使对应观察失效。照片/标签原件必须有 hash、隐私分类和删除策略；删除附件后保留 tombstone/hash、失效依赖 fact，新导出不得包含已删除 bytes，并明确旧备份不会被追溯改写。撤回或 supersede 后相关派生事实、checkpoint 和 evaluation cache 必须失效。

### 4.10 价格历史与目标价

```ts
interface PriceHistoryPoint {
  historyPointId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  bucketStart: string;
  bucketEnd: string;
  timeZone: "Asia/Shanghai";
  policyHash: string;
  priceBasis: "comparable_total_cny";
  condition: "new";
  region: "CN";
  currency: "CNY";
  minCny: number;
  maxCny: number;
  medianCny?: number;
  sampleCount: number;
  sellerCount: number;
  platformCounts: Record<string, number>;
  observationIds: string[];
  confidence: "low" | "medium" | "high";
  snapshotId: string;
}

interface PriceTarget {
  targetId: string;
  planId: string;
  instanceId?: string;
  skuId: string;
  variantIdentityFactIds: string[];
  targetTotalCny: number;
  sellerTierMinimum?: "S1" | "S2" | "S3" | "S4";
  requireMainlandWarranty?: boolean;
  expiresAt?: string;
  enabled: boolean;
  status: "watching" | "met" | "paused" | "unavailable";
  revisionHash: string;
  updatedAt: string;
  nextCheckAt?: string;
  lastEvaluatedSnapshotId?: string;
  lastTriggeredAt?: string;
}

interface PriceTargetEvent {
  eventId: string;
  targetId: string;
  targetRevisionHash: string;
  priceSnapshotId: string;
  transition: "watching_to_met" | "met_to_watching" | "to_unavailable" | "paused" | "resumed";
  occurredAt: string;
  idempotencyKey: string; // target + revision + snapshot + transition
}

interface JobSchedule {
  scheduleId: string;
  jobType: "price_target_recheck" | "official_update_scan";
  subjectRef: string;
  cadenceSeconds: number;
  nextRunAt: string;
  lastEnqueuedBucket?: string;
  enabled: boolean;
}
```

历史点只能由保存的 observation/snapshot 派生；同一精确变体、policy 和时间桶幂等生成。目标价以 `comparableTotalCny` 判定，append-only event 使用 `targetId + revisionHash + snapshotId + transition` 去重，只在跨线时提醒；编辑目标、二次跨线、停启与恢复备份都必须可重放。自动 watch 由持久 schedule 驱动，离线/重启恢复最多补一个遗漏时间桶，不制造任务风暴；首发不发外部通知。

### 4.11 持久任务、便携包、备份与 Doctor

```ts
interface BackgroundJob {
  schemaVersion: string;
  jobId: string;
  type: string;
  handlerVersion: string;
  idempotencyKey: string;
  inputHash: string;
  payloadRef: string;
  planId?: string;
  status: "queued" | "running" | "waiting_user" | "waiting_retry" | "paused_offline" | "paused_restore_review" | "succeeded" | "failed" | "cancelled" | "dead_letter";
  revision: number;
  attempt: number;
  maxAttempts: number;
  runAfter: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  checkpointRef?: string;
  runtimeGeneration: number;
  networkRequired: boolean;
  dependencyJobIds: string[];
  progress?: { stage: string; completed: number; total?: number };
  resultRefs: string[];
  resultCommitHash?: string;
  lastError?: { code: string; message: string; redacted: true };
  createdAt: string;
  updatedAt: string;
}

interface BackupManifestBase {
  schemaVersion: string;
  backupId: string;
  createdAt: string;
  appVersion: string;
  runtimeGeneration: number;
  entries: Array<{ logicalPath: string; kind: string; byteLength: number; sha256: string; privacyClass: "public_source" | "private_user" | "runtime_internal" }>;
  includedRoots: string[];
  excludedEntries: Array<{ kind: string; reason: string }>;
  planIds: string[];
  requirementSpecHashes: string[];
  factSnapshotIds: string[];
  userObservationSnapshotIds: string[];
  priceSnapshotIds: string[];
  evaluationHashes: string[];
  artifactLockfileRef: string;
  executionSessionIds: string[];
  manifestHash: string;
}

type BackupManifest =
  | (BackupManifestBase & { mode: "plan_portable"; portableProfile: "slim" | "complete" })
  | (BackupManifestBase & { mode: "full_local_backup"; portableProfile?: never });

interface BackupEnvelope {
  formatVersion: string;
  manifestHash: string;
  payloadSha256: string;
  payloadSha256Basis: "ciphertext";
  encryption:
    | { mode: "none"; formatVersion: string }
    | {
        mode: "authenticated";
        formatVersion: string;
        kdf: "scrypt";
        kdfParams: { n: number; r: number; p: number; saltBase64: string };
        cipher: "aes-256-gcm";
        nonceBase64: string;
        aadSha256: string;
      };
}

interface PortableReferenceEdge {
  fromRef: string;
  toRef: string;
  necessity: "required_for_replay" | "optional_for_audit";
}

interface ImportPlan {
  importPlanId: string;
  mode: "dry_run" | "apply";
  manifestHash: string;
  portableProfile: "slim" | "complete";
  resultMode: "exact_replay" | "reevaluate_with_current_runtime";
  conflicts: Array<{ existingId: string; incomingHash: string; existingHash: string }>;
  idRemap: Record<string, string>;
  action: "no_op_same_hash" | "copy_as_new_plan" | "replace_after_backup" | "reject";
  rollbackRef?: string;
}

interface BackupVerificationReport {
  backupId: string;
  manifestHash: string;
  verifiedAt: string;
  appVersion: string;
  schemaVersion: string;
  hashClosureValid: boolean;
  temporaryRestoreTested: boolean;
  result: "pass" | "fail";
}

interface DoctorCheckResult {
  checkId: string;
  checkVersion: string;
  category: "storage" | "integrity" | "migration" | "services" | "network" | "security" | "jobs" | "backup" | "runtime";
  status: "pass" | "warn" | "fail" | "skipped";
  severity: "info" | "degraded" | "blocking";
  summary: string;
  evidence: Array<{ code: string; redactedDisplay?: string; valueHash?: string }>;
  remediation?: string;
  repairable: boolean;
}

interface DoctorReport {
  schemaVersion: string;
  generatedAt: string;
  appVersion: string;
  overall: "healthy" | "degraded" | "unhealthy";
  checks: DoctorCheckResult[];
  reportHash: string;
}

interface RepairPlan {
  repairPlanId: string;
  reportHash: string;
  actionIds: string[];
  impactSummary: string;
  preconditionHashes: string[];
  backupId: string;
  idempotencyKey: string;
  approvedAt?: string;
  rollbackRefs: string[];
}
```

任务 payload 只存引用，大网页/PDF/模型输出放 ArtifactRepository；checkpoint/result commit 必须以 `expectedRevision + active leaseToken + runtimeGeneration` 做 CAS，过期 worker 不得提交。外部幂等只保证 repository/proposal/inbox 等事务副作用 exactly-once；只读 GET 可以 at-least-once，但 capture 以内容寻址去重。离线转 `paused_offline` 而不是耗尽 retry；完整恢复后所有非终态 job 进入 `paused_restore_review`、旧 lease 全部失效，用户复核后才续跑。任务只能产出 candidate/update/proposal，不能绕过审批直接改方案。

`plan_portable` 分 `slim` 与 `complete`：slim 可按当前 runtime 重评；complete 必须携带所有 `required_for_replay` facts/observations/prices/rules/system/adapters/engine/model artifacts，厂商原文可作为仅含 URL/hash/locator/合规 excerpt 的 `optional_for_audit` 外部引用。相同 ID+hash 导入为 no-op；相同 ID+不同 hash 只能明确复制为新档案或先备份后替换，禁止静默覆盖，plan-scoped ID 重映射写入 manifest。

`full_local_backup` 覆盖 runtime repositories、配置、审计、任务、execution sessions 和被引用归档；provider key、cookie、浏览器 profile 和 `.env` 只记录 excluded reason。PurchaseRecord 不持久化姓名、电话、地址；其余 `private_user` 内容和内层 manifest 必须 authenticated encryption，密钥不进包，外层仅保留格式/KDF 参数。恢复取得全局 maintenance lease、冻结 writer/worker，先解到 staging，拒绝绝对路径、`..`、symlink 和重复路径，验证 schema/hash/引用闭包后原子切换 root pointer 并递增 `runtimeGeneration`；旧进程写入必须被 fencing 拒绝。

`manifestHash` 按 HashSpec 排除自身字段计算；`BackupEnvelope.payloadSha256` 位于被校验/加密 payload 之外，避免 archive hash 自引用。

Doctor 默认只读并支持稳定 JSON 输出；evidence 只允许结构化脱敏 code/display/hash，禁止原始路径、网页正文或用户字段。定义 mandatory check IDs、合法 status/severity 组合和 strict exit code；`overall` 只能由 checks 确定。至少检查 runtime 权限/空间、repository hash 和引用闭包、pending migration、服务版本、stuck lease/dead letter、最近一份仍在 freshness 阈值内且有 `BackupVerificationReport` 的备份、WebGL/浏览器、SearXNG/PDF parser、离线状态、时钟异常和日志脱敏。`--repair` 消费版本绑定的 `RepairPlan`，执行前重验 preconditions、先备份并显式确认，必须幂等且可回滚。

### 4.12 仿真输入

```ts
interface SimulationInput {
  workloadMetricRefs: string[];
  ambientC: { min: number; max: number };
  fanPolicyId: string;
  storageActivity: Array<{ logicalLayoutId: string; dutyCycle: number; concurrentDiskCount: number }>;
  placementIds: string[];
  routeIds: string[];
  modelVersion: string;
}
```

what-if 默认锁定同一 `SimulationInput`；只改变 NAS layout 时环境和工作负载不得漂移，但 layout/path refs 与 `simulationInputHash/simulationHash` 必须变化。所有默认仿真输入显示来源并允许用户覆盖。

---

## 5. 固定执行协议

### 5.1 开始前

当前工作区已有大量用户未提交修改。执行者必须：

1. 先运行 `git status --short` 并保存基线；
2. 不使用 `git reset --hard`、`git checkout --` 或批量清理；
3. 不覆盖与本阶段无关的用户修改；
4. 若无法安全分离阶段变更，先建立新 worktree/分支或请求用户决定；
5. 每个迁移脚本先支持 dry-run、manifest、备份和 rollback；
6. 未经明确授权，不部署、不推送远程、不购买、不发送外部消息。

### 5.2 每阶段固定流程

每个阶段按以下顺序执行：

1. 阅读本阶段目标、依赖和退出门禁；
2. 更新或新增离线 fixture；
3. 先写失败测试；
4. 实现最小闭环，不把后续阶段混入同一提交；
5. 执行聚焦测试；
6. 执行 `npm run typecheck`、`npm test`、`npm run build`；
7. 运行该阶段要求的浏览器 smoke；
8. 执行 `git diff --check`、敏感信息扫描和架构边界扫描；
9. 更新本文件中的阶段状态、变更摘要、测试证据和 rollback 位置；
10. 使用一个或少量按职责拆分、均可独立回滚的本地提交；是否推送由用户另行决定。

### 5.3 通用门禁命令

```bash
npm run typecheck
npm test
npm run build
npm run agent:secret-scan
npm run test:platform:browser
git diff --check
```

涉及官网、价格或 SearXNG 时增加：

```bash
npm run searxng:health
npm run searxng:smoke
```

live smoke 只能验证真实网络集成，不能取代离线 deterministic fixtures。

### 5.4 阶段依赖主线

```text
U0 → U1 → U2 → U3 → ┬→ U4 ─┐
                     └→ U5 ─┴→ U6 → U7 → U8 → U9 → U10 → U11 → U12
```

- `U4` 证据解析与 `U5` 通用 adapter 可在 `U3` 后并行；
- `U6` 必须等两者契约稳定后再切换主评估器；
- `U8` 3D/走线先于 `U9` 热噪，因为热/噪需要安装、风道和工作点；
- `U12` 通过前不得删除 v2/N6 fallback。

### 5.5 总阶段看板

| 阶段 | 状态 | 依赖 | 核心交付 |
|---|---|---|---|
| U0 | 已完成 | 无 | 冻结全部首发契约、基线、通用/故障黄金夹具和 feature flags |
| U1 | 未开始 | U0 | runtime repositories、附件/观察、durable jobs、备份 SPI 和 Doctor 骨架 |
| U2 | 未开始 | U1 | BuildConfig V3、需求、情景、逻辑布局、渐进档案和 V2 迁移 |
| U3 | 未开始 | U2 | Fact/Claim 与用户观察图、身份 scope、冲突、更新决定和快照 |
| U4 | 未开始 | U3 | 官网 → 第三方 → Agent 推断、附件提取和持久任务闭环 |
| U5 | 未开始 | U3 | 通用 capabilities、随盒清单、标准库和 adapter registry |
| U6 | 未开始 | U4、U5 | 渐进兼容、附件完整性、可启动性、可行性求解和 what-if |
| U7 | 未开始 | U6 | 系统 profiles、BIOS 路径、首启程序和 NAS 存储布局 |
| U8 | 未开始 | U5-U7 | 通用 3D、走线、公差、线材与电气安全 |
| U9 | 未开始 | U8 | 工作负载驱动的热区间、标准化硬件噪音和情景差异 |
| U10 | 未开始 | U3、U4、U6-U9 | 中国价格历史/目标价、整机排序和买/等建议 |
| U11 | 未开始 | U7-U10 | 统一 UI/Agent、装机指南、情景比较、任务/导出/诊断体验 |
| U12 | 未开始 | U0-U11 | 迁移、便携包、完整恢复、Doctor strict、通用性证明和发布门禁 |

执行者开始或完成一个阶段时，必须同时更新本表与对应阶段末尾的执行记录；不能只勾选任务而不保存验证证据。

### 5.6 首发补充能力追踪矩阵

本表是 12 项首发能力的覆盖索引。任何一行只有在“契约、实现、自动化测试、浏览器/CLI 验收、U12 发布门禁”均有证据时才能标记完成。

| # | 首发能力 | 主契约 | 主要阶段 | 支撑阶段 | 核心验收 |
|---|---|---|---|---|---|
| 1 | 需求/工作负载模型 | `RequirementSpec` | U2 | U0、U6、U9-U11 | 只有需求、零硬件也可保存；hard/soft 不混淆 |
| 2 | 整机自动求解 | `SolverCandidate` | U6、U10 | U0、U5、U11-U12 | 候选经权威 evaluator；无解返回冲突集；安全假绿为 0 |
| 3 | 情景分支/what-if/并排比较 | `ScenarioBranch`、`WhatIfResult` | U2、U6 | U8-U12 | 试算不改活动方案；同 snapshot 可复现并归因差异 |
| 4 | 随盒附件/紧固件/工具 | `BundleItem`、`AssemblyRequirement` | U5、U6 | U0、U3-U4、U8、U11-U12 | 装配所需项目逐项解析为已含/需购/未证实/阻断 |
| 5 | 个性化装机与首启指南 | `BuildProcedure`、`ExecutionSession` | U7、U8 | U0、U6、U11-U12 | 步骤绑定领域 dependency hash，刷新可恢复并选择性失效 |
| 6 | BIOS/固件更新可行性 | firmware facets/plan | U6、U7 | U3-U5、U11-U12 | 无可执行升级路径不得宣称能首启；官方文件/步骤可追溯 |
| 7 | NAS/TrueNAS 存储布局 | `LogicalLayoutSelection`、`StorageLayoutEvaluation` | U7 | U2、U5-U6、U8、U11-U12 | 输入/派生分离；容量、容错、路径、扩容和破坏性风险可解释 |
| 8 | 用户观察证据 | `UserObservation` | U3、U4 | U0-U2、U5-U6、U8-U12 | 仅作用当前 plan/subject revision；撤回或 subject 变化使结论失效 |
| 9 | 价格历史/目标价/买等 | `PriceHistoryPoint`、`PriceTarget` | U10 | U0-U1、U4、U11-U12 | 历史不冒充当前价；精确变体、去重提醒、重启保留 |
| 10 | 便携导出/完整备份恢复 | `BackupManifest` | U1、U12 | U0、U2-U3、U7、U10-U11 | 空 runtime 恢复后权威 hashes 一致；secret 命中为 0 |
| 11 | 持久后台任务 | `BackgroundJob` | U1、U4 | U3、U7、U10-U12 | 中途杀进程可续跑且无重复副作用；离线可暂停 |
| 12 | 本地部署 Doctor | `DoctorCheckResult` | U1、U12 | U0、U3-U4、U7、U10-U11 | 默认零写入；能检出损坏/悬空引用/stuck lease；strict 通过 |

交叉边界：用户需求、评估器生成的 `RequirementNode`、用户观察和装机步骤是四类不同对象；不得共享同一状态字段或相互冒充。便携导出与整站备份不得共用一个模糊“导出”按钮。

---

## 6. U0：契约冻结、基线和黄金夹具

### 依赖

无。

### 目标

固定当前行为、用户决策、失败基线和通用验收样本，防止后续只让 N6 演示继续通过。

### 任务

- [x] 将本计划加入 `docs/ROADMAP.md`，明确其取代“additional case adapters are unscheduled”的旧定位。
- [x] 新增 `docs/architecture/topology-v3.md`，把第 4.1 节细化为正式 schema。
- [x] 新增 `docs/architecture/fact-resolution.md`，固定证据阶梯、冲突、更新和推断策略。
- [x] 新增 `docs/architecture/decision-semantics.md`，固定 `pass/fail/blocked` 和安全规则。
- [x] 把第 4.0-4.12 节固化成正式 schema 与边界文档；至少覆盖 canonical/domain hash、渐进 `RequirementSpec`、solver/what-if、package contents、assembly/commissioning、firmware、NAS input/evaluation、user observation、simulation input、price history/target、background job、portability/backup 和 Doctor。
- [x] 冻结 metric/facet/unit/observation-field registries、比较符和 plan/simulation JSON Patch allowlist；禁止 Agent、solver 和 evaluator各自解释自由文本 DSL。
- [x] 新增 `HashSpec` 跨 runtime 黄金向量；Node/browser 对 Unicode、数字、集合排序、单位规范化和 self-hash 排除必须输出相同 hash。
- [x] 冻结两类 requirement：config 中的用户目标与 evaluation 中的派生缺口；新增 contract test 禁止把派生 requirement 持久写回 config。
- [x] 修复当前过期的 skill 版本测试断言，确保全量测试只有可解释的环境失败。
- [x] 保存当前 catalog、case、constraint、price、plan schema 的 hash manifest。
- [x] 保存当前空白方案和 N6 方案的 v2 导出 fixture。
- [x] 新增 `tests/fixtures/builds/`，建立以下黄金方案：
  - [x] 普通 ATX Windows 游戏 PC；
  - [x] 核显办公 PC；
  - [x] TrueNAS 多盘 NAS，含 HBA/背板；
  - [x] 多扩展卡工作站；
  - [x] Mini-ITX 紧凑主机；
  - [x] 真空白方案；
  - [x] 只有部分部件的渐进方案。
- [x] 负面 fixture 覆盖 socket、BIOS、DDR、PSU 连接、PCIe lane、机箱净空、启动盘、显示输出、网卡驱动、错误模组线和 12V-2x6 弯折。
- [x] 为首发补充能力新增离线 fixture：
  - [x] 只有预算/工作负载/hard-soft 需求、没有硬件的空白方案；
  - [x] 可求解、`unsat_proven` 且返回 irreducible conflict、搜索超限只返回 partial 的三组需求；
  - [x] 固定 snapshot 的单部件/system/NAS layout what-if；
  - [x] 缺螺丝、错螺柱、多余螺柱、缺支架、缺工具和随盒数量/revision 不符；
  - [x] Windows 与 TrueNAS 的 bench test、pre-power、first-power、失败分支；
  - [x] 已兼容 BIOS、需要 flashback、多阶段 bridge、无可行升级路径；
  - [x] mirror、RAIDZ1/2、混盘、SMR、HBA 非 IT mode 和无法唯一定位待清盘磁盘；
  - [x] 照片、标签、BIOS 截图、带误差量尺、观察撤回和跨方案隔离；
  - [x] 当前价格、两年稀疏历史、目标价跨线与重启去重；
  - [x] job 中断续跑、`.buildsim` 往返、完整 backup/restore 和 Doctor 损坏检测。
- [x] 新增架构测试：通用模块不得新增 N6 import。
- [x] 为 v3、facts、observations、generic adapter、progressive evaluation、solver/what-if、build execution、storage layout、price history/target、durable jobs、portability/backup 和 Doctor repair 增加默认关闭的 feature flags。
- [x] 记录当前性能、bundle、浏览器、内存释放和 API 大小基线。

### 主要文件

- `docs/ROADMAP.md`
- `docs/architecture/`
- `tests/fixtures/builds/`
- `tests/architecture-boundaries.test.ts`
- `tests/universal-platform-baseline.test.ts`
- `tests/requirements-contract.test.ts`
- `tests/solver-contract.test.ts`
- `tests/build-execution-contract.test.ts`
- `tests/user-observation-contract.test.ts`
- `tests/nas-layout-contract.test.ts`
- `tests/portability-contract.test.ts`
- `tests/portable-profile-validation.test.ts`
- `tests/content-hash-golden-vectors.test.ts`
- `tests/requirement-draft-contract.test.ts`
- `tests/storage-selection-evaluation-separation.test.ts`
- `scripts/runtime/flags.mjs`

### 聚焦验证

```bash
npx vitest run tests/capability-config.test.ts tests/plan-migration.test.ts tests/upgrade-guardrails.test.ts tests/architecture-boundaries.test.ts tests/content-hash-golden-vectors.test.ts tests/requirements-contract.test.ts tests/requirement-draft-contract.test.ts tests/solver-contract.test.ts tests/build-execution-contract.test.ts tests/user-observation-contract.test.ts tests/nas-layout-contract.test.ts tests/storage-selection-evaluation-separation.test.ts tests/portability-contract.test.ts tests/portable-profile-validation.test.ts
npm run typecheck
npm test
```

### 退出门禁

- [x] 空白 fixture 为零组件、零连接、零 BOM、零几何。
- [x] 至少四种用途的黄金方案都有 expected verdict。
- [x] 所有已知失败和环境限制有书面记录。
- [x] feature flags 默认关闭时当前行为不变。
- [x] 后续阶段可以用 fixture 证明“通用”，而不是只截图 N6。
- [x] 用户需求、派生 remediation、用户观察和装机步骤在 schema/test 中不能互相冒充。
- [x] 同一输入 hashes 的 solver 候选顺序确定；候选必须再次经过权威 evaluator。
- [x] 空白方案仍为零硬件节点，即使已经保存工作负载、预算或系统建议。
- [x] budget-only、workload-only 和所有字段 deferred 的需求均可保存；未确认 Agent proposal 不会变成 hard constraint。
- [x] config/requirement/fact/observation/adapter/model/artifact hashes 在 Node 与浏览器完全一致，self-hash 无歧义。

### 回滚

仅回退 U0 新增文档、fixture、测试和 feature flag；不修改用户现有计划数据。

### 推荐提交

`docs(plan): freeze universal hardware contracts and fixtures`

### U0 执行记录（2026-08-27）

- 状态：已完成（U0 契约、fixture、false-green 复审和跨 runtime 门禁通过）
- 提交：基础集成 `c8aa2ab`，U0 契约/fixture `c6fea37`；已推送 `origin/codex/complete-universal-hardware-platform`
- 主要变更：
  - 已新增 U0 架构文档、正式契约、冻结 registries、HashSpec、通用/故障 fixtures、N6 债务 ratchet 与默认关闭的 rollout flags。
  - 已消除 fixture 自证、调用方自证和契约/registry 漂移；正式 server-facing gate 只接受服务器签发的 resolver/ref，raw JSON context 不能冒充可信状态。
- 数据迁移：
  - dry-run：U0 不改运行时数据；不适用。
  - manifest：`tests/fixtures/baseline/u0-source-hashes.json`
  - rollback：仅回退 U0 新增文档、fixtures、tests 与默认关闭 flags；不删除或重写用户数据。
- 聚焦测试：22 files / 115 tests 通过（含权威 U0 命令、扩展 trusted-boundary/fixture 合同）。
- 全量测试：managed sandbox 123/124 files、744/745 tests 通过；唯一失败是 loopback `listen EPERM`，同一测试获批回环重跑 1/1 通过，合计无产品失败。
- TypeScript/build/secret：`npm run typecheck`、`npm run build` 通过；secret scan 459 files、0 findings。
- 浏览器测试：最终隔离 Chromium 验收通过，七类正式 schema hash 向量与 Node 7/7 完全一致；空白/模板/保存/3D/Agent 审批/交易/刷新/三视口均通过。
- live smoke：U0 未运行外部网络 smoke；本阶段不据此声明官网、价格或 provider 健康。
- 未解决限制：
  - legacy evaluator、UI 与空间/线束路径仍含冻结的 N6 债务；U5-U9 必须迁出而不能提高 ratchet。
  - runtime repository、持久任务、备份/恢复与 Doctor runner 属于 U1，生产发布门禁仍为阻断状态。
- 下一阶段前置条件：已满足；U1 仍必须实现 resolver 背后的真实 repository/runner，不得用 U0 的 stub 或纯 validator 代替持久化、恢复和 Doctor 证据。

---

## 7. U1：runtime 数据隔离、持久任务与可恢复运维基础

### 依赖

U0。

### 目标

先解除全局 SKU 被用户成交价/owned 数据污染的问题，统一所有 runtime repository 的持久性边界，并在上层联网能力开始前建立 durable jobs、可验证备份 SPI 和只读 Doctor 基础。

### 任务

- [ ] 定义只包含产品身份和稳定 seed 的 `ProductCatalogSeed`。
- [ ] 定义 runtime `ProductCatalogOverlay`，不再直接修改镜像内 seed 文件。
- [ ] 从全局 SKU 删除 `paid`、owned 数量、用户成交备注和用户标签。
- [ ] 把用户成交/订单信息迁入 plan transaction 或 plan-scoped purchase record；首发不持久化姓名、电话和收货地址。
- [ ] 无法确定所属方案的用户数据进入 quarantine，绝不默认绑定新方案。
- [ ] 把 facts、domain registry overlay、price observations/history/targets、snapshots、audit、evidence、attachments、observations、jobs、execution sessions、exports、backups 和 diagnostics 全部放入 `/app/runtime` 下的明确子目录。
- [ ] 将官方域名改为“镜像 seed + runtime overlay”；所有读取走同一 repository，批准后当前进程立即可见。
- [ ] 移除 Agent/evaluation 对静态 `latest.json` 的运行时权威依赖。
- [ ] 修复 price service 重启或容器重建后价格数据丢失。
- [ ] 为 repository 写入增加原子 rename、expected hash、并发锁、备份和 rollback manifest。
- [ ] 建立 `AttachmentRepository`、plan-scoped `ObservationRepository`、`JobRepository`、`ExecutionRepository` 和 `ArtifactRepository`；blob 内容寻址，元数据/隐私类别/引用与 blob 分离。
- [ ] 建立跨 repository 引用图和只读 consistent-snapshot/export SPI，供便携导出、完整备份、Doctor 以及未来安全 GC 共用。
- [ ] 落地 durable job scheduler/worker 骨架：revision CAS、lease/fencing token、heartbeat、checkpoint、runtime generation、idempotency key、attempt、dependency、offline pause、restore quarantine、cancel 和 dead-letter；不允许 U4/U10 各自再建内存队列。
- [ ] 落地 `scripts/backup/create.mjs`、`verify.mjs`、`restore.mjs` 骨架；实现 maintenance lease、staging/root pointer/runtime generation，`plan_portable` 与 `full_local_backup` 使用不同 mode，迁移 rollback manifest 不冒充用户备份。
- [ ] 落地只读 Doctor CLI 与稳定 JSON schema，先覆盖 runtime 权限/空间、repository manifest/hash、snapshot pointer、服务版本和 job lease；repair flag 默认关闭。
- [ ] 完整备份排除 API key、`.env`、cookie、浏览器 profile/cache并记录 excluded reason；`private_user` 与内层 manifest 使用 authenticated encryption，私密包权限 `0600`，密钥不进包。
- [ ] 建立 `BackupVerificationReport`、portable `ArtifactLockfile/ImportPlan` 和引用 necessity；complete portable 必须离线精确 replay，slim portable 明确按当前 runtime 重评。
- [ ] Doctor 增加 mandatory checks/strict exit、结构化脱敏 evidence 和版本绑定 `RepairPlan`；默认命令无写入，repair 先重验 preconditions 与备份。
- [ ] 定义 runtime quota/retention 与基于引用图的 mark-and-sweep：活动 snapshot、审计、备份/导出引用对象不可删，GC 默认 dry-run、幂等并有 quarantine/恢复窗口。
- [ ] 重写 price audit 入口：客户端只能提交服务端已捕获的 observation/candidate ID，不能提交任意价格、source hash 或 provenance hash。
- [ ] URL 必须验证 platform 域名、协议、重定向、variant 和 canonical form。
- [ ] 为所有 repository 增加 corruption、partial write、concurrent write 和 restart tests。

### 主要文件

- `src/sku/catalog.ts`
- `src/sku/types.ts`
- `scripts/price-server/catalog/repository.mjs`
- `scripts/price-server/catalog/registry.mjs`
- `scripts/price-server/catalog/domain-proposals.mjs`
- `scripts/price-server/store.mjs`
- `scripts/price-server/price-audit.mjs`
- `deploy/osaka/compose.yaml`
- 新增 `scripts/migrations/isolate-user-data-v1.mjs`
- 新增 `src/attachments/`、`src/observations/`、`src/jobs/contracts.ts`、`src/build-execution/repository.ts`、`src/backup/contracts.ts`、`src/doctor/contracts.ts`
- 新增 `scripts/jobs/`、`scripts/backup/`、`scripts/doctor.mjs`

### 聚焦验证

```bash
npx vitest run tests/catalog-runtime-repository.test.ts tests/catalog-domain-proposals.test.ts tests/price-audit.test.ts tests/price-catalog-runtime-routes.test.ts tests/attachment-repository.test.ts tests/observation-repository.test.ts tests/execution-repository-restart.test.ts tests/background-job-repository.test.ts tests/background-job-restart.test.ts tests/background-job-fencing.test.ts tests/restored-job-quarantine.test.ts tests/runtime-backup-manifest.test.ts tests/runtime-reference-graph.test.ts tests/backup-encryption.test.ts tests/doctor-readonly.test.ts tests/doctor-strict-exit.test.ts tests/runtime-gc.test.ts tests/osaka-deployment.test.ts
```

### 退出门禁

- [ ] 全局 SKU 不包含任何用户 paid/owned 数据。
- [ ] 38 个现有 SKU 的 legacy 字段已进入迁移清单，不因缺 provenance 被继续当作活动 official fact。
- [ ] 新品牌域名批准后无需重启即可使用。
- [ ] 价格服务重启、容器重建和 Agent 读取都看到同一 runtime snapshot。
- [ ] 任意客户端构造的 URL/价格不能直接成为 audited observation。
- [ ] 所有数据迁移可 dry-run、可审计、可回滚。
- [ ] 重启后附件、用户观察、价格历史/目标、job 状态/进度和产物引用不丢失。
- [ ] 两个 worker 不能同时提交同一 job；相同 idempotency key 不产生重复 fact/price/proposal。
- [ ] consistent backup manifest 能列出全部 repository root/snapshot pointer；并发写入时要么取得一致屏障，要么明确失败。
- [ ] 默认 Doctor 对 runtime 零写入且输出无 secret/PII；构造的坏 hash、悬空引用和过期 lease 能被检出。
- [ ] 过期 worker/旧 runtime generation 的提交为 0；恢复后的非终态 job 不会自动运行。
- [ ] execution sessions 重启不丢；完整备份 manifest 包含其引用闭包。
- [ ] 默认备份中的 plaintext private-user/secret 命中为 0；失败恢复不切换 active pointer。

### 回滚

关闭 runtime overlay flag，恢复只读 seed；用 migration manifest 恢复旧文件。不得把已隔离的用户数据重新并回全局 SKU。

### 推荐提交

- `refactor(data): isolate product facts plan data and runtime stores`
- `feat(runtime): add durable jobs backup spi and doctor foundation`

---

## 8. U2：BuildConfig V3 实例拓扑、需求、情景与渐进档案

### 依赖

U1。

### 目标

用实例、安装位和连接边替换固定 `selection`，同时把用户需求、NAS 逻辑布局、firmware 目标和不可变情景纳入渐进档案，让零硬件需求、重复型号和部分方案都可保存、版本化和提案。

### 任务

- [ ] 新增 `src/topology/contracts.ts`、`validation.ts`、`normalize.ts` 和 `hash.ts`；派生 requirement 实现放在独立 `src/requirements/`，不得成为 config 字段。
- [ ] 实现 `BuildConfigV3`、`ComponentInstance`、`RoleDecision`、`PlacementEdge`、`ConnectionEdge`、`RequirementSpec`、`LogicalLayoutSelection`、`FirmwareTarget` 和 `SystemSelection`；当前 observation/派生结论不得进入这些持久输入类型。
- [ ] 需求允许逐字段保存并区分 hard/soft、must/important/nice-to-have、用户已确认/尚未回答；预算、工作负载、容量、吞吐、噪音、体积和周期均可在零硬件时存在。
- [ ] 建立可治理的 `component kind registry`，首批覆盖本计划范围内全部内部硬件。
- [ ] 每个重复部件展开为独立稳定 instance ID。
- [ ] 允许 identity unresolved 节点保存用户原话和候选。
- [ ] 真实 component instance 状态严格限制为 `planned/ordered`，默认 planned；`not_needed` 只存 `RoleDecision`。
- [ ] 真空白档案不创建默认 Windows 硬件节点、GPU none 节点或任何隐式用户需求；用户随后可以只添加需求而保持零硬件。
- [ ] `not_needed` 作为用户明确的角色排除表达，不使用假 SKU `gpu.none`，不创建 component instance，也不伪装成派生 `RequirementNode`。
- [ ] BOM 改为 topology projection；删除 profile default 注入。
- [ ] NAS 物理盘保留独立实例；pool/vdev/mirror/RAIDZ 使用逻辑布局节点/边，同一物理盘不能同时进入互斥活动 vdev。
- [ ] 附件/observation 存在方案域 repository，config 不内嵌 blob、提取正文或当前观察值；当前 BIOS 来自 observation snapshot，目标版本/设置来自 `firmwareTargets`。
- [ ] 建立独立 `ScenarioRepository`，实现 `ScenarioFamily/ScenarioBranch/WhatIfResult`：分支以父 plan version + 固定 snapshots + allowlisted patch 表达，不进入 config；接受后才生成普通 plan proposal。
- [ ] 修改 plan proposal allowlist，使 Agent 能按 instance/edge 做增量 proposal。
- [ ] pending Agent plan 与普通空白 plan 统一，取消必须一次完整初始化的特例。
- [ ] 每轮自然语言输入只提案明确识别的节点、状态、角色、连接和用户需求，不自动填满其余硬件或把 Agent 猜测升级成用户 hard constraint。
- [ ] 增加 canonical ordering，确保相同语义产生稳定 config hash。
- [ ] 增加 V2 → V3 迁移：
  - [ ] case/board/cpu/psu/cooler/gpu/memory 转独立实例；
  - [ ] `diskSkuId + diskCount` 展开实例；
  - [ ] `nvmeCount` 无 SKU 时生成未解析 NVMe，不得生成 980 PRO；
  - [ ] `gpu.none` 转 GPU role 的 `RoleDecision(not_needed)`，GPU instance 数仍为 0；
  - [ ] fan groups 生成未解析风扇需求；
  - [ ] `owned → ordered` 并记录 migration note；
  - [ ] 其他采购 bucket → planned；
  - [ ] 不猜测 workload、预算、BIOS 当前/目标版本、NAS pool/vdev、随盒附件、工具可用性、用户观察或首次启动状态；
  - [ ] 旧版本文件保持不可变；首次编辑时创建 v3 draft。
- [ ] 导出迁移前后 diff、warnings 和 rollback reference。

### 主要文件

- 新增 `src/topology/`
- 新增 `src/requirements/`
- 新增 `src/scenarios/`
- `src/config/types.ts`
- `src/config/io.ts`
- `src/config/validate.ts`
- `src/plans/contracts.ts`
- `src/plans/validation.ts`
- `src/plans/proposals.ts`
- `src/plans/migration.ts`
- `src/plans/canonical.ts`
- `src/plans/default-plan.ts`
- `src/server/domain-tools.ts`
- `skills/plan-initializer/SKILL.md`

### 聚焦验证

```bash
npx vitest run tests/plan-contracts.test.ts tests/plan-migration.test.ts tests/agent-plan-proposal.test.ts tests/capability-config.test.ts tests/topology-v3.test.ts tests/topology-user-requirements.test.ts tests/topology-role-decision.test.ts tests/topology-logical-layout.test.ts tests/what-if-plan-isolation.test.ts tests/scenario-hash-isolation.test.ts tests/config-v3-migration.test.ts
```

### 退出门禁

- [ ] 两块相同 SSD 可有不同槽位、角色和状态。
- [ ] 多 GPU、NIC、HBA、不同硬盘和多个 DIMM 可同时表达。
- [ ] 未识别型号可保存并继续版本化。
- [ ] 空白和部分方案都没有隐式部件或 BOM。
- [ ] Agent 连续多轮增量提案不会覆盖前一轮事实，也不会补造未提到部件。
- [ ] V2 N6 迁移不新增 Samsung SSD、Exos、HBA 或线材。
- [ ] 旧版本可只读复现；v3 新版本可回滚。
- [ ] 用户可只保存需求而不选择任何硬件；派生 requirement 在 config 中的数量恒为 0。
- [ ] what-if 完成后活动 config/version hash 不变，stale base snapshot 会被拒绝。
- [ ] 相同 topology 的不同 scenario metadata 产生相同 config/spatial hash；无独显方案为 0 个 GPU instance + 1 条显式 role decision，真空白两者均为 0。

### 回滚

关闭 v3 flag，继续用 v2 reader；保留已经生成的 v3 文件但不删除。旧不可变版本不做逆向重写。

### 推荐提交

- `refactor(topology): add v3 component instance graph`
- `feat(requirements): add progressive requirements and scenario branches`

---

## 9. U3：Fact/Claim 图、身份、冲突与更新快照

### 依赖

U2。

### 目标

让每个参与评估的值都成为可版本化、可更新、可冲突、可追溯的 claim，并增加严格 plan/subject-revision-scoped 的用户观察快照；替换当前粗粒度 `evidence: official` 和任意 `attrs`。

### 任务

- [ ] 新增 `src/facts/contracts.ts`、`resolver.ts`、`conflicts.ts`、`identity.ts`、`snapshots.ts` 和 `inference-policy.ts`。
- [ ] 扩展 evidence contract，支持 claim、单位、scope、revision、region、有效时间、supersession 和 locator。
- [ ] 实现 claim-level identity：family/model/variant/revision。
- [ ] 为字段定义 `safetyClass`，并在 resolution policy 中强制安全红线。
- [ ] 建立 `FactRepository` 和内容寻址 `FactSnapshot`。
- [ ] 建立 plan/subject-revision-scoped `UserObservationRepository` 和内容寻址 `UserObservationSnapshot`，并把 observation snapshot hash 纳入 evaluation/cache key。
- [ ] 用户观察记录 typed subject、governed fieldId、method、time、unit、uncertainty、attachment refs、config/subject hashes、确认/验证和失效原因；只有 active 且当前有效时投影为 `authority: user_observation`。
- [ ] 定义观察激活/失效/撤回 CAS：更换实例/槽位/port、改变 route、重新刷 BIOS、附件删除或用户 retract/supersede 后，依赖 fact/decision/checkpoint 失效；附件删除保留 tombstone/hash。
- [ ] 建立 `ConflictSet`；官网内部、官网与第三方、revision/地区冲突都不能静默覆盖。
- [ ] 实现受审批的补充和替换；替换必须引用旧 fact hash 和 `supersedesFactId`。
- [ ] 实现 `UpdateDecision`：accept/reject/defer/undo、作用方案、subject/claim/revision 记忆。
- [ ] 方案版本锁定 fact snapshot；新事实只发送 update notice，不静默改变旧方案。
- [ ] 用户接受更新后生成 evaluation diff；撤销后恢复旧 snapshot 并重算。
- [ ] evaluation cache key 使用完整 `SnapshotHashes` 与 adapter/engine/simulation artifact closure；任一 adapter/model 更新必然 cache miss，旧 evaluation 标记 stale。
- [ ] 建立 package contents、fastener/tool need、firmware release/CPU support/upgrade method、磁盘 sector/CMR-SMR/endurance/HBA mode 的正式 claim schema。
- [ ] BIOS facts 按 board revision/region 记录 CPU support since version、bridge version、flashback/BMC/普通升级、回退和 firmware file hash；不得从同系列主板继承。
- [ ] 逐步把 catalog `attrs` 转为治理 facets；未迁移的 legacy 字段进入 `legacy_unverified`，不能继续作为硬结论。
- [ ] 为现有 N6/ASUS 捆绑手册建立正式 claim locator。
- [ ] 写扫描器：活动 official fact 缺 evidence hash/locator 时测试失败。

### 主要文件

- 新增 `src/facts/`
- 新增 `src/observations/`
- `src/evidence/contracts.ts`
- `src/evidence/repository.mjs`
- `src/sku/types.ts`
- `src/plans/evaluation.ts`
- `src/plans/contracts.ts`
- `src/server/evaluation-service.ts`
- 新增 `scripts/price-server/facts/repository.mjs`
- 新增 `scripts/migrations/migrate-facts-v1.mjs`

### 聚焦验证

```bash
npx vitest run tests/evidence-repository.test.ts tests/plan-evidence.test.ts tests/catalog-identity.test.ts tests/evaluation-diff.test.ts tests/fact-resolution.test.ts tests/fact-snapshot.test.ts tests/user-observation-resolution.test.ts tests/user-observation-scope.test.ts tests/user-observation-activation.test.ts tests/user-observation-subject-lifecycle.test.ts tests/observation-attachment-erasure.test.ts tests/observation-snapshot.test.ts tests/adapter-model-cache-invalidation.test.ts tests/bios-fact-resolution.test.ts tests/update-decision.test.ts
```

### 退出门禁

- [ ] 任一兼容、空间、热噪或采购输入可追到 claim/evidence 或推导链。
- [ ] Agent 推断能完整重放，输入 fact 更新后自动失效。
- [ ] family fact 不能越权支持 variant/revision 安全字段。
- [ ] 官网更新不静默覆盖；accept/reject/defer/undo 可复现。
- [ ] 修改一个尺寸、接口或功耗 fact 后，受影响 evaluation hash 变化。
- [ ] 没有 provenance 的 legacy 值不会被显示为已验证 official。
- [ ] 用户量尺修改/撤回会改变 observation snapshot 和受影响 evaluation hash，但不会影响其他方案/实例或全局 SKU。
- [ ] 缺 uncertainty 的量尺不能支持临界机械 pass；用户观察不能单独绿色放行 pinout、线径、电流或额定安全字段。
- [ ] unconfirmed/proposed/stale observation 用作 fact 的数量为 0；换槽/port/route 后旧观察不能产生 pass，新导出不含已删除附件 bytes。

### 回滚

关闭 fact graph flag，保持旧 catalog 只读。不得删除新 FactRepository；旧方案继续锁定旧 snapshot。

### 推荐提交

- `feat(facts): add claim graph snapshots and reversible updates`
- `feat(observations): add plan scoped user evidence`

---

## 10. U4：官网 → 第三方 → Agent 推断闭环

### 依赖

U3。

### 目标

完成从用户原话/附件到受治理事实或观察 proposal 的持久联网解析闭环，并让 Agent 对官网缺失原因给出机器可读、用户可理解的说明。

### 任务

- [ ] 定义 `EvidenceSearchOutcome.reason`：
  - [ ] `official_not_published`；
  - [ ] `official_page_found_field_missing`；
  - [ ] `official_identity_unresolved`；
  - [ ] `official_access_blocked`；
  - [ ] `official_parse_failed`；
  - [ ] `official_sources_conflict`；
  - [ ] `official_search_exhausted`。
- [ ] 将文档 discovery、acquisition、archive、OCR/PDF parse、excerpt、claim extraction、第三方 fallback、adapter candidate 和 binding 串成 U1 `JobRepository` 上的持久状态机；不得保留进程内权威 Map。
- [ ] 首发 job handler 至少覆盖 official discovery/acquire/extract、third-party fallback、fact update impact、adapter generation；使用 revision CAS、active fencing token、runtime generation、checkpoint、域名限速、指数退避 + jitter 和幂等结果提交。
- [ ] Agent 增加审批型 tools：`archive_official_evidence`、`propose_fact_update`、`bind_fact_evidence`、`resolve_fact_conflict`。
- [ ] 官网文档只有正文确认 exact identity/revision 后才能成为 explicit official document。
- [ ] 官网 registry 采用 seed + runtime overlay，支持未知品牌 proposal。
- [ ] 扩展 category/vendor adapters，覆盖 socket、BIOS/QVL/CPU support/update manual、package contents/fasteners/tools、端口拓扑、线材、散热/风扇曲线、磁盘介质/HBA mode 和 TrueNAS 官方要求等当前缺失字段。
- [ ] 增加审批型附件/观察 tools：`archive_user_attachment`、`inspect_attachment`、`propose_user_observation`、`bind_observation_attachment`；照片标签、BIOS 页面、OCR、条码和量尺只能形成 plan-scoped proposal。
- [ ] 图片默认剥离非必要 EXIF，原件内容 hash 不变；限制 MIME、像素、页数、大小、解压比和处理时间，附件正文同样按不可信输入隔离。
- [ ] 建立第三方来源 registry，记录来源类型、独立性、测试方法和对象 revision。
- [ ] 一份合格专业实测可形成低置信 third-party fact；两份独立一致来源提升置信度。
- [ ] 检测转载/同源，不能把多个转载算成独立证据。
- [ ] Agent inference 只能引用已解析 facts；禁止以模型记忆直接补造数值。
- [ ] 推断记录规则/模型版本、输入 hashes、公式、假设、区间和失效条件。
- [ ] 普通推断可支持 planning pass；安全红线只允许 blocked/fail，不能单独 pass。
- [ ] Agent 每次回答展示：采用的证据阶梯、未找到官方的原因、第三方来源、推断说明和补证动作。
- [ ] 保留网页/PDF 为不可信数据，强化 prompt injection、HTML/PDF payload、XSS、SSRF、redirect 和大小/时间上限测试。

### 主要文件

- `src/evidence/acquire.mjs`
- `src/evidence/discovery.mjs`
- `src/evidence/http-routes.mjs`
- `src/evidence/excerpts.mjs`
- `scripts/price-server/catalog/`
- 新增 `scripts/price-server/evidence/third-party-registry.mjs`
- 新增 `scripts/price-server/evidence/third-party-acquire.mjs`
- `src/server/domain-tools.ts`
- `src/agent/runtime.ts`
- `src/agent/plan-context.ts`
- `skills/plan-initializer/SKILL.md`
- `skills/geometry-evidence-audit/SKILL.md`
- `scripts/jobs/handlers/`
- `src/attachments/`
- `src/observations/`

### 聚焦验证

```bash
npx vitest run tests/evidence-acquisition.test.ts tests/evidence-discovery.test.ts tests/evidence-excerpts.test.ts tests/catalog-enrichment-closure.test.ts tests/catalog-browser-security.test.ts tests/runtime-catalog-xss.test.ts tests/agent-tools.test.ts tests/evidence-ladder.test.ts tests/inference-policy.test.ts tests/background-job-restart.test.ts tests/background-job-idempotency.test.ts tests/background-job-fencing.test.ts tests/job-crash-after-effect.test.ts tests/background-job-cancellation.test.ts tests/attachment-security.test.ts tests/agent-observation-tools.test.ts
```

### 退出门禁

- [ ] ASUS、Intel、Samsung、Seasonic 和至少两个新增品牌完成离线 E2E fixture。
- [ ] 验证码页、错误页、系列页不会升级成 exact official fact。
- [ ] 第三方永远不显示为 official。
- [ ] 搜索失败原因可见、可测试、可审计。
- [ ] 推断可以重放并随输入失效。
- [ ] 无法证明安全时产生 blocked 和补证任务，不制造确定值。
- [ ] 在 download/OCR/extract 任一阶段杀进程后可从安全 checkpoint 续跑，不重复生成 claim/adapter；取消不留下半活动 snapshot。
- [ ] 恶意附件、错误 OCR 和附件中的 prompt injection 不会升级成产品事实；用户附件永远不显示为 official。
- [ ] 离线 job 进入 `paused_offline`，恢复网络后继续；dead-letter/脱敏错误和人工重试动作可见。
- [ ] stale lease/旧 generation worker commit 为 0；外部重复 GET 只产生一个内容寻址 capture 和一个事务结果。

### 回滚

关闭 external evidence/inference flags；保留已归档证据和 fact snapshots，不删除历史。

### 推荐提交

`feat(evidence): close official third-party inference resolution loop`

---

## 11. U5：通用 capability、标准库和 adapter registry

### 依赖

U3。可与 U4 并行，但在 U6 前必须稳定。

### 目标

把 N6 专属 imports、常量和分支替换为可组合 facets、随盒供给、标准规则、候选索引和 runtime adapter，让新增硬件不修改核心 evaluator 或 solver。

### 任务

- [ ] 新增 `src/capabilities/facets.ts`、`registry.ts`、`provider.ts`。
- [ ] 新增 `src/standards/` 和 `data/standards/`，首批覆盖 CPU socket、DIMM、PCIe、M.2、SATA/SlimSAS、USB、风扇/pump header、ATX/EPS/PCIe/12V-2x6 等标准。
- [ ] 新增 package supply、mount-fastener pattern、tool/consumable need facets；普通螺丝/扎带/导热膏/工具由 requirement/supply 表达，影响几何或电气的 riser/支架/转接板仍是 component instance。
- [ ] 产品级 `BundleItem` 按 exact owner component instance 投影为 instance supply；allocation 必须包含 `ownerInstanceId + bundleItemId`，防止不同设备随盒物或同一物件被重复消耗。
- [ ] 新增 firmware facets：CPU/version support table、普通升级/USB flashback/BMC、bridge version、rollback/recovery、settings reset、TPM/Secure Boot/CSM/Above 4G/ReBAR/IOMMU/SATA mode/ECC。
- [ ] 新增 storage facets：logical/physical sector、CMR/SMR、TRIM/endurance、controller/HBA IT/RAID mode、passthrough、hot-swap/backplane 和 failure domain。
- [ ] 建立 requirement → capability 候选索引，solver 只按白名单 facet predicate 取候选，不按品牌/SKU 名称字符串搜索；索引与 evaluator 使用同一 fact snapshot。
- [ ] 新增 `src/adapters/contracts.ts`、`registry.ts`、`data-driven-case.ts`。
- [ ] 定义通用 case manifest：外壳、内部空间、mount、slot、bay、fan/radiator、port anchor、routing zone、forbidden zone、service corridor、assembly constraints。
- [ ] 每个 manifest 字段绑定 fact/derivation ID 和误差范围。
- [ ] 将 N6 profile/geometry/routing/assembly 迁成普通 adapter 数据。
- [ ] 移除 `caseCapabilities()` 只认 N6 的 registry 分支。
- [ ] 逐步删除核心对 `buildN6Geometry`、`planN6Wiring`、`N6_INTERIOR_BOX` 等静态依赖。
- [ ] 删除 SKU 名称字符串判断，如 A4000 专用分支；用 capabilities/facts 表达。
- [ ] 未支持机箱流程：
  - [ ] 解析 exact identity；
  - [ ] 获取官网产品页/手册/图；
  - [ ] 抽取官方外形、form factor、限高/限长、安装位；
  - [ ] Agent 生成 provisional geometry/routing candidate；
  - [ ] 每个推断 anchor 标误差和来源；
  - [ ] schema/几何/端口/闭合性校验；
  - [ ] 用户审核更新后写入 runtime adapter registry；
  - [ ] plan-scoped 用户量尺可以形成当前实例 override，但不能回写全局 adapter seed；
  - [ ] 证据不足只阻断受影响空间/走线，不阻断其他已知电子兼容。
- [ ] 建立普通 ATX、mATX、Mini-ITX 和 NAS 背板四类 adapter fixtures，至少来自三个不同机箱布局、两个以上厂商。
- [ ] 增加 architecture boundary test：通用 core 禁止包含具体机箱名称。

### 主要文件

- 新增 `src/capabilities/`
- 新增 `src/standards/`
- 新增 `src/adapters/contracts.ts`
- 新增 `src/adapters/registry.ts`
- `src/core/capabilities.ts`
- `src/core/physical.ts`
- `src/spatial/model.ts`
- `src/adapters/jonsbo-n6/`
- `data/cases/jonsbo-n6/`
- 新增 `src/assembly/resources.ts`

### 聚焦验证

```bash
npx vitest run tests/capability-config.test.ts tests/geometry.test.ts tests/routing.test.ts tests/architecture-boundaries.test.ts tests/generic-adapter.test.ts tests/case-manifest-validation.test.ts tests/package-supplies.test.ts tests/bios-capabilities.test.ts tests/storage-capabilities.test.ts tests/requirement-capability-index.test.ts tests/adapter-observation-override.test.ts
```

### 退出门禁

- [ ] N6、普通 ATX、普通 mATX、Mini-ITX 使用同一 registry/evaluator。
- [ ] 新增第二款非 N6 机箱时不修改核心 evaluator。
- [ ] 通用模块不 import N6 数据。
- [ ] 删除 N6 adapter 代码后，等价数据 manifest 仍通过 N6 黄金测试。
- [ ] 未支持机箱可生成 provisional adapter；不能生成时有明确 blocked/补证结果。
- [ ] `nvmeCount=0` 或无 NVMe 实例时 3D 不出现 SSD。
- [ ] 随盒附件只在 exact region/revision/quantity 匹配时满足 requirement；不能用“通常附带”静默放行。
- [ ] 新增 CPU 支持表、HBA mode 或 package contents 不需要修改 evaluator；用户量尺只影响当前方案实例。
- [ ] adapter/standard/capability manifest 进入 `adapterSnapshotHash/ArtifactLockfile`；更新后旧 evaluation/cache 必然失效。

### 回滚

通过 adapter registry flag 回到 legacy N6 adapter；保留新 manifests 和 facts，不删除 runtime adapter。

### 推荐提交

`refactor(adapters): add generic capability and hardware registry`

---

## 12. U6：渐进兼容、真实启动与整机可行性求解

### 依赖

U4、U5。

### 目标

移除“配置不完整就整体短路”，按规则依赖评估已知子图，闭合附件/工具/firmware/首启需求，并用同一权威 evaluator 完成有界整机可行性求解与只读 what-if。

### 任务

- [ ] 新增 `src/compatibility/contracts.ts`、`engine.ts`、`requirements.ts`、`explain.ts`。
- [ ] 将 `src/config/validate.ts` 限定为 schema/引用完整性；硬件兼容迁入 rule engine。
- [ ] 每条规则声明需要的 component kinds、facts、placements、connections 和 system profile。
- [ ] 已知输入足够时立即评估；缺少普通部件生成 requirement；缺少安全事实生成 blocked。
- [ ] 实现 `RequirementNode` closure、cycle detection 与 `RequirementSatisfaction` 数量分配；候选部件继续产生的支架/线材/紧固件/耗材/工具需求必须运行到固定点。
- [ ] 分离“档案完整度”“身份完整度”“兼容 verdict”“系统可用 verdict”。
- [ ] 实现规则域：
  - [ ] CPU socket、芯片组、BIOS support；
  - [ ] 主板 form factor、螺柱、I/O 与机箱；
  - [ ] RAM DDR/UDIMM/RDIMM/ECC、容量、rank、population、CPU IMC/QVL；
  - [ ] GPU/HBA/NIC/扩展卡的 slot、lane、bifurcation、共享和空间；
  - [ ] PSU 总功率、瞬态、ATX24、EPS、GPU 接头、模组线家族；
  - [ ] 散热器 socket kit、高度、内存/VRM 干涉、冷排位置；
  - [ ] M.2 key/长度/SATA/NVMe、lane sharing、散热片；
  - [ ] SATA/SlimSAS/HBA/背板和启动盘；
  - [ ] 前置 USB/Type-C/音频；
  - [ ] fan/pump/RGB header 数量、电流和控制方式；
  - [ ] NAS 启转负载、背板供电和 HBA 模式。
- [ ] 增加装配完整性/首次通电规则：正确/多余螺柱、螺丝规格、散热器背板/扣具/保护膜、导热材料、ATX24/EPS/GPU、CPU fan/pump、12V-2x6 插入/弯折、松散金属件和必要工具。
- [ ] U6 独占纯 `FirmwarePathEvaluation`/upgrade graph：使用 release fact 有向边计算当前版本观察、最低支持版本、bridge release、flashback/BMC/普通升级前置、临时 CPU/RAM/显示路径、settings reset 和回退 requirements；“存在目标 BIOS”不等于当前组合可升级。
- [ ] 增加 NAS logical layout 结构规则：boot/data 分离、物理盘唯一归属、HBA/port 路径、控制器 mode 和 destructive target 唯一定位。
- [ ] 新增 `src/solver/candidate-index.ts`、`solve.ts`、`requirement-closure.ts`、`unsat.ts`、`what-if.ts` 和 `explain.ts`，先完成有界可行性求解：
  1. [ ] 锁定用户指定及 ordered 实例；
  2. [ ] 从 hard requirements 与当前 topology 生成 requirement closure；
  3. [ ] 用 capability index 和硬规则剪枝候选池；
  4. [ ] 每个候选调用当前阶段可用的同一权威 evaluator，保存 evaluated domain coverage；
  5. [ ] 只有证明无解才返回 `unsat_proven`；否则返回 irreducible conflict/放宽项，超时返回 `feasible_partial` 与未探索范围；
  6. [ ] what-if 固定 base hashes、保持只读，接受结果仍走普通 proposal。
- [ ] 求解作为 durable job 保存 candidate config/operations、base version/hash、seed/version/limits/checkpoint；重启后可复算/批准，同一 base 得到同一 hash，stale base 拒绝。
- [ ] BOM 只由 topology、requirements 和状态派生。
- [ ] 价格、证据和局部兼容在方案不完整时继续显示。
- [ ] 修复空盘位生成数据线和零硬盘仍要求完整背板供电的错误。
- [ ] 每条 decision 输出 rule ID/version、fact IDs、instance IDs、假设和 remediation。

### 主要文件

- 新增 `src/compatibility/`
- 新增 `src/requirements/`
- 新增 `src/solver/`
- 新增 `src/firmware/`
- `src/core/evaluate.ts`
- `src/core/engine.ts`
- `src/core/physical.ts`
- `src/core/policy.ts`
- `src/config/validate.ts`
- `src/wiring/plan.ts`
- `src/server/evaluation-service.ts`

### 聚焦验证

```bash
npx vitest run tests/engine.test.ts tests/reviewed-gpu-evaluation.test.ts tests/wiring-backplane.test.ts tests/wiring-data-path.test.ts tests/progressive-evaluation.test.ts tests/compatibility-rules.test.ts tests/electrical-safety.test.ts tests/requirement-closure.test.ts tests/requirement-allocation-conservation.test.ts tests/package-supplies.test.ts tests/package-instance-supply.test.ts tests/ordered-is-not-present.test.ts tests/fastener-safety.test.ts tests/firmware-upgrade-path.test.ts tests/whole-build-solver.test.ts tests/solver-unsat-proof.test.ts tests/solver-determinism.test.ts tests/solver-restart-approval.test.ts tests/what-if-evaluation.test.ts
```

### 退出门禁

- [ ] 只录入机箱、主板、CPU、两块 SSD 和 PSU 时立即显示已有身份、证据、价格和局部结论。
- [ ] 同时列出内存、散热、启动/显示等缺失 requirements。
- [ ] 不生成不存在的 GPU、HDD、HBA、风扇或线材。
- [ ] CPU/socket 或 PSU 接线已知错误时立即 fail，不等待整机完整。
- [ ] 安全证据不足稳定 blocked，不显示绿色。
- [ ] Agent 权威评估与本地评估 hash 一致。
- [ ] 每个安装必要附件均有 instance-scoped package allocation、用户 resource assertion、采购 requirement 或明确 blocked；没有“盒里应该有”的隐式满足，也没有重复数量分配。
- [ ] `powerReady=false` 直到全部 safety requirements 满足；普通勾选不能绕过安全 requirement。
- [ ] `ordered`、官网 included claim 或 unverified allocation 都不能单独使 `powerReady=true`；必须有 `present_verified` 或安全 checkpoint。
- [ ] U6 输出仅称 `feasibility_candidate`；不得提前称“可购买”或假定 U7-U9 尚未评估的 domain 已通过，固定 ordered 实例不会被替换。
- [ ] 同 snapshot/version 的候选顺序稳定；无解状态与证明匹配；`feasible_partial` 只能称“已找到的候选”，不能称全局最优。
- [ ] what-if 对 PlanRepository 的写操作为 0；base snapshot 过期时拒绝应用。

### 回滚

保留 legacy evaluator 只读 fallback；关闭 progressive rules flag。不得恢复 profile default BOM 注入。

### 推荐提交

- `feat(compat): add progressive compatibility and bootability rules`
- `feat(solver): add bounded whole build feasibility and what-if`

---

## 13. U7：系统 profiles、firmware、首次启动与 NAS 布局

### 依赖

U6。

### 目标

把“硬件能装”扩展为“firmware 路径可执行、目标系统能安装/首启并满足用途”；同时提供 Windows/TrueNAS 等系统说明、版本绑定执行清单和可审计 NAS 存储布局。

### 任务

- [ ] 新增 `src/system-profiles/contracts.ts`、`registry.ts`、`defaults.ts`、`requirements.ts`、`evaluate.ts` 和 `compare.ts`。
- [ ] 新增 `data/systems/`，系统事实引用官网 support lifecycle、硬件要求和驱动/兼容资料。
- [ ] 实现 machine intent 默认建议：PC/工作站 → Windows，NAS → TrueNAS。
- [ ] 默认建议必须记录 `source: defaulted`；用户选择记录 `source: user` 并锁定。
- [ ] Agent 在第一次默认时给出简短理由和至少一个相关替代方案。
- [ ] 系统 profile 检查 BIOS/UEFI、启动设备、显示输出、网卡/存储驱动、HBA 模式、ECC/IPMI 和安装前置条件。
- [ ] TrueNAS profile 检查启动介质、磁盘/HBA 拓扑、直通方式和 NIC 支持。
- [ ] Windows profile 检查 CPU/platform 支持、启动方式、驱动和显示路径。
- [ ] 消费 U6 `FirmwarePathEvaluation`，在 `src/build-execution/bios-plan.ts` 和 `settings.ts` 中生成官方文件/步骤、介质/文件名、断电风险、恢复与升级后设置 procedure；U7 不重复实现 upgrade graph/evaluator，不自动执行刷写。
- [ ] 新增 `src/build-execution/contracts.ts`、`first-boot.ts`、`commissioning.ts`、`checklist.ts`；生成绑定 `procedureSafetyHash` 的 bench test、pre-power、first-power、POST、OS install 和 verification 步骤及失败分支，并持久写入 U1 `ExecutionRepository`。
- [ ] Windows 首启覆盖最小化 POST、debug LED/code、内存训练、BIOS 识别、异常温度停机、UEFI/TPM/Secure Boot、安装介质、驱动与显示路径；涉及 BitLocker/设备加密时先提示恢复密钥。
- [ ] TrueNAS 首启覆盖启动池、磁盘唯一定位、HBA IT mode、控制器/端口映射、安装目标复核和数据盘禁止误清除。
- [ ] 新增 `src/storage/contracts.ts`、`capacity.ts`、`truenas.ts`、`expansion.ts`、`explain.ts`；只读取 config 的 `LogicalLayoutSelection`，派生 `StorageLayoutEvaluation`：实际可用容量、容错、混盘损失、故障域、path decisions、spare、结构化扩容和 resilver 风险。
- [ ] 任何 wipe/install step 生成独立 `DestructiveActionPlan`，列出精确 disk instance 和临时 device locator，确认绑定 safety hash；无法唯一定位、输入已变或未单独确认时只能 blocked。固定显示“RAID/RAIDZ 不是备份”。
- [ ] 新增 `docs/guides/system-selection.md`，比较 Windows、TrueNAS、主流 Linux、Unraid、Proxmox 等相关系统。
- [ ] 新增统一 explanation registry，每个比较结论有稳定 `helpRef`。
- [ ] UI 新增可访问问号按钮，打开说明 dialog/页面；不复制一份旁路文案。
- [ ] Agent 和 UI 使用相同 explanation/helpRef。
- [ ] 系统版本变化通过 fact/update flow 提醒，不静默改方案。

### 主要文件

- 新增 `src/system-profiles/`
- `src/firmware/`（消费 U6 的 path evaluation，不重复建 evaluator）
- `src/build-execution/`
- 新增 `src/storage/`
- 新增 `data/systems/`
- 新增 `docs/guides/system-selection.md`
- 新增 `src/lab/system-panel.ts`
- 新增 `src/lab/help-link.ts`
- `src/server/domain-tools.ts`
- `src/lab/workspace-pages.ts`
- `src/plans/contracts.ts`

### 聚焦验证

```bash
npx vitest run tests/system-choice.test.ts tests/system-compatibility.test.ts tests/platform-accessibility.test.ts tests/agent-tools.test.ts tests/bios-plan.test.ts tests/bios-safety.test.ts tests/firmware-procedure-integration.test.ts tests/first-boot-windows.test.ts tests/first-boot-truenas.test.ts tests/commissioning-gates.test.ts tests/safety-step-cannot-skip.test.ts tests/procedure-selective-invalidation.test.ts tests/execution-repository-restart.test.ts tests/truenas-storage-layout.test.ts tests/storage-selection-evaluation-separation.test.ts tests/destructive-action-confirmation.test.ts tests/nas-capacity.test.ts tests/nas-expansion.test.ts
```

### 浏览器验收

- [ ] 新建 PC：硬件为空，出现 Windows 默认建议与解释，不自动添加购买项。
- [ ] 新建 NAS：硬件为空，出现 TrueNAS 默认建议与解释。
- [ ] 用户改选系统后刷新、保存、版本恢复和 Agent 重评估都不覆盖。
- [ ] 问号可键盘操作、焦点返回正确、具有 `aria-label`。
- [ ] 切换系统后兼容和 requirement 确定性重算。
- [ ] 打开 BIOS/首启步骤可追到当前 plan version/procedure safety hash；刷新后 checkpoint 保留，价格刷新不影响机械确认，相关配置/安全事实变化只失效依赖步骤。
- [ ] NAS 布局编辑器能显示每个 vdev 的物理盘、容量、容错、controller path、扩容限制和破坏性目标。

### 退出门禁

- [ ] 机械兼容与系统可用分开显示。
- [ ] 默认建议可解释、可修改、可锁定。
- [ ] 系统比较说明和 Agent 回答引用同一事实/帮助条目。
- [ ] 目标系统缺关键驱动或启动链路时 fail/blocked，不声称可用。
- [ ] BIOS 当前版本未知时产生明确观察动作；CPU 需要更高版本且无可行升级路径时系统/boot verdict 不得 pass。
- [ ] 首启 checklist 与当前 topology、firmware plan、系统 profile 一致；步骤状态不改变 `PlanItemState`，不声称实物健康。
- [ ] NAS 容量/容错计算可复现，同一盘不能属于两个活动 vdev，未唯一定位磁盘时不生成可执行破坏步骤。
- [ ] ExecutionSession 可多次建立、重启恢复和标记 stale；安全步骤不能 skip，所有 readiness 均由当前 requirement/checkpoint 派生。
- [ ] config 中只有 NAS selection；派生容量/容错/风险不会写回。destructive confirmation 在 safety hash 变化后失效。

### 回滚

关闭 system profile flag；保留用户 system selection 数据。不得重置用户已锁定选择。

### 推荐提交

- `feat(system): add Windows and TrueNAS profiles with help guide`
- `feat(execution): add firmware first boot and storage layout plans`

---

## 14. U8：通用 3D、走线、公差与电气安全

### 依赖

U5-U7。

### 目标

把当前 N6 方盒/waypoint 规划器升级为数据驱动的通用安装、附件使用与走线预演；插头方向允许推导，但所有空间结论包含误差和安全余量，并可生成个性化 assembly procedure。

### 任务

- [ ] 新增 `src/geometry/types.ts`、`frames.ts`、`instantiate.ts`、`tolerance.ts`、`collision.ts`、`service-space.ts`。
- [ ] 几何实体支持局部坐标系、父 mount、6DoF pose、包络、插拔扫掠体、XYZ/角度公差。
- [ ] 新增 `src/interconnect/types.ts`、`connector-library.ts`、`instantiate.ts`。
- [ ] 每个 port 记录 connector family、公母、keying、pose、插拔方向、额定用途和 provenance。
- [ ] 每根关键 cable instance 记录两端、pinout family、长度、线径、额定电流、分叉位置、直/弯头和最小弯曲半径。
- [ ] 将 routing 拆成 graph、solver、bend、bundle-capacity、assembly-order。
- [ ] 从可走区域、穿线孔和禁入区生成 route graph，而不是依赖 N6 固定 waypoint。
- [ ] 对障碍物按公差和服务余量膨胀后求最坏路径。
- [ ] 用户照片/量尺通过 observation override 提供端口 pose、净空、线长或穿线孔尺寸；显示测量端点、误差和 scope，不冒充厂商 CAD。无可靠比例尺的照片不能产生绝对毫米值。
- [ ] 增加附件标注模型/工具：两点量距、接口方向、实例/port/mount 绑定；只解除依赖该观察的 decision。
- [ ] 检查线长、弯折、束径、开孔容量、侧板空间、服务环、维修空间和装配顺序。
- [ ] 电气安全独立于机械“插得上”：模组 PSU pinout、EPS/PCIe 误用、12V-2x6、菊链电流、背板浪涌分别判定。
- [ ] 渲染器显示连接方向、公差带、blocked 位置和建议替代路径。
- [ ] 保留 BoxGeometry fallback；可选 glTF/mesh 不能成为兼容结论唯一依据。
- [ ] 未添加的实例不得出现在 geometry 或 route 中。
- [ ] 不再用固定 `Math.min(socket, 3)` 等坐标映射代替真实接口实例。
- [ ] 根据 topology、assembly constraints、requirements 和 route 顺序补全 `BuildProcedure` 的 mechanical/wiring 阶段；输出附件、工具、耗材、操作顺序、安全 stop condition 和替代路径。
- [ ] NAS 逻辑盘映射到具体 bay、controller port、backplane path 和 cable；UI 能在物理盘与逻辑角色间双向导航。
- [ ] what-if 支持旧/新包络、碰撞和 route diff 叠加，但场景对象不得进入活动 spatial scene。

### 主要文件

- 新增 `src/geometry/`
- 新增 `src/interconnect/`
- 新增 `src/routing/`
- 新增 `src/safety/electrical.ts`
- 新增 `src/assembly/plan.ts`
- `src/core/geometry.ts`
- `src/core/routing.ts`
- `src/spatial/model.ts`
- `src/spatial/three-renderer.ts`
- `src/spatial/overlays.ts`
- `src/adapters/jonsbo-n6/`

### 聚焦验证

```bash
npx vitest run tests/geometry.test.ts tests/routing.test.ts tests/spatial-routing.test.ts tests/spatial-scene-model.test.ts tests/geometry-tolerance.test.ts tests/routing-property.test.ts tests/electrical-safety.test.ts tests/geometry-user-observation.test.ts tests/attachment-annotation.test.ts tests/nas-physical-logical-map.test.ts tests/assembly-procedure.test.ts tests/spatial-what-if.test.ts
npm run test:spatial:browser
```

### 退出门禁

- [ ] 净空大于误差 + 公差 + 服务余量才 pass。
- [ ] 公差区间可能碰撞时 blocked。
- [ ] 每根必需线有唯一两端；不支持共享的 port 不得重复占用。
- [ ] 最坏路径长度超过线长、弯折不足或开孔容量不足时 fail/blocked。
- [ ] 外形相同但 PSU pinout family 不同的线材 fail。
- [ ] 空盘位不生成数据线；无 NVMe 实例不绘制 NVMe。
- [ ] 至少三种机箱布局能显示真实 topology 驱动的 3D 与走线。
- [ ] observation 误差跨越干涉边界时仍 blocked；观察撤回后相关通过项恢复 blocked。
- [ ] 每个装配步骤的附件/工具/线材需求都从中央 RequirementSatisfaction 读取；相关 procedure dependency hash 变化才标记对应步骤 stale。
- [ ] what-if 3D/route 不污染活动场景；NAS 每块盘的逻辑角色与物理路径可相互定位。

### 回滚

使用 spatial/routing feature flag 回到 legacy renderer/evaluator；新 topology 和 fact 数据保持不变。

### 推荐提交

`feat(spatial): add generic tolerance-aware cable routing`

---

## 15. U9：通用热模型与标准化硬件噪音

### 依赖

U8。噪音依赖负载、热模型和风扇/RPM 工作点。

### 目标

用需求/工作负载驱动的通用 airflow network 和可标准化声学曲线替代 N6 全局常量；支持 plan-scoped 校准与 what-if，输出区间、假设和贡献，不输出伪精确结果。

### 任务

- [ ] 新增 `src/thermal/types.ts`、`airflow-graph.ts`、`fan-operating-point.ts`、`steady-state.ts`、`scenarios.ts`、`calibration.ts`。
- [ ] 支持任意腔体、开孔、滤网、风扇、冷排、散热器和泄漏边。
- [ ] 热源来自 component instance 和 workload，不从 N6 profile 注入。
- [ ] workload 必须来自当前 `RequirementSpec` 或用户显式选择的标准 scenario；未提供时展示默认假设并请求确认，不能从高端 SKU 反推“重负载”。
- [ ] 风量由 fan P-Q curve 和系统阻抗区间求工作点；无曲线时使用明确 inference range。
- [ ] 默认环境 `20-30°C`，UI 显示并允许覆盖。
- [ ] 输出器件/腔体温度区间和最坏场景；区间跨越安全上限时 blocked/fail。
- [ ] 保留 thermal field 作为展示插值，并明确非 CFD。
- [ ] 新增 `src/acoustics/types.ts`、`normalize.ts`、`operating-point.ts`、`aggregate.ts`。
- [ ] 声学事实记录 A-weighted、参考距离、负载、RPM、测试方法和来源。
- [ ] 只聚合能够归一化到共同条件的硬件声源。
- [ ] 输出各声源贡献、总区间和 quiet/normal/audible/loud 等级。
- [ ] 不加入房间、机箱遮挡、机箱共振或用户位置模型。
- [ ] coil whine 记录发生风险和来源，不加入确定性 dBA 总和。
- [ ] Agent 权威 evaluation 接受 workload/environment profile，不能永远返回 thermal unknown。
- [ ] plan-scoped observation 可输入环境温度、风扇 RPM、设备温度和符合记录条件的噪音测量；记录实例、负载、方法、距离、误差和时间，只校准当前方案区间，不提升成同型号全局事实。
- [ ] NAS layout 驱动磁盘并发、启转、热与 HDD 噪音场景；改变 vdev/盘位/控制器路径必须改变相应 simulation hash。
- [ ] 构建并冻结 `SimulationInput`；默认环境/工作负载/fan policy/storage activity/model version 全部进入 input hash，what-if 默认复用相同输入。
- [ ] solver 可消费用户 hard thermal/acoustic constraints；证据不足时返回 blocked/宽区间，不能把缺失噪音数据当作满足“静音”。
- [ ] what-if 输出温度/声学区间变化、主要贡献和变化来源，保持相同环境/工作负载口径。

### 主要文件

- 新增 `src/thermal/`
- 新增 `src/acoustics/`
- `src/core/thermal.ts`
- `src/core/thermal-field.ts`
- `src/core/evaluate.ts`
- `src/server/evaluation-service.ts`
- `src/server/domain-tools.ts`
- `src/lab/view-models.ts`

### 聚焦验证

```bash
npx vitest run tests/thermal.test.ts tests/thermal-field.test.ts tests/thermal-network.test.ts tests/acoustics.test.ts tests/agent-evaluation-server.test.ts tests/thermal-user-calibration.test.ts tests/acoustic-user-observation.test.ts tests/solver-thermal-acoustic-constraints.test.ts tests/simulation-input-hash.test.ts tests/layout-spatial-simulation-hash.test.ts tests/simulation-what-if.test.ts
```

### 数值性质测试

- [ ] 能量守恒误差在声明容差内。
- [ ] 功耗升高不能让最高预测温度下降。
- [ ] 风扇关闭或阻抗增加不能改善温度。
- [ ] 两个独立 30 dBA 声源聚合约为 33.01 dBA。
- [ ] 不同参考距离能正确归一化。
- [ ] 不可比较的声学数据不直接相加。

### 退出门禁

- [ ] 通用热模型不 import N6 profile。
- [ ] UI 和 Agent 显示区间、工作点、假设和 evidence。
- [ ] 缺关键安全输入时 blocked，不生成单点温度。
- [ ] 噪音明确为硬件标准化结果，不称房间实际噪音。
- [ ] 用户观察只改变当前方案，撤回后恢复未校准区间；不同距离/负载的声学 observation 不直接相加。
- [ ] 未满足严格热/噪 hard constraint 的候选不进入 U10 可购买排名；NAS layout 变化会重算热噪。
- [ ] 价格或情景元数据变化不改变 simulation hash；相同环境下改变 vdev 会改变 layout/simulation hash。

### 回滚

关闭 thermal/acoustic v3 flags；保留旧模型仅作为 N6 fixture，不作为通用默认。

### 推荐提交

`feat(simulation): add generic thermal and normalized acoustic models`

---

## 16. U10：中国价格历史、目标价与整机推荐

### 依赖

U3、U4、U6-U9。只有 U7-U9 完成并重验证当前 hard domains 后，feasibility candidate 才能进入可购买排名。

### 目标

建立可信但不过度严格的中国全新当前价、历史、目标价和买/等口径，并只对 U6 生成、经 U7-U9 全域重验证后晋升为 `purchase_eligible` 的完整整机应用用户的长期骨架/易替换件哲学做透明排序。

### 任务：价格

- [ ] 新增 `src/price/policy.ts`、`confidence.ts` 和服务端 `price-observations.mjs`。
- [ ] listing capture 内容寻址并保留精确 variant、seller、库存声明、条件和抓取时间。
- [ ] PriceObservation 必须由服务端 capture 派生。
- [ ] 渠道分层：
  - [ ] S1：京东自营、品牌官方店、天猫官方旗舰店；
  - [ ] S2：可验证授权/专卖渠道；
  - [ ] S3：淘宝企业店、PDD 品牌/官方或有明确保修店；
  - [ ] S4：普通淘宝/PDD；允许低置信展示和备选。
- [ ] seller tier 必须有证据，不能只按平台名猜。
- [ ] 1 条有效 observation 显示低置信单点。
- [ ] 2 条以上独立 seller 显示 min-max 区间、样本数和平台分布。
- [ ] 72 小时 preferred、7 天 usable、超过 7 天 expired。
- [ ] 同一 seller 多链接不算独立样本。
- [ ] 极端价差进入 price conflict，不静默删除。
- [ ] 发票、保修、授权、跨境、券/会员条件作为排序和风险标签。
- [ ] 显示前重新检查 URL、variant 和库存声明；链接失效则降级/移除。
- [ ] 清理跟踪参数，保留必要商品和 variant 参数；不默认加入联盟链接。
- [ ] 无当前全新价时显示 unavailable 并寻找替代型号。
- [ ] 新增 `PriceHistoryRepository`，保留所有合法 observation 和不可变聚合点；current snapshot 只是时间序列投影，不覆盖原始历史。
- [ ] 历史按 exact variant、condition、seller、币种/地区和促销条件分组；统一使用 `comparableTotalCny = 商品价 + 必付运费 - 可无条件取得优惠`，会员/券/跨店条件单列。
- [ ] 同一 seller/商品的重复链接和同一 observation 幂等去重；过期报价可以进入历史但不得进入当前预算，二手/预售不进入“全新历史”。
- [ ] 历史图/统计显示窗口、样本数、覆盖天数、min/max/median、来源和缺口；数据覆盖不足时 market cycle 只能标为第三方/Agent inference。
- [ ] 实现 plan-scoped `PriceTarget` 和 watchlist：精确变体、目标到手价、最低 seller tier/大陆保修要求、期限和 enabled 状态。
- [ ] PriceTarget 编辑/停启使用 expected revision hash CAS，任何时刻只有一个 active head；并发 UI/Agent 修改产生冲突 proposal，不静默 last-write-wins。
- [ ] price recheck、history rebuild 和 target evaluation 使用 durable jobs + persistent `JobSchedule`；append-only `PriceTargetEvent` 按 target revision/snapshot/transition 去重，只在跨线时提醒，编辑、二次跨线、停启、重启/离线补桶和 restore replay 不重复，首发不发外部通知。
- [ ] 买/等建议显示当前价在可用历史窗口中的位置、未来扩容/替换摩擦、建议有效期、触发条件和反证；无足够历史时只能给保守 inference，不能伪造“历史低位”。

### 任务：推荐

- [ ] 新增 `src/recommendation/policy.ts`、`score.ts`、`market-cycle.ts`、`explain.ts`。
- [ ] 首先过滤 fail 和安全 blocked 候选。
- [ ] 建立透明初始权重，可由用户覆盖：
  - [ ] 当前工作负载价值 30%；
  - [ ] 有证据的可靠性 20%；
  - [ ] 维护便利 15%；
  - [ ] 使用周期内实际可用的扩展性 15%；
  - [ ] 替换摩擦/骨架稳定性 10%；
  - [ ] 当前市场价格位置和生命周期成本 10%。
- [ ] 额外惩罚单独展示，不藏入总分：
  - [ ] 暂时用不到的能力；
  - [ ] 无证据的品牌/新品溢价；
  - [ ] 异常价格周期；
  - [ ] 快速折旧且容易后续扩容。
- [ ] 骨架件默认 5 年，易替换/扩容件 2-3 年。
- [ ] 性能分数必须按目标 workload/benchmark，不做跨用途统一“性能”。
- [ ] 市场周期判断必须显示依据：本地历史、同代替代、发布周期或明确 Agent inference。
- [ ] 输出经济、平衡、长期三档；每档至少一个替代。
- [ ] 解释每项加减分、价格置信度、事实缺口和未来升级影响。
- [ ] 价格不足时可以给兼容候选，但不得声称性价比排名确定。
- [ ] 对 U6 candidate 用 U7-U9 已完成的 system/firmware/storage/spatial/simulation domains 重新运行同一 evaluator；只有全部 `requiredForPurchase` coverage 为当前 hash 的 pass、residual must 为 0，才能生成 `CandidatePromotionRecord(purchase_eligible)` 并排名。
- [ ] scoring/recommendation 不拥有第二套兼容逻辑，也不能把 hard requirement 转为扣分项；late-domain 失败的候选退回 excluded/blocked 并解释。
- [ ] 完成整机层排序：显示整机总预算、planned/ordered 拆分、每项价格置信度、骨架投入、可替换件投入、功耗/热噪/空间风险和升级路径。
- [ ] 固定 ordered/用户锁定实例后只求解其余缺口；不得为了高分替换锁定部件。
- [ ] 为经济、平衡、长期三档保存 requirement coverage、候选/剪枝摘要、solver/scoring version、全部输入 hashes 和未探索范围；`partial` 结果不显示“最优”。
- [ ] scenario compare 默认使用相同 snapshots 并分别显示用户输入差异与市场刷新差异；支持换型号、改预算/系统/NAS layout、延后采购，输出总价/兼容/热噪/3D/线材/升级路径 diff 与敏感性。

### 主要文件

- `src/price/types.ts`
- `src/price/merge.ts`
- `src/price/search.ts`
- 新增 `src/price/policy.ts`
- 新增 `src/price/confidence.ts`
- 新增 `scripts/price-server/price-observations.mjs`
- 新增 `scripts/price-server/price-history-repository.mjs`
- 新增 `scripts/price-server/price-target-repository.mjs`
- 新增 `src/price/history.ts`、`src/price/targets.ts`、`src/price/buy-wait.ts`
- `scripts/price-server/price-audit.mjs`
- 新增 `src/recommendation/`
- `src/solver/`
- `src/server/domain-tools.ts`
- `src/lab/price-panel.ts`

### 聚焦验证

```bash
npx vitest run tests/price-audit.test.ts tests/price-search.test.ts tests/price-snapshot.test.ts tests/price-observation.test.ts tests/price-history.test.ts tests/price-history-dedup.test.ts tests/price-target.test.ts tests/price-target-idempotency.test.ts tests/price-target-edit.test.ts tests/price-target-second-crossing.test.ts tests/price-target-restore-replay.test.ts tests/price-schedule-catchup.test.ts tests/market-cycle-evidence.test.ts tests/recommendation-score.test.ts tests/recommendation-safety.test.ts tests/solver-domain-promotion.test.ts tests/solver-late-domain-revalidation.test.ts tests/whole-build-ranking.test.ts tests/solver-ordered-lock.test.ts tests/recommendation-what-if.test.ts
npm run test:purchase-price:browser
```

### 价格验收样本

- [ ] 一条 48 小时有效报价：低置信单点。
- [ ] 两条 24 小时独立报价：市场区间。
- [ ] 一条 48 小时 + 一条 5 天报价：区间，标出 usable。
- [ ] 第 8 天：自动过期，不进入当前预算。
- [ ] 普通淘宝/PDD 精确全新变体：可低置信显示，不冒充 S1。
- [ ] 二手、预售、缺货、variant 不符、平台域名不符：不进入当前全新价。
- [ ] 目标价跨线只提醒一次；服务重启不重复，错误变体/二手/预售不触发；无新货时为 unavailable。
- [ ] 同一组历史在第 8 天仍可查询，但 current snapshot 已过期；历史最低价不显示成当前可买价。

### 退出门禁

- [ ] 页面、Agent 和权威评估读取同一 price snapshot。
- [ ] 单条低置信报价不会被显示成市场价。
- [ ] 推荐列表没有 fail/安全 blocked 候选。
- [ ] 排序完整解释用户哲学的加减分。
- [ ] 每个推荐有精确型号、证据、价格状态和备选。
- [ ] 历史/目标/触发去重状态在服务重启后不丢失；任何历史点可追到 observation IDs 和 snapshot。
- [ ] target 编辑/停启/二次跨线/恢复后 duplicate event count = 0；离线恢复最多补一个时间桶 job。
- [ ] 买/等建议显示有效期、历史覆盖和不确定性；样本不足时不确定宣称异常周期或确定最佳购买时机。
- [ ] 每个整机候选全部 hard requirements 满足且无 fail/安全 blocked；无当前价时预算明确不完整，不能声称价格优胜。
- [ ] 每个 ranked solution 引用当前 `CandidatePromotionRecord`；任一 required domain hash stale 时自动撤销 purchase eligibility 并重验证。

### 回滚

关闭 price observation/recommendation v3 flags；保留 capture 和 snapshot 历史，不删除。

### 推荐提交

- `feat(price): add China observations history targets and timing`
- `feat(recommendation): rank feasible whole build scenarios`

---

## 17. U11：统一 UI、Agent 体验与更新收件箱

### 依赖

U7-U10。

### 目标

把需求、拓扑、证据/观察、结论、装机/首启、NAS、3D、当前/历史报价、情景和推荐投影成一个一致的渐进体验，并加入任务、便携、备份和诊断入口，不建立第二套前端事实。

### 任务

- [ ] 新建空白方案只显示用途/系统建议和“添加第一个部件”，不显示默认部件。
- [ ] 提供渐进需求向导：用途/工作负载、硬目标、预算、容量/冗余/吞吐、体积/热噪和周期均可跳过；hard/soft、已确认/待确认清楚分开，外设目标不创建外设拓扑。
- [ ] Agent 从自然语言提取需求时先给细粒度 proposal；不得把推断的偏好静默标成用户 hard constraint。
- [ ] 提供整机求解入口、探索/partial 状态、无解冲突和经济/平衡/长期完整候选；每套显示 requirement coverage 与硬门槛证据。
- [ ] 提供 what-if 实验区和并排比较，显著标明“尚未写入方案”；接受后才进入普通 proposal，能分开显示输入变化与事实/市场刷新影响。
- [ ] Agent 对用户每轮描述生成小范围 proposal，逐项展示新增/修改/删除。
- [ ] 组件卡显示 instance、角色、状态、身份解析、证据阶梯和待补信息。
- [ ] 区分 `not_needed`、`planned`、`ordered`；`not_needed` UI 写入 RoleDecision 而非组件节点，提供 ordered → planned 回退。
- [ ] 方案完整度与兼容 verdict 分开显示。
- [ ] `pass/fail/blocked` 使用一致颜色、文字和可访问标签；不只依赖颜色。
- [ ] blocked 卡显示阻断原因和可执行补证动作。
- [ ] 证据面板显示 official/third-party/user-observation/agent-inference、原文定位、hash、版本和适用 scope。
- [ ] 支持附件导入、绑定 plan/instance/placement/connection/port/mount/firmware subject、隐私/EXIF 提示、处理 job、两点量距/方向标注和观察 proposal；观察卡显示 proposed/active/stale、方法、误差、subject revision、附件 hash、作用域与撤回。
- [ ] 更新收件箱显示旧值、新值、来源、受影响规则、evaluation diff、accept/reject/defer/undo。
- [ ] 3D 可选择 instance/finding/route，显示公差带和来源。
- [ ] 热噪面板显示区间、工作点、假设和声源贡献。
- [ ] 价格卡显示单点/区间、置信度、seller tier、时效、条件和 canonical link。
- [ ] 推荐卡显示硬门槛、分项得分、惩罚、时间跨度和备选。
- [ ] 附件/工具面板区分随盒已证实、随盒未证实、用户可用、需另购和 blocked；工具/耗材不混入内部硬件 BOM。
- [ ] 装机/首启页显示与当前 procedure safety hash 绑定的 bench test、assembly、wiring、pre-power、POST、firmware、OS install 步骤、stop conditions 和故障分支；刷新/重启恢复 ExecutionSession，按依赖选择性失效 checkpoint。
- [ ] BIOS 卡显示当前/最低/目标版本、可行 transition、官方文件/手册、临时硬件、设置 reset、风险和恢复；平台不提供自动刷写按钮。
- [ ] NAS 布局页同时显示 pool/vdev/盘 instance/bay/controller path、容量、容错、扩容限制、SMR/HBA 风险和待清盘目标；破坏性动作需要单独确认。
- [ ] 当前价与历史图/目标价/买等建议分栏；历史点不可呈现为当前购买链接，目标提醒进入现有更新收件箱。
- [ ] 系统问号连接到统一 helpRef/说明手册。
- [ ] Agent 输出引用同一 decision/fact/price/help IDs，不复制自由文本结论。
- [ ] `.buildsim` 便携导出提供 slim/complete/脱敏模式；complete 包含 config、requirement、fact/observation/price snapshots、execution、ArtifactLockfile 和所有 replay-required rules/system/adapter/engine/model artifacts，厂商原文可作为 optional audit ref。
- [ ] 导入先生成 `ImportPlan` dry-run：同 ID+hash no-op，同 ID 异 hash 只能复制为新档案或备份后替换；显示 ID remap、冲突、schema/hash/closure，绝不静默覆盖。
- [ ] 整站备份/恢复与单方案导出使用分开的入口、文案和权限提示；显示最近备份验证状态，不把“下载方案”说成灾难恢复。
- [ ] Job 中心显示 type、阶段、进度、waiting user/网络暂停/restore review、attempt、依赖、取消/重试/dead-letter 和脱敏错误；后台 job 结果仍走 candidate/update/proposal 审批。
- [ ] Doctor 页面只读投影 CLI 结果，显示完整性、磁盘/权限、版本/迁移、服务、浏览器/WebGL、parser、队列和备份；repair 必须打开影响预览、先备份并再次确认。
- [ ] 保持 desktop/tablet/mobile、键盘、screen reader、WebGL fallback 和离线体验。

### 主要文件

- `src/lab/workspace-pages.ts`
- `src/lab/plan-shell.ts`
- `src/lab/agent-panel.ts`
- `src/lab/evidence-panel.ts`
- `src/lab/spatial-view.ts`
- `src/lab/price-panel.ts`
- 新增 `src/lab/requirements-panel.ts`、`solver-panel.ts`、`scenario-compare.ts`
- 新增 `src/lab/attachments-panel.ts`、`build-procedure.ts`、`nas-layout.ts`
- 新增 `src/lab/job-status.ts`、`backup-panel.ts`、`doctor-panel.ts`
- `src/lab/view-models.ts`
- `src/lab/design-system.css`
- `src/server/domain-tools.ts`

### 聚焦验证

```bash
npx vitest run tests/plan-editor.test.ts tests/partial-ui-surfaces.test.ts tests/evidence-workspace-ui.test.ts tests/spatial-three-interaction.test.ts tests/platform-accessibility.test.ts tests/workspace-dashboard.test.ts tests/requirements-ui.test.ts tests/solver-ui.test.ts tests/what-if-ui.test.ts tests/attachment-ui.test.ts tests/first-boot-ui.test.ts tests/bios-ui.test.ts tests/nas-layout-ui.test.ts tests/price-history-ui.test.ts tests/job-center-ui.test.ts tests/portability-ui.test.ts tests/doctor-ui.test.ts
npm run test:agent-plan:browser
npm run test:spatial:browser
npm run test:platform:browser
```

### 浏览器验收路径

1. 新建空白 PC → 解释 Windows 默认 → 逐轮输入 5 个部件 → 每轮批准小 proposal。
2. 新建 NAS → 解释 TrueNAS 默认与备选 → 添加异构盘/HBA → 显示系统与背板要求。
3. 输入未预置机箱 → 展示官网搜索进度 → provisional adapter → blocked/通过空间结果。
4. 打开证据卡 → 查看官网缺失原因、第三方来源和推断链。
5. 接收一个官网更新 → 查看 diff → reject → undo → accept → evaluation 重算。
6. 查看 3D route、公差、热噪区间、价格低置信/区间和三档推荐。
7. 刷新、离线、恢复版本，结论和 snapshot 保持一致。
8. 从零硬件需求 → bounded solve → 查看无解/partial 解释 → 比较 what-if → 批准一个候选；试算前活动方案保持不变。
9. 上传 BIOS 截图和机箱量尺 → 确认 plan-scoped observation → 只重算相关 blocker → 撤回后恢复 blocked。
10. 检查随盒/需购附件 → 查看个性化装机与首次通电清单 → 刷新恢复 → 修改配置后旧安全确认失效。
11. 建立 TrueNAS mirror/RAIDZ 情景 → 导航物理盘/逻辑 vdev → 查看容量、容错、扩容与 destructive warning。
12. 设置目标价 → 模拟跨线提醒且不重复 → 查看买/等依据 → 当前报价过期但历史保留。
13. 中断并恢复一个搜证 job → 导出/再导入 `.buildsim` → 分开创建完整备份 → Doctor 发现构造的坏引用且不自动修复。

### 退出门禁

- [ ] 所有页面数据来自同一 BuildEvaluation snapshot。
- [ ] 无 hidden components、hidden BOM 或自动填满。
- [ ] Agent 文本不能直接修改方案；proposal 仍需明确批准。
- [ ] 更新决定可撤销且不会污染其他方案。
- [ ] 可访问性、清理、性能和 fallback 测试不退化。
- [ ] what-if 活动方案写入次数为 0；complete portable 缺 replay-required artifact 时拒绝导入，成功导入后权威 hashes 与 manifest 一致；slim 模式只承诺按当前 runtime 重评并明确差异。
- [ ] execution/checkpoint、job、target reminder 和 Doctor 状态刷新/进程重启后保持；所有 repair/破坏性动作均有独立确认。

### 回滚

通过 UI flag 回到旧 workspace projection；保留 v3 数据和新 snapshot，不回写 v2。

### 推荐提交

`feat(ui): integrate progressive evidence-first build workflow`

---

## 18. U12：迁移、便携恢复、通用性证明与发布门禁

### 依赖

U0-U11 全部完成。

### 目标

迁移现有数据，以便携往返、完整恢复、持久任务和 Doctor strict 证明本地部署可靠性，并证明新架构不是 N6 特例；未全部通过前保留旧路径。

### 任务：完成便携、恢复与诊断实现

- [ ] 完成 slim/complete `.buildsim` exporter、reference necessity graph、ArtifactLockfile、ImportPlan、ID remap、dry-run/conflict/rollback API；在非空 repository 验证 no-op、copy-as-new 和 replace-after-backup。
- [ ] 完成加密 `full_local_backup`、verification report、maintenance lease、staging restore、root pointer/runtime generation 切换和 crash recovery；错误密码、篡改、切换前后崩溃均不能破坏 active runtime。
- [ ] 完成所有 Doctor mandatory checks、strict exit、backup freshness/restore verification、结构化脱敏 report 和 RepairPlan executor；repair 重验 preconditions、幂等且 rollback 后 hash 恢复。
- [ ] 完成 restored job quarantine/fencing、price schedule catch-up、ExecutionSession closure 和 runtime quota/retention/安全 GC；任何删除先 dry-run 并尊重活动 snapshot/审计/备份引用。
- [ ] 完成脱敏诊断包；不得包含 raw path、网页正文、用户字段、secret、cookie 或 private attachment bytes。

### 主要文件

- 新增 `src/portability/`、`src/backup/`、`src/doctor/`
- `scripts/backup/create.mjs`、`verify.mjs`、`restore.mjs`
- `scripts/doctor.mjs`、`scripts/jobs/`、`scripts/runtime/`
- `src/server/backup-routes.ts`、`portability-routes.ts`、`doctor-routes.ts`
- `deploy/osaka/compose.yaml`
- `README.md`、`README.zh-CN.md`、`docs/ARCHITECTURE.md`、`docs/PROVENANCE.md`

### 数据迁移顺序

1. [ ] 先运行只读 Doctor；对 catalog、constraints、geometry、routing、prices、plans、evidence、attachments、observations、jobs、execution sessions、artifact locks 和 decisions 创建一致性完整备份并验证可恢复。
2. [ ] 运行 U1 用户数据隔离迁移。
3. [ ] 将已有完整 locator/hash 的字段迁为对应 authority facts。
4. [ ] 只有 `evidence: official` + URL/自由文本的字段迁为 `legacy_unverified`，不能成为活动安全事实。
5. [ ] 明确 planning/inferred 值补齐规则和输入；不能解释的进入 unresolved blocker。
6. [ ] 将 N6/ASUS 捆绑手册导入正式 evidence/claim 关系。
7. [ ] 当前旧价格记录保留为 legacy archive/history；没有 listing capture/seller/库存证据时不迁为当前报价，不能据此触发目标价。
8. [ ] 将 geometry、routing、thermal 输入绑定 fact/derivation IDs。
9. [ ] 运行 V2 → V3 plan migration，输出逐方案 report。
10. [ ] 重建 repository 引用图、FactSnapshot、UserObservationSnapshot、PriceSnapshot/history/target event/schedule index、job/execution index、ArtifactLockfile、完整 SnapshotHashes/DomainHashes。
11. [ ] 全量重算方案并保存 old/new evaluation diff。
12. [ ] 先以 opt-in flag 开启 V3；通过 soak 后再设为默认。
13. [ ] 旧收据/图片只迁为附件或交易证据，不自动成为产品 fact；无法确定 plan/instance scope 的观察进入 quarantine。
14. [ ] 旧 task/job 不猜测绑定新方案；无法可靠恢复的只进入历史收件箱，并显示没有自动重跑。

### 必须通过的通用 fixture

- [ ] ATX、Micro-ATX、Mini-ITX 各至少一套。
- [ ] 至少三款不同布局机箱，只有一款是 N6。
- [ ] 游戏 PC、无独显办公 PC、TrueNAS NAS、HBA 多盘 NAS、多扩展卡工作站。
- [ ] 至少一个运行时新发现、此前不在本地 catalog/case registry 的机箱。
- [ ] 多 SSD、多 DIMM、多 GPU/扩展卡、不同硬盘型号和多线材实例。
- [ ] socket/BIOS/RAM/PSU/PCIe/M.2/冷排/前置接口/系统驱动的正反例。
- [ ] 错误模组线、12V-2x6 弯折不足、header 超载和背板浪涌。
- [ ] 官网完整、官网缺字段、官网访问受阻、第三方补齐、Agent 推断、来源冲突和更新撤销。
- [ ] 一条价格、两条价格、过期价格、普通淘宝/PDD、无新货。
- [ ] hard/soft 需求、feasible/unsat/partial solver、locked ordered 部件和只读 what-if。
- [ ] 随盒/缺失附件、紧固件短路、工具、BIOS 无升级路径、首启安全 checkpoint。
- [ ] TrueNAS mirror/RAIDZ/混盘/HBA mode/唯一 destructive target。
- [ ] 用户量尺/照片/BIOS 观察、撤回、跨方案隔离和 attachment security。
- [ ] 价格历史/目标价/买等、job 重启/离线/去重、portable/backup/restore/Doctor。
- [ ] Node/browser canonical hash、adapter/model cache invalidation、procedure selective invalidation、restored job fencing 和 import ID conflict。
- [ ] 至少 ATX、ITX、NAS 三套未用于调参的 holdout：实测净空落入声明公差、建议线长不短于实物需要、可复现实测温度/标准化声学点落入预测区间。

### 端到端 canary

从空白方案输入：

- JONSBO N6；
- ASUS Pro WS W680M-ACE SE；
- Intel Core i5-14500；
- Samsung 980 PRO 1TB ×2；
- Seasonic FOCUS Plus Gold 850 (SSR-850FX)。

阶段 A：部分方案验收（保持用户原始输入，不补造硬件）：

- [ ] 两块 SSD 是两个实例，不来自 profile default。
- [ ] Agent 展示精确/家族 claim scope。
- [ ] 主板/CPU/SSD/PSU 官网事实可追溯。
- [ ] i5-14500 最大睿频功耗使用官方事实，不再从 65W × 1.35 猜测。
- [ ] 未选择内存、散热和显卡时仍显示局部评估与 requirements。
- [ ] PSU/背板线束区分“当前盘位需求”和“全背板未来能力”。
- [ ] 空盘位不生成假数据线。
- [ ] 3D/走线显示推断坐标、公差和 blocked 项。
- [ ] 缺内存/散热等关键输入时，总热噪为 partial/blocked，不输出完整温度/噪音，也不允许 `powerReady`。
- [ ] 中国新货价格按低置信单点或市场区间显示。
- [ ] procedure 只能生成当前安全的 prepare/measurement/补证步骤，不得生成可执行首次通电完成状态。

阶段 B：用户接受一套经 U7-U9 重验证的完整 solver candidate 后：

- [ ] 热噪显示工作负载区间、SimulationInput、假设和贡献。
- [ ] 推荐给出经济、平衡、长期完整方案和明确评分依据。
- [ ] 随盒附件、需购线材/紧固件/工具和 BIOS 更新可行路径均有明确状态；`ordered/included` 未验证在手时仍不满足 pre-power。
- [ ] 生成与完整配置一致的装机/首次通电程序；全部 safety checkpoint 未完成前 `powerReady=false`。
- [ ] 若将该例转为 NAS intent，可建立明确 boot/data layout、容量/容错/磁盘路径和 destructive warning；不得依赖 N6 专用逻辑。

### 跨产品首发 canary

N6 示例不能单独证明首发完成。还必须从另一份真空白方案执行以下厂商/形态无关路径：

1. [ ] 只输入用途、预算、hard/soft 工作负载目标，不输入任何 SKU。
2. [ ] bounded solver 生成至少一套可启动完整候选，另一个矛盾需求返回可解释冲突集。
3. [ ] 锁定一个 ordered 部件，分别 what-if 更换机箱、系统和存储布局；活动 plan hash 不变。
4. [ ] 使用此前未预置的非 N6 机箱，官网资料不足处由第三方/推断/用户量尺按阶梯补齐。
5. [ ] 展示随盒附件、需购附件/工具，生成 BIOS 路径、装机与首次通电清单。
6. [ ] 新建 TrueNAS 情景，规划 mirror/RAIDZ、物理路径、容量、容错和扩容，不执行任何清盘。
7. [ ] 建立当前价/历史/目标价，验证跨线提醒幂等和买/等不确定性。
8. [ ] 在 evidence download、OCR、solver、price recheck、adapter generation 中途分别重启 worker，确认恢复或安全失败。
9. [ ] 导出 `.buildsim` 并在空 plan repository dry-run/import；再将完整 runtime backup 恢复到临时空环境。
10. [ ] 运行 Doctor strict；恢复前后 config/evaluation/snapshot/decision hashes 和用户决定一致。

### 便携、恢复、任务与 Doctor 门禁

- [ ] `.buildsim` 导入支持 dry-run、冲突预览、checksum、schema 兼容、ID remap 和 rollback；绝对路径、`..`、symlink、重复路径、zip bomb、缺 required blob/artifact 和未知 schema 安全拒绝。
- [ ] 在空与非空 repository 测试重复导入/ID 冲突：同 hash no-op，异 hash 绝不静默覆盖；complete portable 离线精确 replay，slim 模式明确重评。
- [ ] 完整备份取得 maintenance lease 与一致性屏障；恢复失败不改变 active pointer，空环境恢复后 plans/facts/evidence/attachments/observations/prices/jobs/execution/decisions 与备份前引用闭包一致。
- [ ] `private_user`/内层 manifest 在备份中无明文；secret、cookie、浏览器 profile、订单地址和无关个人路径在默认 portable/full backup/诊断包中的明文命中数为 0。
- [ ] 在各 job 阶段杀进程后可继续或安全进入 retry/dead-letter；重复事务副作用为 0，stale worker/旧 generation 无法提交；恢复后的非终态 job 必须等待用户 review。
- [ ] Doctor 在新安装、迁移后和恢复后三种场景通过；能检出坏 blob、悬空 snapshot、过宽权限、stuck lease、pending migration 和未验证备份。
- [ ] Doctor 默认命令零写入；repair 先生成计划与备份、需显式批准、幂等且可回滚；离线只让网络检查 skipped/degraded，不误报数据损坏。
- [ ] Doctor strict exit/status/severity 符合冻结契约，report/repair plan 无 raw sensitive detail；错误 precondition 拒绝 repair，重复 repair 和 rollback hashes 可验证。

### false-green 与质量门禁

- [ ] 黄金安全 fixture 中 false-green = 0。
- [ ] fail/blocked 候选不会进入可购买推荐。
- [ ] 空白和部分档案 hidden component count = 0。
- [ ] 活动 official facts 缺 hash/locator count = 0。
- [ ] 全局 SKU 用户 paid/owned 字段 count = 0。
- [ ] 通用 core 对 N6 import count = 0。
- [ ] Agent/local evaluation hash mismatch count = 0。
- [ ] 过期价格进入当前预算 count = 0。
- [ ] 新增非 N6 adapter 需要修改核心 evaluator 的次数 = 0。
- [ ] solver 可购买候选中的 `fail/安全 blocked/residual must` count = 0。
- [ ] ranked solution missing/current-domain-mismatched promotion record count = 0。
- [ ] what-if active-plan mutation count = 0。
- [ ] user observation cross-plan leakage count = 0。
- [ ] historical price used as current price count = 0。
- [ ] job duplicate side effects count = 0。
- [ ] portable import unresolved missing refs count = 0。
- [ ] verified backup restore hash mismatch count = 0。
- [ ] Doctor unapproved writes count = 0。
- [ ] cross-runtime canonical hash mismatch count = 0。
- [ ] stale adapter/model evaluation reused count = 0。
- [ ] unconfirmed/stale observation used as fact count = 0。
- [ ] deleted attachment bytes in new export count = 0。
- [ ] stale worker commits count = 0；restored jobs auto-run count = 0。
- [ ] duplicate target event after edit/restart/restore count = 0。
- [ ] plaintext private-user matches in backup count = 0。
- [ ] old-generation writes after restore count = 0；failed restore active pointer changes count = 0。
- [ ] complete portable missing replay-required refs count = 0；silent import overwrite count = 0。
- [ ] portable profile ambiguity count = 0；slim imported as exact replay count = 0。
- [ ] Doctor raw sensitive detail count = 0；repair rollback hash mismatch count = 0。
- [ ] partial build false completion count = 0；unrelated price refresh invalidated safety checkpoint count = 0。

### 完整验证

```bash
npm run typecheck
npm test
npm run build
npm run agent:secret-scan
npm run test:g1:browser
npm run test:purchase-price:browser
npm run test:g7:browser
npm run test:workspace:browser
npm run test:spatial:browser
npm run test:agent-plan:browser
npm run test:agent-initialization:browser
npm run test:transactions:browser
npm run test:build-tasks:browser
npm run test:platform:browser
npm run test:c7:browser
npx vitest run tests/content-hash-golden-vectors.test.ts tests/whole-build-solver.test.ts tests/solver-domain-promotion.test.ts tests/solver-late-domain-revalidation.test.ts tests/what-if-evaluation.test.ts tests/package-supplies.test.ts tests/ordered-is-not-present.test.ts tests/commissioning-gates.test.ts tests/procedure-selective-invalidation.test.ts tests/partial-build-no-false-completion.test.ts tests/firmware-upgrade-path.test.ts tests/truenas-storage-layout.test.ts tests/destructive-action-confirmation.test.ts tests/user-observation-plan-isolation.test.ts tests/user-observation-subject-lifecycle.test.ts tests/observation-attachment-erasure.test.ts tests/price-history.test.ts tests/price-target-restore-replay.test.ts tests/background-job-fencing.test.ts tests/restored-job-quarantine.test.ts tests/portable-profile-validation.test.ts tests/portable-nonempty-import.test.ts tests/portable-offline-replay.test.ts tests/backup-roundtrip.test.ts tests/backup-encryption.test.ts tests/backup-secret-exclusion.test.ts tests/backup-path-traversal.test.ts tests/restore-generation-fencing.test.ts tests/doctor-readonly.test.ts tests/doctor-strict-exit.test.ts tests/doctor-secret-redaction.test.ts tests/doctor-repair-idempotency.test.ts tests/doctor-repair-rollback.test.ts
npm run doctor -- --strict
git diff --check
```

live network 验收使用明确的只读测试帐号/本地服务，失败不得通过改 fixture 规避。

### 切换条件

只有全部满足时才将 v3 设为默认：

- [ ] 所有 U0-U12 退出门禁通过；
- [ ] V2 → V3 迁移和 rollback 在副本上演练成功；
- [ ] 至少四类黄金方案和未预置机箱 canary 通过；
- [ ] 现有 N6 能力由通用 adapter 复现；
- [ ] 本地部署重启后 plans/facts/evidence/prices/decisions 不丢失；
- [ ] 本地部署重启后 attachments/observations/jobs/price history/targets/execution sessions 也不丢失，且无重复提醒/副作用；
- [ ] `.buildsim` 往返、完整 backup → 空环境 restore → Doctor strict 演练成功，恢复后权威 hashes 一致；
- [ ] complete portable 在缺少原始 runtime artifacts 的空安装离线精确重放；non-empty import 冲突策略、完整备份加密和 restore generation fencing 均通过；
- [ ] 浏览器、离线、WebGL fallback、腐败数据和并发冲突测试通过；
- [ ] README、README.zh-CN、ROADMAP、ARCHITECTURE、PROVENANCE 和系统说明已更新；
- [ ] 最终执行报告列出已实现、未实现、限制、测试、迁移、回滚和数据安全。

### 旧路径删除策略

- 第一轮只把 v3 设为默认，保留 v2 reader 和 legacy N6 fallback；
- 至少经过一个完整本地发布周期且无迁移回滚后，才单独计划删除旧 writer/runtime；
- 不删除旧不可变 plan versions、evidence documents、price archives 或 migration manifests；
- 删除 legacy 前新增架构测试，确保没有页面继续读取旁路事实。

### 回滚

关闭 v3 默认 flag，恢复 v2/legacy 只读路径；恢复对应 snapshot pointer。不得删除 v3 数据，也不得逆向覆盖旧版本。

### 推荐提交

- `feat(portability): add portable plans verified restore and doctor`
- `test(platform): complete universal hardware migration and release gates`

---

## 19. 推荐提交序列

1. `docs(plan): freeze universal hardware contracts and fixtures`
2. `refactor(data): isolate product facts plan data and runtime stores`
3. `feat(runtime): add durable jobs backup spi and doctor foundation`
4. `refactor(topology): add v3 component instance graph`
5. `feat(requirements): add progressive requirements and scenario branches`
6. `feat(facts): add claim graph snapshots and reversible updates`
7. `feat(observations): add plan scoped user evidence`
8. `feat(evidence): close official third-party inference resolution loop`
9. `refactor(adapters): add generic capabilities package supply and hardware registry`
10. `feat(compat): add progressive compatibility and bootability rules`
11. `feat(solver): add bounded whole build feasibility and what-if`
12. `feat(system): add Windows and TrueNAS profiles with help guide`
13. `feat(execution): add firmware first boot and storage layout plans`
14. `feat(spatial): add generic tolerance-aware routing and assembly plans`
15. `feat(simulation): add workload-driven thermal and normalized acoustic models`
16. `feat(price): add China observations history targets and timing`
17. `feat(recommendation): rank feasible whole build scenarios`
18. `feat(ui): integrate progressive evidence-first build workflow`
19. `feat(portability): add portable plans verified restore and doctor`
20. `test(platform): complete universal hardware migration and release gates`

每个提交必须能独立回滚；不要把数据迁移、架构重构和大规模 UI 改动塞进同一个提交。

---

## 20. 明确不在本计划范围内

- 显示器、键鼠、路由器、交换机、UPS、USB 外设的拓扑与采购；
- 公网 SaaS、多用户账号、租户、共享权限和计费；
- 自动下单或代表用户付款；
- 实物收货、长期 installed 状态、退货、损坏、资产序列号和健康度管理；版本绑定的装机/首启 checklist 与临时磁盘 locator 仍在范围内，但不转成资产台账；
- SSD/HDD SMART、持续墙上功耗遥测和安装后自动校准；用户主动提供的一次性量尺、温度/RPM/噪音观察可用于当前方案且不外推；
- 完整 CFD；
- 房间声学、摆放距离、机箱共振和实际听感预测；
- 厂商 CAD 精度保证；
- 在开源仓库内重新分发无授权的完整厂商手册、图片或 CAD；运行时按需获取并本地哈希归档。

---

## 21. Definition of Done

本计划只有在以下用户路径无需 N6 专用代码、无需隐藏默认值且可由自动化复现时才算完成：

> 用户新建空白 PC/NAS/工作站方案，可先描述需求也可逐步描述任意内部消费级硬件；Agent 自动确认身份、获取官网和手册事实，必要时降级到第三方、plan-scoped 用户观察与明确推断。平台能求解整套可启动方案、比较 what-if，并持续更新局部兼容、随盒/缺失附件、BIOS 路径、NAS 布局、个性化装机/首启、3D 走线、热噪、当前/历史价格、目标价和推荐。每个结论都说明来源、假设和影响，安全证据不足时阻断而不假绿。官网更新由用户决定是否采用且可撤销；后台任务可恢复，方案可携带、整站可恢复、Doctor 可在发布前证明本地数据完整。中国全新报价按时效和置信度展示，推荐符合长期骨架合理溢价、易替换件控制投入的性价比原则。

完成状态不得以“支持了更多 SKU”或“新增了第二个机箱”代替；真正门槛是：新增此前未预置的合格硬件和机箱时，核心评估器、UI 和 Agent 协议不需要出现该产品名称。

12 项首发补充能力必须全部在第 5.6 节追踪矩阵中有实现提交、测试报告和 U12 门禁证据；任何一项仅有 UI mock、自由文本 Agent 回答或单一 N6 演示，都视为未完成。

---

## 22. 阶段执行记录模板

每完成一个阶段，在对应章节末尾追加：

```md
### Ux 执行记录（YYYY-MM-DD）

- 状态：未开始 / 进行中 / 门禁失败 / 门禁通过
- 提交：<commit sha 或未提交说明>
- 主要变更：
  - ...
- 数据迁移：
  - dry-run：...
  - manifest：...
  - rollback：...
- 聚焦测试：...
- 全量测试：...
- 浏览器测试：...
- live smoke：未运行 / 结果 / 环境
- 未解决限制：
  - ...
- 下一阶段前置条件：...
```
