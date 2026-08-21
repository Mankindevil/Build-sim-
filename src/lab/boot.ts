import { loadBundledCatalog, requireSku, bundledPriceSummary } from "../sku/catalog";
import { evaluateBuild, type BuildEvaluation, type ThermalEnv } from "../core/evaluate";
import { EVIDENCE_LABELS } from "../core/evidence";
import { sampleSlice, type FieldBounds, type SlicePlane } from "../core/thermal-field";
import { N6_DECK_Y, N6_ENVELOPE_BOX, N6_INTERIOR_BOX } from "../adapters/jonsbo-n6/geometry";
import {
  downloadText,
  exportChecklist,
  parseConfig,
  serializeConfig,
} from "../config/io";
import type { BuildConfig, BootMode, HbaMode, PsuTopology } from "../config/types";
import { buildLabCatalogs } from "./view-models";
import { formatSnapshotStamp } from "../price/types";
import { applyPriceSnapshot, snapshotSummary } from "../price/merge";
import { buildSkuSearchLinks, pickOfficialUrl } from "../price/search";
import { getLocalSnapshot, initPricePanel, updatePriceCatalog } from "./price-panel";
import { planPanelWiring } from "../wiring/panel";
import { boardSataPorts, boardStorage, nativeSataCeiling } from "../core/policy";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";
import v1RuntimeUrl from "./v1-runtime.js?url";

let catalog = loadBundledCatalog();
const views = buildLabCatalogs(catalog);
let priceStamp = bundledPriceSummary();

const BOARD_ID = "board.asus-w680m-ace-se";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function val(id: string): string {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
  return el?.value ?? "";
}

function configFromDom(): BuildConfig {
  const topo = (val("psu-position") || "auto") as PsuTopology;
  const boot = (val("boot-select") || "bay") as BootMode;
  const hbaMode = (val("hba-select") || "auto") as HbaMode;
  const config: BuildConfig = {
    schemaVersion: "2.0.0",
    id: "live-from-lab",
    name: "N6 Build Lab live",
    updatedAt: new Date().toISOString().slice(0, 10),
    caseId: "case.jonsbo-n6",
    boardId: BOARD_ID,
    cpuId: "cpu.i5-14500",
    selection: {
      psuId: val("psu-select"),
      psuTopology: topo,
      coolerId: val("cooler-select"),
      gpuId: val("gpu-select") === "custom" ? "gpu.none" : val("gpu-select"),
      memoryId: val("ram-select"),
      diskCount: Number(val("disk-range") || "1"),
      diskSkuId: n6Profile.defaults.diskSkuId,
      nvmeCount: Number(val("nvme-select") || String(n6Profile.defaults.ownedNvmeQty)),
      boot,
      hbaMode,
      hbaSkuId: hbaMode === "always" ? n6Profile.hba.defaultSkuId : null,
    },
    bom: [],
  };
  if (topo === "dual") {
    config.selection.secondaryPsuId = val("secondary-psu-select");
    config.selection.dualStart = val("dual-start-select") === "sync" ? "sync" : "none";
  }
  return config;
}

function applyConfigToDom(config: BuildConfig): void {
  const set = (id: string, value: string) => {
    const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) el.value = value;
  };
  set("psu-select", config.selection.psuId);
  set("psu-position", config.selection.psuTopology);
  set("cooler-select", config.selection.coolerId);
  set("gpu-select", config.selection.gpuId);
  set("ram-select", config.selection.memoryId);
  set("disk-range", String(config.selection.diskCount));
  if (config.selection.nvmeCount) set("nvme-select", String(config.selection.nvmeCount));
  set("boot-select", config.selection.boot);
  set("hba-select", config.selection.hbaMode);
  if (config.selection.secondaryPsuId) set("secondary-psu-select", config.selection.secondaryPsuId);
  if (config.selection.dualStart) set("dual-start-select", config.selection.dualStart);
}

function evidenceLabel(level: keyof typeof EVIDENCE_LABELS): string {
  return EVIDENCE_LABELS[level];
}

