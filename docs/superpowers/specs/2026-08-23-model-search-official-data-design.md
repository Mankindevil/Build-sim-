# 型号联网搜索、事实层与 AI 建议升级优化计划

日期：2026-08-23 · 版本：v1.1 · 状态：待 review

本文件是实施计划，不是已完成状态声明。当前仓库仍以本地 catalog、`evaluateBuild`、旧版 V1 runtime 和本地 `price-server` 为现状；以下阶段完成并通过门禁后，才可称为对应能力已上线。

## 0. 当前状态与计划边界

### 已存在

- `data/skus/catalog.json`、N6 case profile/geometry/routing/assembly 和 `evaluateBuild` 确定性引擎。
- `scripts/price-server/` 本地价格服务、官方页面适配器基础设施、浏览器 fallback、候选和 snapshot 机制。
- `.env.example`、`.env.local` 读取约定，以及服务端 DeepSeek 配置校验模块 `scripts/deepseek/config.mjs`。

### 尚未实现

- `/api/catalog/*` 型号搜索、官网候选 job、字段提取 provenance、草稿和官方直通写入。
- G1/G2 规定的 V1/V2 事实层收敛、capability/power/price/profile 数据化和完整配置校验。
- `/api/advice/build` DeepSeek 请求客户端、JSON/ref 校验、缓存和 UI 建议面板。
- 官网搜索、直通写入、DeepSeek 降级和跨层浏览器验收的完整自动化证据。

因此，当前不能对用户宣称“已经可以输入型号联网搜索”或“已经由 DeepSeek 生成装机建议”；本文件只定义升级完成所需的实施路径和验收证据。

## 1. 目标

用户在 Build Lab 中输入一个自然语言型号、品牌 + 型号或 MPN 后，系统能够：

1. 规范化用户输入并识别品牌、型号、MPN、类别和地区。
2. 联网搜索候选产品，官网来源优先，必要时使用官方站内搜索或受控的搜索提供商。
3. 打开候选官网页面，提取尺寸、功耗、接口、兼容性、价格和官方图片等结构化字段。
4. 为每个字段保留来源、抓取时间、提取方式和证据等级。
5. 官网精确匹配、来源可信且通过字段校验的结果可以直接写入正式 SKU；不满足直通条件的结果才进入“待确认 SKU 草稿”。
6. 官网找不到或参数不完整时，明确显示 `unknown`，不能用电商标题、同系列型号或经验值冒充官网参数。
7. 后续接入 DeepSeek，为当前页面提供装机建议、潜在风险、替代方案和下一步操作，替代旧运行时中写死的评价文案。

现有 `scripts/price-server/` 已具备本地 HTTP 服务、官方页面适配器、浏览器 fallback、候选保存和人工审计机制。本设计沿用这一边界，不让浏览器直接跨域抓站，也不新建第二套价格抓取服务。

## 2. 非目标

- 普通搜索结果、第三方商城结果和存在冲突的官网结果不自动写入正式 SKU；只有满足第 3.3 节全部条件的官方 exact candidate 才允许走 `accept-official` 直通。
- 不绕过验证码、登录、robots、站点限流或访问控制。
- 不把第三方商城页面标记为官方参数来源。
- 不以 LLM 自由生成参数作为型号参数第一数据源；参数仍必须来自官网、规格书、已审计 SKU 或用户输入。DeepSeek 只消费已结构化的事实，生成建议和风险解释。
- 不在本阶段实现所有厂商的专用 API；先做可插拔适配器和少量明确厂商的官方页面适配。
- 不因为找到官网价格，就把 MSRP、当前零售价、成交价和历史最低价混为一个字段。

## 2.1 评审结论与不可破坏不变量

本次评审将原计划、12 个代码问题、DeepSeek 接入和环境变量要求合并为一条升级路线。后续实现必须满足以下不变量：

1. **单一事实源**：页面 KPI、FIT、热结果、接线、BOM、价格汇总和 AI 输入只能来自同一份 `BuildEvaluation`/事实快照；V1 runtime 不得再维护平行结论。
2. **确定性优先**：几何冲突、端口容量、功耗边界和字段校验由本地 engine 判定；DeepSeek 只能解释、排序和提出条件性方案。
3. **unknown 不猜测**：缺失或冲突字段保持 `unknown`/`conflict`，不能用同系列、标题、经验值或模型推理替代。
4. **证据可追溯**：任何正式 SKU 字段、自动接纳、手工修改、价格 snapshot 和 AI claim 都必须能回到 provenance、输入 hash 或 engine finding。
5. **写入可回滚**：catalog、草稿、建议缓存和价格 snapshot 的写入必须幂等，保存旧值/变更摘要；失败不得留下半写入状态。
6. **密钥不出服务端**：DeepSeek key 只从 `.env.local`/`.env` 读取，禁止 `VITE_` 前缀、浏览器读取、日志记录和 API 回传。
7. **降级不阻塞基础能力**：官网搜索、装机确定性评估和导出功能不依赖 DeepSeek 可用；AI 失败时不得恢复旧的写死评价文案。

## 2.2 目标架构与边界

```text
用户输入
  ↓ normalize + schema
catalog/search service（本地 price-server，127.0.0.1）
  ↓ official allowlist / fetch / extract / provenance / hash
ModelCandidate → official direct acceptance 或 SkuDraft
  ↓ catalog version + price snapshot（参数与价格两条流水线）
BuildConfig + catalog + case profile
  ↓ evaluateBuild（唯一确定性事实源）
BuildEvaluation + provenance
  ├─ UI：KPI / FIT / 热 / 接线 / BOM / unknown
  └─ DeepSeek adapter：结构化输入 → schema/ref 校验 → 建议与风险
```

浏览器只调用本地 API 并渲染结构化结果，不直接抓官网、不持有第三方 key、不执行服务端写入。官网抓取、catalog 写入、价格审计和 AI 请求均在服务端边界内完成。

## 2.3 计划内模块边界

