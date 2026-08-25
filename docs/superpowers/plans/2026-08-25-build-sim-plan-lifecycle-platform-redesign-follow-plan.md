# Build Sim 方案全生命周期平台重设计 Follow Plan

日期：2026-08-25  
状态：待执行  
适用仓库：`/home/linuxuser/Code/build-sim`  
阶段编号：`R0-R10`（避免与既有 `G/A/C` 阶段混淆）  
对应 Goal Prompt：[方案全生命周期平台重设计 Goal Prompt](../goals/2026-08-25-build-sim-plan-lifecycle-platform-redesign-goal-prompt.md)

这是一份可以被新的执行者逐项 follow、逐阶段验收、逐阶段回滚的实施计划。它不是单纯的 UI 改版：核心任务是建立真正的“方案”领域对象，让工作台、方案编辑、确定性评估、3D、Agent、采购交易和装机执行围绕同一个 active plan 与同一个版本工作。

---

## 0. 最终目标

将当前以单页 DOM 临时状态为中心的 N6 Build Lab，重构为以方案生命周期为中心的平台：

```text
创建 / 复制 / 导入方案
          ↓
编辑方案草稿 ── 自动保存、撤销/恢复、未保存保护
          ↓
保存不可变版本 PlanVersion
          ↓
确定性 BuildEvaluation（唯一 verdict 事实源）
          ├── 工作台风险与下一步
          ├── 3D 场景与冲突/走线图层
          ├── 采购清单与交易关联
          ├── 装机任务与检查清单
          └── Agent 只读上下文
                         ↓
               Agent 生成修改提案
                         ↓
              人工审阅 diff 并批准
                         ↓
             应用为新草稿 / 新版本
                         ↓
                  重新确定性评估
```

最终用户必须能够明确完成以下任务：

1. 在工作台新建空白方案、从模板创建、复制现有方案或导入 JSON。
2. 在多个方案之间切换，知道哪个是当前方案、是否存在未保存修改、当前版本是什么。
3. 修改方案并看到保存状态、影响范围、风险变化、预算变化和可回退版本。
4. 从评估问题直接跳转到对应配置项；修改后由 `BuildEvaluation` 重新计算。
5. 在真实交互式 3D 场景中选择部件、查看尺寸、冲突、间隙、走线和证据等级。
6. 让 Agent 自动获得当前方案、版本、评估、3D 选中部件、交易和装机上下文。
7. 让 Agent 生成结构化、可预览、可拒绝的变更提案；未经确认不得修改方案。
8. 上传交易截图时看到完整阶段进度，并把交易关联到具体方案和具体部件。
9. 让采购状态、交易记录和装机任务随方案版本联动，同时保留历史证据。
10. 刷新页面、重启本地服务或切换方案后，方案与关联数据仍可恢复。

---

## 1. 当前基线与已确认缺口

### 1.1 当前配置不是持久化方案

- `src/lab/boot.ts` 的 `configFromDom()` 每次从表单即时构造 `BuildConfig`。
- `id` 固定为 `live-from-lab`，`name` 固定为 `N6 Build Lab live`。
- 当前只支持 JSON 导入、JSON 导出和清单导出，没有方案列表、创建、保存、复制、删除或版本。
- 表单改变后重新 render，但不存在统一 draft、dirty state、自动保存或跨刷新恢复。

### 1.2 装机进度与方案配置分离

- `src/lab/build-progress.ts` 使用独立的 `build-sim.progress.v1` localStorage。
- 进度记录没有 `planId` 或 `planVersionId`，因此无法安全支持多个方案。
- 交易截图服务器档案同样没有方案/部件关联，历史记录只能作为全局列表展示。

### 1.3 Agent 只拿到临时快照

- `initAgentPanel({ getBuildConfig: configFromDom })` 只在发消息时附带当前 DOM 配置。
- Agent 会话没有稳定的 `planId`、`versionId`、`evaluationHash` 或 3D selection。
- Agent 回答不能生成平台可理解的结构化方案 diff，也没有安全的“预览 → 批准 → 应用 → 重评估”闭环。

### 1.4 当前 3D 是 SVG 参数投影

- 当前 `spatial-scene` 在 SVG 中绘制毫米级参数化投影，具有拖拽/缩放交互，但不是完整 WebGL 场景。
- 多个顶视、侧视、背板视图彼此分离；部件选择、图层、遮挡、透明外壳和空间检查体验较弱。
- 现有几何、路由、证据等级和确定性冲突规则有价值，必须复用，不能为了视觉效果绕开事实边界。

### 1.5 页面结构过度集中

- `index.html` 体积大，配置、工作台、3D、交易、Agent 和 CSS 混在同一页面。
- `src/lab/v1-runtime.js` 与 `src/lab/boot.ts` 同时驱动 UI，状态边界不清晰。
- 重设计应逐步模块化，不在同一阶段同时迁移框架和业务模型。

### 1.6 开始执行前的共享工作区状态

2026-08-25 计划编写时：

- branch：`main`
- HEAD：`541614be8bfdc757aeb4b6cd770d581d04fb86e0`
- 工作区已有未提交修改，至少包括 `index.html`、Agent contracts/provider/runtime/server 及其测试。
- `index.html` 中存在一次尚未完成的工作台/交易结构草稿；它不是已验收设计，执行时应基于本计划重新评估，不得把存在的 markup 当成已完成能力。
- 其他 Agent 文件的修改可能属于用户正在进行的工作，必须保留、区分并避免覆盖。

