# Build Sim Agent 官网资料自动补齐 Follow Plan

日期：2026-08-24
状态：执行中（C0 已完成）
适用仓库：`/Users/jintingzhou/Code/build-sim`
当前目标分支：`codex-build-sim-upgrade`
对应 Goal Prompt：[Agent 官网资料自动补齐 Goal Prompt](../goals/2026-08-24-agent-official-catalog-enrichment-goal-prompt.md)

这是一份可以逐项执行、逐阶段验收和独立回滚的实施计划。阶段使用 `C0-C7`，避免与已经完成的 Agent `A0-A7` 和 Build Sim `G0-G7` 混淆。

## 0. 最终目标

把当前“本地 catalog 命中，否则只返回厂商搜索链接”的官网查询能力升级为：

```text
品牌 / 型号 / 精确 MPN
        ↓
本地 catalog、缓存和可信官网 registry
        ↓ 未命中
受控发现 Provider（首个实现：SearXNG）
        ↓
可信域名过滤、canonical URL、去重和排序
        ↓
受限 HTTP/PDF 抓取
        ↓ 动态页面或必需字段不足
Playwright Chromium 渲染
        ↓
确定性字段提取、单位转换、冲突检查和字段级 provenance
        ↓
trusted + exact MPN + 必需字段完整 + 无冲突
        ├─ 满足策略：审计式自动补齐 catalog
        └─ 不满足：保留 candidate / draft，不污染正式事实
        ↓
BuildEvaluation 重新读取版本化 catalog 并保持唯一事实源
```

完成后应达到：

1. 用户不需要修改代码维护官网白名单。
2. 当前 catalog 已经引用的可信官网全部进入版本化 registry。
3. Agent 可以规划查询、调用官网搜索/检查/补齐流程，但不能从模型常识猜参数。
4. SearXNG 只负责发现 URL；搜索标题和 snippet 不能成为官方参数。
5. Playwright 只负责渲染；最终 URL、响应大小和私网访问仍受安全门禁约束。
6. 可信官网上的 exact MPN 结果可以按显式策略自动补齐；新域名默认只能进入 `proposed`。
7. 每次 catalog 变更都有字段 provenance、content hash、幂等 key、审计、备份和回滚记录。

## 1. 已确认的当前基线

### 1.1 已实现

- `scripts/price-server/catalog/service.mjs` 已有 catalog search job、已知 URL 检查、候选持久化和缓存。
- `scripts/price-server/catalog/fetch.mjs` 已有 HTTPS、受限跳转、响应大小和超时控制。
- `scripts/price-server/catalog/browser-fallback.mjs` 已有 Playwright Chromium fallback。
- `scripts/price-server/catalog/extract.mjs` 已有 JSON-LD、HTML 规格表和文本 PDF 的确定性字段提取。
- `scripts/price-server/catalog/write.mjs` 已有 official acceptance、draft、审计、原子写入和回滚。
- Agent 已有 `search_official_catalog`、`inspect_catalog_candidate` 等只读 Tool。
- `BuildEvaluation` 是装机结论的唯一确定性事实源；Agent/模型不能覆盖 verdict 或填造 unknown。

### 1.2 当前缺口

- `OFFICIAL_REGISTRY` 仍是代码常量，只有 JONSBO、ASUS、Seagate、Corsair。
- 当前 catalog 共 37 个 SKU、21 个品牌标签；其中已有 Intel、Kingston、NVIDIA、Samsung、Seasonic、SilverStone、FSP、Thermalright 官网引用，但不在 registry 中。
- catalog 未命中时只构造厂商站内搜索 URL，没有发现实际产品页。
- `source.kind === "search"` 的候选不会被检查，因此 `search_official_catalog` 还不是真正的 URL discovery。
- Chromium fallback 只在 `extracted.fields.length === 0` 时触发；抓到标题但缺少关键规格时不会触发。
- Chromium 导航完成后的 `page.url()` 没有再次执行官网 allowlist 校验。
- 当前 Agent dispatcher 不允许写 Tool；若要由 Agent 触发正式 catalog 变更，必须显式扩展现有审批/策略边界，不能把写操作伪装成只读 Tool。

