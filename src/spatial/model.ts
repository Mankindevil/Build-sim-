import type { BuildEvaluation } from "../core/evaluate";
import type { EvidenceLevel } from "../core/evidence";
import type { CenteredBox, PartKind, PlacedPart, Vec3 } from "../core/geometry";
import type { EngineFinding } from "../core/engine";
import type { FieldProvenance } from "../catalog-search/types";
import type { SkuCatalog, SkuRecord } from "../sku/types";
import { N6_INTERIOR_BOX } from "../adapters/jonsbo-n6/geometry";
import { targetForFinding } from "../plans/finding-targets";

export const SPATIAL_SCENE_SCHEMA_VERSION = "1.0.0" as const;

export type SpatialLayer = "shell" | "structure" | "components" | "storage" | "airflow" | "clearance" | "conflicts";
export type SpatialAnchor = "center";

export interface SpatialSceneNode {
  id: string;
  partId: string;
  name: string;
  kind: PartKind | "shell" | "interior";
  layer: SpatialLayer;
  box: CenteredBox;
  rotation: Vec3;
  anchor: SpatialAnchor;
  skuId: string | null;
  skuName: string | null;
  dimsLabel: string;
  sizeEvidence: EvidenceLevel;
  anchorEvidence: EvidenceLevel;
  evidence: EvidenceLevel;
  provenance: FieldProvenance[];
  findingIds: string[];
  mountedOn: string | null;
  repeatGroup: string | null;
  explodedOffset: Vec3;
  selectable: boolean;
  note: string | null;
}

export interface SpatialSceneModel {
  schemaVersion: typeof SPATIAL_SCENE_SCHEMA_VERSION;
  coordinateSystem: {
    units: "mm";
    origin: "case-envelope-center";
    axes: { x: "right"; y: "up"; z: "rear" };
    anchor: SpatialAnchor;
  };
  caseSkuId: string;
  bounds: CenteredBox;
  nodes: SpatialSceneNode[];
  evaluationFindingIds: string[];
}

const EVIDENCE_RANK: Record<EvidenceLevel, number> = { official: 0, standard: 1, inferred: 2, unknown: 3 };

export function weakestEvidence(...levels: EvidenceLevel[]): EvidenceLevel {
  return levels.reduce((weakest, level) => EVIDENCE_RANK[level] > EVIDENCE_RANK[weakest] ? level : weakest, "official");
}

function skuById(catalog: SkuCatalog, id: string | undefined): SkuRecord | undefined {
  return id ? catalog.skus.find((candidate) => candidate.id === id) : undefined;
}

function findingsForPart(findings: EngineFinding[], part: Pick<PlacedPart, "id" | "skuId" | "group" | "kind">): string[] {
  return findings
    .filter((finding) => {
      const target = targetForFinding(finding.id).spatialPartId;
      return finding.related?.some((related) => related === part.id || related === part.skuId || related === part.group)
        || target === part.id
        || (target === "drive-array" && (part.kind === "drive" || part.kind === "empty" || part.id.startsWith("tray.")))
        || (target === "memory" && part.kind === "ram")
        || (target === "case" && part.kind === "chassis");
    })
    .map((finding) => finding.id)
    .sort();
}

function layerFor(part: PlacedPart): SpatialLayer {
  if (part.kind === "conflict") return "conflicts";
  if (part.kind === "clearance" || part.kind === "reserve") return "clearance";
  if (part.kind === "fan") return "airflow";
  if (["drive", "empty", "boot"].includes(part.kind)) return "storage";
  if (["chassis", "deck", "pcb", "connector"].includes(part.kind)) return "structure";
  return "components";
}

function repeatGroupFor(part: PlacedPart): string | null {
  if (part.kind === "drive" || part.kind === "empty") return `tray:${part.kind}`;
  if (part.kind === "fan") return part.group ? `fan:${part.group}` : "fan";
  if (part.kind === "ram") return "ram";
  if (part.kind === "m2") return "m2";
  if (part.kind === "connector") return part.group ? `connector:${part.group}` : "connector";
  return null;
}

