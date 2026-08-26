export type PlanRepositoryErrorCode = "not_found" | "corrupt_data" | "invalid_id" | "idempotency_conflict" | "invalid_input" | "initialization_pending";

export class PlanRepositoryError extends Error {
  constructor(
    readonly code: PlanRepositoryErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlanRepositoryError";
  }
}
