import type { BuildConfig } from "../config/types";
import type { EngineFinding } from "./engine";
import type { PlacedPart, Vec3 } from "./geometry";
import { maxOn, minOn } from "./geometry";
import { N6_INTERIOR_BOX } from "../adapters/jonsbo-n6/geometry";
import type { N6Routing } from "../adapters/jonsbo-n6/routing";
import type { SkuCatalog } from "../sku/types";
import type { WiringPlan } from "../wiring/types";

export const PHYSICAL_RULESET_VERSION = "physical-rules-1.0.0";
const SLOT_PITCH_MM = 20.32;

export interface OBB2D {
  center: [number, number];
  half: [number, number];
  angleDeg: number;
  evidence: "standard" | "inferred";
}

export interface PlugSweepFact {
  cableId: string;
  portId: string;
  sweep: { c: Vec3; w: number; h: number; d: number };
  blockedBy: string[];
  evidence: "inferred";
}

export interface BendRadiusFact {
  cableId: string;
  requiredMm: number;
  availableMm: number | null;
  evidence: "inferred" | "unknown";
}

export interface PhysicalEvaluation {
  schemaVersion: "1.0.0";
  rulesetVersion: typeof PHYSICAL_RULESET_VERSION;
  hash: string;
  provenance: string[];
  gpu?: { obb: OBB2D; projectedWidthMm: number; projectedDepthMm: number; angleDeg: number };
  plugSweeps: PlugSweepFact[];
  bendRadius: BendRadiusFact[];
  slotWidth: { gpuSlots: number | null; hbaSlots: number; totalSlots: number; evidence: "standard" | "inferred" | "unknown" };
  lane: { nvmeCount: number; m2Slots: number; slimSasClaimed: boolean; hbaPresent: boolean; evidence: "standard" | "inferred" | "unknown" };
  serviceSpace: { minimumInsertionMm: number | null; blockedPorts: string[]; evidence: "inferred" | "unknown" };
  findings: EngineFinding[];
}

export interface PhysicalOptions {
  gpuRotationDeg?: number;
}

/** Plan identity, display metadata and persistence timestamps are not physical inputs. */
function physicalConfigFacts(config: BuildConfig) {
  return {
    caseId: config.caseId,
    boardId: config.boardId,
    cpuId: config.cpuId,
    selection: config.selection,
  };
}

function tinyHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function gpuObb(part: PlacedPart, angleDeg = 0): OBB2D {
  return { center: [part.box.c[0], part.box.c[2]], half: [part.box.w / 2, part.box.d / 2], angleDeg, evidence: "inferred" };
}

export function obbProjectedExtents(obb: OBB2D): { widthMm: number; depthMm: number } {
  const radians = (obb.angleDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(radians));
  const s = Math.abs(Math.sin(radians));
  return {
    widthMm: 2 * (obb.half[0] * c + obb.half[1] * s),
    depthMm: 2 * (obb.half[0] * s + obb.half[1] * c),
  };
}

function obbCorners(obb: OBB2D): [number, number][] {
  const radians = (obb.angleDeg * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return ([-1, 1] as const).flatMap((x) => ([-1, 1] as const).map((z) => [
    obb.center[0] + x * obb.half[0] * c - z * obb.half[1] * s,
    obb.center[1] + x * obb.half[0] * s + z * obb.half[1] * c,
  ] as [number, number]));
}

function obbOutsideCase(obb: OBB2D): boolean {
  const corners = obbCorners(obb);
  const xLo = minOn(N6_INTERIOR_BOX, "x");
  const xHi = maxOn(N6_INTERIOR_BOX, "x");
  const zLo = minOn(N6_INTERIOR_BOX, "z");
  const zHi = maxOn(N6_INTERIOR_BOX, "z");
  return corners.some(([x, z]) => x < xLo || x > xHi || z < zLo || z > zHi);
}

function bendRadius(cable: N6Routing["cables"][number]): number | null {
  const points = cable.route?.polyline ?? [];
  if (points.length < 3) return cable.route ? Infinity : null;
  let available = Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const current = points[i]!;
    const next = points[i + 1]!;
    const incoming = Math.hypot(current[0] - prev[0], current[1] - prev[1], current[2] - prev[2]);
    const outgoing = Math.hypot(next[0] - current[0], next[1] - current[1], next[2] - current[2]);
    available = Math.min(available, incoming / 2, outgoing / 2);
  }
  return Number.isFinite(available) ? Math.round(available * 10) / 10 : null;
}

function requiredBendRadius(kind: N6Routing["cables"][number]["kind"]): number {
  return kind === "power" ? 25 : kind === "data" ? 15 : 10;
}

