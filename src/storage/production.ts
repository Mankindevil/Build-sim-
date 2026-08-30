import type { FactRecord } from "../facts/contracts";
import type { UserObservation } from "../observations/contracts";
import { hashPlanConfig, sha256Hex } from "../plans/canonical";
import type { BuildConfigV3, ComponentInstance, LogicalLayoutSelection } from "../topology/contracts";
import type { StorageLayoutEvaluation } from "./contracts";
import { evaluateTrueNasLayout, type StorageDiskAuthority } from "./truenas";

export interface ProductionStorageLayoutReady {
  readonly status: "ready";
  readonly layoutId: string;
  readonly evaluation: StorageLayoutEvaluation;
  readonly disks: readonly StorageDiskAuthority[];
}

export interface ProductionStorageLayoutBlocked {
  readonly status: "blocked";
  readonly layoutId: string;
  readonly reasons: readonly string[];
  readonly missingInstanceIds: readonly string[];
}

export type ProductionStorageLayoutProjection = ProductionStorageLayoutReady | ProductionStorageLayoutBlocked;

export interface ProductionStorageLayoutInput {
  readonly config: BuildConfigV3;
  readonly configHash: string;
  readonly selection: LogicalLayoutSelection;
  readonly facts: readonly FactRecord[];
  readonly observations: readonly UserObservation[];
}

function officialComponentFacts(
  facts: readonly FactRecord[],
  component: ComponentInstance,
  field: string,
): FactRecord[] {
  if (component.identity.status !== "resolved") return [];
  const skuId = component.identity.skuId;
  return facts.filter((fact) => fact.status === "active" && fact.authority === "official" && fact.field === field
    && fact.subject.kind === "product" && fact.subject.skuId === skuId);
}

function oneFact(
  facts: readonly FactRecord[],
  component: ComponentInstance,
  field: string,
): FactRecord | null {
  const matches = officialComponentFacts(facts, component, field);
  return matches.length === 1 ? matches[0]! : null;
}

function diskMedia(fact: FactRecord): StorageDiskAuthority["media"] | null {
  if (fact.value === "cmr") return "CMR";
  if (fact.value === "smr") return "SMR";
  return ["slc", "mlc", "tlc", "qlc"].includes(String(fact.value)) ? "SSD" : null;
}

function storageTransport(fact: FactRecord): StorageDiskAuthority["path"]["transport"] | null {
  const value = String(fact.value).toLowerCase();
  if (value.includes("nvme")) return "nvme";
  if (value.includes("sas")) return "sas";
  if (value.includes("sata")) return "sata";
  if (value.includes("usb")) return "usb";
  return null;
}

function connectionPeer(config: BuildConfigV3, instanceId: string): Array<{
  component: ComponentInstance;
  localPortId: string;
  peerPortId: string;
  connectionId: string;
  cableInstanceId: string | null;
}> {
  const byId = new Map(config.components.map((component) => [component.instanceId, component]));
  return config.connections.flatMap((connection) => {
    if (connection.status === "blocked" || connection.status === "required") return [];
    if (connection.from.instanceId === instanceId) {
      const component = byId.get(connection.to.instanceId);
      return component ? [{
        component, localPortId: connection.from.portId, peerPortId: connection.to.portId,
        connectionId: connection.connectionId, cableInstanceId: connection.cableInstanceId ?? null,
      }] : [];
    }
    if (connection.to.instanceId === instanceId) {
      const component = byId.get(connection.from.instanceId);
      return component ? [{
        component, localPortId: connection.to.portId, peerPortId: connection.from.portId,
        connectionId: connection.connectionId, cableInstanceId: connection.cableInstanceId ?? null,
      }] : [];
    }
    return [];
  });
}

function resolveController(config: BuildConfigV3, disk: ComponentInstance): {
  controller: ComponentInstance;
  controllerPortId: string;
  pathInstanceIds: string[];
  backplaneInstanceId: string | null;
  connectionIds: string[];
  cableInstanceIds: string[];
} | null {
  const direct = connectionPeer(config, disk.instanceId);
  if (direct.length !== 1) return null;
  const first = direct[0]!;
  if (["motherboard", "hba", "raid_controller"].includes(first.component.kind)) {
    return {
      controller: first.component, controllerPortId: first.peerPortId,
      pathInstanceIds: [disk.instanceId, first.component.instanceId], backplaneInstanceId: null,
      connectionIds: [first.connectionId], cableInstanceIds: first.cableInstanceId ? [first.cableInstanceId] : [],
    };
  }
  if (first.component.kind !== "backplane") return null;
  const upstream = connectionPeer(config, first.component.instanceId)
    .filter(({ component }) => component.instanceId !== disk.instanceId
      && ["motherboard", "hba", "raid_controller"].includes(component.kind));
  if (upstream.length !== 1) return null;
  return {
    controller: upstream[0]!.component,
    controllerPortId: upstream[0]!.peerPortId,
    pathInstanceIds: [disk.instanceId, first.component.instanceId, upstream[0]!.component.instanceId],
    backplaneInstanceId: first.component.instanceId,
    connectionIds: [first.connectionId, upstream[0]!.connectionId].sort(),
    cableInstanceIds: [first.cableInstanceId, upstream[0]!.cableInstanceId].filter((value): value is string => value !== null).sort(),
  };
}