### 1.3 开始执行前的工作区约束

- 当前工作区已有尚未提交的 env/端口配置改动，涉及 `.env.example`、`scripts/price-server/env.mjs`、`scripts/price-server/catalog/security.mjs`、`scripts/price-server/server.mjs`、`src/server/domain-tools.ts` 等文件。
- C0 开始前必须先检查 `git status --short` 和 `git diff -- <overlap-files>`，区分已有用户改动与本计划改动。
- 不得覆盖、回退或混入无关改动；若无法安全区分，停止并请求用户决定是否先提交当前 env 改动。
- 以前对 `A1-A7` 阶段提交的 push 授权不自动覆盖 `C0-C7`。没有新的明确授权时，只能修改、测试和准备本地提交，不得推送。

## 2. 不可破坏的边界

- Agent 可以抓取官网并补齐结构化 catalog，但不能从模型知识、搜索 snippet、同系列产品或经验值补造参数。
- 新官网域名不能由 Agent 在同一次执行中自行发现、自行授权并立即作为 official 写入。
- `trusted` 域名可进入自动补齐流程；`proposed` 域名只能保存候选与验证证据；`rejected` 域名不能抓取为官方参数。
- catalog 自动接受至少要求：可信域名、canonical/final URL 合法、成功抓取、精确 MPN、类别必需字段完整、无未解决冲突、每个字段有 provenance、content hash 存在。
- 对已有手工值或不同来源值不做静默覆盖；值不一致时必须进入 conflict/draft。
- 搜索候选、官方参数 provenance 和价格 provenance 继续分离。
- 页面 KPI、FIT、热、功耗、接线、BOM 和兼容性 verdict 继续只来自 `BuildEvaluation`。
- Provider key、SearXNG endpoint 和浏览器配置保持服务端专用，不使用 `VITE_` 前缀。
- 网络、SearXNG、Chromium 或模型失败只能让官网补齐变成 partial/unknown，不能阻塞本地模拟器。
- 所有写入必须可审计、幂等、原子化并可回滚。

## 3. 目标数据与接口

### 3.1 官网 registry

新增版本化数据文件，推荐路径：

```text
data/catalog/official-domains.json
```

建议契约：

```ts
interface OfficialDomainRegistry {
  schemaVersion: "1.0.0";
  updatedAt: string;
  brands: OfficialBrandEntry[];
}

interface OfficialBrandEntry {
  brand: string;
  aliases?: string[];
  domains: string[];
  trustStatus: "trusted" | "proposed" | "rejected";
  source: "seed" | "catalog-provenance" | "agent-proposal" | "manual";
  approvedAt?: string;
  search?: {
    kind: "site-search";
    urlTemplate: string;
  };
}
```

### 3.2 Discovery Provider

```ts
interface CatalogDiscoveryProvider {
  id: string;
  discover(input: {
    query: NormalizedModelQuery;
    allowedDomains: string[];
    limit: number;
    signal: AbortSignal;
  }): Promise<DiscoveredUrl[]>;
}
```

首批实现：

- `CatalogCacheDiscoveryProvider`
- `RegistrySearchDiscoveryProvider`
- `SearXngDiscoveryProvider`

### 3.3 Renderer

保留 provider-neutral renderer 边界，首批只实现 Playwright：

```ts
interface CatalogRenderer {
  id: "playwright" | "crawl4ai";
  render(url: string, options: RenderOptions): Promise<RenderedOfficialPage>;
}
```

Crawl4AI 只保留扩展点，不作为本计划完成门禁；只有真实动态页面样本证明现有 Playwright 不够时才接入。

### 3.4 自动补齐策略

新增服务端配置：

```dotenv
CATALOG_DISCOVERY_PROVIDER=registry
SEARXNG_BASE_URL=http://127.0.0.1:8080
SEARXNG_TIMEOUT_MS=10000
SEARXNG_RESULT_LIMIT=10
CATALOG_DISCOVERY_CACHE_TTL_MS=86400000

CATALOG_AUTO_ENRICH_TRUSTED_OFFICIAL=true
CATALOG_AUTO_ACCEPT_EXACT_MPN=false
CATALOG_AUTO_TRUST_NEW_DOMAINS=false
```

