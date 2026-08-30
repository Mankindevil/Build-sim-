import type { ComponentKindId } from "../contracts/registries";
import { factFieldPolicy, type FactScope } from "../facts/field-registry";
import type { ConflictSet, FactRecord } from "../facts/contracts";
import type { GovernedEvaluationInput } from "../server/evaluation-service";
import type { ComponentInstance } from "../topology/contracts";
import { validateBuildConfigV3 } from "../topology/validation";
import { projectTopologyBom } from "../topology/projections";
import {
  allocateRequirementSupplies,
  deriveRequirementReadiness,
  projectPackageInstanceSupplies,
  type AllocatableRequirementSupply,
} from "../requirements/allocation";
import { computeRequirementClosure, type RequirementClosureRule } from "../requirements/closure";
import { validateRequirementClosureReplayRuntime } from "../requirements/runtime.mjs";
import type { EvaluationDecision, RequirementNode } from "../requirements/contracts";
import {
  evaluateAssemblySafety,
  projectVerifiedAssemblySupplies,
  type AssemblySafetyEvaluation,
  type AssemblySafetyInput,
} from "../requirements/assembly-safety";
import { createAssemblyResourcePatternClosureRule } from "../requirements/patterns";
import { evaluateFirmwarePath } from "../firmware/evaluate";
import { evaluateFirmwareRequirementBatchFixedPoint } from "../firmware/fixed-point";
import type { FirmwarePathEvaluation, FirmwarePathEvaluationInput } from "../firmware/contracts";
import type { CaseAdapterArtifactPayload } from "../adapters/registry";
import { SystemProfileRegistry } from "../system-profiles/registry";
import { evaluateSystemProfile } from "../system-profiles/evaluate";
import type { SystemCheckAuthority, SystemProfileEvaluation } from "../system-profiles/contracts";
import { validateWorkspaceSystemProfilePayloadRuntime } from "../system-profiles/runtime.mjs";
import { evaluateProductionThermalAcoustic, type ProductionThermalAcousticEvaluation } from "../simulation/evaluate";
import {
  COMPATIBILITY_DOMAINS,
  type CompatibilityRuleContext,
  type DomainEvaluation,
  type GovernedCompatibilityRule,
  type MissingRuleInput,
  type ProgressiveBuildEvaluation,
  type ProgressivePriceProjection,
  type ProgressiveVerdict,
  type RuleEvaluationRecord,
  validateCompatibilityRuleDefinition,
  validateProgressiveBuildEvaluation,
  validateProgressiveBuildEvaluationClosure,
} from "./contracts";
import { compatibilityDecision, compatibilityRequirement } from "./explain";
import {
  missingComponentRequirement,
  missingFactRequirement,
  missingInputKey,
  missingTopologyRequirement,
} from "./requirements";
import {
  BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS,
  BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES,
  BUILTIN_COMPATIBILITY_RULES,
} from "./rules";
import {
  firmwareCapabilityTupleKeyRuntime,
  firmwareExecutableFactAuthorityErrorsRuntime,
  projectProgressivePriceRuntime,
  validateAssemblyObservationBindingsRuntime,
} from "./runtime.mjs";

const SCOPE_RANK: Readonly<Record<FactScope, number>> = Object.freeze({
  family: 0,
  model: 1,
  variant: 2,
  revision: 3,
  plan_subject: 4,
});

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  throw new TypeError("non-JSON compatibility fact value");
}

function aggregateVerdicts(verdicts: readonly ProgressiveVerdict[]): ProgressiveVerdict {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("blocked")) return "blocked";
  if (verdicts.includes("unknown")) return "unknown";
  return verdicts.length > 0 ? "pass" : "unknown";
}

function subjectMatchesInstance(fact: FactRecord, component: ComponentInstance, planId: string): boolean {
  if (fact.subject.kind === "product") return component.identity.status === "resolved" && fact.subject.skuId === component.identity.skuId;
  if (fact.subject.planId !== planId) return false;
  const subject = fact.subject.subjectRef;
  return ("instanceId" in subject && subject.instanceId === component.instanceId)
    || (subject.kind === "mount" && subject.ownerInstanceId === component.instanceId);
}

function conflictMatchesInstance(conflict: ConflictSet, component: ComponentInstance, planId: string): boolean {
  if (conflict.subject.kind === "product") return component.identity.status === "resolved" && conflict.subject.skuId === component.identity.skuId;
  if (conflict.subject.planId !== planId) return false;
  const subject = conflict.subject.subjectRef;
  return ("instanceId" in subject && subject.instanceId === component.instanceId)
    || (subject.kind === "mount" && subject.ownerInstanceId === component.instanceId);
}

function ruleArtifactId(rule: GovernedCompatibilityRule): string {
  return `${rule.definition.ruleId}@${rule.definition.ruleVersion}`;
}

function assertLockedInput(input: GovernedEvaluationInput, rules: readonly GovernedCompatibilityRule[]): void {
  if (input.config.schemaVersion !== "3.0.0") throw new TypeError("progressive evaluator accepts only governed BuildConfig V3 input");
  const configErrors = validateBuildConfigV3(input.config);
  if (configErrors.length) throw new TypeError(`invalid governed V3 config: ${configErrors.join("; ")}`);
  if (input.planId !== input.config.id || input.evaluationLock.planId !== input.planId) throw new TypeError("progressive evaluator plan identity mismatch");
  if (!sameJson(input.snapshotHashes, input.evaluationLock.snapshotHashes)) throw new TypeError("progressive evaluator snapshot/lock binding mismatch");
  if (input.evaluationLock.artifactLockfileHash !== input.artifactLockfile.lockfileHash) throw new TypeError("progressive evaluator artifact lockfile binding mismatch");
  for (const role of ["ruleSet", "engine"] as const) {
    const loaded = input.artifacts[role].ref;
    const locked = input.artifactLockfile.artifacts[role];
    const snapshotHash = role === "ruleSet" ? input.snapshotHashes.ruleSetHash : input.snapshotHashes.engineHash;
    if (loaded.ref !== `sha256:${loaded.contentHash}` || locked.ref !== loaded.ref || locked.contentHash !== loaded.contentHash || snapshotHash !== loaded.contentHash) {
      throw new TypeError(`progressive evaluator ${role} authority binding mismatch`);
    }
  }
  const payload = input.artifacts.ruleSet.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as { ruleIds?: unknown }).ruleIds)) {
    throw new TypeError("locked ruleSet manifest unavailable");
  }
  const lockedRuleIds = (payload as { ruleIds: unknown[] }).ruleIds;
  if (lockedRuleIds.some((id) => typeof id !== "string") || new Set(lockedRuleIds).size !== lockedRuleIds.length) {
    throw new TypeError("locked ruleSet manifest IDs invalid");
  }
  const sortedLocked = [...lockedRuleIds as string[]].sort(compare);
  if (!sameJson(lockedRuleIds, sortedLocked)) throw new TypeError("locked ruleSet manifest IDs must be canonical");
  const payloadSources = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(payloadSources)) throw new TypeError("locked ruleSet sources unavailable");
  const manifestSource = payloadSources.find((source) => source && typeof source === "object" && !Array.isArray(source)
    && (source as { moduleId?: unknown }).moduleId === "compatibility/rule-manifest") as { bytes?: unknown } | undefined;
  let lockedManifest: unknown;
  try { lockedManifest = typeof manifestSource?.bytes === "string" ? JSON.parse(manifestSource.bytes) : null; }
  catch { lockedManifest = null; }
  if (!sameJson(lockedManifest, BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES)) {
    throw new TypeError("locked compatibility rule manifest differs from executable builtins");
  }
  const enginePayload = input.artifacts.engine.payload as { sources?: unknown };
  if (!Array.isArray(enginePayload?.sources)) throw new TypeError("locked engine implementation sources unavailable");
  const engineModules = new Set(enginePayload.sources.flatMap((source) => source && typeof source === "object" && !Array.isArray(source)
    && typeof (source as { moduleId?: unknown }).moduleId === "string" ? [(source as { moduleId: string }).moduleId] : []));
  for (const entry of BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES) {
    if (entry.implementationModuleIds.some((moduleId) => !engineModules.has(moduleId))) {
      throw new TypeError(`locked engine omits implementation source for ${entry.ruleId}`);
    }
  }
  const compatibilityIds = (lockedRuleIds as string[]).filter((id) => id.startsWith("compat."));
  if (!sameJson(compatibilityIds, BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS)) {
    throw new TypeError("locked compatibility rule IDs differ from executable builtins");
  }
  for (const rule of rules) {
    const errors = validateCompatibilityRuleDefinition(rule.definition);
    if (errors.length) throw new TypeError(`invalid compatibility rule ${rule.definition.ruleId}: ${errors.join("; ")}`);
    if (!lockedRuleIds.includes(ruleArtifactId(rule))) throw new TypeError(`compatibility rule is absent from locked ruleSet: ${ruleArtifactId(rule)}`);
  }
}