export function evaluatePhysicalConstraints(
  config: BuildConfig,
  catalog: SkuCatalog,
  parts: PlacedPart[],
  routing: N6Routing,
  wiring: WiringPlan,
  options: PhysicalOptions = {},
): PhysicalEvaluation {
  const findings: EngineFinding[] = [];
  const gpu = parts.find((part) => part.kind === "gpu");
  const angleDeg = options.gpuRotationDeg ?? 0;
  const gpuFact = gpu
    ? (() => {
        const obb = gpuObb(gpu, angleDeg);
        const projected = obbProjectedExtents(obb);
        if (obbOutsideCase(obb)) findings.push({ id: "physical.gpu-obb-case", verdict: "warn", evidence: "inferred", message: `GPU OBB 旋转 ${angleDeg}° 后的包络超出机箱规划内框；旋转角、挡板和线材净空需要实装复核。`, related: [gpu.id, config.caseId] });
        return { obb, projectedWidthMm: projected.widthMm, projectedDepthMm: projected.depthMm, angleDeg };
      })()
    : undefined;

  const plugSweeps = routing.cables.flatMap((cable) => cable.insertion.map((insertion) => ({ cableId: cable.id, portId: insertion.portId, sweep: insertion.sweep, blockedBy: insertion.blocks.map((block) => block.partId), evidence: "inferred" as const })));
  const blockedPorts = plugSweeps.filter((sweep) => sweep.blockedBy.length > 0).map((sweep) => sweep.portId);
  if (blockedPorts.length) findings.push({ id: "physical.plug-service-space", verdict: "warn", evidence: "inferred", message: `插头扫掠体在 ${blockedPorts.length} 个端口被结构件占用；需要保留插拔服务空间或改用弯头插头。`, related: blockedPorts });

  const bendRadiusFacts = routing.cables.map((cable) => {
    const requiredMm = requiredBendRadius(cable.kind);
    const availableMm = bendRadius(cable);
    if (availableMm === null) findings.push({ id: `physical.bend-radius-unknown:${cable.id}`, verdict: "warn", evidence: "unknown", message: `${cable.label} 的走线路径未知，线材弯折半径保持 unknown。`, related: [cable.id] });
    else if (availableMm < requiredMm) findings.push({ id: `physical.bend-radius:${cable.id}`, verdict: "warn", evidence: "inferred", message: `${cable.label} 可用弯折半径约 ${availableMm}mm，小于规划 ${requiredMm}mm；需改路或换软线。`, related: [cable.id] });
    return { cableId: cable.id, requiredMm, availableMm, evidence: availableMm === null ? "unknown" as const : "inferred" as const };
  });

  const gpuSlots = gpu ? Math.max(1, Math.round(gpu.box.w / SLOT_PITCH_MM)) : null;
  const hbaPresent = parts.some((part) => part.kind === "hba");
  const totalSlots = (gpuSlots ?? 0) + (hbaPresent ? 1 : 0);
  const slotEvidence = gpuSlots === null ? "unknown" : "standard";
  if (hbaPresent && gpuSlots !== null && gpuSlots > 2) findings.push({ id: "physical.slot-width-hba", verdict: "bad", evidence: "standard", message: `GPU 约 ${gpuSlots} 槽且 HBA 占用第二扩展位；槽宽不允许两者同时规划。`, related: [gpu?.id ?? "gpu.none", "hba"] });
  const nvmeCount = config.selection.nvmeCount ?? 0;
  const m2Slots = 2;
  const slimSasClaimed = nvmeCount > m2Slots;
  const laneEvidence = "standard" as const;
  if (slimSasClaimed && !hbaPresent) findings.push({ id: "physical.lane-slimsas", verdict: "warn", evidence: "standard", message: `NVMe ${nvmeCount} 块超过 ${m2Slots} 个 M.2 槽，额外设备占用 SlimSAS；主板 SATA lane 与 HBA 需求需复核。`, related: [config.boardId] });
  const minimumInsertionMm = plugSweeps.length ? Math.min(...plugSweeps.map((sweep) => sweep.sweep.w + sweep.sweep.h + sweep.sweep.d).filter(Number.isFinite)) : null;
  if (!wiring.checklist.length) findings.push({ id: "physical.service-space-checklist", verdict: "warn", evidence: "unknown", message: "接线服务空间清单为空，无法证明维护时的插拔通道。", related: [config.caseId] });

  const provenance = ["case.jonsbo-n6/geometry.json", "case.jonsbo-n6/routing.json", "BuildEvaluation.wiring", PHYSICAL_RULESET_VERSION];
  const result: PhysicalEvaluation = {
    schemaVersion: "1.0.0",
    rulesetVersion: PHYSICAL_RULESET_VERSION,
    hash: tinyHash({ config: physicalConfigFacts(config), gpu: gpuFact, plugSweeps, bendRadiusFacts, slotEvidence, laneEvidence, provenance }),
    provenance,
    ...(gpuFact ? { gpu: gpuFact } : {}),
    plugSweeps,
    bendRadius: bendRadiusFacts,
    slotWidth: { gpuSlots, hbaSlots: hbaPresent ? 1 : 0, totalSlots, evidence: slotEvidence },
    lane: { nvmeCount, m2Slots, slimSasClaimed, hbaPresent, evidence: laneEvidence },
    serviceSpace: { minimumInsertionMm, blockedPorts, evidence: plugSweeps.length ? "inferred" : "unknown" },
    findings,
  };
  return result;
}
