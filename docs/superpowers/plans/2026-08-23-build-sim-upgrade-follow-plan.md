# Build Sim 升级优化 Follow Plan

日期：2026-08-23
对应设计 spec：[型号联网搜索、事实层与 AI 建议升级优化计划](../specs/2026-08-23-model-search-official-data-design.md)
状态：待执行
适用分支：`codex/build-sim-upgrade`（从 `main` 创建）

这是一份可以逐项执行、逐阶段验收的实施计划。它把设计 spec 中的 12 个代码问题、官网型号搜索、官方参数直通、价格联动和 DeepSeek 建议层拆成可独立 review 的工作包。

## 0. 最终目标

用户输入品牌、型号或 MPN 后，系统能够：

1. 规范化输入并返回候选型号。
2. 官网来源优先，保留字段级 provenance、抓取时间、定位和内容 hash。
3. 官方 exact MPN 且字段校验、冲突和安全检查全部通过时，允许审计式直通正式 SKU。
4. 非精确、非官方或有冲突结果只能进入草稿确认，不能直接污染 catalog、BuildConfig、BOM 或价格。
5. 所有装机结论都来自唯一的 `BuildEvaluation`，不再存在 V1/V2 两套评价模型。
6. DeepSeek 只消费结构化事实，输出建议、风险、替代方案和行动顺序；它不能降低 `bad`、补造 unknown 或修改确定性 verdict。
7. DeepSeek key、URL、模型和限额只通过服务端 `.env.local` 管理，浏览器永远拿不到 key。

## 1. 当前基线和已知边界

当前仓库已经存在：

- `data/skus/catalog.json` 及 N6 case profile、geometry、routing、assembly。
- `src/core/evaluate.ts` 确定性装机评估引擎。
- `src/lab/boot.ts`、`src/lab/view-models.ts` 和旧的 `src/lab/v1-runtime.js`。
- `scripts/price-server/` 本地价格服务、官方页面基础适配器、浏览器 fallback、候选和 snapshot 机制。
- `.env.example` 与 `scripts/deepseek/config.mjs`；真实 key 应由用户复制到本地 `.env.local`。

当前尚未完成：

- `/api/catalog/*` 型号搜索和官网提取 job。
- `FieldProvenance`、`SkuDraft`、官方直通写入和回滚审计。
- V1/V2 事实层收敛以及 capability、power、price、thermal 数据化。
- `/api/advice/build` DeepSeek 客户端、schema/ref 校验和建议 UI。

不要把本计划中的接口、页面或 AI 能力描述为已经上线。

## 2. 不可破坏的执行约束

- 所有页面 KPI、FIT、温度、接线、BOM、价格摘要和 AI 输入必须来自同一份 `BuildEvaluation` 快照。
- `ok / warn / bad` 由本地 engine 决定；DeepSeek 只能解释、排序和提出条件方案。
- 缺失或冲突字段必须显示 `unknown` / `conflict`，禁止从同系列、标题、经验值或模型推理补齐。
- 官方字段、手工修改、价格 snapshot、AI claim 和 catalog 写入都必须有 provenance、hash 或 finding 引用。
- 所有文件写入采用临时文件 + 原子 rename；catalog、snapshot、draft 和建议缓存均支持幂等、备份和回滚。
- 默认关闭 catalog 写入和 DeepSeek 请求 feature flag；阶段门禁通过后逐步开启。
- API key 不得使用 `VITE_` 前缀，不得进入浏览器、bundle、日志、fixture、Git 或 API 响应。
- 外部抓取和 DeepSeek 失败只影响对应能力，不能阻塞基础装机评估、导出和价格审计。

## 3. 执行方式

### 3.1 每个工作包的固定流程

每个工作包必须按以下顺序完成：

1. 阅读本计划对应阶段和设计 spec 对应章节。
2. 先补或更新测试/fixture，再实现代码；若测试无法先写，必须在 PR 说明原因。
3. 执行该阶段列出的最小验证命令和全量回归命令。
4. 检查 `git diff --check`、敏感信息、未预期文件和数据变更。
5. 更新本文件的完成状态、变更摘要、测试证据和回滚位置。
6. 每个阶段使用一个独立提交；提交信息使用 `feat(plan):`、`fix(engine):`、`feat(catalog):`、`feat(advice):` 等清晰前缀。
7. 阶段门禁通过后再开启下一阶段 feature flag；失败时保留失败日志和可复现 fixture，不绕过门禁。

