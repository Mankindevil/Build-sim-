import { sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { BackgroundJobHandler } from "../jobs/worker";
import { projectCurrentChinaPrice } from "./policy";
import { ProductionPlanPriceService } from "./production";
import { PriceRepository } from "./repository";
import { evaluatePriceTarget } from "./targets";

export interface PriceTargetEvaluationCommit {
  readonly schemaVersion: "price-target-evaluation-commit-v1";
  readonly targetId: string;
  readonly targetRevision: number;
  readonly targetRecordHash: string;
  readonly priceSnapshotId: string;
  readonly priceSnapshotHash: string;
  readonly eventId: string | null;
  readonly eventCreated: boolean;
}

function scheduleIdFromRef(payloadRef: string): string {
  if (!payloadRef.startsWith("price-schedule:") || payloadRef.slice("price-schedule:".length).length === 0) {
    throw new TypeError("price target job payloadRef is invalid");
  }
  return payloadRef.slice("price-schedule:".length);
}

/** Root-pinned target state transition shared by scheduled and explicit rechecks. */
export class PriceTargetEvaluationService {
  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly prices: PriceRepository;
    readonly planPrices: ProductionPlanPriceService;
    readonly now?: () => string;
    readonly faultAfterEventWrite?: () => void | Promise<void>;
  }) {}

  async evaluateSchedule(scheduleId: string, expectedInputHash?: string, expectedIdempotencyKey?: string): Promise<PriceTargetEvaluationCommit> {
    await this.options.coordinator.initialize();
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const storedSchedule = await this.options.prices.getScheduleAtRoot(activeRoot, scheduleId);
      const { schedule } = storedSchedule;
      if (schedule.jobType !== "price_target_recheck" || !schedule.subjectRef.startsWith("price-target:")) {
        throw new TypeError("price schedule is not a target recheck");
      }
      if (expectedIdempotencyKey !== undefined) {
        const prefix = `price-schedule:${scheduleId}:`;
        if (!expectedIdempotencyKey.startsWith(prefix)) throw new TypeError("price schedule job idempotency authority is invalid");
        const bucket = expectedIdempotencyKey.slice(prefix.length);
        const expected = sha256Json({ schemaVersion: "price-schedule-job-input-v1", scheduleId, jobType: schedule.jobType, subjectRef: schedule.subjectRef, bucket });
        if (expectedInputHash !== expected) throw new TypeError("price schedule job input hash is invalid");
      }
      const targetId = schedule.subjectRef.slice("price-target:".length);
      const current = await this.options.prices.getTargetAtRoot(activeRoot, targetId);
      const planView = await this.options.planPrices.forPlanAtRoot(activeRoot, current.target.planId);
      const component = current.target.instanceId === undefined
        ? planView.components.find(({ skuId, variantIdentityFactIds }) => skuId === current.target.skuId
          && JSON.stringify([...variantIdentityFactIds].sort()) === JSON.stringify([...current.target.variantIdentityFactIds].sort()))
        : planView.components.find(({ instanceId }) => instanceId === current.target.instanceId);
      if (!component || component.skuId !== current.target.skuId
        || JSON.stringify([...component.variantIdentityFactIds].sort()) !== JSON.stringify([...current.target.variantIdentityFactIds].sort())) {
        throw new TypeError("price target no longer matches its plan instance");
      }
      const selected = new Set(component.current.selectedObservationIds);
      const observations = (await this.options.prices.listObservationsAtRoot(activeRoot)).filter(({ observationId }) => selected.has(observationId));
      // Rebuild the projection from the exact selected records before applying
      // seller-tier/warranty target policy; never accept a caller projection.
      const projection = projectCurrentChinaPrice({
        skuId: current.target.skuId,
        variantIdentityFactIds: current.target.variantIdentityFactIds,
        observations,
        now: `${planView.asOf}T23:59:59.999Z`,
      });
      if (JSON.stringify(projection) !== JSON.stringify(component.current)) throw new TypeError("price target projection differs from the locked plan view");
      const evaluated = await evaluatePriceTarget({
        target: current.target,
        projection,
        observations,
        priceSnapshotId: planView.priceSnapshotId,
        now,
        nextCheckAt: schedule.nextRunAt,
      });
      // Event-first ordering makes a process interruption replayable: the
      // semantic idempotency index returns the same event before target CAS is
      // retried, so a crossing cannot disappear between two durable writes.
      const event = evaluated.event === null ? null : await this.options.prices.recordTargetEventAtRoot(activeRoot, evaluated.event);
      if (event !== null) await this.options.faultAfterEventWrite?.();
      const target = await this.options.prices.updateTargetEvaluationAtRoot(activeRoot, evaluated.target, {
        expectedRevision: current.revision,
        expectedHash: current.recordHash,
      });
      return {
        schemaVersion: "price-target-evaluation-commit-v1",
        targetId,
        targetRevision: target.revision,
        targetRecordHash: target.recordHash,
        priceSnapshotId: planView.priceSnapshotId,
        priceSnapshotHash: planView.priceSnapshotHash,
        eventId: event?.event.eventId ?? null,
        eventCreated: event?.created ?? false,
      };
    })).result;
  }

  handlers(): Readonly<Record<string, BackgroundJobHandler>> {
    return Object.freeze({
      "price_target_recheck@price-schedule-v1": async (context) => {
        const result = await this.evaluateSchedule(scheduleIdFromRef(context.payloadRef), context.job.inputHash, context.idempotencyKey);
        const resultRefs = [
          `price-target:${result.targetId}`,
          `price-snapshot:${result.priceSnapshotId}`,
          ...(result.eventId === null ? [] : [`price-target-event:${result.eventId}`]),
        ].sort();
        return { resultRefs, resultCommitHash: sha256Json({ ...result, resultRefs }) };
      },
    });
  }
}