默认建议：

- 自动抓取 trusted 官网：开启。
- exact MPN 自动写正式 catalog：初始关闭，C5 门禁通过后由用户显式开启。
- 自动信任新域名：始终关闭。

所有数值配置必须通过现有 `process.env > .env.local > .env > .env.example` 按 key 合并和范围校验。

## 4. 每阶段固定执行协议

每个阶段必须执行：

1. 阅读本阶段目标、依赖和退出门禁。
2. 检查共享工作区状态，确认没有覆盖用户或前阶段未提交改动。
3. 先添加离线 fixture/测试，再实现代码；网络 live smoke 不得替代离线测试。
4. 运行阶段聚焦测试。
5. 运行完整 Vitest、typecheck、生产 build、legacy runners、secret scan 和 `git diff --check`。
6. 更新本计划对应阶段的执行记录：状态、文件、测试、未知项和回滚位置。
7. 每阶段使用一个可独立回滚的提交；只有在用户明确授权 C 阶段 push 后才能推送。
8. push 后必须用 `git ls-remote origin codex-build-sim-upgrade` 核对远端 SHA 等于本地 HEAD。
9. 任一门禁失败时停止进入下一阶段，不通过删除测试、放宽断言或把失败改成 warning 绕过。

通用验证命令：

```bash
npm test
npm run typecheck
npm run build
node tests/legacy-run-model-tests.js
node tests/legacy-run-static-tests.js
npm run agent:secret-scan
git diff --check
```

## 5. C0：契约冻结与回归基线

### 目标

把本计划涉及的 trust、discovery、renderer、enrichment 和 Agent 写边界固化成测试契约，同时保护当前 env 改动。

### 任务

- [ ] 记录开始时的 branch、HEAD、`git status --short` 和重叠文件 diff。
- [ ] 为 registry、discovery result、domain proposal、renderer result 和 enrichment result 定义 TypeScript/JSDoc 契约。
- [ ] 增加固定 fixture：trusted exact MPN、proposed domain、搜索 snippet 含错误参数、动态页面缺关键字段、官网跳转出白名单、字段冲突。
- [ ] 添加回归测试，证明搜索 snippet、模型文本和第三方页面不能成为 official field provenance。
- [ ] 记录当前 37 SKU、当前品牌集合、当前 registry 4 品牌和已引用未放行官网域名快照。
- [ ] 更新 `.env.example` 的配置设计，但保留现有 env 优先级和用户已修改的 `WEB_SERVER_PORT`。

### 聚焦验证

```bash
npx vitest run tests/catalog-search.test.ts tests/agent-tools.test.ts tests/server-env.test.ts
```

### 退出门禁

- 新契约可在无网络、无 SearXNG、无 Provider key 环境测试。
- fixture 明确区分 discovery evidence 与 official field evidence。
- 工作区已有 env 改动没有被覆盖或误归入本阶段。

### 推荐提交

```text
test(catalog): freeze official enrichment contracts
```

## 6. C1：Playwright 与官网 fetch 安全加固

### 目标

先关闭 Chromium 最终 URL 和动态页面 fallback 缺口，再扩大官网发现范围。

### 任务

- [ ] Playwright 导航完成后对 `page.url()` 重新执行 trusted domain、协议和私网检查。
- [ ] 主文档发生非 trusted 域名跳转时立即失败，不提取任何 official 字段。
- [ ] 浏览器请求拦截至少阻止 localhost、私网 IP、不安全协议和解析到私网的主文档请求。
- [ ] 对直接 fetch 与 Chromium 路径补 DNS 解析后的私网地址检查，避免只检查 hostname 字符串。
- [ ] 对渲染后 HTML 执行最大字节限制。
- [ ] 将 Playwright timeout 与现有 env loader 对齐。
- [ ] 将 fallback 条件从“0 字段”改为“0 字段或缺少该类别必需字段”；不得因只有 title/model 就跳过渲染。
- [ ] 浏览器 fallback 失败返回 partial/unknown，并保留失败原因，不伪造 HTTP 200 事实。

### 聚焦验证

