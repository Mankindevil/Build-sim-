import { sha256Json } from "../runtime/fs.mjs";
import { FileJobRepository } from "../jobs/repository";
import type { BackgroundJob } from "../jobs/contracts";
import type { JobSchedule } from "./contracts";
import { PriceRepository, type VersionedJobSchedule } from "./repository";

export interface PriceScheduleClaim {
  readonly bucket: string;
  readonly nextRunAt: string;
}

export interface PriceScheduleTickResult {
  readonly due: boolean;
  readonly job: BackgroundJob | null;
  readonly jobCreated: boolean;
  readonly schedule: VersionedJobSchedule;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function alignedBucketMs(schedule: JobSchedule, nowMs: number, cadenceMs: number): number {
  if (schedule.jobType !== "price_history_rebuild") return Math.floor(nowMs / cadenceMs) * cadenceMs;
  // Daily history buckets are calendar days in Asia/Shanghai, not UTC days.
  return Math.floor((nowMs + SHANGHAI_OFFSET_MS) / cadenceMs) * cadenceMs - SHANGHAI_OFFSET_MS;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

/** Returns at most the current cadence bucket, never one job per missed period. */
export function currentPriceScheduleClaim(schedule: JobSchedule, now: string): PriceScheduleClaim | null {
  if (!schedule.enabled) return null;
  const nowMs = timestamp(now, "schedule clock");
  if (timestamp(schedule.nextRunAt, "schedule nextRunAt") > nowMs) return null;
  const cadenceMs = schedule.cadenceSeconds * 1_000;
  const bucketMs = alignedBucketMs(schedule, nowMs, cadenceMs);
  const bucket = new Date(bucketMs).toISOString();
  if (schedule.lastEnqueuedBucket === bucket) return null;
  return { bucket, nextRunAt: new Date(bucketMs + cadenceMs).toISOString() };
}

/**
 * Job creation precedes the schedule cursor. The durable job's deterministic
 * idempotency key makes a crash in between replay the same job before CAS
 * advances the cursor.
 */
export class PriceScheduleService {
  constructor(
    private readonly prices: PriceRepository,
    private readonly jobs: FileJobRepository,
    private readonly options: { readonly faultAfterJobCreate?: () => void | Promise<void> } = {},
  ) {}

  async tick(scheduleId: string, now: string): Promise<PriceScheduleTickResult> {
    const current = await this.prices.getSchedule(scheduleId);
    const claim = currentPriceScheduleClaim(current.schedule, now);
    if (claim === null) return { due: false, job: null, jobCreated: false, schedule: current };
    const key = `price-schedule:${scheduleId}:${claim.bucket}`;
    const input = {
      schemaVersion: "price-schedule-job-input-v1",
      scheduleId,
      jobType: current.schedule.jobType,
      subjectRef: current.schedule.subjectRef,
      bucket: claim.bucket,
    } as const;
    const created = await this.jobs.create({
      type: current.schedule.jobType,
      handlerVersion: "price-schedule-v1",
      idempotencyKey: key,
      inputHash: sha256Json(input),
      payloadRef: `price-schedule:${scheduleId}`,
      runAfter: now,
      networkRequired: current.schedule.jobType === "official_update_scan",
    });
    await this.options.faultAfterJobCreate?.();
    const schedule = await this.prices.putSchedule({
      ...current.schedule,
      lastEnqueuedBucket: claim.bucket,
      nextRunAt: claim.nextRunAt,
    }, { expectedRevision: current.revision, expectedHash: current.recordHash });
    return { due: true, job: created.job, jobCreated: created.created, schedule };
  }
}