| 模块 | 计划职责 | 禁止承担的职责 |
|---|---|---|
| `src/catalog-search/` | 输入规范化、候选类型、字段 schema、匹配和 provenance 类型 | 发起外部网络请求、读取密钥 |
| `scripts/price-server/catalog/` | 搜索 job、官网 fetch/extract、缓存、allowlist、draft/direct 写入 | 把未审计价格当成 SKU 参数 |
| `scripts/deepseek/` | 环境配置、请求客户端、超时/重试、输出校验和脱敏 | 决定几何/功耗/兼容性 verdict |
| `src/core/` | 唯一确定性 `BuildEvaluation`、capability、power、thermal、wiring | 生成不可追溯自然语言评价 |
| `src/lab/` | 展示结构化 engine findings、来源和 AI 建议 | 再计算一套 KPI 或保存 API key |
| `data/catalog-candidates/`、`data/audit/` | 候选、快照、审计和回滚引用 | 保存密钥、Cookie、完整未裁剪网页 |

## 3. 用户流程

### 3.1 输入

新增“添加型号”入口，字段如下：

```text
型号输入：Seagate Exos X24 24TB SATA
类别：自动 / 机箱 / 主板 / CPU / PSU / 散热器 / GPU / 内存 / 存储 / HBA / 风扇 / 配件
品牌：可选
地区/语言：默认 zh-CN + CN，可切换 en-US / JP
只查官网：默认开启
```

用户可以输入：

- `RTX A4000`
- `CP-9020284`
- `华硕 W680M ACE SE`
- `Seagate Exos X24 24TB SATA 3.5`

### 3.2 状态

界面按阶段显示：

```text
解析输入 → 搜索候选 → 官网核验 → 提取参数 → 直通判定 / 草稿确认 → 装机建议与风险
```

每个候选显示：

- 产品名、品牌、MPN、类别
- 官网链接和是否为 canonical URL
- 官网是否成功抓取
- 可提取字段数量 / 缺失字段数量
- 匹配分数和匹配原因
- 第三方报价链接（单独分组，不混入官方参数）
- `official / standard / inferred / unknown` 证据标签

### 3.3 官网直通与确认

官网结果满足以下条件时，直接进入正式 SKU：

1. URL 命中厂商 allowlist，最终 canonical URL 仍在允许域名内。
2. 页面或官方 PDF 中的 MPN 与用户输入精确匹配；没有 MPN 时，品牌 + 型号 + 类别必须达到 exact match。
3. 页面抓取成功，未经过登录墙、验证码或异常重定向。
4. 几何、功耗、接口等该类别要求的关键字段通过类型、单位和范围校验。
5. 没有未解决的同 MPN 多版本冲突；版本、地区或容量不同的产品必须拆成不同候选。
6. 每个写入字段都附带官方来源和抓取时间。

直通不是无审计写入：服务端仍保存抓取 hash、字段 provenance、变更摘要和旧值备份；如果同 MPN 已存在 SKU，只追加新来源或生成冲突，不静默覆盖用户手工值。

不满足上述条件时，用户点击“采用此型号”后进入字段确认页：

- 左侧是提取值
- 中间是字段来源和原文片段/表格定位
- 右侧是当前用户输入或已有 SKU 值
- 冲突字段必须逐项选择“采用官网 / 保留旧值 / 手工修改 / unknown”

不满足直通条件的结果只生成 SKU 草稿和变更摘要；是否写入正式 catalog 由独立的“保存型号”操作完成。

### 3.4 DeepSeek 建议

完成 `evaluateBuild` 后，服务端把确定性结果和已确认的字段来源提交给 DeepSeek，生成：

- 当前方案结论
- 机械、电气、热、维护和采购风险
- 必须先处理的事项
- 可选替代方案及取舍
- 需要用户实测或补充资料的 unknown

DeepSeek 只能解释和排序事实，不能改写本地引擎的 `ok / warn / bad`，不能把 unknown 变成已知，也不能编造缺失的尺寸、价格或兼容性。

## 4. 搜索与官网优先策略

### 4.1 查询规范化

新增 `src/catalog-search/normalize.ts`，输出：

```ts
interface NormalizedModelQuery {
  raw: string;
  brand?: string;
  model?: string;
  mpn?: string;
  category?: SkuCategory;
  capacity?: string;
  interface?: string;
  tokens: string[];
  locale: string;
}
```

规则：

- 保留原始输入，不覆盖用户原文。
- 统一大小写、连字符、全角半角和多余空格。
- MPN 优先保留原始拼写，例如 `CP-9020284`、`KF564C32RSK2-32`。
- 容量、接口、尺寸、代际等规格词单独存储，不能只拼成一个搜索字符串。
- 不根据模糊型号强行猜品牌；猜测只能作为候选匹配因素。

### 4.2 搜索层级

搜索顺序固定为：

1. 已知 catalog 中的 `appearance.page` / `price.listingUrl`。
2. 厂商域名注册表中的站内搜索或型号 URL 规则。
3. 受控搜索提供商的精确搜索（品牌 + MPN + `site:官方域名`）。
4. 现有 JD / 淘宝 / 拼多多 / Amazon 适配器，仅作为候选发现和价格候选。

官网域名注册表建议新增：

```json
{
  "brand": "Seagate",
  "domains": ["seagate.com"],
  "countryDomains": ["seagate.com.cn"],
  "search": {
    "kind": "site-search",
    "urlTemplate": "https://www.seagate.com/search/?q={query}"
  },
  "extractor": "seagate-product"
}
```

如果没有厂商适配器，不应直接声称“官网参数已获取”，而是返回“未配置官网适配器 + 可打开搜索链接”。

### 4.3 官网页面解析

新增官方参数采集器接口：

```ts
interface OfficialSourceAdapter {
  id: string;
  domains: string[];
  canHandle(url: URL): boolean;
  discover?(query: NormalizedModelQuery): Promise<OfficialCandidate[]>;
  extract(input: OfficialFetchResult): Promise<ExtractedOfficialData>;
}
```

通用提取顺序：

1. JSON-LD `Product` / `Offer`。
2. OpenGraph、meta、页面标题。
3. 规格表格、定义列表和带单位的字段。
4. 页面内嵌 JSON 状态。
5. 官方手册、规格书 PDF 链接；PDF 参数进入独立来源，不覆盖网页来源。
6. 页面需要 JavaScript 渲染时，使用现有 Playwright browser adapter。

第一阶段不做自由文本“猜值”。例如页面只写“高性能散热”，不能推导出功耗或温度；页面写“约 140W”则可以提取为规划候选，但必须标记原文和精度。

## 5. 统一数据模型

### 5.1 搜索候选

新增 `data/catalog-candidates/YYYY-MM-DD.json`：

