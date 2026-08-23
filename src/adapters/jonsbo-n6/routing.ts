import type { EngineFinding } from "../../core/engine";
import type { PlacedPart } from "../../core/geometry";
import {
  buildRouteGraph,
  resolvePort,
  routeRun,
  type CableRunSpec,
  type Port,
  type PortDecl,
  type PortRowDecl,
  type RoutedCable,
  type RouteEdge,
  type RouteGraph,
  type Waypoint,
} from "../../core/routing";
import type { SkuCatalog } from "../../sku/types";
import type { WiringPlan } from "../../wiring/types";
import routing from "../../../data/cases/jonsbo-n6/routing.json";

/**
 * Turns the electrical plan into millimetre cable runs over the N6 geometry.
 *
 * The wiring plan already knows which bay lands on which port and how many
 * peripheral leads the backplane needs; this layer only asks where those cables
 * physically go. Nothing here invents a second topology: every run starts from a
 * `WiringPlan` entry or from a part that is present in the geometry.
 */

const decls = routing.ports as unknown as (PortDecl | PortRowDecl)[];

/**
 * Port ids are unique per *part*, so a declaration attached to a family of parts
 * (`backplane.inlet`, the two PSUs) is instantiated once per member with the part
 * id appended. Same declaration, different coordinates.
 */
function instantiate(parts: PlacedPart[]): Map<string, Port> {
  const ports = new Map<string, Port>();
  const byId = new Map(parts.map((p) => [p.id, p]));

  for (const decl of decls) {
    // Rows declared once and repeated along an axis are expanded below.
    if (!("offset" in decl)) continue;
    // A declaration for `psu` follows whichever PSU parts exist, and a face may
    // be restricted to one mounting slot: the modular panel turns around when the
    // unit moves from the rear shelf to the front bay.
    const targets =
      byId.get(decl.onPart) !== undefined
        ? [byId.get(decl.onPart)!]
        : parts.filter((p) => p.id === decl.onPart || p.id.startsWith(`${decl.onPart}.`));
    for (const part of targets) {
      if (decl.whenSlot && !(part.slotId && decl.whenSlot.includes(part.slotId))) continue;
      const suffix = part.id === decl.onPart ? "" : `.${part.id.slice(decl.onPart.length + 1)}`;
      const port = resolvePort(part, decl);
      ports.set(`${decl.id}${suffix}`, { ...port, id: `${decl.id}${suffix}` });
    }
  }

  // The nine backplane data outlets are one declaration repeated along the tray
  // pitch, so they stay aligned with the trays if that pitch is ever corrected.
  const dataDecl = decls.find((d) => d.id === "port.backplane.data") as PortRowDecl | undefined;
  const pcb = byId.get("backplane.pcb");
  if (dataDecl && pcb) {
    for (let i = 0; i < 9; i++) {
      const offset: [number, number] = [(i - 4) * dataDecl.offsetPitchMm, dataDecl.offsetV];
      const port = resolvePort(pcb, { ...dataDecl, offset });
      const id = `port.backplane.data.${i + 1}`;
      ports.set(id, { ...port, id });
    }
  }

  return ports;
}

function graphOf(): RouteGraph {
  return buildRouteGraph(
    routing.waypoints as unknown as Waypoint[],
    routing.edges as unknown as RouteEdge[],
  );
}

function cableLengthMm(catalog: SkuCatalog, skuId?: string): number | null {
  if (!skuId) return null;
  const sku = catalog.skus?.find((s) => s.id === skuId);
  const len = Number((sku?.attrs as Record<string, unknown> | undefined)?.["lengthMm"]);
  return Number.isFinite(len) && len > 0 ? len : null;
}

/** Which port a bay's data path terminates on, given the plan's target. */
function dataTargetPort(target: string, assignment: { connector: string; portIndex: number | null }): string | null {
  if (target === "hba" && assignment.portIndex !== null) return assignment.portIndex <= 4 ? "port.hba.p1" : "port.hba.p2";
  if (target === "sata") return "port.board.sata";
  if (target === "slimsas") return "port.board.slimsas";
  return null;
}