function updateFitFromEngine(result: ReturnType<typeof evaluateBuild>): void {
  const chip = $("fit-chip");
  if (!chip) return;
  const worst = result.occupancy.verdict;
  chip.setAttribute("data-level", worst === "ok" ? "ok" : worst);
  const top = result.findings[0];
  if (!top) {
    chip.textContent = "兼容：引擎未发现冲突";
    return;
  }
  chip.textContent = `${worst === "ok" ? "兼容" : worst === "warn" ? "警告" : "冲突"}：${top.message}`;

  const list = $("verdict-list");
  if (list) {
    list.innerHTML = result.findings
      .slice(0, 8)
      .map(
        (f) =>
          `<li><b>${f.verdict}</b> · ${evidenceLabel(f.evidence)} — ${f.message}</li>`,
      )
      .join("");
  }
}

function updateWiringFromEngine(result: ReturnType<typeof evaluateBuild>): void {
  const portMap = $("port-map");
  if (portMap) {
    const targetZh: Record<string, string> = {
      hba: "HBA",
      slimsas: "主板 SlimSAS",
      sata: "主板 SATA",
    };
    portMap.innerHTML = result.wiring.bayPaths
      .map((b) => {
        const empty = b.portLabel === "—";
        // `none` already reads as a sentence; prefixing it with a port kind would stutter.
        const label = empty
          ? "空托架"
          : b.target === "none"
            ? b.portLabel
            : `${targetZh[b.target] ?? b.target} · ${b.portLabel}`;
        return `<div class="port-card" data-target="${empty ? "empty" : b.target}"><b>Bay ${b.bayIndex}</b><span>${label}</span><small>${evidenceLabel(b.evidence)}${b.note ? " — " + b.note : ""}</small></div>`;
      })
      .join("");
  }
  const notes = $("wiring-notes");
  if (notes) {
    const warns = result.wiring.warnings;
    const checks = result.wiring.checklist
      .filter((c) => c.requiredQty > 0)
      .map((c) => `${c.requiredQty}× ${c.label}（${evidenceLabel(c.evidence)}）`);
    notes.textContent = [...warns, ...checks].join(" · ") || "接线清单已按当前选型生成";
  }
  const badge = $("controller-badge");
  if (badge) {
    const hba = result.wiring.bayPaths.some((b) => b.target === "hba");
    badge.textContent = hba ? "需要 HBA / 扩展" : "主板原生路径";
  }
}

/** Engine-owned backplane harness audit; overrides the legacy runtime's own text. */
function updateBackplaneHarness(wiring: ReturnType<typeof evaluateBuild>["wiring"]): void {
  const check = wiring.backplaneHarness;
  const psuName = catalog.skus.find((s) => s.id === check.feedPsuId)?.name ?? check.feedPsuId;
  const role = check.feedRole === "backplane-dedicated" ? "背板专供" : "主电源";

  const count = $("harness-count");
  if (count) {
    const leads =
      check.verdict === "unknown"
        ? "线数未锁定"
        : `SATA ${check.confirmed.sata}/${check.required.sata} · Molex ${check.confirmed.molex}/${check.required.molex}`;
    count.innerHTML = `${role}<br><b>${psuName}</b><br>${leads}`;
  }

  const callout = $("harness-warning");
  if (callout) {
    callout.dataset.level = check.verdict === "ok" ? "ok" : check.verdict === "bad" ? "bad" : "warn";
    callout.textContent = `${evidenceLabel(check.evidence)} · ${check.notes.join(" ")}`;
  }

  const seen: Record<string, number> = { sata: 0, molex: 0 };
  for (const feed of wiring.backplanePower) {
    seen[feed.connector] = (seen[feed.connector] ?? 0) + 1;
    const have = check.confirmed[feed.connector];
    const covered = have !== null && have >= (seen[feed.connector] ?? 0);
    const wire = document.querySelector<HTMLElement>(`.wire-${feed.inletIndex}`);
    if (wire) wire.dataset.missing = String(!covered);
  }

  const rear = $("rear-harness-text");
  if (rear) {
    rear.textContent =
      check.verdict === "unknown"
        ? `${psuName} · 独立线数未锁定`
        : `${psuName} · SATA ${check.confirmed.sata} + Molex ${check.confirmed.molex}`;
  }
}

/**
 * Socket-by-socket diagram of the PSU panel. Drawn from `planPanelWiring` so the
 * picture and the audit can never disagree: a chained lead and an inlet with no
 * lead at all are two visibly different failures.
 */