### 3.2 推荐分支和提交边界

```bash
git switch -c codex/build-sim-upgrade
```

推荐提交顺序：

1. `docs(plan): add executable build-sim upgrade follow plan`
2. `chore(baseline): add migration guardrails and reproducible scenarios`
3. `refactor(engine): converge BuildEvaluation as the single fact source`
4. `refactor(model): move capabilities power price and thermal facts to data`
5. `feat(catalog): add official model search and extraction jobs`
6. `feat(catalog): add official acceptance and draft confirmation`
7. `feat(price): link confirmed SKUs to auditable snapshots`
8. `feat(advice): add DeepSeek structured advice with safe fallback`
9. `test(e2e): add browser and cross-layer acceptance matrix`

如果某阶段需要多个提交，最后必须 squash 成一个可独立回滚的阶段提交。

每个阶段提交完成后必须立即推送：首次使用 `git push -u origin <branch>`，后续使用 `git push`。push 成功并通过 `git ls-remote origin <branch>` 核对远程 commit 后，才能开始下一阶段或报告该阶段完成；没有 push 权限时必须明确报告阻塞。

## 4. G0：基线冻结与迁移护栏（P0 前置）

### 目标

固定当前行为、建立 feature flag 和回滚护栏，避免重构期间无法区分回归与新功能。

### 任务清单

- [x] 记录 `npm test`、`npm run typecheck`、`npm run build` 当前结果。
- [x] 修复 `tests/legacy-run-*.js` 的 ESM/CJS 入口，或在本计划中记录明确的暂时豁免。
- [x] 建立固定场景 fixture：baseline、dual PSU、240 radiator、9 HDD + HBA、缺字段、重复 MPN、价格 snapshot、DeepSeek disabled。
- [x] 增加 `BUILD_SIM_CATALOG_WRITE_ENABLED=false`、`BUILD_SIM_ADVICE_ENABLED=false` 等服务端开关。
- [x] 所有 catalog、draft、snapshot、audit 写入统一使用临时文件和原子 rename。
- [x] 为 catalog 写入建立旧值备份目录和 rollback manifest 约定。
- [x] 检查 `.env.local` 是否被忽略，运行构建后确认 bundle 没有 key 名称和值。

### 主要文件

- `package.json`
- `tests/legacy-run-*.js`
- `scripts/price-server/env.mjs`
- `scripts/price-server/store.mjs`
- 新增 `scripts/runtime/flags.mjs`、`tests/fixtures/upgrade-scenarios/`

### 验证

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

### 退出门禁

- 基线命令可重复运行。
- feature flag 默认关闭时，现有 Build Lab、价格审计和配置导入行为不变。
- 测试 fixture 可在无网络、无 key 环境运行。
- 所有写入都有备份和 rollback manifest。

### 回滚

关闭新 feature flag；如果涉及数据迁移，使用 rollback manifest 恢复对应 catalog/snapshot 文件，不删除原始文件。

### G0 执行记录（2026-08-23）

- 状态：已实现，门禁待提交/推送后确认。
- 证据：`docs/superpowers/reports/2026-08-23-g0-baseline.md`。
- 修改：`scripts/runtime/flags.mjs`、`scripts/price-server/env.mjs`、`scripts/price-server/store.mjs`、legacy runners、离线 fixtures 和 `tests/upgrade-guardrails.test.ts`。
- 验证：`npm test` 16 files / 188 tests、`npm run typecheck`、`npm run build`、两个 legacy runner、`git diff --check` 和 dist 敏感名称扫描均通过。

## 5. G1：统一 `BuildEvaluation` 与页面事实源（P0）

### 目标

关闭问题 1、3、6、11、12 的核心部分，先确保系统结论正确，再允许接入动态数据和 AI。

### 任务清单