function explodedOffsetFor(box: CenteredBox): Vec3 {
  const [x, y, z] = box.c;
  const length = Math.hypot(x, y, z);
  if (length < 0.001) return [0, 0, 0];
  return [x / length, y / length, z / length];
}

function nodeFromPart(part: PlacedPart, catalog: SkuCatalog, findings: EngineFinding[]): SpatialSceneNode {
  const sku = skuById(catalog, part.skuId);
  return {
    id: `part:${part.id}`,
    partId: part.id,
    name: part.name,
    kind: part.kind,
    layer: layerFor(part),
    box: structuredClone(part.box),
    rotation: [0, 0, 0],
    anchor: "center",
    skuId: part.skuId ?? null,
    skuName: sku?.name ?? null,
    dimsLabel: part.dimsLabel,
    sizeEvidence: part.sizeEvidence,
    anchorEvidence: part.anchorEvidence,
    evidence: weakestEvidence(part.sizeEvidence, part.anchorEvidence),
    provenance: structuredClone(sku?.provenance ?? []),
    findingIds: findingsForPart(findings, part),
    mountedOn: part.mountedOn ?? null,
    repeatGroup: repeatGroupFor(part),
    explodedOffset: explodedOffsetFor(part.box),
    selectable: part.kind !== "empty",
    note: part.note ?? null,
  };
}

function envelopeFromCase(sku: SkuRecord): CenteredBox {
  const { widthMm, heightMm, lengthMm } = sku.dims;
  if (![widthMm, heightMm, lengthMm].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    throw new Error(`Case SKU ${sku.id} has no complete millimetre envelope`);
  }
  return { c: [0, 0, 0], w: widthMm!, h: heightMm!, d: lengthMm! };
}

function syntheticNode(
  id: "case-shell" | "case-interior",
  name: string,
  kind: "shell" | "interior",
  box: CenteredBox,
  caseSku: SkuRecord,
  sizeEvidence: EvidenceLevel,
): SpatialSceneNode {
  return {
    id,
    partId: id,
    name,
    kind,
    layer: "shell",
    box: structuredClone(box),
    rotation: [0, 0, 0],
    anchor: "center",
    skuId: caseSku.id,
    skuName: caseSku.name,
    dimsLabel: `${box.w} × ${box.d} × ${box.h} mm`,
    sizeEvidence,
    anchorEvidence: "standard",
    evidence: weakestEvidence(sizeEvidence, "standard"),
    provenance: structuredClone(caseSku.provenance ?? []),
    findingIds: [],
    mountedOn: null,
    repeatGroup: null,
    explodedOffset: [0, 0, 0],
    selectable: id === "case-shell",
    note: id === "case-shell" ? caseSku.dims.note ?? null : "可用内部空间来自 N6 统一几何源。",
  };
}

/** Renderer-neutral scene facts. It derives no verdicts and owns no dimensions. */
export function buildSpatialSceneModel(evaluation: BuildEvaluation, catalog: SkuCatalog): SpatialSceneModel {
  const caseSku = skuById(catalog, evaluation.config.caseId);
  if (!caseSku) throw new Error(`Unknown case SKU: ${evaluation.config.caseId}`);
  const bounds = envelopeFromCase(caseSku);
  const findings = evaluation.findings ?? [];
  const shell = syntheticNode("case-shell", `${caseSku.name} 外壳`, "shell", bounds, caseSku, caseSku.dims.evidence);
  const interior = syntheticNode("case-interior", "N6 内部可用空间", "interior", N6_INTERIOR_BOX, caseSku, "inferred");
  shell.findingIds = findings.filter((finding) => targetForFinding(finding.id).spatialPartId === "case").map((finding) => finding.id).sort();
  const nodes = [shell, interior, ...evaluation.geometry.map((part) => nodeFromPart(part, catalog, findings))];
  return {
    schemaVersion: SPATIAL_SCENE_SCHEMA_VERSION,
    coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" },
    caseSkuId: caseSku.id,
    bounds,
    nodes,
    evaluationFindingIds: findings.map((finding) => finding.id).sort(),
  };
}

export function sceneNode(model: SpatialSceneModel, partId: string): SpatialSceneNode | null {
  return model.nodes.find((node) => node.partId === partId || node.id === partId) ?? null;
}
