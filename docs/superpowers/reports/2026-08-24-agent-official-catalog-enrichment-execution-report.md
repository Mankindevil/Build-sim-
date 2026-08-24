# Build Sim Agent 可信官网发现与目录补齐 C0-C7 执行报告

日期：2026-08-24（Asia/Tokyo）

分支：`codex-build-sim-upgrade`

起始 HEAD：`1e4980ae73c975cf978521e5d8aba6e5da346f17`

## 已实现

| 阶段 | 本地提交 | 交付 |
|---|---|---|
| C0 | `25cbaa6` | 冻结 discovery/proposal/renderer/conflict 契约与离线 fixtures |
| C1 | `687f238` | HTTP/Playwright 最终 URL、DNS/SSRF、子请求、响应体积和失败降级安全边界 |
| C2 | `a792415` | 版本化 official-domain registry、alias/地区域名/trustStatus 治理与 catalog 全覆盖 |
| C3 | `393ddcf` | provider-neutral discovery、候选隔离、canonical 去重、失败隔离和版本化幂等键 |
| C4 | `e0f7b01` | loopback-only SearXNG JSON provider、受限查询、严格解析和 TTL cache |
| C5 | `95d250f` | DomainProposal expected-hash 决策、trusted exact-MPN draft/accept、原子备份、审计和回滚 |
| C6 | `e7124a7` | Agent proposal/enrichment Tool、A6 精确审批/幂等、shopping-research 权限和 UI 状态区分 |
| C7 | 本报告所在提交 | 真实二进制 PDF 文本层、离线闭环、浏览器 fixture、live 只读样本、全量门禁和文档 |

当前 catalog 为 37 个 SKU、21 个品牌标签。按 `appearance.page`、`price.listingUrl` 和字段级 `provenance.sourceUrl` 统计，13 个唯一官网 hostname 均命中 trusted registry，blocked=0，覆盖率 100%。Generic/Unknown 或无官网证据的品牌不会自动获得信任。

## 验证证据

### 离线与回归

- C7 新增闭环测试：exact-MPN discovery → trusted inspection → expected-hash enrichment → 临时 catalog → `BuildEvaluation` 读取 → rollback 后逐字段恢复。写入、审计和回滚全部发生在测试临时目录。
- 完整 Vitest：后续实现完成后为 43 个文件、324 项通过。
- TypeScript typecheck、浏览器 production build、Agent SSR build 通过。
- legacy model：24 个场景、85 个断言、12 个 P0，0 failure。
- legacy static：23 个断言，0 failure。
- `agent:secret-scan`：232 个文件，0 finding。
- `git diff --check`：通过。

离线矩阵覆盖 registry 命中、SearXNG 多候选/trusted 过滤/canonical 去重、错误 snippet 隔离、静态 HTML、Playwright fallback、跳出白名单、私网子请求、proposal-only、新候选补齐/回滚、冲突/重复/缺字段/超大响应，以及 SearXNG/Chromium/Provider 分层失败降级。

### 浏览器

- `npm run test:g1:browser`：通过；确定性兼容结论在交互后保持一致。
- `npm run test:g7:browser`：通过；`physicalHash=fnv1a-a73a1717`、`calibrationHash=fnv1a-df3c1119`；live Advice 关闭，未冒充真实模型响应。
- `npm run test:c7:browser`：通过；本地 fixture 在真实 Chromium UI 中分别显示 2 个搜索候选、discovery provider、待治理 proposal、官方检查/expected hash、draft 字段差异、rollback 引用和完成审计。该项证明 UI 状态表达，不是 live SearXNG/Provider 证据。

### 真实官网只读样本

以下请求均未写正式 catalog；四个样本的 HTTP 200、content type、最终 URL 和提取结果来自 2026-08-24 当次实际请求。