function updatePanelWiring(config: BuildConfig): void {
  const host = $("panel-wiring");
  if (!host) return;
  const plan = planPanelWiring(config, catalog);
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const SOCKET_W = 30;
  const SOCKET_H = 20;
  const PER_ROW = 3;
  const at = new Map<string, { x: number; y: number }>();
  let svg = "";
  let y = 58;

  const groups = [...new Set(plan.sockets.map((s) => s.group))];
  for (const g of groups) {
    const inGroup = plan.sockets.filter((s) => s.group === g);
    svg += `<text class="pw-group-label" x="36" y="${y}">${esc(inGroup[0]?.groupLabel ?? g)}</text>`;
    y += 10;
    inGroup.forEach((s, i) => {
      const col = i % PER_ROW;
      const row = Math.floor(i / PER_ROW);
      const x = 36 + col * (SOCKET_W + 8);
      const sy = y + row * (SOCKET_H + 6);
      at.set(s.id, { x: x + SOCKET_W, y: sy + SOCKET_H / 2 });
      svg += `<rect class="pw-socket" data-state="${s.cableId ? "used" : "free"}" x="${x}" y="${sy}" width="${SOCKET_W}" height="${SOCKET_H}" rx="3"><title>${esc(s.id)} · ${s.pins}pin · ${s.cableId ? "已占用" : "空位"}</title></rect>`;
      svg += `<text class="pw-socket-label" x="${x + SOCKET_W / 2}" y="${sy + 13.5}" text-anchor="middle">${s.pins}</text>`;
    });
    y += Math.ceil(inGroup.length / PER_ROW) * (SOCKET_H + 6) + 10;
  }
  // Explain leftover frame area: an uncounted group must not read as empty sockets.
  if (plan.panelKnown && !groups.includes("cpu-pcie")) {
    svg += `<text class="pw-caption" x="36" y="${y + 4}">其余分组（主板 / CPU / PCIe）未逐座点数，故不绘制</text>`;
    y += 16;
  }
  const panelH = Math.max(y - 20, 120);

  // Loads: backplane inlets first (they carry the constraint), then board rails.
  const byId = new Map(plan.cables.map((c) => [c.id, c]));
  type Load = { label: string; sub: string; cableId: string | null; state: string };
  const loads: Load[] = plan.inlets.map((i) => ({
    label: `背板口 ${i.index} · ${i.connector === "sata" ? "SATA PWR" : "Molex"}`,
    sub:
      i.cableId === null
        ? "无线可接"
        : `${byId.get(i.cableId)?.label ?? i.cableId}${i.shared ? "（与相邻口串接）" : "（独立线）"}`,
    cableId: i.cableId,
    state: i.cableId === null ? "unmet" : i.shared ? "shared" : "ok",
  }));
  for (const c of plan.cables) {
    if (c.kind === "sata" || c.kind === "molex") continue;
    loads.push({
      label: c.targets[0] ?? c.label,
      sub: c.socketId ? `${c.label} · ${c.connectors} 头` : `${c.label} · 无插座可插`,
      cableId: c.id,
      state: c.socketId ? "ok" : "unmet",
    });
  }

  const LOAD_X = 430;
  const LOAD_W = 262;
  const PITCH = 34;
  let links = "";
  loads.forEach((l, i) => {
    const ly = 40 + i * PITCH;
    svg += `<rect class="pw-load" data-state="${l.state}" x="${LOAD_X}" y="${ly}" width="${LOAD_W}" height="28" rx="4"/>`;
    svg += `<text class="pw-load-label" x="${LOAD_X + 10}" y="${ly + 12}">${esc(l.label)}</text>`;
    svg += `<text class="pw-load-sub" x="${LOAD_X + 10}" y="${ly + 23}">${esc(l.sub)}</text>`;
    const from = l.cableId ? at.get(byId.get(l.cableId)?.socketId ?? "") : undefined;
    if (from) {
      const my = ly + 14;
      const mid = (from.x + LOAD_X) / 2;
      links += `<path class="pw-link" data-state="${l.state}" d="M${from.x} ${from.y} C${mid} ${from.y} ${mid} ${my} ${LOAD_X} ${my}"/>`;
    }
  });

  const height = Math.max(40 + loads.length * PITCH + 20, panelH + 40);
  host.innerHTML =
    `<svg viewBox="0 0 720 ${height}" role="img" aria-label="电源模组插座到负载的接线图">` +
    `<rect class="pw-frame" x="24" y="34" width="268" height="${panelH}" rx="6"/>` +
    `<text class="pw-title" x="24" y="26">${esc(plan.psuName)}${plan.panelKnown ? "" : "（面板未点数）"}</text>` +
    `<text class="pw-caption" x="${LOAD_X}" y="26">负载 / 背板进线口</text>` +
    links +
    svg +
    "</svg>";

  const badge = $("panel-wiring-badge");
  if (badge) {
    badge.textContent = plan.panelKnown
      ? `插座布局 ${evidenceLabel(plan.evidence)} · 外围空位 ${plan.freeSockets.filter((s) => s.group === "peripheral").length}`
      : "插座布局未点数";
  }
  const notes = $("panel-wiring-notes");
  if (notes) {
    notes.dataset.level = plan.unmet.length > 0 ? "bad" : plan.panelKnown ? "ok" : "warn";
    notes.textContent = [...plan.unmet, ...plan.notes].join(" · ");
  }
}