function applies(rule: GovernedCompatibilityRule, components: readonly ComponentInstance[]): boolean {
  const activation = rule.definition.activation;
  if (activation.topology === "non_empty" && components.length === 0) return false;
  return activation.anyComponentKinds.length === 0
    || activation.anyComponentKinds.some((kind) => components.some((component) => component.kind === kind));
}

interface PreflightResult {
  inputStatus: RuleEvaluationRecord["inputStatus"];
  missingInputs: MissingRuleInput[];
  conflictSetIds: string[];
  requirements: RequirementNode[];
  selectedFacts: Map<string, FactRecord[]>;
  selectedIdentityFacts: Map<string, FactRecord[]>;
  allowedFactKeys: Set<string>;
}

function factKey(instanceId: string, field: string): string {
  return `${instanceId}\0${field}`;
}

function factCandidates(
  input: GovernedEvaluationInput,
  component: ComponentInstance,
  field: string,
): FactRecord[] {
  return input.factClosure.facts
    .filter((fact) => fact.field === field && subjectMatchesInstance(fact, component, input.planId))
    .sort((left, right) => compare(left.factId, right.factId));
}

function preflightRule(input: GovernedEvaluationInput, rule: GovernedCompatibilityRule): PreflightResult {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable V2 compatibility preflight");
  const definition = rule.definition;
  const missingInputs: MissingRuleInput[] = [];
  const requirements: RequirementNode[] = [];
  const conflictSetIds = new Set<string>();
  const selectedFacts = new Map<string, FactRecord[]>();
  const selectedIdentityFacts = new Map<string, FactRecord[]>();
  const allowedFactKeys = new Set<string>();
  const ofKind = (kind: ComponentKindId) => config.components.filter((component) => component.kind === kind);

  definition.requiredInputs.componentKinds.forEach((declaration, index) => {
    const present = ofKind(declaration.componentKind);
    if (present.length >= declaration.minCount) return;
    missingInputs.push({
      kind: "component",
      ref: declaration.componentKind,
      instanceIds: present.map(({ instanceId }) => instanceId).sort(compare),
      safetyClass: definition.safetyClass,
    });
    requirements.push(missingComponentRequirement(definition, declaration, index));
  });

  for (const declaration of definition.requiredInputs.facts) {
    if (!factFieldPolicy(declaration.field)) throw new TypeError(`rule uses non-governed fact field ${declaration.field}`);
    for (const component of ofKind(declaration.componentKind)) {
      allowedFactKeys.add(factKey(component.instanceId, declaration.field));
      const conflicts = input.factClosure.conflicts.filter((conflict) => conflict.status === "open"
        && conflict.field === declaration.field && conflictMatchesInstance(conflict, component, input.planId));
      conflicts.forEach(({ conflictSetId }) => conflictSetIds.add(conflictSetId));
      const current = factCandidates(input, component, declaration.field);
      const active = current.filter((candidate) => candidate.status === "active");
      const unresolved = current.some((candidate) => candidate.status === "unresolved_blocker" || candidate.status === "conflicted");
      const accepted = active.filter((candidate) => {
        if (declaration.requiredAuthority === "official" && candidate.authority !== "official") return false;
        if (declaration.requiredAuthority === "governed" && candidate.authority === "agent_inference") return false;
        if (candidate.scope === "plan_subject") return declaration.minimumScope === "plan_subject";
        if (declaration.minimumScope === "plan_subject") return false;
        return SCOPE_RANK[candidate.scope]! >= SCOPE_RANK[declaration.minimumScope]!;
      });
      const values = new Set(accepted.map((candidate) => canonicalJson({ value: candidate.value, unit: candidate.unit ?? null })));
      if (conflicts.length > 0 || (declaration.cardinality === "single" && values.size > 1)) {
        missingInputs.push({
          kind: "fact",
          ref: `${component.instanceId}:${declaration.field}:conflict`,
          instanceIds: [component.instanceId],
          safetyClass: declaration.safetyClass,
        });
        requirements.push(missingFactRequirement(definition, declaration, component.instanceId));
        continue;
      }
      if (unresolved || accepted.length === 0) {
        missingInputs.push({
          kind: "fact",
          ref: `${component.instanceId}:${declaration.field}`,
          instanceIds: [component.instanceId],
          safetyClass: declaration.safetyClass,
        });
        requirements.push(missingFactRequirement(definition, declaration, component.instanceId));
        continue;
      }
      selectedFacts.set(factKey(component.instanceId, declaration.field), accepted);
    }
  }

  if (definition.requiredInputs.identityClosure !== null) {
    for (const component of config.components) {
      const conflicts = input.factClosure.conflicts.filter((conflict) => conflict.status === "open"
        && conflict.field.startsWith("identity.") && conflictMatchesInstance(conflict, component, input.planId));
      conflicts.forEach(({ conflictSetId }) => conflictSetIds.add(conflictSetId));
      const identity = component.identity.status === "resolved" ? component.identity : null;
      const facts = identity === null ? [] : input.factClosure.facts.filter((candidate) => candidate.status === "active"
        && candidate.authority !== "agent_inference" && subjectMatchesInstance(candidate, component, input.planId)
        && (identity.identityClaimIds.includes(candidate.factId)
          || candidate.evidenceRefs.some((ref) => identity.identityClaimIds.includes(ref))))
        .sort((left, right) => compare(left.factId, right.factId));
      if (identity === null || facts.length === 0 || conflicts.length > 0) {
        missingInputs.push({
          kind: "fact",
          ref: `${component.instanceId}:identity-closure${conflicts.length > 0 ? ":conflict" : ""}`,
          instanceIds: [component.instanceId],
          safetyClass: definition.requiredInputs.identityClosure.safetyClass,
        });
        requirements.push(missingFactRequirement(definition, {
          componentKind: component.kind,
          field: "identity.model",
          cardinality: "single",
          safetyClass: definition.requiredInputs.identityClosure.safetyClass,
          requiredAuthority: "governed",
          minimumScope: "model",
          missingRequirementKind: definition.requiredInputs.identityClosure.missingRequirementKind,
        }, component.instanceId));
      } else {
        selectedIdentityFacts.set(component.instanceId, facts);
      }
    }
  }

  for (const declaration of definition.requiredInputs.placements) {
    const components = ofKind(declaration.componentKind);
    const owners = new Set(ofKind(declaration.mountOwnerKind).map(({ instanceId }) => instanceId));
    // A placement dependency applies to present children only. Optional absent
    // device classes never manufacture phantom placement requirements.
    if (components.length === 0 || owners.size === 0) continue;
    const matched = config.placements.filter((placement) => components.some(({ instanceId }) => instanceId === placement.componentInstanceId)
      && owners.has(placement.mountOwnerInstanceId));
    if (matched.length >= declaration.minCount) continue;
    const instanceIds = [...components.map(({ instanceId }) => instanceId), ...owners].sort(compare);
    const ref = `${declaration.componentKind}-in-${declaration.mountOwnerKind}`;
    missingInputs.push({ kind: "placement", ref, instanceIds, safetyClass: definition.safetyClass });
    requirements.push(missingTopologyRequirement(definition, "placement", ref, instanceIds));
  }

  for (const declaration of definition.requiredInputs.connections) {
    const left = new Set(ofKind(declaration.fromKind).map(({ instanceId }) => instanceId));
    const right = new Set(ofKind(declaration.toKind).map(({ instanceId }) => instanceId));
    // Missing component roles are declared separately; a connection cannot be
    // required for an optional endpoint that is not in the locked topology.
    if (left.size === 0 || right.size === 0) continue;
    const matched = config.connections.filter((connection) => {
      const endpointsMatch = (left.has(connection.from.instanceId) && right.has(connection.to.instanceId))
        || (right.has(connection.from.instanceId) && left.has(connection.to.instanceId));
      return endpointsMatch && (!declaration.cableRequired || connection.cableInstanceId !== undefined);
    });
    if (matched.length >= declaration.minCount) continue;
    const instanceIds = [...left, ...right].sort(compare);
    const ref = `${declaration.fromKind}-to-${declaration.toKind}`;
    missingInputs.push({ kind: "connection", ref, instanceIds, safetyClass: definition.safetyClass });
    requirements.push(missingTopologyRequirement(definition, "connection", ref, instanceIds));
  }

  const profile = definition.requiredInputs.systemProfile;
  if (profile?.required && (!config.system || (profile.allowedProfileIds.length > 0 && !profile.allowedProfileIds.includes(config.system.profileId)))) {
    const ref = profile.allowedProfileIds.length > 0 ? profile.allowedProfileIds.join("+") : "system-selection";
    missingInputs.push({ kind: "system_profile", ref, instanceIds: [], safetyClass: "normal" });
    requirements.push(missingTopologyRequirement(definition, "system_profile", ref, []));
  }

  const uniqueRequirements = new Map<string, RequirementNode>();
  for (const requirement of requirements) {
    const previous = uniqueRequirements.get(requirement.requirementId);
    if (previous && !sameJson(previous, requirement)) throw new Error(`conflicting requirements for ${requirement.requirementId}`);
    uniqueRequirements.set(requirement.requirementId, requirement);
  }
  const normalizedMissing = [...new Map(missingInputs.map((candidate) => [missingInputKey(candidate), candidate])).values()]
    .sort((left, right) => compare(missingInputKey(left), missingInputKey(right)));
  const conflictIds = [...conflictSetIds].sort(compare);
  const inputStatus: PreflightResult["inputStatus"] = conflictIds.length > 0 ? "conflicted" : normalizedMissing.length > 0 ? "missing" : "complete";
  return {
    inputStatus,
    missingInputs: normalizedMissing,
    conflictSetIds: conflictIds,
    requirements: [...uniqueRequirements.values()].sort((left, right) => compare(left.requirementId, right.requirementId)),
    selectedFacts,
    selectedIdentityFacts,
    allowedFactKeys,
  };
}

