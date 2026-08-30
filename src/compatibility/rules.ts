import type { ComponentKindId } from "../contracts/registries";
import type { FactRecord } from "../facts/contracts";
import type { EvaluationDecision, RequirementNode } from "../requirements/contracts";
import type { ComponentInstance } from "../topology/contracts";
import type {
  CompatibilityRuleContext,
  CompatibilityRuleDefinition,
  CompatibilityRuleManifestEntry,
  GovernedCompatibilityRule,
} from "./contracts";
import { compatibilityRuleDefinitionHash } from "./contracts";
import {
  BUILTIN_COMPATIBILITY_RULE_MANIFEST_HASH_RUNTIME,
  compatibilityRuleManifestHashRuntime,
} from "./runtime.mjs";
import { compatibilityDecision, compatibilityRequirement } from "./explain";
import { safetyRemediationForKnownFailure } from "./requirements";

const VERSION = "1.0.0";
export const BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS = Object.freeze([
  "compatibility/engine",
  "compatibility/explain",
  "compatibility/requirements",
  "compatibility/rules",
  "compatibility/runtime",
  "firmware/evaluate",
  "firmware/fixed-point",
  "firmware/fixed-point-runtime",
  "firmware/runtime",
  "requirements/allocation",
  "requirements/assembly-safety-runtime",
  "requirements/closure",
  "requirements/patterns",
  "requirements/runtime",
  "simulation/evaluate",
  "thermal/airflow-graph",
  "thermal/fan-operating-point",
  "thermal/steady-state",
  "acoustics/aggregate",
  "acoustics/operating-point",
].sort((left, right) => left.localeCompare(right)));

function definition(input: Omit<CompatibilityRuleDefinition, "schemaVersion" | "ruleVersion">): CompatibilityRuleDefinition {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return {
    schemaVersion: "compatibility-rule-definition-v1",
    ruleVersion: VERSION,
    ...input,
    activation: {
      ...input.activation,
      anyComponentKinds: [...new Set(input.activation.anyComponentKinds)].sort(compare),
    },
    requiredInputs: {
      componentKinds: [...input.requiredInputs.componentKinds].sort((left, right) => compare(left.componentKind, right.componentKind)),
      facts: [...input.requiredInputs.facts].sort((left, right) => compare(`${left.componentKind}:${left.field}`, `${right.componentKind}:${right.field}`)),
      placements: [...input.requiredInputs.placements].sort((left, right) => compare(`${left.componentKind}:${left.mountOwnerKind}`, `${right.componentKind}:${right.mountOwnerKind}`)),
      connections: [...input.requiredInputs.connections].sort((left, right) => compare(`${left.fromKind}:${left.toKind}`, `${right.fromKind}:${right.toKind}`)),
      systemProfile: input.requiredInputs.systemProfile === null ? null : {
        ...input.requiredInputs.systemProfile,
        allowedProfileIds: [...new Set(input.requiredInputs.systemProfile.allowedProfileIds)].sort(compare),
      },
      identityClosure: input.requiredInputs.identityClosure === null ? null : { ...input.requiredInputs.identityClosure },
      nestedEvaluations: { ...input.requiredInputs.nestedEvaluations },
      adapterResources: { ...input.requiredInputs.adapterResources },
      logicalLayouts: input.requiredInputs.logicalLayouts,
    },
  };
}

function components(
  kind: ComponentKindId,
  minCount = 1,
  criticality: RequirementNode["criticality"] = "boot",
  requiredBefore: RequirementNode["requiredBefore"] = criticality === "safety" ? "pre_power" : "first_boot",
) {
  return {
    componentKind: kind,
    minCount,
    missing: { kind: "component" as const, criticality, ...(requiredBefore !== undefined ? { requiredBefore } : {}) },
  };
}

function fact(
  componentKind: ComponentKindId,
  field: string,
  safetyClass: "normal" | "boot" | "electrical_safety",
  minimumScope: "family" | "model" | "variant" | "revision" | "plan_subject" = "variant",
  cardinality: "single" | "many" = "single",
) {
  return {
    componentKind,
    field,
    cardinality,
    safetyClass,
    requiredAuthority: safetyClass === "normal" ? "governed" as const : "official" as const,
    minimumScope,
    missingRequirementKind: safetyClass === "normal" ? "measurement" as const : "evidence" as const,
  };
}

function baseInputs(): CompatibilityRuleDefinition["requiredInputs"] {
  return {
    componentKinds: [], facts: [], placements: [], connections: [], systemProfile: null,
    identityClosure: null,
    nestedEvaluations: { assemblySafety: false, firmwarePaths: false, systemProfileChecks: false, thermalAcoustic: false },
    adapterResources: { resourcePatterns: false, bundleItems: false },
    logicalLayouts: false,
  };
}

function one(context: CompatibilityRuleContext, kind: ComponentKindId): ComponentInstance {
  return context.componentsOfKind(kind)[0]!;
}

function firstFact(context: CompatibilityRuleContext, instance: ComponentInstance, fieldId: string): FactRecord {
  return context.factsFor(instance, fieldId)[0]!;
}

function scalar(value: FactRecord): string | number | boolean {
  if (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean") return value.value;
  throw new TypeError(`rule received non-scalar fact ${value.field}`);
}

function stringSet(value: FactRecord): string[] {
  if (!Array.isArray(value.value) || value.value.some((entry) => typeof entry !== "string")) throw new TypeError(`rule received non-string-set fact ${value.field}`);
  return value.value as string[];
}

function structured(value: FactRecord): Readonly<Record<string, unknown>> {
  if (value.value === null || typeof value.value !== "object" || Array.isArray(value.value)) {
    throw new TypeError(`rule received non-structured fact ${value.field}`);
  }
  return value.value as Readonly<Record<string, unknown>>;
}

function normalizedToken(value: unknown): string {
  return String(value).normalize("NFC").toLowerCase().replaceAll("_", "-");
}

function tokenSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizedToken));
}

function powerConnectorFamily(value: string): "atx24" | "eps" | "gpu" | "peripheral" | null {
  const token = normalizedToken(value);
  if ((token.includes("atx") && token.includes("24")) || token === "atx24") return "atx24";
  if (token.includes("eps")) return "eps";
  if (token.includes("12v-2x6") || token.includes("12vhpwr") || token.includes("pcie")) return "gpu";
  if (token.includes("sata-power") || token.includes("molex") || token.includes("peripheral")) return "peripheral";
  return null;
}

function connectorSupports(interfaceValue: unknown, connectorValue: unknown): boolean {
  const device = normalizedToken(interfaceValue);
  const host = normalizedToken(connectorValue);
  const compactDevice = device.replace(/[^a-z0-9]/gu, "");
  const compactHost = host.replace(/[^a-z0-9]/gu, "");
  const sameFamily = (family: string) => device.includes(family) && host.includes(family);
  if (sameFamily("sata") || sameFamily("slimsas") || sameFamily("sas")) return true;
  if ((device.includes("nvme") || device.includes("m2"))
    && (host.includes("nvme") || host.includes("m2") || host.includes("slimsas"))) {
    const requiredKey = ["key-b", "key-m", "key-bm"].find((token) => device.includes(token));
    if (requiredKey !== undefined && !host.includes(requiredKey)) return false;
    const requiredLength = ["2230", "2242", "2260", "2280", "22110"].find((token) => device.includes(token));
    return requiredLength === undefined || host.includes(requiredLength);
  }
  return compactDevice.length > 0 && compactHost.length > 0
    && (compactDevice.includes(compactHost) || compactHost.includes(compactDevice));
}

function headerFamily(value: unknown): "usb-c" | "usb" | "audio" | "fan" | "pump" | "argb" | "rgb" | null {
  const token = normalizedToken(value);
  if (token.includes("usb-c") || token.includes("type-c") || token.includes("type-e")) return "usb-c";
  if (token.includes("usb")) return "usb";
  if (token.includes("audio") || token.includes("hda")) return "audio";
  if (token.includes("pump")) return "pump";
  if (token.includes("argb") || (token.includes("rgb") && token.includes("5v"))) return "argb";
  if (token.includes("rgb")) return "rgb";
  if (token.includes("fan") || token.includes("pwm")) return "fan";
  return null;
}

function topologyFacts(
  context: CompatibilityRuleContext,
  instance: ComponentInstance,
): Array<{ fact: FactRecord; endpointId: string; connectorType: string; location: string; pathId: string; quantity: number }> {
  return context.factsFor(instance, "io.port_topology").map((candidate) => {
    const value = structured(candidate);
    if (typeof value.endpointId !== "string" || typeof value.connectorType !== "string"
      || typeof value.location !== "string" || typeof value.pathId !== "string"
      || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 1) {
      throw new TypeError("rule received invalid governed I/O topology");
    }
    return {
      fact: candidate,
      endpointId: value.endpointId,
      connectorType: normalizedToken(value.connectorType),
      location: value.location,
      pathId: value.pathId,
      quantity: Number(value.quantity),
    };
  });
}

function replacementRequirement(
  rule: CompatibilityRuleDefinition,
  discriminator: string,
  instances: readonly ComponentInstance[],
  kind: ComponentKindId,
): RequirementNode {
  return safetyRemediationForKnownFailure(
    rule,
    discriminator,
    instances.map(({ instanceId }) => instanceId),
    kind,
  );
}

function explicitRequirement(input: {
  rule: CompatibilityRuleDefinition;
  discriminator: string;
  kind: RequirementNode["kind"];
  criticality?: RequirementNode["criticality"];
  requiredBefore?: RequirementNode["requiredBefore"];
  instances?: readonly ComponentInstance[];
  evidenceRefs?: string[];
}): RequirementNode {
  return compatibilityRequirement({
    ruleId: input.rule.ruleId,
    ruleVersion: input.rule.ruleVersion,
    discriminator: input.discriminator,
    kind: input.kind,
    criticality: input.criticality ?? (input.rule.safetyClass === "electrical_safety" ? "safety" : input.rule.safetyClass === "boot" ? "boot" : "normal"),
    ...(input.requiredBefore !== undefined ? { requiredBefore: input.requiredBefore }
      : input.rule.safetyClass === "electrical_safety" ? { requiredBefore: "pre_power" as const }
        : input.rule.safetyClass === "boot" ? { requiredBefore: "first_boot" as const } : {}),
    instanceIds: input.instances?.map(({ instanceId }) => instanceId) ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
  });
}

function result(decisions: EvaluationDecision[], requirements: RequirementNode[] = []) {
  return { decisions, requirements };
}

function aggregateDecisionVerdicts(decisions: readonly EvaluationDecision[]): EvaluationDecision["verdict"] {
  if (decisions.some(({ verdict }) => verdict === "fail")) return "fail";
  if (decisions.some(({ verdict }) => verdict === "blocked")) return "blocked";
  return "pass";
}

const coreProfileDefinition = definition({
  ruleId: "compat.core-profile",
  domain: "identity",
  description: "Every host profile declares the minimum ordinary assembly, power, and boot component roles.",
  safetyClass: "boot",
  activation: { topology: "always", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [
      components("case", 1, "boot", "assembly"), components("motherboard", 1, "boot", "assembly"),
      components("cpu"), components("memory_module"), components("psu", 1, "safety", "pre_power"),
      components("cpu_cooler"), components("storage_drive"),
    ],
  },
});

const coreProfileRule: GovernedCompatibilityRule = {
  definition: coreProfileDefinition,
  evaluate: (context) => result([compatibilityDecision({
    ruleId: coreProfileDefinition.ruleId,
    ruleVersion: coreProfileDefinition.ruleVersion,
    discriminator: "minimum-roles-present",
    verdict: "pass",
    domain: coreProfileDefinition.domain,
    message: "The minimum ordinary component roles for the evaluated host subgraph are present.",
    instanceIds: context.components.map(({ instanceId }) => instanceId),
  })]),
};

const identityDefinition = definition({
  ruleId: "compat.identity-closure",
  domain: "identity",
  description: "Every present component retains claim-level identity evidence; unresolved identity stays blocked.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    identityClosure: { allPresentComponents: true, safetyClass: "boot", missingRequirementKind: "evidence" },
  },
});

