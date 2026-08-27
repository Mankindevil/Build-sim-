import type { BuildEvaluation } from "../core/evaluate";
import type { BuildTask } from "./contracts";

export interface BuildPurchaseFact {
  skuId: string;
  stage: "candidate" | "locked" | "purchased" | "installed";
  receiptId?: string;
  planId?: string | null;
  planItemId?: string | null;
  linkStatus?: "linked" | "unlinked" | "stale";
}

export interface DeriveBuildTasksInput {
  planId: string;
  sourceVersionId: string;
  evaluation: BuildEvaluation;
  purchaseFacts?: BuildPurchaseFact[];
}

export interface BuildTaskSummary {
  total: number;
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  obsolete: number;
  next: Array<Pick<BuildTask, "id" | "kind" | "sourceRef" | "title" | "status" | "relatedPartId" | "cableId">>;
  blockers: Array<Pick<BuildTask, "id" | "title" | "staleReason" | "evidenceRefs">>;
}

const ACTIVE_STATUSES = new Set<BuildTask["status"]>(["todo", "doing", "blocked"]);

export function buildTaskId(planId: string, sourceRef: string): string {
  return `task:${encodeURIComponent(planId)}:${encodeURIComponent(sourceRef)}`;
}

function relatedPartForSku(evaluation: BuildEvaluation, skuId: string): string | undefined {
  return evaluation.geometry.find((part) => part.skuId === skuId)?.id;
}

function task(input: Omit<BuildTask, "schemaVersion" | "id" | "statusSource">): BuildTask {
  return {
    schemaVersion: "1.0.0",
    id: buildTaskId(input.planId, input.sourceRef),
    statusSource: "derived",
    ...input,
  };
}

export function deriveBuildTasks(input: DeriveBuildTasksInput): BuildTask[] {
  const { planId, sourceVersionId, evaluation } = input;
  const facts = new Map((input.purchaseFacts ?? [])
    .filter((fact) => !fact.planId || fact.planId === planId)
    .filter((fact) => !fact.planItemId || fact.planItemId === fact.skuId)
    .filter((fact) => !fact.linkStatus || fact.linkStatus === "linked")
    .map((fact) => [fact.skuId, fact]));
  const tasks: BuildTask[] = [];

  evaluation.bom.forEach((line, order) => {
    const sourceRef = `purchase:sku:${line.skuId}`;
    const fact = facts.get(line.skuId);
    const relatedPartId = relatedPartForSku(evaluation, line.skuId);
    const purchased = fact?.stage === "purchased" || fact?.stage === "installed";
    tasks.push(task({
      planId, sourceVersionId, sourceRef, kind: "purchase", order,
      title: `采购 ${line.qty}× ${line.skuId}`,
      status: purchased ? "done" : "todo",
      ...(relatedPartId ? { relatedPartId } : {}),
      evidenceRefs: fact?.receiptId ? [`transaction:${fact.receiptId}`] : [`bom:${line.skuId}`],
    }));
  });

  // A generic case-fan group is a reviewed mounting requirement, not a product.
  // Keep it out of the SKU BOM while making the procurement gap impossible to
  // mistake for a completed budget or shopping list.
  (evaluation.price.unresolvedRequirements ?? []).forEach((requirement, index) => {
    const sourceRef = `purchase:requirement:${requirement.id}`;
    tasks.push(task({
      planId, sourceVersionId, sourceRef, kind: "purchase", order: 500 + index,
      title: `先确认 ${requirement.mountLabel} ${requirement.sizeMm}mm 风扇具体 SKU（${requirement.qty} 个）`,
      status: "blocked",
      staleReason: "当前只记录了安装位、尺寸和数量；具体风扇 SKU、单价、噪音与具体产品的实际风量均未知，不能视为已完成采购。",
      findingId: `procurement.unresolved:${requirement.id}`,
      evidenceRefs: [`requirement:${requirement.id}`, `config:selection.fanGroups.${requirement.mountId}`],
    }));
  });

  const assemblyByStep = new Map(evaluation.assembly.steps.map((step) => [step.id, buildTaskId(planId, `assembly:${step.id}`)]));
  evaluation.assembly.steps.forEach((step, index) => {
    const sourceRef = `assembly:${step.id}`;
    const dependencyIds = evaluation.assembly.constraints
      .filter((constraint) => constraint.after === step.id)
      .map((constraint) => assemblyByStep.get(constraint.before))
      .filter((id): id is string => Boolean(id));
    tasks.push(task({
      planId, sourceVersionId, sourceRef, kind: "assembly", order: 1_000 + index,
      title: step.label,
      status: step.deadlocked ? "blocked" : "todo",
      ...(step.deadlocked ? { staleReason: "装配依赖存在循环，需先解决阻断" } : {}),
      ...(dependencyIds.length ? { dependsOn: [...new Set(dependencyIds)] } : {}),
      ...(step.partId ? { relatedPartId: step.partId } : {}),
      ...(step.cableId ? { cableId: step.cableId } : {}),
      evidenceRefs: step.reasons.length ? step.reasons : [`assembly:${step.id}`],
    }));
  });

  evaluation.wiring.checklist.forEach((item, index) => {
    const missing = typeof item.haveQty === "number" && item.haveQty < item.requiredQty;
    tasks.push(task({
      planId, sourceVersionId, sourceRef: `wiring:${item.id}`, kind: "wiring", order: 2_000 + index,
      title: item.label,
      status: missing ? "blocked" : "todo",
      ...(missing ? { staleReason: `数量不足：需要 ${item.requiredQty}，现有 ${item.haveQty}` } : {}),
      evidenceRefs: [`evidence:${item.evidence}`, ...(item.purchaseHint ? [`purchase-hint:${item.purchaseHint}`] : [])],
    }));
  });

  evaluation.findings.filter((finding) => !finding.id.startsWith("procurement.unresolved:")).forEach((finding, index) => {
    tasks.push(task({
      planId, sourceVersionId, sourceRef: `verification:${finding.id}`, kind: "verification", order: 3_000 + index,
      title: finding.message,
      status: finding.verdict === "bad" ? "blocked" : finding.verdict === "ok" ? "done" : "todo",
      ...(finding.verdict === "bad" ? { staleReason: "确定性评估阻断" } : {}),
      findingId: finding.id,
      ...(finding.related?.[0] ? { relatedPartId: finding.related[0] } : {}),
      evidenceRefs: [`finding:${finding.id}`, `evidence:${finding.evidence}`],
    }));
  });

  return tasks;
}

