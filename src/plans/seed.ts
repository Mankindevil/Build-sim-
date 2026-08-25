import { sha256Hex } from "./canonical";
import type { BuildPlan, PlanRepository } from "./contracts";
import { createDefaultN6Config } from "./default-plan";

export async function ensureDefaultPlan(repository: PlanRepository, now = () => new Date().toISOString()): Promise<BuildPlan> {
  const plans = await repository.list();
  const existing = plans.find((plan) => plan.status === "active") ?? plans[0];
  if (existing) return repository.get(existing.id);
  const timestamp = now();
  const created = await repository.create({
    name: "N6 Build Lab",
    description: "Migrated default N6 workspace plan",
    config: createDefaultN6Config("default-n6", timestamp),
    metadata: { useCase: "NAS" },
    idempotencyKey: "workspace-default-n6-v1",
  });
  await repository.saveVersion(created.id, {
    expectedRevision: created.draftRevision,
    expectedConfigHash: await sha256Hex(created.draft.config),
    reason: "initial",
    idempotencyKey: "workspace-default-n6-initial-version-v1",
  });
  return repository.get(created.id);
}
