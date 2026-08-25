import { loadBundledCatalog, requireSku, bundledPriceSummary } from "../sku/catalog";
import { derivePower, evaluateBuild, type BuildEvaluation, type PowerEvaluation, type ThermalEnv } from "../core/evaluate";
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
import type { FanMode, FanGroupInput } from "../core/thermal";
import { buildLabCatalogs } from "./view-models";
import { formatSnapshotStamp } from "../price/types";
import { applyPriceSnapshot, snapshotSummary } from "../price/merge";
import { buildSkuSearchLinks, pickOfficialUrl } from "../price/search";
import { getLocalSnapshot, initPricePanel, updatePriceCatalog } from "./price-panel";
import { planPanelWiring } from "../wiring/panel";
import { boardSataPorts, boardStorage, nativeSataCeiling } from "../core/policy";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";
import n6Routing from "../../data/cases/jonsbo-n6/routing.json";
import v1RuntimeUrl from "./v1-runtime.js?url";
import { initAdvicePanel } from "./advice-panel";
import { initAgentPanel } from "./agent-panel";
import { buildAdviceInput } from "../advice/validate";
import { initBuildProgress, type BuildProgressController } from "./build-progress";
import { initTransactionImport } from "./transaction-import";
import { WorkspaceApiClient } from "../plans/client";
import { PlanStore } from "../plans/client-store";
import { canonicalJson } from "../plans/canonical";
import { mountPlanShell, type PlanShellController } from "./plan-shell";
import "./design-system.css";

let catalog = loadBundledCatalog();
const views = buildLabCatalogs(catalog);
let priceStamp = bundledPriceSummary();
let latestEvaluation: BuildEvaluation | null = null;
let buildProgress: BuildProgressController | null = null;
let planStore: PlanStore | null = null;
let planShell: PlanShellController | null = null;

const BOARD_ID = "board.asus-w680m-ace-se";