const identityRule: GovernedCompatibilityRule = {
  definition: identityDefinition,
  evaluate: (context) => {
    const decisions: EvaluationDecision[] = [];
    const requirements: RequirementNode[] = [];
    for (const component of context.components) {
      const claimFacts = context.identityFactsFor(component);
      if (component.identity.status === "resolved" && claimFacts.length > 0) {
        decisions.push(compatibilityDecision({
          ruleId: identityDefinition.ruleId,
          ruleVersion: identityDefinition.ruleVersion,
          discriminator: component.instanceId,
          verdict: "pass",
          domain: identityDefinition.domain,
          message: `Component ${component.instanceId} has identity evidence in the locked fact closure.`,
          instanceIds: [component.instanceId],
          factIds: claimFacts.map(({ factId }) => factId),
        }));
        continue;
      }
      const requirement = compatibilityRequirement({
        ruleId: identityDefinition.ruleId,
        ruleVersion: identityDefinition.ruleVersion,
        discriminator: `identity-${component.instanceId}`,
        kind: "evidence",
        criticality: "boot",
        requiredBefore: "first_boot",
        instanceIds: [component.instanceId],
      });
      requirements.push(requirement);
      decisions.push(compatibilityDecision({
        ruleId: identityDefinition.ruleId,
        ruleVersion: identityDefinition.ruleVersion,
        discriminator: component.instanceId,
        verdict: "blocked",
        domain: identityDefinition.domain,
        message: `Component ${component.instanceId} identity cannot be proven from the locked claim closure.`,
        instanceIds: [component.instanceId],
        remediation: [requirement],
      }));
    }
    return result(decisions, requirements);
  },
};

const assemblySafetyDefinition = definition({
  ruleId: "compat.assembly-safety",
  domain: "assembly",
  description: "Locked physical checks govern standoffs, resources, power connectors, cooling, film, and loose metal before power.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    nestedEvaluations: { assemblySafety: true, firmwarePaths: false, systemProfileChecks: false, thermalAcoustic: false },
  },
});

const assemblySafetyRule: GovernedCompatibilityRule = {
  definition: assemblySafetyDefinition,
  evaluate: (context) => {
    if (context.assemblySafetyEvaluations.length === 0) {
      const requirement = compatibilityRequirement({
        ruleId: assemblySafetyDefinition.ruleId,
        ruleVersion: assemblySafetyDefinition.ruleVersion,
        discriminator: "locked-physical-checks",
        kind: "measurement",
        criticality: "safety",
        requiredBefore: "pre_power",
        instanceIds: context.components.map(({ instanceId }) => instanceId),
      });
      return result([compatibilityDecision({
        ruleId: assemblySafetyDefinition.ruleId,
        ruleVersion: assemblySafetyDefinition.ruleVersion,
        discriminator: "missing",
        verdict: "blocked",
        domain: assemblySafetyDefinition.domain,
        message: "The locked assembly and first-power observation set is unavailable.",
        instanceIds: context.components.map(({ instanceId }) => instanceId),
        remediation: [requirement],
      })], [requirement]);
    }
    const nestedDecisions = context.assemblySafetyEvaluations.flatMap(({ decisions }) => decisions);
    const verdict = aggregateDecisionVerdicts(nestedDecisions);
    const remediation = context.assemblySafetyEvaluations.flatMap(({ requirements }) => requirements)
      .filter((requirement) => nestedDecisions.some((decision) => decision.verdict !== "pass"
        && decision.remediation.some(({ requirementId }) => requirementId === requirement.requirementId)));
    return result([compatibilityDecision({
      ruleId: assemblySafetyDefinition.ruleId,
      ruleVersion: assemblySafetyDefinition.ruleVersion,
      discriminator: "aggregate",
      verdict,
      domain: assemblySafetyDefinition.domain,
      message: verdict === "pass" ? "All locked assembly and first-power checks pass."
        : verdict === "fail" ? "A known assembly or first-power safety error must be corrected."
          : "An assembly or first-power safety observation is missing.",
      instanceIds: nestedDecisions.flatMap(({ instanceIds }) => instanceIds),
      factIds: nestedDecisions.flatMap(({ factIds }) => factIds),
      assumptions: nestedDecisions.flatMap(({ assumptions }) => assumptions),
      remediation,
    })]);
  },
};

const adapterResourceDefinition = definition({
  ruleId: "compat.adapter-resource-closure",
  domain: "assembly",
  description: "Locked adapter mount patterns and instance-scoped package contents participate in requirement fixed-point and allocation.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["case"] },
  requiredInputs: {
    ...baseInputs(),
    adapterResources: { resourcePatterns: true, bundleItems: true },
  },
});

const adapterResourceRule: GovernedCompatibilityRule = {
  definition: adapterResourceDefinition,
  evaluate: () => result([compatibilityDecision({
    ruleId: adapterResourceDefinition.ruleId,
    ruleVersion: adapterResourceDefinition.ruleVersion,
    discriminator: "locked-projection",
    verdict: "pass",
    domain: adapterResourceDefinition.domain,
    message: "Locked adapter resource patterns are available to the authoritative fixed-point projection.",
  })]),
};

const firmwarePathDefinition = definition({
  ruleId: "compat.firmware-path",
  domain: "firmware",
  description: "Every explicit locked firmware target must have a replayed executable update, recovery, and settings path.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    nestedEvaluations: { assemblySafety: false, firmwarePaths: true, systemProfileChecks: false, thermalAcoustic: false },
  },
});

const firmwarePathRule: GovernedCompatibilityRule = {
  definition: firmwarePathDefinition,
  evaluate: (context) => {
    if (context.firmwareTargets.length === 0) return result([compatibilityDecision({
      ruleId: firmwarePathDefinition.ruleId,
      ruleVersion: firmwarePathDefinition.ruleVersion,
      discriminator: "not-requested",
      verdict: "pass",
      domain: firmwarePathDefinition.domain,
      message: "No explicit firmware transition target is requested.",
    })]);
    if (context.firmwareEvaluations.length !== context.firmwareTargets.length) {
      const requirement = compatibilityRequirement({
        ruleId: firmwarePathDefinition.ruleId,
        ruleVersion: firmwarePathDefinition.ruleVersion,
        discriminator: "locked-capability-path",
        kind: "evidence",
        criticality: "boot",
        requiredBefore: "first_boot",
        instanceIds: context.firmwareTargets.map(({ instanceId }) => instanceId),
      });
      return result([compatibilityDecision({
        ruleId: firmwarePathDefinition.ruleId,
        ruleVersion: firmwarePathDefinition.ruleVersion,
        discriminator: "missing",
        verdict: "blocked",
        domain: firmwarePathDefinition.domain,
        message: "A locked executable firmware capability/path is missing for an explicit target.",
        instanceIds: context.firmwareTargets.map(({ instanceId }) => instanceId),
        remediation: [requirement],
      })], [requirement]);
    }
    const verdict = context.firmwareEvaluations.some(({ verdict: candidate }) => candidate === "blocked") ? "blocked" : "pass";
    const remediation = context.firmwareEvaluations.flatMap(({ derivedRequirements }) => derivedRequirements);
    return result([compatibilityDecision({
      ruleId: firmwarePathDefinition.ruleId,
      ruleVersion: firmwarePathDefinition.ruleVersion,
      discriminator: "aggregate",
      verdict,
      domain: firmwarePathDefinition.domain,
      message: verdict === "pass" ? "Every explicit firmware target has an executable locked path."
        : "A firmware transition prerequisite, recovery path, or current-version observation is missing.",
      instanceIds: context.firmwareEvaluations.map(({ instanceId }) => instanceId),
      factIds: context.firmwareEvaluations.flatMap(({ selectedTransitions, missingPowerPrerequisiteFactIds }) => [
        ...missingPowerPrerequisiteFactIds,
        ...selectedTransitions.flatMap((transition) => transition.sourceFactIds),
      ]),
      assumptions: context.firmwareEvaluations.flatMap(({ assumptions }) => assumptions),
      remediation,
    })]);
  },
};

const cpuFirmwareSupportDefinition = definition({
  ruleId: "compat.cpu-chipset-firmware-support",
  domain: "firmware",
  description: "The exact board revision/chipset must carry an official CPU support entry and minimum firmware release.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["cpu", "motherboard"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("cpu"), components("motherboard")],
    facts: [
      fact("motherboard", "firmware.cpu_support", "boot", "revision", "many"),
      fact("motherboard", "motherboard.chipset", "boot"),
    ],
  },
});