```bash
npx vitest run tests/catalog-search.test.ts tests/catalog-browser-security.test.ts
```

### 退出门禁

- allowlisted → non-allowlisted 跳转被阻断。
- 公开域名 → 私网解析、localhost 子请求和超大渲染结果被阻断。
- 静态页面只抓一次；缺必需字段的动态 fixture 会触发 renderer。
- 所有失败保持 partial/unknown。

### 推荐提交

```text
fix(catalog): harden official browser fallback
```

## 7. C2：官网 registry 数据化与现有域名迁移

### 目标

让用户不再编辑代码维护白名单，并保证当前 catalog 已引用的官网不再被 registry 错误阻断。

### 任务

- [ ] 新增 `data/catalog/official-domains.json` 和严格 loader/schema 校验。
- [ ] 迁移现有 JONSBO、ASUS、Seagate、Corsair registry 数据。
- [ ] 从当前 catalog 的 committed provenance/listing/page 初始化以下 trusted 品牌和域名：Intel、Kingston、NVIDIA、Samsung、Seasonic、SilverStone、FSP、Thermalright。
- [ ] Intel 的 `intel.com` 与 `intel.co.jp` 作为两个显式域名记录，不根据字符串猜国家域名。
- [ ] 增加 Corsair/CORSAIR 等品牌 alias 和大小写规范化。
- [ ] `registryForBrand`、`registryForUrl` 和 adapter 查找改为读取数据文件。
- [ ] 拒绝重复品牌、重复域名、公共后缀、URL 而非 hostname、含协议/path 的非法 domain 条目。
- [ ] 保留 `trusted/proposed/rejected` 状态；只有 trusted 可通过 `validateOfficialUrl()`。
- [ ] 输出迁移报告：catalog 引用的官方 URL 中被 registry 阻断的数量必须降为 0。

### 聚焦验证

```bash
npx vitest run tests/catalog-registry.test.ts tests/catalog-search.test.ts
```

### 退出门禁

- 当前 catalog 已引用的所有官方 provenance/page URL 均可映射到 trusted registry。
- Generic、Unknown、无官网品牌不会被自动创建为 trusted。
- malformed/proposed/rejected 域名不能通过 official URL 校验。
- registry 修改只需要编辑版本化数据，不需要修改代码。

### 推荐提交

```text
feat(catalog): move official domains into governed registry
```

## 8. C3：Discovery Provider 抽象

### 目标

把“发现产品 URL”和“抓取/验证产品页”分离，为 SearXNG 和未来 Provider 保留稳定接口。

### 任务

- [ ] 实现 `CatalogDiscoveryProvider` registry。
- [ ] 将当前 catalog/cache 命中封装为本地 discovery provider，并保持最高优先级。
- [ ] 将厂商站内搜索 URL 封装为 registry provider；搜索页本身仍是 weak candidate，不能作为产品页。
- [ ] discovery result 只包含 title/url/snippet/provider/engine/retrievedAt/rank，不包含 official 字段。
- [ ] 所有发现 URL 在进入 inspect 前必须经过 protocol、trusted domain、canonicalization 和去重。
- [ ] job key 纳入 discovery provider id、registry version 和 query normalization version。
- [ ] provider 失败隔离，单个 provider 失败不丢失本地 catalog 命中。

### 聚焦验证

```bash
npx vitest run tests/catalog-discovery.test.ts tests/catalog-search.test.ts
```

### 退出门禁

- search job 能返回多个真实产品页候选，而不是只返回一个搜索页 URL。
- snippet 中的数字永远不会进入 extracted fields。
- 相同 canonical URL 不会形成重复 candidate。
- Provider 超时产生 warning/partial，不污染 catalog。

### 推荐提交

```text
refactor(catalog): add provider-neutral URL discovery
```

## 9. C4：SearXNG 官网发现 Provider

### 目标

通过本地 SearXNG JSON API 发现 trusted 官网产品页和官方 PDF，同时保持可离线测试与失败降级。

### 任务

