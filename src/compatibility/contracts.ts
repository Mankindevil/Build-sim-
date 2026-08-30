import type { ComponentKindId, SystemProfileId } from "../contracts/registries";
import type { FactRecord } from "../facts/contracts";
import type { FirmwarePathEvaluation } from "../firmware/contracts";
import type { FirmwareCapability } from "../capabilities/firmware";
import type { AssemblySafetyEvaluation } from "../requirements/assembly-safety";
import type { SystemProfileEvaluation } from "../system-profiles/contracts";
import type { SnapshotHashes } from "../hash";
import type { PricePlatform } from "../price/types";
import type {
  EvaluationDecision,
  RequirementKind,
  RequirementNode,
} from "../requirements/contracts";
import type { RequirementClosureResult } from "../requirements/closure";
import type {
  RequirementAllocationResult,
  RequirementReadiness,
} from "../requirements/allocation";
import type {
  BuildConfigV3,
  ComponentInstance,
  ConnectionEdge,
  PlacementEdge,
} from "../topology/contracts";
import type { TopologyBomLine } from "../topology/projections";
import type { ProductionThermalAcousticEvaluation } from "../simulation/evaluate";
import {
  compatibilityRuleDefinitionHashRuntime,
  progressiveEvaluationReferencesRuntime,
  validateProgressiveBuildEvaluationClosureRuntime,
  validateProgressiveBuildEvaluationRuntime,
  validateCompatibilityRuleDefinitionRuntime,
} from "./runtime.mjs";
import type {
  ProgressiveEvaluationClosureContextRuntime,
  ProgressiveEvaluationReferencesRuntime,
} from "./runtime.mjs";

export const PROGRESSIVE_BUILD_EVALUATION_SCHEMA_VERSION = "progressive-build-evaluation-v1" as const;
export const COMPATIBILITY_RULE_DEFINITION_SCHEMA_VERSION = "compatibility-rule-definition-v1" as const;

export const COMPATIBILITY_DOMAINS = Object.freeze([
  "identity",
  "mechanical",
  "electrical",
  "firmware",
  "system",
  "storage",
  "assembly",
  "commissioning",
  "routing",
  "thermal",
  "acoustic",
  "procurement",
] as const);

export type CompatibilityDomain = (typeof COMPATIBILITY_DOMAINS)[number];
export type ProgressiveVerdict = EvaluationDecision["verdict"] | "unknown";
export type RuleSafetyClass = "normal" | "boot" | "electrical_safety";

export interface MissingComponentRequirementDeclaration {
  kind: "component";
  criticality: RequirementNode["criticality"];
  requiredBefore?: RequirementNode["requiredBefore"];
}

export interface RequiredComponentKindDeclaration {
  componentKind: ComponentKindId;
  minCount: number;
  missing: MissingComponentRequirementDeclaration;
}

export interface RequiredFactDeclaration {
  componentKind: ComponentKindId;
  field: string;
  cardinality: "single" | "many";
  safetyClass: RuleSafetyClass;
  requiredAuthority: "governed" | "official";
  minimumScope: "family" | "model" | "variant" | "revision" | "plan_subject";
  missingRequirementKind: Extract<RequirementKind, "evidence" | "measurement">;
}

export interface RequiredPlacementDeclaration {
  componentKind: ComponentKindId;
  mountOwnerKind: ComponentKindId;
  minCount: number;
}

export interface RequiredConnectionDeclaration {
  fromKind: ComponentKindId;
  toKind: ComponentKindId;
  minCount: number;
  cableRequired: boolean;
}

export interface RequiredSystemProfileDeclaration {
  required: boolean;
  allowedProfileIds: SystemProfileId[];
}

export interface RequiredIdentityClosureDeclaration {
  allPresentComponents: true;
  safetyClass: RuleSafetyClass;
  missingRequirementKind: "evidence";
}

export interface RequiredNestedEvaluationDeclaration {
  assemblySafety: boolean;
  firmwarePaths: boolean;
  systemProfileChecks: boolean;
  thermalAcoustic: boolean;
}

export interface RequiredAdapterResourceDeclaration {
  resourcePatterns: boolean;
  bundleItems: boolean;
}

/**
 * Serializable dependency declaration. Executable rules are bound separately
 * by the locked engine artifact; this object never carries code or predicates.
 */
