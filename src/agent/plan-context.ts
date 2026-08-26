import type { BuildPlan, PlanAgentContext, PlanEvaluationSnapshot } from "../plans/contracts";
import type { PlanSelection } from "../plans/client-store";
import { assertValidPlanAgentContext } from "../plans/validation";
import { PLAN_SCHEMA_VERSION } from "../plans/contracts";

export interface CreatePlanAgentContextInput {
  plan: BuildPlan;
  snapshot: PlanEvaluationSnapshot;
  selection: PlanSelection | null;
  spatialViewContext?: Record<string, unknown> | null;
  purchaseSummary: unknown;
  buildTaskSummary: unknown;
}

export function createPlanAgentContext(input: CreatePlanAgentContextInput): PlanAgentContext {
  if (input.snapshot.planId !== input.plan.id) throw new Error("evaluation snapshot belongs to another plan");
  const context: PlanAgentContext = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: input.plan.id,
    planVersionId: input.plan.activeVersionId,
    draftRevision: input.snapshot.draftRevision,
    configHash: input.snapshot.configHash,
    evaluationHash: input.snapshot.evaluationHash,
    buildConfig: structuredClone(input.snapshot.evaluation.config),
    evaluation: structuredClone(input.snapshot.evaluation),
    spatialSelection: input.selection ? structuredClone(input.selection) : null,
    ...(input.spatialViewContext ? { spatialViewContext: structuredClone(input.spatialViewContext) } : {}),
    purchaseSummary: structuredClone(input.purchaseSummary),
    buildTaskSummary: structuredClone(input.buildTaskSummary),
  };
  assertValidPlanAgentContext(context);
  return context;
}

export function planAgentContextEnvelope(content: string, context: PlanAgentContext): string {
  // BuildConfig is already sent through the validated session field, and the
  // authoritative evaluation is available through get_build_evaluation. Do not
  // duplicate either large payload in the user message: a normal N6 evaluation
  // can exceed the Agent message limit before the provider is ever called.
  const promptContext = {
    schemaVersion: context.schemaVersion,
    planId: context.planId,
    planVersionId: context.planVersionId,
    draftRevision: context.draftRevision,
    configHash: context.configHash,
    evaluationHash: context.evaluationHash,
    spatialSelection: context.spatialSelection,
    ...(context.spatialViewContext ? { spatialViewContext: context.spatialViewContext } : {}),
    purchaseSummary: context.purchaseSummary,
    buildTaskSummary: context.buildTaskSummary,
    authoritativeFacts: "Use get_build_evaluation; BuildConfig is attached to the Agent session.",
  };
  return `${content.trim()}\n\n<plan_agent_context schema_version="${context.schemaVersion}">\n${JSON.stringify(promptContext)}\n</plan_agent_context>\nOnly propose changes through the structured propose_plan_change tool. A normal answer never changes the plan.`;
}

export function isPlanAgentContextStale(bound: PlanAgentContext | null, current: PlanAgentContext | null): boolean {
  if (!bound || !current) return bound !== current;
  return bound.planId !== current.planId
    || bound.draftRevision !== current.draftRevision
    || bound.configHash !== current.configHash
    || bound.evaluationHash !== current.evaluationHash;
}
