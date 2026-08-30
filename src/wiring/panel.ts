import type { BuildConfig } from "../config/types";
import type { ModularPanelGroup, SkuCatalog, SkuRecord } from "../sku/types";
import type { EvidenceLevel } from "../core/evidence";
import { buildSataPorts, needsHba } from "../core/policy";
import type { CaseWiringProfile } from "./plan";

/**
 * Socket-level cable plan for the PSU panel.
 *
 * `checkBackplaneHarness` answers "does this pass"; this module answers "what
 * exactly plugs in where, and which requirement is left unserved". It assigns
 * every bundled cable to a real socket and every backplane inlet to a real
 * cable, so a shortfall shows up as a specific empty inlet instead of a verdict.
 */

export type CableKind = "mb" | "cpu" | "pcie" | "12v2x6" | "sata" | "molex" | "mixed" | "sense";

/** Which panel group a cable kind has to plug into. */
const KIND_GROUP: Record<CableKind, ModularPanelGroup["id"]> = {
  mb: "mb",
  cpu: "cpu-pcie",
  pcie: "cpu-pcie",
  "12v2x6": "cpu-pcie",
  sata: "peripheral",
  molex: "peripheral",
  mixed: "peripheral",
  sense: "sense",
};

const KIND_ZH: Record<CableKind, string> = {
  mb: "主板 24-pin",
  cpu: "CPU EPS",
  pcie: "PCIe 8-pin",
  "12v2x6": "12V-2x6",
  sata: "SATA 供电线",
  molex: "Molex(PATA) 线",
  mixed: "SATA+Molex 混合外围线",
  sense: "Sense 感测线",
};

export interface PanelSocket {
  id: string;
  group: ModularPanelGroup["id"];
  groupLabel: string;
  /** 1-based index inside its group. */
  index: number;
  pins: number | string;
  /** Cable occupying it, or `null` when free. */
  cableId: string | null;
}

export interface PlannedCable {
  id: string;
  kind: CableKind;
  label: string;
  /** Connectors on this one cable. */
  connectors: number;
  /** Socket it plugs into; `null` when the panel has no free socket for it. */
  socketId: string | null;
  /** Human-readable destinations this cable serves. */
  targets: string[];
  status: "ok" | "chained" | "unplaceable" | "unused";
}

export interface InletAssignment {
  index: number;
  connector: "sata" | "molex";
  cableId: string | null;
  /** True when the cable also feeds another inlet — the接法 the manual discourages. */
  shared: boolean;
}

export interface PanelWiringPlan {
  psuId: string;
  psuName: string;
  /** `false` when the panel layout is unknown and sockets are only implied. */
  panelKnown: boolean;
  sockets: PanelSocket[];
  cables: PlannedCable[];
  inlets: InletAssignment[];
  /** Sockets left free after the plan — the room a purchase could use. */
  freeSockets: PanelSocket[];
  /** Requirements no cable could serve. */
  unmet: string[];
  evidence: EvidenceLevel;
  notes: string[];
}

function buildSockets(psu: SkuRecord | undefined): { sockets: PanelSocket[]; known: boolean } {
  const panel = psu?.modularPanel;
  if (panel && panel.groups.length > 0) {
    const sockets: PanelSocket[] = [];
    for (const g of panel.groups) {
      for (let i = 1; i <= g.sockets; i++) {
        sockets.push({
          id: `${g.id}.${i}`,
          group: g.id,
          groupLabel: g.label,
          index: i,
          pins: g.pins,
          cableId: null,
        });
      }
    }
    return { sockets, known: true };
  }

  // No panel data: imply just enough peripheral sockets to place the bundled
  // cables, and flag the panel as unknown so the UI never draws it as fact.
  const implied =
    psu?.harness?.peripheralLeads ??
    Math.max(
      0,
      (psu?.harness?.sataLeads ?? 0) +
        (psu?.harness?.molexLeads ?? 0) -
        (psu?.harness?.mixedPeripheralLeads ?? 0),
    );
  const sockets: PanelSocket[] = [];
  for (let i = 1; i <= implied; i++) {
    sockets.push({
      id: `peripheral.${i}`,
      group: "peripheral",
      groupLabel: "Peripheral（面板未点数）",
      index: i,
      pins: 6,
      cableId: null,
    });
  }
  return { sockets, known: false };
}