- [ ] 实现 `SearXngDiscoveryProvider`，只读取固定服务端 endpoint。
- [ ] endpoint 默认 `127.0.0.1`；模型和 Tool input 不允许覆盖 endpoint。
- [ ] 查询优先使用精确 MPN，并为每个 trusted domain 生成 `site:<domain>` 约束。
- [ ] 限制查询长度、域名数、结果数、总响应大小、超时和并发。
- [ ] 严格解析 JSON schema，忽略未知字段和非法 URL。
- [ ] 结果再次按 registry 过滤；非 trusted 域名即使由 SearXNG 返回也不得进入 official inspect。
- [ ] 增加内存/落盘缓存和 TTL；缓存 key 包含 query、域名、provider 与 registry version。
- [ ] 增加 `.env.example`、README 和运行说明。
- [ ] 提供离线 SearXNG response fixtures；live smoke 仅作为附加证据。

### 聚焦验证

```bash
npx vitest run tests/searxng-discovery.test.ts tests/catalog-discovery.test.ts tests/server-env.test.ts
```

### 可选 live smoke

```bash
curl -fsS "http://127.0.0.1:${SEARXNG_PORT:-8080}/search?q=ST24000NM002H+site%3Aseagate.com&format=json"
```

live smoke 若未配置 SearXNG，应记录为“外部条件未验证”，不能算代码失败，也不能阻塞离线门禁。

### 退出门禁

- exact MPN fixture 能返回受限、去重后的 trusted 官网产品页/PDF。
- SearXNG 不可用时本地 catalog、直接 inspect 和模拟器仍可用。
- endpoint、响应或候选 URL 不能绕过 SSRF/allowlist。
- 搜索结果只保留 candidate provenance。

### 推荐提交

```text
feat(catalog): add SearXNG official URL discovery
```

## 10. C5：可信官网自动补齐与 domain proposal

### 目标

让 Agent/服务可以从 trusted 官网补齐 catalog，同时让新域名只进入可审计 proposal。

### 任务

- [ ] 实现 `DomainProposal` 数据契约、持久化、幂等、状态和审计。
- [ ] 对 SearXNG 发现但不在 registry 的品牌域名只生成 proposal；不得抓取为 official 或自动 trusted。
- [ ] proposal 保存品牌、域名、发现来源、canonical/final URL、精确 MPN 页面证据、跳转信息和建议理由。
- [ ] 增加 approve/reject 管理路径；批准一次后写入 registry，并保留旧 registry 备份和 rollback manifest。
- [ ] 实现 trusted official enrichment job：inspect → required fields → conflicts → acceptance policy。
- [ ] `CATALOG_AUTO_ENRICH_TRUSTED_OFFICIAL=true` 时允许自动生成 candidate/draft。
- [ ] `CATALOG_AUTO_ACCEPT_EXACT_MPN=true` 时，只有完整通过现有 official acceptance 门禁才写正式 catalog。
- [ ] 任何已有字段冲突进入 draft；不静默覆盖人工值或不同官方来源值。
- [ ] 每个自动写入记录 input hash、registry version、extractor version、content hash、字段 diff、审计和回滚位置。
- [ ] 重新加载 catalog 或重算 BuildEvaluation 时使用新 catalog version，不能让模型结果直接进入 evaluation。

### 聚焦验证

```bash
npx vitest run tests/catalog-domain-proposals.test.ts tests/catalog-auto-enrichment.test.ts tests/catalog-search.test.ts
```

### 退出门禁

- trusted + exact MPN + 完整字段 + 无冲突能够幂等自动补齐并成功回滚。
- proposed/rejected、模糊型号、缺字段、冲突、非 canonical、抓取失败全部不能自动接受。
- 同一 job 重试不产生重复 SKU、重复 provenance 或重复审计事件。
- 自动补齐关闭时行为退化为 candidate/draft，不影响现有系统。

### 推荐提交

```text
feat(catalog): add governed official auto enrichment
```

## 11. C6：Agent Tool、审批策略与 UI

### 目标

让 Agent 可以完整编排“搜索 → 检查 → 建议补齐”，同时如实区分只读、外部读取和写入效果。

### 任务