export interface CompatibilityRuleDefinition {
  schemaVersion: typeof COMPATIBILITY_RULE_DEFINITION_SCHEMA_VERSION;
  ruleId: string;
  ruleVersion: string;
  domain: CompatibilityDomain;
  description: string;
  safetyClass: RuleSafetyClass;
  activation: {
    topology: "always" | "non_empty";
    anyComponentKinds: ComponentKindId[];
  };
  requiredInputs: {
    componentKinds: RequiredComponentKindDeclaration[];
    facts: RequiredFactDeclaration[];
    placements: RequiredPlacementDeclaration[];
    connections: RequiredConnectionDeclaration[];
    systemProfile: RequiredSystemProfileDeclaration | null;
    identityClosure: RequiredIdentityClosureDeclaration | null;
    nestedEvaluations: RequiredNestedEvaluationDeclaration;
    adapterResources: RequiredAdapterResourceDeclaration;
    logicalLayouts: boolean;
  };
}

export type MissingRuleInput =
  | {
      kind: "component";
      ref: string;
      instanceIds: string[];
      safetyClass: RuleSafetyClass;
    }
  | {
      kind: "fact";
      ref: string;
      instanceIds: string[];
      safetyClass: RuleSafetyClass;
    }
  | {
      kind: "placement" | "connection" | "system_profile";
      ref: string;
      instanceIds: string[];
      safetyClass: RuleSafetyClass;
    };

export interface RuleEvaluationRecord {
  ruleId: string;
  ruleVersion: string;
  domain: CompatibilityDomain;
  applicability: "applicable" | "not_applicable";
  verdict: ProgressiveVerdict | "not_applicable";
  inputStatus: "complete" | "missing" | "conflicted";
  decisionIds: string[];
  requirementIds: string[];
  conflictSetIds: string[];
  missingInputs: MissingRuleInput[];
}

export interface DomainEvaluatedCoverage {
  registeredRuleCount: number;
  applicableRuleCount: number;
  evaluatedRuleCount: number;
  blockedRuleCount: number;
  unknownRuleCount: number;
}

export interface DomainEvaluation {
  domain: CompatibilityDomain;
  verdict: ProgressiveVerdict;
  registeredRuleIds: string[];
  applicableRuleIds: string[];
  evaluatedRuleIds: string[];
  blockedRuleIds: string[];
  unknownRuleIds: string[];
  decisionIds: string[];
  requirementIds: string[];
  conflictSetIds: string[];
  evaluatedCoverage: DomainEvaluatedCoverage;
}

export interface ProgressiveEvaluationCoverage {
  totalDomainCount: number;
  registeredRuleCount: number;
  evaluatedDomainCount: number;
  applicableRuleCount: number;
  evaluatedRuleCount: number;
  blockedRuleCount: number;
  unknownRuleCount: number;
}

export interface ProgressiveBuildReadiness {
  profileCompleteness: "empty" | "partial" | "complete";
  identityCompleteness: "empty" | "partial" | "complete";
  compatibilityVerdict: ProgressiveVerdict;
  systemAvailabilityVerdict: ProgressiveVerdict;
  assemblyReady: boolean;
  powerReady: boolean;
  firstBootReady: boolean;
  osInstallReady: boolean;
}

export interface ProgressiveEvaluationAuthority {
  schemaVersion: "progressive-evaluation-authority-v1";
  evaluationLockHash: string;
  artifactLockfileHash: string;
  configHash: string;
  snapshotHashes: SnapshotHashes;
  ruleSet: { ref: string; contentHash: string };
  engine: { ref: string; contentHash: string };
  adapterSnapshot: { ref: string; contentHash: string };
}

export interface ProgressiveKnownPriceLine {
  instanceId: string;
  skuId: string;
  quantity: 1;
  status: "known";
  priceCny: number;
  currency: "CNY";
  platform: PricePlatform;
  quoteContentHash: string;
  provenanceId: string | null;
  listingUrl: string;
}

export interface ProgressiveUnknownResolvedPriceLine {
  instanceId: string;
  skuId: string;
  quantity: 1;
  status: "unknown";
  reason: "no_audited_exact_variant_quote";
}

export interface ProgressiveUnknownIdentityPriceLine {
  instanceId: string;
  quantity: 1;
  status: "unknown";
  reason: "identity_unresolved";
}

export type ProgressivePriceLine =
  | ProgressiveKnownPriceLine
  | ProgressiveUnknownResolvedPriceLine
  | ProgressiveUnknownIdentityPriceLine;

/**
 * Deterministic projection of the exact price artifact locked by this
 * evaluation. It is informative for known instances, never a purchase gate.
 */
export interface ProgressivePriceProjection {
  schemaVersion: "progressive-price-projection-v1";
  priceSnapshotRef: string;
  priceSnapshotHash: string;
  snapshotId: string;
  asOf: string;
  lines: ProgressivePriceLine[];
  knownSubtotalCny: number;
  unknownInstanceIds: string[];
  complete: boolean;
}