R0 开始时必须重新记录 branch、HEAD、`git status --short` 和重叠文件 diff。禁止 reset、checkout 或覆盖不属于本计划的修改。

---

## 2. 不可破坏的产品与技术边界

### 2.1 单一事实源

- `BuildConfig` / `PlanVersion` 是用户选择的事实源。
- `BuildEvaluation` 是兼容性、物理、功耗、热、接线、BOM 和 verdict 的唯一确定性事实源。
- 3D、工作台、采购建议和 Agent 只能读取或解释评估结果，不能自行产生与引擎冲突的 verdict。
- evidence 为 `unknown` 时必须保持 unknown；视觉层和 Agent 不得猜测毫米、接口、温度或价格。

### 2.2 修改权限

- 用户直接编辑方案可以产生 draft。
- Agent 默认只读；只能生成 `PlanChangeProposal`。
- Agent 提案必须展示字段级 diff、原因、评估影响和预算影响。
- 未经用户确认，提案不得写入 active draft，更不得静默覆盖已保存版本。
- 所有应用动作必须包含 base version/hash，过期提案必须阻止或重新基线化。

### 2.3 历史与隐私

- 已保存 `PlanVersion` 不可变；修改产生新版本。
- 交易证据与历史版本保留关联，不因当前选择变化而被静默改写。
- 交易原图可能包含敏感信息；支持只删除原图、保留摘要。
- 删除方案、版本、交易档案必须明确范围并优先可恢复/软删除。

### 2.4 3D 事实边界

- 现有 `geometry.json`、`routing.json`、`assembly.json`、catalog 尺寸和 provenance 是场景数据源。
- WebGL 只改变表达方式，不改变几何判定。
- 官方尺寸、行业标准、推算尺寸必须在 3D inspector 中明确标识。
- 没有厂商 CAD/GLB 时使用参数化包络，不伪装为精确外观模型。

### 2.5 渐进迁移

- 不要求一次性重写整个引擎、catalog、价格服务或 Agent runtime。
- 不在本计划内迁移到 React/Vue 等新框架；先在现有 TypeScript/Vite 基础上建立清晰模块和 store。
- legacy 页面在对应替代模块通过门禁前继续可用。

---

## 3. 目标信息架构与核心用户路径

### 3.1 一级导航

```text
工作台
方案编辑
评估中心
空间预览
采购与交易
装机执行
Agent
```

所有一级页面顶部共享：

- 当前方案切换器。
- 方案名称、当前版本、保存状态。
- 阻断/警告摘要。
- 全局“新建方案”和“保存版本”。
- 最近操作与错误反馈。

### 3.2 新建方案路径

```text
工作台「新建方案」
  ├─ 推荐模板
  ├─ 空白方案
  ├─ 复制现有方案
  └─ 导入 JSON
        ↓
名称、用途、目标负载、预算（预算允许 unknown）
        ↓
基础平台与存储目标
        ↓
生成 draft + 初次评估
        ↓
进入方案编辑器
```

### 3.3 修改方案路径

```text
打开方案 → 修改字段 → draft 立即更新
        ↓
显示 dirty / autosaving / saved / failed
        ↓
重新评估并展示影响摘要
        ↓
撤销 / 恢复 / 保存为新版本
```

### 3.4 Agent 修改路径

```text
当前方案上下文 + 用户问题
        ↓
Agent 结构化 PlanChangeProposal
        ↓
diff、原因、风险变化、预算变化
        ↓
人工批准 / 部分批准 / 拒绝
        ↓
基于 expectedVersion 应用到 draft
        ↓
确定性重评估
        ↓
保存新版本
```

### 3.5 交易路径

```text
选择当前方案 → 上传截图
        ↓
读取文件 → OCR → 官网/目录核验 → 人工校对
        ↓
选择关联部件或创建待关联项
        ↓
加入待保存队列
        ↓
逐笔归档 + 明确成功/失败
        ↓
更新采购状态、已投入预算和装机任务
```

---

## 4. 目标领域模型

R0 必须先冻结契约，后续 UI 不得继续直接把 DOM 当状态源。

### 4.1 Plan 与版本

```ts
interface BuildPlan {
  schemaVersion: "1.0.0";
  id: string;
  name: string;
  description?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  activeVersionId: string | null;
  draftRevision: number;
  draft: PlanDraft;
  metadata: {
    useCase?: string;
    budgetCny?: number | null;
    tags?: string[];
  };
}

interface PlanDraft {
  baseVersionId: string | null;
  config: BuildConfig;
  dirty: boolean;
  updatedAt: string;
}

interface PlanVersion {
  schemaVersion: "1.0.0";
  id: string;
  planId: string;
  versionNumber: number;
  createdAt: string;
  reason: "initial" | "manual-save" | "agent-proposal" | "import" | "restore";
  config: BuildConfig;
  configHash: string;
  parentVersionId: string | null;
}
```

要求：

- `BuildConfig.id` 不再固定为 `live-from-lab`，应稳定绑定 plan/version。
- 版本使用 canonical serialization 计算 hash。
- 保存版本时使用 expected draft revision 防止并发覆盖。

### 4.2 评估快照

```ts
interface PlanEvaluationSnapshot {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  evaluatedAt: string;
  evaluation: BuildEvaluation;
}
```