- [ ] 扩展 `search_official_catalog`，返回真实 discovery candidates、provider、rank、trustStatus 和 job 状态。
- [ ] 保留 `inspect_catalog_candidate` 为外部只读 Tool，只允许 trusted URL。
- [ ] 新增只读 `list_official_domain_proposals` 或等价 Tool，供 Agent 解释待确认域名。
- [ ] 若增加 `enrich_official_catalog`，必须声明 `effect: "write"`，不能伪装成 read/external-read。
- [ ] 复用 A6 approval envelope、idempotency、definition hash、audit 和 rollback 契约；不得打开任意写 Tool。
- [ ] 写 Tool input 只允许 candidate/job id 和预期 hash，不能让模型直接提交任意字段值或 URL。
- [ ] UI 展示 discovery provider、可信状态、匹配原因、字段来源、冲突、自动接受/草稿结果和回滚引用。
- [ ] UI 明确区分“搜索候选”“官方已核验”“已写 catalog”。
- [ ] Skill `shopping-research` 仅在 manifest 显式允许后看到新增 Tool；其他 Skill 不自动获得写权限。
- [ ] Agent 不可用或未审批时，手工 inspect/draft 和本地模拟器仍可用。

### 聚焦验证

```bash
npx vitest run tests/agent-tools.test.ts tests/agent-runtime.test.ts tests/agent-approval.test.ts tests/catalog-auto-enrichment.test.ts
```

### 浏览器验证

- 搜索一个本地 fixture exact MPN。
- 查看多个 discovery candidates。
- 检查 trusted 官网字段与 provenance。
- proposed 域名只显示待确认，不可自动写入。
- exact trusted candidate 在审批/策略允许时完成补齐。
- 刷新页面后状态、catalog version 和审计仍一致。

### 退出门禁

- Agent 可以编排流程，但不能扩大 trusted registry 或提交模型自造字段。
- 所有写行为都有明确 effect、策略/审批、幂等和审计。
- Tool/Skill definition hash 随契约变化而更新。
- UI 不把 candidate、draft 或搜索 snippet 展示为正式官方参数。

### 推荐提交

```text
feat(agent): orchestrate governed catalog enrichment
```

## 12. C7：全量验收、真实样本与交付

### 目标

用离线矩阵和少量真实官网样本证明发现、渲染、补齐、安全、Agent 和回滚链路完整。

### 离线验收矩阵

- [ ] 现有 catalog URL → trusted registry 命中。
- [ ] SearXNG exact MPN → 多候选 → trusted 过滤 → canonical 去重。
- [ ] 搜索 snippet 含错误数字 → 不进入 official fields。
- [ ] 静态 HTML exact MPN → 直接抽取。
- [ ] 动态 HTML 部分字段 → Playwright fallback → 补齐必需字段。
- [ ] allowlisted 初始 URL → 非白名单最终 URL → 阻断。
- [ ] 页面请求 localhost/私网 → 阻断。
- [ ] proposed 域名 → 只能 proposal/draft。
- [ ] trusted exact MPN → 自动补齐 → BuildEvaluation 可读取 → 回滚恢复旧 catalog。
- [ ] 字段冲突、重复 MPN、缺字段和超大响应 → partial/draft/blocked。
- [ ] SearXNG、Chromium、Agent Provider 分别不可用 → 本地模拟器仍可用。

### 真实只读样本

至少选择 4 个当前 catalog 已有品牌，覆盖：

- 一个静态规格页。
- 一个动态规格页。
- 一个官方 PDF。
- 一个地区域名或 canonical redirect。

真实样本默认只读，不自动写正式 catalog。只有用户明确开启自动接受且所有门禁通过时，才允许演练写入与回滚。

### 完整验证

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

### 文档交付

- [ ] 更新 README 的 SearXNG、trusted registry、自动补齐和失败降级说明。
- [ ] 更新 `docs/agent-system-design.md` 的 Tool/写入边界。
- [ ] 更新 `docs/agent-implementation-matrix.md`，只把真实通过门禁的能力列为已实现。
- [ ] 更新 `docs/PROVENANCE.md` 的自动官网字段来源规则。
- [ ] 生成 C0-C7 执行报告，列出通过、未运行、外部阻塞和代码失败。
- [ ] 记录未验证项：真实 SearXNG、验证码/登录墙、扫描 PDF、live DeepSeek/Claude、Crawl4AI。