- [x] 梳理 `src/lab/v1-runtime.js` 中独立的功耗、价格、噪音、FIT 和自然语言评价计算。
- [x] 将页面 KPI、FIT、温度、BOM、接线、热场和价格摘要改为读取 `BuildEvaluation`。
- [x] 旧 runtime 只保留渲染、事件绑定和 UI 状态，不再计算第二套结论。
- [x] 为 primary/secondary PSU 建立显式 `PsuLoad`，分别计算效率、DC load、waste heat 和 chamber。
- [x] 将风扇 `count/size/mount/radiatorFanProfile` 从配置贯穿到 geometry、thermal 和 UI。
- [x] 统一概览 SVG、等轴图、热场和冲突图使用的 `PlacedPart[]` 和 projection。
- [x] 对 dual PSU、240 radiator、1/2/4/9 fan、0/1/2 GPU/HBA 等场景增加回归测试。
- [x] 修复 legacy 测试入口，加入最小 Playwright smoke。

### 主要文件

- `src/core/evaluate.ts`
- `src/core/thermal.ts`
- `src/core/thermal-field.ts`
- `src/lab/boot.ts`
- `src/lab/view-models.ts`
- `src/lab/v1-runtime.js`
- `src/adapters/jonsbo-n6/geometry.ts`

### 退出门禁

- UI 与 `evaluateBuild()` 的关键结果逐项一致。
- 存在 `bad` 时任何建议区域都不能显示“可直接安装”。
- dual PSU、240 radiator、真实 fan count 均有自动化证据。
- AI 开关关闭时基础评估、导出和价格功能仍可用。

### 回滚

保留旧 renderer 的只读 fallback，通过 feature flag 切换；不得恢复旧的功耗/FIT/风险结论。

### G1 执行记录（2026-08-23）

- 状态：已实现，门禁通过，已提交并推送。
- 修改：`src/core/evaluate.ts` 增加 `BuildEvaluation.power/price/noise` 与显式 primary/secondary `PsuLoad`；`src/lab/boot.ts` 将一次评估快照传给 runtime；`src/lab/v1-runtime.js` 的 KPI、FIT、温度、接线、BOM/价格摘要和建议均读取该快照并移除旧结论函数；N6 profile 增加可追溯功耗 profile。
- 测试：`npm test` 16 files / 191 tests、`npm run typecheck`、`npm run build`、`npm run test:g1:browser`、`node tests/legacy-run-static-tests.js`、`node tests/legacy-run-model-tests.js` 均通过。
- 浏览器 smoke 覆盖基础面板、dual PSU、240 radiator、价格表旧硬编码检查；Playwright Chromium 使用项目依赖安装后运行。
- 回滚：回退本阶段独立提交 `refactor(engine): converge BuildEvaluation as the single fact source`；不恢复 V1 的功耗/FIT/价格旁路。

## 6. G2：Capability、功耗、价格、配置和 unknown 数据化（P1）

### 目标

关闭问题 2、4、5、7、8、9、10，让所有关键数字从可追溯数据和 profile 计算，而不是从 runtime 中散落的常数得到。

### 任务清单

- [x] 定义 `CaseCapabilities`、`BoardCapabilities`、`PowerProfile`、`WorkloadProfile`、`ThermalProfile`。
- [x] 将盘位、背板口、风扇 mount、PCIe/SATA/SlimSAS/M.2 数量统一到 capability 来源。
- [x] 将 CPU PL1/PL2、GPU/HBA/硬盘/风扇/PSU 输入功耗和效率规则移出 V1 runtime。
- [x] 清理 7W、0.9、0.88、24dBA、99mm、31mm 等静默 fallback；改为 unknown 或显式 planning range + finding。
- [x] 删除 `fixedCost`、固定已购价和 `4500 * diskCount`；区分 MSRP、当前报价、已购价、历史 snapshot、from price 和汇率参考价。
- [x] 几何和展示名称从所选 SKU 读取，删除 W680M、i5-14500、980 PRO 等基线字符串。
- [x] 将 HBA 端口改为 `controller/connector/portIndex` 结构化映射，删除 `P4-P7` 文案正则推导。
- [x] 在 `parseConfig` 后增加 schema migration、类型/范围、SKU 类别、拓扑、BOM 和 capability 校验。
- [x] 为每个关键数字补 `official/standard/planning/manual/unknown` 证据状态。

