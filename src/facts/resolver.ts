import { sha256Json } from "../runtime/fs.mjs";
import {
  canFactAloneSupportSafetyPass,
  type ConflictSet,
  type FactRecord,
  type FactSubject,
  type SafetyFactPassContext,
} from "./contracts";
import { factFieldPolicy, type FactSafetyClass } from "./field-registry";
import { verifyConflictSet } from "./conflicts";
import { verifyFactRecord } from "./hash";

export type FactResolutionStatus = "resolved" | "blocked" | "unknown";

export interface ResolvedFactField {
  subjectKey: string;
  field: string;
  status: FactResolutionStatus;
  safetyClass: FactSafetyClass | null;
  factIds: string[];
  value?: unknown;
  unit?: string;
  reason:
    | "resolved_verified"
    | "no_active_fact"
    | "open_conflict"
    | "conflict_set_required"
    | "insufficient_authority_or_scope"
    | "invalid_authority_record";
}

export interface FactResolutionInput {
  subject: FactSubject;
  field: string;
  facts: readonly FactRecord[];
  conflicts: readonly ConflictSet[];
  passContextFor(fact: FactRecord): SafetyFactPassContext | undefined;
}

export function factSubjectKey(subject: FactSubject): string {
  return sha256Json(subject);
}

function currentFacts(facts: readonly FactRecord[]): FactRecord[] {
  const superseded = new Set(facts.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
  return facts.filter((fact) => fact.status === "active" && !superseded.has(fact.factId));
}

function authorityRank(fact: FactRecord): number {
  return fact.authority === "official" ? 0 : fact.authority === "third_party" ? 1 : fact.authority === "user_observation" ? 2 : 3;
}

export async function resolveFactField(input: FactResolutionInput): Promise<ResolvedFactField> {
  const subjectKey = factSubjectKey(input.subject);
  const policy = factFieldPolicy(input.field);
  const candidates = currentFacts(input.facts).filter((fact) => fact.field === input.field && factSubjectKey(fact.subject) === subjectKey);
  if (!policy) return { subjectKey, field: input.field, status: "blocked", safetyClass: null, factIds: candidates.map((fact) => fact.factId).sort(), reason: "invalid_authority_record" };
  if (!candidates.length) return { subjectKey, field: input.field, status: "unknown", safetyClass: policy.safetyClass, factIds: [], reason: "no_active_fact" };

  const verified: FactRecord[] = [];
  for (const fact of candidates) if (await verifyFactRecord(fact)) verified.push(fact);
  if (verified.length !== candidates.length) return { subjectKey, field: input.field, status: "blocked", safetyClass: policy.safetyClass, factIds: candidates.map((fact) => fact.factId).sort(), reason: "invalid_authority_record" };

  for (const conflict of input.conflicts) {
    if (conflict.status !== "open" || conflict.field !== input.field || factSubjectKey(conflict.subject) !== subjectKey) continue;
    if (!await verifyConflictSet(conflict)) return { subjectKey, field: input.field, status: "blocked", safetyClass: policy.safetyClass, factIds: candidates.map((fact) => fact.factId).sort(), reason: "invalid_authority_record" };
    if (conflict.factIds.some((id) => verified.some((fact) => fact.factId === id))) {
      return { subjectKey, field: input.field, status: "blocked", safetyClass: policy.safetyClass, factIds: verified.map((fact) => fact.factId).sort(), reason: "open_conflict" };
    }
  }

  const values = new Set(verified.map((fact) => sha256Json({ value: fact.value, unit: fact.unit })));
  if (values.size > 1) return { subjectKey, field: input.field, status: "blocked", safetyClass: policy.safetyClass, factIds: verified.map((fact) => fact.factId).sort(), reason: "conflict_set_required" };
  const selected = [...verified].sort((left, right) => authorityRank(left) - authorityRank(right) || left.factId.localeCompare(right.factId))[0]!;
  if (!canFactAloneSupportSafetyPass(selected, input.passContextFor(selected))) {
    return { subjectKey, field: input.field, status: "blocked", safetyClass: policy.safetyClass, factIds: verified.map((fact) => fact.factId).sort(), reason: "insufficient_authority_or_scope" };
  }
  return {
    subjectKey,
    field: input.field,
    status: "resolved",
    safetyClass: policy.safetyClass,
    factIds: verified.map((fact) => fact.factId).sort(),
    value: structuredClone(selected.value),
    ...(selected.unit !== undefined ? { unit: selected.unit } : {}),
    reason: "resolved_verified",
  };
}

export async function resolveFactGraph(input: {
  facts: readonly FactRecord[];
  conflicts: readonly ConflictSet[];
  passContextFor(fact: FactRecord): SafetyFactPassContext | undefined;
}): Promise<ResolvedFactField[]> {
  const groups = new Map<string, { subject: FactSubject; field: string; facts: FactRecord[] }>();
  for (const fact of currentFacts(input.facts)) {
    const key = `${factSubjectKey(fact.subject)}\0${fact.field}`;
    const group = groups.get(key) ?? { subject: fact.subject, field: fact.field, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  }
  const results: ResolvedFactField[] = [];
  for (const group of [...groups.values()].sort((left, right) => `${factSubjectKey(left.subject)}\0${left.field}`.localeCompare(`${factSubjectKey(right.subject)}\0${right.field}`))) {
    results.push(await resolveFactField({ ...group, conflicts: input.conflicts, passContextFor: input.passContextFor }));
  }
  return results;
}
