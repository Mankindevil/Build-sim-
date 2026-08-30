import type { CaseAdapterArtifactPayload, CaseAdapterManifest, CaseAdapterRuntimeIdentity } from "../adapters";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import type { CenteredBox, PartKind, Vec3 } from "../core/geometry";
import type { EvidenceLevel } from "../core/evidence";
import { buildGenericRouteGraph, solveRouteGeometry, type RoutableZone, type RoutingOpening } from "../routing";
import type { SpatialOverlayModel } from "./overlays";
import { SPATIAL_SCENE_SCHEMA_VERSION, type SpatialSceneModel, type SpatialSceneNode } from "./model";

export const AUTHORITATIVE_SPATIAL_SCENE_SCHEMA_VERSION = "authoritative-spatial-scene-v1" as const;

export interface AuthoritativeSpatialSceneSnapshot {
  readonly schemaVersion: typeof AUTHORITATIVE_SPATIAL_SCENE_SCHEMA_VERSION;
  readonly planId: string;
  readonly planVersionId: string;
  readonly configHash: string;
  readonly evaluationHash: string;
  readonly evaluationLockHash: string;
  readonly adapterSnapshotHash: string;
  readonly caseInstanceId: string;
  readonly caseIdentity: {
    readonly skuId: string;
    readonly region: string;
    readonly revision: string;
    readonly manifestHash: string;
  };
  readonly executionStatus: "ready" | "partial";
  readonly blockedDomains: ReadonlyArray<"component_placement" | "routing" | "assembly">;
  readonly model: SpatialSceneModel;
  readonly overlays: SpatialOverlayModel;
}

function box(centerMm: readonly number[], sizeMm: readonly number[]): CenteredBox {
  return {
    c: [centerMm[0]!, centerMm[1]!, centerMm[2]!],
    w: sizeMm[0]!,
    h: sizeMm[1]!,
    d: sizeMm[2]!,
  };
}

function evidenceFor(status: "verified" | "provisional"): EvidenceLevel {
  // Binding status proves geometric identity, not source authority. Avoid
  // promoting a third-party verified fact to "official" in the renderer.
  return status === "provisional" ? "inferred" : "unknown";
}

function node(input: {
  id: string;
  name: string;
  kind: PartKind | "shell" | "interior";
  layer: SpatialSceneNode["layer"];
  box: CenteredBox;
  evidence: EvidenceLevel;
  sourceFactIds: readonly string[];
  derivationIds: readonly string[];
  uncertaintyMm: number;
  skuId?: string | null;
  selectable?: boolean;
}): SpatialSceneNode {
  const note = [
    input.sourceFactIds.length ? `facts: ${input.sourceFactIds.join(", ")}` : null,
    input.derivationIds.length ? `derivations: ${input.derivationIds.join(", ")}` : null,
    input.uncertaintyMm > 0 ? `±${input.uncertaintyMm} mm` : null,
  ].filter(Boolean).join(" · ");
  const [x, y, z] = input.box.c;
  const length = Math.hypot(x, y, z);
  return {
    id: input.id,
    partId: input.id,
    name: input.name,
    kind: input.kind,
    layer: input.layer,
    box: structuredClone(input.box),
    rotation: [0, 0, 0],
    anchor: "center",
    skuId: input.skuId ?? null,
    skuName: null,
    dimsLabel: `${input.box.w} × ${input.box.d} × ${input.box.h} mm`,
    sizeEvidence: input.evidence,
    anchorEvidence: input.evidence,
    evidence: input.evidence,
    provenance: [],
    findingIds: [],
    mountedOn: null,
    repeatGroup: null,
    explodedOffset: length > 0.001 ? [x / length, y / length, z / length] : [0, 0, 0],
    selectable: input.selectable ?? true,
    note: note || null,
  };
}