export function planPanelWiring(
  config: BuildConfig,
  catalog: SkuCatalog,
  profile: CaseWiringProfile,
): PanelWiringPlan {
  const backplane = profile.backplanePower;
  const dual = config.selection.psuTopology === "dual";
  const feedPsuId = dual
    ? (config.selection.secondaryPsuId ?? profile.defaults.secondaryPsuSkuId ?? config.selection.psuId)
    : config.selection.psuId;
  const psu = catalog.skus.find((s) => s.id === feedPsuId);
  const { sockets, known } = buildSockets(psu);
  const cables: PlannedCable[] = [];
  const notes: string[] = [];
  const unmet: string[] = [];
  const populatedBackplane = config.selection.diskCount > 0 || config.selection.boot === "bay";

  const freeSocket = (group: ModularPanelGroup["id"]): PanelSocket | undefined =>
    sockets.find((s) => s.group === group && s.cableId === null);

  let seq = 0;
  const addCable = (
    kind: CableKind,
    connectors: number,
    targets: string[],
    labelSuffix = "",
  ): PlannedCable => {
    const id = `c${++seq}`;
    const socket = freeSocket(KIND_GROUP[kind]);
    if (socket) socket.cableId = id;
    const cable: PlannedCable = {
      id,
      kind,
      label: `${KIND_ZH[kind]}${labelSuffix}`,
      connectors,
      socketId: socket?.id ?? null,
      targets,
      status: socket ? "ok" : "unplaceable",
    };
    cables.push(cable);
    return cable;
  };

  // Board-side cables first: they are non-negotiable, so they must claim their
  // sockets before the peripheral contest is scored. Only groups that have actually
  // been counted are planned — a group absent from the panel data means "not counted",
  // not "no socket", and drawing it as unplaceable would invent a defect.
  const hasGroup = (g: ModularPanelGroup["id"]): boolean => sockets.some((s) => s.group === g);
  const uncounted: string[] = [];
  if (known && !dual) {
    const mbSockets = sockets.filter((s) => s.group === "mb").length;
    if (mbSockets > 0) {
      const mb = addCable("mb", 1, ["主板 24-pin"], mbSockets > 1 ? `（占 ${mbSockets} 座）` : "");
      // Corsair and FSP split the 24-pin across two sockets on one cable.
      for (const s of sockets.filter((x) => x.group === "mb" && x.cableId === null)) {
        s.cableId = mb.id;
      }
    } else uncounted.push("主板");
    if (hasGroup("sense")) addCable("sense", 1, ["主板 24-pin 感测"]);
    if (hasGroup("cpu-pcie")) {
      addCable("cpu", 1, ["CPU EPS 8-pin"]);
      if (config.selection.gpuId !== "gpu.none") addCable("pcie", 2, ["显卡 PCIe"]);
    } else uncounted.push("CPU / PCIe");
  } else if (dual) notes.push("双电源模式下本图只表示背板专用电源；主板、CPU 与 GPU 线保留在主电源面板。");

  // Peripheral contest: one lead per inlet, per manual §13.
  const sataLeads = psu?.harness?.sataLeads ?? null;
  const molexLeads = psu?.harness?.molexLeads ?? null;
  const mixedLeads = psu?.harness?.mixedPeripheralLeads ?? 0;
  const inlets: InletAssignment[] = [];
  const perConnector: Record<"sata" | "molex", PlannedCable[]> = { sata: [], molex: [] };

  if (populatedBackplane) for (let i = 0; i < mixedLeads; i++) {
    const cable = addCable(
      "mixed",
      2,
      [],
      mixedLeads > 1 ? ` ${i + 1}` : "",
    );
    if (cable.status === "ok") {
      perConnector.sata.push(cable);
      perConnector.molex.push(cable);
    }
  }

  if (populatedBackplane) for (const kind of ["sata", "molex"] as const) {
    const leads = kind === "sata" ? sataLeads : molexLeads;
    const need = kind === "sata" ? backplane.connectors.sataPower : backplane.connectors.molex;
    if (leads === null) {
      notes.push(`${KIND_ZH[kind]}根数未公布，接线图按"至少能插上 1 根"保守绘制。`);
    }
    const count = leads === null ? (mixedLeads > 0 ? 0 : 1) : Math.max(0, leads - mixedLeads);
    for (let i = 0; i < count; i++) {
      const c = addCable(kind, kind === "sata" ? 4 : 3, [], count > 1 ? ` ${i + 1}` : "");
      if (c.status === "ok") perConnector[kind].push(c);
    }
    if (leads !== null && leads < need) {
      unmet.push(`${KIND_ZH[kind]}少 ${need - leads} 根（背板需 ${need} 根独立线）`);
    }
  }

  // Hand out inlets in the adapter-declared physical order.
  const usedByKind: Record<"sata" | "molex", number> = { sata: 0, molex: 0 };
  if (populatedBackplane) for (const [zeroBasedIndex, kind] of backplane.inletOrder.entries()) {
    const idx = zeroBasedIndex + 1;
    const pool = perConnector[kind];
    const connectorIndex = usedByKind[kind]++;
    const cable = pool[connectorIndex] ?? pool[pool.length - 1] ?? null;
    const shared = cable !== null && cable.targets.length > 0;
    if (cable) {
      cable.targets.push(`背板口 ${idx}`);
      if (shared) cable.status = "chained";
    } else {
      unmet.push(`背板口 ${idx}（${kind === "sata" ? "SATA" : "Molex"}）没有任何线可接`);
    }
    inlets.push({
      index: idx,
      connector: kind,
      cableId: cable?.id ?? null,
      shared,
    });
  }

  // Boot bay and HBA hang off spare SATA connectors, not extra cables.
  const hba = needsHba(config.selection, buildSataPorts(catalog, config));
  if (config.selection.boot === "bay") {
    notes.push("启动盘位从背板取电，不额外占用外围线。");
  }
  if (hba) notes.push("HBA 由 PCIe 插槽供电，不占外围线。");

  const freeSockets = sockets.filter((s) => s.cableId === null);
  const chained = cables.filter((c) => c.status === "chained");
  if (chained.length > 0) {
    notes.push(
      `${chained.map((c) => c.label).join(" / ")} 被安排串接两个背板口，这正是手册第 13 节不建议的接法。`,
    );
  }
  if (populatedBackplane && freeSockets.some((s) => s.group === "peripheral")) {
    notes.push(
      `外围组还有 ${freeSockets.filter((s) => s.group === "peripheral").length} 个空座，加购同型号原厂线可以插上。`,
    );
  } else if (populatedBackplane && known) {
    notes.push("外围组已插满，加购线无处可插——只能换电源或上双电源。");
  }
  if (!known) {
    notes.push("该型号面板分组未逐座点数，图中插座仅按原盒线材反推，不能当作实物布局。");
  } else if (uncounted.length > 0) {
    notes.push(
      `只点数了外围组；${uncounted.join(" / ")} 分组的插座数未确认，图中不画，也不代表缺少插座。`,
    );
  }

  return {
    psuId: feedPsuId,
    psuName: psu?.name ?? feedPsuId,
    panelKnown: known,
    sockets,
    cables,
    inlets,
    freeSockets,
    unmet,
    evidence: known ? (psu?.modularPanel?.evidence ?? "inferred") : "unknown",
    notes,
  };
}