草稿评估可以存在于内存/缓存中；已保存版本的评估快照必须能明确验证 config hash。

### 4.3 Agent 上下文与提案

```ts
interface PlanAgentContext {
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  buildConfig: BuildConfig;
  evaluation: BuildEvaluation;
  spatialSelection?: { partId: string; view: string } | null;
  purchaseSummary: unknown;
  buildTaskSummary: unknown;
}

interface PlanChangeProposal {
  id: string;
  planId: string;
  expectedDraftRevision: number;
  expectedConfigHash: string;
  createdAt: string;
  summary: string;
  rationale: string[];
  operations: PlanPatchOperation[];
  predictedImpact: {
    resolvedFindingIds: string[];
    introducedFindingIds: string[];
    budgetDeltaCny: number | null;
  };
  status: "proposed" | "applied" | "rejected" | "stale";
}
```

允许修改的路径必须使用 allowlist，不接受任意 JSON path。

### 4.4 交易关联

```ts
interface PlanTransactionLink {
  planId: string | null;
  planVersionIdAtCapture: string | null;
  planItemId: string | null;
  linkStatus: "linked" | "unlinked" | "stale";
}
```

旧交易迁移为 `unlinked`，不得伪造关联。

### 4.5 装机任务

```ts
interface BuildTask {
  id: string;
  planId: string;
  sourceVersionId: string;
  kind: "purchase" | "assembly" | "wiring" | "verification";
  sourceRef: string;
  title: string;
  status: "todo" | "doing" | "done" | "blocked" | "obsolete";
  staleReason?: string;
}
```

方案版本变化时，任务必须重新 reconcile；不能把已完成任务静默映射到不同部件。

---

## 5. 目标存储和服务边界

### 5.1 PlanRepository

先定义 provider-neutral 接口：

```ts
interface PlanRepository {
  list(): Promise<BuildPlanSummary[]>;
  get(planId: string): Promise<BuildPlan>;
  create(input: CreatePlanInput): Promise<BuildPlan>;
  updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan>;
  saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion>;
  duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan>;
  archive(planId: string): Promise<void>;
  restore(planId: string): Promise<void>;
  delete(planId: string): Promise<void>;
  listVersions(planId: string): Promise<PlanVersion[]>;
}
```

### 5.2 首批实现建议

- 服务端文件存储：`runtime/plans/`，使用原子写入、内容校验和显式 schema version。
- 新增独立 workspace domain 模块，路由建议为 `/api/workspace/plans`。
- 可暂由现有 TypeScript 本地服务承载，但 domain/store 不得与 Agent runtime 强耦合。
- Vite 增加 `/api/workspace` 代理。
- 浏览器只保留 active plan id、短期 draft cache 和离线恢复信息，不把 localStorage 当正式多方案数据库。
- 服务不可用时允许只读默认方案和内存草稿，但必须显示“未持久化”，不得显示“已保存”。

### 5.3 并发和原子性

- draft update 使用 `expectedRevision`。
- 保存版本使用 `expectedConfigHash`。
- 文件写入先临时文件、fsync/rename 或项目现有等价原子模式。
- 重复 idempotency key 返回相同结果。
- 冲突返回结构化 `409 stale_revision`，前端提供重新加载/另存为，不静默覆盖。

---

## 6. 每阶段固定执行协议

每个 `R` 阶段必须：

1. 阅读本阶段目标、依赖和退出门禁。
2. 检查 `git status --short` 和本阶段重叠文件 diff，保护用户已有修改。
3. 先冻结契约和添加离线测试，再实现代码。
4. 运行阶段聚焦测试。
5. 运行完整 Vitest、typecheck、production build、legacy runners、secret scan 和 `git diff --check`。
6. 更新本计划执行记录：状态、文件、测试、未验证项、迁移和回滚位置。
7. 每阶段一个独立、可回滚提交；未获明确授权不得 push。
8. 任一退出门禁失败时停止后续阶段，不得删除测试、放宽断言或把失败伪装为完成。

通用验证：

```bash
npm test
npm run typecheck
npm run build
node tests/legacy-run-model-tests.js
node tests/legacy-run-static-tests.js
npm run agent:secret-scan
git diff --check
```

涉及真实浏览器交互的阶段额外运行：

```bash
npm run test:g1:browser
npm run test:g7:browser
```

若新增专用 E2E script，应加入 `package.json` 并在最终门禁运行。

---

## 7. R0：契约冻结、工作区审计与产品基线

### 目标

在继续改 UI 前冻结方案生命周期的领域契约、状态机和基线证据。

### 任务

- [ ] 记录 branch、HEAD、dirty files 和重叠 diff；标记用户改动与计划改动。
- [ ] 为 `BuildPlan`、`PlanDraft`、`PlanVersion`、`PlanEvaluationSnapshot`、`PlanAgentContext`、`PlanChangeProposal`、`PlanTransactionLink`、`BuildTask` 定义契约。
- [ ] 定义方案状态机：create、edit、autosave、save-version、archive、restore、duplicate、import、delete。
- [ ] 定义 UI 保存状态机：`clean | dirty | saving | saved | conflict | failed | offline`。
- [ ] 定义 Agent proposal 状态机和允许 patch path。
- [ ] 定义交易导入状态机：`selected | reading | recognizing | enriching | reviewing | staged | archiving | archived | failed`。
- [ ] 记录现有页面关键路径截图或 DOM fixture：配置、概览、3D、交易、Agent。
- [ ] 添加契约测试，证明版本不可变、stale revision 被拒绝、Agent 不能修改非 allowlist 字段。
- [ ] 将当前未完成的 `index.html` 草稿标记为待重构，不把 markup 存在视为完成。

