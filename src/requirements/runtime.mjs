import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import {
  governedFacetSatisfiesRuntime,
  validateGovernedFacetPredicateRuntime,
  validateGovernedFacetValueRuntime,
} from "../contracts/governed-facet-runtime.mjs";
import { validateCaseAdapterManifestRuntime } from "../adapters/case-manifest-runtime.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const KINDS = new Set(["component", "accessory", "fastener", "cable", "consumable", "tool", "evidence", "measurement", "firmware_action", "system_action", "user_decision"]);
const CRITICALITIES = new Set(["normal", "boot", "safety"]);
const STAGES = new Set(["assembly", "pre_power", "first_boot", "os_install"]);
const SOURCES = new Set(["component", "package_content", "user_resource", "purchase"]);
const AVAILABILITY = new Set(["planned", "ordered", "present_verified"]);
const OBSERVATION_REF = /^observation:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function id(value) {
  return text(value) && !/\s/u.test(value);
}

function strings(value, allowEmpty = true) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(text)
    && new Set(value).size === value.length;
}

function canonicallyOrdered(value, key) {
  if (!Array.isArray(value)) return false;
  const keys = value.map(key);
  return keys.every((candidate, index) => index === 0 || keys[index - 1] < candidate);
}

function sortedStrings(value, allowEmpty = true) {
  return strings(value, allowEmpty) && canonicallyOrdered(value, (candidate) => candidate);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_536;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 65_536;
}