const cpuFirmwareSupportRule: GovernedCompatibilityRule = {
  definition: cpuFirmwareSupportDefinition,
  evaluate: (context) => {
    const cpu = one(context, "cpu");
    const board = one(context, "motherboard");
    if (cpu.identity.status !== "resolved") throw new TypeError("CPU identity is unresolved");
    const cpuSkuId = cpu.identity.skuId;
    const supportFacts = context.factsFor(board, "firmware.cpu_support");
    const chipset = firstFact(context, board, "motherboard.chipset");
    const matching = supportFacts.filter((candidate) => structured(candidate).cpuSkuId === cpuSkuId);
    const supported = matching.length > 0;
    const remediation = supported ? [] : [replacementRequirement(cpuFirmwareSupportDefinition, "supported-cpu", [cpu, board], "cpu")];
    return result([compatibilityDecision({
      ruleId: cpuFirmwareSupportDefinition.ruleId,
      ruleVersion: cpuFirmwareSupportDefinition.ruleVersion,
      discriminator: `${board.instanceId}-${cpu.instanceId}`,
      verdict: supported ? "pass" : "fail",
      domain: cpuFirmwareSupportDefinition.domain,
      message: supported
        ? `The exact board revision has an official CPU support entry on chipset ${String(scalar(chipset))}.`
        : "The official support table for this exact board revision does not contain the selected CPU.",
      instanceIds: [board.instanceId, cpu.instanceId],
      factIds: [chipset.factId, ...supportFacts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const memoryPopulationDefinition = definition({
  ruleId: "compat.memory-population",
  domain: "electrical",
  description: "DIMM count, capacity, DDR generation, UDIMM/RDIMM, ECC and rank tokens must satisfy the board population rules.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["memory_module"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard"), components("memory_module")],
    facts: [
      fact("motherboard", "motherboard.memory_slot_count", "boot"),
      fact("motherboard", "motherboard.memory_population_rules", "boot"),
      fact("memory_module", "memory.capacity", "boot"),
      fact("memory_module", "memory.type", "boot"),
    ],
  },
});

function numberToken(values: readonly string[], prefix: string): number | null {
  const raw = values.find((value) => normalizedToken(value).startsWith(prefix));
  if (raw === undefined) return null;
  const parsed = Number(normalizedToken(raw).slice(prefix.length));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const memoryPopulationRule: GovernedCompatibilityRule = {
  definition: memoryPopulationDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const memories = context.componentsOfKind("memory_module");
    const slots = firstFact(context, board, "motherboard.memory_slot_count");
    const rulesFact = firstFact(context, board, "motherboard.memory_population_rules");
    const rules = stringSet(rulesFact).map(normalizedToken);
    const memoryFacts = memories.flatMap((memory) => [
      firstFact(context, memory, "memory.type"), firstFact(context, memory, "memory.capacity"),
    ]);
    const types = memories.map((memory) => normalizedToken(scalar(firstFact(context, memory, "memory.type"))));
    const totalCapacity = memories.reduce((sum, memory) => sum + Number(scalar(firstFact(context, memory, "memory.capacity"))), 0);
    const allowedCounts = rules.filter((entry) => entry.startsWith("count:")).map((entry) => Number(entry.slice(6))).filter(Number.isSafeInteger);
    const maxCapacity = numberToken(rules, "max-capacity-gib:");
    const requiredTokens = rules.filter((entry) => ["udimm", "rdimm", "ecc", "non-ecc"].includes(entry));
    const violations: string[] = [];
    if (memories.length > Number(scalar(slots))) violations.push("installed DIMM count exceeds the board slot count");
    if (allowedCounts.length > 0 && !allowedCounts.includes(memories.length)) violations.push("installed DIMM count is not an allowed population");
    if (maxCapacity !== null && totalCapacity > maxCapacity) violations.push("installed memory capacity exceeds the governed maximum");
    for (const token of requiredTokens) if (types.some((value) => !value.includes(token))) violations.push(`memory type does not satisfy ${token}`);
    const rankMaximum = numberToken(rules, "max-rank:");
    if (rankMaximum !== null && types.some((value) => {
      const match = /(?:^|[-+])([1-9][0-9]*)r(?:$|[-+])/u.exec(value);
      return match !== null && Number(match[1]) > rankMaximum;
    })) violations.push("memory rank exceeds the governed population maximum");
    const remediation = violations.length === 0 ? [] : [replacementRequirement(memoryPopulationDefinition, "compatible-memory-kit", [board, ...memories], "memory_module")];
    return result([compatibilityDecision({
      ruleId: memoryPopulationDefinition.ruleId,
      ruleVersion: memoryPopulationDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict: violations.length === 0 ? "pass" : "fail",
      domain: memoryPopulationDefinition.domain,
      message: violations.length === 0 ? "The governed DIMM population, capacity, type, ECC and rank constraints are satisfied." : violations.join("; "),
      instanceIds: [board.instanceId, ...memories.map(({ instanceId }) => instanceId)],
      factIds: [slots.factId, rulesFact.factId, ...memoryFacts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const memoryQvlDefinition = definition({
  ruleId: "compat.memory-imc-qvl",
  domain: "electrical",
  description: "Every selected memory SKU must appear in both exact-board and CPU memory-controller qualification evidence.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["memory_module"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("cpu"), components("motherboard"), components("memory_module")],
    facts: [
      fact("cpu", "compatibility.qvl_entry", "boot", "revision", "many"),
      fact("motherboard", "compatibility.qvl_entry", "boot", "revision", "many"),
    ],
  },
});

const memoryQvlRule: GovernedCompatibilityRule = {
  definition: memoryQvlDefinition,
  evaluate: (context) => {
    const cpu = one(context, "cpu");
    const board = one(context, "motherboard");
    const memories = context.componentsOfKind("memory_module");
    const boardFacts = context.factsFor(board, "compatibility.qvl_entry");
    const cpuFacts = context.factsFor(cpu, "compatibility.qvl_entry");
    const boardSkus = new Set(boardFacts.map((candidate) => String(structured(candidate).componentSkuId)));
    const cpuSkus = new Set(cpuFacts.map((candidate) => String(structured(candidate).componentSkuId)));
    const unqualified = memories.filter((memory) => {
      if (memory.identity.status !== "resolved") return true;
      return !boardSkus.has(memory.identity.skuId) || !cpuSkus.has(memory.identity.skuId);
    });
    const remediation = unqualified.length === 0 ? [] : [replacementRequirement(memoryQvlDefinition, "qualified-memory", [cpu, board, ...unqualified], "memory_module")];
    return result([compatibilityDecision({
      ruleId: memoryQvlDefinition.ruleId,
      ruleVersion: memoryQvlDefinition.ruleVersion,
      discriminator: `${board.instanceId}-${cpu.instanceId}`,
      verdict: unqualified.length === 0 ? "pass" : "fail",
      domain: memoryQvlDefinition.domain,
      message: unqualified.length === 0 ? "Every selected memory SKU has exact-board and CPU IMC qualification evidence." : "At least one selected memory SKU is absent from board or CPU IMC qualification evidence.",
      instanceIds: [board.instanceId, cpu.instanceId, ...memories.map(({ instanceId }) => instanceId)],
      factIds: [...boardFacts, ...cpuFacts].map(({ factId }) => factId),
      remediation,
    })], remediation);
  },
};

const PCIE_CARD_KINDS = Object.freeze([
  "gpu", "hba", "nic", "capture_card", "expansion_board", "pcie_card",
] as const);

const pcieTopologyDefinition = definition({
  ruleId: "compat.pcie-topology",
  domain: "routing",
  description: "Every expansion card needs a declared board connection and case placement with compatible slot, lane, bifurcation and sharing authority.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: [...PCIE_CARD_KINDS] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal", "assembly"), components("motherboard")],
    facts: [
      fact("motherboard", "pcie.lane_count", "boot"),
      fact("motherboard", "pcie.lane_sharing", "boot"),
      fact("motherboard", "pcie.slot_types", "boot"),
      ...PCIE_CARD_KINDS.flatMap((kind) => [fact(kind, "pcie.lane_count", "boot"), fact(kind, "pcie.slot_types", "boot")]),
    ],
    placements: PCIE_CARD_KINDS.map((componentKind) => ({ componentKind, mountOwnerKind: "case" as const, minCount: 1 })),
    connections: PCIE_CARD_KINDS.map((toKind) => ({ fromKind: "motherboard" as const, toKind, minCount: 1, cableRequired: false })),
  },
});

const pcieTopologyRule: GovernedCompatibilityRule = {
  definition: pcieTopologyDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const chassis = one(context, "case");
    const cards = PCIE_CARD_KINDS.flatMap((kind) => [...context.componentsOfKind(kind)]);
    const boardLanes = firstFact(context, board, "pcie.lane_count");
    const boardSlotsFact = firstFact(context, board, "pcie.slot_types");
    const sharingFact = firstFact(context, board, "pcie.lane_sharing");
    const boardSlots = tokenSet(stringSet(boardSlotsFact));
    const sharing = tokenSet(stringSet(sharingFact));
    const cardFacts = cards.flatMap((card) => [firstFact(context, card, "pcie.lane_count"), firstFact(context, card, "pcie.slot_types")]);
    const totalLanes = cards.reduce((sum, card) => sum + Number(scalar(firstFact(context, card, "pcie.lane_count"))), 0);
    const violations: string[] = [];
    const topologyGaps: ComponentInstance[] = [];
    if (totalLanes > Number(scalar(boardLanes))) violations.push("aggregate card lane demand exceeds the governed board lane budget");
    for (const card of cards) {
      const requiredSlots = stringSet(firstFact(context, card, "pcie.slot_types")).map(normalizedToken);
      const baseSlots = requiredSlots.filter((token) => !token.startsWith("bifurcation:"));
      if (baseSlots.length > 0 && !baseSlots.some((token) => boardSlots.has(token))) violations.push(`${card.instanceId} has no compatible physical slot type`);
      for (const token of requiredSlots.filter((entry) => entry.startsWith("bifurcation:"))) {
        if (!sharing.has(token) && !boardSlots.has(token)) violations.push(`${card.instanceId} requires unsupported ${token}`);
      }
      const connected = context.connections.some((connection) => connection.from.instanceId === card.instanceId || connection.to.instanceId === card.instanceId);
      const placed = context.placements.some((placement) => placement.componentInstanceId === card.instanceId && placement.mountOwnerInstanceId === chassis.instanceId);
      if (!connected || !placed) topologyGaps.push(card);
      const boardEndpoint = context.connections.flatMap((connection) => {
        if (connection.from.instanceId === board.instanceId && connection.to.instanceId === card.instanceId) return [connection.from.portId];
        if (connection.to.instanceId === board.instanceId && connection.from.instanceId === card.instanceId) return [connection.to.portId];
        return [];
      })[0];
      if (boardEndpoint !== undefined && (sharing.has(`unavailable:${normalizedToken(boardEndpoint)}`)
        || sharing.has(`shared-disabled:${normalizedToken(boardEndpoint)}`))) violations.push(`${card.instanceId} uses a disabled shared lane endpoint`);
    }
    const requirements: RequirementNode[] = [];
    if (violations.length > 0) requirements.push(replacementRequirement(pcieTopologyDefinition, "compatible-expansion-card", [board, chassis, ...cards], cards[0]?.kind ?? "pcie_card"));
    if (topologyGaps.length > 0) requirements.push(explicitRequirement({
      rule: pcieTopologyDefinition,
      discriminator: "expansion-placement-and-connection",
      kind: "user_decision",
      instances: [board, chassis, ...topologyGaps],
    }));
    const verdict = violations.length > 0 ? "fail" : topologyGaps.length > 0 ? "blocked" : "pass";
    return result([compatibilityDecision({
      ruleId: pcieTopologyDefinition.ruleId,
      ruleVersion: pcieTopologyDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict,
      domain: pcieTopologyDefinition.domain,
      message: violations.length > 0 ? violations.join("; ")
        : topologyGaps.length > 0 ? "At least one expansion card lacks an explicit board connection or case placement."
          : "Expansion card slot, lane, bifurcation, sharing and placement constraints are satisfied.",
      instanceIds: [board.instanceId, chassis.instanceId, ...cards.map(({ instanceId }) => instanceId)],
      factIds: [boardLanes.factId, boardSlotsFact.factId, sharingFact.factId, ...cardFacts.map(({ factId }) => factId)],
      remediation: requirements,
    })], requirements);
  },
};

function equalityRule(input: {
  definition: CompatibilityRuleDefinition;
  leftKind: ComponentKindId;
  leftField: string;
  rightKind: ComponentKindId;
  rightField: string;
  failureComponentKind: ComponentKindId;
  label: string;
}): GovernedCompatibilityRule {
  return {
    definition: input.definition,
    evaluate: (context) => {
      const left = one(context, input.leftKind);
      const right = one(context, input.rightKind);
      const leftFact = firstFact(context, left, input.leftField);
      const rightFact = firstFact(context, right, input.rightField);
      const matches = scalar(leftFact) === scalar(rightFact);
      const remediation = matches ? [] : [safetyRemediationForKnownFailure(
        input.definition,
        `replace-${input.failureComponentKind}`,
        [left.instanceId, right.instanceId],
        input.failureComponentKind,
      )];
      return result([compatibilityDecision({
        ruleId: input.definition.ruleId,
        ruleVersion: input.definition.ruleVersion,
        discriminator: `${left.instanceId}-${right.instanceId}`,
        verdict: matches ? "pass" : "fail",
        domain: input.definition.domain,
        message: matches
          ? `${input.label} match (${String(scalar(leftFact))}).`
          : `${input.label} mismatch: ${String(scalar(leftFact))} versus ${String(scalar(rightFact))}.`,
        instanceIds: [left.instanceId, right.instanceId],
        factIds: [leftFact.factId, rightFact.factId],
        remediation,
      })], remediation);
    },
  };
}

const cpuSocketDefinition = definition({
  ruleId: "compat.cpu-socket",
  domain: "mechanical",
  description: "CPU and motherboard socket keys must match exactly.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["cpu", "motherboard"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("cpu"), components("motherboard")],
    facts: [fact("cpu", "cpu.socket", "boot"), fact("motherboard", "motherboard.cpu_socket", "boot")],
  },
});

const cpuSocketRule = equalityRule({
  definition: cpuSocketDefinition,
  leftKind: "cpu",
  leftField: "cpu.socket",
  rightKind: "motherboard",
  rightField: "motherboard.cpu_socket",
  failureComponentKind: "cpu",
  label: "CPU/socket",
});

const memoryTypeDefinition = definition({
  ruleId: "compat.memory-type",
  domain: "electrical",
  description: "Every memory module type must match the motherboard memory type.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["memory_module", "motherboard"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard"), components("memory_module")],
    facts: [fact("motherboard", "motherboard.memory_type", "boot"), fact("memory_module", "memory.type", "boot")],
  },
});

const memoryTypeRule: GovernedCompatibilityRule = {
  definition: memoryTypeDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const boardFact = firstFact(context, board, "motherboard.memory_type");
    const decisions: EvaluationDecision[] = [];
    const requirements: RequirementNode[] = [];
    for (const memory of context.componentsOfKind("memory_module")) {
      const memoryFact = firstFact(context, memory, "memory.type");
      const matches = scalar(boardFact) === scalar(memoryFact);
      const remediation = matches ? [] : [safetyRemediationForKnownFailure(memoryTypeDefinition, `replace-${memory.instanceId}`, [board.instanceId, memory.instanceId], "memory_module")];
      requirements.push(...remediation);
      decisions.push(compatibilityDecision({
        ruleId: memoryTypeDefinition.ruleId,
        ruleVersion: memoryTypeDefinition.ruleVersion,
        discriminator: `${board.instanceId}-${memory.instanceId}`,
        verdict: matches ? "pass" : "fail",
        domain: memoryTypeDefinition.domain,
        message: matches ? `Memory ${memory.instanceId} matches ${String(scalar(boardFact))}.` : `Memory ${memory.instanceId} uses ${String(scalar(memoryFact))}, but the board requires ${String(scalar(boardFact))}.`,
        instanceIds: [board.instanceId, memory.instanceId],
        factIds: [boardFact.factId, memoryFact.factId],
        remediation,
      }));
    }
    return result(decisions, requirements);
  },
};

const caseBoardDefinition = definition({
  ruleId: "compat.case-board-form-factor",
  domain: "mechanical",
  description: "The case must declare support for the motherboard form factor and the topology must place it in the case.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["case", "motherboard"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal"), components("motherboard")],
    facts: [fact("case", "case.motherboard_form_factors", "normal"), fact("motherboard", "motherboard.form_factor", "normal")],
    placements: [{ componentKind: "motherboard", mountOwnerKind: "case", minCount: 1 }],
  },
});