```ts
interface ModelCandidate {
  candidateId: string;
  query: NormalizedModelQuery;
  brand?: string;
  model?: string;
  mpn?: string;
  category?: SkuCategory;
  title: string;
  url: string;
  canonicalUrl?: string;
  source: {
    kind: "official" | "marketplace" | "search";
    domain: string;
    platform?: string;
    retrievedAt: string;
    httpStatus?: number;
  };
  match: {
    score: number;
    kind: "exact-mpn" | "brand-model" | "spec-match" | "weak";
    reasons: string[];
  };
  extraction: {
    status: "not-run" | "ok" | "partial" | "failed";
    fieldsFound: number;
    fieldsMissing: number;
    adapter?: string;
    error?: string;
  };
  priceCandidates?: PriceQuote[];
}
```

### 5.2 字段级来源

现有 `SkuRecord` 只有对象级 `evidence`，不足以支撑官网采集。增加可选的 `provenance`，保持旧 catalog 兼容：

```ts
interface FieldProvenance {
  provenanceId: string;
  field: string;
  value: unknown;
  evidence: EvidenceLevel;
  sourceUrl: string;
  sourceKind: "official-page" | "official-pdf" | "marketplace" | "manual";
  retrievedAt: string;
  extractor: string;
  locator?: string;
  snippet?: string;
  confidence?: number;
  note?: string;
}
```

`snippet` 只保存短片段或表格定位，不保存整页 HTML；整页只进入本地缓存，避免把第三方页面内容无界复制进仓库。

正式 `SkuRecord` 增加可选字段：

```ts
provenance?: FieldProvenance[];
```

旧 SKU 没有 provenance 时保持可读，但不会满足“官网直通”的自动接纳条件。

### 5.3 SKU 草稿

```ts
interface SkuDraft {
  schemaVersion: "1.0.0";
  draftId: string;
  baseSkuId?: string;
  candidateId: string;
  proposed: Partial<SkuRecord>;
  fields: FieldProvenance[];
  conflicts: {
    field: string;
    existing?: unknown;
    proposed?: unknown;
    reason: string;
  }[];
  status: "draft" | "confirmed" | "rejected";
  createdAt: string;
  updatedAt: string;
}
```

正式写入时再把 `SkuDraft` 编译成当前 `SkuRecord`，并升级 catalog schema；搜索过程本身不直接改 `catalog.json`。

## 6. 字段提取规则

字段按类别注册，而不是在每个适配器中随意返回：

```ts
interface FieldSpec {
  path: string;
  type: "string" | "number" | "boolean" | "range" | "enum";
  units?: string[];
  requiredFor?: ("geometry" | "power" | "wiring" | "pricing")[];
  validators?: string[];
}
```

公共字段：

- brand / model / mpn
- lengthMm / widthMm / heightMm / thicknessMm
- weightKg
- tdpW / tgpW / ratedW / idleW / maxOperatingW
- interface / form / slots
- official image / manual / product page

类别字段示例：

- PSU：form、ratedW、efficiency、fanOffLoadW、modularPanel、harness
- GPU：tgpW、idleW、lengthMm、slots、vramGb、powerConnector
- 内存：DDR、capacityGb、modules、speedMt、ecc、heightMm、qvl
- 硬盘：capacityTb、interface、form、idleW、maxOperatingW、startup12vPeakA
- 主板：m2Slots、nativeSataPorts、slimsasSataPorts、pcieSlots、memoryType

验证规则：

- 单位必须明确，不能把 `2.5` 自动当成 2.5mm 或 2.5 inch。
- 长度、功耗、容量不能为负数。
- `slots` 可以是 1、2、2.5 等半槽值，但必须保留原文。
- 规格书与网页冲突时，两者都保留，进入冲突列表，不自动选较大或较新值。
- 官方参数缺失时保持 `unknown`，不能从同系列产品复制。

## 7. DeepSeek 建议层设计

### 7.1 职责边界

当前 `src/lab/v1-runtime.js` 中的 `fitModel`、`routeTitle`、`routeCopy`、`fanAdvice`、`next-buy-list` 等内容包含大量写死的评价文案。后续由 DeepSeek 建议层替代这些自然语言评价，但不替代确定性计算：

| 内容 | 权威来源 | DeepSeek 权限 |
|---|---|---|
| AABB 相交、槽位占用、端口数量、线长不足 | `evaluateBuild` / case adapter | 只能解释，不能修改 verdict |
| 硬盘、CPU、GPU、PSU 的输入功耗 | catalog + workload profile | 只能引用和比较 |
| 官网字段、规格书参数 | `FieldProvenance` | 只能引用，不能补造 |
| 方案推荐、风险排序、替代方案 | DeepSeek | 负责生成 |
| 维护顺序、采购优先级、实测建议 | DeepSeek + engine findings | 负责组织和解释 |

### 7.2 输入契约

新增 `BuildAdviceInput`，只发送结构化事实，不把整页网页或完整 HTML 直接交给模型：

```ts
interface BuildAdviceInput {
  requestId: string;
  locale: "zh-CN" | "en-US" | "ja-JP";
  userGoal?: string;
  buildConfig: BuildConfig;
  evaluation: {
    findings: EngineFinding[];
    occupancy: EngineResult;
    wiring: WiringPlan;
    routing: N6Routing;
    thermal?: ThermalResult;
    bom: BuildLineItem[];
  };
  selectedSkuFacts: {
    skuId: string;
    name: string;
    fields: Record<string, unknown>;
    provenance: FieldProvenance[];
  }[];
  constraints: {
    cannotDowngradeBad: true;
    unknownMustStayUnknown: true;
    citeSourceFields: true;
  };
}
```

用户目标可以是“NAS 优先、低噪音”“以后加单槽 GPU”“预算优先”等；如果没有目标，模型必须声明采用的默认优先级，而不是假设用户一定追求性能或最低价格。

### 7.3 输出契约

DeepSeek 必须返回 JSON，服务端先做 schema 校验，再交给页面：