| 覆盖类型 | 当前 catalog 品牌与来源 | 实际观察 |
|---|---|---|
| 静态规格页 | [Thermalright AXP90-X53 FULL BLACK](https://www.thermalright.com/product/axp90-x53-full-black/) | HTTP 200，HTML 约 68,979 bytes；确定性静态抽取只得到 model，缺 exact MPN/必需字段，保持 `partial` |
| 动态规格页 | [ASUS Pro WS W680M-ACE SE](https://www.asus.com/us/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/) | HTTP 200，HTML 约 541,912 bytes；实际触发 Playwright fallback，得到 brand/model/mpn，但缺必需尺寸，保持 `partial` |
| 官方 PDF | [Seagate Exos X24 Rev. C manual](https://www.seagate.com/content/dam/seagate/assets/support/internal-hard-drive/enterprise-hard-drives/exos-x24/_shared/files/Seagate_EXOS24_CMR_ISE_SED(10-12-16-20-24TB)_Rev-C.pdf) | HTTP 200，`application/pdf`，约 1,041,236 bytes；真实二进制文本层已成功解析，但文档没有通用 extractor 接受的显式 `label: value` 行，0 字段，保持 `partial` |
| 地区域名 | [Intel 日本 i5-14500](https://www.intel.co.jp/content/www/jp/ja/products/sku/236784/intel-core-i5-processor-14500-24m-cache-up-to-5-00-ghz/specifications.html) | HTTP 200、无 redirect、最终仍为 `intel.co.jp`；registry 显式允许该地区域名，抽取 brand/model，缺 exact MPN/TDP，保持 `partial` |

这组结果只证明页面/PDF在当次网络条件下可达、安全校验和降级语义工作正常；不把页面可达等同于字段完整，也不把 `partial` 当作可自动写入。

## 数据与安全

- 正式 `data/skus/catalog.json` 自动写入：0；文件相对 C7 开始时无差异。
- C5/C7 的成功写入只发生在 `os.tmpdir()` 隔离目录，并完成 rollback；没有修改用户正式 catalog。
- discovery snippet、title、provider/rank 不进入 official fields；新域名只生成 proposal。
- write Tool 只接受 candidate id 与 expected hash；approval token 不进入 Provider message、会话、Tool input、浏览器 bundle 或持久化审计。
- PDF 原始正文、完整 HTML、Cookie、Provider key 和本地 `.env*` 未进入提交；只保留测试 fixture、字段级短 snippet/hash 和汇总证据。
- C0 前既有 env/端口修改在每个阶段均保持未暂存，不归入 C0-C7 提交。

## 未实现／未验证后续完成（同日）

### 已进一步实现并真实验证

- 增加本地 SearXNG Compose 运行时，官方多架构镜像固定为 `sha256:11a9b34cdc0b1ec2b991470a2762ecb5a1a531898289fb51dcd015260450729e`，只绑定 `127.0.0.1:8080`，JSON API 已启用，secret 运行时随机生成且不落库。
- `npm run searxng:health` 实际返回 `jsonApi=true`；`npm run searxng:smoke` 以 `JONSBO N6 site:jonsbo.com` 真实发现 5 个候选，全部仍位于 trusted `jonsbo.com` 域。SearXNG 结果仍只有 URL/title/snippet 候选权，不成为 official 字段。
- 增加扫描 PDF 的 opt-in 本地 OCR：PDF 先检查有效文本层，空白或只有页码标记时才渲染；页数、宽度、像素和单步超时均有上限，Tesseract.js 与英文语言数据固定版本并从本地读取。
- JONSBO N6 7.0 MiB 扫描手册实际处理前 3 页约 5.1 秒，OCR 平均置信度约 73.3；从明确 `Dimension: 305mm(W)*353mm(D)*318mm(H)` 和 `PCI Expansion Slot: 4` 标签产生尺寸/槽位候选。所有 OCR 字段标记为 `official-ocr-pdf`、置信度 0.7，并强制保持 `partial` 人工复核，不能直接自动接受。
- 增加 CAPTCHA、登录墙、付费墙、HTTP 401/402/403/429 的确定性检测和结构化 manual action。inspect 即使能解析出 JSON-LD，命中 barrier 仍保持 `partial`；抓取器不会携带凭据/Cookie，也没有绕过逻辑。
- 增加显式授权的 `agent:live-smoke`。真实 DeepSeek 流式适配器完成两次有界调用：8-token 首次调用验证认证、request id 和 usage，但 token 全用于 reasoning、正文为空；随后 64-token 上限调用成功，Provider 返回模型 `deepseek-v4-pro`、`end_turn`、总 token 132（reasoning 23），正文严格匹配 `LIVE_OK`。日志只输出长度与 SHA-256，不输出正文或 key。

### 仍未实现／仍未验证

- Claude live 未验证：本机没有 Claude key/enable 配置；不以 DeepSeek 成功代替 Claude 证据。
- 真实第三方站点的 CAPTCHA、登录墙、付费墙未主动触发；当前已验证的是检测、阻断和人工接管语义，不是绕过能力。验证码/登录/反爬/付费墙绕过仍明确不实现。
- 未人为制造 SearXNG 上游封禁；provider 的超时、无效 JSON、超大响应和单引擎失败仍由离线门禁覆盖。
- 未引入 Crawl4AI：现有 HTTP + Playwright 已覆盖当前真实静态/动态样本，访问控制也不应通过更换爬虫来绕过，因此没有真实必要性证据。
- 原四个 live 官网样本仍未达到自动接受门禁；新增 OCR 结果也是 `partial`，不是正式 catalog 补齐成功证明。
- `CATALOG_AUTO_ACCEPT_EXACT_MPN`、`CATALOG_WRITE_ENABLED` 默认仍关闭；`CATALOG_AUTO_TRUST_NEW_DOMAINS=true` 继续被硬拒绝。

### 后续门禁证据

- 聚焦：OCR/access-barrier、catalog search/auto-enrichment/contracts、SearXNG 共 33 项通过；完整 Vitest 43 文件、324 项通过。
- `npm run typecheck`、客户端 production build、Agent SSR build 通过。
- legacy model 24 场景、85 断言、12 个 P0，0 failure；legacy static 23 断言，0 failure。
- `npm audit --omit=dev --audit-level=high`：0 vulnerability。
- G1、G7、C7 Chromium smoke 均通过。首次并发执行因 `127.0.0.1:5176`/price service 未启动而连接失败；启动当前配置的本地服务后原断言不变并通过，未通过放宽断言绕过。
- `agent:secret-scan`：232 文件、0 finding；`git diff --check` 通过。
- 正式 catalog 新增/修改写入仍为 0；OCR 与 barrier 测试只在内存/临时 fixture 中运行。

## 失败分类与 Git

- 代码门禁失败：0。
- 外部条件未验证：Claude live、真实访问墙触发、SearXNG 上游封禁；Crawl4AI 未引入，见上文。
- Push：未授权，未推送。远端 `origin/codex-build-sim-upgrade` 保持起始 SHA `1e4980ae73c975cf978521e5d8aba6e5da346f17`；本地 C0-C7 提交领先远端。
- 回滚：每个 C0-C7 阶段为独立本地提交；数据写入另有 proposal/registry/catalog rollback manifest。
