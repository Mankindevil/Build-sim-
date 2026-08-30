import { canonicalJson } from "../plans/canonical";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import type { EvaluationDecision, RequirementNode } from "../requirements/contracts";
import type { SystemCheckAuthority, SystemCheckId, SystemProfileEvaluation, SystemProfileEvaluationInput } from "./contracts";
import { systemCheckRequirement } from "./requirements";

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function decision(
  input: SystemProfileEvaluationInput,
  checkId: SystemCheckId,
  verdict: EvaluationDecision["verdict"],
  message: string,
  instanceIds: readonly string[],
  factIds: readonly string[],
  remediation: readonly RequirementNode[],
): EvaluationDecision {
  return {
    decisionId: `decision.system.${input.profile.profileId}.${checkId}`,
    verdict,
    domain: "system",
    message,
    instanceIds: [...instanceIds].sort(compare),
    factIds: [...factIds].sort(compare),
    ruleId: `system-profile.${input.profile.profileId}.${checkId}`,
    ruleVersion: "1",
    assumptions: [],
    remediation: [...remediation],
  };
}

function firmwareDecision(input: SystemProfileEvaluationInput): { decision: EvaluationDecision; requirement?: RequirementNode } {
  const evidenceFactIds = (evaluations: typeof input.firmwareEvaluations) => [...new Set(evaluations.flatMap((evaluation) => [
    ...evaluation.selectedTransitions.flatMap(({ sourceFactIds }) => sourceFactIds),
  ]))].sort(compare);
  const boardIds = input.config.components.filter(({ kind }) => kind === "motherboard").map(({ instanceId }) => instanceId).sort(compare);
  if (input.firmwareEvaluations.length === 0) {
    const requirement = systemCheckRequirement(input.profile, "firmware_path");
    return { decision: decision(input, "firmware_path", "blocked", "Current firmware release and an executable support path are not proven.", boardIds, [], [requirement]), requirement };
  }
  const blocked = input.firmwareEvaluations.filter(({ verdict }) => verdict !== "pass");
  if (blocked.length > 0) {
    const requirement = systemCheckRequirement(input.profile, "firmware_path");
    return { decision: decision(input, "firmware_path", "blocked", "The selected system cannot be marked bootable until every firmware path is executable.", blocked.map(({ instanceId }) => instanceId), evidenceFactIds(blocked), [requirement]), requirement };
  }
  return { decision: decision(input, "firmware_path", "pass", "All selected firmware targets have executable paths or already satisfy the target.", input.firmwareEvaluations.map(({ instanceId }) => instanceId), evidenceFactIds(input.firmwareEvaluations), []) };
}

export function evaluateSystemProfile(input: SystemProfileEvaluationInput): SystemProfileEvaluation {
  if (input.config.system?.profileId !== input.profile.profileId || input.config.system.versionFactId !== input.profile.releaseFactId) {
    throw new TypeError("system profile evaluation selection/profile binding mismatch");
  }
  const checkById = new Map<string, SystemCheckAuthority>();
  for (const check of input.checks) {
    if (checkById.has(check.checkId)) throw new TypeError(`duplicate system check authority: ${check.checkId}`);
    checkById.set(check.checkId, check);
  }
  const decisions: EvaluationDecision[] = [];
  const requirements: RequirementNode[] = [];
  for (const checkId of input.profile.requiredChecks) {
    if (checkId === "firmware_path") {
      const result = firmwareDecision(input);
      decisions.push(result.decision);
      if (result.requirement) requirements.push(result.requirement);
      continue;
    }
    const authority = checkById.get(checkId);
    if (!authority || authority.status === "unknown") {
      const requirement = systemCheckRequirement(input.profile, checkId);
      requirements.push(requirement);
      decisions.push(decision(input, checkId, "blocked", authority?.message ?? `Required system check ${checkId} lacks governed authority.`, authority?.instanceIds ?? [], authority?.factIds ?? [], [requirement]));
    } else if (authority.status === "fail") {
      const requirement = systemCheckRequirement(input.profile, checkId);
      requirements.push(requirement);
      decisions.push(decision(input, checkId, "fail", authority.message, authority.instanceIds, authority.factIds, [requirement]));
    } else {
      decisions.push(decision(input, checkId, "pass", authority.message, authority.instanceIds, authority.factIds, []));
    }
  }
  decisions.sort((left, right) => compare(left.decisionId, right.decisionId));
  requirements.sort((left, right) => compare(left.requirementId, right.requirementId));
  const verdict: SystemProfileEvaluation["verdict"] = decisions.some(({ verdict }) => verdict === "fail") ? "fail"
    : decisions.some(({ verdict }) => verdict === "blocked") ? "blocked" : "pass";
  const base = {
    schemaVersion: "system-profile-evaluation-v1" as const,
    profileId: input.profile.profileId,
    releaseFactId: input.profile.releaseFactId,
    selectionSource: input.config.system.source,
    verdict,
    decisions,
    requirements,
    helpRefs: [input.profile.helpRef],
  };
  const contentHash = sha256Utf8Runtime(`buildsim:system-profile-evaluation:${canonicalJson(base)}`);
  if (contentHash === null) throw new TypeError("system profile evaluation cannot be hashed");
  return { ...base, contentHash };
}
