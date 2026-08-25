# Build Sim 方案全生命周期平台重设计 Goal Prompt

下面内容可以直接复制给负责执行的 Codex/Agent。详细逐阶段计划：
[Build Sim 方案全生命周期平台重设计 Follow Plan](../plans/2026-08-25-build-sim-plan-lifecycle-platform-redesign-follow-plan.md)

---

## 可复制 Prompt

```text
你正在 `/home/linuxuser/Code/build-sim` 仓库中工作。请严格按照：

docs/superpowers/plans/2026-08-25-build-sim-plan-lifecycle-platform-redesign-follow-plan.md

依次执行 R0-R10，把当前 N6 Build Lab 从单页临时配置工具重构为以“方案全生命周期”为核心的平台，并完成工作台、方案编辑、确定性评估、真实 3D、Agent、采购交易和装机任务的端到端打通。

最终 Goal：

1. 建立真正的 BuildPlan、PlanDraft、PlanVersion 和 PlanRepository。用户可以新建空白方案、从模板创建、复制、导入、重命名、切换、归档、恢复和删除方案。
2. 当前配置不再固定为 `live-from-lab`，DOM 不再是唯一状态源。客户端必须有统一 PlanStore；所有模块读取同一个 active plan、draft revision、config hash 和 evaluation hash。
3. 实现自动保存、显式保存版本、dirty/saving/saved/failed/conflict/offline 状态、撤销/恢复、未保存保护和 stale revision 并发门禁。已保存版本不可变，恢复历史版本必须形成新 draft/新版本。
4. 工作台必须成为操作中心：展示方案列表、当前方案风险、预算、采购/装机进度、下一步任务和继续编辑/3D/交易/Agent 快捷入口。用户最多两次操作即可开始新建方案或继续当前方案。
5. 方案编辑器必须按基础平台、存储、电源、散热、GPU/扩展和采购分组；修改后展示风险变化、预算变化和受影响模块；finding 可以回跳到具体配置字段。
6. `BuildEvaluation` 继续是兼容性、物理、功耗、热、接线、BOM 和 verdict 的唯一确定性事实源。工作台、3D、Agent 和任务系统不得各自重算或覆盖 verdict，unknown 必须保持 unknown。
7. 将主空间预览升级为基于 WebGL/Three.js 的真实交互式 3D 场景：透视/正交相机、旋转/平移/缩放、透明外壳、图层、爆炸视图、raycast 部件选择、inspector、冲突/间隙/尺寸/走线/热/装机顺序图层。场景必须复用现有 geometry、routing、assembly、catalog 和 evaluation，不得猜造厂商 CAD 精度。WebGL 不可用时保留 SVG 回退。
8. 3D 选择必须进入全局上下文。用户从 finding 可打开对应 3D 部件，也可从 3D 跳回配置修复或携带 partId/findingId 询问 Agent。
9. Agent session/run 必须绑定 planId、version/revision、config hash 和 evaluation hash，并自动获得当前 3D selection、采购和装机摘要。上下文过期必须明确显示 stale。
10. Agent 默认只读，只能生成结构化 PlanChangeProposal。提案必须使用 allowlist patch，展示字段 diff、理由、确定性 before/after evaluation、风险变化、预算变化和 unknown。未经人工确认不得修改 draft；应用时校验 expected revision/hash，过期提案必须阻止。应用后必须由 BuildEvaluation 重新计算，不能相信模型声称的 verdict。
11. 重做交易闭环：从工作台/采购页进入，显示 selected、reading、recognizing、enriching、reviewing、staged、archiving、archived/failed 状态；支持取消、重试、超时、部分成功和未保存保护。不要为不可测的 OCR/网络阶段伪造百分比。
12. 交易必须能关联具体 planId、捕获时 versionId 和 planItemId；旧交易迁移为 unlinked inbox，不得猜归属。交易列表支持搜索、筛选、排序、校对、重新关联、删除原图和删除整笔。归档成功后更新采购状态和已投入预算，unknown 价格不得补零。
13. 将 BOM、交易、assembly、wiring 和 findings 统一为 BuildTask。方案版本变化时执行稳定 sourceRef 的 reconcile，正确保留、更新、新增或 obsolete 任务；不得按名称模糊匹配不同 SKU。
14. 刷新页面、重启本地服务和切换方案后数据必须恢复。首批正式存储使用 provider-neutral PlanRepository + 服务端 `runtime/plans/` 文件存储、schema 校验、原子写入、revision/hash 门禁和结构化 API；浏览器 localStorage 只保留 active id/短期恢复，不作为正式多方案数据库。
15. 逐步拆分 `index.html`、`src/lab/boot.ts` 和 `src/lab/v1-runtime.js`，但本 Goal 不迁移到 React/Vue 等新框架，也不重写确定性引擎、catalog 或价格系统。legacy 模块只能在替代功能通过门禁后清理。

不可破坏的边界：

- 现有 geometry/catalog/provenance/evaluation 是事实基础；UI、3D 和 Agent 不得填造证据不足的数据。
- Agent 写行为必须复用 approval、idempotency、definition hash 和 audit 边界，不得伪装成 read-only Tool。
- approval token、API key、Cookie、交易原图或隐私信息不得进入模型消息、浏览器持久化、提交或日志。
- 已保存 PlanVersion 不可变；交易历史证据不得因当前方案变化被静默改写。
- 服务离线、OCR/Agent/WebGL 失败必须降级并可恢复，不能白屏或显示虚假“已保存”。
- 不实现自动下单、验证码绕过、多用户云协作或没有证据的厂商级 CAD。

开始前必须：

1. 完整阅读 Follow Plan、`docs/ROADMAP.md`、`docs/agent-system-design.md`、`src/lab/boot.ts`、`src/lab/build-progress.ts`、`src/lab/transaction-import.ts`、`src/lab/agent-panel.ts`、`src/core/evaluate.ts`、geometry/routing/assembly 数据和当前 server/store 实现。
2. 记录 branch、HEAD、`git status --short` 和重叠文件 diff。
3. 当前工作区已有未提交修改，至少涉及 `index.html` 和 Agent contracts/provider/runtime/server/tests。必须区分并保留用户改动，不得 reset、checkout、覆盖或混入无关修改。
4. `index.html` 中存在尚未完成的工作台/交易结构草稿；不能因为 markup 已存在就把 R2/R3/R8 标记为完成，必须按退出门禁重构和验证。
5. 未获用户当前明确授权时不得 push、部署、删除用户数据或执行破坏性 git 操作。

执行方式：

- 严格按 R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10 执行。
- 每阶段先添加契约/离线测试，再实现代码。
- 每阶段运行 Follow Plan 中的聚焦测试和退出门禁。
- 每阶段完成后更新 Follow Plan 的执行记录：状态、修改、测试、浏览器证据、迁移、未验证项、回滚和 push 状态。
- 每阶段一个独立、可回滚提交；如果共享工作区无法安全提交，至少保持阶段 diff 可区分并报告原因。
- 任一阶段门禁失败时停止进入下一阶段，说明是实现失败、已有无关问题、外部依赖阻塞还是未运行；不得删除测试、降低断言、静默吞错或用 fixture 冒充真实浏览器/服务证据。
- 只有 R2/R4 契约冻结后，R5 和 R8 才可由不同执行者并行；`index.html`、`boot.ts`、PlanStore 和全局 CSS 必须有单一 owner，避免并行覆盖。

每阶段通用验证：

npm test
npm run typecheck
npm run build
node tests/legacy-run-model-tests.js
node tests/legacy-run-static-tests.js
npm run agent:secret-scan
git diff --check

涉及真实 UI/3D/跨模块的阶段还必须运行现有 browser smoke 和新增 plan/workspace/3D E2E。没有启动所需本地服务时，应明确标记未运行或按项目说明启动，不得把端口监听当作功能成功。

最终必须真实走通以下验收场景：

1. 空工作台创建 N6 模板方案。
2. 修改 PSU/存储，看到保存状态、确定性风险变化和受影响模块。
3. 保存 v1、复制第二方案并证明数据不串联。
4. 在 3D 中选中冲突部件，查看 evidence，并跳回配置修复。
5. 携带当前 3D/finding 上下文询问 Agent，获得结构化提案。
6. 未批准时方案不变；批准后应用到 draft、重新评估并保存 v2。
7. 上传交易、看到完整阶段、校对并关联 v2 部件、成功归档。
8. 工作台预算、采购状态和装机任务同步更新。
9. 刷新和重启服务后所有方案、版本、交易关联与任务恢复。
10. 手机 viewport 可完成创建、修改、保存和交易校对；WebGL 不可用时 SVG 回退可用。

完成 R10 前必须输出中文执行报告，结构为：

1. 已实现（按 R0-R10）
2. 未实现
3. 当前限制与已知风险
4. 数据迁移结果
5. 验证证据：聚焦、全量、typecheck/build、legacy、browser/E2E、3D fallback、Agent proposal、交易、secret scan、diff check
6. 事实与安全：evaluation 单一事实源、unknown、Agent approval/stale proposal、交易隐私、原子存储/并发门禁
7. 性能与无障碍
8. Git：branch、起始 HEAD、阶段 commits、push 状态、远端 SHA（若已授权 push）

不要把计划、类型定义、已有 markup、fixture、截图或单独模块测试当成平台已打通。只有真实代码落地、跨模块路径走通并满足阶段退出门禁，才能标记完成。
```

## 建议 Goal 标题

```text
完成 Build Sim 方案全生命周期平台重设计 R0-R10
```

## 建议 Goal Objective

```text
按照 docs/superpowers/plans/2026-08-25-build-sim-plan-lifecycle-platform-redesign-follow-plan.md 完成 R0-R10：建立可创建、保存、复制、切换、版本化和恢复的 BuildPlan/PlanStore/PlanRepository，以 active plan 和确定性 BuildEvaluation 为统一状态与事实源，重构工作台和方案编辑器，升级 evidence-aware Three.js 3D 场景，打通带 3D/评估/采购上下文且仅能通过人工批准提案修改方案的 Agent，重做可关联具体方案部件的交易归档和装机任务 reconcile，并通过迁移、离线、全量、浏览器 E2E、性能、无障碍、安全和回滚门禁；保留当前工作区已有修改，未获授权不得推送或部署。
```
