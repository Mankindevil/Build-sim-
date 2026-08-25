import type { BuildEvaluation } from "../core/evaluate";
import type { ConflictVerdict, EvidenceLevel } from "../core/evidence";
import type { Vec3 } from "../core/geometry";
import type { SpatialSceneModel } from "./model";
import { targetForFinding } from "../plans/finding-targets";

export interface SpatialFindingOverlay {
  id: string;
  verdict: ConflictVerdict;
  evidence: EvidenceLevel;
  message: string;
  partIds: string[];
  editorField: string;
}

export interface SpatialRouteOverlay {
  id: string;
  label: string;
  kind: "power" | "data" | "fan" | "other";
  points: Vec3[];
  pathAvailable: boolean;
  requiredMm: number | null;
  availableLengthMm: number | null;
  evidence: EvidenceLevel;
  verdict: ConflictVerdict;
  findingIds: string[];
  endpointPartIds: [string, string];
}

export interface SpatialDimensionOverlay {
  id: string;
  label: string;
  axis: "x" | "y" | "z";
  from: Vec3;
  to: Vec3;
  valueMm: number;
  evidence: EvidenceLevel;
  sourcePartIds: string[];
}

export interface SpatialHeatSourceOverlay {
  id: string;
  label: string;
  at: Vec3;
  sigmaMm: Vec3;
  watts: number;
  tempC: { lo: number; hi: number };
  evidence: EvidenceLevel;
}

export interface SpatialThermalOverlay {
  available: boolean;
  ambientC: number | null;
  note: "规划热场插值，非 CFD、非实测";
  sources: SpatialHeatSourceOverlay[];
}

export interface SpatialAssemblyStepOverlay {
  id: string;
  label: string;
  kind: "part" | "plug" | "remove" | "refit";
  partIds: string[];
  cableId: string | null;
  portId: string | null;
  reasons: string[];
  deadlocked: boolean;
}

export interface SpatialOverlayModel {
  findings: SpatialFindingOverlay[];
  routes: SpatialRouteOverlay[];
  dimensions: SpatialDimensionOverlay[];
  thermal: SpatialThermalOverlay;
  assembly: SpatialAssemblyStepOverlay[];
}

function aliases(target: string | null, model: SpatialSceneModel): string[] {
  if (!target) return [];
  const direct = model.nodes.find((node) => node.partId === target);
  if (direct) return [direct.partId];
  if (target === "psu-primary") return model.nodes.filter((node) => node.partId === "psu.primary").map((node) => node.partId);
  if (target === "cpu-cooler") return model.nodes.filter((node) => node.kind === "cooler" || node.kind === "radiator").map((node) => node.partId);
  if (target === "drive-array") return model.nodes.filter((node) => node.kind === "drive" || node.kind === "boot").map((node) => node.partId);
  if (target === "memory") return model.nodes.filter((node) => node.kind === "ram").map((node) => node.partId);
  if (target === "case") return ["case-shell"];
  return model.nodes.filter((node) => node.partId.startsWith(target)).map((node) => node.partId);
}

export function configFieldPartIds(field: string, model: SpatialSceneModel): string[] {
  const map: Record<string, (node: SpatialSceneModel["nodes"][number]) => boolean> = {
    caseId: (node) => node.partId === "case-shell",
    boardId: (node) => node.kind === "board",
    cpuId: (node) => node.kind === "cpu",
    "selection.psuId": (node) => node.kind === "psu",
    "selection.coolerId": (node) => node.kind === "cooler" || node.kind === "radiator",
    "selection.gpuId": (node) => node.kind === "gpu",
    "selection.memoryId": (node) => node.kind === "ram",
    "selection.diskCount": (node) => node.kind === "drive" || node.kind === "boot",
    "selection.diskSkuId": (node) => node.kind === "drive",
    "selection.nvmeCount": (node) => node.kind === "m2",
    "selection.boot": (node) => node.kind === "boot" || node.kind === "m2" || node.kind === "usb",
    "selection.hbaMode": (node) => node.kind === "hba" || node.partId === "hba.reserve",
  };
  const predicate = map[field];
  return predicate ? model.nodes.filter(predicate).map((node) => node.partId) : [];
}

function findingParts(evaluation: BuildEvaluation, model: SpatialSceneModel, findingId: string): string[] {
  const finding = evaluation.findings.find((candidate) => candidate.id === findingId);
  if (!finding) return [];
  const existing = new Set(model.nodes.map((node) => node.partId));
  const related = (finding.related ?? []).flatMap((value) => existing.has(value) ? [value] : model.nodes.filter((node) => node.skuId === value || node.partId.startsWith(value)).map((node) => node.partId));
  const targeted = aliases(targetForFinding(finding.id).spatialPartId, model);
  return [...new Set([...related, ...targeted])].sort();
}

function worstVerdict(findings: BuildEvaluation["findings"]): ConflictVerdict {
  return findings.some((finding) => finding.verdict === "bad") ? "bad" : findings.some((finding) => finding.verdict === "warn") ? "warn" : "ok";
}