const caseBoardRule: GovernedCompatibilityRule = {
  definition: caseBoardDefinition,
  evaluate: (context) => {
    const chassis = one(context, "case");
    const board = one(context, "motherboard");
    const caseFact = firstFact(context, chassis, "case.motherboard_form_factors");
    const boardFact = firstFact(context, board, "motherboard.form_factor");
    const matches = stringSet(caseFact).includes(String(scalar(boardFact)));
    const remediation = matches ? [] : [safetyRemediationForKnownFailure(caseBoardDefinition, "replace-case", [chassis.instanceId, board.instanceId], "case")];
    return result([compatibilityDecision({
      ruleId: caseBoardDefinition.ruleId,
      ruleVersion: caseBoardDefinition.ruleVersion,
      discriminator: `${chassis.instanceId}-${board.instanceId}`,
      verdict: matches ? "pass" : "fail",
      domain: caseBoardDefinition.domain,
      message: matches ? "The case supports the selected motherboard form factor." : `The case does not support motherboard form factor ${String(scalar(boardFact))}.`,
      instanceIds: [chassis.instanceId, board.instanceId],
      factIds: [caseFact.factId, boardFact.factId],
      remediation,
    })], remediation);
  },
};

const coolerSocketDefinition = definition({
  ruleId: "compat.cooler-socket-kit",
  domain: "mechanical",
  description: "Every CPU cooler or AIO must include a governed mounting standard matching the board socket kit.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["cpu_cooler", "aio"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard")],
    facts: [
      fact("motherboard", "mount.standard", "boot"),
      fact("cpu_cooler", "mount.standard", "boot"),
      fact("aio", "mount.standard", "boot"),
    ],
  },
});

const coolerSocketRule: GovernedCompatibilityRule = {
  definition: coolerSocketDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const coolers = [...context.componentsOfKind("cpu_cooler"), ...context.componentsOfKind("aio")];
    const boardMount = firstFact(context, board, "mount.standard");
    const facts = coolers.map((cooler) => firstFact(context, cooler, "mount.standard"));
    const incompatible = coolers.filter((cooler) => scalar(firstFact(context, cooler, "mount.standard")) !== scalar(boardMount));
    const remediation = incompatible.length === 0 ? [] : [replacementRequirement(coolerSocketDefinition, "matching-cooler-kit", [board, ...incompatible], "cpu_cooler")];
    return result([compatibilityDecision({
      ruleId: coolerSocketDefinition.ruleId,
      ruleVersion: coolerSocketDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict: incompatible.length === 0 ? "pass" : "fail",
      domain: coolerSocketDefinition.domain,
      message: incompatible.length === 0 ? "Every cooling mount standard matches the board socket kit." : "A selected cooler lacks a matching governed socket kit.",
      instanceIds: [board.instanceId, ...coolers.map(({ instanceId }) => instanceId)],
      factIds: [boardMount.factId, ...facts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const coolerClearanceDefinition = definition({
  ruleId: "compat.cooler-clearance",
  domain: "mechanical",
  description: "Air-cooler height and plan-scoped RAM/VRM clearance must fit the selected case placement.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["cpu_cooler"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal", "assembly"), components("cpu_cooler")],
    facts: [
      fact("case", "case.cpu_cooler_max_height", "normal"),
      fact("cpu_cooler", "physical.clearance", "normal", "plan_subject"),
      fact("cpu_cooler", "physical.height", "normal"),
    ],
    placements: [{ componentKind: "cpu_cooler", mountOwnerKind: "case", minCount: 1 }],
  },
});

const coolerClearanceRule: GovernedCompatibilityRule = {
  definition: coolerClearanceDefinition,
  evaluate: (context) => {
    const chassis = one(context, "case");
    const cooler = one(context, "cpu_cooler");
    const maximum = firstFact(context, chassis, "case.cpu_cooler_max_height");
    const height = firstFact(context, cooler, "physical.height");
    const clearance = firstFact(context, cooler, "physical.clearance");
    const fits = Number(scalar(height)) <= Number(scalar(maximum)) && Number(scalar(clearance)) > 0;
    const remediation = fits ? [] : [replacementRequirement(coolerClearanceDefinition, "clearance-compatible-cooler", [chassis, cooler], "cpu_cooler")];
    return result([compatibilityDecision({
      ruleId: coolerClearanceDefinition.ruleId,
      ruleVersion: coolerClearanceDefinition.ruleVersion,
      discriminator: `${chassis.instanceId}-${cooler.instanceId}`,
      verdict: fits ? "pass" : "fail",
      domain: coolerClearanceDefinition.domain,
      message: fits ? "Cooler height and measured RAM/VRM clearance are positive within the case envelope."
        : "Cooler height exceeds the case limit or the measured RAM/VRM clearance is non-positive.",
      instanceIds: [chassis.instanceId, cooler.instanceId],
      factIds: [maximum.factId, height.factId, clearance.factId],
      remediation,
    })], remediation);
  },
};

const radiatorSupportDefinition = definition({
  ruleId: "compat.radiator-placement",
  domain: "mechanical",
  description: "AIO/radiator mounting standards must be listed by the case and each present cooling body requires a case placement.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["aio", "radiator"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal", "assembly")],
    facts: [
      fact("case", "cooling.radiator_support", "normal"),
      fact("aio", "mount.standard", "normal"),
      fact("radiator", "mount.standard", "normal"),
    ],
    placements: [
      { componentKind: "aio", mountOwnerKind: "case", minCount: 1 },
      { componentKind: "radiator", mountOwnerKind: "case", minCount: 1 },
    ],
  },
});

