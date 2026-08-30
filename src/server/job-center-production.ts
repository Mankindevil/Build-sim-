import type { BackgroundJob, BackgroundJobStatus } from "../jobs/contracts";
import { FileJobRepository, JobRepositoryError } from "../jobs/repository";

export interface WorkspaceJobStatus {
  readonly schemaVersion: "workspace-job-status-v1";
  readonly jobId: string;
  readonly planId: string;
  readonly type: string;
  readonly status: BackgroundJobStatus;
  readonly revision: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly runAfter: string;
  readonly networkRequired: boolean;
  readonly dependencyJobIds: readonly string[];
  readonly progress: BackgroundJob["progress"] | null;
  readonly lastError: BackgroundJob["lastError"] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function project(job: BackgroundJob): WorkspaceJobStatus {
  if (!job.planId) throw new JobRepositoryError("corrupt_data", "plan job is missing its plan identity");
  return {
    schemaVersion: "workspace-job-status-v1",
    jobId: job.jobId,
    planId: job.planId,
    type: job.type,
    status: job.status,
    revision: job.revision,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    runAfter: job.runAfter,
    networkRequired: job.networkRequired,
    dependencyJobIds: [...job.dependencyJobIds],
    progress: job.progress ? structuredClone(job.progress) : null,
    lastError: job.lastError ? structuredClone(job.lastError) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class ProductionWorkspaceJobCenter {
  constructor(private readonly jobs: FileJobRepository) {}

  private async owned(planId: string, jobId: string): Promise<BackgroundJob> {
    const job = await this.jobs.get(jobId);
    if (job.planId !== planId) throw new JobRepositoryError("not_found", "job was not found for this plan");
    return job;
  }

  async list(planId: string): Promise<WorkspaceJobStatus[]> {
    return (await this.jobs.list())
      .filter((job) => job.planId === planId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.jobId.localeCompare(right.jobId))
      .map(project);
  }

  async cancel(planId: string, jobId: string, expectedRevision: number): Promise<WorkspaceJobStatus> {
    const job = await this.owned(planId, jobId);
    if (job.status === "running") throw new JobRepositoryError("conflict", "running job must finish its current bounded step before cancellation");
    return project(await this.jobs.cancel(jobId, expectedRevision));
  }

  async resume(planId: string, jobId: string, expectedRevision: number): Promise<WorkspaceJobStatus> {
    await this.owned(planId, jobId);
    return project(await this.jobs.resume(jobId, expectedRevision));
  }
}