interface NestedEvaluationContext {
  firmwareEvaluations: CompatibilityRuleContext["firmwareEvaluations"];
  assemblySafetyEvaluations: CompatibilityRuleContext["assemblySafetyEvaluations"];
  systemProfileEvaluation: CompatibilityRuleContext["systemProfileEvaluation"];
  thermalAcousticEvaluation: CompatibilityRuleContext["thermalAcousticEvaluation"];
}

function contextFor(
  input: GovernedEvaluationInput,
  preflight: PreflightResult,
  rule: GovernedCompatibilityRule,
  nested: NestedEvaluationContext,
): CompatibilityRuleContext {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable V2 compatibility context");
  const definition = rule.definition.requiredInputs;
  const kinds = new Set<ComponentKindId>([
    ...definition.componentKinds.map(({ componentKind }) => componentKind),
    ...definition.facts.map(({ componentKind }) => componentKind),
    ...definition.placements.flatMap(({ componentKind, mountOwnerKind }) => [componentKind, mountOwnerKind]),
    ...definition.connections.flatMap(({ fromKind, toKind }) => [fromKind, toKind]),
  ]);
  const components = definition.identityClosure === null && !definition.nestedEvaluations.assemblySafety
    ? config.components.filter((component) => kinds.has(component.kind)) : config.components;
  const componentIds = new Set(components.map(({ instanceId }) => instanceId));
  const placements = config.placements.filter((placement) => definition.placements.some((declaration) => {
    const child = config.components.find((component) => component.instanceId === placement.componentInstanceId);
    const owner = config.components.find((component) => component.instanceId === placement.mountOwnerInstanceId);
    return child?.kind === declaration.componentKind && owner?.kind === declaration.mountOwnerKind;
  }));
  const connections = config.connections.filter((connection) => definition.connections.some((declaration) => {
    const left = config.components.find((component) => component.instanceId === connection.from.instanceId)?.kind;
    const right = config.components.find((component) => component.instanceId === connection.to.instanceId)?.kind;
    return (left === declaration.fromKind && right === declaration.toKind)
      || (left === declaration.toKind && right === declaration.fromKind);
  }));
  return Object.freeze({
    components,
    placements,
    connections,
    systemProfile: definition.systemProfile === null ? null : config.system,
    firmwareEvaluations: definition.nestedEvaluations.firmwarePaths ? nested.firmwareEvaluations : [],
    firmwareTargets: definition.nestedEvaluations.firmwarePaths ? config.firmwareTargets : [],
    assemblySafetyEvaluations: definition.nestedEvaluations.assemblySafety ? nested.assemblySafetyEvaluations : [],
    systemProfileEvaluation: definition.nestedEvaluations.systemProfileChecks ? nested.systemProfileEvaluation : null,
    thermalAcousticEvaluation: definition.nestedEvaluations.thermalAcoustic ? nested.thermalAcousticEvaluation : null,
    logicalLayouts: definition.logicalLayouts ? config.logicalLayouts : [],
    componentsOfKind: (kind: ComponentKindId) => components.filter((component) => component.kind === kind),
    factsFor: (instance: ComponentInstance, field: string) => {
      const key = factKey(instance.instanceId, field);
      if (!componentIds.has(instance.instanceId) || !preflight.allowedFactKeys.has(key)) {
        throw new TypeError(`compatibility rule attempted undeclared fact access: ${instance.instanceId}:${field}`);
      }
      return preflight.selectedFacts.get(key) ?? [];
    },
    identityFactsFor: (instance: ComponentInstance) => {
      if (definition.identityClosure === null || !componentIds.has(instance.instanceId)) {
        throw new TypeError(`compatibility rule attempted undeclared identity access: ${instance.instanceId}`);
      }
      return preflight.selectedIdentityFacts.get(instance.instanceId) ?? [];
    },
  });
}

function resultVerdict(decisions: readonly EvaluationDecision[]): ProgressiveVerdict {
  return aggregateVerdicts(decisions.map(({ verdict }) => verdict));
}

function preflightEvidenceFactIds(
  input: GovernedEvaluationInput,
  preflight: PreflightResult,
  rule: GovernedCompatibilityRule,
): string[] {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") return [];
  const ids = new Set<string>();
  for (const missing of preflight.missingInputs.filter((candidate) => candidate.kind === "fact")) {
    for (const instanceId of missing.instanceIds) {
      const component = config.components.find((candidate) => candidate.instanceId === instanceId);
      if (!component) continue;
      if (missing.ref.startsWith(`${instanceId}:identity-closure`)) {
        input.factClosure.facts
          .filter((fact) => fact.field.startsWith("identity.") && subjectMatchesInstance(fact, component, input.planId))
          .forEach(({ factId }) => ids.add(factId));
        continue;
      }
      for (const declaration of rule.definition.requiredInputs.facts) {
        if (declaration.componentKind !== component.kind
          || !missing.ref.startsWith(`${instanceId}:${declaration.field}`)) continue;
        factCandidates(input, component, declaration.field).forEach(({ factId }) => ids.add(factId));
      }
    }
  }
  return [...ids].sort(compare);
}