### 退出门禁

- 修改一个 SKU 或 case profile 后，几何、接线、功耗、价格和展示同步变化。
- 所有无来源数字显示 unknown 或明确 planning range。
- 旧配置可迁移；非法配置不会部分写入；迁移失败可恢复旧文件。
- G1 回归场景在新 profile 下仍通过。

### G2 执行记录（2026-08-23）

- 状态：已实现，门禁待提交/推送后确认。
- 修改：新增 `src/core/capabilities.ts` 和 `src/config/validate.ts`；N6 profile 增加 thermal profile；功耗/温度/价格保留 null unknown 和 price provenance；几何/UI 名称读取选定 SKU；HBA data path 使用结构化 assignment；旧 schema 迁移、配置校验和 rollback manifest 恢复路径落地。
- 测试：`npx vitest run tests/capability-config.test.ts tests/upgrade-guardrails.test.ts`（9 tests）、`npm test`（17 files / 198 tests）、`npm run typecheck`、`npm run build`、`npm run test:g1:browser`、两个 legacy runners、`git diff --check` 均通过。浏览器 smoke 需本地 Vite 服务运行，Chromium 使用批准的 GUI 权限启动；价格 API 未启动的 proxy error 不影响页面 smoke 断言。
- 未解决 unknown：catalog 未提供的实际线束独立根数、冷却器 θ/噪音、未审计价格和缺失关键尺寸仍保持 unknown；planning profile 尚未替换为实测快照。
- 回滚：回退本阶段独立提交；配置迁移可用 `scripts/price-server/store.mjs` 的 rollback manifest 恢复旧 JSON，不恢复 V1 的旁路结论。

## 7. G3：型号搜索与官网通用采集（原 S0/S1）

### 目标

用户输入型号后，服务端返回候选、官方来源和字段级 provenance；此阶段不直接修改正式 catalog。

### 任务清单

- [x] 新增 `src/catalog-search/normalize.ts`，保留 raw、brand、model、MPN、category、capacity、interface 和 locale。
- [x] 新增 candidate、provenance、draft、field schema 类型。
- [x] 在现有 `scripts/price-server/` 中加入 `/api/catalog/search`、`/api/catalog/search/:jobId`、`/api/catalog/inspect`。
- [x] 增加官方域名 allowlist、canonical/redirect/私网校验、响应大小、超时、域名限流和幂等 job key。
- [x] 按 JSON-LD → meta → 规格表 → 内嵌 JSON → 官方 PDF → Playwright fallback 提取。
- [x] 保存 retrievedAt、httpStatus、extractor、locator、snippet、content hash 和字段冲突。
- [x] 搜索候选和价格候选分开存储，第三方标题不得变成官方参数。
- [x] 增加离线 HTML/PDF fixture，不以实时网络作为单元测试前置条件。

### 主要文件

- 新增 `src/catalog-search/normalize.ts`
- 新增 `src/catalog-search/types.ts`
- 新增 `scripts/price-server/catalog/`
- `scripts/price-server/server.mjs`
- `scripts/price-server/env.mjs`
- `data/catalog-candidates/`

### 退出门禁

- 输入规范化、MPN 匹配、单位和数值校验通过。
- SSRF、redirect、私网 IP、响应大小和协议测试通过。
- 官网失败只返回 partial/unknown，不伪造字段。
- 重复点击不会创建重复 job。

### G3 执行记录（2026-08-23）

