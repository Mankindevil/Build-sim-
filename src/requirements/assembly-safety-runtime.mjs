import {
  governedFacetSatisfiesRuntime,
  validateGovernedFacetPredicateRuntime as validateFacetPredicate,
  validateGovernedFacetValueRuntime
} from "../contracts/governed-facet-runtime.mjs";
import {
  requirementArtifactContentHashRuntime,
  validateRequirementAllocationPackageClosureRuntime,
  validateRequirementAllocationResultRuntime,
  validateRequirementNodeRuntime
} from "./runtime.mjs";
const CHECK_TYPES = /* @__PURE__ */ new Set(["resource", "standoff_layout", "connection", "12v2x6", "protective_film", "loose_metal"]);
const CONNECTIONS = /* @__PURE__ */ new Set(["atx24", "eps", "gpu_power", "cpu_fan", "pump"]);
const RESOURCE_ROLES = /* @__PURE__ */ new Set([
  "motherboard_screw",
  "cooler_backplate",
  "cooler_retention",
  "thermal_material",
  "tool",
  "temporary_component",
  "firmware_medium",
  "firmware_action",
  "other"
]);
const RESOURCE_KINDS = /* @__PURE__ */ new Set(["component", "accessory", "fastener", "cable", "consumable", "tool", "firmware_action"]);
const RESOURCE_STATES = /* @__PURE__ */ new Set(["present_verified", "absent_verified", "mismatch_verified", "unknown"]);
const CONNECTION_STATES = /* @__PURE__ */ new Set(["connected_verified", "disconnected_verified", "wrong_connector_verified", "unknown"]);
const CRITICALITIES = /* @__PURE__ */ new Set(["normal", "boot", "safety"]);
const STAGES = /* @__PURE__ */ new Set(["assembly", "pre_power", "first_boot", "os_install"]);
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, required) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => required.includes(key));
}
function id(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.normalize("NFC") && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}
function ids(value, nonEmpty = false) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(id) && new Set(value).size === value.length;
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 65536;
}
function commonErrors(check) {
  const errors = [];
  if (!id(check.checkId) || !id(check.ownerInstanceId)) errors.push("assembly check identity invalid");
  if (!ids(check.instanceIds, true) || !ids(check.factIds) || !ids(check.observationIds)) errors.push("assembly check authority references invalid");
  else if (!check.instanceIds.includes(check.ownerInstanceId)) errors.push("assembly check ownerInstanceId must be in instanceIds");
  return errors;
}
function checkErrors(value) {
  if (!record(value) || !CHECK_TYPES.has(String(value.checkType))) return ["assembly safety check type invalid"];
  const common = ["checkId", "checkType", "ownerInstanceId", "instanceIds", "factIds", "observationIds"];
  const errors = commonErrors(value);
  if (value.checkType === "resource") {
    if (!exact(value, [...common, "resourceId", "role", "kind", "predicates", "quantity", "criticality", "requiredBefore", "state"])) return ["assembly resource check shape invalid"];
    if (!id(value.resourceId) || !RESOURCE_ROLES.has(value.role) || !RESOURCE_KINDS.has(value.kind)) errors.push("assembly resource identity/role/kind invalid");
    if (!Array.isArray(value.predicates)) errors.push("assembly resource predicates invalid");
    else value.predicates.forEach((predicate, index) => errors.push(...validateFacetPredicate(predicate).map((error) => `assembly resource predicates.${index}: ${error}`)));
    if (!positiveInteger(value.quantity) || !CRITICALITIES.has(value.criticality) || !STAGES.has(value.requiredBefore)) errors.push("assembly resource quantity/gate invalid");
    if (!RESOURCE_STATES.has(value.state)) errors.push("assembly resource state invalid");
    if (value.state !== "unknown" && value.observationIds.length === 0) errors.push("verified assembly resource state requires an observation");
    if (value.state === "present_verified" && concreteFacets(value.predicates) === null) errors.push("verified assembly resource predicates cannot form a concrete matching supply");
  } else if (value.checkType === "standoff_layout") {
    if (!exact(value, [...common, "expectedPositionIds", "expectedThread", "expectedHeightMm", "heightToleranceMm", "observed"])) return ["assembly standoff check shape invalid"];
    if (!ids(value.expectedPositionIds, true) || !id(value.expectedThread) || !finiteNonNegative(value.expectedHeightMm) || Number(value.expectedHeightMm) === 0 || !finiteNonNegative(value.heightToleranceMm)) errors.push("assembly standoff expectation invalid");
    if (value.observed !== null) {
      if (!Array.isArray(value.observed) || value.observed.some((entry) => !exact(entry, ["positionId", "thread", "heightMm"]) || !id(entry.positionId) || !id(entry.thread) || !finiteNonNegative(entry.heightMm) || entry.heightMm === 0)) errors.push("assembly standoff observation invalid");
      else if (new Set(value.observed.map((entry) => entry.positionId)).size !== value.observed.length) errors.push("assembly standoff positions repeat");
      if (value.observationIds.length === 0) errors.push("observed standoff layout requires an observation");
    }
  } else if (value.checkType === "connection") {
    if (!exact(value, [...common, "connectionKind", "connectorStandard", "state"])) return ["assembly connection check shape invalid"];
    if (!CONNECTIONS.has(value.connectionKind) || !id(value.connectorStandard) || !CONNECTION_STATES.has(value.state)) errors.push("assembly connection declaration invalid");
    if (value.state !== "unknown" && value.observationIds.length === 0) errors.push("verified assembly connection requires an observation");
  } else if (value.checkType === "12v2x6") {
    if (!exact(value, [...common, "connectorStandard", "state", "fullySeated", "bendDistanceMm", "minimumBendDistanceMm"])) return ["assembly 12v2x6 check shape invalid"];
    if (value.connectorStandard !== "12v2x6" || !CONNECTION_STATES.has(value.state) || value.fullySeated !== null && typeof value.fullySeated !== "boolean" || value.bendDistanceMm !== null && !finiteNonNegative(value.bendDistanceMm) || !finiteNonNegative(value.minimumBendDistanceMm) || Number(value.minimumBendDistanceMm) === 0) errors.push("assembly 12v2x6 declaration invalid");
    if ((value.state !== "unknown" || value.fullySeated !== null || value.bendDistanceMm !== null) && value.observationIds.length === 0) errors.push("verified 12v2x6 state requires an observation");
  } else if (value.checkType === "protective_film") {
    if (!exact(value, [...common, "state"])) return ["assembly protective-film check shape invalid"];
    if (!["removed_verified", "present_verified", "unknown"].includes(String(value.state))) errors.push("assembly protective-film state invalid");
    if (value.state !== "unknown" && value.observationIds.length === 0) errors.push("verified protective-film state requires an observation");
  } else {
    if (!exact(value, [...common, "state"])) return ["assembly loose-metal check shape invalid"];
    if (!["clear_verified", "found_verified", "unknown"].includes(String(value.state))) errors.push("assembly loose-metal state invalid");
    if (value.state !== "unknown" && value.observationIds.length === 0) errors.push("verified loose-metal state requires an observation");
  }
  return errors;
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeIds(value) {
  return [...value].sort(compare);
}
function predicateKey(value) {
  return `${value.facetId}\0${value.operator}\0${JSON.stringify(value.value)}\0${value.unitId ?? ""}`;
}
function normalizeCheck(check) {
  const base = {
    ...structuredClone(check),
    instanceIds: normalizeIds(check.instanceIds),
    factIds: normalizeIds(check.factIds),
    observationIds: normalizeIds(check.observationIds)
  };
  if (base.checkType === "resource") {
    base.predicates.sort((left, right) => compare(predicateKey(left), predicateKey(right)));
  } else if (base.checkType === "standoff_layout") {
    base.expectedPositionIds.sort(compare);
    base.observed?.sort((left, right) => compare(left.positionId, right.positionId));
  }
  return base;
}
function requirement(assemblyId, check, suffix, kind, predicates, quantity, criticality = "safety", requiredBefore = "pre_power") {
  const node = {
    requirementId: `requirement.assembly.${assemblyId}.${check.checkId}${suffix.length ? `.${suffix}` : ""}`,
    kind,
    predicates: structuredClone(predicates).sort((left, right) => compare(predicateKey(left), predicateKey(right))),
    quantity,
    criticality,
    requiredBefore,
    producedBy: { ruleId: `assembly.${check.checkType}`, ruleVersion: "1.0.0", instanceIds: normalizeIds(check.instanceIds) },
    evidenceRefs: normalizeIds(check.factIds)
  };
  const errors = validateRequirementNodeRuntime(node);
  if (errors.length) throw new TypeError(`generated assembly requirement invalid: ${errors.join("; ")}`);
  return node;
}
function decision(assemblyId, check, verdict, message, remediation, assumptions = []) {
  return {
    decisionId: `decision.assembly.${assemblyId}.${check.checkId}`,
    verdict,
    domain: check.checkType === "connection" || check.checkType === "12v2x6" ? "electrical" : "assembly",
    message,
    instanceIds: normalizeIds(check.instanceIds),
    factIds: normalizeIds(check.factIds),
    ruleId: `assembly.${check.checkType}`,
    ruleVersion: "1.0.0",
    assumptions,
    remediation
  };
}
function deriveCheck(assemblyId, check) {
  if (check.checkType === "resource") {
    const node2 = requirement(assemblyId, check, "", check.kind, check.predicates, check.quantity, check.criticality, check.requiredBefore);
    // A verified-present item is supply authority, not a second demand for the
    // same physical item. Only an actual gap emits a RequirementNode.
    if (check.state === "present_verified") return { requirements: [], decision: decision(assemblyId, check, "pass", `${check.role} is present and observed.`, []) };
    if (check.state === "mismatch_verified") return { requirements: [node2], decision: decision(assemblyId, check, "fail", `${check.role} is present but does not match the governed specification.`, [node2]) };
    return { requirements: [node2], decision: decision(assemblyId, check, "blocked", `${check.role} availability is not verified present.`, [node2], check.state === "unknown" ? ["resource presence is unknown"] : []) };
  }
  if (check.checkType === "standoff_layout") {
    const supply = requirement(assemblyId, check, "standoffs", "accessory", [
      { facetId: "resource.kind", operator: "eq", value: "standoff" },
      { facetId: "fastener.thread", operator: "eq", value: check.expectedThread },
      { facetId: "fastener.length_mm", operator: "eq", value: check.expectedHeightMm, unitId: "mm" }
    ], check.expectedPositionIds.length, "safety", "assembly");
    const layout = requirement(assemblyId, check, "layout-checkpoint", "measurement", [], 1);
    if (check.observed === null) return { requirements: [supply, layout], decision: decision(assemblyId, check, "blocked", "Standoff positions, thread, and height have not been observed.", [supply, layout], ["installed standoff layout is unknown"]) };
    const expected = new Set(check.expectedPositionIds);
    const observed = new Map(check.observed.map((entry) => [entry.positionId, entry]));
    const missing = check.expectedPositionIds.filter((position) => !observed.has(position));
    const extra = check.observed.filter((entry) => !expected.has(entry.positionId));
    const mismatch = check.observed.filter((entry) => expected.has(entry.positionId) && (entry.thread !== check.expectedThread || Math.abs(entry.heightMm - check.expectedHeightMm) > check.heightToleranceMm));
    const unsafe = missing.length > 0 || extra.length > 0 || mismatch.length > 0;
    return {
      requirements: [supply, layout],
      decision: decision(assemblyId, check, unsafe ? "fail" : "pass", unsafe ? `Standoff layout is unsafe: ${missing.length} missing, ${extra.length} extra, ${mismatch.length} wrong thread/height.` : "Every required standoff is present with no extra or mismatched standoff.", unsafe ? [supply, layout] : [])
    };
  }
  const node = requirement(assemblyId, check, "", "measurement", [], 1);
  if (check.checkType === "connection") {
    if (check.state === "connected_verified") return { requirements: [node], decision: decision(assemblyId, check, "pass", `${check.connectionKind} is observed fully connected.`, []) };
    if (check.state === "unknown") return { requirements: [node], decision: decision(assemblyId, check, "blocked", `${check.connectionKind} connection is not observed.`, [node], ["physical connection state is unknown"]) };
    return { requirements: [node], decision: decision(assemblyId, check, "fail", `${check.connectionKind} is disconnected or uses the wrong connector.`, [node]) };
  }
  if (check.checkType === "12v2x6") {
    const knownUnsafe = check.state === "disconnected_verified" || check.state === "wrong_connector_verified" || check.fullySeated === false || check.bendDistanceMm !== null && check.bendDistanceMm < check.minimumBendDistanceMm;
    const complete = check.state === "connected_verified" && check.fullySeated === true && check.bendDistanceMm !== null;
    return {
      requirements: [node],
      decision: decision(assemblyId, check, knownUnsafe ? "fail" : complete ? "pass" : "blocked", knownUnsafe ? "12V-2x6 is not safely seated or its bend begins inside the governed minimum distance." : complete ? "12V-2x6 seating and bend distance are observed safe." : "12V-2x6 seating or bend distance is not fully observed.", knownUnsafe || !complete ? [node] : [], complete || knownUnsafe ? [] : ["connector seating/bend evidence is incomplete"])
    };
  }
  if (check.checkType === "protective_film") {
    const verdict2 = check.state === "removed_verified" ? "pass" : check.state === "present_verified" ? "fail" : "blocked";
    return { requirements: [node], decision: decision(
      assemblyId,
      check,
      verdict2,
      verdict2 === "pass" ? "Cooler protective film removal is observed." : verdict2 === "fail" ? "Cooler protective film remains installed." : "Protective film removal is not observed.",
      verdict2 === "pass" ? [] : [node]
    ) };
  }
  const verdict = check.state === "clear_verified" ? "pass" : check.state === "found_verified" ? "fail" : "blocked";
  return { requirements: [node], decision: decision(
    assemblyId,
    check,
    verdict,
    verdict === "pass" ? "No loose conductive metal is observed." : verdict === "fail" ? "Loose conductive metal is present in the chassis." : "Loose-metal inspection is not observed.",
    verdict === "pass" ? [] : [node]
  ) };
}
function derive(input) {
  const checks = input.checks.map(normalizeCheck).sort((left, right) => compare(left.checkId, right.checkId));
  const derived = checks.map((check) => deriveCheck(input.assemblyId, check));
  const requirements = derived.flatMap((entry) => entry.requirements).sort((left, right) => compare(left.requirementId, right.requirementId));
  if (new Set(requirements.map(({ requirementId }) => requirementId)).size !== requirements.length) throw new TypeError("assembly requirements collide");
  const material = {
    schemaVersion: "assembly-safety-evaluation-v1",
    assemblyId: input.assemblyId,
    checks,
    decisions: derived.map((entry) => entry.decision).sort((left, right) => compare(left.decisionId, right.decisionId)),
    requirements
  };
  const contentHash = requirementArtifactContentHashRuntime(material, "assembly-safety-evaluation-v1");
  if (contentHash === null) throw new TypeError("assembly safety evaluation cannot be hashed");
  return { ...material, contentHash };
}
function evaluateAssemblySafety(input) {
  const errors = validateAssemblySafetyInput(input);
  if (errors.length) throw new TypeError(`Invalid assembly safety input: ${errors.join("; ")}`);
  return derive({ assemblyId: input.assemblyId, checks: input.checks });
}
function validateAssemblySafetyInput(value) {
  try {
    if (!exact(value, ["assemblyId", "checks"])) return ["assembly safety input shape invalid"];
    const errors = [];
    if (!id(value.assemblyId)) errors.push("assemblyId invalid");
    if (!Array.isArray(value.checks)) errors.push("assembly checks invalid");
    else {
      value.checks.forEach((check, index) => errors.push(...checkErrors(check).map((error) => `checks.${index}: ${error}`)));
      const checkIds = value.checks.map((check) => record(check) ? check.checkId : void 0).filter((checkId) => typeof checkId === "string");
      if (new Set(checkIds).size !== checkIds.length) errors.push("assembly check IDs must be unique");
      const resourceIds = value.checks.filter((check) => record(check) && check.checkType === "resource")
        .map((check) => check.resourceId).filter((resourceId) => typeof resourceId === "string");
      if (new Set(resourceIds).size !== resourceIds.length) errors.push("assembly resource IDs must be unique");
      const observationIds = value.checks.flatMap((check) => record(check) && check.checkType === "resource"
        && Array.isArray(check.observationIds) ? check.observationIds : []);
      if (new Set(observationIds).size !== observationIds.length) {
        errors.push("assembly resource observations cannot be reused across checks");
      }
    }
    return errors;
  } catch {
    return ["assembly safety input is inaccessible or invalid"];
  }
}
function validateAssemblySafetyEvaluationRuntime(value) {
  try {
    const fields = ["schemaVersion", "assemblyId", "checks", "decisions", "requirements", "contentHash"];
    if (!exact(value, fields) || value.schemaVersion !== "assembly-safety-evaluation-v1") return ["assembly safety evaluation shape/schema invalid"];
    if (!Array.isArray(value.checks)) return ["assembly safety evaluation checks invalid"];
    const inputErrors = validateAssemblySafetyInput({ assemblyId: value.assemblyId, checks: value.checks });
    if (inputErrors.length) return inputErrors;
    const replay = derive({ assemblyId: value.assemblyId, checks: value.checks });
    return JSON.stringify(replay) === JSON.stringify(value) ? [] : ["assembly safety evaluation differs from authoritative replay"];
  } catch {
    return ["assembly safety evaluation is inaccessible or invalid"];
  }
}
function assemblySafetyReferencesRuntime(value) {
  if (validateAssemblySafetyEvaluationRuntime(value).length) return null;
  const evaluation = value;
  return Object.freeze({
    instanceIds: Object.freeze(normalizeIds(evaluation.checks.flatMap((check) => check.instanceIds).filter((entry, index, all) => all.indexOf(entry) === index))),
    factIds: Object.freeze(normalizeIds(evaluation.checks.flatMap((check) => check.factIds).filter((entry, index, all) => all.indexOf(entry) === index))),
    observationIds: Object.freeze(normalizeIds(evaluation.checks.flatMap((check) => check.observationIds).filter((entry, index, all) => all.indexOf(entry) === index)).map((id) => `observation:${id}`)),
    requirementIds: Object.freeze(evaluation.requirements.map((node) => node.requirementId))
  });
}
function concreteFacets(predicates) {
  try {
    const groups = new Map();
    for (const predicate of predicates) groups.set(predicate.facetId, [...groups.get(predicate.facetId) ?? [], predicate]);
    const facets = [];
    for (const [facetId, group] of groups) {
      const unitId = group[0].unitId;
      if (group.some((predicate) => predicate.unitId !== unitId)) return null;
      let value;
      if (group.some((predicate) => predicate.operator === "includes")) {
        if (group.some((predicate) => predicate.operator !== "includes")) return null;
        value = [...new Set(group.map((predicate) => predicate.value))].sort(compare);
      } else if (group.some((predicate) => predicate.operator !== "eq")) {
        let low = Number.NEGATIVE_INFINITY;
        let high = Number.POSITIVE_INFINITY;
        let equality = null;
        for (const predicate of group) {
          if (predicate.operator === "eq") equality = equality === null || equality === predicate.value ? predicate.value : Number.NaN;
          else if (predicate.operator === "gte") low = Math.max(low, predicate.value);
          else if (predicate.operator === "lte") high = Math.min(high, predicate.value);
          else if (predicate.operator === "between") { low = Math.max(low, predicate.value[0]); high = Math.min(high, predicate.value[1]); }
        }
        if (Number.isNaN(equality) || low > high || equality !== null && (typeof equality !== "number" || equality < low || equality > high)) return null;
        value = equality ?? (Number.isFinite(low) ? low : Number.isFinite(high) ? high : 0);
      } else {
        value = group[0].value;
        if (group.some((predicate) => predicate.value !== value)) return null;
      }
      const facet = { facetId, value, ...(unitId === void 0 ? {} : { unitId }) };
      if (validateGovernedFacetValueRuntime(facet).length || group.some((predicate) => !governedFacetSatisfiesRuntime(facet, predicate))) return null;
      facets.push(facet);
    }
    return facets.sort((left, right) => compare(left.facetId, right.facetId));
  } catch { return null; }
}

function assemblyResourceAssertionHashRuntime(value) {
  try {
    if (!record(value) || value.checkType !== "resource" || checkErrors(value).length > 0) return null;
    const check = normalizeCheck(value);
    return requirementArtifactContentHashRuntime({
      resourceId: check.resourceId,
      ownerInstanceId: check.ownerInstanceId,
      role: check.role,
      kind: check.kind,
      predicates: check.predicates,
      quantity: check.quantity,
      state: check.state,
    }, "assembly-resource-assertion-v1");
  } catch { return null; }
}
function assemblyCheckAssertionHashRuntime(value) {
  try {
    if (!record(value) || checkErrors(value).length > 0) return null;
    const normalized = normalizeCheck(value);
    const { factIds: _factIds, observationIds: _observationIds, ...semantic } = normalized;
    return requirementArtifactContentHashRuntime(semantic, "assembly-check-assertion-v1");
  } catch { return null; }
}
function projectVerifiedAssemblySuppliesRuntime(value) {
  if (validateAssemblySafetyEvaluationRuntime(value).length) return null;
  const supplies = [];
  const decisions = new Map(value.decisions.map((decision2) => [decision2.decisionId, decision2]));
  for (const check of value.checks) {
    const decision2 = decisions.get(`decision.assembly.${value.assemblyId}.${check.checkId}`);
    if (decision2?.verdict !== "pass" || check.observationIds.length === 0) continue;
    const prefix = `requirement.assembly.${value.assemblyId}.${check.checkId}`;
    if (check.checkType === "resource") {
      const facets = concreteFacets(check.predicates);
      if (facets === null) return null;
      supplies.push({
        source: "user_resource",
        refId: `assembly-resource.${check.ownerInstanceId}.${check.resourceId}`,
        ownerInstanceId: check.ownerInstanceId,
        kind: check.kind,
        facets,
        quantity: check.quantity,
        availability: "present_verified",
        verificationStatus: "verified",
        satisfiesBefore: check.requiredBefore,
        evidenceRefs: [...check.factIds],
        observationRefs: check.observationIds.map((id2) => `observation:${id2}`).sort(compare)
      });
      continue;
    }
    const ownedRequirementIds = check.checkType === "standoff_layout"
      ? new Set([`${prefix}.standoffs`, `${prefix}.layout-checkpoint`])
      : new Set([prefix]);
    for (const requirement2 of value.requirements.filter((node2) => ownedRequirementIds.has(node2.requirementId))) {
      const facets = concreteFacets(requirement2.predicates);
      if (facets === null) return null;
      const suffix = requirement2.requirementId.slice(prefix.length).replace(/^\./u, "") || "check";
      const standoffPhysicalHash = check.checkType === "standoff_layout" && suffix === "standoffs"
        ? requirementArtifactContentHashRuntime({
          ownerInstanceId: check.ownerInstanceId,
          expectedPositionIds: check.expectedPositionIds,
          expectedThread: check.expectedThread,
          expectedHeightMm: check.expectedHeightMm,
        }, "assembly-standoff-resource-v1") : null;
      supplies.push({
        source: "user_resource",
        refId: standoffPhysicalHash === null
          ? `assembly-observation.${value.assemblyId}.${check.checkId}.${suffix}`
          : `assembly-standoffs.${check.ownerInstanceId}.sha256-${standoffPhysicalHash}`,
        ownerInstanceId: check.ownerInstanceId,
        kind: requirement2.kind,
        facets,
        quantity: requirement2.quantity,
        availability: "present_verified",
        verificationStatus: "verified",
        ...(requirement2.requiredBefore === void 0 ? {} : { satisfiesBefore: requirement2.requiredBefore }),
        evidenceRefs: [...check.factIds],
        observationRefs: check.observationIds.map((id2) => `observation:${id2}`).sort(compare)
      });
    }
  }
  return Object.freeze(supplies.sort((left, right) => compare(`${left.ownerInstanceId}\0${left.refId}`, `${right.ownerInstanceId}\0${right.refId}`)).map(Object.freeze));
}

function projectedSupplyKey(value) {
  return `${value.source}\0${value.ownerInstanceId ?? ""}\0${value.refId}`;
}

function sameProjectedSupply(left, right) {
  const leftHash = requirementArtifactContentHashRuntime({ supply: left }, "generated-requirement-supply-closure-v1");
  const rightHash = requirementArtifactContentHashRuntime({ supply: right }, "generated-requirement-supply-closure-v1");
  return leftHash !== null && leftHash === rightHash;
}

/**
 * Close every supply emitted by the current progressive composition to its
 * only generators: locked package manifests and strict-replayed assembly
 * observations. Component/purchase supplies remain forbidden until an
 * explicit external inventory/procurement authority is added to the context.
 */
function validateRequirementAllocationGeneratedSupplyClosureRuntime(value, context) {
  try {
    const errors = validateRequirementAllocationResultRuntime(value);
    if (!record(context) || !exact(context, ["packageBindings", "assemblyEvaluations"]) || !Array.isArray(context.packageBindings)
      || !Array.isArray(context.assemblyEvaluations)) {
      return [...errors, "generated requirement supply closure context invalid"];
    }
    errors.push(...validateRequirementAllocationPackageClosureRuntime(value, context.packageBindings)
      .map((error) => `generated package supply closure: ${error}`));

    const expectedPackageKeys = [];
    for (const binding of context.packageBindings) {
      if (!record(binding) || !id(binding.ownerInstanceId) || !record(binding.manifest) || !Array.isArray(binding.manifest.bundleItems)) continue;
      expectedPackageKeys.push(...binding.manifest.bundleItems.map((item) => `package_content\0${binding.ownerInstanceId}\0${item?.bundleItemId ?? ""}`));
    }
    expectedPackageKeys.sort(compare);
    const packageSupplies = value?.supplies?.filter((supply) => supply.source === "package_content") ?? [];
    const actualPackageKeys = packageSupplies.map(projectedSupplyKey).sort(compare);
    if (new Set(expectedPackageKeys).size !== expectedPackageKeys.length
      || JSON.stringify(actualPackageKeys) !== JSON.stringify(expectedPackageKeys)) {
      errors.push("generated package supplies differ from locked manifest projection cardinality");
    }
    for (const supply of packageSupplies) {
      if (supply.availability !== "planned" || supply.verificationStatus !== "unverified"
        || supply.satisfiesBefore !== undefined || supply.observationRefs.length !== 0) {
        errors.push(`generated package supply has unbound availability assertion: ${supply.ownerInstanceId}/${supply.refId}`);
      }
    }

    const expectedUserSupplies = [];
    const assemblyIds = new Set();
    const standoffPositionKeys = new Set();
    const nonResourceSemanticKeys = new Set();
    const nonResourceObservationIdsBySemantic = new Map();
    for (const [index, evaluation] of context.assemblyEvaluations.entries()) {
      const evaluationErrors = validateAssemblySafetyEvaluationRuntime(evaluation);
      if (evaluationErrors.length > 0) {
        errors.push(...evaluationErrors.map((error) => `assemblyEvaluations.${index}: ${error}`));
        continue;
      }
      if (assemblyIds.has(evaluation.assemblyId)) errors.push(`assembly evaluation duplicated: ${evaluation.assemblyId}`);
      assemblyIds.add(evaluation.assemblyId);
      const decisions = new Map(evaluation.decisions.map((decision2) => [decision2.decisionId, decision2]));
      for (const check of evaluation.checks) {
        const decision2 = decisions.get(`decision.assembly.${evaluation.assemblyId}.${check.checkId}`);
        if (decision2?.verdict !== "pass" || check.observationIds.length === 0 || check.checkType === "resource") continue;
        const semanticHash = assemblyCheckAssertionHashRuntime(check);
        if (semanticHash !== null) {
          const semanticKey = `${check.ownerInstanceId}\0${semanticHash}`;
          if (nonResourceSemanticKeys.has(semanticKey)) {
            errors.push(`assembly projected check repeats an owner/semantic assertion: ${semanticKey}`);
          } else nonResourceSemanticKeys.add(semanticKey);
          const priorObservationIds = nonResourceObservationIdsBySemantic.get(semanticKey) ?? new Set();
          for (const observationId of check.observationIds) {
            if (priorObservationIds.has(observationId)) {
              errors.push(`assembly projected check reuses an observation for the same semantic assertion: ${observationId}`);
            } else priorObservationIds.add(observationId);
          }
          nonResourceObservationIdsBySemantic.set(semanticKey, priorObservationIds);
        }
        if (check.checkType === "standoff_layout") {
          const positions = new Set([
            ...check.expectedPositionIds,
            ...(check.observed ?? []).map((entry) => entry.positionId),
          ]);
          for (const positionId of positions) {
            const positionKey = `${check.ownerInstanceId}\0${positionId}`;
            if (standoffPositionKeys.has(positionKey)) {
              errors.push(`assembly projected standoff repeats a physical owner/position: ${positionKey}`);
            } else standoffPositionKeys.add(positionKey);
          }
        }
      }
      const projected = projectVerifiedAssemblySuppliesRuntime(evaluation);
      if (projected === null) errors.push(`assembly supply projection failed: ${evaluation.assemblyId}`);
      else expectedUserSupplies.push(...projected);
    }
    expectedUserSupplies.sort((left, right) => compare(projectedSupplyKey(left), projectedSupplyKey(right)));
    const expectedUserByKey = new Map();
    for (const supply of expectedUserSupplies) {
      const key = projectedSupplyKey(supply);
      if (expectedUserByKey.has(key)) errors.push(`assembly projected supply duplicated: ${key}`);
      expectedUserByKey.set(key, supply);
    }
    const actualUserSupplies = (value?.supplies ?? []).filter((supply) => supply.source === "user_resource");
    const actualUserKeys = actualUserSupplies.map(projectedSupplyKey).sort(compare);
    const expectedUserKeys = [...expectedUserByKey.keys()].sort(compare);
    if (JSON.stringify(actualUserKeys) !== JSON.stringify(expectedUserKeys)) {
      errors.push("user-resource supplies differ from strict assembly observation projection");
    }
    for (const supply of actualUserSupplies) {
      const expected = expectedUserByKey.get(projectedSupplyKey(supply));
      if (expected === undefined || !sameProjectedSupply(supply, expected)) {
        errors.push(`user-resource supply differs from assembly authority: ${projectedSupplyKey(supply)}`);
      }
    }
    for (const supply of value?.supplies ?? []) {
      if (supply.source === "component" || supply.source === "purchase") {
        errors.push(`requirement supply source lacks locked generator authority: ${projectedSupplyKey(supply)}`);
      }
    }
    return [...new Set(errors)];
  } catch {
    return ["generated requirement supply closure validation failed closed"];
  }
}
export {
  assemblyCheckAssertionHashRuntime,
  assemblyResourceAssertionHashRuntime,
  assemblySafetyReferencesRuntime,
  evaluateAssemblySafety,
  evaluateAssemblySafety as evaluateAssemblySafetyRuntime,
  projectVerifiedAssemblySuppliesRuntime,
  validateRequirementAllocationGeneratedSupplyClosureRuntime,
  validateAssemblySafetyEvaluationRuntime,
  validateAssemblySafetyInput
};