```ts
interface BuildAdviceResult {
  schemaVersion: "1.0.0";
  model: string;
  generatedAt: string;
  summary: string;
  recommendation: {
    verdict: "recommended" | "conditional" | "not-recommended" | "insufficient-data";
    reasons: AdviceClaim[];
  };
  risks: AdviceRisk[];
  actions: AdviceAction[];
  alternatives: AdviceAlternative[];
  unknowns: string[];
  sourceRefs: string[];
}

interface AdviceClaim {
  text: string;
  kind: "engine-finding" | "official-field" | "user-goal" | "model-inference";
  refs: string[];
}

interface AdviceRisk {
  level: "high" | "medium" | "low" | "unknown";
  category: "mechanical" | "electrical" | "thermal" | "maintenance" | "price" | "data";
  text: string;
  refs: string[];
  mitigation?: string;
}

interface AdviceAction {
  priority: number;
  action: string;
  blocking: boolean;
  refs: string[];
}

interface AdviceAlternative {
  title: string;
  changes: string[];
  benefits: string[];
  tradeoffs: string[];
  refs: string[];
}
```

服务端后处理规则：

1. JSON 不合规时重试一次；仍失败则返回 `advice-unavailable`。
2. `refs` 必须指向 engine finding id、SKU field provenance id 或用户目标，不能为空泛引用。
3. 模型输出的 `recommended` 不能覆盖 engine 的 `bad`；若存在 `bad`，最终 UI 至少显示 `not-recommended` 或 `conditional`。
4. 模型声称的数字必须能在输入事实中找到；找不到就降级为 unknown 并记录校验错误。
5. 建议和事实分开渲染，页面明确显示“DeepSeek 建议”与“确定性引擎判定”。

### 7.4 API

新增：

```text
POST /api/advice/build
GET  /api/advice/build/:requestId
```

建议请求也使用 jobId/requestId，因为 DeepSeek 请求、重试和引用校验可能超过普通页面请求时限。服务端保存：

- provider：`deepseek`
- model name
- prompt/input hash
- response hash
- generatedAt
- schema validation result
- engine evaluation hash

API key 只存在服务端环境变量，浏览器永远不能读取；UI 只收到结构化建议和引用。

### 7.4.1 环境变量管理

DeepSeek 配置统一放在项目根目录的 `.env.local`，模板为 `.env.example`。`.env.local` 已被 Git 忽略，不能提交真实密钥；`.env.example` 只包含空 key 和非敏感默认值。

| 变量 | 必填 | 用途 | 默认值/限制 |
|---|---:|---|---|
| `DEEPSEEK_ENABLED` | 否 | 是否启用建议请求 | `false` |
| `DEEPSEEK_API_KEY` | 启用时必填 | 服务端鉴权 | 不回传、不记录日志 |
| `DEEPSEEK_API_URL` | 否 | DeepSeek API 根地址 | `https://api.deepseek.com`，只允许 HTTP(S) |
| `DEEPSEEK_MODEL` | 否 | 模型名称 | `deepseek-chat` |
| `DEEPSEEK_TIMEOUT_MS` | 否 | 单次请求超时 | `30000`，范围 1000–120000 |
| `DEEPSEEK_MAX_TOKENS` | 否 | 输出 token 上限 | `1200`，范围 1–16384 |
| `DEEPSEEK_TEMPERATURE` | 否 | 生成温度 | `0.2`，范围 0–2 |

服务端通过 `scripts/deepseek/config.mjs` 读取并校验这些变量。前端不得使用 `import.meta.env` 读取 DeepSeek key；如果启用但缺 key、URL 非 HTTP(S) 或数值超出范围，应在服务启动/首次请求时明确失败，并沿用“AI 建议暂不可用”的降级策略。

### 7.5 Prompt 与不可信网页内容

- 官网页面中的文本、产品标题和用户输入都视为不可信数据，不能让它们改变系统指令。
- 发送给 DeepSeek 的是清洗后的字段和短引用片段，不发送脚本、Cookie、完整 HTML 或无界文本。
- Prompt 明确要求：不能猜测缺失参数；必须引用给定的 `refs`；不能修改 `ok / warn / bad`。
- 用户目标与网页文本分开标记，防止网页中的提示词污染建议。

### 7.6 降级

DeepSeek 不可用、超时、限流或返回非法 JSON 时：

- 保留 `evaluateBuild` 的确定性 findings、BOM、接线和热结果。
- 页面显示“AI 建议暂不可用”，而不是恢复旧的写死评价文案。
- 允许用户重试或导出结构化评估结果，不能阻塞基础装机检查。

## 8. API 设计

复用现有本地 `price-server`，新增 `/api/catalog` 路由；继续只绑定 `127.0.0.1`。

### `POST /api/catalog/search`

请求：

```json
{
  "query": "Seagate Exos X24 24TB SATA",
  "category": "storage",
  "brand": "Seagate",
  "locale": "zh-CN",
  "officialOnly": true,
  "limit": 10
}
```

响应：

```json
{
  "jobId": "catalog-search-...",
  "status": "queued"
}
```

搜索和官网抓取可能打开浏览器或等待站点响应，使用 jobId，避免页面请求超时。

### `GET /api/catalog/search/:jobId`

返回：

```json
{
  "status": "running | completed | partial | failed",
  "stage": "normalize | discover | fetch | extract | score",
  "candidates": [],
  "warnings": [],
  "errors": []
}
```

### `POST /api/catalog/inspect`

请求候选 URL，单独执行官网参数提取。返回 `ModelCandidate + FieldProvenance[]`，不写 catalog。

### `POST /api/catalog/drafts`

把候选和用户确认值保存成 `SkuDraft`。请求必须携带字段选择结果，服务端重新验证来源和字段类型。

### `POST /api/catalog/drafts/:id/confirm`

将非直通草稿编译成 SKU。确认前再次检查：MPN、类别、必需几何字段、字段证据和重复 SKU。返回变更摘要，不静默覆盖同 MPN 的旧 SKU。

### `POST /api/catalog/candidates/:id/accept-official`

对满足官网直通条件的候选执行自动接纳。服务端重新执行 allowlist、canonical URL、MPN exact match、字段校验、冲突检查和内容 hash 校验；通过后直接写入 SKU，并返回：

- 新增或更新的 `skuId`
- 字段变更摘要
- 官方 provenance 列表
- 旧值备份位置
- 未满足直通条件时的具体阻断原因

## 9. 缓存、限流和安全

### 缓存

- URL 规范化后作为缓存 key。
- 保存 `ETag`、`Last-Modified`、抓取时间、HTTP 状态和内容 hash。
- 默认缓存 24 小时；用户可点击“强制刷新”。
- 同 URL + 同内容 hash 不重复解析。
- 搜索候选和官网字段缓存分开，避免价格刷新覆盖参数来源。

