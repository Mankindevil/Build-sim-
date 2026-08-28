import type { BuildConfigDocument } from "../config/types";
import type { BuildPlan, PlanAgentContext, PlanEvaluationSnapshot } from "../plans/contracts";
import type { PlanSelection } from "../plans/client-store";
import { assertValidPlanAgentContext } from "../plans/validation";
import { PLAN_SCHEMA_VERSION } from "../plans/contracts";
import { hashPlanConfig, sha256Hex } from "../plans/canonical";
import { createPlanPartialEvaluationV3, isPlanPartialEvaluationV3 } from "../plans/evaluation";

export interface CreatePlanAgentContextInput {
  plan: BuildPlan<BuildConfigDocument>;
  snapshot: PlanEvaluationSnapshot;
  selection: PlanSelection | null;
  spatialViewContext?: Record<string, unknown> | null;
  purchaseSummary: unknown;
  buildTaskSummary: unknown;
}

export async function createPlanAgentContext(input: CreatePlanAgentContextInput): Promise<PlanAgentContext> {
  if (input.snapshot.planId !== input.plan.id) throw new Error("evaluation snapshot belongs to another plan");
  if (input.snapshot.draftRevision !== input.plan.draftRevision) throw new Error("evaluation snapshot revision is stale");
  if (input.snapshot.planVersionId !== input.plan.activeVersionId) throw new Error("evaluation snapshot active version is stale");
  const configHash = await hashPlanConfig(input.plan.draft.config);
  if (input.snapshot.configHash !== configHash) throw new Error("evaluation snapshot config domain hash is stale");
  const evaluationHash = await sha256Hex(input.snapshot.evaluation);
  if (input.snapshot.evaluationHash !== evaluationHash) throw new Error("evaluation snapshot payload hash is invalid");
  if (input.plan.draft.config.schemaVersion === "3.0.0") {
    if (!isPlanPartialEvaluationV3(input.snapshot.evaluation)) throw new Error("BuildConfig V3 requires a partial topology evaluation");
    if (await sha256Hex(input.snapshot.evaluation) !== await sha256Hex(createPlanPartialEvaluationV3(input.plan.draft.config))) {
      throw new Error("V3 partial evaluation does not match the active topology");
    }
  } else {
    if (isPlanPartialEvaluationV3(input.snapshot.evaluation)) throw new Error("BuildConfig V2 cannot use a V3 partial evaluation");
    if (await hashPlanConfig(input.snapshot.evaluation.config) !== configHash) throw new Error("V2 evaluation does not match the active draft");
  }
  const context: PlanAgentContext = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: input.plan.id,
    planVersionId: input.plan.activeVersionId,
    draftRevision: input.snapshot.draftRevision,
    configHash: input.snapshot.configHash,
    evaluationHash: input.snapshot.evaluationHash,
    buildConfig: structuredClone(input.plan.draft.config),
    evaluation: structuredClone(input.snapshot.evaluation),
    spatialSelection: input.selection ? structuredClone(input.selection) : null,
    ...(input.spatialViewContext ? { spatialViewContext: structuredClone(input.spatialViewContext) } : {}),
    purchaseSummary: structuredClone(input.purchaseSummary),
    buildTaskSummary: structuredClone(input.buildTaskSummary),
    evidenceSummary: {
      count: input.plan.draft.evidenceBindings?.length ?? 0,
      bindings: (input.plan.draft.evidenceBindings ?? []).slice(0, 40).map(({ documentId, captureId, subject, purposes, locators }) => ({
        documentId,
        ...(captureId ? { captureId } : {}),
        subject: structuredClone(subject),
        purposes: structuredClone(purposes),
        ...(locators ? { locators: structuredClone(locators) } : {}),
      })),
    },
    ...(input.plan.metadata.initialization ? { initialization: structuredClone(input.plan.metadata.initialization) } : {}),
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
    ...(context.evidenceSummary ? { evidenceSummary: context.evidenceSummary } : {}),
    ...(context.initialization ? { initialization: context.initialization } : {}),
    authoritativeFacts: "Use get_build_evaluation; BuildConfig is attached to the Agent session.",
  };
  const proposalRule = "Treat blank, partial, and legacy pending plans identically: propose only the requirements or topology nodes explicitly identified in this turn through the structured propose_plan_change tool. Never autofill missing hardware or elevate an Agent guess to user authority. A normal answer never changes the plan.";
  return `${content.trim()}\n\n<plan_agent_context schema_version="${context.schemaVersion}">\n${JSON.stringify(promptContext)}\n</plan_agent_context>\n${proposalRule}`;
}

export function isPlanAgentContextStale(bound: PlanAgentContext | null, current: PlanAgentContext | null): boolean {
  if (!bound || !current) return bound !== current;
  return bound.planId !== current.planId
    || bound.draftRevision !== current.draftRevision
    || bound.configHash !== current.configHash
    || bound.evaluationHash !== current.evaluationHash;
}