/**
 * The V3 evaluator payload is deliberately hash-free. The authoritative
 * evaluation identity is issued by the outer receipt and binds this payload to
 * the exact locked inputs repeated below for offline verification.
 */
export interface ProgressiveBuildEvaluation {
  schemaVersion: typeof PROGRESSIVE_BUILD_EVALUATION_SCHEMA_VERSION;
  kind: "topology-v3-progressive";
  configSchemaVersion: BuildConfigV3["schemaVersion"];
  authority: ProgressiveEvaluationAuthority;
  topologyBom: TopologyBomLine[];
  priceProjection: ProgressivePriceProjection;
  decisions: EvaluationDecision[];
  requirements: RequirementNode[];
  requirementClosure: RequirementClosureResult;
  requirementAllocation: RequirementAllocationResult;
  requirementReadiness: RequirementReadiness;
  firmwareEvaluations: FirmwarePathEvaluation[];
  firmwareCapabilities: FirmwareCapability[];
  assemblySafetyEvaluations: AssemblySafetyEvaluation[];
  thermalAcousticEvaluation: ProductionThermalAcousticEvaluation;
  ruleEvaluations: RuleEvaluationRecord[];
  domainEvaluations: DomainEvaluation[];
  coverage: ProgressiveEvaluationCoverage;
  readiness: ProgressiveBuildReadiness;
}

export interface CompatibilityRuleContext {
  readonly components: readonly ComponentInstance[];
  readonly placements: readonly PlacementEdge[];
  readonly connections: readonly ConnectionEdge[];
  readonly systemProfile: Readonly<BuildConfigV3["system"]>;
  readonly firmwareEvaluations: readonly FirmwarePathEvaluation[];
  readonly firmwareTargets: readonly BuildConfigV3["firmwareTargets"][number][];
  readonly assemblySafetyEvaluations: readonly AssemblySafetyEvaluation[];
  readonly systemProfileEvaluation: Readonly<SystemProfileEvaluation> | null;
  readonly thermalAcousticEvaluation: Readonly<ProductionThermalAcousticEvaluation> | null;
  readonly logicalLayouts: readonly BuildConfigV3["logicalLayouts"][number][];
  componentsOfKind(kind: ComponentKindId): readonly ComponentInstance[];
  factsFor(instance: ComponentInstance, field: string): readonly FactRecord[];
  identityFactsFor(instance: ComponentInstance): readonly FactRecord[];
}

export interface CompatibilityRuleExecutionResult {
  decisions: EvaluationDecision[];
  requirements?: RequirementNode[];
}

export interface GovernedCompatibilityRule {
  readonly definition: CompatibilityRuleDefinition;
  evaluate(context: CompatibilityRuleContext): CompatibilityRuleExecutionResult;
}

export interface CompatibilityRuleManifestEntry {
  ruleId: string;
  ruleVersion: string;
  domain: CompatibilityDomain;
  implementationModuleIds: string[];
  definitionHash: string;
}

/** Strict, total, JS-shared validation. It never normalizes hostile input. */
export function validateProgressiveBuildEvaluation(value: unknown): string[] {
  return validateProgressiveBuildEvaluationRuntime(value);
}

export function isProgressiveBuildEvaluation(value: unknown): value is ProgressiveBuildEvaluation {
  return validateProgressiveBuildEvaluation(value).length === 0;
}

export function assertProgressiveBuildEvaluation(value: unknown): asserts value is ProgressiveBuildEvaluation {
  const errors = validateProgressiveBuildEvaluation(value);
  if (errors.length) throw new TypeError(`Invalid ProgressiveBuildEvaluation: ${errors.join("; ")}`);
}

export function validateCompatibilityRuleDefinition(value: unknown): string[] {
  return validateCompatibilityRuleDefinitionRuntime(value);
}

export function compatibilityRuleDefinitionHash(value: unknown): string {
  const hash = compatibilityRuleDefinitionHashRuntime(value);
  if (hash === null) throw new TypeError("Compatibility rule definition is not canonical");
  return hash;
}

export function validateProgressiveBuildEvaluationClosure(
  value: unknown,
  context: ProgressiveEvaluationClosureContextRuntime,
): string[] {
  return validateProgressiveBuildEvaluationClosureRuntime(value, context);
}

export function progressiveEvaluationReferences(
  value: unknown,
  firmwareCapabilities?: readonly unknown[],
): ProgressiveEvaluationReferencesRuntime | null {
  return progressiveEvaluationReferencesRuntime(value, firmwareCapabilities);
}