function canonical(value, root = true, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite requirement artifact number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) throw new TypeError("non-canonical requirement artifact value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse requirement artifact array");
      return `[${value.map((entry) => canonical(entry, false, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("requirement artifact object must be plain");
    return `{${Object.entries(value)
      .filter(([key, child]) => child !== undefined && !(root && key === "contentHash"))
      .map(([key, child]) => [key.normalize("NFC"), child])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, false, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

export function requirementArtifactContentHashRuntime(value, schemaVersion) {
  try {
    if (!record(value) || !text(schemaVersion)) return null;
    const preimage = `buildsim\0hash-spec-v1\0requirement-evaluation\0${schemaVersion}\0${canonical(value)}`;
    return sha256Utf8Runtime(preimage);
  } catch { return null; }
}

export function validateRequirementNodeRuntime(value) {
  try {
    const required = ["requirementId", "kind", "predicates", "quantity", "criticality", "producedBy", "evidenceRefs"];
    if (!exact(value, required, ["requiredBefore"])) return ["derived requirement shape invalid"];
    const errors = [];
    if (!id(value.requirementId)) errors.push("requirementId invalid");
    if (!KINDS.has(value.kind)) errors.push("requirement kind invalid");
    if (!positiveInteger(value.quantity)) errors.push("requirement quantity must be a positive safe integer");
    if (!CRITICALITIES.has(value.criticality)) errors.push("requirement criticality invalid");
    if (value.requiredBefore !== undefined && !STAGES.has(value.requiredBefore)) errors.push("requiredBefore invalid");
    if (!Array.isArray(value.predicates)) errors.push("requirement predicates must be an array");
    else {
      value.predicates.forEach((predicate, index) => errors.push(...validateGovernedFacetPredicateRuntime(predicate).map((error) => `predicates.${index}: ${error}`)));
      const keys = value.predicates.map((predicate) => { try { return canonical(predicate, false); } catch { return "invalid"; } });
      if (new Set(keys).size !== keys.length) errors.push("requirement predicates must not repeat");
      if (!canonicallyOrdered(value.predicates, (predicate) => `${predicate.facetId}\0${predicate.operator}\0${JSON.stringify(predicate.value)}\0${predicate.unitId ?? ""}`)) {
        errors.push("requirement predicates order invalid");
      }
    }
    if (!exact(value.producedBy, ["ruleId", "ruleVersion", "instanceIds"]) || !id(value.producedBy?.ruleId)
      || !id(value.producedBy?.ruleVersion) || !sortedStrings(value.producedBy?.instanceIds)) errors.push("requirement producedBy invalid");
    if (!sortedStrings(value.evidenceRefs)) errors.push("requirement evidenceRefs invalid");
    return errors;
  } catch { return ["derived requirement is inaccessible or invalid"]; }
}

const DEFAULT_MAX_ITERATIONS = 64;
const DEFAULT_MAX_REQUIREMENTS = 4_096;

function deepFreezeRuntime(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeRuntime(child);
  return value;
}

function requirementCanonicalJsonRuntime(requirement) {
  const normalized = {
    ...structuredClone(requirement),
    predicates: [...requirement.predicates].sort((left, right) => {
      const a = `${left.facetId}\0${left.operator}\0${JSON.stringify(left.value)}\0${left.unitId ?? ""}`;
      const b = `${right.facetId}\0${right.operator}\0${JSON.stringify(right.value)}\0${right.unitId ?? ""}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    producedBy: {
      ...requirement.producedBy,
      instanceIds: [...requirement.producedBy.instanceIds].sort(),
    },
    evidenceRefs: [...requirement.evidenceRefs].sort(),
  };
  return canonical(normalized, false);
}

function normalizeRequirementRuntime(requirement) {
  return JSON.parse(requirementCanonicalJsonRuntime(requirement));
}

function closureRuleKeyRuntime(value) { return `${value.ruleId}\0${value.ruleVersion}`; }
function closureEdgeKeyRuntime(value) { return `${value.fromRequirementId}\0${value.toRequirementId}\0${value.ruleId}\0${value.ruleVersion}`; }
function closureLimitRuntime(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 65_536) {
    throw new TypeError(`${label} must be a positive safe integer no greater than 65536`);
  }
  return resolved;
}

function normalizeClosureDerivationRuntime(value, defaultParentId) {
  if (record(value) && Object.prototype.hasOwnProperty.call(value, "requirement")) {
    if (!exact(value, ["requirement"], ["parentRequirementIds"])) {
      throw new TypeError("requirement derivation contains unknown fields");
    }
    return {
      requirement: value.requirement,
      parentRequirementIds: value.parentRequirementIds === undefined ? [defaultParentId] : [...value.parentRequirementIds],
    };
  }
  return { requirement: value, parentRequirementIds: [defaultParentId] };
}

/**
 * JS-safe fixed-point authority. TypeScript and offline replay both use this
 * implementation so iteration/cycle semantics cannot drift between mirrors.
 */
export function computeRequirementClosureRuntime(input) {
  if (!record(input) || !exact(input, ["roots", "rules"], ["maxIterations", "maxRequirements"])
    || !Array.isArray(input.roots) || !Array.isArray(input.rules)) {
    throw new TypeError("requirement closure input contains unknown or missing fields");
  }
  const maxIterations = closureLimitRuntime(input.maxIterations, DEFAULT_MAX_ITERATIONS, "maxIterations");
  const maxRequirements = closureLimitRuntime(input.maxRequirements, DEFAULT_MAX_REQUIREMENTS, "maxRequirements");
  if (input.roots.length > maxRequirements) throw new RangeError("root requirements exceed maxRequirements");
  const rules = [...input.rules].sort((left, right) => {
    const a = closureRuleKeyRuntime(left); const b = closureRuleKeyRuntime(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const ruleKeys = rules.map(closureRuleKeyRuntime);
  if (new Set(ruleKeys).size !== ruleKeys.length) throw new TypeError("requirement closure rules must have unique ruleId + ruleVersion");
  for (const rule of rules) {
    if (!record(rule) || !exact(rule, ["ruleId", "ruleVersion", "expand"])
      || !id(rule.ruleId) || !id(rule.ruleVersion) || typeof rule.expand !== "function") {
      throw new TypeError("requirement closure rule invalid");
    }
  }

  const byId = new Map(); const canonicalById = new Map(); const roots = [];
  const addRequirement = (candidate) => {
    const normalized = normalizeRequirementRuntime(candidate);
    const nodeErrors = validateRequirementNodeRuntime(normalized);
    if (nodeErrors.length) throw new TypeError(`Invalid derived requirement: ${nodeErrors.join("; ")}`);
    const normalizedJson = requirementCanonicalJsonRuntime(normalized);
    const existing = canonicalById.get(normalized.requirementId);
    if (existing !== undefined) {
      if (existing !== normalizedJson) throw new Error(`conflicting requirement derivations for ${normalized.requirementId}`);
      return false;
    }
    if (byId.size >= maxRequirements) return false;
    byId.set(normalized.requirementId, normalized); canonicalById.set(normalized.requirementId, normalizedJson);
    return true;
  };
  for (const root of input.roots) {
    addRequirement(root);
    if (!roots.includes(root.requirementId)) roots.push(root.requirementId);
  }
  roots.sort();

  const edges = new Map(); let iterations = 0; let reachedFixedPoint = rules.length === 0; let limitReached = false;
  while (!reachedFixedPoint && iterations < maxIterations) {
    iterations += 1; let changed = false;
    const snapshot = Object.freeze({
      iteration: iterations,
      requirements: Object.freeze([...byId.values()].sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0)
        .map((candidate) => deepFreezeRuntime(structuredClone(candidate)))),
      edges: Object.freeze([...edges.values()].sort((left, right) => {
        const a = closureEdgeKeyRuntime(left); const b = closureEdgeKeyRuntime(right); return a < b ? -1 : a > b ? 1 : 0;
      }).map((candidate) => deepFreezeRuntime(structuredClone(candidate)))),
    });
    for (const requirement of snapshot.requirements) {
      for (const rule of rules) {
        const emitted = rule.expand(deepFreezeRuntime(structuredClone(requirement)), snapshot);
        if (!Array.isArray(emitted)) throw new TypeError(`${rule.ruleId}@${rule.ruleVersion} expand() must return an array`);
        for (const raw of emitted) {
          const derivation = normalizeClosureDerivationRuntime(raw, requirement.requirementId);
          if (!Array.isArray(derivation.parentRequirementIds) || derivation.parentRequirementIds.length === 0
            || !derivation.parentRequirementIds.every(id) || new Set(derivation.parentRequirementIds).size !== derivation.parentRequirementIds.length) {
            throw new TypeError(`${rule.ruleId}@${rule.ruleVersion} derivation parentRequirementIds invalid`);
          }
          const before = byId.size; const added = addRequirement(derivation.requirement);
          if (!added && byId.size === before && !byId.has(derivation.requirement?.requirementId)) { limitReached = true; break; }
          if (added) changed = true;
          for (const parentRequirementId of [...derivation.parentRequirementIds].sort()) {
            if (!byId.has(parentRequirementId)) throw new Error(`${rule.ruleId}@${rule.ruleVersion} references unknown parent requirement ${parentRequirementId}`);
            const candidate = { fromRequirementId: parentRequirementId, toRequirementId: derivation.requirement.requirementId, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion };
            const key = closureEdgeKeyRuntime(candidate);
            if (!edges.has(key)) { edges.set(key, candidate); changed = true; }
          }
        }
        if (limitReached) break;
      }
      if (limitReached) break;
    }
    if (limitReached) break;
    reachedFixedPoint = !changed;
  }
  const requirements = [...byId.values()].sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  const orderedEdges = [...edges.values()].sort((left, right) => {
    const a = closureEdgeKeyRuntime(left); const b = closureEdgeKeyRuntime(right); return a < b ? -1 : a > b ? 1 : 0;
  });
  const cyclicComponents = cyclicComponentsRuntime(requirements.map(({ requirementId }) => requirementId), orderedEdges);
  const cycles = cyclicComponents.map((members) => canonicalCyclePathRuntime(members, orderedEdges));
  if (cycles.some((cycle) => cycle === null)) throw new Error("cyclic requirement component has no concrete cycle path");
  const blockedRequirementIds = limitReached || !reachedFixedPoint
    ? requirements.map(({ requirementId }) => requirementId)
    : [...new Set(cyclicComponents.flat())].sort();
  const material = {
    schemaVersion: "requirement-closure-v1",
    rootRequirementIds: roots,
    requirements,
    edges: orderedEdges,
    cycles,
    iterations,
    reachedFixedPoint: reachedFixedPoint && !limitReached,
    blockedRequirementIds,
    ruleRefs: rules.map(({ ruleId, ruleVersion }) => ({ ruleId, ruleVersion })),
  };
  const contentHash = requirementArtifactContentHashRuntime(material, material.schemaVersion);
  if (contentHash === null) throw new TypeError("requirement closure content hash could not be computed");
  const result = { ...material, contentHash };
  const resultErrors = validateRequirementClosureRuntime(result);
  if (resultErrors.length) throw new TypeError(`Invalid requirement closure result: ${resultErrors.join("; ")}`);
  return result;
}

/** Re-execute locked rules and compare every persisted byte-relevant field. */
export function validateRequirementClosureReplayRuntime(value, input) {
  try {
    const errors = validateRequirementClosureRuntime(value);
    if (!record(input) || !exact(input, ["roots", "rules"], ["maxIterations", "maxRequirements"])
      || !Array.isArray(input.roots) || !Array.isArray(input.rules)) {
      return [...errors, "requirement closure replay input invalid"];
    }
    const rootIds = input.roots.map((root) => root?.requirementId);
    input.roots.forEach((root, index) => errors.push(...validateRequirementNodeRuntime(root)
      .map((error) => `replay roots.${index}: ${error}`)));
    if (new Set(rootIds).size !== rootIds.length
      || !canonicallyOrdered(input.roots, (root) => root?.requirementId ?? "")) {
      errors.push("requirement closure replay roots must be unique and canonically ordered");
    }
    const ruleKeys = input.rules.map((rule) => record(rule) ? closureRuleKeyRuntime(rule) : "");
    if (new Set(ruleKeys).size !== ruleKeys.length
      || !canonicallyOrdered(input.rules, (rule) => record(rule) ? closureRuleKeyRuntime(rule) : "")) {
      errors.push("requirement closure replay rules must be unique and canonically ordered");
    }
    if (errors.length) return [...new Set(errors)];
    const replay = computeRequirementClosureRuntime(input);
    if (canonical(value, false) !== canonical(replay, false)) errors.push("requirement closure differs from locked fixed-point replay");
    return [...new Set(errors)];
  } catch { return ["requirement closure fixed-point replay failed closed"]; }
}

function validateAllocation(value) {
  const required = ["source", "refId", "quantity", "availability", "verificationStatus", "evidenceRefs", "observationRefs"];
  if (!exact(value, required, ["ownerInstanceId", "satisfiesBefore"])) return ["requirement allocation shape invalid"];
  const errors = [];
  if (!SOURCES.has(value.source) || !id(value.refId) || (value.ownerInstanceId !== undefined && !id(value.ownerInstanceId))) errors.push("requirement allocation identity invalid");
  if ((value.source === "package_content" || value.source === "user_resource") && !id(value.ownerInstanceId)) errors.push("package/user allocation requires ownerInstanceId");
  if (!positiveInteger(value.quantity)) errors.push("allocation quantity must be a positive safe integer");
  if (!AVAILABILITY.has(value.availability) || !["unverified", "verified"].includes(value.verificationStatus)) errors.push("requirement allocation availability invalid");
  if (value.availability === "present_verified" && value.verificationStatus !== "verified") errors.push("present_verified allocation must be verified");
  if (value.satisfiesBefore !== undefined && !STAGES.has(value.satisfiesBefore)) errors.push("allocation satisfiesBefore invalid");
  if (!sortedStrings(value.evidenceRefs) || !sortedStrings(value.observationRefs)
    || value.observationRefs.some((ref) => !OBSERVATION_REF.test(ref))) errors.push("requirement allocation references invalid");
  if (value.availability === "present_verified" && Array.isArray(value.observationRefs) && value.observationRefs.length === 0) errors.push("present_verified allocation requires an observation reference");
  return errors;
}

function checkpointCovers(requirementId, checkpointRefs) {
  return checkpointRefs.some((checkpoint) => checkpointRef(checkpoint) && checkpoint.requirementId === requirementId);
}

export function validateRequirementSatisfactionRuntime(requirement, satisfaction, checkpointRefs = []) {
  try {
    if (validateRequirementNodeRuntime(requirement).length) return ["requirement is invalid"];
    if (!exact(satisfaction, ["requirementId", "status", "allocations", "residualQuantity"])) return ["requirement satisfaction shape invalid"];
    const errors = [];
    if (satisfaction.requirementId !== requirement.requirementId) errors.push("requirementId does not match requirement");
    if (!["open", "satisfied", "blocked"].includes(satisfaction.status)) errors.push("requirement satisfaction status invalid");
    if (!nonNegativeInteger(satisfaction.residualQuantity)) errors.push("residualQuantity must be a non-negative safe integer");
    if (!Array.isArray(satisfaction.allocations)) errors.push("requirement allocations must be an array");
    let allocated = 0;
    if (Array.isArray(satisfaction.allocations)) for (const [index, allocation] of satisfaction.allocations.entries()) {
      const allocationErrors = validateAllocation(allocation);
      errors.push(...allocationErrors.map((error) => `allocations.${index}: ${error}`));
      if (allocationErrors.length === 0) {
        allocated += allocation.quantity;
        const gated = requirement.criticality === "boot" || requirement.criticality === "safety"
          || requirement.requiredBefore !== undefined;
        if (gated && !checkpointCovers(requirement.requirementId, checkpointRefs)
          && (allocation.availability !== "present_verified" || allocation.verificationStatus !== "verified")) {
          errors.push(`allocations.${index}: boot/safety allocation must be present_verified or covered by a safety checkpoint`);
        }
      }
    }
    if (requirement.quantity !== allocated + satisfaction.residualQuantity) errors.push("allocation quantity is not conserved");
    if (satisfaction.status === "satisfied" && satisfaction.residualQuantity !== 0) errors.push("satisfied requirement must have zero residualQuantity");
    if ((satisfaction.status === "open" || satisfaction.status === "blocked") && satisfaction.residualQuantity === 0) errors.push(`${satisfaction.status} requirement must retain residual quantity`);
    return errors;
  } catch { return ["requirement satisfaction is inaccessible or invalid"]; }
}

function edge(value) {
  return exact(value, ["fromRequirementId", "toRequirementId", "ruleId", "ruleVersion"])
    && [value.fromRequirementId, value.toRequirementId, value.ruleId, value.ruleVersion].every(id);
}

function ruleRef(value) {
  return exact(value, ["ruleId", "ruleVersion"]) && id(value.ruleId) && id(value.ruleVersion);
}

function cycleIsClosed(cycle, edgeSet) {
  if (!Array.isArray(cycle) || cycle.length === 0 || !cycle.every(id) || new Set(cycle).size !== cycle.length) return false;
  return cycle.every((current, index) => edgeSet.has(`${current}\0${cycle[(index + 1) % cycle.length]}`));
}

function cyclicComponentsRuntime(requirementIds, edges) {
  const adjacency = new Map(requirementIds.map((requirementId) => [requirementId, []]));
  for (const candidate of edges) {
    if (!edge(candidate) || !adjacency.has(candidate.fromRequirementId) || !adjacency.has(candidate.toRequirementId)) continue;
    const list = adjacency.get(candidate.fromRequirementId);
    if (!list.includes(candidate.toRequirementId)) list.push(candidate.toRequirementId);
  }
  for (const list of adjacency.values()) list.sort();
  let cursor = 0;
  const indices = new Map(); const low = new Map(); const stack = []; const onStack = new Set(); const result = [];
  const visit = (requirementId) => {
    indices.set(requirementId, cursor); low.set(requirementId, cursor); cursor += 1; stack.push(requirementId); onStack.add(requirementId);
    for (const next of adjacency.get(requirementId) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(requirementId, Math.min(low.get(requirementId), low.get(next))); }
      else if (onStack.has(next)) low.set(requirementId, Math.min(low.get(requirementId), indices.get(next)));
    }
    if (low.get(requirementId) !== indices.get(requirementId)) return;
    const members = [];
    while (stack.length > 0) {
      const member = stack.pop(); onStack.delete(member); members.push(member);
      if (member === requirementId) break;
    }
    members.sort();
    if (members.length > 1 || (adjacency.get(members[0]) ?? []).includes(members[0])) result.push(members);
  };
  [...requirementIds].sort().forEach((requirementId) => { if (!indices.has(requirementId)) visit(requirementId); });
  return result.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

/** Mirror closure.ts exactly so a checksum-correct alternate path is rejected. */
function canonicalCyclePathRuntime(members, edges) {
  const allowed = new Set(members);
  const adjacency = new Map(members.map((requirementId) => [requirementId, []]));
  for (const candidate of edges) {
    if (!edge(candidate) || !allowed.has(candidate.fromRequirementId) || !allowed.has(candidate.toRequirementId)) continue;
    const list = adjacency.get(candidate.fromRequirementId);
    if (!list.includes(candidate.toRequirementId)) list.push(candidate.toRequirementId);
  }
  for (const list of adjacency.values()) list.sort();
  const anchor = [...members].sort()[0];
  if ((adjacency.get(anchor) ?? []).includes(anchor)) return [anchor];
  const path = [anchor];
  const visiting = new Set(path);
  const search = (current) => {
    for (const next of adjacency.get(current) ?? []) {
      if (next === anchor) return path.length > 1;
      if (visiting.has(next)) continue;
      visiting.add(next); path.push(next);
      if (search(next)) return true;
      path.pop(); visiting.delete(next);
    }
    return false;
  };
  if (!search(anchor)) return null;
  return path;
}

export function validateRequirementClosureRuntime(value) {
  try {
    const fields = ["schemaVersion", "rootRequirementIds", "requirements", "edges", "cycles", "iterations", "reachedFixedPoint", "blockedRequirementIds", "ruleRefs", "contentHash"];
    if (!exact(value, fields) || value.schemaVersion !== "requirement-closure-v1") return ["requirement closure shape/schema invalid"];
    const errors = [];
    if (!HASH.test(String(value.contentHash ?? ""))) errors.push("requirement closure contentHash invalid");
    if (!strings(value.rootRequirementIds) || !strings(value.blockedRequirementIds) || !Array.isArray(value.requirements)
      || !Array.isArray(value.edges) || !Array.isArray(value.cycles) || !Array.isArray(value.ruleRefs)) errors.push("requirement closure collections invalid");
    if (!Number.isSafeInteger(value.iterations) || value.iterations < 0 || typeof value.reachedFixedPoint !== "boolean") errors.push("requirement closure progress invalid");
    const requirements = Array.isArray(value.requirements) ? value.requirements : [];
    requirements.forEach((requirement, index) => errors.push(...validateRequirementNodeRuntime(requirement).map((error) => `requirements.${index}: ${error}`)));
    const requirementIds = requirements.map((requirement) => requirement?.requirementId);
    const requirementSet = new Set(requirementIds);
    if (requirementSet.size !== requirementIds.length) errors.push("requirement closure IDs must be unique");
    if (!canonicallyOrdered(requirements, (requirement) => requirement?.requirementId ?? "")) errors.push("requirement closure requirements order invalid");
    if (!sortedStrings(value.rootRequirementIds)) errors.push("requirement closure root order invalid");
    if (Array.isArray(value.rootRequirementIds) && value.rootRequirementIds.some((requirementId) => !requirementSet.has(requirementId))) errors.push("requirement closure root reference missing");
    const edges = Array.isArray(value.edges) ? value.edges : [];
    const edgeKeys = [];
    for (const [index, candidate] of edges.entries()) {
      if (!edge(candidate)) errors.push(`edges.${index}: requirement closure edge invalid`);
      else {
        edgeKeys.push(`${candidate.fromRequirementId}\0${candidate.toRequirementId}\0${candidate.ruleId}\0${candidate.ruleVersion}`);
        if (!requirementSet.has(candidate.fromRequirementId) || !requirementSet.has(candidate.toRequirementId)) errors.push(`edges.${index}: requirement closure endpoint missing`);
      }
    }
    if (new Set(edgeKeys).size !== edgeKeys.length) errors.push("requirement closure edges must be unique");
    if (!canonicallyOrdered(edges, (candidate) => edge(candidate)
      ? `${candidate.fromRequirementId}\0${candidate.toRequirementId}\0${candidate.ruleId}\0${candidate.ruleVersion}` : "")) {
      errors.push("requirement closure edge order invalid");
    }
    const edgeSet = new Set(edges.filter(edge).map((candidate) => `${candidate.fromRequirementId}\0${candidate.toRequirementId}`));
    if (Array.isArray(value.cycles) && value.cycles.some((cycle) => !cycleIsClosed(cycle, edgeSet))) errors.push("requirement closure cycle is not a closed dependency path");
    const cyclicComponents = cyclicComponentsRuntime([...requirementSet], edges);
    if (Array.isArray(value.cycles)) {
      const expectedCycles = cyclicComponents.map((component) => canonicalCyclePathRuntime(component, edges));
      if (expectedCycles.some((cycle) => cycle === null)
        || canonical(value.cycles, false) !== canonical(expectedCycles, false)) {
        errors.push("requirement closure cycles do not match canonical dependency paths");
      }
    }
    if (Array.isArray(value.ruleRefs)) {
      if (value.ruleRefs.some((candidate) => !ruleRef(candidate))) errors.push("requirement closure ruleRefs invalid");
      const keys = value.ruleRefs.map((candidate) => `${candidate?.ruleId}\0${candidate?.ruleVersion}`);
      if (new Set(keys).size !== keys.length) errors.push("requirement closure ruleRefs must be unique");
      if (!canonicallyOrdered(value.ruleRefs, (candidate) => `${candidate?.ruleId}\0${candidate?.ruleVersion}`)) errors.push("requirement closure ruleRefs order invalid");
      const refs = new Set(keys);
      if (edges.some((candidate) => edge(candidate) && !refs.has(`${candidate.ruleId}\0${candidate.ruleVersion}`))) errors.push("requirement closure edge rule reference missing");
    }
    if (Array.isArray(value.blockedRequirementIds) && value.blockedRequirementIds.some((requirementId) => !requirementSet.has(requirementId))) errors.push("requirement closure blocked reference missing");
    if (!sortedStrings(value.blockedRequirementIds)) errors.push("requirement closure blocked order invalid");
    if (Array.isArray(value.blockedRequirementIds)) {
      const expectedBlocked = (value.reachedFixedPoint
        ? [...new Set(cyclicComponents.flat())]
        : [...requirementSet]).sort();
      const actualBlocked = [...value.blockedRequirementIds].sort();
      if (canonical(actualBlocked, false) !== canonical(expectedBlocked, false)) errors.push("requirement closure blocked IDs are inconsistent with fixed-point/cycles");
    }
    const expected = requirementArtifactContentHashRuntime(value, value.schemaVersion);
    if (expected === null || value.contentHash !== expected) errors.push("requirement closure content hash mismatch");
    return errors;
  } catch { return ["requirement closure is inaccessible or invalid"]; }
}

function validateSupply(value) {
  const required = ["source", "refId", "kind", "facets", "quantity", "availability", "verificationStatus", "evidenceRefs", "observationRefs"];
  if (!exact(value, required, ["ownerInstanceId", "packageAuthorityRef", "satisfiesBefore"])) return ["requirement supply shape invalid"];
  const errors = [];
  if (!SOURCES.has(value.source) || !id(value.refId) || (value.ownerInstanceId !== undefined && !id(value.ownerInstanceId))) errors.push("requirement supply identity invalid");
  if ((value.source === "package_content" || value.source === "user_resource") && !id(value.ownerInstanceId)) errors.push("package/user supply requires ownerInstanceId");
  const packageAuthority = value.packageAuthorityRef;
  if (value.source === "package_content") {
    if (!exact(packageAuthority, ["manifestHash", "instanceSupplyId", "instanceSupplyHash", "bundleItemHash", "ownerSkuId"])
      || !HASH.test(String(packageAuthority.manifestHash ?? ""))
      || !id(packageAuthority.instanceSupplyId) || !HASH.test(String(packageAuthority.instanceSupplyHash ?? ""))
      || !HASH.test(String(packageAuthority.bundleItemHash ?? "")) || !id(packageAuthority.ownerSkuId)) {
      errors.push("package supply authority reference invalid");
    }
  } else if (packageAuthority !== undefined) errors.push("non-package supply cannot carry package authority");
  if (!KINDS.has(value.kind)) errors.push("requirement supply kind invalid");
  if (!Array.isArray(value.facets)) errors.push("requirement supply facets invalid");
  else {
    value.facets.forEach((facet, index) => errors.push(...validateGovernedFacetValueRuntime(facet).map((error) => `facets.${index}: ${error}`)));
    const facetIds = value.facets.map((facet) => facet?.facetId);
    if (new Set(facetIds).size !== facetIds.length) errors.push("requirement supply facet IDs must be unique");
    if (!canonicallyOrdered(value.facets, (facet) => facet?.facetId ?? "")) errors.push("requirement supply facet order invalid");
  }
  if (!positiveInteger(value.quantity)) errors.push("requirement supply quantity invalid");
  if (!AVAILABILITY.has(value.availability) || !["unverified", "verified"].includes(value.verificationStatus)) errors.push("requirement supply availability invalid");
  if (value.availability === "present_verified" && value.verificationStatus !== "verified") errors.push("present_verified supply must be verified");
  if (value.satisfiesBefore !== undefined && !STAGES.has(value.satisfiesBefore)) errors.push("requirement supply satisfiesBefore invalid");
  if (!sortedStrings(value.evidenceRefs) || !sortedStrings(value.observationRefs)
    || value.observationRefs.some((ref) => !OBSERVATION_REF.test(ref))) errors.push("requirement supply references invalid");
  if (value.availability === "present_verified" && Array.isArray(value.observationRefs) && value.observationRefs.length === 0) errors.push("present_verified supply requires an observation reference");
  return errors;
}

function supplyKey(value) {
  return `${value.source}\0${value.ownerInstanceId ?? ""}\0${value.refId}`;
}

function checkpointRef(value) {
  return exact(value, ["checkpointId", "requirementId", "planVersionId", "procedureId", "dependencyHash", "procedureSafetyHash", "confirmedAt", "actor"])
    && id(value.requirementId) && id(value.checkpointId) && id(value.planVersionId) && id(value.procedureId)
    && HASH.test(value.dependencyHash) && HASH.test(value.procedureSafetyHash)
    && typeof value.confirmedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value.confirmedAt)
    && Number.isFinite(Date.parse(value.confirmedAt)) && value.actor === "user";
}

function remainingSupply(value) {
  return exact(value, ["source", "refId", "quantity"], ["ownerInstanceId"])
    && SOURCES.has(value.source) && id(value.refId) && (value.ownerInstanceId === undefined || id(value.ownerInstanceId))
    && ((value.source !== "package_content" && value.source !== "user_resource") || id(value.ownerInstanceId))
    && nonNegativeInteger(value.quantity);
}

const ALLOCATION_STAGE_ORDER = Object.freeze({ assembly: 0, pre_power: 1, first_boot: 2, os_install: 3 });

function normalizeAllocationSupplyRuntime(supply) {
  return {
    source: supply.source,
    refId: supply.refId.normalize("NFC"),
    ...(supply.ownerInstanceId === undefined ? {} : { ownerInstanceId: supply.ownerInstanceId.normalize("NFC") }),
    ...(supply.packageAuthorityRef === undefined ? {} : { packageAuthorityRef: structuredClone(supply.packageAuthorityRef) }),
    kind: supply.kind,
    facets: structuredClone(supply.facets).map((facet) => ({
      ...facet,
      ...(Array.isArray(facet.value) ? { value: [...facet.value].sort() } : {}),
    })).sort((left, right) => left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0),
    quantity: supply.quantity,
    availability: supply.availability,
    verificationStatus: supply.verificationStatus,
    ...(supply.satisfiesBefore === undefined ? {} : { satisfiesBefore: supply.satisfiesBefore }),
    evidenceRefs: [...new Set(supply.evidenceRefs)].sort(),
    observationRefs: [...new Set(supply.observationRefs)].sort(),
  };
}

function checkpointValidForRuntime(checkpoint, requirement, context) {
  return checkpointRef(checkpoint) && record(context)
    && exact(context, ["planVersionId", "procedureId", "expectedDependencyHash", "expectedProcedureSafetyHash"])
    && checkpoint.requirementId === requirement.requirementId
    && checkpoint.planVersionId === context.planVersionId
    && checkpoint.procedureId === context.procedureId
    && checkpoint.dependencyHash === context.expectedDependencyHash
    && checkpoint.procedureSafetyHash === context.expectedProcedureSafetyHash;
}

function validAllocationCheckpointsRuntime(requirements, options) {
  const byId = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
  const mapValues = options.checkpointByRequirement instanceof Map ? [...options.checkpointByRequirement.values()] : [];
  const candidates = [...(options.safetyCheckpoints ?? []), ...mapValues];
  const valid = new Map(); const provenance = new Map();
  for (const candidate of candidates) {
    if (!record(candidate) || !exact(candidate, ["checkpoint", "context"])) continue;
    const requirement = byId.get(candidate.checkpoint?.requirementId);
    if (!requirement || !checkpointValidForRuntime(candidate.checkpoint, requirement, candidate.context)) continue;
    const key = candidate.checkpoint.checkpointId;
    const hash = requirementArtifactContentHashRuntime(candidate, "safety-checkpoint-authority-v1");
    if (hash === null) throw new TypeError("safety checkpoint provenance cannot be hashed");
    if (provenance.has(key) && provenance.get(key) !== hash) throw new TypeError(`conflicting safety checkpoint authority: ${key}`);
    provenance.set(key, hash); valid.set(key, structuredClone(candidate.checkpoint));
  }
  return [...valid.values()].sort((left, right) => {
    const a = `${left.requirementId}\0${left.checkpointId}`; const b = `${right.requirementId}\0${right.checkpointId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function allocationSupplyMatchesRuntime(supply, requirement, checkpointRequirementIds) {
  if (supply.kind !== requirement.kind) return false;
  if ((supply.source === "package_content" || supply.source === "user_resource")
    && !requirement.producedBy.instanceIds.includes(supply.ownerInstanceId)) return false;
  if (requirement.requiredBefore !== undefined && supply.satisfiesBefore !== undefined
    && ALLOCATION_STAGE_ORDER[supply.satisfiesBefore] > ALLOCATION_STAGE_ORDER[requirement.requiredBefore]) return false;
  const gated = requirement.criticality === "boot" || requirement.criticality === "safety" || requirement.requiredBefore !== undefined;
  if (gated && !checkpointRequirementIds.has(requirement.requirementId)
    && (supply.availability !== "present_verified" || supply.verificationStatus !== "verified")) return false;
  return requirement.predicates.every((predicate) => supply.facets.some((facet) => governedFacetSatisfiesRuntime(facet, predicate)));
}

function addAllocationFlowEdge(graph, from, to, capacity) {
  const forward = { to, reverse: graph[to].length, capacity, initialCapacity: capacity };
  const reverse = { to: from, reverse: graph[from].length, capacity: 0, initialCapacity: 0 };
  graph[from].push(forward); graph[to].push(reverse); return forward;
}

function allocationMaxFlowRuntime(graph, source, sink) {
  while (true) {
    const parent = new Array(graph.length); const queue = [source]; parent[source] = { node: source, edgeIndex: -1 };
    for (let cursor = 0; cursor < queue.length && parent[sink] === undefined; cursor += 1) {
      const node = queue[cursor];
      for (const [edgeIndex, edge] of graph[node].entries()) {
        if (edge.capacity <= 0 || parent[edge.to] !== undefined) continue;
        parent[edge.to] = { node, edgeIndex }; queue.push(edge.to); if (edge.to === sink) break;
      }
    }
    if (parent[sink] === undefined) return;
    let amount = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== source;) {
      const step = parent[node]; const edge = graph[step.node][step.edgeIndex]; amount = Math.min(amount, edge.capacity); node = step.node;
    }
    for (let node = sink; node !== source;) {
      const step = parent[node]; const edge = graph[step.node][step.edgeIndex]; edge.capacity -= amount;
      graph[node][edge.reverse].capacity += amount; node = step.node;
    }
  }
}

/** JS-safe deterministic allocation authority used by offline firmware replay. */
export function allocateRequirementSuppliesRuntime(requirementsInput, suppliesInput, options = {}) {
  if (!Array.isArray(requirementsInput) || !Array.isArray(suppliesInput) || !record(options)
    || Object.keys(options).some((key) => !["safetyCheckpoints", "checkpointByRequirement", "blockedRequirementIds"].includes(key))) {
    throw new TypeError("requirement allocation inputs invalid");
  }
  const requirements = requirementsInput.map(normalizeRequirementRuntime)
    .sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  if (new Set(requirements.map((requirement) => requirement.requirementId)).size !== requirements.length
    || requirements.some((requirement) => validateRequirementNodeRuntime(requirement).length > 0)) throw new TypeError("requirement allocation requirements invalid");
  const supplies = suppliesInput.map(normalizeAllocationSupplyRuntime)
    .sort((left, right) => supplyKey(left) < supplyKey(right) ? -1 : supplyKey(left) > supplyKey(right) ? 1 : 0);
  if (new Set(supplies.map(supplyKey)).size !== supplies.length
    || supplies.some((supply) => validateSupply(supply).length > 0)) throw new TypeError("requirement allocation supplies invalid");
  const checkpointRefs = validAllocationCheckpointsRuntime(requirements, options);
  const checkpointRequirementIds = new Set(checkpointRefs.map((checkpoint) => checkpoint.requirementId));
  const blocked = new Set(options.blockedRequirementIds ?? []);
  if ([...blocked].some((requirementId) => !requirements.some((requirement) => requirement.requirementId === requirementId))) {
    throw new TypeError("blocked requirement reference missing");
  }
  const orderedRequirements = [...requirements].sort((left, right) => {
    const priority = (requirement) => requirement.criticality === "safety" ? 0 : requirement.criticality === "boot" ? 1 : 2;
    return priority(left) - priority(right) || right.predicates.length - left.predicates.length
      || (left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  });
  const source = 0; const supplyOffset = 1; const requirementOffset = supplyOffset + supplies.length;
  const sink = requirementOffset + orderedRequirements.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  supplies.forEach((supply, index) => addAllocationFlowEdge(graph, source, supplyOffset + index, supply.quantity));
  orderedRequirements.forEach((requirement, index) => addAllocationFlowEdge(graph, requirementOffset + index, sink, requirement.quantity));
  const matches = [];
  supplies.forEach((supply, supplyIndex) => orderedRequirements.forEach((requirement, requirementIndex) => {
    if (blocked.has(requirement.requirementId) || !allocationSupplyMatchesRuntime(supply, requirement, checkpointRequirementIds)) return;
    matches.push({ supplyIndex, requirementIndex, edge: addAllocationFlowEdge(
      graph, supplyOffset + supplyIndex, requirementOffset + requirementIndex, Math.min(supply.quantity, requirement.quantity),
    ) });
  }));
  allocationMaxFlowRuntime(graph, source, sink);
  const allocationsByRequirement = new Map(); const consumed = new Map();
  for (const { supplyIndex, requirementIndex, edge } of matches) {
    const quantity = edge.initialCapacity - edge.capacity; if (quantity <= 0) continue;
    const supply = supplies[supplyIndex]; const requirement = orderedRequirements[requirementIndex];
    const allocation = {
      source: supply.source, refId: supply.refId,
      ...(supply.ownerInstanceId === undefined ? {} : { ownerInstanceId: supply.ownerInstanceId }), quantity,
      availability: supply.availability, verificationStatus: supply.verificationStatus,
      ...(supply.satisfiesBefore === undefined ? {} : { satisfiesBefore: supply.satisfiesBefore }),
      evidenceRefs: [...supply.evidenceRefs], observationRefs: [...supply.observationRefs],
    };
    allocationsByRequirement.set(requirement.requirementId, [...(allocationsByRequirement.get(requirement.requirementId) ?? []), allocation]);
    consumed.set(supplyKey(supply), (consumed.get(supplyKey(supply)) ?? 0) + quantity);
  }
  const satisfactions = requirements.map((requirement) => {
    const allocations = (allocationsByRequirement.get(requirement.requirementId) ?? []).sort((left, right) => (
      supplyKey(left) < supplyKey(right) ? -1 : supplyKey(left) > supplyKey(right) ? 1 : 0
    ));
    const residualQuantity = requirement.quantity - allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    return { requirementId: requirement.requirementId, status: blocked.has(requirement.requirementId) ? "blocked"
      : residualQuantity === 0 ? "satisfied" : "open", allocations, residualQuantity };
  });
  const remainingSupplies = supplies.map((supply) => ({
    source: supply.source, refId: supply.refId,
    ...(supply.ownerInstanceId === undefined ? {} : { ownerInstanceId: supply.ownerInstanceId }),
    quantity: supply.quantity - (consumed.get(supplyKey(supply)) ?? 0),
  }));
  const material = { schemaVersion: "requirement-allocation-v1", requirements, supplies, satisfactions, remainingSupplies,
    blockedRequirementIds: [...blocked].sort(), checkpointRefs };
  const contentHash = requirementArtifactContentHashRuntime(material, material.schemaVersion);
  if (contentHash === null) throw new TypeError("requirement allocation cannot be hashed");
  const result = { ...material, contentHash };
  const errors = validateRequirementAllocationResultRuntime(result);
  if (errors.length) throw new TypeError(`Invalid requirement allocation result: ${errors.join("; ")}`);
  return result;
}

export function validateRequirementAllocationResultRuntime(value) {
  try {
    const fields = ["schemaVersion", "requirements", "supplies", "satisfactions", "remainingSupplies", "blockedRequirementIds", "checkpointRefs", "contentHash"];
    if (!exact(value, fields) || value.schemaVersion !== "requirement-allocation-v1") return ["requirement allocation result shape/schema invalid"];
    const errors = [];
    if (!HASH.test(String(value.contentHash ?? ""))) errors.push("requirement allocation contentHash invalid");
    if (!Array.isArray(value.requirements) || !Array.isArray(value.supplies) || !Array.isArray(value.satisfactions)
      || !Array.isArray(value.remainingSupplies) || !strings(value.blockedRequirementIds)
      || !Array.isArray(value.checkpointRefs)) errors.push("requirement allocation collections invalid");
    const requirements = Array.isArray(value.requirements) ? value.requirements : [];
    const supplies = Array.isArray(value.supplies) ? value.supplies : [];
    const satisfactions = Array.isArray(value.satisfactions) ? value.satisfactions : [];
    const checkpoints = Array.isArray(value.checkpointRefs) ? value.checkpointRefs : [];
    requirements.forEach((requirement, index) => errors.push(...validateRequirementNodeRuntime(requirement).map((error) => `requirements.${index}: ${error}`)));
    supplies.forEach((supply, index) => errors.push(...validateSupply(supply).map((error) => `supplies.${index}: ${error}`)));
    if (!canonicallyOrdered(requirements, (requirement) => requirement?.requirementId ?? "")) errors.push("requirement allocation requirements order invalid");
    if (!canonicallyOrdered(supplies, (supply) => record(supply) ? supplyKey(supply) : "")) errors.push("requirement allocation supplies order invalid");
    if (!canonicallyOrdered(satisfactions, (satisfaction) => satisfaction?.requirementId ?? "")) errors.push("requirement allocation satisfactions order invalid");
    if (!canonicallyOrdered(value.remainingSupplies ?? [], (candidate) => record(candidate) ? supplyKey(candidate) : "")) errors.push("requirement allocation remaining supplies order invalid");
    if (!sortedStrings(value.blockedRequirementIds)) errors.push("requirement allocation blocked order invalid");
    if (!canonicallyOrdered(checkpoints, (checkpoint) => `${checkpoint?.requirementId ?? ""}\0${checkpoint?.checkpointId ?? ""}`)) errors.push("requirement allocation checkpoint order invalid");
    if (checkpoints.some((candidate) => !checkpointRef(candidate))) errors.push("requirement allocation checkpointRefs invalid");
    const requirementById = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
    const blockedIds = Array.isArray(value.blockedRequirementIds) ? value.blockedRequirementIds : [];
    const blockedSet = new Set(blockedIds);
    if (blockedIds.some((requirementId) => !requirementById.has(requirementId))) errors.push("requirement allocation blocked reference missing");
    const checkpointIds = checkpoints.map((candidate) => candidate.checkpointId);
    if (new Set(checkpointIds).size !== checkpointIds.length || checkpoints.some((candidate) => !requirementById.has(candidate.requirementId))) errors.push("requirement allocation checkpoint reference duplicate or missing");
    const satisfactionIds = [];
    for (const [index, satisfaction] of satisfactions.entries()) {
      satisfactionIds.push(satisfaction?.requirementId);
      const requirement = requirementById.get(satisfaction?.requirementId);
      if (!requirement) errors.push(`satisfactions.${index}: requirement missing`);
      else {
        if (!canonicallyOrdered(satisfaction.allocations ?? [], (allocation) => record(allocation) ? supplyKey(allocation) : "")) {
          errors.push(`satisfactions.${index}: allocations order invalid`);
        }
        errors.push(...validateRequirementSatisfactionRuntime(requirement, satisfaction, checkpoints).map((error) => `satisfactions.${index}: ${error}`));
        if (blockedSet.has(satisfaction.requirementId)
          && (satisfaction.allocations?.length !== 0 || satisfaction.residualQuantity !== requirement.quantity)) {
          errors.push(`satisfactions.${index}: blocked requirement cannot consume supply`);
        }
        const expectedStatus = blockedSet.has(satisfaction.requirementId) ? "blocked"
          : satisfaction.residualQuantity === 0 ? "satisfied" : "open";
        if (satisfaction.status !== expectedStatus) errors.push(`satisfactions.${index}: status differs from blocked requirement authority`);
      }
    }
    if (new Set(satisfactionIds).size !== satisfactionIds.length || satisfactionIds.length !== requirementById.size
      || [...requirementById.keys()].some((requirementId) => !satisfactionIds.includes(requirementId))) errors.push("requirement allocation must contain exactly one satisfaction per requirement");
    const supplyByKey = new Map();
    for (const supply of supplies) {
      const key = supplyKey(supply);
      if (supplyByKey.has(key)) errors.push("requirement supplies must be unique by source/owner/ref");
      supplyByKey.set(key, supply);
    }
    const consumed = new Map();
    for (const satisfaction of satisfactions) for (const allocation of satisfaction?.allocations ?? []) {
      const key = supplyKey(allocation);
      consumed.set(key, (consumed.get(key) ?? 0) + (Number.isSafeInteger(allocation.quantity) ? allocation.quantity : 0));
      const supply = supplyByKey.get(key);
      if (!supply) errors.push(`allocation references missing supply: ${key}`);
      else {
        if (allocation.availability !== supply.availability || allocation.verificationStatus !== supply.verificationStatus
          || allocation.satisfiesBefore !== supply.satisfiesBefore
          || canonical(allocation.evidenceRefs, false) !== canonical(supply.evidenceRefs, false)
          || canonical(allocation.observationRefs, false) !== canonical(supply.observationRefs, false)) errors.push(`allocation metadata differs from supply: ${key}`);
        const requirement = requirementById.get(satisfaction.requirementId);
        if (!requirement || requirement.kind !== supply.kind
          || requirement.predicates.some((predicate) => !supply.facets.some((facet) => governedFacetSatisfiesRuntime(facet, predicate)))) {
          errors.push(`allocation supply does not satisfy requirement kind/facets: ${key}`);
        }
        if ((supply.source === "package_content" || supply.source === "user_resource")
          && !requirement?.producedBy?.instanceIds?.includes(supply.ownerInstanceId)) {
          errors.push(`allocation supply owner is outside requirement target scope: ${key}`);
        }
        const order = { assembly: 0, pre_power: 1, first_boot: 2, os_install: 3 };
        if (requirement?.requiredBefore !== undefined && supply.satisfiesBefore !== undefined
          && order[supply.satisfiesBefore] > order[requirement.requiredBefore]) errors.push(`allocation supply becomes available after requirement gate: ${key}`);
      }
    }
    const remaining = Array.isArray(value.remainingSupplies) ? value.remainingSupplies : [];
    if (remaining.some((candidate) => !remainingSupply(candidate))) errors.push("remaining supply entry invalid");
    const remainingByKey = new Map();
    for (const candidate of remaining) {
      const key = supplyKey(candidate);
      if (remainingByKey.has(key)) errors.push("remaining supplies must be unique");
      remainingByKey.set(key, candidate.quantity);
    }
    for (const [key, supply] of supplyByKey) {
      const used = consumed.get(key) ?? 0;
      if (used > supply.quantity || (remainingByKey.get(key) ?? -1) !== supply.quantity - used) errors.push(`supply quantity is not conserved: ${key}`);
    }
    if ([...remainingByKey.keys()].some((key) => !supplyByKey.has(key))) errors.push("remaining supply references missing supply");
    const expected = requirementArtifactContentHashRuntime(value, value.schemaVersion);
    if (expected === null || value.contentHash !== expected) errors.push("requirement allocation content hash mismatch");
    return errors;
  } catch { return ["requirement allocation result is inaccessible or invalid"]; }
}

/**
 * Replay the deterministic allocator from the exact persisted requirements and
 * supplies, while taking blocked/cycle and checkpoint authority only from the
 * independently locked closure context. Structural conservation alone cannot
 * prove that the canonical maximum flow was actually used.
 */
export function validateRequirementAllocationReplayRuntime(value, context) {
  try {
    const errors = validateRequirementAllocationResultRuntime(value);
    if (errors.length) return ["requirement allocation replay source invalid", ...errors];
    if (!exact(context, ["blockedRequirementIds", "checkpointBindings"])
      || !Array.isArray(context.blockedRequirementIds) || !Array.isArray(context.checkpointBindings)
      || !sortedStrings(context.blockedRequirementIds)) {
      return ["requirement allocation replay context invalid"];
    }
    const replay = allocateRequirementSuppliesRuntime(value.requirements, value.supplies, {
      blockedRequirementIds: context.blockedRequirementIds,
      safetyCheckpoints: context.checkpointBindings,
    });
    return canonical(value, false) === canonical(replay, false)
      ? [] : ["requirement allocation differs from deterministic authoritative replay"];
  } catch { return ["requirement allocation deterministic replay failed closed"]; }
}

function adapterArtifactHash(value) {
  try {
    return sha256Utf8Runtime(`buildsim\u0000hash-spec-v1\u0000artifact.adapter-snapshot\u00001.0.0\u0000${canonical(value)}`);
  } catch { return null; }
}

/** Rebind every package supply to an exact owner instance and locked adapter manifest. */
export function validateRequirementAllocationPackageClosureRuntime(value, bindings) {
  try {
    const errors = validateRequirementAllocationResultRuntime(value);
    if (errors.length) return ["package allocation source artifact invalid", ...errors];
    if (!Array.isArray(bindings)) return ["package allocation manifest bindings invalid"];
    const byOwner = new Map();
    for (const [index, binding] of bindings.entries()) {
      if (!exact(binding, ["ownerInstanceId", "manifest"]) || !id(binding.ownerInstanceId)) {
        errors.push(`package manifest bindings.${index} shape invalid`);
        continue;
      }
      const manifestErrors = validateCaseAdapterManifestRuntime(binding.manifest);
      if (manifestErrors.length) errors.push(...manifestErrors.map((error) => `package manifest bindings.${index}: ${error}`));
      if (byOwner.has(binding.ownerInstanceId)) errors.push(`package manifest owner binding duplicated: ${binding.ownerInstanceId}`);
      byOwner.set(binding.ownerInstanceId, binding.manifest);
    }
    for (const supply of value.supplies.filter((candidate) => candidate.source === "package_content")) {
      const manifest = byOwner.get(supply.ownerInstanceId);
      const authority = supply.packageAuthorityRef;
      if (!manifest) { errors.push(`package supply owner manifest missing: ${supply.ownerInstanceId}`); continue; }
      if (authority.manifestHash !== manifest.contentHash || authority.ownerSkuId !== manifest.identity.skuId) {
        errors.push(`package supply manifest identity/hash mismatch: ${supply.ownerInstanceId}/${supply.refId}`);
        continue;
      }
      const bundle = manifest.bundleItems.find((candidate) => candidate.bundleItemId === supply.refId);
      if (!bundle || bundle.contentHash !== authority.bundleItemHash || bundle.ownerSkuId !== authority.ownerSkuId) {
        errors.push(`package supply bundle authority mismatch: ${supply.ownerInstanceId}/${supply.refId}`);
        continue;
      }
      const identityHash = adapterArtifactHash({
        schemaVersion: "instance-supply-identity-v1",
        ownerInstanceId: supply.ownerInstanceId,
        bundleItemId: bundle.bundleItemId,
        bundleItemHash: bundle.contentHash,
      });
      const instanceSupplyId = identityHash === null ? null : `instance-supply-sha256-${identityHash}`;
      const material = {
        schemaVersion: "instance-supply-v1",
        supplyId: instanceSupplyId,
        ownerInstanceId: supply.ownerInstanceId,
        ownerSkuId: bundle.ownerSkuId,
        bundleItemId: bundle.bundleItemId,
        bundleItemHash: bundle.contentHash,
        kind: bundle.kind,
        specification: structuredClone(bundle.specification),
        quantity: bundle.quantity,
        ...(bundle.region === undefined ? {} : { region: bundle.region }),
        ...(bundle.revision === undefined ? {} : { revision: bundle.revision }),
        evidenceFactIds: structuredClone(bundle.evidenceFactIds),
      };
      const instanceSupplyHash = instanceSupplyId === null ? null : adapterArtifactHash(material);
      if (authority.instanceSupplyId !== instanceSupplyId || authority.instanceSupplyHash !== instanceSupplyHash) {
        errors.push(`package supply instance authority mismatch: ${supply.ownerInstanceId}/${supply.refId}`);
      }
      const expectedKind = ["cable", "fastener", "tool", "consumable"].includes(bundle.kind) ? bundle.kind : "accessory";
      const expectedFacets = bundle.specification.map((facet) => ({
        facetId: facet.facetId,
        value: Array.isArray(facet.value) ? [...facet.value].sort() : structuredClone(facet.value),
        ...(facet.facetId === "fastener.length_mm" ? { unitId: "mm" } : {}),
      })).sort((left, right) => left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0);
      const actualFacets = structuredClone(supply.facets).sort((left, right) => left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0);
      if (supply.kind !== expectedKind || supply.quantity !== bundle.quantity
        || canonical(actualFacets, false) !== canonical(expectedFacets, false)
        || canonical([...supply.evidenceRefs].sort(), false) !== canonical([...bundle.evidenceFactIds].sort(), false)) {
        errors.push(`package supply projection differs from locked bundle: ${supply.ownerInstanceId}/${supply.refId}`);
      }
    }
    return [...new Set(errors)];
  } catch { return ["package allocation manifest closure validation failed closed"]; }
}

/**
 * Bind persisted checkpoint references to the actual execution checkpoint and
 * the current plan/procedure dependency authority. Matching requirement IDs
 * alone never authorize a gated allocation.
 */
export function validateRequirementAllocationCheckpointClosureRuntime(value, bindings) {
  try {
    const errors = validateRequirementAllocationResultRuntime(value);
    if (errors.length) return ["checkpoint allocation source artifact invalid", ...errors];
    if (!Array.isArray(bindings)) return ["checkpoint allocation authority bindings invalid"];
    const byKey = new Map();
    for (const [index, binding] of bindings.entries()) {
      if (!exact(binding, ["checkpoint", "context"]) || !checkpointRef(binding.checkpoint)
        || !exact(binding.context, ["planVersionId", "procedureId", "expectedDependencyHash", "expectedProcedureSafetyHash"])
        || !id(binding.context.planVersionId) || !id(binding.context.procedureId)
        || !HASH.test(String(binding.context.expectedDependencyHash ?? ""))
        || !HASH.test(String(binding.context.expectedProcedureSafetyHash ?? ""))) {
        errors.push(`checkpoint authority bindings.${index} shape invalid`);
        continue;
      }
      const checkpoint = binding.checkpoint;
      const context = binding.context;
      const key = checkpoint.checkpointId;
      if (byKey.has(key)) errors.push(`checkpoint authority binding duplicated: ${checkpoint.checkpointId}`);
      byKey.set(key, binding);
      if (checkpoint.planVersionId !== context.planVersionId || checkpoint.procedureId !== context.procedureId
        || checkpoint.dependencyHash !== context.expectedDependencyHash
        || checkpoint.procedureSafetyHash !== context.expectedProcedureSafetyHash) {
        errors.push(`checkpoint authority is stale or scope-mismatched: ${checkpoint.checkpointId}`);
      }
    }
    const persistedKeys = new Set();
    for (const checkpoint of value.checkpointRefs) {
      const key = checkpoint.checkpointId;
      persistedKeys.add(key);
      const binding = byKey.get(key);
      if (binding === undefined) errors.push(`checkpoint execution authority missing: ${checkpoint.checkpointId}`);
      else if (canonical(checkpoint, false) !== canonical(binding.checkpoint, false)) {
        errors.push(`checkpoint persisted reference differs from execution authority: ${checkpoint.checkpointId}`);
      }
    }
    for (const [key, binding] of byKey) {
      if (!persistedKeys.has(key)) errors.push(`checkpoint authority is not referenced by allocation: ${binding.checkpoint.checkpointId}`);
    }
    return [...new Set(errors)];
  } catch { return ["checkpoint allocation authority closure validation failed closed"]; }
}

function sortedUniqueRequirementIds(requirements) {
  return [...new Set(requirements.map((requirement) => requirement.requirementId))].sort();
}

/** Recompute readiness from the exact allocation artifact; caller booleans have no authority. */
export function validateRequirementReadinessRuntime(value, allocation) {
  try {
    const fields = [
      "schemaVersion", "sourceAllocationHash", "assemblyReady", "powerReady", "firstBootReady", "osInstallReady",
      "assemblyBlockerRequirementIds", "powerBlockerRequirementIds", "firstBootBlockerRequirementIds",
      "osInstallBlockerRequirementIds", "contentHash",
    ];
    if (!exact(value, fields) || value.schemaVersion !== "requirement-readiness-v1") return ["requirement readiness shape/schema invalid"];
    const errors = [];
    if (validateRequirementAllocationResultRuntime(allocation).length) return ["requirement readiness source allocation invalid"];
    if (!HASH.test(String(value.sourceAllocationHash ?? "")) || value.sourceAllocationHash !== allocation.contentHash) errors.push("requirement readiness source allocation hash mismatch");
    if (![value.assemblyReady, value.powerReady, value.firstBootReady, value.osInstallReady].every((candidate) => typeof candidate === "boolean")) errors.push("requirement readiness booleans invalid");
    const collections = [
      value.assemblyBlockerRequirementIds, value.powerBlockerRequirementIds,
      value.firstBootBlockerRequirementIds, value.osInstallBlockerRequirementIds,
    ];
    if (collections.some((candidate) => !strings(candidate))) errors.push("requirement readiness blocker collections invalid");
    const satisfactionById = new Map(allocation.satisfactions.map((satisfaction) => [satisfaction.requirementId, satisfaction]));
    const unsatisfied = (requirement) => satisfactionById.get(requirement.requirementId)?.status !== "satisfied";
    const assembly = allocation.requirements.filter((requirement) => requirement.requiredBefore === "assembly" && unsatisfied(requirement));
    const power = allocation.requirements.filter((requirement) => (
      requirement.requiredBefore === "pre_power" || requirement.criticality === "safety"
      || (requirement.requiredBefore === undefined && requirement.criticality === "boot")
    ) && unsatisfied(requirement));
    const firstBoot = allocation.requirements.filter((requirement) => (
      requirement.requiredBefore === "first_boot" || requirement.criticality === "boot"
    ) && unsatisfied(requirement));
    const osInstall = allocation.requirements.filter((requirement) => requirement.requiredBefore === "os_install" && unsatisfied(requirement));
    const expected = {
      assemblyBlockerRequirementIds: sortedUniqueRequirementIds(assembly),
      powerBlockerRequirementIds: sortedUniqueRequirementIds([...assembly, ...power]),
      firstBootBlockerRequirementIds: sortedUniqueRequirementIds([...assembly, ...power, ...firstBoot]),
      osInstallBlockerRequirementIds: sortedUniqueRequirementIds([...assembly, ...power, ...firstBoot, ...osInstall]),
    };
    for (const [field, ids] of Object.entries(expected)) {
      if (canonical(value[field], false) !== canonical(ids, false)) errors.push(`requirement readiness ${field} does not match allocation`);
    }
    if (value.assemblyReady !== (expected.assemblyBlockerRequirementIds.length === 0)
      || value.powerReady !== (expected.powerBlockerRequirementIds.length === 0)
      || value.firstBootReady !== (expected.firstBootBlockerRequirementIds.length === 0)
      || value.osInstallReady !== (expected.osInstallBlockerRequirementIds.length === 0)) errors.push("requirement readiness booleans do not match blockers");
    const contentHash = requirementArtifactContentHashRuntime(value, value.schemaVersion);
    if (!HASH.test(String(value.contentHash ?? "")) || contentHash === null || value.contentHash !== contentHash) errors.push("requirement readiness content hash mismatch");
    return errors;
  } catch { return ["requirement readiness is inaccessible or invalid"]; }
}

export function requirementClosureReferencesRuntime(value) {
  try {
    if (validateRequirementClosureRuntime(value).length) return null;
    return Object.freeze({
      instanceIds: Object.freeze([...new Set(value.requirements.flatMap((requirement) => requirement.producedBy.instanceIds))].sort()),
      evidenceRefs: Object.freeze([...new Set(value.requirements.flatMap((requirement) => requirement.evidenceRefs))].sort()),
      ruleRefs: Object.freeze(value.ruleRefs.map((rule) => `${rule.ruleId}@${rule.ruleVersion}`).sort()),
    });
  } catch { return null; }
}

export function requirementAllocationReferencesRuntime(value) {
  try {
    if (validateRequirementAllocationResultRuntime(value).length) return null;
    return Object.freeze({
      ownerInstanceIds: Object.freeze([...new Set(value.supplies.flatMap((supply) => supply.ownerInstanceId === undefined ? [] : [supply.ownerInstanceId]))].sort()),
      evidenceRefs: Object.freeze([...new Set(value.supplies.flatMap((supply) => supply.evidenceRefs))].sort()),
      observationRefs: Object.freeze([...new Set(value.supplies.flatMap((supply) => supply.observationRefs))].sort()),
      checkpointIds: Object.freeze(value.checkpointRefs.map((checkpoint) => checkpoint.checkpointId).sort()),
      checkpointRefs: Object.freeze(value.checkpointRefs.map((checkpoint) => Object.freeze(structuredClone(checkpoint)))),
      blockedRequirementIds: Object.freeze([...value.blockedRequirementIds]),
      packageSupplyRefs: Object.freeze(value.supplies.filter((supply) => supply.source === "package_content").map((supply) => Object.freeze({
        ownerInstanceId: supply.ownerInstanceId,
        bundleItemId: supply.refId,
        ...structuredClone(supply.packageAuthorityRef),
      }))),
      manifestHashes: Object.freeze([...new Set(value.supplies.filter((supply) => supply.source === "package_content")
        .map((supply) => supply.packageAuthorityRef.manifestHash))].sort()),
    });
  } catch { return null; }
}