### 限流

- 复用现有 channel throttle / cooldown。
- 官方站点也按域名单独限流，不只按渠道限流。
- 单个 job 限制最大域名数、页面数、响应大小和总耗时。
- 浏览器验证页面保持现有“需要登录/验证码”状态，不自动重试绕过。

### SSRF 与数据安全

服务端抓取必须：

- 只允许 `https:`，必要时允许少数明确的 `http:` 官方域名。
- 禁止 `file://`、`data:`、`javascript:` 和本地回环地址。
- 每次 redirect 重新校验目标域名和私网 IP。
- 限制响应大小、重定向次数、连接超时和解析超时。
- 不把用户 Cookie、浏览器登录态、Authorization header 转发给任意 URL。
- 不把抓到的整页 HTML 自动提交给第三方 LLM。

### 9.1 审计、观测与保留策略

所有外部抓取、正式写入和 AI 请求都产生统一审计事件，至少包含：

```ts
interface AuditEvent {
  eventId: string;
  eventType: "search" | "fetch" | "extract" | "catalog-write" | "price-write" | "advice";
  requestId?: string;
  actor: "user" | "system";
  inputHash?: string;
  sourceUrl?: string;
  outcome: "success" | "partial" | "blocked" | "failed";
  reason?: string;
  changedFields?: string[];
  rollbackRef?: string;
  createdAt: string;
}
```

至少记录 job 成功/失败/部分完成、官方直通阻断原因、抓取耗时、缓存命中、DeepSeek 延迟/重试/限流/输出校验结果；日志必须脱敏，不记录 API key、Authorization、Cookie、完整 prompt 或整页 HTML。候选原文缓存、AI 建议缓存和审计事件设置明确 TTL，并提供按 requestId/inputHash 定位和删除入口。

### 9.2 外部服务故障隔离

- 按域名和 DeepSeek provider 使用独立 timeout、并发上限和 circuit breaker；单一官网或模型故障不能拖垮 `price-server` 或 Build Lab。
- job 使用幂等 key；重复点击只返回已有 job，不重复抓取、写入或计费。
- 服务恢复后允许用户显式重试；后台不得无限重试验证码、登录失败、4xx 或 schema 永久错误。

## 10. 与现有价格系统的关系

官网参数搜索和价格审计要分成两条流水线：

```text
型号搜索 → 官网精确匹配 → 官方直通 catalog SKU
                         ↘ 非精确/有冲突 → 用户确认草稿 → catalog SKU
                         ↘ marketplace / official price candidate → 人工审计 → snapshot
```

规则：

- 官网参数可以没有价格。
- 官网价格可以是 USD、JPY 等，不能直接进入 CNY snapshot。
- 电商搜索卡片价格继续标记 `priceKind: "from"`，不能自动审计。
- 参数来源为官方，不代表价格已经审计。
- 价格审计通过 `skuId + platform + variantLabel` 关联到 SKU，但不改变字段级参数证据。

## 11. UI 设计

新增“添加型号”面板，最小版本包括：

1. 输入框、类别、品牌和官网优先开关。
2. 搜索进度和渠道状态。
3. 候选卡片：官网标识、MPN、匹配原因、字段完整度。
4. 参数表：值、单位、证据等级、来源链接、定位片段。
5. 冲突字段筛选。
6. 对官方直通候选显示“直接采用”；对非直通候选显示“生成草稿”。
7. 提供“打开官网”“加入价格审计”“生成 DeepSeek 建议”三个动作。
8. `unknown` 字段不能显示成 `0`，不得因为 UI 缺省而填入规划值。

官方直通候选在服务端校验通过后可写入正式 catalog，但必须生成变更摘要和旧值备份；非直通候选在用户确认前不修改当前配置、BOM 或正式 catalog。

## 12. 失败与降级行为

| 情况 | 返回行为 |
|---|---|
| 无法识别型号 | 保留原查询，给出手动填写品牌/MPN提示 |
| 找到多个同名型号 | 不自动合并，按 MPN/地区/容量拆分候选 |
| 官网不可访问 | 显示官网链接和失败原因，可继续查看电商候选，但官方字段保持 unknown |
| 官网无结构化字段 | 返回页面成功但参数 partial，不从描述猜值 |
| 页面需要登录/验证码 | 状态 needsLogin，不绕过 |
| 网页与 PDF 冲突 | 两条来源并列，进入 conflict |
| 电商标题与官网型号不一致 | 候选降权或标 suspect，不写入 SKU |
| 官网 exact MPN、字段完整且无冲突 | 允许 `accept-official` 直接写入 SKU，并保留 provenance 和回滚备份 |
| 官方字段缺少几何必需值 | 可以保存草稿，但不能标记为 geometry-ready |
| 抓取超时/限流 | job partial，保留已经完成的候选和每个渠道原因 |

## 13. 测试计划

### 单元测试

- 输入规范化：大小写、连字符、中文品牌、容量和接口词。
- MPN 精确匹配、品牌+型号匹配、同系列误匹配拒绝。
- JSON-LD、规格表、嵌入 JSON、PDF 链接解析。
- 单位换算和非法数值拒绝。
- 页面与 PDF 字段冲突保留两条来源。
- 缺少官方页面、缺少字段、非 CNY 官网价格保持 unknown。
- canonical URL、redirect、私网地址和协议校验。
- 同 URL 内容 hash 命中缓存。
- `.env.local` 配置：disabled 可无 key、enabled 缺 key 拒绝、URL 协议和数值边界校验；key 不出现在日志和前端构建产物。

### 集成测试

- `/api/catalog/search` job 生命周期。
- 官方适配器失败后 marketplace 候选仍能返回。
- exact official candidate 通过 `accept-official` 后能直接新增/更新 SKU，并生成 provenance、hash 和备份。
- 非直通候选仍必须经过草稿确认；未确认时 catalog 不变。
- 重复 MPN 不会生成两个未提示的正式 SKU。
- 价格 candidate 与参数 provenance 不互相覆盖。
- DeepSeek 输入只包含结构化事实和短引用，不包含整页 HTML。
- DeepSeek 非法 JSON、无引用数字或试图降低 `bad` 时，服务端拒绝或降级。
- AI input hash、engine hash 或 prompt version 变化时不会错误复用旧建议；缓存命中和手动刷新行为可验证。

### 浏览器验收

至少覆盖：