- 状态：已实现，门禁通过，待提交/推送后确认。
- 修改：新增输入规范化、候选/provenance/draft/字段类型、官方 allowlist 与 SSRF 防护、受限抓取、通用 HTML/PDF 文本提取、可选 Playwright fallback、幂等 catalog job API 和候选原子落盘/rollback manifest；catalog 参数与价格候选保持分离。
- 测试：`npx vitest run tests/catalog-search.test.ts`（10 tests）、`npm test`（18 files / 208 tests）、`npm run typecheck`、`npm run build`、`npm run test:g1:browser`、`node tests/legacy-run-static-tests.js`、`node tests/legacy-run-model-tests.js`、本地 API job/SSRF smoke、`git diff --check` 和敏感信息扫描均通过。
- 未解决 unknown：未配置厂商适配器时只返回官方站内搜索候选；扫描型/非文本 PDF、登录墙/验证码和动态页面失败时保持 partial/unknown；本阶段不写入正式 catalog。
- 回滚：回退本阶段独立提交；候选文件通过 `data/audit/rollback/catalog-search-manifest.json` 恢复，不删除原始 catalog 或价格数据。

## 8. G4：厂商适配器、官方直通与草稿确认（原 S2/S3）

### 目标

建立“官方 exact candidate 可直通，其他结果必须确认”的安全写入流程。

### 任务清单

- [x] 从 JONSBO、ASUS、Seagate、Corsair 中选择 2–3 个页面稳定且覆盖当前基线 SKU 的品牌。
- [x] 每个 adapter 实现 `canHandle`、discover/extract，并提供 HTML/PDF fixture。
- [x] 实现 `POST /api/catalog/candidates/:id/accept-official`。
- [x] 服务端重复执行 allowlist、canonical、exact MPN/brand-model、抓取状态、关键字段、冲突和 provenance 检查。
- [x] 同 MPN 已有手工字段时禁止静默覆盖；只允许追加来源或进入 conflict。
- [x] 非直通候选进入 `SkuDraft` 确认页，确认时重新校验字段、重复 MPN、schema 和 feature flag。
- [x] 写入 catalog version、旧值备份、hash、字段变更摘要和 AuditEvent。
- [x] 重复请求返回同一结果，不重复创建 SKU；失败不得产生半写入。

### 退出门禁

- exact official candidate 可以直通并成功回滚。
- 缺关键字段、冲突、非 allowlist 域名、登录墙或验证码状态全部阻断直通。
- 非直通候选取消确认后，catalog、BuildConfig 和 BOM 不变化。

### G4 执行记录（2026-08-23）

- 状态：已实现，门禁通过，待提交/推送后确认。
- 修改：新增 ASUS、Seagate、Corsair 三个官方 adapter 的 canHandle/discover/extract；新增 HTML/PDF fixtures；实现 `accept-official`、`SkuDraft` 创建/确认/拒绝、catalog version、字段 provenance、content hash、AuditEvent、幂等 key 和 rollback manifest。
- 直通条件：allowlist、canonical、最终 URL、成功 HTTP 状态、exact MPN 或 exact brand/model、类别关键字段、无冲突、完整 provenance 和 content hash 全部通过才允许写入；默认 feature flag 关闭。
- 测试：`npx vitest run tests/catalog-search.test.ts`（13 tests）、`npm test`（18 files / 211 tests）、`npm run typecheck`、`npm run build`、两个 legacy runners、`npm run test:g1:browser`、三家真实页面只读抽样（均 HTTP 200）、G4 API smoke、`git diff --check` 和敏感信息扫描均通过。
- 回滚演练：临时 catalog 直通新增 SKU 后通过 rollback manifest 恢复旧 catalog；草稿拒绝和未确认状态均未修改 catalog。
- 未解决 unknown：真实 ASUS/Seagate/Corsair 页面抽样存在动态字段缺失或冲突，均保持 partial/不可直通；厂商页面变化、验证码和登录墙仍需 adapter/Playwright 失败降级；本阶段没有把实时抽样写入正式 catalog。
- 回滚：回退本阶段独立提交；使用对应 catalog/draft/audit rollback manifest 恢复旧值，不删除原始数据。

## 9. G5：价格联动与购买信息一致性（原 S4）

### 任务清单

- [x] 从已确认 SKU 生成现有 price-server 查询。
- [x] 参数 provenance 与价格 provenance 分离。
- [x] 明确 MSRP、当前报价、已购价、历史 snapshot、from price 和汇率参考价。
- [x] 价格候选仍需人工确认 variant 后才能进入 snapshot。
- [x] catalog 写入和 snapshot 写入分别审计、分别回滚。
- [x] 购买清单展示 snapshot 日期、平台、variantLabel 和来源。

