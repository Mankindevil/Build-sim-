export type PlanConflictCode = "stale_revision" | "stale_config_hash";

export class PlanConflictError extends Error {
  readonly status = 409;

  constructor(
    readonly code: PlanConflictCode,
    readonly expected: number | string,
    readonly actual: number | string,
  ) {
    super(`${code}: expected ${String(expected)}, actual ${String(actual)}`);
    this.name = "PlanConflictError";
  }
}

export function assertExpectedRevision(expected: number, actual: number): void {
  if (expected !== actual) throw new PlanConflictError("stale_revision", expected, actual);
}

export function assertExpectedConfigHash(expected: string, actual: string): void {
  if (expected !== actual) throw new PlanConflictError("stale_config_hash", expected, actual);
}