### 聚焦验证

```bash
npx vitest run tests/plan-contracts.test.ts tests/plan-state-machine.test.ts
```

### 退出门禁

- 所有核心对象有 schema version 和运行时校验。
- draft、version、evaluation、transaction 和 task 的关联键明确。
- 没有 UI 继续直接以 DOM 为唯一状态源的新代码。
- 已有工作区修改未被覆盖。

### 推荐提交

```text
test(plans): freeze lifecycle and proposal contracts
```

---

## 8. R1：方案存储、版本和迁移底座

### 依赖

R0 完成。

### 目标

实现可测试、可持久化、可并发保护的多方案仓库。

### 任务

- [ ] 实现 `PlanRepository` 和文件存储 adapter。
- [ ] 实现 list/get/create/updateDraft/saveVersion/duplicate/archive/restore/delete/listVersions。
- [ ] 使用安全文件名映射，不直接把用户输入拼入路径。
- [ ] 使用原子写入和 revision/hash 并发门禁。
- [ ] 新增 `/api/workspace/plans` REST routes 和结构化错误。
- [ ] Vite 增加 `/api/workspace` 本地代理。
- [ ] 实现默认方案种子：从当前 N6 默认 DOM 配置生成一次 initial plan/version。
- [ ] 实现旧 `build-sim.progress.v1` 迁移读取器；迁移后保留备份标记，幂等执行。
- [ ] 旧交易记录不猜 planId，进入 unlinked inbox。
- [ ] 服务不可用和损坏文件必须返回可理解错误，不让整个模拟器白屏。

### 聚焦验证

```bash
npx vitest run tests/plan-store.test.ts tests/plan-api.test.ts tests/plan-migration.test.ts
```

### 退出门禁

- 创建两个方案、切换、重启 store 后仍存在。
- 保存新版本不修改旧版本内容/hash。
- stale revision 返回 409，数据未覆盖。
- duplicate 产生新 plan id、独立版本链。
- 迁移可重复运行且不会重复创建数据。

### 推荐提交

```text
feat(plans): add versioned workspace repository
```

---

## 9. R2：客户端 PlanStore、路由与应用壳

### 依赖

R1 完成。

### 目标

让所有页面读取同一个 active plan，而不是分别读取 DOM/localStorage。

### 任务

- [ ] 实现客户端 `PlanStore`：plans、activePlan、draft、evaluation、save status、selection。
- [ ] 明确 action：create、activate、patchDraft、undo、redo、saveVersion、duplicate、archive。
- [ ] 实现 active plan id 恢复和无方案空状态。
- [ ] 将 `configFromDom()` 改为过渡 adapter，最终读取 `PlanStore.activeDraft.config`。
- [ ] 表单事件改为 dispatch patch，再由 store 驱动 render。
- [ ] 实现自动保存 debounce、显式保存版本和关闭/刷新 dirty 保护。
- [ ] 拆出 app shell、plan switcher、global status、toast/inline error 模块。
- [ ] 建立轻量路由/section controller；保持浏览器前进后退与深链接。
- [ ] 首批保留 legacy panel renderer，通过 adapter 订阅 store，避免一次性重写全部图表。

### 聚焦验证

```bash
npx vitest run tests/plan-store-ui.test.ts tests/plan-routing.test.ts tests/plan-autosave.test.ts
```

### 退出门禁

- 页面刷新后恢复 active plan 和 draft。
- 切换方案时所有配置表单同步变化。
- dirty/saving/saved/failed/conflict 状态准确。
- undo/redo 不跨方案污染。
- legacy evaluation 面板仍读取当前 active plan。

### 推荐提交

```text
feat(workspace): connect app shell to active plan store
```

---

## 10. R3：工作台、方案管理与方案编辑器

### 依赖

R2 完成。

### 目标

交付用户可理解的“增加方案”和“修改方案”完整体验。

### 工作台任务

- [ ] 新建方案主入口：模板、空白、复制、导入。
- [ ] 方案列表展示名称、版本、更新时间、风险、采购/装机进度和保存状态。
- [ ] 当前方案卡展示阻断、警告、预算、已购、已安装和下一步任务。
- [ ] 快捷入口：继续编辑、打开 3D、处理风险、上传交易、询问 Agent。
- [ ] 空状态、加载、服务离线、损坏方案和迁移状态完整。
- [ ] 支持重命名、复制、归档、恢复和删除；危险操作明确范围。

### 编辑器任务

- [ ] 按基础平台、存储、电源、散热、GPU/扩展、采购状态分组。
- [ ] 提供页面内目录、搜索配置项和问题回跳锚点。
- [ ] 展示字段来源与 unknown，而非只展示选项。
- [ ] 修改后展示风险变化、预算变化和受影响模块。
- [ ] 实现“保存版本”对话框：版本原因、摘要、父版本。
- [ ] 实现版本历史、对比和从历史版本恢复为新 draft。
- [ ] JSON 导入改为创建/更新方案的显式流程，不直接静默覆盖当前 DOM。

### 聚焦验证

```bash
npx vitest run tests/workspace-dashboard.test.ts tests/plan-editor.test.ts tests/plan-version-history.test.ts tests/config-import-ui.test.ts
```

