import type { BuildPlan, PlanRepository } from "./contracts";
import { createEmptyBuildConfig } from "./default-plan";

export async function ensureDefaultPlan(repository: PlanRepository, now = () => new Date().toISOString()): Promise<BuildPlan> {
  const plans = await repository.list();
  const existing = plans.find((plan) => plan.status === "active") ?? plans[0];
  if (existing) return repository.get(existing.id);
  const timestamp = now();
  return repository.create({
    name: "空白装机方案",
    description: "从空白开始，逐件加入部件",
    config: createEmptyBuildConfig("default-empty", timestamp),
    metadata: {
      initialization: {
        status: "initialized",
        source: "manual",
        initializedAt: timestamp,
      },
    },
    idempotencyKey: "workspace-default-empty-v1",
  });
}
