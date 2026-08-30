import {
  FileJobRepository,
  JobRepositoryError,
  type ClaimedBackgroundJob,
  type JobLease,
} from "./repository";
import type { BackgroundJob } from "./contracts";

export interface JobHandlerResult {
  resultRefs: string[];
  resultCommitHash: string;
}

export interface JobHandlerContext {
  readonly job: BackgroundJob;
  readonly idempotencyKey: string;
  readonly payloadRef: string;
  heartbeat(progress?: BackgroundJob["progress"]): Promise<void>;
  checkpoint(checkpointRef: string, progress?: BackgroundJob["progress"]): Promise<void>;
  /**
   * Atomically releases this network job's active lease and pauses it without
   * consuming an attempt. This method never resolves: it is dedicated worker
   * control flow, not a retryable handler failure.
   */
  pauseOffline(progress?: BackgroundJob["progress"]): Promise<never>;
  /** Release the lease into durable waiting_user state until an explicit review resumes it. */
  pauseForUser(progress?: BackgroundJob["progress"]): Promise<never>;
  currentLease(): Readonly<JobLease>;
}

export type BackgroundJobHandler = (context: JobHandlerContext) => Promise<JobHandlerResult>;

export interface JobWorkerOptions {
  repository: FileJobRepository;
  workerId: string;
  handlers: ReadonlyMap<string, BackgroundJobHandler> | Readonly<Record<string, BackgroundJobHandler>>;
  online?: () => boolean | Promise<boolean>;
  /** Restrict this worker to handlers it owns without claiming another subsystem's job. */
  types?: readonly string[];
}

export type WorkerRunResult =
  | { outcome: "idle" }
  | { outcome: "succeeded"; job: BackgroundJob }
  | { outcome: "retry_scheduled" | "failed" | "dead_letter"; job: BackgroundJob }
  | { outcome: "fenced"; jobId: string }
  | { outcome: "paused_offline" | "waiting_user" };

/** A deliberately redacted error suitable for durable job state. */
export class JobHandlerError extends Error {
  constructor(
    readonly code: string,
    readonly redactedMessage: string,
    readonly retryable = true,
    readonly retryAt?: string,
  ) {
    super(redactedMessage);
    this.name = "JobHandlerError";
  }
}

function handlerKey(job: Pick<BackgroundJob, "type" | "handlerVersion">): string {
  return `${job.type}@${job.handlerVersion}`;
}

function normalizeHandlers(
  handlers: JobWorkerOptions["handlers"],
): ReadonlyMap<string, BackgroundJobHandler> {
  return handlers instanceof Map ? handlers : new Map(Object.entries(handlers));
}

class JobPausedOfflineSignal extends Error {
  constructor() {
    super("job paused offline");
    this.name = "JobPausedOfflineSignal";
  }
}

class JobWaitingForUserSignal extends Error {
  constructor() {
    super("job waiting for user");
    this.name = "JobWaitingForUserSignal";
  }
}

/**
 * A one-job worker. Handlers receive only durable references and an explicit
 * idempotency key; they never receive an ungoverned in-memory payload authority.
 */
export class DurableJobWorker {
  private readonly repository: FileJobRepository;
  private readonly workerId: string;
  private readonly handlers: ReadonlyMap<string, BackgroundJobHandler>;
  private readonly online: () => boolean | Promise<boolean>;
  private readonly types: readonly string[] | undefined;

  constructor(options: JobWorkerOptions) {
    if (!options.workerId) throw new TypeError("workerId is required");
    this.repository = options.repository;
    this.workerId = options.workerId;
    this.handlers = normalizeHandlers(options.handlers);
    this.online = options.online ?? (() => true);
    this.types = options.types;
  }

  async runOnce(): Promise<WorkerRunResult> {
    const online = await this.online();
    const claimed = await this.repository.claimNext(this.workerId, {
      online,
      ...(this.types === undefined ? {} : { types: this.types }),
    });
    if (!claimed) {
      const jobs = await this.repository.list();
      if (!online && jobs.some((job) => job.status === "paused_offline")) return { outcome: "paused_offline" };
      return { outcome: "idle" };
    }
    return this.executeClaim(claimed);
  }