### 浏览器验收路径

1. 空工作区新建模板方案。
2. 修改 PSU，看到 dirty → saving → saved。
3. 保存版本并对比前后差异。
4. 复制方案并修改，原方案不受影响。
5. 从风险卡跳到具体配置字段。

### 退出门禁

- 用户无需 JSON 文件即可完成新增、修改、保存、复制和切换方案。
- 工作台每个主要状态都有明确下一步动作。
- 多方案数据不串联。
- 键盘和移动端可完成核心路径。

### 推荐提交

```text
feat(workspace): deliver plan dashboard and editor
```

---

## 11. R4：评估版本化与跨模块影响闭环

### 依赖

R2 完成；建议在 R3 后执行。

### 目标

让每个评估结果明确属于哪个 draft revision 或已保存版本，并可从 finding 回到修改入口。

### 任务

- [ ] 建立 `EvaluationCoordinator`，输入 active draft config，输出带 hash 的 snapshot。
- [ ] 对同 config hash 去重，避免重复评估和 UI 抖动。
- [ ] 结果过期时显示 stale，不让旧 verdict 冒充当前方案。
- [ ] finding 增加 UI target mapping：配置 section、field、3D part、wiring/task ref。
- [ ] 工作台风险、FIT chip、热、接线、BOM 统一订阅同一 snapshot。
- [ ] 版本保存时固定 snapshot 元数据；必要时可重新计算但必须核对 hash。
- [ ] 添加 before/after evaluation diff，供编辑器和 Agent 提案使用。
- [ ] 保持 `BuildEvaluation` 唯一事实源，不把 UI 计算移回 DOM runtime。

### 聚焦验证

```bash
npx vitest run tests/plan-evaluation.test.ts tests/evaluation-diff.test.ts tests/finding-navigation.test.ts
```

### 退出门禁

- 所有主要面板展示相同 evaluation hash。
- 快速连续修改不会显示旧评估为最新。
- finding 可定位到配置字段和空间部件。
- 保存版本后可证明 version config hash 与 evaluation config hash 一致。

### 推荐提交

```text
feat(evaluation): bind deterministic results to plan revisions
```

---

## 12. R5：真实 3D 场景基础

### 依赖

R4 完成。

### 目标

用 WebGL/Three.js 场景替代主 SVG 透视表达，同时保留现有参数化几何和证据边界。

### 任务

- [ ] 新增 Three.js 及必要类型依赖；记录 bundle 影响。
- [ ] 定义 renderer-neutral `SpatialSceneModel`，从 geometry/catalog/evaluation 生成。
- [ ] 将 N6 外壳、内部空间、主板、CPU、RAM、M.2、PSU、GPU、HBA、硬盘、风扇转换为统一场景节点。
- [ ] 统一坐标系、毫米单位、旋转和 anchor；不复制 geometry 常量。
- [ ] 实现透视/正交相机、orbit、pan、zoom、reset 和视角预设。
- [ ] 实现透明外壳、分层、显示/隐藏、爆炸视图。
- [ ] 实现 raycast 选择、hover、高亮和部件 inspector。
- [ ] inspector 展示名称、SKU、尺寸、位置、evidence、provenance 和关联 findings。
- [ ] 使用实例化网格优化硬盘/风扇等重复部件。
- [ ] 检测 WebGL 不可用时回退到现有 SVG/2D 视图。
- [ ] 遵守 reduced-motion，处理 resize、DPR、context lost 和资源 dispose。

### 聚焦验证

```bash
npx vitest run tests/spatial-scene-model.test.ts tests/spatial-selection.test.ts tests/spatial-fallback.test.ts
```

### 浏览器验收

- 场景成功加载且无 WebGL console error。
- 旋转、缩放、预设相机、选择部件和 inspector 可用。
- 当前配置改变后，对应部件正确增删/替换。
- WebGL 禁用时显示可操作的 SVG 回退。

### 退出门禁

- 3D 场景节点和确定性 geometry 使用同一毫米数据。
- 选择部件能同步到全局 PlanStore selection。
- 不因“精美模型”引入无证据尺寸。
- 桌面端保持可接受帧率；移动端不阻塞主线程和页面滚动。

### 推荐提交

```text
feat(spatial): add evidence-aware interactive 3d scene
```

---

## 13. R6：3D 冲突、尺寸、走线和工作流联动

### 依赖

R5 完成。

### 目标

把 3D 从“可旋转模型”升级为解决问题的工作界面。

### 任务

- [ ] 冲突图层：根据 evaluation physical findings 高亮部件和碰撞体。
- [ ] 间隙图层：显示 clearance envelope，并标明 official/standard/inferred。
- [ ] 尺寸工具：预设关键尺寸，不提供伪精确任意 CAD 测量。
- [ ] 走线图层：复用 routing paths，区分 power/data、warn/unknown/bad。
- [ ] 风道/热图层：复用 thermal field；明确“规划热场，非 CFD”。
- [ ] 装机顺序图层：按 assembly steps 隔离/高亮当前部件。
- [ ] 3D finding 点击后打开问题说明和配置修复入口。
- [ ] 配置字段 hover/selection 可反向高亮 3D 部件。
- [ ] “询问 Agent”携带当前 partId、findingId 和 camera/view context。
- [ ] 截图/分享仅导出当前视图和事实说明，不嵌入敏感交易信息。