function evaluateRule(
  input: GovernedEvaluationInput,
  rule: GovernedCompatibilityRule,
  nested: NestedEvaluationContext,
): { record: RuleEvaluationRecord; decisions: EvaluationDecision[]; requirements: RequirementNode[] } {
  const preflight = preflightRule(input, rule);
  const definition = rule.definition;
  if (preflight.inputStatus !== "complete") {
    const blocks = preflight.inputStatus === "conflicted"
      || preflight.missingInputs.some((missing) => missing.kind === "fact" && missing.safetyClass !== "normal")
      || preflight.missingInputs.some((missing) => missing.kind === "connection" && missing.safetyClass === "electrical_safety");
    const decisions = blocks ? [compatibilityDecision({
      ruleId: definition.ruleId,
      ruleVersion: definition.ruleVersion,
      discriminator: preflight.inputStatus,
      verdict: "blocked",
      domain: definition.domain,
      message: preflight.inputStatus === "conflicted"
        ? "This rule is blocked by an open conflict in one of its declared inputs."
        : "This rule is blocked because a boot or electrical-safety fact is unavailable.",
      factIds: preflightEvidenceFactIds(input, preflight, rule),
      instanceIds: preflight.missingInputs.flatMap(({ instanceIds }) => instanceIds),
      remediation: preflight.requirements,
    })] : [];
    return {
      record: {
        ruleId: definition.ruleId,
        ruleVersion: definition.ruleVersion,
        domain: definition.domain,
        applicability: "applicable",
        verdict: blocks ? "blocked" : "unknown",
        inputStatus: preflight.inputStatus,
        decisionIds: decisions.map(({ decisionId }) => decisionId).sort(compare),
        requirementIds: preflight.requirements.map(({ requirementId }) => requirementId).sort(compare),
        conflictSetIds: preflight.conflictSetIds,
        missingInputs: preflight.missingInputs,
      },
      decisions,
      requirements: preflight.requirements,
    };
  }

  let execution: ReturnType<GovernedCompatibilityRule["evaluate"]>;
  try {
    execution = rule.evaluate(contextFor(input, preflight, rule, nested));
  } catch {
    const requirement = compatibilityRequirement({
      ruleId: definition.ruleId,
      ruleVersion: definition.ruleVersion,
      discriminator: "rule-execution",
      kind: "evidence",
      criticality: definition.safetyClass === "electrical_safety" ? "safety" : definition.safetyClass === "boot" ? "boot" : "normal",
      ...(definition.safetyClass === "electrical_safety" ? { requiredBefore: "pre_power" as const }
        : definition.safetyClass === "boot" ? { requiredBefore: "first_boot" as const } : {}),
    });
    const decision = compatibilityDecision({
      ruleId: definition.ruleId,
      ruleVersion: definition.ruleVersion,
      discriminator: "execution-unavailable",
      verdict: "blocked",
      domain: definition.domain,
      message: "The locked rule could not produce a valid evaluation and failed closed.",
      remediation: [requirement],
    });
    return {
      record: {
        ruleId: definition.ruleId, ruleVersion: definition.ruleVersion, domain: definition.domain,
        applicability: "applicable",
        verdict: "blocked", inputStatus: "complete", decisionIds: [decision.decisionId],
        requirementIds: [requirement.requirementId], conflictSetIds: [], missingInputs: [],
      },
      decisions: [decision], requirements: [requirement],
    };
  }
  const decisions = [...execution.decisions].sort((left, right) => compare(left.decisionId, right.decisionId));
  const requirements = [...(execution.requirements ?? [])].sort((left, right) => compare(left.requirementId, right.requirementId));
  if (decisions.length === 0
    || decisions.some((decision) => decision.ruleId !== definition.ruleId || decision.ruleVersion !== definition.ruleVersion || decision.domain !== definition.domain)
    || requirements.some((requirement) => requirement.producedBy.ruleId !== definition.ruleId || requirement.producedBy.ruleVersion !== definition.ruleVersion)) {
    throw new TypeError(`locked compatibility rule emitted invalid authority: ${ruleArtifactId(rule)}`);
  }
  return {
    record: {
      ruleId: definition.ruleId,
      ruleVersion: definition.ruleVersion,
      domain: definition.domain,
      applicability: "applicable",
      verdict: resultVerdict(decisions),
      inputStatus: "complete",
      decisionIds: decisions.map(({ decisionId }) => decisionId),
      requirementIds: requirements.map(({ requirementId }) => requirementId),
      conflictSetIds: [],
      missingInputs: [],
    },
    decisions,
    requirements,
  };
}

function notApplicableRule(rule: GovernedCompatibilityRule): {
  record: RuleEvaluationRecord;
  decisions: EvaluationDecision[];
  requirements: RequirementNode[];
} {
  return {
    record: {
      ruleId: rule.definition.ruleId,
      ruleVersion: rule.definition.ruleVersion,
      domain: rule.definition.domain,
      applicability: "not_applicable",
      verdict: "not_applicable",
      inputStatus: "complete",
      decisionIds: [],
      requirementIds: [],
      conflictSetIds: [],
      missingInputs: [],
    },
    decisions: [],
    requirements: [],
  };
}

function buildDomainEvaluations(records: readonly RuleEvaluationRecord[]): DomainEvaluation[] {
  return COMPATIBILITY_DOMAINS.map((domain) => {
    const registeredRules = records.filter((record) => record.domain === domain);
    const rules = registeredRules.filter((record) => record.applicability === "applicable");
    const applicableRuleIds = rules.map((record) => `${record.ruleId}@${record.ruleVersion}`).sort(compare);
    const evaluatedRuleIds = rules.filter((record) => record.verdict === "pass" || record.verdict === "fail").map((record) => `${record.ruleId}@${record.ruleVersion}`).sort(compare);
    const blockedRuleIds = rules.filter((record) => record.verdict === "blocked").map((record) => `${record.ruleId}@${record.ruleVersion}`).sort(compare);
    const unknownRuleIds = rules.filter((record) => record.verdict === "unknown").map((record) => `${record.ruleId}@${record.ruleVersion}`).sort(compare);
    return {
      domain,
      verdict: aggregateVerdicts(rules.map(({ verdict }) => verdict).filter((verdict): verdict is ProgressiveVerdict => verdict !== "not_applicable")),
      registeredRuleIds: registeredRules.map((record) => `${record.ruleId}@${record.ruleVersion}`).sort(compare),
      applicableRuleIds,
      evaluatedRuleIds,
      blockedRuleIds,
      unknownRuleIds,
      decisionIds: rules.flatMap(({ decisionIds }) => decisionIds).sort(compare),
      requirementIds: rules.flatMap(({ requirementIds }) => requirementIds).sort(compare),
      conflictSetIds: [...new Set(rules.flatMap(({ conflictSetIds }) => conflictSetIds))].sort(compare),
      evaluatedCoverage: {
        registeredRuleCount: registeredRules.length,
        applicableRuleCount: applicableRuleIds.length,
        evaluatedRuleCount: evaluatedRuleIds.length,
        blockedRuleCount: blockedRuleIds.length,
        unknownRuleCount: unknownRuleIds.length,
      },
    };
  });
}

export interface ProgressiveCompatibilityAuthorityResolver {
  /** Read-only repository/root projection; raw prebuilt evaluations are never accepted. */
  resolveAssemblySafetyInputs?(input: GovernedEvaluationInput): Promise<readonly AssemblySafetyInput[]>;
  /** Resolve a raw capability/path input for exactly one locked config target. */
  resolveFirmwarePathInput?(
    input: GovernedEvaluationInput,
    target: Readonly<NonNullable<Extract<GovernedEvaluationInput["config"], { schemaVersion: "3.0.0" }>["firmwareTargets"]>[number]>,
  ): Promise<FirmwarePathEvaluationInput | null>;
  /** Resolve raw support observations/facts. The engine derives the final profile evaluation. */
  resolveSystemCheckAuthorities?(
    input: GovernedEvaluationInput,
    firmwareEvaluations: readonly FirmwarePathEvaluation[],
  ): Promise<readonly SystemCheckAuthority[]>;
}