1. 输入 `RTX A4000`，官方 exact candidate 通过直通校验，自动进入 SKU，并查看尺寸、功耗、插槽和 provenance。
2. 输入 `CP-9020284`，官网参数和电商线材/价格候选分栏显示，官网参数可直通但价格仍需独立审计。
3. 输入不存在型号，显示 partial/unknown，不出现假参数。
4. 官网字段缺失时，用户可以手工填入并看到字段来源变为 `manual`。
5. 非直通候选取消确认后，当前 catalog、BuildConfig 和 BOM 不变化。
6. 生成 DeepSeek 建议时，页面同时展示确定性 findings 和 AI 建议，且 AI 不能降低 `bad`。
7. DeepSeek 不可用时显示结构化评估结果和“AI 建议暂不可用”，不恢复旧的写死评价文案。
8. 搜索过程中切换页面或重复点击，不会创建重复 job。

## 14. 统一实施路线、交付物与门禁

所有阶段都按“代码/数据变更 → 离线测试 → 浏览器 smoke → 变更摘要 → 可回滚点”交付。阶段未通过门禁时，不进入下一阶段；新功能通过 feature flag 保持关闭，不影响现有 Build Lab 和价格审计。

### G0：基线冻结与迁移护栏（P0 前置）

**目的**：先固定现状证据，避免重构过程中把“修复”误判为“新功能”。

- 记录当前 `npm test`、`npm run typecheck`、`npm run build` 和最小浏览器 smoke 的结果；修复测试入口中的 ESM/CJS 问题，明确哪些 legacy 测试暂时豁免。
- 为 baseline、dual PSU、240 radiator、9 HDD/HBA、缺失字段和价格 snapshot 生成固定配置快照。
- 新增 `BUILD_SIM_CATALOG_WRITE_ENABLED`、`BUILD_SIM_ADVICE_ENABLED` 等服务端开关，默认关闭；所有写入使用临时文件 + 原子 rename。
- 确认 `.env.local`、`.env.example`、`scripts/deepseek/config.mjs` 的密钥边界；禁止真实 key 进入测试 fixture、日志和前端构建产物。

**交付物**：基线报告、场景清单、开关说明、回滚脚本/备份目录约定。

**门禁**：基线命令可重复；`dist` 和浏览器 bundle 中无 `DEEPSEEK_API_KEY`；关闭开关时现有页面行为不变。

### G1：统一 `BuildEvaluation` 与页面事实源（P0，关闭问题 1、3、6、11、12 的核心部分）

- 将页面 KPI、FIT、温度、BOM、价格摘要、接线和热场输入改为读取 `BuildEvaluation`；V1 runtime 只保留渲染和交互，不再自行计算结论。
- 为 primary/secondary PSU 建立显式 `PsuLoad`，各自绑定效率、DC 负载和 chamber；添加 dual topology 回归测试。
- 将风扇 `count/size/mount/radiatorFanProfile` 贯穿 config → geometry → thermal → UI，禁止把 240 冷排当成 140 风扇。
- 统一视觉层的 `PlacedPart[]` 和 projection，至少消除概览 SVG、等轴图和冲突图的重复基线布局。
- 修复 legacy 测试入口并加入最小 Playwright smoke：页面 KPI 与 `evaluateBuild()` 的关键字段逐项比对。

**交付物**：单一事实层、迁移后的 view-model、dual/240/count 测试、浏览器 smoke。

**门禁**：同一配置下 UI 与 `evaluateBuild()` 无未解释差异；存在 `bad` 时页面不得显示“可直接安装”；旧写死建议可以隐藏但确定性 findings 仍完整显示。

**回滚**：保留旧 renderer 只读 fallback，但不得恢复旧结论；通过 feature flag 切换渲染入口。

### G2：Capability、功耗、价格与 unknown 数据化（P1，关闭问题 2、4、5、7、8、9、10）

- 建立 `CaseCapabilities`、`BoardCapabilities`、`PowerProfile`、`WorkloadProfile` 和带 provenance 的 `ThermalProfile`；盘位、背板口、风扇 mount、PCIe/SATA/SlimSAS/M.2 数量只保留一个来源。
- 将 CPU PL1/PL2、GPU/HBA/硬盘/风扇/PSU 输入、效率和 derate 规则移出 V1 runtime；明确 `official`、`standard`、`planning`、`manual`、`unknown` 五类证据。
- 删除固定价格、`fixedCost` 和 `4500 * diskCount` 等旁路；已购、当前、原价、历史最低价分别走 price snapshot 字段，未知不得伪造。
- 清理静默 fallback（7W、0.9、0.88、24dBA、99mm、31mm 等）；无证据的数值只能返回 unknown 或显式 planning range，并产生 finding。
- 几何和展示名称全部读取所选 SKU；HBA 端口改为 `controller/connector/portIndex` 结构化映射。
- `parseConfig` 后增加 schema migration、类型/范围、SKU 类别、拓扑、BOM 和 capability 校验；非法导入不得部分写入。

**交付物**：catalog/profile schema、迁移脚本、unknown/planning UI、价格字段迁移报告、配置校验器。

**门禁**：修改一个 SKU 或 case profile 后，几何、接线、功耗、价格和展示同步变化；所有无来源数字可追溯或明确 unknown；旧配置可迁移且失败可回滚。

### G3：型号搜索与官网通用采集（原 S0/S1）

- 落地 normalize、candidate、provenance、draft 类型及 `/api/catalog/search`、`/inspect` job 骨架。
- 复用现有 `price-server`，保持 `127.0.0.1` 绑定；加入官方 allowlist、canonical/redirect/私网校验、域名限流、ETag/Last-Modified/content hash 缓存。
- 按 JSON-LD → meta → 规格表 → 内嵌 JSON → 官方 PDF → Playwright fallback 的顺序提取；不做自由文本猜值。
- UI 展示候选、字段完整度、来源类型、短片段/定位和 unknown；参数来源与第三方价格候选分栏。

**交付物**：API job store、通用 extractor、缓存与安全校验、候选 UI、离线 fixture。

**门禁**：输入规范化和字段验证单测通过；SSRF/redirect/响应大小测试通过；官网失败只影响官方字段，不伪造参数；重复 job 具有幂等 key。

### G4：厂商适配器、官方直通与草稿写入（原 S2/S3）