/** Air-balance readout. Shows ranges, never a single confident temperature. */
function updateAirBalance(result: ReturnType<typeof evaluateBuild>): void {
  const host = $("air-balance");
  const thermal = result.thermal;
  if (!host || !thermal) return;
  const r1 = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "∞");
  const range = (lo: number, hi: number, unit: string): string =>
    Math.abs(hi - lo) < 0.05 ? `${r1(lo)}${unit}` : `${r1(lo)}–${r1(hi)}${unit}`;

  const cells: string[] = [];
  for (const ch of [thermal.chambers.lower, thermal.chambers.upper]) {
    // A chamber with no fan is running on leakage alone; that is the headline, not the ΔT.
    const level = !ch.fanned ? "bad" : ch.riseK.hi > 12 ? "warn" : "ok";
    cells.push(
      `<div class="air-cell" data-level="${level}"><h4>${ch.label}${ch.fanned ? "" : " · 无风扇"}</h4><dl>` +
        `<dt>热负荷</dt><dd>${range(ch.loadW.lo, ch.loadW.hi, "W")}</dd>` +
        `<dt>估算风量</dt><dd>${range(ch.cfm.lo, ch.cfm.hi, " CFM")}</dd>` +
        `<dt>空气温升</dt><dd>${range(ch.riseK.lo, ch.riseK.hi, "K")}</dd>` +
        `<dt>出风温度</dt><dd>${range(ch.outletC.lo, ch.outletC.hi, "°C")}</dd>` +
        "</dl></div>",
    );
  }
  cells.push(
    `<div class="air-cell" data-level="${thermal.hddC.hi > 50 ? "bad" : thermal.hddC.hi > 45 ? "warn" : "ok"}"><h4>硬盘壳温</h4><dl>` +
      `<dt>区间</dt><dd>${range(thermal.hddC.lo, thermal.hddC.hi, "°C")}</dd>` +
      `<dt>环境</dt><dd>${thermal.ambientC}°C</dd>` +
      `<dt>整体证据</dt><dd>${evidenceLabel(thermal.evidence)}</dd>` +
      "</dl></div>",
  );
  if (thermal.psuInletC && thermal.coupling.active) {
    cells.push(
      `<div class="air-cell" data-level="warn"><h4>下置电源共腔</h4><dl>` +
        `<dt>进气温度</dt><dd>${range(thermal.psuInletC.lo, thermal.psuInletC.hi, "°C")}</dd>` +
        `<dt>自身废热</dt><dd>${r1(thermal.coupling.psuWasteW)}W</dd>` +
        `<dt>占下层负荷</dt><dd>${Math.round(thermal.coupling.shareOfLowerLoad * 100)}%</dd>` +
        `<dt>最坏额外温升</dt><dd>+${r1(thermal.coupling.extraRiseK)}K</dd>` +
        "</dl></div>",
    );
  }
  host.innerHTML = cells.join("");

  const badge = $("air-balance-badge");
  if (badge) badge.textContent = `整体证据 ${evidenceLabel(thermal.evidence)} · 非 CFD`;

  const notes = $("air-balance-notes");
  if (notes) {
    const bad = result.findings.filter(
      (f) => f.id.startsWith("thermal.") && f.verdict === "bad",
    );
    notes.dataset.level = bad.length > 0 ? "bad" : thermal.chambers.lower.fanned ? "ok" : "warn";
    notes.textContent = [...bad.map((f) => f.message), ...thermal.notes].join(" ");
  }

  const assume = $("air-assumptions");
  if (assume) {
    assume.innerHTML = thermal.assumptions
      .map(
        (a) =>
          `<div class="air-assume-row"><b>${a.label}</b><span>${a.value}</span><em>${evidenceLabel(a.evidence)}</em><small>${a.note}</small></div>`,
      )
      .join("");
  }
}