export interface ProgressiveCompatibilityOptions {
  /** Optional repository/root resolver. It cannot inject supplies or completed evaluations. */
  authorityResolver?: ProgressiveCompatibilityAuthorityResolver;
  /** Production rollout controls. Direct/pinned evaluators default to enabled. */
  thermalV3Enabled?: boolean;
  acousticV3Enabled?: boolean;
}

function assertAssemblyInputClosure(input: GovernedEvaluationInput, values: readonly AssemblySafetyInput[]): void {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable assembly V2 closure");
  const instances = new Set(config.components.map(({ instanceId }) => instanceId));
  const facts = new Set(input.factClosure.facts.map(({ factId }) => factId));
  const observations = new Set(input.observationClosure.observations.map(({ observation }) => observation.observationId));
  for (const value of values) for (const check of value.checks) {
    if (check.instanceIds.some((instanceId) => !instances.has(instanceId)) || !instances.has(check.ownerInstanceId)) {
      throw new TypeError(`assembly input ${value.assemblyId} references an instance outside the locked config`);
    }
    if (check.factIds.some((factId) => !facts.has(factId))) throw new TypeError(`assembly input ${value.assemblyId} references a fact outside the locked closure`);
    if (check.observationIds.some((observationId) => !observations.has(observationId))) {
      throw new TypeError(`assembly input ${value.assemblyId} references an observation outside the locked closure`);
    }
  }
}

function assertFirmwareObservationClosure(
  input: GovernedEvaluationInput,
  targetInstanceId: string,
  current: NonNullable<FirmwarePathEvaluationInput["currentObservation"]>,
): void {
  const entry = input.observationClosure.observations.find(({ observation }) => observation.observationId === current.observationId);
  const observation = entry?.observation;
  const allowedMethods = current.method === "label_observation"
    ? ["label", "photo", "visual_confirmation"] : ["photo", "visual_confirmation", "user_assertion"];
  const authorityRef = entry === undefined ? "" : `observation:${current.observationId}@sha256:${entry.recordHash}`;
  const allowedEvidence = new Set([...(observation?.attachmentRefs ?? []), authorityRef]);
  if (!entry || !observation || observation.planId !== input.planId
    || observation.subjectRef.kind !== "firmware_instance" || observation.subjectRef.instanceId !== targetInstanceId
    || observation.fieldId !== "firmware.bios_version" || observation.value !== current.releaseFactId
    || observation.status !== "active" || !observation.confirmedByUser || observation.validatedAt === undefined
    || observation.invalidatedAt !== undefined || entry.attachmentClosureVerified !== true
    || entry.projectionContext.planId !== input.planId || !entry.projectionContext.subjectExists
    || entry.projectionContext.currentConfigHash !== input.snapshotHashes.configHash
    || entry.projectionContext.currentSubjectRevisionHash !== observation.subjectRevisionHash
    || !allowedMethods.includes(observation.method)
    || current.evidenceRefs.length === 0 || current.evidenceRefs.some((ref) => !allowedEvidence.has(ref))) {
    throw new TypeError(`firmware current observation ${current.observationId} is not bound to the locked plan/subject/release authority`);
  }
}

function firmwareCpuSkuBinding(
  config: Extract<GovernedEvaluationInput["config"], { schemaVersion: "3.0.0" }>,
  targetInstanceId: string,
): { skuId: string | null; ambiguous: boolean } {
  const cpuById = new Map(config.components.filter(({ kind }) => kind === "cpu")
    .map((component) => [component.instanceId, component]));
  const placed = config.placements
    .filter(({ mountOwnerInstanceId, componentInstanceId }) => mountOwnerInstanceId === targetInstanceId && cpuById.has(componentInstanceId))
    .map(({ componentInstanceId }) => cpuById.get(componentInstanceId)!);
  const candidates = placed.length > 0 ? placed : [...cpuById.values()];
  if (candidates.some(({ identity }) => identity.status !== "resolved")) return { skuId: null, ambiguous: candidates.length > 0 };
  const skuIds = [...new Set(candidates.flatMap(({ identity }) => identity.status === "resolved" ? [identity.skuId] : []))];
  return skuIds.length <= 1 ? { skuId: skuIds[0] ?? null, ambiguous: false } : { skuId: null, ambiguous: true };
}

function derivedFirmwareAvailableFactIds(
  input: GovernedEvaluationInput,
  capability: FirmwarePathEvaluationInput["capability"],
): string[] {
  const required = new Set(capability.transitions.flatMap(({ powerPrerequisiteFactIds }) => powerPrerequisiteFactIds));
  return input.factClosure.facts
    .filter(({ factId, status, authority }) => required.has(factId) && status === "active" && authority === "official")
    .map(({ factId }) => factId)
    .sort(compare);
}

function derivedFirmwarePreflight(
  targetInstanceId: string,
  assemblySafetyEvaluations: readonly AssemblySafetyEvaluation[],
): NonNullable<FirmwarePathEvaluationInput["preflight"]> {
  const supplies = assemblySafetyEvaluations.flatMap((evaluation) => [...projectVerifiedAssemblySupplies(evaluation)]);
  const hasVerifiedComponent = (category: string) => supplies.some((supply) => supply.source === "user_resource"
    && supply.ownerInstanceId === targetInstanceId && supply.kind === "component"
    && supply.availability === "present_verified" && supply.verificationStatus === "verified"
    && supply.facets.some((facet) => facet.facetId === "identity.category" && facet.value === category));
  return {
    workingCpuAvailable: hasVerifiedComponent("cpu") ? true : null,
    workingMemoryAvailable: hasVerifiedComponent("memory_module") ? true : null,
    displayPathAvailable: hasVerifiedComponent("gpu") ? true : null,
  };
}

function derivedFirmwareRequestedSettings(
  target: Extract<GovernedEvaluationInput["config"], { schemaVersion: "3.0.0" }>["firmwareTargets"][number],
  capability: FirmwarePathEvaluationInput["capability"],
): NonNullable<FirmwarePathEvaluationInput["requestedSettings"]> {
  const settingEvidence = new Map(capability.settings.map(({ settingId, sourceFactIds }) => [settingId, sourceFactIds]));
  return target.requestedSettings.map(({ settingId, desiredValue }) => ({
    settingId,
    desiredValue,
    evidenceRefs: [...(settingEvidence.get(settingId) ?? [])].sort(compare),
  })).sort((left, right) => compare(left.settingId, right.settingId));
}

function derivedFirmwareCurrentObservation(
  input: GovernedEvaluationInput,
  targetInstanceId: string,
  capability: FirmwarePathEvaluationInput["capability"],
): FirmwarePathEvaluationInput["currentObservation"] {
  const matches = input.observationClosure.observations.filter(({ observation }) => observation.planId === input.planId
    && observation.status === "active" && observation.subjectRef.kind === "firmware_instance"
    && observation.subjectRef.instanceId === targetInstanceId && observation.fieldId === "firmware.bios_version");
  if (matches.length > 1) throw new TypeError(`firmware current observation for ${targetInstanceId} is ambiguous`);
  const entry = matches[0];
  if (entry === undefined) return null;
  const observation = entry.observation;
  if (typeof observation.value !== "string") throw new TypeError(`firmware current observation for ${targetInstanceId} has a non-release value`);
  const current = {
    observationId: observation.observationId,
    releaseFactId: observation.value,
    method: capability.versionIdentification.method,
    evidenceRefs: [...new Set([
      ...observation.attachmentRefs,
      `observation:${observation.observationId}@sha256:${entry.recordHash}`,
    ])].sort(compare),
  };
  assertFirmwareObservationClosure(input, targetInstanceId, current);
  return current;
}

function assertFirmwareExecutableFactAuthority(
  input: GovernedEvaluationInput,
  evaluations: readonly FirmwarePathEvaluation[],
  capabilities: readonly FirmwarePathEvaluationInput["capability"][],
): void {
  const capabilityByHash = new Map(capabilities.map((capability) => [capability.contentHash, capability]));
  for (const evaluation of evaluations) {
    if (evaluation.verdict !== "pass") continue;
    const capability = capabilityByHash.get(evaluation.capabilityRef.contentHash);
    if (capability === undefined) {
      throw new TypeError(`firmware executable fact authority for ${evaluation.instanceId} cannot be derived`);
    }
    const authorityErrors = firmwareExecutableFactAuthorityErrorsRuntime(
      evaluation,
      capability,
      input.factClosure.facts,
    );
    if (authorityErrors.length > 0) {
      throw new TypeError(`firmware executable facts for ${evaluation.instanceId} lack active official authority or exact scoped semantics: ${authorityErrors.join("; ")}`);
    }
  }
}