### 退出门禁

- 全量测试、typecheck、build、legacy、浏览器 smoke、secret scan 和 diff check 通过。
- 当前 catalog 已引用官网的 registry 覆盖率为 100%。
- 离线 exact MPN discovery → inspect → enrichment → BuildEvaluation → rollback 闭环通过。
- 真实样本只报告实际观察结果，不把 fixture 当成生产证明。
- 没有密钥、Cookie、完整网页正文或用户本地环境文件进入 Git。
- 若获得 push 授权，远端分支 SHA 与本地 HEAD 一致；否则明确记录“本地完成、未推送”。

### 推荐提交

```text
test(catalog): close official enrichment delivery gates
```

## 13. 推荐提交序列

```text
test(catalog): freeze official enrichment contracts
fix(catalog): harden official browser fallback
feat(catalog): move official domains into governed registry
refactor(catalog): add provider-neutral URL discovery
feat(catalog): add SearXNG official URL discovery
feat(catalog): add governed official auto enrichment
feat(agent): orchestrate governed catalog enrichment
test(catalog): close official enrichment delivery gates
```

每个提交都必须能独立通过对应门禁并独立回滚。不要把当前尚未提交的 env 改动偷偷归入 C 阶段；若它们是 C0 前置，应先由用户决定是否单独提交。

## 14. 明确不在本计划范围内

- 不实现验证码、登录墙、反爬或付费墙绕过。
- 不让 Agent 自动下单、确认价格或修改用户 BuildConfig。
- 不把搜索 snippet、商城标题、论坛、评测站或 LLM 常识写成 official 参数。
- 不承诺 SearXNG 上游永不封禁。
- 不在缺少真实必要性证据时引入 Crawl4AI、Browserless 或 Firecrawl。
- 不把真实 DeepSeek/Claude API 调用作为本计划的离线门禁。
- 不自动信任未知域名或未经确认的经销商/区域代理站。

## 15. 最终交付报告模板

```markdown
## 已实现

- C0 ...

## 未实现

- ...

## 当前限制

- ...

## 验证证据

- 聚焦测试：...
- 全量 Vitest：...
- typecheck/build：...
- legacy/browser：...
- live SearXNG/官网：...
- secret scan/diff check：...

## 数据与安全

- Registry 覆盖：...
- 自动补齐写入：...
- 审计/回滚：...
- 未进入 Git 的敏感数据：...

## Git

- Branch：...
- Commits：...
- Push：已推送 / 未授权 / 失败
- Remote SHA：...
```

## 16. 执行记录

### C0（2026-08-24）

- 状态：已完成。
- 基线：分支 `codex-build-sim-upgrade`，开始 HEAD `1e4980ae73c975cf978521e5d8aba6e5da346f17`；确认 22 个既有 env/端口相关修改并从 C 阶段精确暂存中排除。
- 数据快照：37 个 SKU、21 个品牌标签、代码内 registry 4 个品牌；catalog 引用 13 个唯一官网 hostname，其中 Intel、Kingston、NVIDIA、Samsung、Seasonic、SilverStone、FSP、Thermalright 尚未进入旧 registry。
- 修改：新增 provider-neutral contract、discovery/official evidence 隔离断言，以及 trusted exact MPN、proposed domain、误导 snippet、动态缺字段、跳出白名单、字段冲突 fixtures。
- 聚焦测试：`catalog-enrichment-contracts`、`catalog-search`、`agent-tools`、`server-env` 共 26 项通过。
- 全门禁：完整 Vitest 34 文件/284 项、typecheck、build、legacy model 85 assertions、legacy static 23 assertions、secret scan 207 files/0 findings、`git diff --check` 均通过。
- 未验证：本阶段无网络验证；fixtures 只证明离线契约。
- 回滚：回滚本阶段独立提交；不影响开始前既有 env/端口改动。

### C1（2026-08-24）