const radiatorSupportRule: GovernedCompatibilityRule = {
  definition: radiatorSupportDefinition,
  evaluate: (context) => {
    const chassis = one(context, "case");
    const coolingBodies = [...context.componentsOfKind("aio"), ...context.componentsOfKind("radiator")];
    const supportFact = firstFact(context, chassis, "cooling.radiator_support");
    const supported = tokenSet(stringSet(supportFact));
    const facts = coolingBodies.map((body) => firstFact(context, body, "mount.standard"));
    const incompatible = coolingBodies.filter((body) => !supported.has(normalizedToken(scalar(firstFact(context, body, "mount.standard")))));
    const remediation = incompatible.length === 0 ? [] : [replacementRequirement(radiatorSupportDefinition, "supported-radiator", [chassis, ...incompatible], incompatible[0]?.kind ?? "radiator")];
    return result([compatibilityDecision({
      ruleId: radiatorSupportDefinition.ruleId,
      ruleVersion: radiatorSupportDefinition.ruleVersion,
      discriminator: chassis.instanceId,
      verdict: incompatible.length === 0 ? "pass" : "fail",
      domain: radiatorSupportDefinition.domain,
      message: incompatible.length === 0 ? "Every selected radiator/AIO mount is supported by the case."
        : "A selected radiator/AIO mount is not supported by the governed case placement list.",
      instanceIds: [chassis.instanceId, ...coolingBodies.map(({ instanceId }) => instanceId)],
      factIds: [supportFact.factId, ...facts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const gpuClearanceDefinition = definition({
  ruleId: "compat.gpu-length-clearance",
  domain: "mechanical",
  description: "GPU length must not exceed the case's governed maximum and requires an explicit placement.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["gpu"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal"), components("gpu", 1, "normal")],
    facts: [fact("case", "case.gpu_max_length", "normal"), fact("gpu", "gpu.length", "normal")],
    placements: [{ componentKind: "gpu", mountOwnerKind: "case", minCount: 1 }],
  },
});

const gpuClearanceRule: GovernedCompatibilityRule = {
  definition: gpuClearanceDefinition,
  evaluate: (context) => {
    const chassis = one(context, "case");
    const gpu = one(context, "gpu");
    const maximum = firstFact(context, chassis, "case.gpu_max_length");
    const length = firstFact(context, gpu, "gpu.length");
    const fits = Number(scalar(length)) <= Number(scalar(maximum));
    const remediation = fits ? [] : [safetyRemediationForKnownFailure(gpuClearanceDefinition, "replace-gpu", [chassis.instanceId, gpu.instanceId], "gpu")];
    return result([compatibilityDecision({
      ruleId: gpuClearanceDefinition.ruleId,
      ruleVersion: gpuClearanceDefinition.ruleVersion,
      discriminator: `${chassis.instanceId}-${gpu.instanceId}`,
      verdict: fits ? "pass" : "fail",
      domain: gpuClearanceDefinition.domain,
      message: fits ? "GPU length is within the governed case limit." : `GPU length ${String(scalar(length))} mm exceeds the ${String(scalar(maximum))} mm case limit.`,
      instanceIds: [chassis.instanceId, gpu.instanceId],
      factIds: [maximum.factId, length.factId],
      remediation,
    })], remediation);
  },
};

const gpuPowerDefinition = definition({
  ruleId: "compat.gpu-power-connectors",
  domain: "electrical",
  description: "The PSU must provide every governed GPU power connector family.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["gpu"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("psu", 1, "safety"), components("gpu", 1, "safety")],
    facts: [fact("psu", "psu.connectors", "electrical_safety"), fact("gpu", "gpu.power_connectors", "electrical_safety")],
  },
});

const gpuPowerRule: GovernedCompatibilityRule = {
  definition: gpuPowerDefinition,
  evaluate: (context) => {
    const psu = one(context, "psu");
    const gpu = one(context, "gpu");
    const psuFact = firstFact(context, psu, "psu.connectors");
    const gpuFact = firstFact(context, gpu, "gpu.power_connectors");
    const provided = new Set(stringSet(psuFact));
    const missing = stringSet(gpuFact).filter((connector) => !provided.has(connector));
    const remediation = missing.length === 0 ? [] : [safetyRemediationForKnownFailure(gpuPowerDefinition, "replace-psu", [psu.instanceId, gpu.instanceId], "psu")];
    return result([compatibilityDecision({
      ruleId: gpuPowerDefinition.ruleId,
      ruleVersion: gpuPowerDefinition.ruleVersion,
      discriminator: `${psu.instanceId}-${gpu.instanceId}`,
      verdict: missing.length === 0 ? "pass" : "fail",
      domain: gpuPowerDefinition.domain,
      message: missing.length === 0 ? "The PSU declares all required GPU connector families." : `The PSU lacks required GPU connectors: ${missing.join(", ")}.`,
      instanceIds: [psu.instanceId, gpu.instanceId],
      factIds: [psuFact.factId, gpuFact.factId],
      remediation,
    })], remediation);
  },
};

const psuCapacityDefinition = definition({
  ruleId: "compat.psu-capacity",
  domain: "electrical",
  description: "Governed component load facts must not exceed governed PSU capacity.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["psu"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("psu", 1, "safety"), components("motherboard"), components("cpu")],
    facts: [
      fact("psu", "psu.capacity", "electrical_safety"),
      fact("motherboard", "power.load", "electrical_safety"),
      fact("cpu", "power.load", "electrical_safety"),
      fact("gpu", "power.load", "electrical_safety"),
      fact("storage_drive", "power.load", "electrical_safety"),
    ],
  },
});

const psuCapacityRule: GovernedCompatibilityRule = {
  definition: psuCapacityDefinition,
  evaluate: (context) => {
    const psu = one(context, "psu");
    const capacity = firstFact(context, psu, "psu.capacity");
    const loads = context.components.filter((component) => component.kind !== "psu")
      .flatMap((component) => context.factsFor(component, "power.load"));
    const total = loads.reduce((sum, load) => sum + Number(scalar(load)), 0);
    const fits = total <= Number(scalar(capacity));
    const remediation = fits ? [] : [safetyRemediationForKnownFailure(psuCapacityDefinition, "replace-psu", [psu.instanceId], "psu")];
    return result([compatibilityDecision({
      ruleId: psuCapacityDefinition.ruleId,
      ruleVersion: psuCapacityDefinition.ruleVersion,
      discriminator: psu.instanceId,
      verdict: fits ? "pass" : "fail",
      domain: psuCapacityDefinition.domain,
      message: fits ? `Governed load ${total} W is within PSU capacity.` : `Governed load ${total} W exceeds PSU capacity ${String(scalar(capacity))} W.`,
      instanceIds: [psu.instanceId, ...context.components.filter((component) => component.kind !== "psu").map(({ instanceId }) => instanceId)],
      factIds: [capacity.factId, ...loads.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const psuTransientDefinition = definition({
  ruleId: "compat.psu-transient-headroom",
  domain: "electrical",
  description: "Official worst-case component loads require conservative transient headroom before power-on.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["psu"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("cpu"), components("motherboard"), components("psu", 1, "safety", "pre_power")],
    facts: [
      fact("psu", "psu.capacity", "electrical_safety"),
      fact("motherboard", "power.load", "electrical_safety"),
      fact("cpu", "power.load", "electrical_safety"),
      fact("gpu", "power.load", "electrical_safety"),
      fact("storage_drive", "power.load", "electrical_safety"),
      fact("hba", "power.load", "electrical_safety"),
      fact("backplane", "power.load", "electrical_safety"),
    ],
  },
});

const psuTransientRule: GovernedCompatibilityRule = {
  definition: psuTransientDefinition,
  evaluate: (context) => {
    const psu = one(context, "psu");
    const capacity = firstFact(context, psu, "psu.capacity");
    const loads = context.components.filter((component) => component.kind !== "psu")
      .flatMap((component) => context.factsFor(component, "power.load"));
    const worstCaseLoad = loads.reduce((sum, load) => sum + Number(scalar(load)), 0);
    const requiredCapacity = worstCaseLoad * 1.25;
    const fits = Number(scalar(capacity)) >= requiredCapacity;
    const remediation = fits ? [] : [replacementRequirement(psuTransientDefinition, "transient-capable-psu", [psu], "psu")];
    return result([compatibilityDecision({
      ruleId: psuTransientDefinition.ruleId,
      ruleVersion: psuTransientDefinition.ruleVersion,
      discriminator: psu.instanceId,
      verdict: fits ? "pass" : "fail",
      domain: psuTransientDefinition.domain,
      message: fits ? "PSU capacity covers the locked worst-case loads and conservative transient reserve."
        : `PSU capacity is below the ${requiredCapacity} W transient planning threshold.`,
      instanceIds: [psu.instanceId, ...context.components.filter((component) => component.kind !== "psu").map(({ instanceId }) => instanceId)],
      factIds: [capacity.factId, ...loads.map(({ factId }) => factId)],
      assumptions: ["transient planning reserve factor: 1.25"],
      remediation,
    })], remediation);
  },
};

const mainPowerDefinition = definition({
  ruleId: "compat.main-power-connectors",
  domain: "electrical",
  description: "The exact PSU must expose the ATX24/EPS families required by the board and the topology must model separate cabled power edges.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["motherboard", "psu"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard"), components("psu", 1, "safety", "pre_power")],
    facts: [fact("motherboard", "io.port_types", "electrical_safety"), fact("psu", "psu.connectors", "electrical_safety")],
    connections: [{ fromKind: "psu", toKind: "motherboard", minCount: 2, cableRequired: true }],
  },
});

const mainPowerRule: GovernedCompatibilityRule = {
  definition: mainPowerDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const psu = one(context, "psu");
    const boardPorts = firstFact(context, board, "io.port_types");
    const psuConnectors = firstFact(context, psu, "psu.connectors");
    const required = new Set(stringSet(boardPorts).map(powerConnectorFamily).filter((entry): entry is "atx24" | "eps" | "gpu" | "peripheral" => entry !== null));
    // ATX desktop boards must declare both main and CPU power families; an
    // official port list that omits either is itself a known incompatible input.
    const supplied = new Set(stringSet(psuConnectors).map(powerConnectorFamily).filter((entry): entry is "atx24" | "eps" | "gpu" | "peripheral" => entry !== null));
    const missing = ["atx24", "eps"].filter((family) => !required.has(family as "atx24" | "eps") || !supplied.has(family as "atx24" | "eps"));
    const remediation = missing.length === 0 ? [] : [replacementRequirement(mainPowerDefinition, "correct-main-power", [board, psu], "psu")];
    return result([compatibilityDecision({
      ruleId: mainPowerDefinition.ruleId,
      ruleVersion: mainPowerDefinition.ruleVersion,
      discriminator: `${board.instanceId}-${psu.instanceId}`,
      verdict: missing.length === 0 ? "pass" : "fail",
      domain: mainPowerDefinition.domain,
      message: missing.length === 0 ? "ATX24 and EPS connector families and separate cable edges are present."
        : `Official connector authority is missing or incompatible for: ${missing.join(", ")}.`,
      instanceIds: [board.instanceId, psu.instanceId],
      factIds: [boardPorts.factId, psuConnectors.factId],
      remediation,
    })], remediation);
  },
};

const cableFamilyDefinition = definition({
  ruleId: "compat.modular-cable-family",
  domain: "electrical",
  description: "A modular PSU cable must match an official cable family and requires revision-scoped pinout authority.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["cable"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("psu", 1, "safety"), components("cable", 1, "safety")],
    facts: [
      fact("psu", "power.cable_families", "electrical_safety"),
      fact("cable", "power.cable_families", "electrical_safety", "revision"),
      fact("psu", "psu.pinout", "electrical_safety", "revision"),
    ],
    connections: [{ fromKind: "psu", toKind: "cable", minCount: 1, cableRequired: false }],
  },
});

const cableFamilyRule: GovernedCompatibilityRule = {
  definition: cableFamilyDefinition,
  evaluate: (context) => {
    const psu = one(context, "psu");
    const cable = one(context, "cable");
    const psuFamilies = firstFact(context, psu, "power.cable_families");
    const cableFamilies = firstFact(context, cable, "power.cable_families");
    const pinout = firstFact(context, psu, "psu.pinout");
    const allowed = new Set(stringSet(psuFamilies));
    const matches = stringSet(cableFamilies).some((family) => allowed.has(family));
    const remediation = matches ? [] : [safetyRemediationForKnownFailure(cableFamilyDefinition, "replace-cable", [psu.instanceId, cable.instanceId], "cable")];
    return result([compatibilityDecision({
      ruleId: cableFamilyDefinition.ruleId,
      ruleVersion: cableFamilyDefinition.ruleVersion,
      discriminator: `${psu.instanceId}-${cable.instanceId}`,
      verdict: matches ? "pass" : "fail",
      domain: cableFamilyDefinition.domain,
      message: matches ? "The modular cable family matches the PSU's official family set." : "The modular cable family does not match this PSU.",
      instanceIds: [psu.instanceId, cable.instanceId],
      factIds: [psuFamilies.factId, cableFamilies.factId, pinout.factId],
      remediation,
    })], remediation);
  },
};

const storageInterfaceDefinition = definition({
  ruleId: "compat.storage-interface-topology",
  domain: "storage",
  description: "M.2 key/length/protocol, SATA/NVMe endpoint, lane sharing, heatsink, placement and data-edge authority must close per drive.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["storage_drive"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard"), components("storage_drive")],
    facts: [
      fact("motherboard", "io.port_topology", "boot", "variant", "many"),
      fact("motherboard", "pcie.lane_sharing", "boot"),
      fact("storage_drive", "storage.interface", "boot"),
    ],
    placements: [
      { componentKind: "storage_drive", mountOwnerKind: "backplane", minCount: 0 },
      { componentKind: "storage_drive", mountOwnerKind: "case", minCount: 0 },
      { componentKind: "storage_drive", mountOwnerKind: "motherboard", minCount: 0 },
    ],
    connections: [
      { fromKind: "storage_drive", toKind: "backplane", minCount: 0, cableRequired: false },
      { fromKind: "storage_drive", toKind: "hba", minCount: 0, cableRequired: false },
      { fromKind: "storage_drive", toKind: "motherboard", minCount: 0, cableRequired: false },
    ],
  },
});

const storageInterfaceRule: GovernedCompatibilityRule = {
  definition: storageInterfaceDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const drives = context.componentsOfKind("storage_drive");
    const boardPorts = topologyFacts(context, board);
    const sharingFact = firstFact(context, board, "pcie.lane_sharing");
    const sharing = tokenSet(stringSet(sharingFact));
    const interfaceFacts = drives.map((drive) => firstFact(context, drive, "storage.interface"));
    const failures: ComponentInstance[] = [];
    const gaps: ComponentInstance[] = [];
    for (const drive of drives) {
      const interfaceFact = firstFact(context, drive, "storage.interface");
      const interfaceValue = normalizedToken(scalar(interfaceFact));
      const edges = context.connections.filter((connection) => connection.from.instanceId === drive.instanceId || connection.to.instanceId === drive.instanceId);
      const placements = context.placements.filter((placement) => placement.componentInstanceId === drive.instanceId);
      if (edges.length === 0 || placements.length === 0) {
        gaps.push(drive);
        continue;
      }
      const directBoardEdges = edges.filter((connection) => connection.from.instanceId === board.instanceId || connection.to.instanceId === board.instanceId);
      if (directBoardEdges.length === 0) continue; // Controller/backplane compatibility is evaluated by its own declared rule.
      const selectedPorts = directBoardEdges.flatMap((connection) => connection.from.instanceId === board.instanceId ? [connection.from.portId] : [connection.to.portId]);
      const candidates = boardPorts.filter((port) => selectedPorts.includes(port.endpointId));
      const compatible = candidates.some((port) => connectorSupports(interfaceValue, port.connectorType));
      const laneDisabled = candidates.some((port) => sharing.has(`unavailable:${normalizedToken(port.endpointId)}`)
        || sharing.has(`shared-disabled:${normalizedToken(port.endpointId)}`));
      const heatsinkRequired = interfaceValue.includes("heatsink-required");
      const heatsinkAvailable = boardPorts.some((port) => port.connectorType.includes("heatsink")
        && (candidates.length === 0 || candidates.some((candidate) => candidate.pathId === port.pathId)));
      if (!compatible || laneDisabled || (heatsinkRequired && !heatsinkAvailable)) failures.push(drive);
    }
    const requirements: RequirementNode[] = [];
    if (failures.length > 0) requirements.push(replacementRequirement(storageInterfaceDefinition, "compatible-storage-interface", [board, ...failures], "storage_drive"));
    if (gaps.length > 0) requirements.push(explicitRequirement({
      rule: storageInterfaceDefinition,
      discriminator: "storage-placement-data-edge",
      kind: "cable",
      instances: [board, ...gaps],
    }));
    const verdict = failures.length > 0 ? "fail" : gaps.length > 0 ? "blocked" : "pass";
    return result([compatibilityDecision({
      ruleId: storageInterfaceDefinition.ruleId,
      ruleVersion: storageInterfaceDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict,
      domain: storageInterfaceDefinition.domain,
      message: failures.length > 0 ? "A drive has an incompatible M.2/SATA/NVMe endpoint, disabled shared lane, key/length mismatch, or missing required heatsink."
        : gaps.length > 0 ? "A drive lacks an explicit placement or data-path edge."
          : "Drive protocol, M.2 key/length, lane-sharing, heatsink, placement and endpoint constraints are satisfied.",
      instanceIds: [board.instanceId, ...drives.map(({ instanceId }) => instanceId)],
      factIds: [...boardPorts.map(({ fact }) => fact.factId), sharingFact.factId, ...interfaceFacts.map(({ factId }) => factId)],
      remediation: requirements,
    })], requirements);
  },
};

const storageControllerDefinition = definition({
  ruleId: "compat.storage-controller-backplane-path",
  domain: "storage",
  description: "Every HBA must attach to the board; every backplane needs one compatible HBA/board data path and a cabled PSU power path.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["hba", "backplane"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard"), components("psu", 1, "safety", "pre_power")],
    facts: [
      fact("motherboard", "io.port_topology", "boot", "variant", "many"),
      fact("psu", "psu.connectors", "electrical_safety"),
      fact("hba", "hba.mode", "boot"),
      fact("hba", "io.port_topology", "boot", "variant", "many"),
      fact("backplane", "io.port_topology", "electrical_safety", "variant", "many"),
    ],
    connections: [
      { fromKind: "backplane", toKind: "hba", minCount: 0, cableRequired: false },
      { fromKind: "backplane", toKind: "motherboard", minCount: 0, cableRequired: false },
      { fromKind: "backplane", toKind: "psu", minCount: 1, cableRequired: true },
      { fromKind: "hba", toKind: "motherboard", minCount: 1, cableRequired: false },
    ],
  },
});