async function resolveNestedEvaluations(
  input: GovernedEvaluationInput,
  resolver: ProgressiveCompatibilityAuthorityResolver | undefined,
  features: Pick<ProgressiveCompatibilityOptions, "thermalV3Enabled" | "acousticV3Enabled">,
): Promise<{
  assemblySafetyInputs: AssemblySafetyInput[];
  assemblySafetyEvaluations: AssemblySafetyEvaluation[];
  firmwareInputs: FirmwarePathEvaluationInput[];
  firmwareEvaluations: FirmwarePathEvaluation[];
  firmwareCapabilities: FirmwarePathEvaluationInput["capability"][];
  systemProfileEvaluation: SystemProfileEvaluation | null;
  thermalAcousticEvaluation: ProductionThermalAcousticEvaluation;
}> {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable nested V2 evaluation");
  const assemblyInputs = [...(await resolver?.resolveAssemblySafetyInputs?.(input) ?? [])]
    .sort((left, right) => compare(left.assemblyId, right.assemblyId));
  if (new Set(assemblyInputs.map(({ assemblyId }) => assemblyId)).size !== assemblyInputs.length) {
    throw new TypeError("assembly safety authorities must have unique IDs");
  }
  assertAssemblyInputClosure(input, assemblyInputs);
  const assemblySafetyEvaluations = assemblyInputs.map(evaluateAssemblySafety)
    .sort((left, right) => compare(left.assemblyId, right.assemblyId));
  const assemblyObservationErrors = validateAssemblyObservationBindingsRuntime(
    assemblySafetyEvaluations,
    input.observationClosure,
    config,
    input.snapshotHashes.configHash,
  );
  if (assemblyObservationErrors.length) {
    throw new TypeError(`assembly observation authority is invalid: ${assemblyObservationErrors.join("; ")}`);
  }
  const firmwareEvaluations: FirmwarePathEvaluation[] = [];
  const firmwareInputs: FirmwarePathEvaluationInput[] = [];
  const firmwareCapabilities: FirmwarePathEvaluationInput["capability"][] = [];
  for (const target of [...config.firmwareTargets].sort((left, right) => compare(left.instanceId, right.instanceId))) {
    const pathInput = await resolver?.resolveFirmwarePathInput?.(input, target) ?? null;
    if (pathInput === null) continue;
    const component = config.components.find(({ instanceId }) => instanceId === target.instanceId);
    if (!component || component.identity.status !== "resolved" || pathInput.instanceId !== target.instanceId
      || pathInput.capability.subjectSkuId !== component.identity.skuId
      || pathInput.capability.factSnapshotRef.snapshotId !== input.factClosure.snapshot.snapshotId
      || pathInput.capability.factSnapshotRef.contentHash !== input.snapshotHashes.factSnapshotHash
      || (pathInput.targetReleaseFactId !== undefined
        && pathInput.targetReleaseFactId !== target.targetReleaseFactId)) {
      throw new TypeError(`firmware authority for ${target.instanceId} is not bound to the locked target/component/snapshot`);
    }
    const cpuBinding = firmwareCpuSkuBinding(config, target.instanceId);
    if (cpuBinding.ambiguous || (pathInput.cpuSkuId !== undefined
      && (pathInput.cpuSkuId ?? null) !== cpuBinding.skuId)) {
      throw new TypeError(`firmware CPU authority for ${target.instanceId} is not bound to the locked topology`);
    }
    const availableFactIds = derivedFirmwareAvailableFactIds(input, pathInput.capability);
    if (pathInput.availableFactIds !== undefined
      && !sameJson([...pathInput.availableFactIds].sort(compare), availableFactIds)) {
      throw new TypeError(`firmware input ${target.instanceId} available facts differ from the locked exact projection`);
    }
    if ([...(pathInput.availableRequirementIds ?? [])].length > 0) {
      throw new TypeError(`firmware input ${target.instanceId} attempts to self-author requirement availability`);
    }
    const preflight = derivedFirmwarePreflight(target.instanceId, assemblySafetyEvaluations);
    const suppliedPreflight = pathInput.preflight ?? {};
    for (const key of ["workingCpuAvailable", "workingMemoryAvailable", "displayPathAvailable"] as const) {
      if (suppliedPreflight[key] !== undefined && suppliedPreflight[key] !== preflight[key]) {
        throw new TypeError(`firmware input ${target.instanceId} preflight differs from verified assembly supplies`);
      }
    }
    if ((pathInput.transitionTemporaryHardwareRequirements?.length ?? 0) > 0) {
      throw new TypeError(`firmware input ${target.instanceId} attempts to self-author transition hardware requirements`);
    }
    const requireRecovery = pathInput.capability.rollbackSupported || pathInput.capability.recoveryMethod !== "none";
    if (pathInput.requireRecovery !== undefined && pathInput.requireRecovery !== requireRecovery) {
      throw new TypeError(`firmware input ${target.instanceId} recovery policy differs from the locked capability`);
    }
    const requestedSettings = derivedFirmwareRequestedSettings(target, pathInput.capability);
    const suppliedSettings = pathInput.requestedSettings?.map(({ settingId, desiredValue }) => ({ settingId, desiredValue }))
      .sort((left, right) => compare(left.settingId, right.settingId));
    const targetSettings = [...target.requestedSettings].sort((left, right) => compare(left.settingId, right.settingId));
    if (suppliedSettings !== undefined && !sameJson(suppliedSettings, targetSettings)) {
      throw new TypeError(`firmware requested settings differ for ${target.instanceId}`);
    }
    const currentObservation = derivedFirmwareCurrentObservation(input, target.instanceId, pathInput.capability);
    if (pathInput.currentObservation !== undefined
      && !sameJson(pathInput.currentObservation, currentObservation)) {
      throw new TypeError(`firmware input ${target.instanceId} current observation differs from the locked unique projection`);
    }
    firmwareCapabilities.push(pathInput.capability);
    const baseInput: FirmwarePathEvaluationInput = {
      ...pathInput,
      ...(currentObservation === undefined ? {} : { currentObservation }),
      cpuSkuId: cpuBinding.skuId,
      targetReleaseFactId: target.targetReleaseFactId,
      availableRequirementIds: [],
      availableFactIds,
      preflight,
      transitionTemporaryHardwareRequirements: [],
      requestedSettings,
      requireRecovery,
    };
    firmwareInputs.push(baseInput);
    firmwareEvaluations.push(await evaluateFirmwarePath(baseInput));
  }
  const capabilityByHash = new Map(firmwareCapabilities.map((capability) => [capability.contentHash, capability]));
  let systemProfileEvaluation: SystemProfileEvaluation | null = null;
  if (config.system !== null) {
    const payload = input.artifacts.systemProfile.payload;
    if (validateWorkspaceSystemProfilePayloadRuntime(payload).length === 0) {
      const registry = new SystemProfileRegistry((payload as { registry: unknown }).registry);
      const profile = registry.resolve(config.system.profileId);
      const checks = [...(await resolver?.resolveSystemCheckAuthorities?.(input, firmwareEvaluations) ?? [])];
      const instanceIds = new Set(config.components.map(({ instanceId }) => instanceId));
      const factIds = new Set(input.factClosure.facts.map(({ factId }) => factId));
      for (const check of checks) {
        if (check.instanceIds.some((instanceId) => !instanceIds.has(instanceId))) throw new TypeError(`system check ${check.checkId} references an instance outside the locked config`);
        if (check.factIds.some((factId) => !factIds.has(factId))) throw new TypeError(`system check ${check.checkId} references a fact outside the locked closure`);
      }
      systemProfileEvaluation = evaluateSystemProfile({ config, profile, firmwareEvaluations, checks });
    }
  }
  return {
    assemblySafetyInputs: assemblyInputs.map((value) => structuredClone(value)),
    assemblySafetyEvaluations,
    firmwareInputs: firmwareInputs.sort((left, right) => compare(left.instanceId, right.instanceId)),
    firmwareEvaluations: firmwareEvaluations.sort((left, right) => compare(left.instanceId, right.instanceId)),
    firmwareCapabilities: [...capabilityByHash.values()].sort((left, right) => compare(
      firmwareCapabilityTupleKeyRuntime(left) ?? "",
      firmwareCapabilityTupleKeyRuntime(right) ?? "",
    )),
    systemProfileEvaluation,
    thermalAcousticEvaluation: evaluateProductionThermalAcoustic(input, features),
  };
}