function updateGalleryFromSkus(config: BuildConfig): void {
  const gallery = $("product-gallery");
  if (!gallery) return;

  const cards: { name: string; status: string; skuId: string; note?: string }[] = [
    { name: "JONSBO N6", status: "已购", skuId: config.caseId },
    { name: "ASUS W680M-ACE SE", status: "已购", skuId: config.boardId },
    { name: "Intel Core i5-14500", status: "已购", skuId: config.cpuId },
    { name: requireSku(catalog, config.selection.memoryId).name, status: "待购", skuId: config.selection.memoryId },
    { name: "Samsung 980 PRO ×2", status: "已有", skuId: "storage.samsung-980-pro" },
    { name: requireSku(catalog, config.selection.psuId).name, status: "待购", skuId: config.selection.psuId },
    { name: requireSku(catalog, config.selection.coolerId).name, status: "待购", skuId: config.selection.coolerId },
    {
      name: `${requireSku(catalog, config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId).name} ×${config.selection.diskCount}`,
      status: "待购",
      skuId: config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId,
    },
    {
      name: requireSku(catalog, config.selection.gpuId).name,
      status: config.selection.gpuId === "gpu.none" ? "暂不安装" : "未来",
      skuId: config.selection.gpuId,
    },
  ];

  gallery.innerHTML = cards
    .map((card) => {
      const sku = catalog.skus.find((s) => s.id === card.skuId);
      const ref = sku?.appearance;
      const snap = sku?.price.snapshot;
      const priceBit = snap
        ? ` · ¥${sku?.price.current} (${formatSnapshotStamp(snap)})`
        : typeof sku?.price.current === "number"
          ? ` · ¥${sku.price.current}`
          : typeof sku?.price.paid === "number"
            ? ` · 成交 ¥${sku.price.paid}`
            : " · 价 unknown";
      const searchLinks = sku
        ? buildSkuSearchLinks(sku, pickOfficialUrl(sku))
            .map(
              (l) =>
                `<a href="${l.url}" target="_blank" rel="noreferrer" title="搜索词：${l.query}">${l.label}</a>`,
            )
            .join(" · ")
        : "";
      const visual =
        ref?.image
          ? `<img src="${ref.image}" alt="${card.name} 厂商官方产品图" loading="lazy"><div class="product-placeholder">图片未加载；可打开官方页</div>`
          : `<div class="product-placeholder">${ref?.note ?? "尚无对应官方缓存图"}</div>`;
      const missing = ref?.image ? "false" : "true";
      const link = ref?.page
        ? `<a href="${ref.page}" target="_blank" rel="noreferrer">查看厂商官方页</a>`
        : "";
      const searchRow = searchLinks
        ? `<small class="price-search-links">搜料号：${searchLinks}</small>`
        : "";
      return `<article class="product-card"><div class="product-visual" data-missing="${missing}">${visual}</div><div class="product-card-body"><b>${card.name}</b><span>${card.status}${priceBit}</span><small>${ref?.note ?? card.note ?? "精确 SKU 外观卡"}</small>${link}${searchRow}</div></article>`;
    })
    .join("");

  gallery.querySelectorAll(".product-visual img").forEach((img) => {
    img.addEventListener("error", () => {
      (img.parentElement as HTMLElement).dataset.missing = "true";
    });
  });
}

function updatePriceStamp(): void {
  const note = $("kpi-price-note");
  if (!note) return;
  if (priceStamp.asOf && priceStamp.auditedCount > 0) {
    note.textContent = `不含未来 GPU · snapshot ${priceStamp.asOf} · ${priceStamp.auditedCount} 条审计报价`;
  } else {
    note.textContent = "不含未来 GPU · 价格快照尚未审计（unknown）";
  }
}

/**
 * Re-apply the locally audited quotes without a page reload. The legacy runtime
 * captured `views.psus` etc. by reference, so the maps are refilled in place.
 */
function reapplyLocalPrices(): void {
  const overlay = getLocalSnapshot();
  const base = loadBundledCatalog();
  catalog = overlay ? applyPriceSnapshot(base, overlay) : base;
  priceStamp = overlay ? snapshotSummary(overlay) : bundledPriceSummary();

  const next = buildLabCatalogs(catalog);
  for (const key of ["psus", "coolers", "gpus", "rams", "officialProducts"] as const) {
    const target = views[key] as Record<string, unknown>;
    const source = next[key] as Record<string, unknown>;
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, source);
  }
  updatePriceCatalog(catalog);
  window.__N6_LAB_API__?.render();
}