export function reconcileBuildTasks(previous: BuildTask[], derived: BuildTask[], at = new Date().toISOString()): BuildTask[] {
  const previousBySource = new Map(previous.map((item) => [`${item.kind}:${item.sourceRef}`, item]));
  const activeKeys = new Set<string>();
  const next: BuildTask[] = derived.map((candidate) => {
    const key = `${candidate.kind}:${candidate.sourceRef}`;
    activeKeys.add(key);
    const existing = previousBySource.get(key);
    if (!existing) return { ...candidate, updatedAt: at, ...(candidate.status === "done" ? { completedAt: at } : {}) };
    const manual = existing.statusSource === "manual";
    const status = manual
      ? existing.status
      : existing.status === "obsolete"
        ? candidate.status
        : candidate.status === "done" || candidate.status === "blocked"
          ? candidate.status
          : existing.status === "done" || existing.status === "doing" ? existing.status : candidate.status;
    return {
      ...candidate,
      status,
      statusSource: manual ? "manual" as const : "derived" as const,
      ...(existing.note ? { note: existing.note } : {}),
      updatedAt: status === existing.status ? existing.updatedAt ?? at : at,
      ...(status === "done" ? { completedAt: existing.completedAt ?? at } : {}),
    };
  });
  for (const existing of previous) {
    const key = `${existing.kind}:${existing.sourceRef}`;
    if (activeKeys.has(key)) continue;
    if (existing.status === "obsolete") { next.push(existing); continue; }
    next.push({ ...existing, status: "obsolete", statusSource: "derived", staleReason: "该来源已从当前方案版本移除", updatedAt: at });
  }
  return next.sort((left, right) => (left.status === "obsolete" ? 1 : 0) - (right.status === "obsolete" ? 1 : 0) || (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
}

export function summarizeBuildTasks(tasks: BuildTask[]): BuildTaskSummary {
  const summary: BuildTaskSummary = { total: tasks.length, todo: 0, doing: 0, done: 0, blocked: 0, obsolete: 0, next: [], blockers: [] };
  for (const item of tasks) summary[item.status] += 1;
  const nextRank: Record<"doing" | "blocked" | "todo", number> = { doing: 0, blocked: 1, todo: 2 };
  summary.next = tasks.filter((item) => ACTIVE_STATUSES.has(item.status))
    .sort((left, right) => nextRank[left.status as keyof typeof nextRank] - nextRank[right.status as keyof typeof nextRank] || (left.order ?? 0) - (right.order ?? 0))
    .slice(0, 5).map(({ id, kind, sourceRef, title, status, relatedPartId, cableId }) => ({ id, kind, sourceRef, title, status, ...(relatedPartId ? { relatedPartId } : {}), ...(cableId ? { cableId } : {}) }));
  summary.blockers = tasks.filter((item) => item.status === "blocked").slice(0, 5).map(({ id, title, staleReason, evidenceRefs }) => ({ id, title, ...(staleReason ? { staleReason } : {}), ...(evidenceRefs ? { evidenceRefs } : {}) }));
  return summary;
}
