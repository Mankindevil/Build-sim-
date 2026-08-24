# Build Sim Agent 官网资料自动补齐 Goal Prompt

下面内容可以直接复制给新的 Codex/Agent 作为执行 Goal。对应逐阶段计划：
[Build Sim Agent 官网资料自动补齐 Follow Plan](../plans/2026-08-24-agent-official-catalog-enrichment-follow-plan.md)

---

## 可复制 Prompt

```text
你正在 `/Users/jintingzhou/Code/build-sim` 仓库中工作。请严格按照：

docs/superpowers/plans/2026-08-24-agent-official-catalog-enrichment-follow-plan.md

执行 C0-C7，完成 Build Sim 的 Agent 官网资料自动发现、可信域名治理和 catalog 自动补齐能力。

最终 Goal：

1. 把当前写死在 `scripts/price-server/catalog/registry.mjs` 的官网白名单迁移为版本化、可验证的 registry 数据。
2. 当前 catalog 已引用的 Intel、Kingston、NVIDIA、Samsung、Seasonic、SilverStone、FSP、Thermalright 等官网必须进入 trusted registry；当前 catalog 官方 URL 的 registry 覆盖率达到 100%。
3. 建立 provider-neutral 的 CatalogDiscoveryProvider，首个外部发现 Provider 使用本地 SearXNG JSON API。
4. SearXNG 只负责“关键词/MPN → 候选 URL”；title/snippet 不能成为 official 参数。
5. 候选 URL 必须经过 trusted registry、协议、canonical/final URL、redirect、私网/DNS、响应大小、超时和去重检查，才能进入官网 inspect。
6. 加固现有 Playwright Chromium fallback：缺少类别必需字段时触发；导航后的最终 URL 重新验证；阻止私网/localhost 主文档请求；限制渲染结果大小；失败保持 partial/unknown。
7. Agent 可以根据 trusted 官网自动抓取并补齐结构化 catalog。字段必须来自确定性 HTML/JSON-LD/规格表/PDF/渲染结果，保留字段级 provenance、retrievedAt、locator/snippet、extractor 和 content hash；禁止模型常识、搜索 snippet、同系列参数或经验值填造 unknown。
8. 新域名默认只能生成 DomainProposal，不能由 Agent 在同一次执行中自行发现、自行授权并立即作为 official 写入。`CATALOG_AUTO_TRUST_NEW_DOMAINS` 必须保持 false。
9. trusted + exact MPN + canonical/final URL 合法 + 成功抓取 + 类别必需字段完整 + 无冲突 + provenance 完整时，允许在显式策略开启后审计式自动补齐；否则只能 candidate/draft/blocked。
10. 自动写入必须幂等、原子化，有旧值备份、字段 diff、registry/extractor/content hash、AuditEvent 和 rollback manifest。已有手工值或不同来源冲突不得静默覆盖。
11. `BuildEvaluation` 继续是 FIT、功耗、热、接线、BOM、价格和兼容性 verdict 的唯一事实源。Agent 可以更新版本化 catalog，再由 BuildEvaluation 重算；模型不能直接覆盖 verdict 或把 unknown 变成已知。
12. Agent Tool 必须如实声明 effect。若增加 catalog 写 Tool，必须复用现有 A6 approval envelope、idempotency、definition hash、audit 和 rollback 契约；不能把写行为伪装成 read/external-read，也不能开放任意字段写入。

开始前必须执行：

- 阅读整份 Follow Plan、`docs/agent-system-design.md`、`docs/agent-implementation-matrix.md` 和当前 catalog/search/security/write 实现。
- 检查 branch、HEAD、`git status --short` 和重叠文件 diff。
- 当前工作区已有尚未提交的 env/端口改动；必须保留并区分这些改动。不得 reset、checkout、覆盖或把无关改动混入 C 阶段。
- 复用现有 env loader 的按 key 优先级：`process.env > .env.local > .env > .env.example`；显式空值阻止下层 fallback。
- 不得读取、打印、记录或提交真实 API key、Cookie、登录会话或 `.env.local`。

执行方式：

- 严格按 C0 → C1 → ... → C7 顺序执行。
- 每阶段先写离线 fixture/测试，再实现代码。
- 每阶段运行聚焦测试和 Follow Plan 中的退出门禁。
- 每阶段完成后更新 Follow Plan 的执行记录：状态、修改、测试、未验证项和回滚位置。
- 每阶段一个独立、可回滚提交。
- 以前 A1-A7 的 push 授权不覆盖 C0-C7；除非用户在当前任务中明确授权 C 阶段 push，否则不得推送。
- 若获得 push 授权，每次 push 后用 `git ls-remote origin codex-build-sim-upgrade` 验证远端 SHA 等于本地 HEAD，再进入下一阶段。
- 任一阶段门禁失败时停止后续阶段，说明是代码失败、外部服务阻塞、未运行还是已有无关问题；不得删除测试或放宽安全边界绕过。

默认配置策略：

CATALOG_DISCOVERY_PROVIDER=registry
SEARXNG_BASE_URL=http://127.0.0.1:8080
SEARXNG_TIMEOUT_MS=10000
SEARXNG_RESULT_LIMIT=10
CATALOG_DISCOVERY_CACHE_TTL_MS=86400000
CATALOG_AUTO_ENRICH_TRUSTED_OFFICIAL=true
CATALOG_AUTO_ACCEPT_EXACT_MPN=false
CATALOG_AUTO_TRUST_NEW_DOMAINS=false

只有 C5 门禁通过且用户显式决定开启后，才把 `CATALOG_AUTO_ACCEPT_EXACT_MPN` 设为 true。不得自动开启新域名信任。

完成 C7 前必须运行：

npm test
npm run typecheck
npm run build
node tests/legacy-run-model-tests.js
node tests/legacy-run-static-tests.js
npm run test:g1:browser
npm run test:g7:browser
npm run agent:secret-scan
git diff --check

真实网络验证规则：

- 离线测试必须在无 SearXNG、无 Provider key、无互联网环境通过。
- 如果 `127.0.0.1:8080` 有可用 SearXNG，可以额外执行只读 live smoke，但必须先确认 `/search?...&format=json` 真正可用，不能根据浏览器页面或端口监听推断服务兼容。
- 真实官网样本默认只读，至少覆盖静态页、动态页、官方 PDF 和地区域名/canonical redirect。
- 验证码、登录墙、扫描 PDF、SearXNG 上游封禁、live DeepSeek/Claude 和 Crawl4AI 未验证时必须明确报告，不得用 fixture 冒充生产证据。

不在范围内：

- 验证码、登录墙、反爬或付费墙绕过。
- 自动下单、自动确认商城价格或修改用户 BuildConfig。
- 将第三方商城、论坛、评测站或 LLM 常识作为 official 参数。
- 在没有真实必要性证据时引入 Crawl4AI、Browserless 或 Firecrawl。
- 让模型任意修改 registry、catalog 或 provenance。

最终回复必须按以下结构，用中文给出可核验证据：

1. 已实现
2. 未实现
3. 当前限制
4. 验证证据：聚焦测试、全量测试、typecheck/build、legacy、browser、live SearXNG/官网、secret scan、diff check
5. 数据与安全：registry 覆盖率、自动补齐写入数、draft/conflict/blocked 数、审计和回滚演练
6. Git：branch、每阶段 commit、push 状态、远端 SHA；未获 push 授权必须写“本地完成，未推送”

不要把计划文字、fixture、接口定义、端口监听或页面截图当成已经实现的生产能力。只有代码落地并通过对应阶段门禁，才能标记“已实现”。
```

## 建议 Goal 标题

```text
实现 Build Sim Agent 可信官网发现与 catalog 自动补齐 C0-C7
```

## 建议 Goal Objective

```text
按照 docs/superpowers/plans/2026-08-24-agent-official-catalog-enrichment-follow-plan.md 完成 C0-C7：将官网白名单数据化并覆盖当前 catalog，接入 provider-neutral SearXNG URL discovery，加固 Playwright 官网渲染安全，实现 trusted exact-MPN 的可审计自动补齐与新域名 proposal 治理，接入 Agent Tool/审批边界，并通过离线、全量、浏览器、真实只读样本、审计和回滚门禁；保留现有工作区改动，未获新授权不得推送。
```
