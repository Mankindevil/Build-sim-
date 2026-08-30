import { randomUUID } from "node:crypto";
import type { ExecutionRepository, StoredExecutionSession } from "./repository";
import type { ExecutionSession } from "./contracts";
import type { GeneratedBuildProcedure } from "./first-boot";

export interface StartExecutionInput {
  readonly repository: ExecutionRepository;
  readonly generated: GeneratedBuildProcedure;
  readonly planVersionId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly runtimeGeneration?: number;
  readonly executionSessionId?: string;
}

/** Persists the procedure and exact dependency context inside the durable U1 execution authority. */
export async function startExecution(input: StartExecutionInput): Promise<StoredExecutionSession> {
  const session: ExecutionSession = {
    executionSessionId: input.executionSessionId ?? `execution-${randomUUID()}`,
    planVersionId: input.planVersionId,
    procedureId: input.generated.procedure.procedureId,
    evaluationHash: input.generated.procedure.inputEvaluationHash,
    procedureSafetyHash: input.generated.procedure.procedureSafetyHash,
    status: "active",
    results: [],
    destructiveActionConfirmations: [],
  };
  return input.repository.create({
    session,
    procedure: input.generated.procedure,
    dependencyContext: input.generated.dependencyContext,
    leaseToken: input.leaseToken,
    leaseExpiresAt: input.leaseExpiresAt,
    ...(input.runtimeGeneration === undefined ? {} : { runtimeGeneration: input.runtimeGeneration }),
  });
}