- 先选择 2–3 个基线最需要的厂商，建议从 JONSBO、ASUS、Seagate、Corsair 中按页面稳定性排序，不以品牌数量作为完成指标。
- 每个适配器必须有 HTML/PDF fixture、MPN/canonical/字段冲突测试和真实页面抽样复核；Playwright 仅作为失败 fallback。
- 实现 `accept-official`：allowlist、exact MPN/brand-model、抓取状态、关键字段、冲突和 provenance 六项全部通过后才可直写；同 MPN 手工字段不得静默覆盖。
- 非直通候选必须进入 `SkuDraft` 确认页；确认时再次校验来源、字段类型、重复 MPN、schema 和写入开关。
- 写入生成 catalog 版本、旧值备份、内容 hash、字段变更摘要和审计事件；重复请求返回同一结果，不重复创建 SKU。

**交付物**：厂商 adapters、直通/草稿 API、schema migration、审计与回滚记录。

**门禁**：exact official candidate 能直通且可回滚；缺关键几何字段、冲突或非 allowlist 域名必阻断；非直通取消确认时 catalog/BuildConfig/BOM 不变。

### G5：价格联动与购买信息一致性（原 S4）

- 从已确认 SKU 生成现有 price-server 查询，保持参数 provenance 与价格 provenance 分离。
- 区分 MSRP、当前报价、已购价、历史 snapshot、`from` 起价和汇率参考价；官网参数直通不等于价格自动入账。
- 价格审计仍要求人工确认 variant；snapshot 写入与 catalog 写入分开，可独立回滚。

**交付物**：价格字段迁移、UI 分栏、snapshot 关联和审计回归测试。

**门禁**：价格变更不会覆盖参数字段；非 CNY 或未审计报价不会进入总价；购买清单能复现对应 snapshot 日期和来源。

### G6：DeepSeek 建议层与环境配置（原 S5）

- 使用 `.env.example` → `.env.local` 管理 `DEEPSEEK_API_KEY`、URL、model、timeout、max tokens、temperature 和 enabled；服务端通过 `scripts/deepseek/config.mjs` 校验，浏览器永不读取 key。
- 新增 `/api/advice/build` job；输入只包含 G1/G2 生成的 `BuildAdviceInput`、SKU provenance、BOM、用户目标和 engine hash。
- 对输出执行 JSON schema、`refs` 存在性、数字事实回溯、`bad` 不可降低和 prompt-injection 防护；保存 input/prompt/response/engine hash，不保存原始 key、Cookie 或整页 HTML。
- UI 将“确定性引擎判定”和“DeepSeek 建议”分区；停用 `fitModel`、`routeTitle`、`routeCopy`、`fanAdvice`、`next-buy-list` 的写死自然语言评价。
- DeepSeek 不可用、超时、限流或非法 JSON 时，仅显示结构化 findings/BOM/热/接线结果和 AI 暂不可用状态。

**交付物**：server adapter、schema/ref validator、脱敏日志、建议缓存、失败降级和浏览器验收场景。

**门禁**：无 key/错误 URL 时安全失败；AI 无法把 `bad` 变成 recommended；输入不存在 unknown 数字；关闭 AI 开关不影响基础装机评估。

### G7：物理扩展、实测校准与全链路 QA（P2）

- 引入 GPU OBB/旋转、插头扫掠体、线材弯折半径、HBA/NIC 槽宽、电气 lane 和服务空间约束。
- 引入墙上功耗、SMART 温度、CPU/GPU 温度、噪音和风扇曲线 calibration snapshot；校准只收窄 planning range，不覆盖官方原始证据。
- 完成 9 HDD、NVMe 数、GPU 厚度、dual PSU、风扇 count、缺失字段、官方冲突、DeepSeek 降级和导入迁移的参数化浏览器测试。

**门禁**：官方/标准/规划/手工/未知证据在 UI、导出和建议中一致；预览、engine、AI 和配置清单无未解释分叉。

## 15. 现有代码的 12 个问题清单

以下问题来自当前仓库审计，全部纳入本 plan；它们不是新的功能愿望，而是后续实现时必须关闭的技术债和正确性风险。

| 编号 | 问题 | 主要位置 | 目标状态 |
|---:|---|---|---|
| 1 | V1 runtime 与 V2 engine 各自计算功耗、价格、噪音和评价，页面存在双模型 | `src/lab/v1-runtime.js`、`src/core/evaluate.ts` | 页面所有结论只读取统一 `BuildEvaluation` |
| 2 | 功耗模型有大量静态经验值，且与 SKU 已有数据重复或不一致 | `src/lab/v1-runtime.js:101`、`data/skus/catalog.json` | HDD、GPU、HBA、风扇、CPU、PSU 输入来自 catalog/workload profile |
| 3 | 双 PSU 热模型的负载、效率和上下腔位置可能取错 | `src/core/evaluate.ts`、`src/lab/v1-runtime.js:977` | primary/secondary 分别计算并放入真实 chamber |
| 4 | 缺数据时静默使用 7W、0.9、0.88、24dBA、99mm 等默认值 | `src/core/evaluate.ts`、`src/lab/view-models.ts` | fallback 变成显式 planning/unknown，并带 warning |
| 5 | 盘位、背板口、HBA port 等数量在多个地方写死为 9、4、3 | `src/wiring/plan.ts`、`src/adapters/jonsbo-n6/routing.ts`、`src/lab/v1-runtime.js` | 所有数量由 case/board capability 统一提供 |
| 6 | 风扇数量和风扇类型会被压缩成二元开关；240 冷排可能错误使用 140mm 热参数 | `geometryEnvFrom()`、`thermalEnv()`、V1 runtime | 真实 count、size、mount 和 radiator fan profile 一致 |
| 7 | 价格、已购成本和数据盘总价绕过 snapshot，使用固定 ¥629、¥2,799、¥1,380、¥4,500 和 `fixedCost` | `src/lab/v1-runtime.js`、`src/lab/view-models.ts` | 价格统一来自 SKU price/snapshot/BOM，未知不伪造 |
| 8 | 几何对象和展示标签仍硬编码 W680M、i5-14500、980 PRO 等基线型号 | `src/adapters/jonsbo-n6/geometry.ts` | 名称、尺寸和 capability 来自当前选择 SKU |
| 9 | 配置导入只校验 schemaVersion，不校验类型、范围、SKU、拓扑和 BOM | `src/config/types.ts` | 导入前完成 schema、范围、SKU 和 case capability 验证 |
| 10 | 热模型中的 derate、passive CFM、θ、spread、barrier leak 和温度阈值混在代码中 | `src/core/thermal.ts`、`src/core/thermal-field.ts`、V1 runtime | 迁移到带证据和可校准的 thermal profile |
| 11 | V2 几何与旧版概览 SVG 各自维护布局，模型和视觉可能分叉 | `src/lab/v1-runtime.js`、`src/adapters/jonsbo-n6/geometry.ts` | 概览图、等轴图、冲突图共享 `PlacedPart[]` |
| 12 | 单元测试通过不代表生成页面和浏览器交互通过；legacy 测试还存在 ESM/CJS 运行问题 | `tests/legacy-run-*.js`、package scripts | 接入 Playwright、修复测试入口并加入跨层一致性测试 |