  private async executeClaim(initial: ClaimedBackgroundJob): Promise<WorkerRunResult> {
    let claimed = initial;
    const handler = this.handlers.get(handlerKey(claimed.job));
    if (!handler) {
      const job = await this.repository.fail(claimed.job.jobId, claimed.lease, {
        code: "handler_not_registered",
        redactedMessage: "No registered handler matches the durable job version",
        retryable: false,
      });
      return { outcome: "failed", job };
    }
    const context: JobHandlerContext = Object.freeze({
      job: structuredClone(claimed.job),
      idempotencyKey: claimed.job.idempotencyKey,
      payloadRef: claimed.job.payloadRef,
      heartbeat: async (progress?: BackgroundJob["progress"]) => {
        claimed = await this.repository.heartbeat(claimed.job.jobId, claimed.lease, progress === undefined ? {} : { progress });
      },
      checkpoint: async (checkpointRef: string, progress?: BackgroundJob["progress"]) => {
        claimed = await this.repository.checkpoint(claimed.job.jobId, claimed.lease, checkpointRef, progress);
      },
      pauseOffline: async (progress?: BackgroundJob["progress"]): Promise<never> => {
        if (progress !== undefined) {
          claimed = await this.repository.heartbeat(claimed.job.jobId, claimed.lease, { progress });
        }
        await this.repository.pauseOffline(claimed.job.jobId, claimed.lease);
        throw new JobPausedOfflineSignal();
      },
      pauseForUser: async (progress?: BackgroundJob["progress"]): Promise<never> => {
        await this.repository.pauseForUser(claimed.job.jobId, claimed.lease, progress);
        throw new JobWaitingForUserSignal();
      },
      currentLease: () => Object.freeze({ ...claimed.lease }),
    });
    try {
      const result = await handler(context);
      const job = await this.repository.succeed(claimed.job.jobId, claimed.lease, result.resultRefs, result.resultCommitHash);
      return { outcome: "succeeded", job };
    } catch (error) {
      if (error instanceof JobPausedOfflineSignal) return { outcome: "paused_offline" };
      if (error instanceof JobWaitingForUserSignal) return { outcome: "waiting_user" };
      if (error instanceof JobRepositoryError && error.code === "fenced") return { outcome: "fenced", jobId: claimed.job.jobId };
      const failure = error instanceof JobHandlerError
        ? error
        : new JobHandlerError("handler_failed", "Job handler failed; diagnostic details are available in redacted service logs");
      try {
        const job = await this.repository.fail(claimed.job.jobId, claimed.lease, {
          code: failure.code,
          redactedMessage: failure.redactedMessage,
          retryable: failure.retryable,
          ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
        });
        const outcome = job.status === "waiting_retry" ? "retry_scheduled" : job.status === "dead_letter" ? "dead_letter" : "failed";
        return { outcome, job };
      } catch (commitError) {
        if (commitError instanceof JobRepositoryError && commitError.code === "fenced") return { outcome: "fenced", jobId: claimed.job.jobId };
        throw commitError;
      }
    }
  }
}

export interface SchedulerTickResult {
  expiredLeasesRecovered: number;
  retriesPromoted: number;
  worker: WorkerRunResult;
}

/** Shared scheduler skeleton for evidence, catalog, price and future Agent jobs. */
export class DurableJobScheduler {
  constructor(
    private readonly repository: FileJobRepository,
    private readonly worker: DurableJobWorker,
  ) {}

  async tick(): Promise<SchedulerTickResult> {
    const expiredLeasesRecovered = await this.repository.recoverExpiredLeases();
    const retriesPromoted = await this.repository.promoteReadyRetries();
    const worker = await this.worker.runOnce();
    return { expiredLeasesRecovered, retriesPromoted, worker };
  }

  async drain(maxJobs = 100): Promise<SchedulerTickResult[]> {
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new TypeError("maxJobs is invalid");
    const results: SchedulerTickResult[] = [];
    for (let index = 0; index < maxJobs; index += 1) {
      const result = await this.tick();
      results.push(result);
      if (result.worker.outcome === "idle" || result.worker.outcome === "paused_offline") break;
    }
    return results;
  }
}