- 状态：已完成。
- 修改：直接 fetch 与 Playwright 路径均增加 DNS 解析后私网阻断；Chromium 主文档请求与导航后最终 URL 重新执行 trusted/HTTPS/DNS 校验；私网或不安全子请求、超大渲染结果被阻断；缺类别必需字段即触发 renderer，失败保留静态字段并标记 partial。
- 聚焦测试：`catalog-search`、`catalog-browser-security` 共 18 项通过，覆盖 allowlisted 跳出、DNS rebinding、localhost 子请求、渲染大小、fallback 条件与失败降级。
- 全门禁：完整 Vitest 35 文件/289 项、typecheck、build、legacy model/static、secret scan 208 files/0 findings、`git diff --check` 均通过。
- 未验证：未访问真实动态官网；Playwright 安全行为使用离线 fake module 验证。
- 回滚：回滚本阶段独立提交；`catalog/security.mjs` 中 C0 前既有 env limits hunk 未纳入本提交。

### C2（2026-08-24）

- 状态：已完成。
- 修改：新增 `data/catalog/official-domains.json`、严格同步 loader/schema/hash；迁移 4 个 seed 品牌并加入 Intel、Kingston、NVIDIA、Samsung、Seasonic、SilverStone、FSP、Thermalright；Intel 的 `.com`/`.co.jp` 显式列出；alias/大小写、trustStatus 与 malformed/public-suffix/重复治理已生效。
- 数据：37 个 SKU、21 个品牌标签；catalog 引用 13 个唯一官网 hostname，blocked=0，registry 覆盖率 100%。Generic/Unknown/无官网品牌未自动 trusted。
- 聚焦测试：`catalog-registry`、`catalog-search` 共 20 项通过。
- 全门禁：完整 Vitest 36 文件/296 项、typecheck、build、legacy model/static、secret scan 210 files/0 findings、`git diff --check` 均通过。
- 未验证：registry 来源为当前 committed catalog provenance/listing/page 迁移；本阶段未重新抓取这些官网。
- 回滚：回滚本阶段独立提交恢复代码常量；版本化 registry 文件随提交一并移除。

### C3（2026-08-24）

- 状态：已完成。
- 修改：新增 `CatalogDiscoveryRegistry`、`CatalogCacheDiscoveryProvider`、`RegistrySearchDiscoveryProvider`；discovery result 只保留 URL/title/snippet/provider/engine/retrievedAt/rank；trusted/HTTPS/canonical/去重在 inspect 前执行；provider 失败隔离；job key/记录包含 provider ids、registry version 与 query normalization version。
- 聚焦测试：`catalog-discovery`、`catalog-search` 共 17 项通过，覆盖多产品候选、非 trusted 过滤、canonical 去重、snippet 隔离、provider failure 降级和版本化幂等键。
- 全门禁：完整 Vitest 37 文件/300 项、typecheck、build、legacy model/static、secret scan 212 files/0 findings、`git diff --check` 均通过。
- 未验证：C3 只有本地 catalog/registry provider 和离线 fixture provider；真实 URL discovery 留到 C4 SearXNG。
- 回滚：回滚本阶段独立提交恢复原 service 内发现逻辑。

### C4（2026-08-24）

- 状态：已完成（离线）；live SearXNG 外部未验证。
- 修改：新增只读 `SearXngDiscoveryProvider`；endpoint 仅允许服务端固定 loopback HTTP；exact MPN + per-domain `site:` 查询；限制 query/domain/result/响应大小/超时/并发；严格 JSON 解析；内存/原子落盘 TTL 缓存 key 包含 provider/query/domain/registry version；默认 provider 仍为 `registry`。
- 聚焦测试：`searxng-discovery`、`catalog-discovery`、`server-env` 共 10 项通过；错误 snippet 只保留 candidate evidence，非 trusted URL 在 inspect 前阻断。
- 全门禁：完整 Vitest 38 文件/304 项、typecheck、build、legacy model/static、secret scan 215 files/0 findings、`git diff --check` 均通过。
- Live：`curl http://127.0.0.1:8080/search?...&format=json` 连接失败（exit 7），本机没有可用 SearXNG；未把端口或 fixture 当作 live 证据。
- 回滚：回滚本阶段独立提交；默认配置本就不会启用 SearXNG。