### 退出门禁

- 价格更新不会覆盖参数字段。
- 非 CNY、未审计或仅搜索卡片的报价不会进入正式总价。
- 同一 SKU 的参数和价格可通过版本/hash 独立复现。

### G5 执行记录（2026-08-23）

- 状态：已实现，门禁通过，待提交/推送后确认。
- 修改：统一 `PriceQuote`/`PriceSnapshotFile` 的 CNY variant 与价格 provenance 契约；price-server 仅接受人工确认的 `skuId+platform+variantLabel` 审计报价；snapshot、价格事件和 rollback manifest 独立写入并以 input/content/provenance hash 幂等；购买清单展示 snapshot 日期、平台、variantLabel、来源和 provenance；参数 provenance 保持独立。
- 测试：服务端 `.mjs` 语法检查、G5 价格定向测试（28 tests）、`npm test -- --run`（19 files / 213 tests）、`npm run typecheck`、`npm run build`、两个 legacy runners、`npm run test:g1:browser`、无效 from/USD/缺时间 API smoke、浏览器价格 provenance 展示 smoke、`git diff --check` 和敏感信息扫描均通过。
- 回滚演练：临时 local quote/snapshot/audit 目录验证同 variant 幂等替换、不同 variant 并存、重复 snapshot 不重复审计事件，并通过 snapshot rollback manifest 恢复旧 latest；本阶段未写入正式 `data/`。
- 未解决 unknown：真实平台价格、汇率参考和“已购价”仍需后续接入；历史/搜索卡片报价只保留为 `from` 或候选，不能进入 CNY 总价；上游页面/接口字段变化继续按 unknown 降级。
- 回滚：回退本阶段独立提交；使用 snapshot/price-event rollback manifest 恢复 latest、日期 snapshot 和本地审计报价，不删除原始 catalog 参数 provenance。

## 10. G6：DeepSeek 建议层与环境配置（原 S5）

### 任务清单

- [ ] 使用 `.env.example` → `.env.local` 管理 `DEEPSEEK_API_KEY`、URL、model、timeout、max tokens、temperature 和 enabled。
- [ ] 服务端通过 `scripts/deepseek/config.mjs` 校验；禁止前端 `import.meta.env` 读取 key。
- [ ] 新增 `/api/advice/build` 和 `/api/advice/build/:requestId` job。
- [ ] 将 `BuildEvaluation`、SKU provenance、BOM、用户目标、unknown 和 engine hash 组装为 `BuildAdviceInput`。
- [ ] 对 DeepSeek 输出执行 JSON schema、refs 存在性、数字回溯和 `bad` 不可降低校验。
- [ ] 使用 prompt version + input hash + engine hash + model 作为缓存键。
- [ ] 保存脱敏的请求/响应 hash、延迟、重试、schema 结果和失败阶段。
- [ ] UI 分开渲染确定性 findings 与 DeepSeek 建议。
- [ ] 停用 `fitModel`、`routeTitle`、`routeCopy`、`fanAdvice`、`next-buy-list` 的写死自然语言评价。
- [ ] AI 失败时保留结构化 findings/BOM/热/接线结果，不恢复旧文案。

### 退出门禁

- 缺 key、错误 URL、超时、限流、非法 JSON 和无效 refs 都能安全失败或降级。
- AI 不能把 `bad` 变成 recommended，也不能从输入事实找不到的数字生成 claim。
- 关闭 `BUILD_SIM_ADVICE_ENABLED` 时基础装机评估不受影响。

## 11. G7：物理扩展、实测校准与全链路 QA（P2）

### 任务清单

- [ ] 加入 GPU OBB/旋转、插头扫掠体、线材弯折半径、HBA/NIC 槽宽、电气 lane 和服务空间约束。
- [ ] 引入墙上功耗、SMART 温度、CPU/GPU 温度、噪音和风扇曲线 calibration snapshot。
- [ ] 校准只收窄 planning range，不覆盖原始官方证据。
- [ ] 参数化覆盖 9 HDD、NVMe 数、GPU 厚度、dual PSU、风扇 count、缺失字段、官方冲突、导入迁移和 DeepSeek 降级。
- [ ] 完成真实浏览器、导出配置、购买清单和 AI 建议的跨层一致性验证。