const storageControllerRule: GovernedCompatibilityRule = {
  definition: storageControllerDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const psu = one(context, "psu");
    const hbas = context.componentsOfKind("hba");
    const backplanes = context.componentsOfKind("backplane");
    const boardPorts = topologyFacts(context, board);
    const hbaPorts = hbas.flatMap((hba) => topologyFacts(context, hba));
    const backplanePorts = backplanes.flatMap((backplane) => topologyFacts(context, backplane));
    const hbaFacts = hbas.flatMap((hba) => [firstFact(context, hba, "hba.mode"), ...context.factsFor(hba, "io.port_topology")]);
    const psuConnectors = firstFact(context, psu, "psu.connectors");
    const hasPeripheralPower = stringSet(psuConnectors).some((connector) => powerConnectorFamily(connector) === "peripheral");
    const pathGaps: ComponentInstance[] = [];
    const incompatible: ComponentInstance[] = [];
    for (const hba of hbas) {
      if (!context.connections.some((edge) => (edge.from.instanceId === hba.instanceId && edge.to.instanceId === board.instanceId)
        || (edge.to.instanceId === hba.instanceId && edge.from.instanceId === board.instanceId))) pathGaps.push(hba);
    }
    for (const backplane of backplanes) {
      const dataEdge = context.connections.find((edge) => {
        const peer = edge.from.instanceId === backplane.instanceId ? edge.to.instanceId
          : edge.to.instanceId === backplane.instanceId ? edge.from.instanceId : null;
        return peer === board.instanceId || hbas.some(({ instanceId }) => instanceId === peer);
      });
      const powerEdge = context.connections.find((edge) => (edge.from.instanceId === backplane.instanceId && edge.to.instanceId === psu.instanceId)
        || (edge.to.instanceId === backplane.instanceId && edge.from.instanceId === psu.instanceId));
      if (!dataEdge || !powerEdge) pathGaps.push(backplane);
      const compatibleFamily = backplanePorts.some((port) => [...boardPorts, ...hbaPorts].some((host) => connectorSupports(port.connectorType, host.connectorType)));
      if (!compatibleFamily || !hasPeripheralPower) incompatible.push(backplane);
    }
    const requirements: RequirementNode[] = [];
    if (incompatible.length > 0) requirements.push(replacementRequirement(storageControllerDefinition, "compatible-controller-backplane", [board, psu, ...incompatible], "backplane"));
    if (pathGaps.length > 0) requirements.push(explicitRequirement({
      rule: storageControllerDefinition,
      discriminator: "controller-data-power-cables",
      kind: "cable",
      instances: [board, psu, ...pathGaps],
    }));
    const verdict = incompatible.length > 0 ? "fail" : pathGaps.length > 0 ? "blocked" : "pass";
    return result([compatibilityDecision({
      ruleId: storageControllerDefinition.ruleId,
      ruleVersion: storageControllerDefinition.ruleVersion,
      discriminator: "controller-backplane",
      verdict,
      domain: storageControllerDefinition.domain,
      message: incompatible.length > 0 ? "The HBA/board/backplane connector families or backplane power family are incompatible."
        : pathGaps.length > 0 ? "A required HBA host edge or backplane data/power cable edge is missing."
          : "HBA host, backplane data and backplane power paths are closed.",
      instanceIds: [board.instanceId, psu.instanceId, ...hbas.map(({ instanceId }) => instanceId), ...backplanes.map(({ instanceId }) => instanceId)],
      factIds: [psuConnectors.factId, ...boardPorts.map(({ fact }) => fact.factId), ...hbaFacts.map(({ factId }) => factId), ...backplanePorts.map(({ fact }) => fact.factId)],
      remediation: requirements,
    })], requirements);
  },
};

const frontPanelDefinition = definition({
  ruleId: "compat.front-panel-headers",
  domain: "routing",
  description: "Every governed front USB/Type-C/audio endpoint needs a compatible internal board header and an explicit cable edge.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: ["case"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("case", 1, "normal", "assembly"), components("motherboard")],
    facts: [
      fact("case", "io.port_topology", "normal", "variant", "many"),
      fact("motherboard", "io.port_topology", "normal", "variant", "many"),
    ],
    connections: [{ fromKind: "case", toKind: "motherboard", minCount: 1, cableRequired: true }],
  },
});

const frontPanelRule: GovernedCompatibilityRule = {
  definition: frontPanelDefinition,
  evaluate: (context) => {
    const chassis = one(context, "case");
    const board = one(context, "motherboard");
    const casePorts = topologyFacts(context, chassis);
    const boardPorts = topologyFacts(context, board);
    const front = casePorts.filter((port) => port.location === "front" && ["usb-c", "usb", "audio"].includes(headerFamily(port.connectorType) ?? ""));
    const missing = front.filter((port) => {
      const family = headerFamily(port.connectorType);
      return family === null || !boardPorts.some((candidate) => candidate.location === "internal" && headerFamily(candidate.connectorType) === family);
    });
    const remediation = missing.length === 0 ? [] : [replacementRequirement(frontPanelDefinition, "front-header-adapter", [chassis, board], "adapter")];
    return result([compatibilityDecision({
      ruleId: frontPanelDefinition.ruleId,
      ruleVersion: frontPanelDefinition.ruleVersion,
      discriminator: `${chassis.instanceId}-${board.instanceId}`,
      verdict: missing.length === 0 ? "pass" : "fail",
      domain: frontPanelDefinition.domain,
      message: missing.length === 0 ? "Front USB, Type-C and audio endpoints have compatible internal headers and a modeled cable edge."
        : `No compatible internal board header exists for: ${missing.map(({ endpointId }) => endpointId).join(", ")}.`,
      instanceIds: [chassis.instanceId, board.instanceId],
      factIds: [...casePorts, ...boardPorts].map(({ fact }) => fact.factId),
      remediation,
    })], remediation);
  },
};

const fanHeaderDefinition = definition({
  ruleId: "compat.fan-rgb-header-budget",
  domain: "electrical",
  description: "Case fans and RGB hubs must fit governed header quantity, current and control-family limits.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["case_fan", "fan_rgb_hub"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard")],
    facts: [
      fact("motherboard", "io.port_topology", "electrical_safety", "variant", "many"),
      fact("motherboard", "power.connector_current_rating", "electrical_safety", "revision"),
      fact("case_fan", "io.port_types", "electrical_safety"),
      fact("case_fan", "power.connector_current_rating", "electrical_safety", "revision"),
      fact("fan_rgb_hub", "io.port_types", "electrical_safety"),
      fact("fan_rgb_hub", "power.connector_current_rating", "electrical_safety", "revision"),
    ],
    connections: [
      { fromKind: "case_fan", toKind: "motherboard", minCount: 1, cableRequired: false },
      { fromKind: "fan_rgb_hub", toKind: "motherboard", minCount: 1, cableRequired: false },
    ],
  },
});