function runSpecs(plan: WiringPlan, ports: Map<string, Port>, catalog: SkuCatalog): CableRunSpec[] {
  const specs: CableRunSpec[] = [];

  // Which physical unit feeds the backplane is the harness check's answer, not a
  // second guess here: a dedicated second PSU sits on the bottom rack, and its
  // sockets are 300 mm from the primary's.
  const feeder =
    plan.backplaneHarness.feedRole === "backplane-dedicated" && ports.has("port.psu.periph.1.secondary")
      ? "secondary"
      : "primary";

  for (const feed of plan.backplanePower) {
    // Three peripheral sockets have to serve four inlets, which is the harness
    // finding; here the fourth lead simply shares the last socket's position.
    const source = ports.get(`port.psu.periph.${Math.min(feed.inletIndex, 3)}.${feeder}`);
    const sink = ports.get(`port.backplane.power.${feed.inletIndex}`);
    if (!source || !sink) continue;
    specs.push({
      id: `run.backplane.power.${feed.inletIndex}`,
      label: `背板供电 ${feed.inletIndex} · ${feed.connector === "sata" ? "SATA" : "PATA"}`,
      fromPortId: source.id,
      toPortId: sink.id,
      kind: "power",
      availableLengthMm: null,
    });
  }

  for (const bay of plan.bayPaths) {
    const toId = dataTargetPort(bay.target, bay.assignment);
    const from = ports.get(`port.backplane.data.${bay.bayIndex}`);
    if (!toId || !from || !ports.has(toId)) continue;
    specs.push({
      id: `run.data.bay.${bay.bayIndex}`,
      label: `盘位 ${bay.bayIndex} 数据 → ${bay.portLabel}`,
      fromPortId: from.id,
      toPortId: toId,
      kind: "data",
      ...(bay.cableSkuId ? { cableSkuId: bay.cableSkuId } : {}),
      availableLengthMm: cableLengthMm(catalog, bay.cableSkuId),
    });
  }

  const pairs: [string, string, string, CableRunSpec["kind"]][] = [
    ["run.board.atx24", "主板 24pin 供电", "atx24", "power"],
    ["run.board.eps", "CPU EPS 8pin 供电", "eps", "power"],
  ];
  for (const [id, label, suffix, kind] of pairs) {
    const from = ports.get(`port.psu.${suffix}.primary`);
    const to = ports.get(`port.board.${suffix}`);
    if (from && to) {
      specs.push({ id, label, fromPortId: from.id, toPortId: to.id, kind, availableLengthMm: null });
    }
  }

  const gpuPower = ports.get("port.gpu.power");
  const psuPcie = ports.get("port.psu.pcie.primary");
  if (gpuPower && psuPcie) {
    specs.push({
      id: "run.gpu.power",
      label: "显卡供电",
      fromPortId: psuPcie.id,
      toPortId: gpuPower.id,
      kind: "power",
      availableLengthMm: null,
    });
  }

  return specs;
}

export interface N6Routing {
  cables: RoutedCable[];
  ports: Port[];
  findings: EngineFinding[];
}

export function buildN6Routing(
  parts: PlacedPart[],
  plan: WiringPlan,
  catalog: SkuCatalog,
): N6Routing {
  const ports = instantiate(parts);
  const graph = graphOf();
  const cables = runSpecs(plan, ports, catalog).map((spec) =>
    routeRun(spec, ports.get(spec.fromPortId)!, ports.get(spec.toPortId)!, graph, parts),
  );
  return { cables, ports: [...ports.values()], findings: routingFindings(cables) };
}

/**
 * Findings for the four phase-one checks. All of them cap at `warn`: every anchor
 * behind them is reconstructed from a schematic figure, and a reconstruction
 * cannot prove a cable does not fit.
 */
export function routingFindings(cables: RoutedCable[]): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const suffix = "（接口锚点为按手册图示重建的推算值，需实物核对）";

  for (const cable of cables) {
    for (const { portId, blocks } of cable.insertion) {
      const worst = blocks[0];
      if (!worst) continue;
      const angled = blocks.every((b) => b.sidewaysClear);
      findings.push({
        id: angled ? `routing.needs-angled-connector:${portId}` : `routing.insertion-blocked:${portId}`,
        verdict: "warn",
        evidence: "inferred",
        message: angled
          ? `${cable.label}：${portId} 正面 ${worst.depthMm}mm 内被「${worst.partName}」占住，侧向仍有空间，需要弯头线材${suffix}`
          : `${cable.label}：${portId} 的插拔空间被「${worst.partName}」吃掉 ${worst.depthMm}mm${suffix}`,
        related: blocks.map((b) => b.partId),
      });
    }

    if (!cable.route) {
      findings.push({
        id: `routing.no-path:${cable.id}`,
        verdict: "warn",
        evidence: "inferred",
        message: `${cable.label}：航点图里没有连通的通路——手册未画出该走线路径，需实物确认是否有穿线孔${suffix}`,
        related: [cable.from.partId, cable.to.partId],
      });
      continue;
    }

    if (cable.segmentHits.length) {
      const names = [...new Set(cable.segmentHits.map((h) => h.partName))];
      findings.push({
        id: `routing.segment-blocked:${cable.id}`,
        verdict: "warn",
        evidence: "inferred",
        message: `${cable.label}：走线折线穿过「${names.join("」「")}」${suffix}`,
        related: [...new Set(cable.segmentHits.map((h) => h.partId))],
      });
    }

    const required = cable.requiredMm!;
    if (cable.availableLengthMm == null) {
      findings.push({
        id: `routing.length-unknown:${cable.id}`,
        verdict: "warn",
        evidence: "unknown",
        message: `${cable.label}：目录里没有这根线的长度，至少需要 ${required}mm（含 15% 装配余量）${suffix}`,
        related: [cable.from.partId, cable.to.partId],
      });
    } else if (cable.availableLengthMm < required) {
      findings.push({
        id: `routing.length-required:${cable.id}`,
        verdict: "warn",
        evidence: "inferred",
        message: `${cable.label}：需要 ${required}mm，选定线材只有 ${cable.availableLengthMm}mm${suffix}`,
        related: [cable.from.partId, cable.to.partId],
      });
    }
  }

  return findings;
}