## 16. 12 个问题的优先级映射与执行顺序

12 个问题不再作为独立的另一份计划，而是绑定到第 14 节的交付阶段：

| 优先级 | 问题编号 | 归属阶段 | 必须先解决的原因 |
|---|---:|---|---|
| P0 正确性 | 1、3、6、11、12 | G0/G1 | 双模型、双 PSU、风扇输入和视觉分叉会直接改变结论；未收敛前接入 AI 会放大错误。 |
| P1 数据化 | 2、4、5、7、8、9、10 | G2 | 硬编码和静默 fallback 会污染功耗、价格、几何和 DeepSeek 输入，必须先变成可追溯字段。 |
| P2 可信度 | 10、11、12（深化） | G7 | 热模型校准、物理约束和真实浏览器验证属于完成度提升，不能替代 P0/P1 的基础正确性。 |

### 16.1 正确依赖关系

```text
G0 基线冻结与护栏
  ├──→ G1 BuildEvaluation 单一事实源
  │       └──→ G2 capability / power / price / config 数据化
  │               └──→ G4 厂商适配器、官方直通、草稿写入
  │                       ├──→ G5 价格联动
  │                       └──→ G6 DeepSeek 建议层
  └──→ G3 搜索与官网通用采集
          └──→ G4 的官网字段输入

G7 物理扩展、实测校准、全链路 QA：G1、G2、G4、G5、G6 稳定后执行
```

G3 可以在 G1/G2 进行时并行开发，但不得绕过 G2 的 schema、capability 和 provenance 门禁写入正式 catalog。G6 可以先做协议和 mock，不得在 G1/G2 完成前接入真实建议或替代旧评价。

### 16.2 P0/P1/P2 退出标准

- **P0 退出**：同一 `BuildConfig` 的 UI 与 `evaluateBuild()` 关键结果完全一致；dual PSU、240 radiator、风扇数量和 legacy 测试均有回归证据；AI 开关关闭时基础评估可用。
- **P1 退出**：所有盘位/端口/功耗/价格/几何关键数字来自 catalog/profile/capability；无来源字段显示 unknown；配置迁移、catalog 写入和 snapshot 写入均可审计回滚。
- **P2 退出**：官方、标准、规划、手工、冲突、未知证据在页面、导出、价格和 AI 建议中一致；物理约束、实测校准和浏览器全链路结果没有未解释分叉。

### 16.3 总体完成定义

本计划只有在以下条件全部满足时才算完成：

1. 用户输入型号后，系统能返回带官方来源和字段级 provenance 的候选；exact official candidate 可安全直通，其他候选必须确认。
2. 正式 catalog、价格 snapshot、BuildEvaluation、UI、导出清单和建议输入之间使用同一 SKU/version/hash，且可以回溯或回滚。
3. 页面不再依赖旧 runtime 的写死评价；确定性 findings 与 DeepSeek 建议分区显示，AI 永远不能降低 `bad` 或制造数字。
4. `.env.local` 管理 DeepSeek key/url/model 等配置，真实密钥不进入浏览器、日志、fixture、Git 或响应。
5. 单元、集成、迁移、SSRF、安全、降级和 Playwright 场景均有自动化证据，并保留失败阶段、输入 hash 和可复现 fixture。

## 17. Review 决策登记

以下是实施前需要确认的事项；如果 review 没有另行修改，按“当前默认”执行，不因为未决偏好阻塞 G0/G1。

| 事项 | 当前默认 | 需要确认的影响 |
|---|---|---|
| 首批官方适配器 | JONSBO、ASUS、Seagate、Corsair 中先选页面稳定且覆盖基线 SKU 的 2–3 个 | 只影响 G4 范围，不改变数据模型和安全门禁 |
| 搜索提供商 | 第一阶段仅使用已有 catalog、厂商站内搜索和已知官方 URL；不新增外部搜索 API | 可降低成本和合规风险；后续可插入 provider，不改变 candidate contract |
| exact MPN 更新 | 允许自动更新非手工字段；保留旧值、content hash、provenance 和变更摘要 | 手工字段永不静默覆盖；冲突则阻断直通 |
| 手工覆盖官方字段 | 允许；新值 evidence 改为 `manual`，原官方 provenance 保留 | DeepSeek 只能引用当前生效值及其来源状态 |
| 原文证据 | 保存限长 snippet + locator；整页只进本地缓存 | 限制仓库和 LLM 输入体积，便于复核 |
| PDF 提取 | 第一阶段允许提取，但网页/PDF 并列保存；冲突不自动裁决 | 若 PDF 解析不稳定，降级为链接 + 人工确认，不阻塞网页字段 |
| DeepSeek 配置 | `.env.local`；默认 `DEEPSEEK_ENABLED=false`、`deepseek-chat`、30s 超时、1200 max tokens | 真实 key 不进浏览器、日志、fixture 或 Git |
| DeepSeek 模型选择 | 服务端先固定模型；暂不开放用户任意填写 model/url | 避免任意 endpoint/模型导致 SSRF、成本和输出契约失控 |
| AI 缓存 | 按 input hash + model + prompt version 缓存，保留 TTL 和手动刷新 | 不把建议当成事实；engine hash 变化必须重新生成 |
| AI 不可用 | 保留结构化 findings/BOM/热/接线，显示“AI 建议暂不可用” | 不恢复旧 runtime 的写死评价 |
| 正式 catalog 写入 | 默认 feature flag 关闭；先在候选/草稿文件验证，G4 门禁通过后再开放 | 任何写入都必须可审计、幂等、可回滚 |