function caseDimensions(model: SpatialSceneModel): SpatialDimensionOverlay[] {
  const [cx, cy, cz] = model.bounds.c;
  const axes = [
    { axis: "x" as const, value: model.bounds.w, from: [cx - model.bounds.w / 2, cy - model.bounds.h / 2, cz - model.bounds.d / 2] as Vec3, to: [cx + model.bounds.w / 2, cy - model.bounds.h / 2, cz - model.bounds.d / 2] as Vec3, label: "机箱宽" },
    { axis: "y" as const, value: model.bounds.h, from: [cx - model.bounds.w / 2, cy - model.bounds.h / 2, cz - model.bounds.d / 2] as Vec3, to: [cx - model.bounds.w / 2, cy + model.bounds.h / 2, cz - model.bounds.d / 2] as Vec3, label: "机箱高" },
    { axis: "z" as const, value: model.bounds.d, from: [cx + model.bounds.w / 2, cy - model.bounds.h / 2, cz - model.bounds.d / 2] as Vec3, to: [cx + model.bounds.w / 2, cy - model.bounds.h / 2, cz + model.bounds.d / 2] as Vec3, label: "机箱深" },
  ];
  const evidence = model.nodes.find((node) => node.partId === "case-shell")?.sizeEvidence ?? "unknown";
  return axes.map((item) => ({ id: `dimension.case.${item.axis}`, label: `${item.label} ${item.value} mm`, axis: item.axis, from: item.from, to: item.to, valueMm: item.value, evidence, sourcePartIds: ["case-shell"] }));
}

/** Overlay facts are projections of BuildEvaluation only; they never derive a new verdict. */
export function buildSpatialOverlayModel(evaluation: BuildEvaluation, model: SpatialSceneModel): SpatialOverlayModel {
  const findings = evaluation.findings.map((finding) => ({
    id: finding.id,
    verdict: finding.verdict,
    evidence: finding.evidence,
    message: finding.message,
    partIds: findingParts(evaluation, model, finding.id),
    editorField: targetForFinding(finding.id).field,
  }));
  const routes = evaluation.routing.cables.map((cable) => {
    const related = evaluation.findings.filter((finding) => finding.id.includes(cable.id) || finding.id.includes(cable.from.id) || finding.id.includes(cable.to.id));
    return {
      id: cable.id,
      label: cable.label,
      kind: cable.kind,
      points: structuredClone(cable.route?.polyline ?? [cable.from.at, cable.to.at]),
      pathAvailable: Boolean(cable.route),
      requiredMm: cable.requiredMm,
      availableLengthMm: cable.availableLengthMm ?? null,
      evidence: cable.evidence,
      verdict: worstVerdict(related),
      findingIds: related.map((finding) => finding.id).sort(),
      endpointPartIds: [cable.from.partId, cable.to.partId] as [string, string],
    };
  });
  const clearanceDimensions = model.nodes.filter((node) => node.kind === "clearance").map((node) => {
    const valueMm = Math.min(node.box.w, node.box.h, node.box.d);
    const axis: SpatialDimensionOverlay["axis"] = node.box.w === valueMm ? "x" : node.box.h === valueMm ? "y" : "z";
    const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    const from = [...node.box.c] as Vec3; const to = [...node.box.c] as Vec3;
    from[axisIndex] -= valueMm / 2; to[axisIndex] += valueMm / 2;
    return { id: `dimension.${node.partId}`, label: `${node.name} ${valueMm} mm`, axis, from, to, valueMm, evidence: node.evidence, sourcePartIds: [node.partId] };
  });
  const thermal: SpatialThermalOverlay = evaluation.heatField ? {
    available: true,
    ambientC: evaluation.heatField.ambientC,
    note: "规划热场插值，非 CFD、非实测",
    sources: evaluation.heatField.sources.map((source) => ({ id: source.id, label: source.label, at: [...source.at], sigmaMm: [...source.sigmaMm], watts: source.watts, tempC: { ...source.tempC }, evidence: source.evidence })),
  } : { available: false, ambientC: null, note: "规划热场插值，非 CFD、非实测", sources: [] };
  const assembly = evaluation.assembly.steps.map((step) => ({
    id: step.id,
    label: step.label,
    kind: step.kind,
    partIds: step.partId ? aliases(step.partId, model).length ? aliases(step.partId, model) : [step.partId] : [],
    cableId: step.cableId ?? null,
    portId: step.portId ?? null,
    reasons: [...step.reasons],
    deadlocked: Boolean(step.deadlocked),
  }));
  return { findings, routes, dimensions: [...caseDimensions(model), ...clearanceDimensions], thermal, assembly };
}

export function primaryPartForFinding(overlay: SpatialOverlayModel, findingId: string): string | null {
  return overlay.findings.find((finding) => finding.id === findingId)?.partIds[0] ?? null;
}