function controllerMode(
  facts: readonly FactRecord[],
  controller: ComponentInstance,
  transport: StorageDiskAuthority["path"]["transport"],
): { mode: StorageDiskAuthority["path"]["controllerMode"]; factIds: string[] } {
  const mode = oneFact(facts, controller, "hba.mode");
  if (mode?.value === "it") return { mode: "it", factIds: [mode.factId] };
  if (mode?.value === "raid" || mode?.value === "ir") return { mode: "raid", factIds: [mode.factId] };
  // A direct NVMe endpoint has no opaque RAID translation layer. SATA/SAS
  // still requires an explicit governed controller-mode fact.
  if (controller.kind === "motherboard" && transport === "nvme") return { mode: "ahci", factIds: [] };
  return { mode: "unknown", factIds: mode ? [mode.factId] : [] };
}

function locatorFor(
  observations: readonly UserObservation[],
  planId: string,
  configHash: string,
  instanceId: string,
  subjectRevisionHash: string,
): string | null {
  const matches = observations.filter((observation) => observation.status === "active"
    && observation.confirmedByUser && observation.validatedAt !== undefined && observation.invalidatedAt === undefined
    && observation.fieldId === "storage.disk_locator" && observation.subjectRef.kind === "instance"
    && observation.subjectRef.instanceId === instanceId && observation.planId === planId
    && observation.observedAgainstConfigHash === configHash
    && observation.subjectRevisionHash === subjectRevisionHash);
  return matches.length === 1 ? matches[0]!.observationId : null;
}

/**
 * Resolves a TrueNAS layout only from the locked config/fact/observation
 * closure. Missing capacity, media or a unique physical path remains blocked;
 * catalog convenience fields never substitute for governed facts.
 */
export async function projectProductionTrueNasLayout(
  input: ProductionStorageLayoutInput,
): Promise<ProductionStorageLayoutProjection> {
  const selectedIds = [...new Set([
    ...input.selection.bootPoolDiskIds,
    ...input.selection.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
    ...input.selection.spareDiskIds,
  ])].sort();
  const byId = new Map(input.config.components.map((component) => [component.instanceId, component]));
  if (await hashPlanConfig(input.config) !== input.configHash) return {
    status: "blocked",
    layoutId: input.selection.layoutId,
    reasons: ["layout config hash does not match the locked plan config"],
    missingInstanceIds: selectedIds,
  };
  const disks: StorageDiskAuthority[] = [];
  const reasons: string[] = [];
  const missing = new Set<string>();
  for (const instanceId of selectedIds) {
    const disk = byId.get(instanceId);
    if (!disk || disk.kind !== "storage_drive" || disk.identity.status !== "resolved") {
      reasons.push(`${instanceId}: selected disk identity is unresolved`); missing.add(instanceId); continue;
    }
    const capacityFact = oneFact(input.facts, disk, "storage.capacity_bytes");
    const mediaFact = oneFact(input.facts, disk, "storage.recording_technology");
    const interfaceFact = oneFact(input.facts, disk, "storage.interface");
    const capacityBytes = capacityFact?.unit === "byte" && typeof capacityFact.value === "number"
      && Number.isSafeInteger(capacityFact.value) && capacityFact.value > 0 ? capacityFact.value : null;
    const media = mediaFact ? diskMedia(mediaFact) : null;
    const transport = interfaceFact ? storageTransport(interfaceFact) : null;
    const path = resolveController(input.config, disk);
    if (capacityBytes === null) reasons.push(`${instanceId}: exact official storage.capacity_bytes fact is missing`);
    if (media === null) reasons.push(`${instanceId}: exact official recording technology fact is missing`);
    if (transport === null) reasons.push(`${instanceId}: exact official storage interface fact is missing`);
    if (path === null) reasons.push(`${instanceId}: one unique disk-to-controller path is missing`);
    if (capacityBytes === null || media === null || transport === null || path === null) { missing.add(instanceId); continue; }
    const mode = controllerMode(input.facts, path.controller, transport);
    const placement = input.config.placements.find(({ componentInstanceId }) => componentInstanceId === instanceId);
    const revisionHash = await sha256Hex(disk);
    disks.push({
      instanceId,
      capacityBytes,
      media,
      faultDomain: placement?.mountOwnerInstanceId ?? path.controller.instanceId,
      revisionHash,
      factIds: [capacityFact!.factId, mediaFact!.factId, interfaceFact!.factId].sort(),
      locatorObservationId: locatorFor(
        input.observations,
        input.config.id,
        input.configHash,
        instanceId,
        revisionHash,
      ),
      path: {
        controllerInstanceId: path.controller.instanceId,
        controllerPortId: path.controllerPortId,
        backplaneInstanceId: path.backplaneInstanceId,
        connectionIds: path.connectionIds,
        cableInstanceIds: path.cableInstanceIds,
        transport,
        controllerMode: mode.mode,
        factIds: mode.factIds,
      },
    });
  }
  if (reasons.length > 0) return {
    status: "blocked", layoutId: input.selection.layoutId,
    reasons: [...new Set(reasons)].sort(), missingInstanceIds: [...missing].sort(),
  };
  return {
    status: "ready",
    layoutId: input.selection.layoutId,
    disks,
    evaluation: evaluateTrueNasLayout({
      selection: structuredClone(input.selection),
      disks,
      systemProfileId: "system.truenas-scale",
    }),
  };
}