export interface LabEvaluationOptions {
  ambientC: number;
  fanMode: FanMode;
  fans: { front?: FanGroupInput | null; rear?: FanGroupInput | null; left?: FanGroupInput | null; right?: FanGroupInput | null };
  workload?: NonNullable<ThermalEnv["workload"]>;
  cpuPl1W?: number;
  cpuPl2W?: number;
  reserveHbaSlot?: boolean;
  gpuOverride?: ThermalEnv["gpuOverride"];
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function findingTitle(message: string): string {
  const lead = message.split(/[：。；]/, 1)[0]?.trim() || message.trim();
  return lead.length > 46 ? `${lead.slice(0, 46)}…` : lead;
}

function val(id: string): string {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
  return el?.value ?? "";
}

function configFromDomLegacy(): BuildConfig {
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

/** Transitional adapter: active plan is authoritative; raw DOM is only the input bridge. */
function configFromDom(): BuildConfig {
  return planStore?.getActiveConfig() ?? configFromDomLegacy();
}

function adviceInput() {
  const evaluation = latestEvaluation ?? evaluate();
  const ids = new Set([
    evaluation.config.caseId,
    evaluation.config.boardId,
    evaluation.config.cpuId,
    evaluation.config.selection.psuId,
    evaluation.config.selection.secondaryPsuId ?? "",
    evaluation.config.selection.coolerId,
    evaluation.config.selection.gpuId,
    evaluation.config.selection.memoryId,
    evaluation.config.selection.diskSkuId ?? "",
    evaluation.config.selection.hbaSkuId ?? "",
  ]);
  const selectedSkuFacts = catalog.skus
    .filter((sku) => ids.has(sku.id))
    .map((sku) => ({
      skuId: sku.id,
      name: sku.name,
      fields: {
        brand: sku.brand,
        model: sku.model,
        mpn: sku.mpn,
        category: sku.category,
        dims: sku.dims,
        power: sku.power,
        harness: sku.harness,
        modularPanel: sku.modularPanel,
        price: sku.price,
        attrs: sku.attrs,
      },
      provenance: sku.provenance ?? [],
    }));
  return buildAdviceInput({
    requestId: "advice-client",
    buildConfig: evaluation.config,
    evaluation,
    selectedSkuFacts,
  });
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
  const badCount = result.findings.filter((finding) => finding.verdict === "bad").length;
  const warnCount = result.findings.filter((finding) => finding.verdict === "warn").length;
  const worst = badCount > 0 ? "bad" : warnCount > 0 ? "warn" : result.occupancy.verdict;
  chip.setAttribute("data-level", worst === "ok" ? "ok" : worst);
  chip.textContent = badCount > 0
    ? `存在阻断 · ${badCount} 项`
    : warnCount > 0
      ? `需要确认 · ${warnCount} 项`
      : "评估通过 · 未发现冲突";

  const list = $("verdict-list");
  if (list) {
    list.innerHTML = result.findings
      .slice(0, 8)
      .map(
        (f) => `<li class="finding-row" data-level="${f.verdict}">
          <span class="finding-level">${f.verdict === "bad" ? "阻断" : f.verdict === "warn" ? "警告" : "通过"}</span>
          <span class="finding-evidence">${escapeHtml(evidenceLabel(f.evidence))}</span>
          <details><summary>${escapeHtml(findingTitle(f.message))}</summary><p>${escapeHtml(f.message)}</p><small>${escapeHtml(f.id)}</small></details>
        </li>`,
      )
      .join("");
  }

  const routeCopy = $("route-copy");
  const primary = result.findings.find((finding) => finding.verdict === "bad")
    ?? result.findings.find((finding) => finding.verdict === "warn")
    ?? result.findings[0];
  if (routeCopy && primary) {
    const firstSentence = primary.message.split("。", 1)[0] ?? primary.message;
    routeCopy.textContent = firstSentence.length > 180 ? `${firstSentence.slice(0, 180)}…` : firstSentence;
    routeCopy.setAttribute("title", primary.message);
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
        : `独立外围线 ${check.uniquePeripheralLeads ?? "unknown"}/${check.inlets} · SATA ${check.confirmed.sata}/${check.required.sata} · Molex ${check.confirmed.molex}/${check.required.molex}`;
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
        : `${psuName} · ${check.uniquePeripheralLeads ?? "unknown"}/${check.inlets} 条独立外围线`;
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
    if (c.kind === "sata" || c.kind === "molex" || c.kind === "mixed") continue;
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

const PORT_KIND_ZH: Record<string, string> = {
  atx24: "24pin",
  eps8: "EPS 8pin",
  pcie8: "PCIe 8pin",
  periph5: "外围 SATA/PATA",
  sata_data: "SATA 数据",
  slimsas: "SlimSAS",
  sff8643: "SFF-8643",
  fan4: "风扇 4pin",
};

const WAYPOINTS = new Map(
  (n6Routing.waypoints as { id: string; kind: string; apertureMm: number; source: string }[]).map(
    (w) => [w.id, w],
  ),
);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * Routing table: one row per solved cable run.
 *
 * It shows the same polylines the isometric view draws, so a row and a line can
 * never disagree. Every cell is a reconstruction — the manual publishes no
 * connector coordinates — which is why the worst thing a row can say is
 * "check it on the real thing", never "this will not fit".
 */
function updateRouting(result: BuildEvaluation): void {
  const host = $("routing-table");
  if (!host) return;
  const cables = result.routing.cables;
  const partName = new Map(result.geometry.map((p) => [p.id, p.name]));

  const endLabel = (port: { partId: string; kind: string; id: string; source: string }): string => {
    const name = partName.get(port.partId) ?? port.partId;
    const kind = PORT_KIND_ZH[port.kind] ?? port.kind;
    return `<span title="${esc(`${port.id} · ${port.source}`)}">${esc(name)} · ${esc(kind)}</span>`;
  };

  const viaLabel = (ids: string[]): string => {
    if (ids.length === 0) return '<span class="rt-muted">直连，未经声明航点</span>';
    return ids
      .map((id) => {
        const wp = WAYPOINTS.get(id);
        const short = id.replace(/^wp\./, "");
        const opening = wp?.kind === "deck_opening";
        const title = wp ? `${id} · 通径约 ${wp.apertureMm}mm · ${wp.source}` : id;
        return `<span class="rt-via" data-opening="${opening}" title="${esc(title)}">${esc(short)}</span>`;
      })
      .join('<span class="rt-arrow">→</span>');
  };

  type Chip = { text: string; level: "warn" | "ok" | "unknown" };
  const chipsFor = (cable: BuildEvaluation["routing"]["cables"][number]): Chip[] => {
    const chips: Chip[] = [];
    if (!cable.route) chips.push({ text: "无声明过的通路", level: "warn" });
    for (const ins of cable.insertion) {
      if (ins.blocks.length === 0) continue;
      const angled = ins.blocks.every((b) => b.sidewaysClear);
      const worst = ins.blocks[0]!;
      chips.push({
        text: angled ? `需弯头 · ${worst.partName}` : `插拔受阻 · ${worst.partName} ${worst.depthMm}mm`,
        level: "warn",
      });
    }
    const through = [...new Set(cable.segmentHits.map((h) => h.partName))];
    if (through.length > 0) chips.push({ text: `折线穿过 ${through.join(" / ")}`, level: "warn" });
    if (cable.route) {
      if (cable.availableLengthMm == null) {
        chips.push({ text: "线材长度未公布", level: "unknown" });
      } else if (cable.availableLengthMm < cable.requiredMm!) {
        chips.push({
          text: `线材短 ${cable.requiredMm! - cable.availableLengthMm}mm`,
          level: "warn",
        });
      }
    }
    if (chips.length === 0) chips.push({ text: "无冲突（推算）", level: "ok" });
    return chips;
  };

  const rows = cables
    .map((cable) => {
      const chips = chipsFor(cable);
      const level = chips.some((c) => c.level === "warn")
        ? "warn"
        : chips.some((c) => c.level === "unknown")
          ? "unknown"
          : "ok";
      const length = cable.route
        ? `${Math.round(cable.route.lengthMm)} → <b>${cable.requiredMm}</b>mm` +
          (cable.availableLengthMm == null ? "" : `<br><span class="rt-muted">选定线材 ${cable.availableLengthMm}mm</span>`)
        : '<span class="rt-muted">—</span>';
      return (
        `<tr data-run-id="${esc(cable.id)}" data-level="${level}" tabindex="0" aria-selected="false">` +
        `<td>${esc(cable.label)}<br><span class="rt-muted">${cable.kind === "power" ? "供电" : "数据"}</span></td>` +
        `<td>${endLabel(cable.from)}<br><span class="rt-arrow">↓</span><br>${endLabel(cable.to)}</td>` +
        `<td>${viaLabel(cable.route?.viaIds ?? [])}</td>` +
        `<td class="rt-len">${length}</td>` +
        `<td>${chips.map((c) => `<span class="rt-chip" data-level="${c.level}">${esc(c.text)}</span>`).join("")}</td>` +
        "</tr>"
      );
    })
    .join("");

  host.innerHTML = cables.length
    ? '<div class="table-responsive"><table class="table table-sm routing-rows"><thead><tr>' +
      "<th>线缆</th><th>起点 → 终点</th><th>途经航点</th><th>折线 → 所需</th><th>状态</th>" +
      `</tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="lab-note">当前选型没有需要求解的线路。</p>';

  bindRoutingRows(host);

  const flagged = cables.filter((c) => chipsFor(c).some((x) => x.level === "warn")).length;
  const unknown = cables.filter((c) => c.route !== null && c.availableLengthMm == null).length;
  const longest = cables.reduce((m, c) => Math.max(m, c.requiredMm ?? 0), 0);
  const badge = $("routing-badge");
  if (badge) {
    badge.textContent = cables.length
      ? `${cables.length} 条线路 · ${flagged} 处冲突 · ${unknown} 条长度未知 · 最长需 ${longest}mm`
      : "无线路";
  }
  const notes = $("routing-notes");
  if (notes) {
    notes.dataset.level = flagged > 0 ? "warn" : unknown > 0 ? "warn" : "ok";
    const openings = new Set(
      cables.flatMap((c) => (c.route?.viaIds ?? []).filter((id) => WAYPOINTS.get(id)?.kind === "deck_opening")),
    );
    notes.textContent =
      (flagged > 0
        ? `${flagged} 条线路有插拔净空、穿越或长度问题，均为推算结论，需实物核对。`
        : "按重建的接口锚点，所有线路都能走通。") +
      (unknown > 0
        ? `另有 ${unknown} 条线材目录里没有长度，无法判断够不够长。`
        : "") +
      (openings.size > 0
        ? `跨腔线路依赖 ${openings.size} 处隔板开口（${[...openings].map((id) => id.replace(/^wp\./, "")).join(" / ")}），手册未标注其尺寸与位置。`
        : "") +
      "所需长度已含 15% 装配余量。";
  }
}

const STEP_VERB: Record<string, string> = {
  part: "装上",
  plug: "接上",
  remove: "拆下",
  refit: "装回",
};

/**
 * Derived assembly order.
 *
 * Consecutive cable connections are collapsed into one line: nine bay data
 * cables are one job, and listing them as nine steps buries the two lines that
 * actually matter — the bracket coming off and going back on.
 */
function updateAssembly(result: BuildEvaluation): void {
  const host = $("assembly-steps");
  if (!host) return;
  const steps = result.assembly.steps;

  type Row = {
    kind: string;
    label: string;
    family: string;
    count: number;
    reasons: string[];
    deadlocked: boolean;
  };
  const rows: Row[] = [];
  for (const step of steps) {
    // Cables of one family share their first word ("背板供电", "盘位"), which is
    // what makes them one job rather than a pile of individual plugs.
    const family = step.label.split(" ")[0] ?? step.label;
    const last = rows[rows.length - 1];
    if (
      step.kind === "plug" &&
      last?.kind === "plug" &&
      last.family === family &&
      last.deadlocked === Boolean(step.deadlocked)
    ) {
      last.count += 1;
      for (const r of step.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
      continue;
    }
    rows.push({
      kind: step.kind,
      label: step.label,
      family,
      count: 1,
      reasons: [...step.reasons],
      deadlocked: Boolean(step.deadlocked),
    });
  }

  host.innerHTML = rows
    .map((row) => {
      const reason = row.reasons[0];
      // A folded row names the family, never the first member: "背板供电 1" as the
      // heading of seven plugs would describe the group wrongly.
      const head = row.count > 1 ? `${row.family}线束` : row.label;
      return (
        `<li data-kind="${row.kind}"${row.deadlocked ? ' data-deadlocked="true"' : ""}>` +
        `<b>${STEP_VERB[row.kind] ?? ""}${esc(head)}</b>` +
        (row.count > 1 ? `<span class="as-count">${row.count} 个接头</span>` : "") +
        (reason ? `<span class="as-why">${esc(reason)}</span>` : "") +
        "</li>"
      );
    })
    .join("");

  const badge = $("assembly-badge");
  if (badge) {
    const derived = result.assembly.constraints.filter(
      (c) => c.kind === "clearance" || c.kind === "access",
    ).length;
    const declared = result.assembly.constraints.filter((c) => c.kind === "declared").length;
    badge.textContent = `${rows.length} 步 · 推导 ${derived} 条 · 手册明写 ${declared} 条`;
  }
  const notes = $("assembly-notes");
  if (notes) {
    const warn = result.assembly.findings.filter((f) => f.verdict !== "ok");
    notes.dataset.level = warn.length > 0 ? "warn" : "ok";
    notes.textContent =
      result.assembly.findings.map((f) => f.message).join(" · ") ||
      "没有交叉遮挡：各件的装入行程互不占用。";
  }
}

/**
 * Row selection drives the preview. The table owns which run is focused because
 * that is where the run is named; the view only listens.
 */
function bindRoutingRows(host: HTMLElement): void {
  let focused: string | null = null;
  const focus = (id: string | null): void => {
    focused = id;
    for (const row of host.querySelectorAll<HTMLElement>("tr[data-run-id]")) {
      row.setAttribute("aria-selected", String(row.dataset.runId === id));
    }
    document.dispatchEvent(new CustomEvent("n6:route-focus", { detail: { id } }));
  };
  for (const row of host.querySelectorAll<HTMLElement>("tr[data-run-id]")) {
    const toggle = (): void => focus(focused === row.dataset.runId ? null : (row.dataset.runId ?? null));
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
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

function updateCalibration(result: BuildEvaluation): void {
  const el = $("calibration-status");
  if (!el) return;
  const unknown = result.calibration.unknown;
  el.dataset.level = unknown.length ? "warn" : "ok";
  el.textContent = unknown.length
    ? `校准 ${result.calibration.snapshot.calibrationVersion} · unknown ${unknown.length} · hash ${result.calibration.hash.slice(-8)}`
    : `校准 ${result.calibration.snapshot.calibrationVersion} · 已收窄规划区间 · hash ${result.calibration.hash.slice(-8)}`;
}

function updateGalleryFromSkus(config: BuildConfig): void {
  const gallery = $("product-gallery");
  if (!gallery) return;

  const cards: { name: string; status: string; skuId: string; note?: string }[] = [
    { name: requireSku(catalog, config.caseId).name, status: "已购", skuId: config.caseId },
    { name: requireSku(catalog, config.boardId).name, status: "已购", skuId: config.boardId },
    { name: requireSku(catalog, config.cpuId).name, status: "已购", skuId: config.cpuId },
    { name: requireSku(catalog, config.selection.memoryId).name, status: "待购", skuId: config.selection.memoryId },
    { name: `${requireSku(catalog, n6Profile.defaults.ownedNvmeSkuId).name} ×${n6Profile.defaults.ownedNvmeQty}`, status: "已有", skuId: n6Profile.defaults.ownedNvmeSkuId },
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
        ? ` · ¥${sku?.price.current} (${formatSnapshotStamp(snap)}${snap.variantLabel ? ` · 规格 ${snap.variantLabel}` : ""}${snap.provenanceId ? ` · prov ${snap.provenanceId.slice(0, 12)}` : ""})`
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
function evaluate(options?: LabEvaluationOptions): BuildEvaluation {
  const config = configFromDom();
  if (!options) return evaluateBuild(config, catalog);
  const power: PowerEvaluation = derivePower(config, catalog, options);
  const lower = config.selection.psuTopology === "bottom" || config.selection.psuTopology === "dual";
  if (power.upperDcW === null || (lower && power.lowerDcW === null)) {
    return evaluateBuild(config, catalog);
  }
  const thermal: ThermalEnv = {
    ...options,
    upperWatts: power.upperDcW,
    psuDcWatts: lower ? power.lowerDcW! : 0,
    loads: power.loads,
    power,
  };
  return evaluateBuild(config, catalog, thermal);
}

function afterRender(result?: BuildEvaluation, env?: ThermalEnv): void {
  const evaluation = result ?? evaluate(env);
  latestEvaluation = evaluation;
  updateFitFromEngine(evaluation);
  updateWiringFromEngine(evaluation);
  updateBackplaneHarness(evaluation.wiring);
  updatePanelWiring(evaluation.config);
  updateRouting(evaluation);
  updateAssembly(evaluation);
  updateAirBalance(evaluation);
  updateCalibration(evaluation);
  updateGalleryFromSkus(evaluation.config);
  updatePriceStamp();
  buildProgress?.syncEvaluation(evaluation);
  planStore?.setEvaluation(evaluation);
}

function bindConfigChrome(): void {
  $("cfg-export-json")?.addEventListener("click", () => {
    const config = configFromDom();
    downloadText(`${config.id}.json`, serializeConfig(config));
  });
  $("cfg-export-checklist")?.addEventListener("click", () => {
    const config = configFromDom();
    const result = evaluateBuild(config, catalog);
    downloadText(`${config.id}-checklist.md`, exportChecklist(config, result.bom, result));
  });
  $("cfg-import-json")?.addEventListener("change", async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const config = parseConfig(text);
    if (planStore?.getState().activePlan) planStore.replaceDraft(config);
    else applyConfigToDom(config);
    window.__N6_LAB_API__?.render();
  });
}

const PLAN_CONFIG_INPUT_IDS = new Set([
  "psu-select", "psu-position", "secondary-psu-select", "dual-start-select", "cooler-select",
  "gpu-select", "ram-select", "disk-range", "boot-select", "nvme-select", "hba-select",
]);

function bindPlanStoreToDom(): void {
  const root = $("n6-lab");
  if (!root || !planStore) return;
  const capture = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target?.id || !PLAN_CONFIG_INPUT_IDS.has(target.id)) return;
    planStore?.replaceDraft(configFromDomLegacy());
  };
  root.addEventListener("change", capture);
  root.addEventListener("input", capture);

  let renderedSignature = "";
  planStore.subscribe((state) => {
    const plan = state.activePlan;
    if (!plan) return;
    const signature = `${plan.id}:${canonicalJson(plan.draft.config)}`;
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    applyConfigToDom(plan.draft.config);
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
      skuName: (id: string) => string;
      ids: { caseId: string; boardId: string; cpuId: string; nvmeId: string; hbaId: string; diskId: string };
      profile: typeof n6Profile;
      /** Board storage facts, so the runtime never restates a count the SKU owns. */
      boardStorage: ReturnType<typeof boardStorage>;
      /** SATA ceiling once NVMe drives have claimed their slots. */
      sataCeiling: (nvmeCount: number) => number;
      priceSnapshot: ReturnType<typeof bundledPriceSummary>;
      /** Runs the V2 engine for the current DOM config. Pure and synchronous. */
      evaluate: (options?: LabEvaluationOptions) => BuildEvaluation;
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
    __BUILD_SIM_PLAN_STORE__?: PlanStore;
  }
}

async function boot(): Promise<void> {
  planStore = new PlanStore({ api: new WorkspaceApiClient(), storage: window.localStorage });
  await planStore.initialize();
  window.__BUILD_SIM_PLAN_STORE__ = planStore;
  const activeConfig = planStore.getState().activePlan?.draft.config;
  if (activeConfig) applyConfigToDom(activeConfig);
  const labRoot = $("n6-lab");
  if (labRoot) planShell = mountPlanShell(labRoot, planStore);
  window.__N6_LAB__ = {
    ...views,
    skuName: (id: string) => requireSku(catalog, id).name,
    ids: {
      caseId: "case.jonsbo-n6",
      boardId: BOARD_ID,
      cpuId: "cpu.i5-14500",
      nvmeId: n6Profile.defaults.ownedNvmeSkuId,
      hbaId: n6Profile.hba.defaultSkuId,
      diskId: n6Profile.defaults.diskSkuId,
    },
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
  bindPlanStoreToDom();

  // Progress is local and synchronous: make the editable base available as soon
  // as the deterministic evaluation has rendered, without waiting on API panels.
  buildProgress = initBuildProgress({
    getCatalog: () => catalog,
    baseSkuIds: ["case.jonsbo-n6", BOARD_ID, "cpu.i5-14500"],
  });
  initTransactionImport({ onImport: (record, screenshot) => buildProgress?.stageTransaction(record, screenshot) });
  if (latestEvaluation) buildProgress.syncEvaluation(latestEvaluation);

  await initPricePanel({ catalog, onAudited: () => reapplyLocalPrices() });
  initAdvicePanel({ getInput: adviceInput });
  await initAgentPanel({ getBuildConfig: configFromDom });
}

void boot();
