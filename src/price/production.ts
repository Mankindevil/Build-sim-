import { sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { BuildConfigDocument } from "../config/types";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import type { PriceHistoryPoint, PriceObservation, PriceTarget } from "./contracts";
import { projectCurrentChinaPrice, type CurrentPriceProjection } from "./policy";
import { projectCurrentHistoryPoints } from "./history";
import { adviseBuyOrWait, type BuyWaitAdvice } from "./buy-wait";
import { createPriceTarget, revisePriceTarget } from "./targets";
import { PriceRepository, PriceRepositoryError, type VersionedPriceTarget } from "./repository";

const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_RECHECK_CADENCE_SECONDS = 6 * 60 * 60;

export interface PlanPriceTargetAuthority {
  getAtRoot(activeRoot: string, planId: string): Promise<{ draftRevision: number; draft: { config: BuildConfigDocument } }>;
}

export interface PlanPriceSnapshotAuthority {
  currentLockAtRoot(activeRoot: string, planId: string, target: { kind: "draft"; draftRevision: number }): Promise<{
    contentHash: string;
    snapshotHashes: { configHash: string; priceSnapshotHash: string };
  } | null>;
  hydrateExternalInputsAtRoot(activeRoot: string, lock: unknown): Promise<{
    priceSnapshot: { ref: { contentHash: string }; payload: unknown };
  }>;
}

interface LockedPriceSnapshot {
  readonly schemaVersion: string;
  readonly snapshotId: string;
  readonly asOf: string;
  readonly contentHash: string;
  readonly quotes: readonly { readonly provenanceId?: string }[];
}

export interface PlanCurrentPriceObservation {
  readonly observationId: string;
  readonly platform: PriceObservation["platform"];
  readonly sellerId?: string;
  readonly sellerName?: string;
  readonly sellerTier: PriceObservation["sellerTier"];
  readonly stockStatus: PriceObservation["stockStatus"];
  readonly comparableTotalCny: number;
  readonly invoiceStatus: PriceObservation["invoiceStatus"];
  readonly warrantyStatus: PriceObservation["warrantyStatus"];
  readonly canonicalUrl: string;
  readonly capturedAt: string;
  readonly recheckedAt?: string;
  readonly requiredDiscountConditions?: readonly string[];
}

export interface PlanComponentPriceProjection {
  readonly instanceId: string;
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly current: CurrentPriceProjection;
  readonly currentObservations: readonly PlanCurrentPriceObservation[];
  readonly history: readonly PriceHistoryPoint[];
  readonly buyWait: BuyWaitAdvice;
  readonly targets: readonly VersionedPriceTarget[];
}

export interface PlanCurrentPriceView {
  readonly schemaVersion: "plan-current-price-view-v1";
  readonly planId: string;
  readonly draftRevision: number;
  readonly configHash: string;
  readonly evaluationLockHash: string;
  readonly priceSnapshotHash: string;
  readonly priceSnapshotId: string;
  readonly asOf: string;
  readonly components: readonly PlanComponentPriceProjection[];
  readonly unresolvedInstanceIds: readonly string[];
}

export interface CreatePlanPriceTargetInput {
  readonly instanceId: string;
  readonly targetTotalCny: number;
  readonly sellerTierMinimum?: "S1" | "S2" | "S3" | "S4";
  readonly requireMainlandWarranty?: boolean;
  readonly expiresAt?: string;
  readonly enabled?: boolean;
}

export interface RevisePlanPriceTargetInput {
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly expectedRecordHash: string;
  readonly expectedTargetRevisionHash: string;
  readonly targetTotalCny?: number;
  readonly sellerTierMinimum?: "S1" | "S2" | "S3" | "S4";
  readonly requireMainlandWarranty?: boolean;
  readonly expiresAt?: string;
  readonly enabled?: boolean;
}

function exactVariant(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function scheduleIdForTarget(targetId: string): string {
  return `price-target-watch-${sha256Json({ targetId }).slice(0, 32)}`;
}

function replacementFrictionFor(component: ComponentInstance): "low" | "medium" | "high" {
  if (["case", "motherboard", "power-supply"].includes(component.kind)) return "high";
  if (["memory", "storage", "graphics-card"].includes(component.kind)) return "low";
  return "medium";
}

function lockedSnapshot(value: unknown): LockedPriceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("locked price snapshot payload is invalid");
  const snapshot = value as Partial<LockedPriceSnapshot>;
  if (typeof snapshot.schemaVersion !== "string" || typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId
    || typeof snapshot.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf)
    || typeof snapshot.contentHash !== "string" || !SHA256.test(snapshot.contentHash) || !Array.isArray(snapshot.quotes)) {
    throw new TypeError("locked price snapshot identity is invalid");
  }
  if (snapshot.quotes.some((quote) => !quote || typeof quote !== "object" || Array.isArray(quote)
    || ((quote as { provenanceId?: unknown }).provenanceId !== undefined && typeof (quote as { provenanceId?: unknown }).provenanceId !== "string"))) {
    throw new TypeError("locked price snapshot quote provenance is invalid");
  }
  return snapshot as LockedPriceSnapshot;
}