### 退出门禁

- 官方、标准、规划、手工、冲突、未知证据在 UI、导出、价格和 AI 建议中一致。
- 预览、engine、AI 和配置清单不存在未解释分叉。

## 12. 总体发布前检查

### 自动化检查

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

另外必须执行：

- Playwright 基线、官方 exact、非直通草稿、缺字段、重复 job、DeepSeek disabled/timeout/invalid JSON 场景。
- 构建产物敏感信息扫描。
- catalog、draft、snapshot、audit 的备份和回滚演练。
- 无网络、无 DeepSeek key、官网 403/429、验证码和响应超大场景。

### 发布条件

- G0–G7 门禁全部记录为通过。
- 所有阶段提交可单独回滚。
- 没有未解释的测试豁免、未知字段或数据迁移失败。
- 默认 feature flag 保持安全状态；上线后先灰度开启 catalog 直通，再灰度开启 DeepSeek。

## 13. Goal 提示词（可直接复制）

```text
目标：按照 docs/superpowers/plans/2026-08-23-build-sim-upgrade-follow-plan.md，完成 Build Sim 的升级优化，不要跳过阶段门禁。

工作规则：
1. 先读取该 follow plan 和对应设计 spec，核对当前仓库实际状态；不能把计划内容当成已实现功能。
2. 严格按 G0 → G1 → G2 → G3 → G4 → G5 → G6 → G7 执行。每个阶段完成后先运行该阶段测试和 npm test/typecheck/build，再停下来报告门禁结果。
3. 每个阶段一个独立提交；提交前执行 git diff --check，检查敏感信息、未预期文件、数据迁移和回滚文件。阶段门禁通过后必须立即 commit 并 push 到当前远程分支，不能只在本地提交。
4. 保留现有用户未相关的修改，不使用 git reset --hard、git checkout -- 或破坏性删除。
5. 所有页面 KPI、FIT、温度、BOM、接线和 AI 输入必须来自唯一的 BuildEvaluation；DeepSeek 不能修改 ok/warn/bad、补造 unknown 或生成输入中不存在的数字。
6. 官网 exact MPN 且 allowlist、canonical、抓取、关键字段、冲突和 provenance 全部通过时才允许官方直通；其他候选必须进入草稿确认。
7. DeepSeek key/url/model/timeout 等只从 .env.local 读取，禁止 VITE_ 前缀、浏览器读取、日志回显或提交到 Git。
8. 官网、价格、catalog、BuildEvaluation、UI、导出和建议之间必须保留 provenance、hash、版本和审计记录；任何写入都要幂等、可回滚。
9. AI、官网或价格服务失败时，必须保留确定性装机评估和结构化 unknown，不得恢复旧 runtime 的写死评价文案。
10. 开始执行前确认当前分支和远程：`git branch --show-current`、`git remote -v`；没有远程或没有 push 权限时立即报告阻塞，不得声称阶段完成。
11. 每个阶段提交后执行 `git status --short`、`git log -1 --oneline` 和 `git push -u origin <branch>`（首次）或 `git push`（后续）；push 返回成功后再进入下一阶段。
12. 最终完成前确认 `git status --short` 为空、`git log -1` 与远程分支一致，并用 `git ls-remote origin <branch>` 核对远程 commit；commit 或 push 任一步失败都必须保留错误信息并停止推进。

每个阶段的报告格式：
- 阶段：Gx
- 本次完成的任务：
- 修改文件：
- 测试命令及结果：
- 门禁：通过/未通过
- 未解决风险或 unknown：
- 回滚方式：
- 提交 hash：
- 下一阶段前是否需要确认：

完成定义：只有 G0–G7 全部通过，浏览器和跨层测试通过，敏感信息扫描通过，迁移/回滚演练完成，才能报告“升级完成”。
```