const fanHeaderRule: GovernedCompatibilityRule = {
  definition: fanHeaderDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const devices = [...context.componentsOfKind("case_fan"), ...context.componentsOfKind("fan_rgb_hub")];
    const boardPorts = topologyFacts(context, board).filter((port) => ["fan", "argb", "rgb"].includes(headerFamily(port.connectorType) ?? ""));
    const boardRating = firstFact(context, board, "power.connector_current_rating");
    const devicePortFacts = devices.map((device) => firstFact(context, device, "io.port_types"));
    const deviceCurrentFacts = devices.map((device) => firstFact(context, device, "power.connector_current_rating"));
    const totalCurrent = deviceCurrentFacts.reduce((sum, candidate) => sum + Number(scalar(candidate)), 0);
    const availableCurrent = Number(scalar(boardRating)) * boardPorts.reduce((sum, port) => sum + port.quantity, 0);
    const unsupported = devices.filter((device) => {
      const families = stringSet(firstFact(context, device, "io.port_types")).map(headerFamily).filter((entry) => entry !== null);
      return families.length === 0 || !families.some((family) => boardPorts.some((port) => headerFamily(port.connectorType) === family));
    });
    const fits = unsupported.length === 0 && boardPorts.reduce((sum, port) => sum + port.quantity, 0) >= devices.length && totalCurrent <= availableCurrent;
    const remediation = fits ? [] : [replacementRequirement(fanHeaderDefinition, "powered-fan-rgb-hub", [board, ...devices], "fan_rgb_hub")];
    return result([compatibilityDecision({
      ruleId: fanHeaderDefinition.ruleId,
      ruleVersion: fanHeaderDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict: fits ? "pass" : "fail",
      domain: fanHeaderDefinition.domain,
      message: fits ? "Fan/RGB header quantity, current and control-family budgets are satisfied."
        : "Fan/RGB header count, current rating or control-family compatibility is insufficient.",
      instanceIds: [board.instanceId, ...devices.map(({ instanceId }) => instanceId)],
      factIds: [boardRating.factId, ...boardPorts.map(({ fact }) => fact.factId), ...devicePortFacts.map(({ factId }) => factId), ...deviceCurrentFacts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const pumpHeaderDefinition = definition({
  ruleId: "compat.pump-header-budget",
  domain: "electrical",
  description: "Every pump/AIO needs an official pump header, compatible control family, current headroom and explicit board edge.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["pump", "aio"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("motherboard")],
    facts: [
      fact("motherboard", "cooling.pump_header", "electrical_safety"),
      fact("motherboard", "io.port_topology", "electrical_safety", "variant", "many"),
      fact("motherboard", "power.connector_current_rating", "electrical_safety", "revision"),
      fact("pump", "io.port_types", "electrical_safety"),
      fact("pump", "power.connector_current_rating", "electrical_safety", "revision"),
      fact("aio", "io.port_types", "electrical_safety"),
      fact("aio", "power.connector_current_rating", "electrical_safety", "revision"),
    ],
    connections: [
      { fromKind: "pump", toKind: "motherboard", minCount: 1, cableRequired: false },
      { fromKind: "aio", toKind: "motherboard", minCount: 1, cableRequired: false },
    ],
  },
});

const pumpHeaderRule: GovernedCompatibilityRule = {
  definition: pumpHeaderDefinition,
  evaluate: (context) => {
    const board = one(context, "motherboard");
    const pumps = [...context.componentsOfKind("pump"), ...context.componentsOfKind("aio")];
    const declared = firstFact(context, board, "cooling.pump_header");
    const boardPorts = topologyFacts(context, board).filter((port) => ["pump", "fan"].includes(headerFamily(port.connectorType) ?? ""));
    const boardRating = firstFact(context, board, "power.connector_current_rating");
    const portFacts = pumps.map((pump) => firstFact(context, pump, "io.port_types"));
    const currentFacts = pumps.map((pump) => firstFact(context, pump, "power.connector_current_rating"));
    const totalCurrent = currentFacts.reduce((sum, candidate) => sum + Number(scalar(candidate)), 0);
    const compatible = pumps.every((pump) => stringSet(firstFact(context, pump, "io.port_types"))
      .some((connector) => ["pump", "fan"].includes(headerFamily(connector) ?? "")));
    const fits = scalar(declared) === true && compatible
      && boardPorts.reduce((sum, port) => sum + port.quantity, 0) >= pumps.length
      && totalCurrent <= Number(scalar(boardRating)) * boardPorts.reduce((sum, port) => sum + port.quantity, 0);
    const remediation = fits ? [] : [replacementRequirement(pumpHeaderDefinition, "powered-pump-controller", [board, ...pumps], "fan_rgb_hub")];
    return result([compatibilityDecision({
      ruleId: pumpHeaderDefinition.ruleId,
      ruleVersion: pumpHeaderDefinition.ruleVersion,
      discriminator: board.instanceId,
      verdict: fits ? "pass" : "fail",
      domain: pumpHeaderDefinition.domain,
      message: fits ? "Pump header presence, control family, count and current budget are sufficient."
        : "Pump header presence, control family, count or current budget is insufficient.",
      instanceIds: [board.instanceId, ...pumps.map(({ instanceId }) => instanceId)],
      factIds: [declared.factId, boardRating.factId, ...boardPorts.map(({ fact }) => fact.factId), ...portFacts.map(({ factId }) => factId), ...currentFacts.map(({ factId }) => factId)],
      remediation,
    })], remediation);
  },
};

const nasPowerDefinition = definition({
  ruleId: "compat.nas-spinup-backplane-hba",
  domain: "electrical",
  description: "NAS storage paths require spin-up reserve, backplane peripheral power and IT-mode HBA authority when a raw-disk layout is requested.",
  safetyClass: "electrical_safety",
  activation: { topology: "non_empty", anyComponentKinds: ["hba", "backplane"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("psu", 1, "safety", "pre_power")],
    facts: [
      fact("psu", "psu.capacity", "electrical_safety"),
      fact("psu", "psu.connectors", "electrical_safety"),
      fact("storage_drive", "power.load", "electrical_safety"),
      fact("backplane", "power.load", "electrical_safety"),
      fact("hba", "hba.mode", "boot"),
    ],
    connections: [{ fromKind: "backplane", toKind: "psu", minCount: 1, cableRequired: true }],
    systemProfile: { required: false, allowedProfileIds: [] },
    logicalLayouts: true,
  },
});

const nasPowerRule: GovernedCompatibilityRule = {
  definition: nasPowerDefinition,
  evaluate: (context) => {
    const psu = one(context, "psu");
    const drives = context.componentsOfKind("storage_drive");
    const backplanes = context.componentsOfKind("backplane");
    const hbas = context.componentsOfKind("hba");
    const capacity = firstFact(context, psu, "psu.capacity");
    const connectors = firstFact(context, psu, "psu.connectors");
    const driveLoads = drives.map((drive) => firstFact(context, drive, "power.load"));
    const backplaneLoads = backplanes.map((backplane) => firstFact(context, backplane, "power.load"));
    const hbaModes = hbas.map((hba) => firstFact(context, hba, "hba.mode"));
    const spinupLoad = driveLoads.reduce((sum, candidate) => sum + Number(scalar(candidate)) * 2, 0)
      + backplaneLoads.reduce((sum, candidate) => sum + Number(scalar(candidate)), 0);
    const rawDiskRequested = context.logicalLayouts.length > 0 || context.systemProfile?.profileId === "system.truenas-scale";
    const wrongMode = rawDiskRequested && hbaModes.some((candidate) => normalizedToken(scalar(candidate)) !== "it");
    const missingPowerFamily = backplanes.length > 0 && !stringSet(connectors).some((candidate) => powerConnectorFamily(candidate) === "peripheral");
    const insufficient = spinupLoad > Number(scalar(capacity));
    const failures = [
      ...(insufficient ? ["spin-up load exceeds PSU capacity"] : []),
      ...(missingPowerFamily ? ["PSU lacks a governed backplane peripheral power family"] : []),
      ...(wrongMode ? ["raw-disk NAS layout requires HBA IT mode"] : []),
    ];
    const remediation = failures.length === 0 ? [] : [replacementRequirement(nasPowerDefinition, "nas-power-controller", [psu, ...backplanes, ...hbas], wrongMode ? "hba" : "psu")];
    return result([compatibilityDecision({
      ruleId: nasPowerDefinition.ruleId,
      ruleVersion: nasPowerDefinition.ruleVersion,
      discriminator: psu.instanceId,
      verdict: failures.length === 0 ? "pass" : "fail",
      domain: nasPowerDefinition.domain,
      message: failures.length === 0 ? "NAS spin-up reserve, backplane power and requested HBA mode are compatible." : failures.join("; "),
      instanceIds: [psu.instanceId, ...drives.map(({ instanceId }) => instanceId), ...backplanes.map(({ instanceId }) => instanceId), ...hbas.map(({ instanceId }) => instanceId)],
      factIds: [capacity.factId, connectors.factId, ...driveLoads.map(({ factId }) => factId), ...backplaneLoads.map(({ factId }) => factId), ...hbaModes.map(({ factId }) => factId)],
      assumptions: ["storage-drive spin-up planning multiplier: 2"],
      remediation,
    })], remediation);
  },
};

const logicalStorageDefinition = definition({
  ruleId: "compat.logical-storage-safety",
  domain: "storage",
  description: "Boot/data roles, unique disk ownership, controller-port paths and destructive target identity must remain explicit.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["storage_drive"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("storage_drive")],
    connections: [
      { fromKind: "storage_drive", toKind: "backplane", minCount: 0, cableRequired: false },
      { fromKind: "storage_drive", toKind: "hba", minCount: 0, cableRequired: false },
      { fromKind: "storage_drive", toKind: "motherboard", minCount: 0, cableRequired: false },
    ],
    systemProfile: { required: false, allowedProfileIds: [] },
    logicalLayouts: true,
  },
});

const logicalStorageRule: GovernedCompatibilityRule = {
  definition: logicalStorageDefinition,
  evaluate: (context) => {
    const drives = context.componentsOfKind("storage_drive");
    if (context.logicalLayouts.length === 0) {
      if (context.systemProfile?.profileId !== "system.truenas-scale") return result([compatibilityDecision({
        ruleId: logicalStorageDefinition.ruleId,
        ruleVersion: logicalStorageDefinition.ruleVersion,
        discriminator: "not-requested",
        verdict: "pass",
        domain: logicalStorageDefinition.domain,
        message: "No NAS logical layout is requested; no logical disk roles were inferred.",
        instanceIds: drives.map(({ instanceId }) => instanceId),
      })]);
      const requirement = explicitRequirement({
        rule: logicalStorageDefinition,
        discriminator: "truenas-layout-selection",
        kind: "user_decision",
        requiredBefore: "os_install",
        instances: drives,
      });
      return result([compatibilityDecision({
        ruleId: logicalStorageDefinition.ruleId,
        ruleVersion: logicalStorageDefinition.ruleVersion,
        discriminator: "missing-layout",
        verdict: "blocked",
        domain: logicalStorageDefinition.domain,
        message: "TrueNAS is selected but boot/data/spare disk roles have not been explicitly assigned.",
        instanceIds: drives.map(({ instanceId }) => instanceId),
        remediation: [requirement],
      })], [requirement]);
    }
    const assignedIds = context.logicalLayouts.flatMap((layout) => [
      ...layout.bootPoolDiskIds,
      ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
      ...layout.spareDiskIds,
    ]);
    const bootIds = new Set(context.logicalLayouts.flatMap(({ bootPoolDiskIds }) => bootPoolDiskIds));
    const dataIds = new Set(context.logicalLayouts.flatMap(({ vdevs }) => vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds)));
    const duplicated = assignedIds.filter((id, index) => assignedIds.indexOf(id) !== index);
    const overlap = [...bootIds].filter((id) => dataIds.has(id));
    const byId = new Map(drives.map((drive) => [drive.instanceId, drive]));
    const missingPath = [...new Set(assignedIds)].filter((diskId) => !context.connections.some((edge) => edge.from.instanceId === diskId || edge.to.instanceId === diskId));
    const portLocators = [...new Set(assignedIds)].map((diskId) => {
      const edge = context.connections.find((candidate) => candidate.from.instanceId === diskId || candidate.to.instanceId === diskId);
      if (!edge) return null;
      const peer = edge.from.instanceId === diskId ? edge.to : edge.from;
      return `${peer.instanceId}:${peer.portId}`;
    });
    const duplicateLocators = portLocators.filter((locator, index) => locator !== null && portLocators.indexOf(locator) !== index);
    const structuralFailure = duplicated.length > 0 || overlap.length > 0 || [...new Set(assignedIds)].some((id) => !byId.has(id)) || duplicateLocators.length > 0;
    const requirements: RequirementNode[] = [];
    if (structuralFailure) requirements.push(explicitRequirement({
      rule: logicalStorageDefinition,
      discriminator: "unique-logical-disk-ownership",
      kind: "user_decision",
      requiredBefore: "os_install",
      instances: drives,
    }));
    if (missingPath.length > 0) requirements.push(explicitRequirement({
      rule: logicalStorageDefinition,
      discriminator: "disk-controller-port-path",
      kind: "cable",
      requiredBefore: "os_install",
      instances: missingPath.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
    }));
    // Planned topology identifies a target logically, but never proves which
    // physical disk is about to be erased. U7 may satisfy this measurement via
    // a locked disk-locator observation and a destructive-action checkpoint.
    const locatorRequirement = explicitRequirement({
      rule: logicalStorageDefinition,
      discriminator: "physical-disk-locator-verification",
      kind: "measurement",
      criticality: "safety",
      requiredBefore: "os_install",
      instances: [...new Set(assignedIds)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
    });
    requirements.push(locatorRequirement);
    const verdict = structuralFailure ? "fail" : "blocked";
    return result([compatibilityDecision({
      ruleId: logicalStorageDefinition.ruleId,
      ruleVersion: logicalStorageDefinition.ruleVersion,
      discriminator: "logical-layout",
      verdict,
      domain: logicalStorageDefinition.domain,
      message: structuralFailure ? "Logical storage contains duplicate ownership, boot/data overlap, missing disks, or duplicate controller-port locators."
        : missingPath.length > 0 ? "Logical disk ownership is valid, but one or more controller-port paths are missing."
          : "Logical roles and port paths are explicit; physical destructive targets still require a locked disk-locator observation.",
      instanceIds: drives.map(({ instanceId }) => instanceId),
      assumptions: ["planned instance and port identities do not prove the physical disk selected by an installer"],
      remediation: requirements,
    })], requirements);
  },
};

const storageBootDefinition = definition({
  ruleId: "compat.storage-boot-support",
  domain: "storage",
  description: "At least one present storage device must explicitly support boot.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: ["storage_drive"] },
  requiredInputs: {
    ...baseInputs(),
    componentKinds: [components("storage_drive")],
    facts: [fact("storage_drive", "storage.boot_support", "boot")],
  },
});

const storageBootRule: GovernedCompatibilityRule = {
  definition: storageBootDefinition,
  evaluate: (context) => {
    const drives = context.componentsOfKind("storage_drive");
    const facts = drives.map((drive) => firstFact(context, drive, "storage.boot_support"));
    const bootable = facts.some((candidate) => scalar(candidate) === true);
    const remediation = bootable ? [] : [safetyRemediationForKnownFailure(storageBootDefinition, "replace-boot-drive", drives.map(({ instanceId }) => instanceId), "storage_drive")];
    return result([compatibilityDecision({
      ruleId: storageBootDefinition.ruleId,
      ruleVersion: storageBootDefinition.ruleVersion,
      discriminator: "boot-path",
      verdict: bootable ? "pass" : "fail",
      domain: storageBootDefinition.domain,
      message: bootable ? "At least one locked storage fact supports boot." : "No present storage device has governed boot support.",
      instanceIds: drives.map(({ instanceId }) => instanceId),
      factIds: facts.map(({ factId }) => factId),
      remediation,
    })], remediation);
  },
};

const systemProfileDefinition = definition({
  ruleId: "compat.system-profile-selection",
  domain: "system",
  description: "A concrete system profile must be selected; U7 support-path evaluation remains required.",
  safetyClass: "boot",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    systemProfile: { required: true, allowedProfileIds: [] },
    nestedEvaluations: { assemblySafety: false, firmwarePaths: true, systemProfileChecks: true, thermalAcoustic: false },
  },
});

const systemProfileRule: GovernedCompatibilityRule = {
  definition: systemProfileDefinition,
  evaluate: (context) => {
    if (context.systemProfileEvaluation) {
      const requirements = context.systemProfileEvaluation.requirements.map((requirement) => ({
        ...structuredClone(requirement),
        producedBy: { ruleId: systemProfileDefinition.ruleId, ruleVersion: systemProfileDefinition.ruleVersion, instanceIds: [...requirement.producedBy.instanceIds] },
      }));
      const requirementById = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
      const decisions = context.systemProfileEvaluation.decisions.map((entry) => ({
        ...structuredClone(entry),
        ruleId: systemProfileDefinition.ruleId,
        ruleVersion: systemProfileDefinition.ruleVersion,
        remediation: entry.remediation.map((requirement) => requirementById.get(requirement.requirementId) ?? requirement),
      }));
      return result(decisions, requirements);
    }
    const requirement = compatibilityRequirement({
      ruleId: systemProfileDefinition.ruleId,
      ruleVersion: systemProfileDefinition.ruleVersion,
      discriminator: "verify-system-support-path",
      kind: "system_action",
      criticality: "boot",
      requiredBefore: "os_install",
      evidenceRefs: context.systemProfile ? [context.systemProfile.versionFactId] : [],
    });
    return result([compatibilityDecision({
      ruleId: systemProfileDefinition.ruleId,
      ruleVersion: systemProfileDefinition.ruleVersion,
      discriminator: "u7-support-pending",
      verdict: "blocked",
      domain: systemProfileDefinition.domain,
      message: "A system profile is selected, but full driver and firmware-path availability is not yet proven.",
      factIds: context.systemProfile ? [context.systemProfile.versionFactId] : [],
      remediation: [requirement],
    })], [requirement]);
  },
};

const thermalSimulationDefinition = definition({
  ruleId: "compat.thermal-simulation",
  domain: "thermal",
  description: "The locked workload, environment, layout, airflow curves, and heat facts produce a bounded thermal result.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    nestedEvaluations: { assemblySafety: false, firmwarePaths: false, systemProfileChecks: false, thermalAcoustic: true },
  },
});

const thermalSimulationRule: GovernedCompatibilityRule = {
  definition: thermalSimulationDefinition,
  evaluate: (context) => {
    const evaluation = context.thermalAcousticEvaluation;
    if (evaluation === null) throw new TypeError("thermal simulation evaluation is unavailable");
    const thermal = evaluation.thermal;
    const blocked = thermal.verdict === "blocked";
    const requirement = blocked ? explicitRequirement({
      rule: thermalSimulationDefinition,
      discriminator: "thermal-input-closure",
      kind: "measurement",
      instances: context.components,
      evidenceRefs: [evaluation.simulationInputHash],
    }) : null;
    const peak = thermal.peakTemperatureC;
    const factIds = [
      ...thermal.airflow.fanOperatingPoints.flatMap(({ sourceRefs }) => sourceRefs),
      ...thermal.components.flatMap(({ sourceRefs }) => sourceRefs),
    ].filter((ref) => !ref.startsWith("observation:"));
    const message = blocked
      ? `Thermal interval is blocked: ${thermal.blockedReasonCodes.join(", ") || "required simulation inputs are unavailable"}.`
      : peak === null
        ? "Thermal evaluation completed without a finite peak-temperature interval."
        : `Planned peak component temperature is ${peak.lo}-${peak.hi} °C for ${evaluation.workloadId}.`;
    return result([compatibilityDecision({
      ruleId: thermalSimulationDefinition.ruleId,
      ruleVersion: thermalSimulationDefinition.ruleVersion,
      discriminator: "workload-thermal-interval",
      verdict: thermal.verdict,
      domain: thermalSimulationDefinition.domain,
      message,
      instanceIds: thermal.components.map(({ componentInstanceId }) => componentInstanceId),
      factIds,
      assumptions: [...thermal.assumptions, thermal.displayNotice],
      remediation: requirement === null ? [] : [requirement],
    })], requirement === null ? [] : [requirement]);
  },
};

const acousticSimulationDefinition = definition({
  ruleId: "compat.acoustic-simulation",
  domain: "acoustic",
  description: "Comparable A-weighted hardware source curves produce a bounded one-metre acoustic result for one locked workload and test method.",
  safetyClass: "normal",
  activation: { topology: "non_empty", anyComponentKinds: [] },
  requiredInputs: {
    ...baseInputs(),
    nestedEvaluations: { assemblySafety: false, firmwarePaths: false, systemProfileChecks: false, thermalAcoustic: true },
  },
});

const acousticSimulationRule: GovernedCompatibilityRule = {
  definition: acousticSimulationDefinition,
  evaluate: (context) => {
    const evaluation = context.thermalAcousticEvaluation;
    if (evaluation === null) throw new TypeError("acoustic simulation evaluation is unavailable");
    const acoustic = evaluation.acoustic;
    const blocked = acoustic.verdict === "blocked";
    const requirement = blocked ? explicitRequirement({
      rule: acousticSimulationDefinition,
      discriminator: "comparable-acoustic-inputs",
      kind: "measurement",
      instances: context.components,
      evidenceRefs: [evaluation.simulationInputHash],
    }) : null;
    const interval = acoustic.totalDba;
    const factIds = [
      ...acoustic.contributions.flatMap(({ sourceRefs }) => sourceRefs),
      ...acoustic.coilWhineRisks.flatMap(({ sourceRefs }) => sourceRefs),
    ].filter((ref) => !ref.startsWith("observation:"));
    const message = blocked
      ? `Acoustic interval is blocked: ${acoustic.blockedReasonCodes.join(", ") || "comparable source curves are unavailable"}.`
      : interval === null
        ? "Acoustic evaluation completed without a comparable source interval."
        : `Standardized hardware-source level is ${interval.lo}-${interval.hi} dBA at 1 m for ${acoustic.loadId}.`;
    return result([compatibilityDecision({
      ruleId: acousticSimulationDefinition.ruleId,
      ruleVersion: acousticSimulationDefinition.ruleVersion,
      discriminator: "standardized-hardware-acoustic-interval",
      verdict: acoustic.verdict,
      domain: acousticSimulationDefinition.domain,
      message,
      instanceIds: acoustic.contributions.map(({ componentInstanceId }) => componentInstanceId),
      factIds,
      assumptions: [...acoustic.assumptions, acoustic.displayNotice],
      remediation: requirement === null ? [] : [requirement],
    })], requirement === null ? [] : [requirement]);
  },
};

export const BUILTIN_COMPATIBILITY_RULES: readonly GovernedCompatibilityRule[] = Object.freeze([
  coreProfileRule,
  identityRule,
  assemblySafetyRule,
  adapterResourceRule,
  firmwarePathRule,
  cpuFirmwareSupportRule,
  cpuSocketRule,
  memoryTypeRule,
  memoryPopulationRule,
  memoryQvlRule,
  caseBoardRule,
  coolerSocketRule,
  coolerClearanceRule,
  radiatorSupportRule,
  gpuClearanceRule,
  pcieTopologyRule,
  gpuPowerRule,
  psuCapacityRule,
  psuTransientRule,
  mainPowerRule,
  cableFamilyRule,
  storageInterfaceRule,
  storageControllerRule,
  storageBootRule,
  frontPanelRule,
  fanHeaderRule,
  pumpHeaderRule,
  nasPowerRule,
  logicalStorageRule,
  systemProfileRule,
  thermalSimulationRule,
  acousticSimulationRule,
].sort((left, right) => left.definition.ruleId.localeCompare(right.definition.ruleId)));

export interface CompatibilityCoverageMatrixEntry {
  checkId: string;
  ruleId: string;
  outcomes: readonly ["pass", "fail", "blocked"];
}

/** Locked checklist-to-executable-rule map for the U6 compatibility surface. */
export const COMPATIBILITY_RULE_COVERAGE_MATRIX: readonly CompatibilityCoverageMatrixEntry[] = Object.freeze(([
  ["assembly.atx24", "compat.assembly-safety"],
  ["assembly.backplate-kit", "compat.assembly-safety"],
  ["assembly.cpu-fan", "compat.assembly-safety"],
  ["assembly.fastener-spec", "compat.assembly-safety"],
  ["assembly.gpu-power", "compat.assembly-safety"],
  ["assembly.loose-metal", "compat.assembly-safety"],
  ["assembly.protective-film", "compat.assembly-safety"],
  ["assembly.pump", "compat.assembly-safety"],
  ["assembly.standoffs-correct", "compat.assembly-safety"],
  ["assembly.standoffs-extra", "compat.assembly-safety"],
  ["assembly.thermal-interface-material", "compat.assembly-safety"],
  ["assembly.tools", "compat.assembly-safety"],
  ["assembly.12v-2x6-bend", "compat.assembly-safety"],
  ["assembly.12v-2x6-seating", "compat.assembly-safety"],
  ["case.form-factor", "compat.case-board-form-factor"],
  ["case.io", "compat.front-panel-headers"],
  ["case.standoffs", "compat.assembly-safety"],
  ["cooler.height", "compat.cooler-clearance"],
  ["cooler.radiator-position", "compat.radiator-placement"],
  ["cooler.ram-vrm-interference", "compat.cooler-clearance"],
  ["cooler.socket-kit", "compat.cooler-socket-kit"],
  ["cpu.bios-support", "compat.cpu-chipset-firmware-support"],
  ["cpu.chipset", "compat.cpu-chipset-firmware-support"],
  ["cpu.socket", "compat.cpu-socket"],
  ["firmware.executable-upgrade-path", "compat.firmware-path"],
  ["front.audio", "compat.front-panel-headers"],
  ["front.type-c", "compat.front-panel-headers"],
  ["front.usb", "compat.front-panel-headers"],
  ["gpu.length-space", "compat.gpu-length-clearance"],
  ["logical.boot-data-separation", "compat.logical-storage-safety"],
  ["logical.destructive-target", "compat.logical-storage-safety"],
  ["logical.hba-port-path", "compat.logical-storage-safety"],
  ["logical.unique-disk", "compat.logical-storage-safety"],
  ["memory.capacity", "compat.memory-population"],
  ["memory.cpu-imc-qvl", "compat.memory-imc-qvl"],
  ["memory.ddr", "compat.memory-type"],
  ["memory.ecc", "compat.memory-population"],
  ["memory.population", "compat.memory-population"],
  ["memory.rank", "compat.memory-population"],
  ["memory.udimm-rdimm", "compat.memory-population"],
  ["nas.backplane-power", "compat.nas-spinup-backplane-hba"],
  ["nas.hba-mode", "compat.nas-spinup-backplane-hba"],
  ["nas.spin-up", "compat.nas-spinup-backplane-hba"],
  ["pcie.bifurcation", "compat.pcie-topology"],
  ["pcie.lanes", "compat.pcie-topology"],
  ["pcie.shared-lanes", "compat.pcie-topology"],
  ["pcie.slot", "compat.pcie-topology"],
  ["pcie.space", "compat.pcie-topology"],
  ["power.atx24", "compat.main-power-connectors"],
  ["power.eps", "compat.main-power-connectors"],
  ["power.gpu-connectors", "compat.gpu-power-connectors"],
  ["power.modular-family", "compat.modular-cable-family"],
  ["power.psu-capacity", "compat.psu-capacity"],
  ["power.transient", "compat.psu-transient-headroom"],
  ["power.12v-2x6", "compat.assembly-safety"],
  ["storage.backplane-data", "compat.storage-controller-backplane-path"],
  ["storage.backplane-power", "compat.storage-controller-backplane-path"],
  ["storage.boot-drive", "compat.storage-boot-support"],
  ["storage.hba-path", "compat.storage-controller-backplane-path"],
  ["storage.m2-heatsink", "compat.storage-interface-topology"],
  ["storage.m2-key", "compat.storage-interface-topology"],
  ["storage.m2-length", "compat.storage-interface-topology"],
  ["storage.m2-lane-sharing", "compat.storage-interface-topology"],
  ["storage.sata-nvme-protocol", "compat.storage-interface-topology"],
  ["storage.sata-slimsas", "compat.storage-controller-backplane-path"],
  ["thermal.fan-control", "compat.fan-rgb-header-budget"],
  ["thermal.fan-current", "compat.fan-rgb-header-budget"],
  ["thermal.fan-header-count", "compat.fan-rgb-header-budget"],
  ["thermal.pump-control", "compat.pump-header-budget"],
  ["thermal.pump-current", "compat.pump-header-budget"],
  ["thermal.rgb-control", "compat.fan-rgb-header-budget"],
] as const).map(([checkId, ruleId]) => Object.freeze({
  checkId,
  ruleId,
  outcomes: Object.freeze(["pass", "fail", "blocked"] as const),
})).sort((left, right) => left.checkId.localeCompare(right.checkId)));

const BUILTIN_RULE_ID_SET = new Set(BUILTIN_COMPATIBILITY_RULES.map(({ definition: rule }) => rule.ruleId));
if (new Set(COMPATIBILITY_RULE_COVERAGE_MATRIX.map(({ checkId }) => checkId)).size !== COMPATIBILITY_RULE_COVERAGE_MATRIX.length
  || COMPATIBILITY_RULE_COVERAGE_MATRIX.some(({ ruleId }) => !BUILTIN_RULE_ID_SET.has(ruleId))) {
  throw new TypeError("compatibility coverage matrix is not closed by executable builtins");
}

export const BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES: readonly CompatibilityRuleManifestEntry[] = Object.freeze(
  BUILTIN_COMPATIBILITY_RULES.map(({ definition: rule }) => Object.freeze({
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    domain: rule.domain,
    implementationModuleIds: [...BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS],
    definitionHash: compatibilityRuleDefinitionHash(rule),
  })),
);

const builtinManifestHash = compatibilityRuleManifestHashRuntime(BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES);
if (builtinManifestHash !== BUILTIN_COMPATIBILITY_RULE_MANIFEST_HASH_RUNTIME) {
  throw new TypeError(`compatibility builtin manifest digest is stale: ${String(builtinManifestHash)}`);
}

export const BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS = Object.freeze(
  BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES.map((entry) => `${entry.ruleId}@${entry.ruleVersion}`),
);