async function lockedAdapterResources(
  input: GovernedEvaluationInput,
): Promise<{ requirements: RequirementNode[]; supplies: AllocatableRequirementSupply[]; closureRules: RequirementClosureRule[] }> {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable adapter V2 projection");
  const payload = input.artifacts.adapterSnapshot.payload as Partial<CaseAdapterArtifactPayload>;
  const manifests = Array.isArray(payload.caseManifests) ? payload.caseManifests : [];
  const requirements: RequirementNode[] = [];
  const supplies: AllocatableRequirementSupply[] = [];
  const closureRules: RequirementClosureRule[] = [];
  for (const owner of config.components.filter((component) => component.kind === "case" && component.identity.status === "resolved")) {
    const identity = owner.identity.status === "resolved" ? owner.identity : null;
    if (identity === null) continue;
    const candidates = manifests.filter((manifest) => manifest.identity.skuId === identity.skuId);
    if (candidates.length !== 1) continue;
    const manifest = candidates[0]!;
    supplies.push(...await projectPackageInstanceSupplies({
      ownerInstanceId: owner.instanceId,
      ownerSkuId: identity.skuId,
      manifestHash: manifest.contentHash,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      bundleItems: manifest.bundleItems,
    }));
    const placements = config.placements.filter((placement) => placement.mountOwnerInstanceId === owner.instanceId);
    for (const placement of placements) for (const pattern of manifest.resourcePatterns) {
      const trigger = compatibilityRequirement({
        ruleId: "compat.adapter-resource-closure",
        ruleVersion: "1.0.0",
        discriminator: `${owner.instanceId}-${placement.placementId}-${pattern.patternId}`,
        kind: "evidence",
        criticality: "normal",
        instanceIds: [owner.instanceId],
        evidenceRefs: [...pattern.evidenceFactIds, pattern.contentHash],
      });
      requirements.push(trigger);
      closureRules.push(await createAssemblyResourcePatternClosureRule({
        pattern,
        ownerInstanceId: owner.instanceId,
        targetInstanceIds: [placement.componentInstanceId],
        mountStandardId: placement.mountId,
        neededByStepId: placement.placementId,
        requirementIdPrefix: `requirement.pattern.${owner.instanceId}.${placement.placementId}.${pattern.patternId}`,
        region: manifest.identity.region,
        revision: manifest.identity.revision,
        triggerRequirementIds: [trigger.requirementId],
      }));
    }
  }
  const groupedRules = new Map<string, RequirementClosureRule[]>();
  for (const rule of closureRules) {
    const key = `${rule.ruleId}\0${rule.ruleVersion}`;
    groupedRules.set(key, [...(groupedRules.get(key) ?? []), rule]);
  }
  const coalescedRules = [...groupedRules.values()].map((members) => Object.freeze({
    ruleId: members[0]!.ruleId,
    ruleVersion: members[0]!.ruleVersion,
    expand(requirement: Readonly<RequirementNode>, snapshot: Parameters<RequirementClosureRule["expand"]>[1]) {
      return members.flatMap((rule) => rule.expand(requirement, snapshot));
    },
  })).sort((left, right) => compare(`${left.ruleId}\0${left.ruleVersion}`, `${right.ruleId}\0${right.ruleVersion}`));
  return {
    requirements: requirements.sort((left, right) => compare(left.requirementId, right.requirementId)),
    supplies: supplies.sort((left, right) => compare(`${left.ownerInstanceId ?? ""}:${left.refId}`, `${right.ownerInstanceId ?? ""}:${right.refId}`)),
    closureRules: coalescedRules,
  };
}

/**
 * Pure progressive compatibility evaluation over one repository-resolved,
 * replay-locked GovernedEvaluationInput. It never accepts raw snapshots,
 * caller hashes, catalog attrs, or self-authored authority booleans.
 */