/**
 * One evaluation per render. The legacy runtime calls this at the *top* of its
 * render pass and passes the result back into `afterRender`, so the KPI strip and
 * the air-balance card are reading the same numbers from the same run.
 */
function evaluate(env?: ThermalEnv): BuildEvaluation {
  return evaluateBuild(configFromDom(), catalog, env);
}

function afterRender(result?: BuildEvaluation, env?: ThermalEnv): void {
  const evaluation = result ?? evaluate(env);
  updateFitFromEngine(evaluation);
  updateWiringFromEngine(evaluation);
  updateBackplaneHarness(evaluation.wiring);
  updatePanelWiring(evaluation.config);
  updateAirBalance(evaluation);
  updateGalleryFromSkus(evaluation.config);
  updatePriceStamp();
}

function bindConfigChrome(): void {
  $("cfg-export-json")?.addEventListener("click", () => {
    const config = configFromDom();
    downloadText(`${config.id}.json`, serializeConfig(config));
  });
  $("cfg-export-checklist")?.addEventListener("click", () => {
    const config = configFromDom();
    const result = evaluateBuild(config, catalog);
    downloadText(`${config.id}-checklist.md`, exportChecklist(config, result.bom));
  });
  $("cfg-import-json")?.addEventListener("change", async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const config = parseConfig(text);
    applyConfigToDom(config);
    window.__N6_LAB_API__?.render();
  });
}

declare global {
  interface Window {
    __N6_LAB__?: {
      psus: typeof views.psus;
      coolers: typeof views.coolers;
      gpus: typeof views.gpus;
      rams: typeof views.rams;
      officialProducts: typeof views.officialProducts;
      profile: typeof n6Profile;
      /** Board storage facts, so the runtime never restates a count the SKU owns. */
      boardStorage: ReturnType<typeof boardStorage>;
      /** SATA ceiling once NVMe drives have claimed their slots. */
      sataCeiling: (nvmeCount: number) => number;
      priceSnapshot: ReturnType<typeof bundledPriceSummary>;
      /** Runs the V2 engine for the current DOM config. Pure and synchronous. */
      evaluate: (env?: ThermalEnv) => BuildEvaluation;
      /** Millimetre-registered slice of the heat field, for the 2D canvas. */
      thermalSlice: (
        field: FieldBounds,
        plane: SlicePlane,
        offsetMm: number,
        extentMm: [number, number, number, number],
        gridMm: number,
      ) => ReturnType<typeof sampleSlice>;
      /** Case frame constants, so the runtime keeps no millimetre copies. */
      caseGeometry: {
        envelope: { w: number; h: number; d: number };
        interior: { c: [number, number, number]; w: number; h: number; d: number };
        deckY: number;
      };
      afterRender: (result?: BuildEvaluation, env?: ThermalEnv) => void;
    };
    __N6_LAB_API__?: {
      readConfig: () => unknown;
      render: () => void;
      root: HTMLElement | null;
      $: (sel: string) => HTMLElement | null;
    };
  }
}

async function boot(): Promise<void> {
  window.__N6_LAB__ = {
    ...views,
    profile: n6Profile,
    boardStorage: boardStorage(catalog, BOARD_ID),
    sataCeiling: (nvmeCount: number) =>
      nativeSataCeiling(boardSataPorts(catalog, BOARD_ID, nvmeCount)),
    priceSnapshot: bundledPriceSummary(),
    evaluate,
    thermalSlice: sampleSlice,
    caseGeometry: {
      envelope: { w: N6_ENVELOPE_BOX.w, h: N6_ENVELOPE_BOX.h, d: N6_ENVELOPE_BOX.d },
      interior: {
        c: N6_INTERIOR_BOX.c,
        w: N6_INTERIOR_BOX.w,
        h: N6_INTERIOR_BOX.h,
        d: N6_INTERIOR_BOX.d,
      },
      deckY: N6_DECK_Y,
    },
    afterRender,
  };
  bindConfigChrome();

  // Load legacy IIFE after LAB data is on window (Vite emits hashed URL via ?url).
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = v1RuntimeUrl;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load v1-runtime.js"));
    document.body.appendChild(s);
  });

  await initPricePanel({ catalog, onAudited: () => reapplyLocalPrices() });
}

void boot();