### 聚焦验证

```bash
npx vitest run tests/spatial-findings.test.ts tests/spatial-routing.test.ts tests/spatial-plan-sync.test.ts
```

### 退出门禁

- 至少一个真实阻断 fixture 可从工作台 → finding → 3D 高亮 → 配置修复 → 冲突消失完整演示。
- 3D 不生成独立 verdict。
- 走线和热图层与对应 evaluation snapshot hash 一致。

### 推荐提交

```text
feat(spatial): connect findings routing and plan editing
```

---

## 14. R7：Agent 方案上下文与可审阅修改提案

### 依赖

R4、R6 完成。

### 目标

让 Agent 真正理解当前工作上下文，并通过受控提案参与方案修改。

### 任务

- [ ] Agent session 绑定 `planId`；每次 run 记录 version/revision/config/evaluation hash。
- [ ] 发送完整 `PlanAgentContext`，包含当前 3D selection、finding、采购和任务摘要。
- [ ] UI 明确显示 Agent 当前绑定的方案和上下文是否 stale。
- [ ] 新增 `propose_plan_change` 结构化结果契约；只允许 allowlist patch。
- [ ] 服务端验证 SKU、字段类型、expected revision/hash 和工具 definition hash。
- [ ] 提案先在隔离配置副本上运行 `BuildEvaluation`，生成确定性 before/after diff。
- [ ] UI 提案卡展示字段 diff、解决/新增 findings、预算变化和 unknown。
- [ ] 支持全部应用、逐项应用、拒绝；部分应用后重新验证 patch。
- [ ] 应用动作进入 active draft，默认不直接保存版本。
- [ ] 复用现有 approval/audit/idempotency 边界；写 effect 不得伪装只读。
- [ ] 旧 Agent 普通对话继续可用，但回答不得被解析为隐式配置修改。

### 聚焦验证

```bash
npx vitest run tests/agent-plan-context.test.ts tests/agent-plan-proposal.test.ts tests/agent-approval.test.ts tests/agent-runtime.test.ts
```

### 关键负向测试

- stale proposal 被拒绝。
- 非 allowlist path 被拒绝。
- 不存在的 SKU 被拒绝。
- 模型声称“已修复”但未应用时，方案和 evaluation 不改变。
- approval token 不进入模型上下文、会话文本或浏览器持久化。

### 退出门禁

- Agent 回答可证明绑定当前方案和 evaluation hash。
- 3D 选中 PSU 后询问，Agent 上下文包含该 PSU，而非依赖用户重复描述。
- 提案未经确认不能修改 draft。
- 应用后确定性重评估，UI 不直接信任 Agent 的预测 verdict。

### 推荐提交

```text
feat(agent): add plan-aware reviewed change proposals
```

---

## 15. R8：采购与交易完整闭环

### 依赖

R2、R4 完成；与 R7 只依赖稳定契约，不应直接耦合 Agent UI。

### 目标

让交易记录可用、可追踪、可关联方案，并补齐上传阶段反馈。

### 任务

- [ ] 交易入口在工作台和采购页可见，并默认绑定 active plan。
- [ ] 上传展示 selected/reading/recognizing/enriching/reviewing/staged/archiving/archived。
- [ ] 对真实可计算环节显示 determinate progress；对 OCR/联网阶段使用阶段进度和耗时，不伪造百分比。
- [ ] 支持取消、重试、重新选择、超时、服务不可用和部分成功。
- [ ] 校对页显示截图、商品、分类、数量、单价、匹配 SKU、置信度和 evidence。
- [ ] 用户选择关联已有 plan item，或创建 unlinked purchase item。
- [ ] staged 与 archived 明确区分；关闭时保护未保存结果。
- [ ] 批量归档逐笔反馈；一笔失败不丢失其他 staged item。
- [ ] 交易列表支持搜索、分类/状态/方案筛选、排序和空状态。
- [ ] 支持编辑摘要、重新关联、删除原图、删除整笔、查看官方来源。
- [ ] archived transaction schema 升级并兼容旧记录；旧记录进入未关联 inbox。
- [ ] 关联交易后更新采购状态和已投入预算；价格 unknown 不强行补零。

### 聚焦验证

```bash
npx vitest run tests/transaction-import-ui.test.ts tests/transaction-archive.test.ts tests/transaction-plan-link.test.ts tests/transaction-history-ui.test.ts
```

### 浏览器验收

1. 从工作台进入上传。
2. 看到完整阶段与错误重试。
3. 校对后关联当前方案 PSU。
4. staged 时明确显示未保存。
5. 保存后交易出现在该方案记录并更新预算。
6. 删除原图后摘要仍在。

### 退出门禁

- 用户始终知道当前阶段、是否已保存和下一步动作。
- 多方案交易不串联。
- 失败重试不要求重新填写已校对字段。
- 隐私删除语义明确且经过测试。

### 推荐提交

```text
feat(transactions): link staged receipts to build plans
```

---

## 16. R9：装机执行、采购和版本变化联动

### 依赖

R4、R8 完成。

### 目标

把采购状态、安装顺序、接线和检查清单统一为随方案版本维护的任务系统。

### 任务