function caseComponent(config: BuildConfigV3): ComponentInstance {
  const cases = config.components.filter((component) => component.kind === "case");
  if (cases.length !== 1) throw new TypeError("spatial scene requires exactly one case instance");
  const selected = cases[0]!;
  if (selected.identity.status !== "resolved") throw new TypeError("spatial scene case identity is unresolved");
  return selected;
}

function manifestFor(payload: CaseAdapterArtifactPayload, component: ComponentInstance): CaseAdapterManifest {
  if (component.identity.status !== "resolved") throw new TypeError("spatial scene case identity is unresolved");
  const skuId = component.identity.skuId;
  const matches = payload.caseManifests.filter((manifest) => manifest.identity.skuId === skuId);
  if (matches.length !== 1) throw new TypeError("spatial scene case manifest is missing or ambiguous");
  return matches[0]!;
}

function descriptorFor(payload: CaseAdapterArtifactPayload, manifest: CaseAdapterManifest): CaseAdapterRuntimeIdentity {
  const matches = payload.runtimeAdapters.filter((descriptor) => descriptor.manifestHash === manifest.contentHash);
  if (matches.length !== 1) throw new TypeError("spatial scene runtime descriptor is missing or ambiguous");
  return matches[0]!;
}

function manifestNodes(manifest: CaseAdapterManifest): SpatialSceneNode[] {
  const result: SpatialSceneNode[] = [];
  const envelope = manifest.geometry.envelope;
  result.push(node({
    id: "case-shell",
    name: manifest.identity.skuId,
    kind: "shell",
    layer: "shell",
    box: box(envelope.centerMm, envelope.sizeMm),
    evidence: evidenceFor(envelope.binding.status),
    sourceFactIds: envelope.binding.sourceFactIds,
    derivationIds: envelope.binding.derivationIds,
    uncertaintyMm: envelope.binding.uncertaintyMm,
    skuId: manifest.identity.skuId,
  }));
  for (const space of manifest.geometry.interiorSpaces) result.push(node({
    id: `interior:${space.nodeId}`,
    name: space.nodeId,
    kind: "interior",
    layer: "shell",
    box: box(space.centerMm, space.sizeMm),
    evidence: evidenceFor(space.binding.status),
    sourceFactIds: space.binding.sourceFactIds,
    derivationIds: space.binding.derivationIds,
    uncertaintyMm: space.binding.uncertaintyMm,
    selectable: false,
  }));
  for (const zone of manifest.geometry.forbiddenZones) result.push(node({
    id: `forbidden:${zone.nodeId}`,
    name: `禁止占用 · ${zone.nodeId}`,
    kind: "conflict",
    layer: "conflicts",
    box: box(zone.centerMm, zone.sizeMm),
    evidence: evidenceFor(zone.binding.status),
    sourceFactIds: zone.binding.sourceFactIds,
    derivationIds: zone.binding.derivationIds,
    uncertaintyMm: zone.binding.uncertaintyMm,
  }));
  for (const corridor of manifest.geometry.serviceCorridors) result.push(node({
    id: `service:${corridor.nodeId}`,
    name: `维护空间 · ${corridor.nodeId}`,
    kind: "clearance",
    layer: "clearance",
    box: box(corridor.centerMm, corridor.sizeMm),
    evidence: evidenceFor(corridor.binding.status),
    sourceFactIds: corridor.binding.sourceFactIds,
    derivationIds: corridor.binding.derivationIds,
    uncertaintyMm: corridor.binding.uncertaintyMm,
  }));
  for (const zone of manifest.routingZones) result.push(node({
    id: `route-zone:${zone.zoneId}`,
    name: `走线区域 · ${zone.zoneId}`,
    kind: "reserve",
    layer: "clearance",
    box: box(zone.centerMm, zone.sizeMm),
    evidence: evidenceFor(zone.binding.status),
    sourceFactIds: zone.binding.sourceFactIds,
    derivationIds: zone.binding.derivationIds,
    uncertaintyMm: zone.binding.uncertaintyMm,
  }));
  for (const port of manifest.ports) {
    const size = Math.max(4, port.binding.uncertaintyMm * 2);
    result.push(node({
      id: `port:${port.portId}`,
      name: `${port.connectorStandardId} · ${port.direction}`,
      kind: "connector",
      layer: "structure",
      box: box(port.anchorMm, [size, size, size]),
      evidence: evidenceFor(port.binding.status),
      sourceFactIds: port.binding.sourceFactIds,
      derivationIds: port.binding.derivationIds,
      uncertaintyMm: port.binding.uncertaintyMm,
    }));
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function dimensions(bounds: CenteredBox, evidence: EvidenceLevel): SpatialOverlayModel["dimensions"] {
  const [x, y, z] = bounds.c;
  return [
    { id: "dimension.case.x", label: `机箱宽 ${bounds.w} mm`, axis: "x", from: [x - bounds.w / 2, y - bounds.h / 2, z - bounds.d / 2], to: [x + bounds.w / 2, y - bounds.h / 2, z - bounds.d / 2], valueMm: bounds.w, evidence, sourcePartIds: ["case-shell"] },
    { id: "dimension.case.y", label: `机箱高 ${bounds.h} mm`, axis: "y", from: [x - bounds.w / 2, y - bounds.h / 2, z - bounds.d / 2], to: [x - bounds.w / 2, y + bounds.h / 2, z - bounds.d / 2], valueMm: bounds.h, evidence, sourcePartIds: ["case-shell"] },
    { id: "dimension.case.z", label: `机箱深 ${bounds.d} mm`, axis: "z", from: [x + bounds.w / 2, y - bounds.h / 2, z - bounds.d / 2], to: [x + bounds.w / 2, y - bounds.h / 2, z + bounds.d / 2], valueMm: bounds.d, evidence, sourcePartIds: ["case-shell"] },
  ] as SpatialOverlayModel["dimensions"];
}

function capacityAreaMm2(sizeMm: readonly number[]): number {
  const crossSection = [...sizeMm].sort((left, right) => left - right).slice(0, 2);
  return crossSection[0]! * crossSection[1]!;
}

function routeDirection(from: Vec3, to: Vec3): Vec3 {
  const vector = [to[0] - from[0], to[1] - from[1], to[2] - from[2]] as Vec3;
  const length = Math.hypot(...vector);
  return length > 0.000001 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

function connectionKind(connectorStandardIds: readonly string[]): "power" | "data" | "fan" | "other" {
  const material = connectorStandardIds.join(" ").toLowerCase();
  if (material.includes("power") || material.includes("eps") || material.includes("atx") || material.includes("12v")) return "power";
  if (material.includes("fan") || material.includes("pwm")) return "fan";
  if (material.includes("sata") || material.includes("usb") || material.includes("data")) return "data";
  return "other";
}

function manifestRoutes(
  manifest: CaseAdapterManifest,
  config: BuildConfigV3,
  caseInstanceId: string,
): { routes: SpatialOverlayModel["routes"]; unresolvedConnectionIds: string[] } {
  if (config.connections.length === 0) return { routes: [], unresolvedConnectionIds: [] };
  const provenance = (binding: CaseAdapterManifest["routingZones"][number]["binding"]) => ({
    authority: "derived" as const,
    sourceRefs: binding.sourceFactIds.map((id) => `fact:${id}`),
    derivationIds: [...binding.derivationIds],
    scope: "product" as const,
  });
  const zones: RoutableZone[] = manifest.routingZones.filter((zone) => zone.kind !== "opening").map((zone) => ({
    zoneId: zone.zoneId,
    ownerInstanceId: caseInstanceId,
    volume: { centerMm: zone.centerMm, sizeMm: zone.sizeMm },
    capacityAreaMm2: capacityAreaMm2(zone.sizeMm),
    provenance: provenance(zone.binding),
  }));
  const openings: RoutingOpening[] = manifest.routingZones.filter((zone) => zone.kind === "opening" && zone.connectsToZoneIds.length === 2).map((zone) => {
    const dimensions = [...zone.sizeMm].sort((left, right) => left - right);
    return {
      openingId: zone.zoneId,
      ownerInstanceId: caseInstanceId,
      centerMm: zone.centerMm,
      sizeMm: [dimensions[0]!, dimensions[1]!] as const,
      connectsZoneIds: [zone.connectsToZoneIds[0]!, zone.connectsToZoneIds[1]!] as const,
      provenance: provenance(zone.binding),
    };
  });
  if (zones.length === 0) return { routes: [], unresolvedConnectionIds: config.connections.map((connection) => connection.connectionId) };
  let graph;
  try {
    graph = buildGenericRouteGraph(zones, openings, new Set([caseInstanceId]));
  } catch {
    return { routes: [], unresolvedConnectionIds: config.connections.map((connection) => connection.connectionId) };
  }
  const portById = new Map(manifest.ports.map((port) => [port.portId, port]));
  const unresolvedConnectionIds: string[] = [];
  const routes: SpatialOverlayModel["routes"] = [];
  for (const connection of [...config.connections].sort((left, right) => left.connectionId.localeCompare(right.connectionId))) {
    if (connection.from.instanceId !== caseInstanceId || connection.to.instanceId !== caseInstanceId) {
      unresolvedConnectionIds.push(connection.connectionId);
      continue;
    }
    const from = portById.get(connection.from.portId);
    const to = portById.get(connection.to.portId);
    if (!from || !to || from.portId === to.portId) {
      unresolvedConnectionIds.push(connection.connectionId);
      continue;
    }
    const route = solveRouteGeometry(graph, from.anchorMm, to.anchorMm);
    const direct = [from.anchorMm, to.anchorMm] as [Vec3, Vec3];
    const points = (route?.polylineMm ?? direct).map((point) => [...point] as Vec3);
    const uncertaintyMm = Math.max(
      from.binding.uncertaintyMm,
      to.binding.uncertaintyMm,
      ...manifest.routingZones.map((zone) => zone.binding.uncertaintyMm),
    );
    const pathAvailable = route !== null;
    if (!pathAvailable) unresolvedConnectionIds.push(connection.connectionId);
    routes.push({
      id: connection.connectionId,
      label: `${from.connectorStandardId} → ${to.connectorStandardId}`,
      kind: connectionKind([from.connectorStandardId, to.connectorStandardId]),
      points,
      pathAvailable,
      requiredMm: (route?.geometricLengthMm ?? Math.hypot(
        to.anchorMm[0] - from.anchorMm[0],
        to.anchorMm[1] - from.anchorMm[1],
        to.anchorMm[2] - from.anchorMm[2],
      )) * 1.15,
      availableLengthMm: null,
      evidence: uncertaintyMm > 0 ? "inferred" : weakestManifestEvidence(from.binding.status, to.binding.status),
      verdict: "warn",
      findingIds: pathAvailable ? [] : [`spatial.route-blocked:${connection.connectionId}`],
      endpointPartIds: ["case-shell", "case-shell"],
      endpointDirections: points.length >= 2 ? [
        { at: points[0]!, direction: routeDirection(points[0]!, points[1]!) },
        { at: points.at(-1)!, direction: routeDirection(points.at(-2)!, points.at(-1)!) },
      ] : [],
      toleranceMm: uncertaintyMm,
      alternativePaths: [],
      blockedPoints: pathAvailable ? [] : [[
        (from.anchorMm[0] + to.anchorMm[0]) / 2,
        (from.anchorMm[1] + to.anchorMm[1]) / 2,
        (from.anchorMm[2] + to.anchorMm[2]) / 2,
      ]],
    });
  }
  return { routes, unresolvedConnectionIds: [...new Set(unresolvedConnectionIds)].sort() };
}

function weakestManifestEvidence(...statuses: Array<"verified" | "provisional">): EvidenceLevel {
  return statuses.includes("provisional") ? "inferred" : "unknown";
}

export function buildAuthoritativeSpatialScene(input: {
  planId: string;
  planVersionId: string;
  config: BuildConfigV3;
  configHash: string;
  evaluationHash: string;
  evaluationLockHash: string;
  adapterSnapshotHash: string;
  adapterPayload: CaseAdapterArtifactPayload;
}): AuthoritativeSpatialSceneSnapshot {
  const component = caseComponent(input.config);
  const manifest = manifestFor(input.adapterPayload, component);
  const descriptor = descriptorFor(input.adapterPayload, manifest);
  const nodes = manifestNodes(manifest);
  const shell = nodes.find((candidate) => candidate.id === "case-shell")!;
  const hasUnrenderedComponents = input.config.components.some((candidate) => candidate.instanceId !== component.instanceId);
  const hasPlacedComponents = input.config.placements.some((placement) => placement.mountOwnerInstanceId === component.instanceId);
  const routeProjection = manifestRoutes(manifest, input.config, component.instanceId);
  // The authoritative scene currently renders manifest-bound case geometry,
  // not world poses for arbitrary component instances. An authored placement
  // and a selected-but-unplaced component are therefore equally unresolved;
  // treating the latter as ready would hide the exact gap in partial plans.
  const placementBlocked = hasPlacedComponents || hasUnrenderedComponents;
  // A route cannot be authoritative while one of its potentially connected
  // component placements has no world pose, even when no connection edge has
  // been authored yet.
  const routingBlocked = placementBlocked || routeProjection.unresolvedConnectionIds.length > 0;
  const assemblyBlocked = placementBlocked || routingBlocked;
  const blockedDomains: AuthoritativeSpatialSceneSnapshot["blockedDomains"] = [
    ...(placementBlocked ? ["component_placement" as const] : []),
    ...(routingBlocked ? ["routing" as const] : []),
    ...(assemblyBlocked ? ["assembly" as const] : []),
  ];
  const executionStatus = descriptor.executionStatus === "ready" && blockedDomains.length === 0 ? "ready" : "partial";
  const model: SpatialSceneModel = {
    schemaVersion: SPATIAL_SCENE_SCHEMA_VERSION,
    coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" },
    caseSkuId: manifest.identity.skuId,
    bounds: structuredClone(shell.box),
    nodes,
    evaluationFindingIds: [],
  };
  const overlays: SpatialOverlayModel = {
    findings: [],
    routes: routeProjection.routes,
    dimensions: dimensions(model.bounds, shell.evidence),
    thermal: { available: false, ambientC: null, note: "规划热场插值，非 CFD、非实测", sources: [] },
    assembly: routeProjection.routes.map((route) => ({
      id: `route:${route.id}`,
      label: `连接 ${route.label}`,
      kind: "plug" as const,
      partIds: [...new Set(route.endpointPartIds)],
      cableId: route.id,
      portId: input.config.connections.find((connection) => connection.connectionId === route.id)?.to.portId ?? null,
      reasons: [route.pathAvailable ? "按锁定机箱 route graph 走线" : "当前 route graph 无可用路径"],
      deadlocked: !route.pathAvailable,
    })),
  };
  return {
    schemaVersion: AUTHORITATIVE_SPATIAL_SCENE_SCHEMA_VERSION,
    planId: input.planId,
    planVersionId: input.planVersionId,
    configHash: input.configHash,
    evaluationHash: input.evaluationHash,
    evaluationLockHash: input.evaluationLockHash,
    adapterSnapshotHash: input.adapterSnapshotHash,
    caseInstanceId: component.instanceId,
    caseIdentity: {
      skuId: manifest.identity.skuId,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      manifestHash: manifest.contentHash,
    },
    executionStatus,
    blockedDomains,
    model,
    overlays,
  };
}
