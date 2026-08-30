import { FileJobRepository } from "../jobs/repository";
import { DurableJobScheduler, DurableJobWorker } from "../jobs/worker";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { ProductionPlanPriceService } from "./production";
import { PriceRepository } from "./repository";
import { PriceScheduleService, type PriceScheduleTickResult } from "./schedule";
import { CurrentPriceSnapshotService, type CurrentPriceSnapshotBuildResult } from "./snapshot";
import { PriceHistoryRebuildService } from "./history-worker";
import { PriceTargetEvaluationService } from "./target-worker";
import type { PriceSnapshotFile } from "./types";
import { PriceRepositoryError } from "./repository";

export interface ProductionPriceTickResult {
  readonly schedules: readonly PriceScheduleTickResult[];
  readonly worker: Awaited<ReturnType<DurableJobScheduler["tick"]>>;
}

/** Durable production composition for observation snapshots and target rechecks. */
export class ProductionPriceRuntime {
  readonly jobs: FileJobRepository;
  readonly schedules: PriceScheduleService;
  readonly targets: PriceTargetEvaluationService;
  readonly history: PriceHistoryRebuildService;
  private readonly scheduler: DurableJobScheduler;
  private readonly prices: PriceRepository;
  private readonly snapshots: CurrentPriceSnapshotService;
  private readonly now: () => string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: {
    readonly coordinator: RuntimeCoordinator;
    readonly prices: PriceRepository;
    readonly planPrices: ProductionPlanPriceService;
    readonly snapshots: CurrentPriceSnapshotService;
    readonly currentSnapshotAtRoot: (activeRoot: string) => PriceSnapshotFile | Promise<PriceSnapshotFile>;
    readonly online?: () => boolean | Promise<boolean>;
    readonly now?: () => string;
    readonly workerId?: string;
    readonly schedulerIntervalMs?: number;
  }) {
    this.prices = options.prices;
    this.snapshots = options.snapshots;
    this.now = options.now ?? (() => new Date().toISOString());
    this.jobs = new FileJobRepository({ coordinator: options.coordinator, now: this.now });
    this.schedules = new PriceScheduleService(this.prices, this.jobs);
    this.targets = new PriceTargetEvaluationService({ coordinator: options.coordinator, prices: options.prices, planPrices: options.planPrices, now: this.now });
    this.history = new PriceHistoryRebuildService({
      coordinator: options.coordinator,
      prices: options.prices,
      currentSnapshotAtRoot: options.currentSnapshotAtRoot,
    });
    const worker = new DurableJobWorker({
      repository: this.jobs,
      workerId: options.workerId ?? "workspace-price-targets",
      handlers: { ...this.targets.handlers(), ...this.history.handlers() },
      online: options.online ?? (() => true),
      types: ["price_target_recheck", "price_history_rebuild"],
    });
    this.scheduler = new DurableJobScheduler(this.jobs, worker);
    this.intervalMs = options.schedulerIntervalMs ?? 1_000;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 50 || this.intervalMs > 3_600_000) throw new TypeError("price scheduler interval is invalid");
  }

  async initialize(): Promise<void> {
    await this.jobs.initialize("production-prices-v1");
    await this.prices.initialize("production-prices-v1");
    try {
      await this.prices.getSchedule("price-history-daily");
    } catch (error) {
      if (!(error instanceof PriceRepositoryError) || error.code !== "not_found") throw error;
      await this.prices.putSchedule({
        scheduleId: "price-history-daily",
        jobType: "price_history_rebuild",
        subjectRef: "runtime-repository:prices",
        cadenceSeconds: 86_400,
        nextRunAt: nextShanghaiMidnight(this.now()),
        enabled: true,
      }, { expectedRevision: 0 });
    }
  }

  rebuildCurrent(asOf?: string): Promise<CurrentPriceSnapshotBuildResult> { return this.snapshots.rebuild(asOf); }

  async tick(now = this.now()): Promise<ProductionPriceTickResult> {
    await this.initialize();
    const schedules = [];
    for (const { schedule } of await this.prices.listSchedules()) {
      if (schedule.jobType === "price_target_recheck" || schedule.jobType === "price_history_rebuild") {
        schedules.push(await this.schedules.tick(schedule.scheduleId, now));
      }
    }
    return { schedules, worker: await this.scheduler.tick() };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.initialize();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick().catch(() => undefined).finally(() => { this.ticking = false; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Returns the current boundary when already at midnight, otherwise the next Asia/Shanghai midnight. */
export function nextShanghaiMidnight(now: string): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("price runtime clock is invalid");
  const local = new Date(nowMs + 8 * 60 * 60 * 1_000);
  const currentBoundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 60 * 60 * 1_000;
  return new Date(nowMs === currentBoundary ? currentBoundary : currentBoundary + 86_400_000).toISOString();
}