export async function evaluateProgressiveCompatibility(
  input: GovernedEvaluationInput,
  options: ProgressiveCompatibilityOptions = {},
): Promise<ProgressiveBuildEvaluation> {
  const rules = [...BUILTIN_COMPATIBILITY_RULES].sort((left, right) => compare(ruleArtifactId(left), ruleArtifactId(right)));
  if (new Set(rules.map(ruleArtifactId)).size !== rules.length) throw new TypeError("compatibility rules must have unique locked identities");
  assertLockedInput(input, rules);
  const config = input.config;
  if (config.schemaVersion !== "3.0.0") throw new TypeError("unreachable V2 progressive evaluator");

  const nested = await resolveNestedEvaluations(input, options.authorityResolver, options);
  const adapterResources = await lockedAdapterResources(input);
  const evaluateRules = (firmwareEvaluations: readonly FirmwarePathEvaluation[]) => {
    const evaluated = rules.map((rule) => applies(rule, config.components)
      ? evaluateRule(input, rule, {
        firmwareEvaluations,
        assemblySafetyEvaluations: nested.assemblySafetyEvaluations,
        systemProfileEvaluation: nested.systemProfileEvaluation,
        thermalAcousticEvaluation: nested.thermalAcousticEvaluation,
      }) : notApplicableRule(rule));
    const adapterEvaluation = evaluated.find(({ record }) => record.ruleId === "compat.adapter-resource-closure");
    if (adapterResources.requirements.length > 0 && adapterEvaluation === undefined) {
      throw new TypeError("adapter resources projected without the locked adapter closure rule");
    }
    if (adapterEvaluation !== undefined) {
      adapterEvaluation.requirements.push(...adapterResources.requirements);
      adapterEvaluation.requirements.sort((left, right) => compare(left.requirementId, right.requirementId));
      adapterEvaluation.record.requirementIds = adapterEvaluation.requirements.map(({ requirementId }) => requirementId);
    }
    return evaluated;
  };
  const rootSet = (
    evaluated: ReturnType<typeof evaluateRules>,
    firmwareEvaluations: readonly FirmwarePathEvaluation[],
    additional: readonly RequirementNode[] = [],
  ): RequirementNode[] => {
    const byId = new Map<string, RequirementNode>();
    const nestedRequirements = [
      ...firmwareEvaluations.flatMap(({ derivedRequirements }) => derivedRequirements),
      ...nested.assemblySafetyEvaluations.flatMap(({ requirements }) => requirements),
      ...adapterResources.requirements,
      ...additional,
    ];
    for (const requirement of [...evaluated.flatMap(({ requirements: values }) => values), ...nestedRequirements]) {
      const previous = byId.get(requirement.requirementId);
      if (previous && !sameJson(previous, requirement)) throw new TypeError(`conflicting compatibility requirement ${requirement.requirementId}`);
      byId.set(requirement.requirementId, requirement);
    }
    return [...byId.values()].sort((left, right) => compare(left.requirementId, right.requirementId));
  };

  let evaluated = evaluateRules(nested.firmwareEvaluations);
  const staticRoots = rootSet(evaluated, []);
  const staticClosure = computeRequirementClosure({ roots: staticRoots, rules: adapterResources.closureRules });
  const verifiedAssemblySupplies = nested.assemblySafetyEvaluations.flatMap((evaluation) => [...projectVerifiedAssemblySupplies(evaluation)]);
  const supplies = [...adapterResources.supplies, ...verifiedAssemblySupplies];
  let requirementAllocation;
  let allocatedCandidateRoots: RequirementNode[] = [];
  if (nested.firmwareInputs.length > 0) {
    const fixedPoint = await evaluateFirmwareRequirementBatchFixedPoint({
      baseInputs: nested.firmwareInputs,
      rootRequirements: staticClosure.requirements,
      supplies,
      allocationOptions: { blockedRequirementIds: staticClosure.blockedRequirementIds },
    });
    nested.firmwareEvaluations = fixedPoint.evaluations;
    assertFirmwareExecutableFactAuthority(input, nested.firmwareEvaluations, nested.firmwareCapabilities);
    requirementAllocation = fixedPoint.requirementAllocation;
    const allocatedRequirementIds = new Set(requirementAllocation.requirements.map(({ requirementId }) => requirementId));
    allocatedCandidateRoots = fixedPoint.candidateRequirements
      .filter(({ requirementId }) => allocatedRequirementIds.has(requirementId));
    evaluated = evaluateRules(nested.firmwareEvaluations);
  }
  const ruleEvaluations = evaluated.map(({ record }) => record).sort((left, right) => compare(`${left.ruleId}@${left.ruleVersion}`, `${right.ruleId}@${right.ruleVersion}`));
  const decisions = evaluated.flatMap(({ decisions: values }) => values).sort((left, right) => compare(left.decisionId, right.decisionId));
  const roots = rootSet(evaluated, nested.firmwareEvaluations, allocatedCandidateRoots);
  const requirementClosure = computeRequirementClosure({ roots, rules: adapterResources.closureRules });
  const requirementReplayErrors = validateRequirementClosureReplayRuntime(requirementClosure, {
    roots,
    rules: adapterResources.closureRules,
  });
  if (requirementReplayErrors.length) {
    throw new TypeError(`requirement closure replay failed: ${requirementReplayErrors.join("; ")}`);
  }
  requirementAllocation ??= allocateRequirementSupplies(
    requirementClosure.requirements,
    supplies,
    { blockedRequirementIds: requirementClosure.blockedRequirementIds },
  );
  if (!sameJson(requirementAllocation.requirements, requirementClosure.requirements)
    || !sameJson(requirementAllocation.blockedRequirementIds, requirementClosure.blockedRequirementIds)) {
    throw new TypeError("firmware fixed-point allocation differs from the authoritative requirement closure");
  }
  const requirementReadiness = deriveRequirementReadiness(requirementAllocation);
  const domainEvaluations = buildDomainEvaluations(ruleEvaluations);
  const domain = (name: (typeof COMPATIBILITY_DOMAINS)[number]) => domainEvaluations.find((candidate) => candidate.domain === name)!.verdict;
  const compatibilityDomains: readonly (typeof COMPATIBILITY_DOMAINS)[number][] = ["mechanical", "electrical", "firmware", "storage", "assembly", "routing"];
  const systemDomains: readonly (typeof COMPATIBILITY_DOMAINS)[number][] = ["firmware", "system", "storage", "commissioning"];
  const compatibilityVerdict = aggregateVerdicts(compatibilityDomains.map(domain));
  const systemAvailabilityVerdict = aggregateVerdicts(systemDomains.map(domain));
  const topologyBom = projectTopologyBom(config);
  const projectedPrice = projectProgressivePriceRuntime(topologyBom, input.externalInputs.priceSnapshot);
  if (projectedPrice === null) throw new TypeError("locked governed price snapshot cannot be projected");
  const priceProjection = projectedPrice as ProgressivePriceProjection;
  const satisfactionByRequirementId = new Map(requirementAllocation.satisfactions
    .map((satisfaction) => [satisfaction.requirementId, satisfaction.status]));
  const profileGap = requirementClosure.requirements.some((requirement) => (
    ["component", "system_action", "user_decision"].includes(requirement.kind)
    && satisfactionByRequirementId.get(requirement.requirementId) !== "satisfied"
  ));
  const unresolved = topologyBom.filter((line) => line.identityStatus === "unresolved").length;
  const profileCompleteness = topologyBom.length === 0 ? "empty" : profileGap ? "partial" : "complete";
  const identityCompleteness = topologyBom.length === 0 ? "empty" : unresolved === 0 ? "complete" : "partial";
  const domainsPass = (names: readonly (typeof COMPATIBILITY_DOMAINS)[number][]) => names.every((name) => domain(name) === "pass");
  const assemblyReady = requirementReadiness.assemblyReady && profileCompleteness === "complete"
    && identityCompleteness === "complete" && domainsPass(["identity", "mechanical", "assembly"]);
  const powerReady = requirementReadiness.powerReady && profileCompleteness === "complete"
    && identityCompleteness === "complete" && domainsPass(["identity", "mechanical", "electrical", "assembly"]);
  const firstBootReady = requirementReadiness.firstBootReady && profileCompleteness === "complete"
    && identityCompleteness === "complete"
    && domainsPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage"]);
  const osInstallReady = requirementReadiness.osInstallReady && profileCompleteness === "complete"
    && identityCompleteness === "complete"
    && domainsPass(["identity", "mechanical", "electrical", "assembly", "firmware", "storage", "system", "commissioning"]);
  const result: ProgressiveBuildEvaluation = {
    schemaVersion: "progressive-build-evaluation-v1",
    kind: "topology-v3-progressive",
    configSchemaVersion: "3.0.0",
    authority: {
      schemaVersion: "progressive-evaluation-authority-v1",
      evaluationLockHash: input.evaluationLock.contentHash,
      artifactLockfileHash: input.artifactLockfile.lockfileHash,
      configHash: input.snapshotHashes.configHash,
      snapshotHashes: structuredClone(input.snapshotHashes),
      ruleSet: { ref: input.artifacts.ruleSet.ref.ref, contentHash: input.artifacts.ruleSet.ref.contentHash },
      engine: { ref: input.artifacts.engine.ref.ref, contentHash: input.artifacts.engine.ref.contentHash },
      adapterSnapshot: { ref: input.artifacts.adapterSnapshot.ref.ref, contentHash: input.artifacts.adapterSnapshot.ref.contentHash },
    },
    topologyBom,
    priceProjection,
    decisions,
    requirements: requirementClosure.requirements,
    requirementClosure,
    requirementAllocation,
    requirementReadiness,
    firmwareEvaluations: nested.firmwareEvaluations,
    firmwareCapabilities: nested.firmwareCapabilities,
    assemblySafetyEvaluations: nested.assemblySafetyEvaluations,
    thermalAcousticEvaluation: nested.thermalAcousticEvaluation,
    ruleEvaluations,
    domainEvaluations,
    coverage: {
      totalDomainCount: COMPATIBILITY_DOMAINS.length,
      registeredRuleCount: ruleEvaluations.length,
      evaluatedDomainCount: domainEvaluations.filter((candidate) => candidate.verdict === "pass" || candidate.verdict === "fail").length,
      applicableRuleCount: ruleEvaluations.filter((record) => record.applicability === "applicable").length,
      evaluatedRuleCount: ruleEvaluations.filter((record) => record.verdict === "pass" || record.verdict === "fail").length,
      blockedRuleCount: ruleEvaluations.filter((record) => record.verdict === "blocked").length,
      unknownRuleCount: ruleEvaluations.filter((record) => record.verdict === "unknown").length,
    },
    readiness: {
      profileCompleteness,
      identityCompleteness,
      compatibilityVerdict,
      systemAvailabilityVerdict,
      assemblyReady,
      powerReady,
      firstBootReady,
      osInstallReady,
    },
  };
  const errors = [
    ...validateProgressiveBuildEvaluation(result),
    ...validateProgressiveBuildEvaluationClosure(result, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: nested.firmwareCapabilities,
      firmwarePathInputs: nested.firmwareInputs,
      firmwareFixedPointRootRequirements: staticClosure.requirements,
      assemblySafetyInputs: nested.assemblySafetyInputs,
      requirementRoots: roots,
    }),
  ];
  if (errors.length) throw new TypeError(`progressive evaluator emitted invalid output: ${errors.join("; ")}`);
  return result;
}

export { BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS };
