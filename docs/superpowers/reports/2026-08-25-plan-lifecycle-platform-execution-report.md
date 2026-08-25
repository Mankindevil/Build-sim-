# Build Sim 方案生命周期平台执行报告

日期：2026-08-25

范围：`R0 → R10`

状态：本地实现与验收完成；未推送、未部署

## 交付结果

- `BuildPlan`、`PlanStore` 与文件型 `PlanRepository` 支持创建、草稿自动保存、复制、切换、不可变版本、历史比较与恢复；active plan 是配置权威源。
- `EvaluationCoordinator` 将 config/evaluation hash 绑定到 plan/version/revision。自动保存成功时同步同配置 snapshot 的服务器 revision，避免 Agent 收到 stale context。
- 工作台、方案编辑器、评估、采购、装机和 Agent 共用同一 active plan/evaluation；旧 DOM runtime 仅保留页面生命周期兼容职责。
- Three.js 场景按需加载并消费确定性 geometry/evaluation，提供 finding、走线、尺寸、热场、装机步骤、反向编辑、截图与 SVG fallback。
- Agent 上下文包含方案、3D、评估、采购和任务摘要。模型只能生成结构化提案；应用前必须人工勾选批准，服务端重新校验 revision/hash/SKU/patch allowlist 并重新评估。
- 交易归档可校对并精确关联 plan/version/item；装机任务按稳定 `kind + sourceRef` reconcile，保留 obsolete 历史和人工状态优先级。
- `index.html` 已缩为 0.48 kB 构建壳层；完整模板迁至 `src/lab/app-document.html`，由 `shell-loader.ts` 惰性装载 `boot.ts`。
- 修正根目录 `runtime/` 数据 ignore 的作用域，并纳入此前被误忽略但被生产服务/测试依赖的 `scripts/runtime/flags.mjs`；暂存快照可独立检出、测试和构建。

## 数据、迁移与恢复

- 方案和版本写入 `PLAN_REPOSITORY_ROOT`；写入具备 checksum、原子替换、revision/hash 冲突和幂等保护，删除进入 `.trash`。
- 旧 `build-sim.progress.v1` 通过幂等兼容 reader 读取并留下 backup marker；不会猜测交易的方案归属。
- 交易 v1 只投影到 `unlinked` inbox；新数据写 schema v2。采购进度和任务分别按 plan id 隔离。
- localStorage 损坏的方案缓存 fail-closed，损坏任务记录会从确定性事实重建；禁用 storage 时在线 workspace 仍可工作。
- 离线、stale revision、OCR 失败/取消/重试、Agent 失败、WebGL fallback/context lost 均有测试覆盖；页面卸载会关闭 SSE、取消 OCR、释放 object URL、事件订阅和 3D 资源。

## 验收证据

- Vitest：保留用户改动的工作树为 82 files / 438 tests passed；仅含待提交 R10 与既有 HEAD 的独立暂存快照为 82 files / 434 tests passed（差额 4 项属于未暂存的用户 Agent 测试）。
- TypeScript：`tsc --noEmit` passed。
- 生产构建：client、Agent SSR、workspace SSR passed；`dist/index.html` 0.48 kB / gzip 0.36 kB。
- 遗留门禁：model 85 assertions、static 23 assertions，全部通过。
- 浏览器门禁：G1、G7、workspace、spatial、Agent proposal、transaction、build task、platform acceptance 全部通过。
- 完整链路：create → edit → save v1 → duplicate/switch → 3D → Agent proposal/manual approval → save v2 → transaction review/link/archive → purchase task → refresh restore；手机端完成创建、编辑、保存和交易校对/归档。
- 性能实测：首次加载 1314 ms，重评估 4193 ms，方案切换 406 ms，3D 初始化 148 ms；50 次确定性评估和 5000 条历史任务 reconcile 均通过独立性能预算测试。
- 无障碍：关键明/暗色对比达到 AA 测试阈值；浏览器审计 unnamed buttons 0、broken dialogs 0、aria-live regions 20；focus-visible 与 reduced-motion 门禁通过。
- 视觉证据：desktop 1440×1000 SHA-256 `6865c7c64eb3b110ec2ce42df23e6570fd0a93746bbdf3abbac70ebe0ad2ffb6`；tablet 1024×768 `3211094a389470fe18283cf89137e651822b1cbf3308868ac040a82d5ce65844`；mobile 390×844 `0d669c13bb82be97041d1371a3e7a7ae0579ccee5f535e7a4f8dadab5890ab98`。
- 安全：336 files scanned / 0 secret findings；`git diff --check` passed。

## 限制

- `v1-runtime.js` 仍承载尚未迁移的详情展示逻辑，但不拥有 durable plan/evaluation/transaction/task/Agent/3D 状态。
- Three.js 动态 chunk 为 552.39 kB / gzip 140.07 kB，构建仍提示单 chunk 超过 500 kB；它保持 lazy load、实例化重复网格和 DPR 上限 2。
- 视觉截图作为临时验收产物在哈希计算后删除，仓库不保存二进制快照。
- 本次只完成本地实现、测试与提交；没有执行远端 push、发布或部署。

## 工作区所有权与清理

- 开始前已存在的 DeepSeek V4/Agent 改动继续保持未暂存，不纳入平台提交。
- 开始前 `index.html` 中的用户 UI 改动迁移到 `src/lab/app-document.html` 并继续保持为未暂存差异；R10 只提交基线模板迁移和最小壳层。
- 本次 E2E 使用的 `/tmp/build-sim-r10-final-plans` 与临时截图均已删除；未删除任何用户方案、交易、运行数据或现有功能资产。

## 回滚

按阶段反向回滚本地 R10→R0 提交。R10 可先恢复旧 `index.html` boot 入口并移除 shell loader；R9/R8 的 plan-scoped localStorage 和交易 schema 兼容 reader可保留。方案仓库、版本、交易归档和 `.trash` 不应随代码回滚删除。
