# PC Build Sim

Modular desktop / NAS build simulator.

**UI rule:** V2 **extends** the V1 interactive Build Lab in place — same spatial preview, thermal field, wiring, and BOM panels. No separate workbench product UI.

**Current focus (v0.2 / V2.0):** JONSBO N6 + ASUS Pro WS W680M-ACE SE + i5-14500  
**Later:** pluggable cases and general desktop builds

## V2.0 scope

1. **Exact SKU library** — concrete models; dropdown values are SKU ids from `data/skus/catalog.json`.
2. **Unified occupancy / conflict engine** — drives the existing FIT chip and wiring panel via `evaluateBuild`. Every millimetre lives in `data/cases/jonsbo-n6/geometry.json`, in one case-local frame (origin at the envelope centre; `x` right, `y` up, `z` rearward), and both the engine and the preview read it. Conflicts are **volumetric**: an overlap is a measured AABB intersection with a drawable box, not a slot-name coincidence, and `mountedOn` pairs are exempt because a cooler is supposed to interpenetrate its CPU. A `bad` verdict needs both anchors evidenced — a reconstructed anchor can only raise `warn`. Frame and per-part evidence split: `docs/PROVENANCE.md`.
3. **Full wiring plans** — per-bay paths + backplane feeds + cable checklist (same Wiring tab), plus a socket-level **PSU panel diagram**: every modular socket of the selected PSU, which cable occupies it, and which backplane inlet ends up sharing a lead or getting none. Panels are drawn only from counted evidence; uncounted groups are left blank rather than implied. Data paths respect the HBA's real port count — the ninth drive falls back to a board port instead of a port the card does not have — and Mini-SAS HD (SFF-8643) breakouts are billed separately from the board's SlimSAS (SFF-8654) cable.
   **Lower-chamber structure** (spatial preview) — tray cage, backplane PCB with its four inlets, and either the removable left fan bracket or the shipped bottom-PSU rack that replaces it, so the bottom half reads as occupied space rather than void. Shapes are planning envelopes; only the structural relationships are from the manual.
   **Air balance** (Thermal tab) — `ΔT = Q /(ρ·cp·V̇)` per chamber, so airflow is a first-class input instead of a fudge offset. Fan CFM, case impedance and drive θ are labelled planning envelopes; the bottom-PSU / drive-bay coupling is bounded, not guessed. See `docs/PROVENANCE.md` for the physics-vs-guess split.
   **Thermal field** (spatial preview) — the heatmap is sampled from that same result at the same part centroids, so a millimetre on the canvas is a millimetre in the case and every hot spot names the component behind it. It interpolates a 0D model and adds no physics: it cannot exceed its hottest source, the deck blocks diffusion unless a bottom PSU couples the chambers, and both bounds are drawn rather than the optimistic one alone. Not CFD — no velocities, no pressure drop.
   **Assembly order** (Wiring tab) — derived, not written down: the mounting tree, the corridor each part travels through on its way in (`data/cases/jonsbo-n6/assembly.json`), and the plug clearances the routing solver already found. Whatever stands in a part's corridor goes in later, which is how "install the DIMMs before an IS-55" and "swap the memory afterwards and the cooler comes off again" stop being hand-typed sentences. Rules the manual states outright stay declared with their section number and `official` evidence — §13.1 pulls the left fan bracket before wiring the backplane — because a published instruction beats any reconstruction, and that one is not derivable from the geometry.
   **Cable routing** (Wiring tab + spatial preview) — connectors are declared as a face plus an offset in `data/cases/jonsbo-n6/routing.json`, so they travel with their part when a PSU gets longer or moves to another bay. Cables are routed over a waypoint graph, which is why the deck stops a run: nothing crosses it except a declared opening. Four checks per run — insertion clearance, required length, connector orientation, blocked access — and every one caps at `warn`, because not one anchor in that file is published. The routing table lists each solved run with its ends, the openings it passes and the length it needs including 15% assembly slack; the `走线折线` toggle draws those same polylines in the isometric view, and clicking a row isolates one run.
4. **Config save / load** — export/import JSON and checklist from the Configure header.
5. **Official appearance** — gallery switches with the selected SKU; missing art stays unknown (not V2.1 3D texture mapping).

**Price:** auditable snapshots in `data/prices/` (see `docs/PRICE_SNAPSHOTS.md`).  
`npm run price:serve` starts a local-only collector; the 价格与配件 tab then fetches 京东/淘宝/拼多多/亚马逊/官网 candidates and only writes a quote after you confirm the listing. Part numbers are used where they index (京东/亚马逊/官网) and spec keywords where they don't (淘宝/拼多多). A search card quotes the listing's **cheapest** variant, so a card price is stamped as an opening price and cannot be audited — an auditable number is read from the detail page's variant table, with the option's own wording stored beside it. amazon.com prices carry a declared exchange rate and stay reference-only. `npm run price:search` emits the same links as a clickable cheat sheet; `npm run price:refresh` rebuilds `latest.json`; `npm run price:fixture` captures a real card into `tests/fixtures/` so an extraction fix stays fixed. UI stamps `snapshot YYYY-MM-DD · platform` — never invents live market or history.

Deferred to **V2.1:** price history series, measured calibration, product textures on 3D envelopes.

## Quick start

```bash
npm install
npm run dev
```

DeepSeek 建议层使用服务端环境变量管理。需要启用时，先复制模板并只在本机填写 key：

