import type { CaseAdapterArtifactPayload } from "../adapters/registry";
import type { DeclarativeProfileDocument } from "../adapters/runtime-model-schema";
import type { FactRecord } from "../facts/contracts";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";

export type BackplaneCapacityStatus = "not_required" | "sufficient" | "insufficient" | "unknown";

export interface BackplaneLeadCounts {
  readonly sata: number | null;
  readonly molex: number | null;
  readonly total: number | null;
}

export interface BackplaneCapacityScope {
  readonly scope: "current_plan" | "full_backplane";
  readonly occupiedBayCount: number;
  readonly totalBayCount: number;
  readonly pendingStorageInstanceIds: readonly string[];
  readonly requiredPowerLeads: BackplaneLeadCounts | null;
  readonly confirmedPsuPowerLeads: BackplaneLeadCounts;
  readonly status: BackplaneCapacityStatus;
}

/**
 * A read-only projection over one locked case adapter and one exact plan/fact
 * snapshot. Current demand and a hypothetical fully populated backplane are
 * intentionally separate; the latter never creates plan components or cables.
 */
export interface BackplaneCapacityProjection {
  readonly schemaVersion: "backplane-capacity-projection-v1";
  readonly caseInstanceId: string;
  readonly caseSkuId: string;
  readonly psuInstanceId: string | null;
  readonly psuSkuId: string | null;
  readonly manifestHash: string;
  readonly runtimeModelHash: string | null;
  readonly currentDemand: BackplaneCapacityScope;
  readonly fullBackplaneCapability: BackplaneCapacityScope;
  readonly sourceFactIds: readonly string[];
  readonly notes: readonly string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function leadFamily(value: unknown): "sata" | "molex" | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("sata")) return "sata";
  if (normalized.includes("molex") || normalized.includes("pata")) return "molex";
  return null;
}

function selectedPsu(config: BuildConfigV3): ComponentInstance | null {
  const candidates = config.components.filter((component) => component.kind === "psu");
  const primary = candidates.filter((component) => component.role === "primary-power");
  return primary.length === 1 ? primary[0]! : candidates.length === 1 ? candidates[0]! : null;
}

function confirmedPsuLeads(psu: ComponentInstance | null, facts: readonly FactRecord[]): {
  counts: BackplaneLeadCounts;
  factIds: string[];
} {
  if (!psu || psu.identity.status !== "resolved") {
    return { counts: { sata: null, molex: null, total: null }, factIds: [] };
  }
  const psuSkuId = psu.identity.skuId;
  const matching = facts.filter((fact) => fact.status === "active" && fact.authority === "official"
    && fact.subject.kind === "product" && fact.subject.skuId === psuSkuId
    && fact.field === "package.cable_count");
  const totals: Record<"sata" | "molex", number> = { sata: 0, molex: 0 };
  const seen: Record<"sata" | "molex", boolean> = { sata: false, molex: false };
  const factIds: string[] = [];
  for (const fact of matching) {
    const value = record(fact.value);
    const family = leadFamily(value?.connectorFamily);
    const quantity = count(value?.quantity);
    if (family === null || quantity === null) continue;
    totals[family] += quantity;
    seen[family] = true;
    factIds.push(fact.factId);
  }
  const sata = seen.sata ? totals.sata : null;
  const molex = seen.molex ? totals.molex : null;
  return {
    counts: { sata, molex, total: sata !== null && molex !== null ? sata + molex : null },
    factIds: [...new Set(factIds)].sort(),
  };
}

function requirementStatus(required: BackplaneLeadCounts | null, confirmed: BackplaneLeadCounts): BackplaneCapacityStatus {
  if (required === null) return "unknown";
  if (required.total === 0) return "not_required";
  if (required.total !== null && confirmed.total !== null && confirmed.total < required.total) return "insufficient";
  if (required.sata !== null && confirmed.sata !== null && confirmed.sata < required.sata) return "insufficient";
  if (required.molex !== null && confirmed.molex !== null && confirmed.molex < required.molex) return "insufficient";
  if (required.sata !== null && required.molex !== null
    && confirmed.sata !== null && confirmed.molex !== null) return "sufficient";
  return "unknown";
}

function nonBackplaneStorageInstanceIds(config: BuildConfigV3, facts: readonly FactRecord[]): Set<string> {
  const result = new Set<string>();
  for (const component of config.components.filter((candidate) => candidate.kind === "storage_drive" && candidate.identity.status === "resolved")) {
    if (component.identity.status !== "resolved") continue;
    const skuId = component.identity.skuId;
    const interfaceFacts = facts.filter((fact) => fact.status === "active" && fact.authority === "official"
      && fact.subject.kind === "product" && fact.subject.skuId === skuId
      && fact.field === "storage.interface" && typeof fact.value === "string");
    if (interfaceFacts.some((fact) => /(?:nvme|m\.2|usb)/i.test(String(fact.value)))) result.add(component.instanceId);
  }
  return result;
}

