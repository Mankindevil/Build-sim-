# 走线几何：接口锚点、穿线通路与装机顺序

日期：2026-08-22 · 状态：已批准，待实现

## 问题

`src/wiring/` 现在只有电气与拓扑：哪个盘位接到哪个口、四个背板进线口要几根独立线、九盘同时启转多少安培。一个毫米坐标都没有。所以下面这些装机时真正会卡住的问题，模型目前答不了：

- 接口朝哪边？后上置 ATX 电源正压在主板 EPS 8-pin 上方时，插头还有没有手指伸进去的空间。
- 线从哪儿穿？手册 §11 只圈出 A/B 两个理线区，没说哪根线过哪个口、隔板哪里有开口。
- 线够不够长？下置 SFX 到背板最右侧那个进线口，需要多长的外围线。
- 什么顺序装？"接背板供电要先拆左侧风扇架"这类约束现在是手写文案，不是推导结果。

上一轮已经把毫米几何收敛成单一真源（`data/cases/jonsbo-n6/geometry.json` + `src/adapters/jonsbo-n6/geometry.ts` 输出 `PlacedPart[]`），体积碰撞也真正跑起来了。走线是建在这个真源之上的下一层，不是另起一套坐标。

## 证据边界

接口坐标没有公开数据：W680M-ACE SE 的 SATA 口簇与 24pin/EPS 位置、背板四个进线口的确切位置、理线孔开口尺寸，手册与规格书都只有示意图。因此：

- 所有接口锚点与航点 `anchorEvidence: "inferred"`，逐项写 `source`。
- 走线判决上限是 `warn`，任何情况下不出 `bad`。文案统一带"锚点为按手册重建的推算值，需实物核对"。
- 目录里没有线长的线材判 `unknown`，并输出"至少需要 X mm"供采购，不猜一个数。

这与包络冲突已有的分级规则一致（见 PROVENANCE"锚点为推算故包络冲突判 warn 不判 bad"）。

## 数据模型

新增 `data/cases/jonsbo-n6/routing.json`。几何真源管实体，这个文件管连通性。三类条目：

**接口声明**挂在部件的面上，不写绝对坐标：

```json
{
  "id": "port.psu.periph.1",
  "onPart": "psu.primary",
  "face": "-z",
  "offset": [12, -18],
  "kind": "molex",
  "insertionMm": 30,
  "anchorEvidence": "inferred",
  "source": "…"
}
```

`offset` 是相对该面中心的毫米偏移，法向由 `face` 决定。换 PSU 长度、从后上 ATX 切到下置 SFX 时接口随件移动。写绝对坐标就等于再造一处会和 `geometry.json` 打架的真源，这是上一轮刚消灭掉的问题。

**航点**是穿线孔、A/B 理线区节点、隔板开口：`{ id, c, kind: "grommet" | "channel" | "deck_opening" | "free", apertureMm, anchorEvidence, source }`。

**通行边**声明哪两个航点之间可以走直线：`{ from, to, note }`。隔板上没有声明开口就没有跨腔的边，所以"这根线过不去"是图上自然得出的结论，而不是另写一条规则。

## 模块划分

`src/core/routing.ts`（与机箱无关，可独立测试）

| 导出 | 职责 |
|---|---|
| `resolvePort(part, decl)` | 面 + 偏移 → 绝对锚点 `{ at, normal, kind, insertionMm }` |
| `insertionSweep(port)` | 插拔所需扫掠体：法向 × `insertionMm`，截面按接头类型查表 |
| `buildRouteGraph(waypoints, edges)` | 航点图 |
| `routeCable(graph, a, b)` | Dijkstra 求折线，两端各接一段接口到最近合法航点的直线；返回 `{ polyline, lengthMm, viaIds }` 或 `null` |
| `requiredLengthMm(route)` | 折线长 × (1 + `SERVICE_SLACK`)，`SERVICE_SLACK = 0.15`，是一个声明出来的装配余量而非物理量 |

`src/core/geometry.ts` 补 `segmentHitsBox(a, b, box)`（线段与 AABB 的 slab 相交），与 `boxesOverlap` 并列，供阻挡检查使用。

`src/adapters/jonsbo-n6/routing.ts` 把现有 `WiringPlan` 的每一项变成 `CableRun`：`bayPaths` 的九条数据线、`backplanePower` 的四根外围线，再加 24pin、EPS、GPU 供电、风扇线、前面板。`evaluateBuild` 增加 `routing`，求值顺序在 wiring 与 geometry 之后。

`src/core/assembly.ts`（第三阶段）从 `mountedOn` 树加"遮挡边"推导装配顺序：A 的插拔扫掠体被后装的 B 吃掉，就产出"A 必须先于 B"。

## 判据

第一阶段四类，全部产出标准 `Finding`：

1. **插拔净空** `routing.insertion-blocked` — 扫掠体与其他件求交，豁免自己的父件与子件，报"被 X 吃掉 N mm"。
2. **接口朝向** `routing.needs-angled-connector` — 法向 `insertionMm` 内被挡但侧向有空间时，说"需要弯头线材"，而不是笼统 warn。
3. **线长** `routing.length-required` / `routing.length-unknown` — 折线长 + 余量 vs 目录 `attrs.lengthMm`；目录无数据判 unknown 并给出"至少需要 X mm"。
4. **阻挡** `routing.segment-blocked` / `routing.no-path` — 逐段与部件求交并点名部件；求不出路径时文案是"手册未画出该通路"，不是"装不上"。

通道截面容量与最小弯曲半径推到第二阶段：它们需要线径与厂商最小弯曲半径，目录里现在基本没有，硬做就是编数字。

## UI

接线页签增加走线表：每根线的起止接口、途经航点、需求长度、判据。等轴视图按同一投影画折线，穿线孔画成小环，被判 warn 的插拔扫掠体画成虚线面（复用 `spatial-clearance` 样式）。`spatialModel()` 已经是几何真源的瘦适配层，因此折线与结构轮廓天然对齐。

## 阶段

1. 判据：`routing.json` + `src/core/routing.ts` + 适配器 + 接入 `evaluateBuild` + 测试。
2. 可视化：走线表 + 等轴折线。
3. 装机顺序：`src/core/assembly.ts` + 测试，并把手册里那三条人工规则改为推导结果。

## 测试

`tests/routing.test.ts`

- 接口位置随 PSU 长度与安装拓扑移动（同一声明，不同 SKU，不同坐标）。
- 扫掠体方向与法向一致，且落在机箱内。
- 跨腔只能经声明的 `deck_opening`；删掉那条边后同一对接口无路径。
- 无路径产出 warn，不抛异常。
- 折线长不小于两端直线距离。
- 四根背板外围线全部有路径；下置 SFX 到最远进线口的需求长度大于机箱对角线的一半。
- 所有走线判决 `verdict` ≤ warn。

`tests/assembly.test.ts` 断言三条顺序：EPS 先于后上置 ATX 电源、背板供电先于左侧风扇架、内存先于 IS-55 散热器。

## 文档

PROVENANCE 增加"接口锚点"与"插拔净空"两节，说明这些坐标是重建值以及为什么判决只到 warn。README 与 ROADMAP 更新条目。