type ResolvedComponent = ComponentInstance & { identity: Extract<ComponentInstance["identity"], { status: "resolved" }> };

function resolvedComponent(config: BuildConfigV3, instanceId: string): ResolvedComponent {
  const component = config.components.find((candidate) => candidate.instanceId === instanceId);
  if (!component || component.identity.status !== "resolved") throw new TypeError("price target instance is missing or unresolved");
  return component as ResolvedComponent;
}

/** One root-pinned view shared by workspace UI and Agent projections. */
export class ProductionPlanPriceService {
  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly prices: PriceRepository;
    readonly plans: PlanPriceTargetAuthority;
    readonly locks: PlanPriceSnapshotAuthority;
    readonly now?: () => string;
  }) {}

  async initialize(): Promise<void> {
    await this.options.coordinator.initialize();
    await this.options.prices.initialize("production-plan-prices-v1");
  }

  async forPlan(planId: string): Promise<PlanCurrentPriceView> {
    await this.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => this.forPlanAtRoot(activeRoot, planId))).result;
  }

  async forPlanAtRoot(activeRoot: string, planId: string): Promise<PlanCurrentPriceView> {
    const plan = await this.options.plans.getAtRoot(activeRoot, planId);
    if (plan.draft.config.schemaVersion !== "3.0.0") throw new TypeError("plan current price view requires BuildConfig V3");
    const lock = await this.options.locks.currentLockAtRoot(activeRoot, planId, { kind: "draft", draftRevision: plan.draftRevision });
    if (!lock || !SHA256.test(lock.contentHash) || !SHA256.test(lock.snapshotHashes.priceSnapshotHash)) throw new TypeError("plan current price view requires a current issued evaluation lock");
    const external = await this.options.locks.hydrateExternalInputsAtRoot(activeRoot, lock);
    if (external.priceSnapshot.ref.contentHash !== lock.snapshotHashes.priceSnapshotHash) throw new TypeError("locked price snapshot hash differs from the plan evaluation");
    const artifact = external.priceSnapshot.payload;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || !("payload" in artifact)) {
      throw new TypeError("locked price artifact payload is invalid");
    }
    const snapshot = lockedSnapshot((artifact as { payload: unknown }).payload);
    const boundObservationIds = new Set(snapshot.quotes.flatMap(({ provenanceId }) => provenanceId ? [provenanceId] : []));
    const [allObservations, allHistory, allTargets] = await Promise.all([
      this.options.prices.listObservationsAtRoot(activeRoot),
      this.options.prices.listHistoryPointsAtRoot(activeRoot),
      this.options.prices.listTargetsAtRoot(activeRoot),
    ]);
    const observations = allObservations.filter(({ observationId }) => boundObservationIds.has(observationId));
    const config = plan.draft.config;
    const components: PlanComponentPriceProjection[] = config.components.flatMap((component) => {
      if (component.identity.status !== "resolved") return [];
      const skuId = component.identity.skuId;
      const variantIdentityFactIds = [...component.identity.identityClaimIds].sort();
      const current = projectCurrentChinaPrice({
        skuId,
        variantIdentityFactIds,
        observations,
        now: `${snapshot.asOf}T23:59:59.999Z`,
      });
      const history = projectCurrentHistoryPoints(allHistory.filter((point) => point.skuId === skuId && exactVariant(point.variantIdentityFactIds, variantIdentityFactIds)))
        .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart) || left.historyPointId.localeCompare(right.historyPointId));
      return [{
        instanceId: component.instanceId,
        skuId,
        variantIdentityFactIds,
        current,
        currentObservations: observations.filter(({ observationId }) => current.selectedObservationIds.includes(observationId))
          .map((observation) => ({
            observationId: observation.observationId,
            platform: observation.platform,
            ...(observation.sellerId === undefined ? {} : { sellerId: observation.sellerId }),
            ...(observation.sellerName === undefined ? {} : { sellerName: observation.sellerName }),
            sellerTier: observation.sellerTier,
            stockStatus: observation.stockStatus,
            comparableTotalCny: observation.comparableTotalCny,
            invoiceStatus: observation.invoiceStatus,
            warrantyStatus: observation.warrantyStatus,
            canonicalUrl: observation.canonicalUrl,
            capturedAt: observation.capturedAt,
            ...(observation.recheckedAt === undefined ? {} : { recheckedAt: observation.recheckedAt }),
            ...(observation.requiredDiscountConditions === undefined ? {} : { requiredDiscountConditions: [...observation.requiredDiscountConditions] }),
          })).sort((left, right) => left.observationId.localeCompare(right.observationId)),
        history,
        buyWait: adviseBuyOrWait({ projection: current, history, replacementFriction: replacementFrictionFor(component) }),
        targets: allTargets.filter(({ target }) => target.planId === planId && target.instanceId === component.instanceId)
          .sort((left, right) => left.target.targetId.localeCompare(right.target.targetId)),
      }];
    }).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    return {
      schemaVersion: "plan-current-price-view-v1",
      planId,
      draftRevision: plan.draftRevision,
      configHash: lock.snapshotHashes.configHash,
      evaluationLockHash: lock.contentHash,
      priceSnapshotHash: lock.snapshotHashes.priceSnapshotHash,
      priceSnapshotId: snapshot.snapshotId,
      asOf: snapshot.asOf,
      components,
      unresolvedInstanceIds: config.components.filter(({ identity }) => identity.status !== "resolved").map(({ instanceId }) => instanceId).sort(),
    };
  }

  async createTarget(planId: string, input: CreatePlanPriceTargetInput): Promise<VersionedPriceTarget> {
    await this.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const plan = await this.options.plans.getAtRoot(activeRoot, planId);
      if (plan.draft.config.schemaVersion !== "3.0.0") throw new TypeError("price targets require BuildConfig V3");
      const component = resolvedComponent(plan.draft.config, input.instanceId);
      const targetId = `price-target-${sha256Json({ planId, instanceId: input.instanceId, skuId: component.identity.skuId }).slice(0, 32)}`;
      const target = await createPriceTarget({
        targetId,
        planId,
        instanceId: input.instanceId,
        skuId: component.identity.skuId,
        variantIdentityFactIds: [...component.identity.identityClaimIds].sort(),
        targetTotalCny: input.targetTotalCny,
        ...(input.sellerTierMinimum === undefined ? {} : { sellerTierMinimum: input.sellerTierMinimum }),
        ...(input.requireMainlandWarranty === undefined ? {} : { requireMainlandWarranty: input.requireMainlandWarranty }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        enabled: input.enabled !== false,
      }, (this.options.now ?? (() => new Date().toISOString()))());
      const stored = await this.options.prices.putTargetAtRoot(activeRoot, target, { expectedRevision: 0 });
      const scheduleId = scheduleIdForTarget(target.targetId);
      try {
        const existing = await this.options.prices.getScheduleAtRoot(activeRoot, scheduleId);
        if (existing.schedule.subjectRef !== `price-target:${target.targetId}` || existing.schedule.jobType !== "price_target_recheck") {
          throw new TypeError("price target schedule identity is invalid");
        }
      } catch (error) {
        if (!(error instanceof PriceRepositoryError) || error.code !== "not_found") throw error;
        await this.options.prices.putScheduleAtRoot(activeRoot, {
          scheduleId,
          jobType: "price_target_recheck",
          subjectRef: `price-target:${target.targetId}`,
          cadenceSeconds: TARGET_RECHECK_CADENCE_SECONDS,
          nextRunAt: target.updatedAt,
          enabled: target.enabled,
        }, { expectedRevision: 0 });
      }
      return stored;
    })).result;
  }

  async reviseTarget(planId: string, input: RevisePlanPriceTargetInput): Promise<VersionedPriceTarget> {
    await this.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const current = await this.options.prices.getTargetAtRoot(activeRoot, input.targetId);
      if (current.target.planId !== planId) throw new TypeError("price target does not belong to the plan");
      const plan = await this.options.plans.getAtRoot(activeRoot, planId);
      if (plan.draft.config.schemaVersion !== "3.0.0" || current.target.instanceId === undefined) throw new TypeError("price target plan authority is unavailable");
      const component = resolvedComponent(plan.draft.config, current.target.instanceId);
      if (component.identity.skuId !== current.target.skuId || !exactVariant(component.identity.identityClaimIds, current.target.variantIdentityFactIds)) {
        throw new TypeError("price target exact variant is stale");
      }
      const revised = await revisePriceTarget(current.target, {
        ...(input.targetTotalCny === undefined ? {} : { targetTotalCny: input.targetTotalCny }),
        ...(input.sellerTierMinimum === undefined ? {} : { sellerTierMinimum: input.sellerTierMinimum }),
        ...(input.requireMainlandWarranty === undefined ? {} : { requireMainlandWarranty: input.requireMainlandWarranty }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }, input.expectedTargetRevisionHash, (this.options.now ?? (() => new Date().toISOString()))());
      const stored = await this.options.prices.putTargetAtRoot(activeRoot, revised, { expectedRevision: input.expectedRevision, expectedHash: input.expectedRecordHash });
      const scheduleId = scheduleIdForTarget(revised.targetId);
      let schedule;
      try { schedule = await this.options.prices.getScheduleAtRoot(activeRoot, scheduleId); }
      catch (error) {
        if (!(error instanceof PriceRepositoryError) || error.code !== "not_found") throw error;
        schedule = null;
      }
      await this.options.prices.putScheduleAtRoot(activeRoot, {
        scheduleId,
        jobType: "price_target_recheck",
        subjectRef: `price-target:${revised.targetId}`,
        cadenceSeconds: TARGET_RECHECK_CADENCE_SECONDS,
        nextRunAt: revised.updatedAt,
        enabled: revised.enabled,
      }, schedule === null ? { expectedRevision: 0 } : { expectedRevision: schedule.revision, expectedHash: schedule.recordHash });
      return stored;
    })).result;
  }
}