- [ ] 从 BOM、assembly、wiring、findings 生成稳定 sourceRef 的任务。
- [ ] 方案版本改变时执行 task reconcile：保留、更新、obsolete 或新增。
- [ ] 已完成任务不因名称相似被错误迁移到不同 SKU。
- [ ] 采购交易自动更新对应 purchase task，但允许人工纠正。
- [ ] 工作台显示下一步 3-5 个任务和阻断原因。
- [ ] 装机页按阶段、依赖和状态展示；支持 checklist、备注和证据链接。
- [ ] 任务可打开对应 3D 部件/走线图层。
- [ ] Agent 可读取任务摘要并提出建议，但不能未经确认标记完成。
- [ ] 导出清单使用当前已保存版本和任务状态，标明生成时间/hash。

### 聚焦验证

```bash
npx vitest run tests/build-task-reconcile.test.ts tests/build-progress.test.ts tests/build-progress-ui.test.ts tests/checklist-export.test.ts
```

### 退出门禁

- 更换 PSU 后旧 PSU 相关任务正确 obsolete，新任务生成。
- 已归档交易正确完成相应采购任务。
- 3D、装机页和工作台展示同一任务状态。
- 导出清单可追溯到方案版本。

### 推荐提交

```text
feat(build): reconcile purchase assembly and wiring tasks
```

---

## 17. R10：整合、迁移、性能、无障碍与最终验收

### 依赖

R0-R9 完成。

### 目标

完成平台级收口，移除重复状态源，证明主要用户路径真实可用。

### 任务

- [ ] 删除或隔离已被替代的 DOM/localStorage 状态逻辑；保留必要兼容 reader。
- [ ] `index.html` 缩减为 app shell，功能 markup/CSS/logic 拆分到模块。
- [ ] 清理 `v1-runtime.js` 中已迁移的职责；未迁移部分通过清晰 adapter 保留。
- [ ] 更新 README、README.zh-CN、ROADMAP 和架构文档。
- [ ] 添加完整 E2E：create → edit → save version → 3D → Agent proposal → apply → transaction → build task。
- [ ] 添加桌面、平板、手机 viewport 视觉回归/截图验收。
- [ ] 检查键盘导航、focus、dialog、aria-live、颜色对比和 reduced motion。
- [ ] 测量首次加载、3D 初始化、方案切换、重评估和大列表性能。
- [ ] 检查 WebGL 资源 dispose、事件监听泄漏、object URL 和 SSE cleanup。
- [ ] 模拟服务离线、存储损坏、stale revision、OCR 失败、Agent 失败、WebGL context lost。
- [ ] 生成执行报告：已实现、未实现、限制、测试证据、迁移结果和 Git 状态。

### 最终验证

```bash
npm test
npm run typecheck
npm run build
node tests/legacy-run-model-tests.js
node tests/legacy-run-static-tests.js
npm run test:g1:browser
npm run test:g7:browser
npm run agent:secret-scan
git diff --check
```

并运行新增加的 workspace/3D/plan E2E 命令。

### 最终产品验收场景

1. 新用户从空工作台创建 N6 方案。
2. 修改存储和 PSU，看到实时评估与影响。
3. 保存 v1，复制为第二个方案，两个方案互不污染。
4. 在 3D 中选择冲突部件并跳回配置修复。
5. 在 3D 上下文中询问 Agent，收到结构化提案。
6. 审阅并应用提案，重新评估后保存 v2。
7. 上传交易、校对、关联 v2 部件并成功归档。
8. 工作台预算、采购进度和装机任务同步变化。
9. 刷新页面和重启服务后状态完整恢复。
10. 手机 viewport 可以完成创建、修改、保存和交易校对。

### 退出门禁

- 不再存在“当前 DOM 配置”和“当前方案”两套互相矛盾的状态。
- Agent、3D、交易和任务都能证明其 plan/version/revision 关联。
- 所有失败状态可恢复，不造成无提示数据丢失。
- 文档、测试和实际产品行为一致。

### 推荐提交

```text
refactor(lab): complete plan lifecycle platform migration
```

---

## 18. 阶段依赖与建议执行顺序

```text
R0 契约
 ↓
R1 存储/API
 ↓
R2 PlanStore/应用壳
 ├─────────────┐
 ↓             ↓
R3 工作台编辑器  R4 评估版本化
                 ├──────────┐
                 ↓          ↓
                R5 3D基础   R8 交易
                 ↓          ↓
                R6 3D联动   R9 装机任务
                 ↓
                R7 Agent提案
                 └────┬─────┘
                      ↓
                     R10 收口
```

推荐严格顺序仍为 `R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10`。如果由多人并行，只有在 R2/R4 契约冻结后，R5 与 R8 才可分支并行；共享文件 `index.html`、`boot.ts`、全局 CSS 和 PlanStore 仍需单一 owner。

---

## 19. 明确不在本计划范围内

- 支持 N6 之外所有机箱的完整通用建模；本计划只为未来 adapter 保留接口。
- 自动下单、支付、登录商城或绕过验证码。
- 把 Agent 预测当作兼容性事实。
- 在没有证据的情况下生成厂商级精确 3D CAD。
- 在同一项目中同时迁移到新的前端框架。
- 多用户账号、云同步、团队权限和实时协作。
- 原生移动 App。

---

## 20. 风险登记

