import { sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { BackgroundJobHandler } from "../jobs/worker";
import type { PriceSnapshotFile } from "./types";
import { buildPriceHistoryPoint } from "./history";
import { PriceRepository } from "./repository";

function scheduleIdFromRef(payloadRef: string): string {
  if (!payloadRef.startsWith("price-schedule:") || payloadRef.length === "price-schedule:".length) throw new TypeError("price history payloadRef is invalid");
  return payloadRef.slice("price-schedule:".length);
}

function exactGroupKey(skuId: string, variantIdentityFactIds: readonly string[]): string {
  return JSON.stringify([skuId, [...variantIdentityFactIds].sort()]);
}

export class PriceHistoryRebuildService {
  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly prices: PriceRepository;
    readonly currentSnapshotAtRoot: (activeRoot: string) => PriceSnapshotFile | Promise<PriceSnapshotFile>;
  }) {}

  async evaluateSchedule(scheduleId: string, expectedInputHash: string, expectedIdempotencyKey: string): Promise<{ readonly historyPointIds: readonly string[]; readonly snapshotId: string }> {
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const { schedule } = await this.options.prices.getScheduleAtRoot(activeRoot, scheduleId);
      if (schedule.jobType !== "price_history_rebuild" || schedule.subjectRef !== "runtime-repository:prices") throw new TypeError("price history schedule authority is invalid");
      const prefix = `price-schedule:${scheduleId}:`;
      if (!expectedIdempotencyKey.startsWith(prefix)) throw new TypeError("price history job idempotency authority is invalid");
      const bucketEnd = expectedIdempotencyKey.slice(prefix.length);
      const expected = sha256Json({ schemaVersion: "price-schedule-job-input-v1", scheduleId, jobType: schedule.jobType, subjectRef: schedule.subjectRef, bucket: bucketEnd });
      if (expected !== expectedInputHash || !Number.isFinite(Date.parse(bucketEnd))) throw new TypeError("price history job input hash is invalid");
      const bucketStart = new Date(Date.parse(bucketEnd) - schedule.cadenceSeconds * 1_000).toISOString();
      const snapshot = await this.options.currentSnapshotAtRoot(activeRoot);
      if (!snapshot.snapshotId) throw new TypeError("price history rebuild requires the current content-addressed snapshot");
      const observations = await this.options.prices.listObservationsAtRoot(activeRoot);
      const groups = new Map<string, typeof observations>();
      for (const observation of observations.filter(({ capturedAt }) => Date.parse(capturedAt) >= Date.parse(bucketStart) && Date.parse(capturedAt) < Date.parse(bucketEnd))) {
        const key = exactGroupKey(observation.skuId, observation.variantIdentityFactIds);
        const list = groups.get(key) ?? []; list.push(observation); groups.set(key, list);
      }
      const historyPointIds = [];
      for (const group of [...groups.values()].sort((left, right) => exactGroupKey(left[0]!.skuId, left[0]!.variantIdentityFactIds).localeCompare(exactGroupKey(right[0]!.skuId, right[0]!.variantIdentityFactIds)))) {
        const first = group[0]!;
        const point = await buildPriceHistoryPoint({ skuId: first.skuId, variantIdentityFactIds: first.variantIdentityFactIds, bucketStart, bucketEnd, snapshotId: snapshot.snapshotId, observations: group });
        await this.options.prices.putHistoryPointAtRoot(activeRoot, point, { expectedRevision: 0 });
        historyPointIds.push(point.historyPointId);
      }
      return { historyPointIds: historyPointIds.sort(), snapshotId: snapshot.snapshotId };
    })).result;
  }

  handlers(): Readonly<Record<string, BackgroundJobHandler>> {
    return Object.freeze({
      "price_history_rebuild@price-schedule-v1": async (context) => {
        const result = await this.evaluateSchedule(scheduleIdFromRef(context.payloadRef), context.job.inputHash, context.idempotencyKey);
        const resultRefs = [`price-snapshot:${result.snapshotId}`, ...result.historyPointIds.map((id) => `price-history:${id}`)].sort();
        return { resultRefs, resultCommitHash: sha256Json({ ...result, resultRefs }) };
      },
    });
  }
}
