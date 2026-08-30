import { hashContent } from "../hash";
import {
  priceTargetEventIdempotencyKey,
  validatePriceTarget,
  type PriceObservation,
  type PriceTarget,
  type PriceTargetEvent,
  type SellerTier,
} from "./contracts";
import type { CurrentPriceProjection } from "./policy";

const TIER_RANK: Readonly<Record<SellerTier, number>> = Object.freeze({ unknown: 0, S4: 1, S3: 2, S2: 3, S1: 4 });

export interface PriceTargetDefinition {
  readonly targetId: string;
  readonly planId: string;
  readonly instanceId?: string;
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly targetTotalCny: number;
  readonly sellerTierMinimum?: Exclude<SellerTier, "unknown">;
  readonly requireMainlandWarranty?: boolean;
  readonly expiresAt?: string;
  readonly enabled: boolean;
}

type NormalizedPriceTargetDefinition = Omit<PriceTargetDefinition, "variantIdentityFactIds"> & { variantIdentityFactIds: string[] };

function definitionMaterial(value: PriceTargetDefinition): NormalizedPriceTargetDefinition {
  return {
    targetId: value.targetId,
    planId: value.planId,
    ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
    skuId: value.skuId,
    variantIdentityFactIds: [...value.variantIdentityFactIds].sort(),
    targetTotalCny: value.targetTotalCny,
    ...(value.sellerTierMinimum === undefined ? {} : { sellerTierMinimum: value.sellerTierMinimum }),
    ...(value.requireMainlandWarranty === undefined ? {} : { requireMainlandWarranty: value.requireMainlandWarranty }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    enabled: value.enabled,
  };
}

export async function priceTargetRevisionHash(value: PriceTargetDefinition): Promise<string> {
  return hashContent(definitionMaterial(value), { domain: "price.target-revision", schemaVersion: "1.0.0" });
}

export async function createPriceTarget(definition: PriceTargetDefinition, now: string): Promise<PriceTarget> {
  const material = definitionMaterial(definition);
  const target: PriceTarget = {
    ...material,
    status: material.enabled ? "watching" : "paused",
    revisionHash: await priceTargetRevisionHash(material),
    updatedAt: now,
  };
  const errors = validatePriceTarget(target);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return target;
}

export async function revisePriceTarget(
  current: PriceTarget,
  patch: Partial<Omit<PriceTargetDefinition, "targetId" | "planId" | "skuId" | "variantIdentityFactIds">>,
  expectedRevisionHash: string,
  now: string,
): Promise<PriceTarget> {
  if (current.revisionHash !== expectedRevisionHash) throw new TypeError("price target revision conflict");
  const definition = definitionMaterial({
    targetId: current.targetId,
    planId: current.planId,
    ...(current.instanceId === undefined ? {} : { instanceId: current.instanceId }),
    skuId: current.skuId,
    variantIdentityFactIds: current.variantIdentityFactIds,
    targetTotalCny: patch.targetTotalCny ?? current.targetTotalCny,
    ...(patch.sellerTierMinimum === undefined
      ? current.sellerTierMinimum === undefined ? {} : { sellerTierMinimum: current.sellerTierMinimum }
      : { sellerTierMinimum: patch.sellerTierMinimum }),
    ...(patch.requireMainlandWarranty === undefined
      ? current.requireMainlandWarranty === undefined ? {} : { requireMainlandWarranty: current.requireMainlandWarranty }
      : { requireMainlandWarranty: patch.requireMainlandWarranty }),
    ...(patch.expiresAt === undefined ? current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt } : { expiresAt: patch.expiresAt }),
    enabled: patch.enabled ?? current.enabled,
  });
  return createPriceTarget(definition, now);
}

function targetEligibleObservation(target: PriceTarget, observation: PriceObservation): boolean {
  if (observation.skuId !== target.skuId || !target.variantIdentityFactIds.every((id) => observation.variantIdentityFactIds.includes(id))
    || observation.variantIdentityFactIds.length !== target.variantIdentityFactIds.length) return false;
  if (target.sellerTierMinimum !== undefined && TIER_RANK[observation.sellerTier] < TIER_RANK[target.sellerTierMinimum]) return false;
  if (target.requireMainlandWarranty === true && observation.warrantyStatus !== "mainland") return false;
  return true;
}

function transition(previous: PriceTarget["status"], next: PriceTarget["status"]): PriceTargetEvent["transition"] | null {
  if (previous === "watching" && next === "met") return "watching_to_met";
  if (previous === "met" && next === "watching") return "met_to_watching";
  if (next === "unavailable" && previous !== "unavailable") return "to_unavailable";
  if (next === "paused" && previous !== "paused") return "paused";
  if (previous === "paused" && next !== "paused") return "resumed";
  return null;
}

export async function evaluatePriceTarget(input: {
  readonly target: PriceTarget;
  readonly projection: CurrentPriceProjection;
  readonly observations: readonly PriceObservation[];
  readonly priceSnapshotId: string;
  readonly now: string;
  readonly nextCheckAt?: string;
}): Promise<{ readonly target: PriceTarget; readonly event: PriceTargetEvent | null }> {
  if (input.projection.skuId !== input.target.skuId || input.priceSnapshotId.length === 0 || !Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("price target evaluation authority invalid");
  }
  const expired = input.target.expiresAt !== undefined && Date.parse(input.target.expiresAt) <= Date.parse(input.now);
  const selected = new Set(input.projection.selectedObservationIds);
  const eligible = input.observations.filter((observation) => selected.has(observation.observationId) && targetEligibleObservation(input.target, observation));
  const nextStatus: PriceTarget["status"] = !input.target.enabled || expired ? "paused"
    : eligible.length === 0 ? "unavailable"
      : eligible.some(({ comparableTotalCny }) => comparableTotalCny <= input.target.targetTotalCny) ? "met" : "watching";
  const firstEvaluation = input.target.lastEvaluatedSnapshotId === undefined;
  const eventTransition = firstEvaluation ? null : transition(input.target.status, nextStatus);
  const target: PriceTarget = {
    ...input.target,
    status: nextStatus,
    lastEvaluatedSnapshotId: input.priceSnapshotId,
    ...(eventTransition === "watching_to_met" ? { lastTriggeredAt: input.now } : {}),
    ...(input.nextCheckAt === undefined ? {} : { nextCheckAt: input.nextCheckAt }),
  };
  if (eventTransition === null) return { target, event: null };
  const eventMaterial = {
    targetId: target.targetId,
    targetRevisionHash: target.revisionHash,
    priceSnapshotId: input.priceSnapshotId,
    transition: eventTransition,
  };
  const eventHash = await hashContent(eventMaterial, { domain: "price.target-event-id", schemaVersion: "1.0.0" });
  const event: PriceTargetEvent = {
    eventId: `price-target-event-${eventHash.slice(0, 32)}`,
    ...eventMaterial,
    occurredAt: input.now,
    idempotencyKey: priceTargetEventIdempotencyKey(eventMaterial),
  };
  return { target, event };
}