```bash
cp .env.example .env.local
# 编辑 .env.local：设置 DEEPSEEK_ENABLED=true、BUILD_SIM_ADVICE_ENABLED=true 和 DEEPSEEK_API_KEY
```

`DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL`、模型、超时、token 上限和温度都由 `.env.local` 管理。不要使用 `VITE_` 前缀，也不要把 `.env.local` 提交到 Git；浏览器只接收结构化建议结果，不会读取 key。

每次真实 provider 调用会从 DeepSeek 响应 `usage` 记录输入缓存命中、输入缓存未命中、输出、推理和总 token，并按带版本和来源的官方 CNY 单价快照计算估算费用。分时计价以请求开始时的北京时间为准：周一至周五 09:00–12:00、14:00–18:00 是高峰，其余时段（含周末全天）为空闲；每条调用记录都会保存命中的计费时段、当时单价与定价版本。页面“Token 与费用”可查看总计、分时段汇总和逐次调用明细，服务端也提供 `GET /api/advice/billing?limit=100`。审计记录不保存 key、prompt 或原始模型输出；本地 advice cache 命中不会重复计费。费用是基于 usage 的本地估算，不等同于 DeepSeek 账户余额账单。

Provider-neutral Agent 服务单独运行在 `127.0.0.1:5175`，默认关闭。启用 DeepSeek 多轮聊天时，还需在 `.env.local` 设置 `BUILD_SIM_AGENT_ENABLED=true`；然后运行：

```bash
npm run agent:serve
```

服务端提供模型/Tool/Skill 目录、持久化会话、消息运行、取消和 SSE 事件接口（`/api/agent/models`、`/api/agent/tools`、`/api/agent/skills`、`/api/agent/sessions`、`/api/agent/runs/:id/events`）。会话文件写入被 Git 忽略的 `data/agent/sessions/`，权限为当前用户读写。浏览器不会直接调用 DeepSeek，也不会接收 API key。当前已用 fixture 验证 DeepSeek SSE、多轮上下文、usage、超时和取消；没有真实 provider 响应证据时，不把 live DeepSeek 标为已验证。

首批 Agent Tool 全部只读：`get_build_evaluation`、`compare_builds`、`get_sku_facts`、`get_price_snapshot`、`search_official_catalog`、`inspect_catalog_candidate`、`search_price_candidates`。前四个直接读取服务端确定性事实；后三个只连接固定的本地价格服务 `127.0.0.1:5174`，沿用官方域名 allowlist、SSRF 防护和未审计候选语义，因此执行外部搜索时还需要同时运行 `npm run price:serve`。Tool Runtime 会校验严格 schema、限制轮次/调用数/重复调用/超时/结果体积，并把 Tool definition hash 写入事件流。

内置 Skill 位于 `skills/*/SKILL.md`：`build-diagnosis`、`upgrade-advisor`、`shopping-research`、`assembly-and-wiring`。目录接口只返回 manifest 和定义哈希；正文仅在消息请求显式传入 `skillId` 后加载进该次运行的系统上下文。Skill 的 `allowedTools` 同时限制模型可见的 Tool 定义与服务端实际派发，模型即使输出越权调用也只会得到结构化 `tool_not_allowed` 结果。

“装机预览”页包含 Provider-neutral Agent 聊天面板，可选择服务端模型与 Skill、保持多轮会话、随每条消息提交当前 BuildConfig、显示流式文本、Skill/Tool 定义哈希、结构化 Tool 结果、usage，并支持取消和新建会话。服务不可用时面板会保持禁用并明确提示，不影响确定性模拟器。`npm run agent:fixture` 只用于本地 DeepSeek SSE 协议和浏览器全链路测试，返回内容明确标注为 fixture，不能作为真实 DeepSeek 可用性证据。

Opens the N6 Build Lab. Change PSU/cooler/GPU/etc.; FIT + wiring update from the engine; appearance gallery follows SKU.

```bash
npm test
npm run build
```

## Layout

```
index.html              V1 Build Lab (primary UI)
src/lab/boot.ts         Boots catalog + engine into the lab
src/lab/v1-runtime.js   V1 interactive renderer (SKU-keyed)
src/lab/view-models.ts  SKU → display DTOs for the lab
data/skus/catalog.json  Exact SKU library (+ appearance)
data/prices/            Audited retail snapshots (latest + dated) + fx.json
scripts/price-refresh/  Snapshot rebuild + offline search cheat sheet
scripts/price-server/   Local-only price collector (APIs + headed browser, variant resolver)
data/cases/jonsbo-n6/   Case profile + geometry.json (single mm source) + routing.json + assembly.json + assets
scripts/shot.mjs        Screenshots lab panels from the dev server (local check)
src/core/               Geometry + occupancy + evaluateBuild + policy + thermal air balance & field + cable routing + assembly order
src/price/              Snapshot merge, search queries, title matching, plausibility gates
src/wiring/             Wiring plans + PSU panel socket plan
src/adapters/jonsbo-n6/ Case geometry + occupancy + routing + assembly adapters
docs/superpowers/specs/ Designs written before the code (cable routing)
legacy/v1/              Frozen V1 reference HTML
```

## Evidence policy

Never present inferred geometry, heatmaps, or planning prices as manufacturer CAD, CFD, or measured data. If evidence is missing, the UI must say `unknown`.

## Provenance

See `docs/PROVENANCE.md` and `docs/ROADMAP.md`.