export function projectBackplaneCapacities(input: {
  readonly config: BuildConfigV3;
  readonly adapterSnapshot: CaseAdapterArtifactPayload;
  readonly facts: readonly FactRecord[];
}): BackplaneCapacityProjection[] {
  const manifests = Array.isArray(input.adapterSnapshot.caseManifests) ? input.adapterSnapshot.caseManifests : [];
  const runtimeModels = Array.isArray(input.adapterSnapshot.runtimeModels) ? input.adapterSnapshot.runtimeModels : [];
  const psu = selectedPsu(input.config);
  const confirmed = confirmedPsuLeads(psu, input.facts);
  const nonBackplaneStorage = nonBackplaneStorageInstanceIds(input.config, input.facts);
  const caseComponents = input.config.components
    .filter((component) => component.kind === "case" && component.identity.status === "resolved")
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const singleCase = caseComponents.length === 1;
  const projections: BackplaneCapacityProjection[] = [];

  for (const caseComponent of caseComponents) {
    if (caseComponent.identity.status !== "resolved") continue;
    const caseSkuId = caseComponent.identity.skuId;
    const matchingManifests = manifests.filter((candidate) => candidate.identity.skuId === caseSkuId);
    if (matchingManifests.length !== 1) continue;
    const manifest = matchingManifests[0]!;
    const totalBayCount = manifest.mounts
      .filter((mount) => mount.kind === "drive")
      .reduce((total, mount) => total + mount.quantity, 0);
    const models = runtimeModels.filter((candidate) => candidate.manifestHash === manifest.contentHash);
    const model = models.length === 1 ? models[0]! : null;
    const profile = record(model?.documents.profile) as Partial<DeclarativeProfileDocument> | null;
    const profileBackplane = record(profile?.backplanePower);
    const profileConnectors = record(profileBackplane?.connectors);
    // A v1 legacy replay model is executable but cannot promote its unbound
    // connector split into a governed capability statement. The verified
    // manifest still provides the aggregate physical inlet count.
    const modelFieldsGoverned = model?.authorityStatus === "governed_fact_derivation_bound";
    const sataRequired = modelFieldsGoverned ? count(profileConnectors?.sataPower) : null;
    const molexRequired = modelFieldsGoverned ? count(profileConnectors?.molex) : null;
    const profileInlets = modelFieldsGoverned ? count(profileBackplane?.inlets) : null;
    const manifestInlets = manifest.ports
      .filter((port) => port.connectorStandardId.toLowerCase().includes("backplane")
        && port.connectorStandardId.toLowerCase().includes("power"))
      .reduce((total, port) => total + port.quantity, 0);
    const fullRequired: BackplaneLeadCounts | null = sataRequired !== null && molexRequired !== null
      && profileInlets === sataRequired + molexRequired
      ? { sata: sataRequired, molex: molexRequired, total: profileInlets }
      : manifestInlets > 0 ? { sata: null, molex: null, total: manifestInlets } : null;

    const driveMountIds = new Set(manifest.mounts.filter((mount) => mount.kind === "drive").map(({ mountId }) => mountId));
    const placedStorageIds = input.config.placements
      .filter((placement) => placement.mountOwnerInstanceId === caseComponent.instanceId && driveMountIds.has(placement.mountId))
      .map(({ componentInstanceId }) => componentInstanceId)
      .filter((instanceId) => input.config.components.some((component) => component.instanceId === instanceId && component.kind === "storage_drive"));
    const pendingStorageInstanceIds = singleCase
      ? input.config.components.filter((component) => component.kind === "storage_drive"
        && !placedStorageIds.includes(component.instanceId) && !nonBackplaneStorage.has(component.instanceId))
        .map(({ instanceId }) => instanceId).sort()
      : [];
    const currentRequired = pendingStorageInstanceIds.length > 0
      ? null
      : placedStorageIds.length > 0 ? fullRequired : { sata: 0, molex: 0, total: 0 };
    const currentStatus = requirementStatus(currentRequired, confirmed.counts);
    const fullStatus = totalBayCount === 0 ? "not_required" : requirementStatus(fullRequired, confirmed.counts);
    const psuIdentity = psu?.identity.status === "resolved" ? psu.identity.skuId : null;
    const notes = [
      `当前方案范围：${placedStorageIds.length}/${totalBayCount} 个背板盘位已明确放置${pendingStorageInstanceIds.length ? `，${pendingStorageInstanceIds.length} 个存储实例的盘位仍未确定` : ""}。`,
      `未来能力范围：按锁定机箱适配器单独评估 ${totalBayCount}/${totalBayCount} 个盘位；不会向当前方案添加硬盘或线材。`,
      fullStatus === "unknown"
        ? "所选电源缺少足以闭合线材根数与端子类型的官方事实，满背板能力保持 unknown。"
        : fullStatus === "insufficient"
          ? "所选电源的已确认线材不足以满足锁定背板的全部供电入口。"
          : fullStatus === "sufficient"
            ? "所选电源的官方线材数量覆盖锁定背板全部供电入口；仍需执行实例级在手核验。"
            : "该机箱没有需要单独供电的背板盘位。",
    ];
    projections.push({
      schemaVersion: "backplane-capacity-projection-v1",
      caseInstanceId: caseComponent.instanceId,
      caseSkuId,
      psuInstanceId: psu?.instanceId ?? null,
      psuSkuId: psuIdentity,
      manifestHash: manifest.contentHash,
      runtimeModelHash: model?.contentHash ?? null,
      currentDemand: {
        scope: "current_plan",
        occupiedBayCount: placedStorageIds.length,
        totalBayCount,
        pendingStorageInstanceIds,
        requiredPowerLeads: currentRequired,
        confirmedPsuPowerLeads: confirmed.counts,
        status: currentStatus,
      },
      fullBackplaneCapability: {
        scope: "full_backplane",
        occupiedBayCount: totalBayCount,
        totalBayCount,
        pendingStorageInstanceIds: [],
        requiredPowerLeads: fullRequired,
        confirmedPsuPowerLeads: confirmed.counts,
        status: fullStatus,
      },
      sourceFactIds: confirmed.factIds,
      notes,
    });
  }
  return projections;
}