| 风险 | 应对 |
|---|---|
| `index.html` 与 `v1-runtime.js` 继续膨胀 | R2 起新增模块只进入独立 TS/CSS；R10 清理 legacy 职责 |
| 多状态源导致数据错乱 | PlanStore 成为客户端唯一 active plan 状态；DOM 仅视图 |
| 3D 重写影响确定性判断 | scene model 只消费 geometry/evaluation；引擎测试保持不变 |
| Three.js bundle/性能 | lazy load 3D、实例化重复网格、DPR 上限、SVG fallback |
| Agent 提案覆盖用户修改 | expected revision/hash、allowlist patch、stale proposal 阻断 |
| 旧交易无法正确归属 | 迁移为 unlinked inbox，必须人工关联 |
| 自动保存误导 | 保存状态来自服务端响应；离线只标 draft cache，不显示已保存 |
| 版本与任务联动错误 | stable sourceRef + reconcile 测试；不按名称模糊匹配 |
| 共享脏工作区冲突 | 每阶段开始检查 status/diff，分离提交，不覆盖用户改动 |

---

## 21. 执行记录模板

每完成一个阶段，在本节追加：

```md
### Rn 执行记录

- 状态：完成 / 部分 / 阻塞
- 起始 HEAD：
- 完成提交：
- 修改文件：
- 聚焦测试：
- 全量门禁：
- 浏览器证据：
- 数据迁移：
- 未验证项：
- 回滚方式：
- Push：未授权 / 已推送（远端 SHA）
```

不得仅因为代码或 markup 已存在就标记完成；必须满足该阶段退出门禁并记录验证证据。

### R0 执行记录

- 状态：完成
- 起始 HEAD：`541614be8bfdc757aeb4b6cd770d581d04fb86e0`
- 完成提交：`test(plans): freeze lifecycle and proposal contracts`（仅纳入 R0 文件，不混入起始脏文件；SHA 见 Git log）
- 修改文件：`src/plans/contracts.ts`、`canonical.ts`、`conflict.ts`、`validation.ts`、`state-machine.ts`、`version.ts`；R0 契约/状态机测试；DOM baseline fixture；workspace baseline 文档
- 聚焦测试：`npx vitest run tests/plan-contracts.test.ts tests/plan-state-machine.test.ts`，2 files / 9 tests passed
- 全量门禁：Vitest 51 files / 366 tests passed；typecheck passed；production + agent build passed；legacy model 85 assertions passed；legacy static 23 assertions passed；secret scan 264 files / 0 findings；`git diff --check` passed
- 浏览器证据：R0 选择 DOM fixture 冻结配置、概览、SVG 空间、交易和 Agent 入口；本阶段不宣称新交互完成
- 数据迁移：未执行；R1 实现迁移 reader
- 未验证项：无 R0 阻断项
- 回滚方式：移除独立 `src/plans/`、R0 tests/fixture 与 baseline 文档；无需改动既有数据
- Push：未授权

### R1 执行记录

- 状态：完成
- 起始 HEAD：`22b8f6b`
- 完成提交：`feat(plans): add versioned workspace repository`（SHA 见 Git log）
- 修改文件：文件 PlanRepository、默认 N6 seed、旧进度迁移 reader、workspace REST routes/server、Vite proxy/build 配置及 R1 tests
- 聚焦测试：`npx vitest run tests/plan-store.test.ts tests/plan-api.test.ts tests/plan-migration.test.ts`，3 files / 11 tests passed
- 全量门禁：Vitest 54 files / 377 tests passed；typecheck passed；client + Agent + workspace production build passed；legacy model 85 assertions passed；legacy static 23 assertions passed；secret scan 278 files / 0 findings；`git diff --check` passed
- 浏览器证据：R1 为服务/存储阶段，无新增 UI 验收声明
- 数据迁移：实现 `build-sim.progress.v1` 幂等 reader、原始 JSON backup marker；旧交易仅生成 `unlinked` link，不猜测 plan/version/item
- 未验证项：真实浏览器 localStorage 的迁移触发由 R2 接入；不阻塞 R1 存储底座
- 回滚方式：停止 workspace server，移除 `/api/workspace` proxy 与独立 `runtime/plans/`；软删除数据位于 repository `.trash/`
- Push：未授权

### R2 执行记录

- 状态：完成
- 起始 HEAD：`b238b7e`
- 完成提交：`feat(workspace): connect app shell to active plan store`（SHA 见 Git log）
- 修改文件：workspace API client、客户端 PlanStore、路由、动态应用壳/CSS、`boot.ts` DOM 过渡 adapter、workspace browser smoke 与 R2 tests
- 聚焦测试：`npx vitest run tests/plan-store-ui.test.ts tests/plan-routing.test.ts tests/plan-autosave.test.ts`，3 files / 7 tests passed
- 全量门禁：Vitest 57 files / 384 tests passed；typecheck passed；client + Agent + workspace production build passed；legacy model 85 assertions passed；legacy static 23 assertions passed；secret scan 282 files / 0 findings；`git diff --check` passed
- 浏览器证据：G1 passed；G7 passed；workspace E2E passed（自动保存、dirty 刷新确认、刷新恢复、创建第二方案、保存版本、切换隔离、active plan 再恢复）
- 数据迁移：PlanStore 初始化时幂等触发 R1 legacy progress reader；正式方案仍来自服务端，localStorage 仅保存 active id 与短期 cache
- 未验证项：R3 才交付完整新建/导入向导、版本历史 UI 和危险操作对话框
- 回滚方式：移除动态 Plan shell/PlanStore boot 接入后，`configFromDomLegacy()` 仍可恢复原页面；服务端方案数据不需删除
- Push：未授权
