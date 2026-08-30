import { hashContent } from "../hash";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isFiniteNonNegative,
  isNfcText,
  isPortableId,
  isPositiveSafeInteger,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
} from "../capabilities/validation";

export type BundleItemKind = "cable" | "fastener" | "standoff" | "bracket" | "adapter" | "tool" | "consumable";
export type AssemblyNeedKind = "accessory" | BundleItemKind;
export type ResourceFacetId =
  | "resource.kind"
  | "cable.connector_standard"
  | "fastener.thread"
  | "fastener.length_mm"
  | "fastener.head"
  | "tool.drive"
  | "consumable.type"
  | "mount.standard"
  | "accessory.standard";
export type ResourceComparisonOperator = "eq" | "gte" | "lte" | "between" | "includes";

export const ASSEMBLY_RESOURCE_FACET_REGISTRY = deepFreeze({
  "resource.kind": { valueType: "string", operators: ["eq"] },
  "cable.connector_standard": { valueType: "string_set", operators: ["includes"] },
  "fastener.thread": { valueType: "string", operators: ["eq"] },
  "fastener.length_mm": { valueType: "number", operators: ["eq", "gte", "lte", "between"] },
  "fastener.head": { valueType: "string", operators: ["eq"] },
  "tool.drive": { valueType: "string", operators: ["eq"] },
  "consumable.type": { valueType: "string", operators: ["eq"] },
  "mount.standard": { valueType: "string", operators: ["eq"] },
  "accessory.standard": { valueType: "string", operators: ["eq"] },
} as const);

export interface ResourceFacet {
  facetId: ResourceFacetId;
  value: string | number | readonly string[];
}

export interface ResourceFacetPredicate {
  facetId: ResourceFacetId;
  operator: ResourceComparisonOperator;
  value: string | number | readonly [number, number];
}

export interface BundleItemInput {
  schemaVersion: "bundle-item-v1";
  bundleItemId: string;
  ownerSkuId: string;
  kind: BundleItemKind;
  specification: ResourceFacet[];
  quantity: number;
  region?: string;
  revision?: string;
  variantScopeFactIds: string[];
  evidenceFactIds: string[];
}

export interface BundleItem extends BundleItemInput {
  contentHash: string;
}

export interface InstanceSupply {
  schemaVersion: "instance-supply-v1";
  supplyId: string;
  ownerInstanceId: string;
  ownerSkuId: string;
  bundleItemId: string;
  bundleItemHash: string;
  kind: BundleItemKind;
  specification: ResourceFacet[];
  quantity: number;
  region?: string;
  revision?: string;
  evidenceFactIds: string[];
  contentHash: string;
}

export interface BundleProjectionInput {
  ownerInstanceId: string;
  ownerSkuId: string;
  region?: string;
  revision?: string;
  bundleItems: readonly BundleItem[];
}

export interface AssemblyResourceNeed {
  schemaVersion: "assembly-resource-need-v1";
  needId: string;
  neededByStepId: string;
  kind: AssemblyNeedKind;
  specification: ResourceFacetPredicate[];
  quantity: number;
  criticality: "normal" | "boot" | "safety";
  requiredBefore: "assembly" | "pre_power" | "first_boot" | "os_install";
  region?: string;
  revision?: string;
  evidenceFactIds: string[];
}

export interface AssemblyResourceNeedTemplate {
  needTemplateId: string;
  kind: AssemblyNeedKind;
  specification: ResourceFacetPredicate[];
  quantity: number;
  criticality: AssemblyResourceNeed["criticality"];
  requiredBefore: AssemblyResourceNeed["requiredBefore"];
}

export interface AssemblyResourcePatternInput {
  schemaVersion: "assembly-resource-pattern-v1";
  patternId: string;
  mountStandardIds: string[];
  needs: AssemblyResourceNeedTemplate[];
  evidenceFactIds: string[];
}

export interface AssemblyResourcePattern extends AssemblyResourcePatternInput {
  contentHash: string;
}

export interface BundleSupplyAllocation {
  allocationId: string;
  requirementId: string;
  ownerInstanceId: string;
  bundleItemId: string;
  instanceSupplyHash: string;
  quantity: number;
  region?: string;
  revision?: string;
}

export interface AssemblyResourceSatisfaction {
  requirementId: string;
  status: "satisfied" | "open";
  allocations: BundleSupplyAllocation[];
  residualQuantity: number;
}

export interface BundleAllocationResult {
  allocations: BundleSupplyAllocation[];
  satisfactions: AssemblyResourceSatisfaction[];
}

const CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);
const KINDS = new Set<BundleItemKind>(["cable", "fastener", "standoff", "bracket", "adapter", "tool", "consumable"]);
const NEED_KINDS = new Set<AssemblyNeedKind>(["accessory", ...KINDS]);

function validateResourceFacet(value: unknown): string[] {
  const facet = safeRecord(value);
  if (!facet || !hasExactKeys(facet, ["facetId", "value"])) return ["resource facet shape invalid"];
  if (typeof facet.facetId !== "string" || !Object.prototype.hasOwnProperty.call(ASSEMBLY_RESOURCE_FACET_REGISTRY, facet.facetId)) return ["resource facetId is not allowlisted"];
  const definition = ASSEMBLY_RESOURCE_FACET_REGISTRY[facet.facetId as ResourceFacetId];
  if (definition.valueType === "number") return typeof facet.value === "number" && Number.isFinite(facet.value) && facet.value >= 0 ? [] : ["resource numeric facet invalid"];
  if (definition.valueType === "string_set") return isUniquePortableIdArray(facet.value) ? [] : ["resource string-set facet invalid"];
  return isPortableId(facet.value) ? [] : ["resource string facet invalid"];
}

function validateResourcePredicate(value: unknown): string[] {
  const predicate = safeRecord(value);
  if (!predicate || !hasExactKeys(predicate, ["facetId", "operator", "value"])) return ["resource predicate shape invalid"];
  if (typeof predicate.facetId !== "string" || !Object.prototype.hasOwnProperty.call(ASSEMBLY_RESOURCE_FACET_REGISTRY, predicate.facetId)) return ["resource predicate facetId is not allowlisted"];
  const definition = ASSEMBLY_RESOURCE_FACET_REGISTRY[predicate.facetId as ResourceFacetId];
  if (typeof predicate.operator !== "string" || !(definition.operators as readonly string[]).includes(predicate.operator)) return ["resource predicate operator is not allowlisted for facet"];
  if (predicate.operator === "between") {
    return Array.isArray(predicate.value) && predicate.value.length === 2
      && predicate.value.every((item) => typeof item === "number" && Number.isFinite(item))
      && Number(predicate.value[0]) <= Number(predicate.value[1]) ? [] : ["resource between predicate invalid"];
  }
  if (definition.valueType === "number") return typeof predicate.value === "number" && Number.isFinite(predicate.value) ? [] : ["resource numeric predicate invalid"];
  return isPortableId(predicate.value) ? [] : ["resource string predicate invalid"];
}

function validateFacetSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return [`${label} invalid`];
  const errors: string[] = [];
  value.forEach((facet, index) => errors.push(...validateResourceFacet(facet).map((error) => `${label}.${index}: ${error}`)));
  const ids = value.map((facet) => safeRecord(facet)?.facetId).filter((id): id is string => typeof id === "string");
  if (new Set(ids).size !== ids.length) errors.push(`${label} facet IDs must be unique`);
  return errors;
}

function validatePredicateSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return [`${label} invalid`];
  const errors: string[] = [];
  value.forEach((predicate, index) => errors.push(...validateResourcePredicate(predicate).map((error) => `${label}.${index}: ${error}`)));
  const ids = value.map((predicate) => safeRecord(predicate)?.facetId).filter((id): id is string => typeof id === "string");
  if (new Set(ids).size !== ids.length) errors.push(`${label} facet IDs must be unique`);
  return errors;
}

function validateBundleItemUnsafe(value: unknown, requireHash: boolean): string[] {
  const item = safeRecord(value);
  if (!item) return ["bundle item must be an object"];
  const required = ["schemaVersion", "bundleItemId", "ownerSkuId", "kind", "specification", "quantity", "variantScopeFactIds", "evidenceFactIds"];
  const optional = ["region", "revision", ...(requireHash ? ["contentHash"] : [])];
  const errors: string[] = [];
  if (!hasExactKeys(item, required, optional) || (requireHash && !("contentHash" in item))) errors.push("bundle item contains unknown fields");
  if (containsNonNfcText(item)) errors.push("bundle item contains non-NFC text");
  if (item.schemaVersion !== "bundle-item-v1") errors.push("bundle item schemaVersion invalid");
  if (!isPortableId(item.bundleItemId) || !isPortableId(item.ownerSkuId)) errors.push("bundle item identity invalid");
  if (!KINDS.has(item.kind as BundleItemKind)) errors.push("bundle item kind invalid");
  errors.push(...validateFacetSet(item.specification, "bundle item specification"));
  if (Array.isArray(item.specification)) {
    const kindFacet = item.specification.map(safeRecord).find((facet) => facet?.facetId === "resource.kind");
    if (!kindFacet || kindFacet.value !== item.kind) errors.push("bundle item resource.kind must exactly match kind");
  }
  if (!isPositiveSafeInteger(item.quantity, 65_536)) errors.push("bundle item quantity invalid");
  if (item.region !== undefined && !isPortableId(item.region)) errors.push("bundle item region invalid");
  if (item.revision !== undefined && !isPortableId(item.revision)) errors.push("bundle item revision invalid");
  if (!isUniquePortableIdArray(item.variantScopeFactIds)) errors.push("bundle item variantScopeFactIds invalid");
  if (!isUniquePortableIdArray(item.evidenceFactIds)) errors.push("bundle item evidenceFactIds invalid");
  if (requireHash && !isSha256(item.contentHash)) errors.push("bundle item contentHash invalid");
  return errors;
}

export function validateBundleItemInput(value: unknown): string[] {
  try { return validateBundleItemUnsafe(value, false); }
  catch { return ["bundle item input is inaccessible or invalid"]; }
}

export function validateBundleItem(value: unknown): string[] {
  try { return validateBundleItemUnsafe(value, true); }
  catch { return ["bundle item is inaccessible or invalid"]; }
}

function normalizeFacetSet(facets: ResourceFacet[]): ResourceFacet[] {
  return facets.map((facet) => ({
    ...facet,
    ...(Array.isArray(facet.value) ? { value: [...facet.value].sort(compareCanonical) } : {}),
  })).sort((left, right) => compareCanonical(left.facetId, right.facetId));
}

function normalizePredicateSet(predicates: ResourceFacetPredicate[]): ResourceFacetPredicate[] {
  return [...predicates].sort((left, right) => compareCanonical(left.facetId, right.facetId));
}

export async function bundleItemContentHash(value: BundleItemInput | BundleItem): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createBundleItem(input: BundleItemInput): Promise<BundleItem> {
  const normalized = normalizeNfcJson(input);
  normalized.specification = normalizeFacetSet(normalized.specification);
  normalized.variantScopeFactIds.sort(compareCanonical);
  normalized.evidenceFactIds.sort(compareCanonical);
  const errors = validateBundleItemInput(normalized);
  if (errors.length) throw new TypeError(`Invalid bundle item: ${errors.join("; ")}`);
  const item: BundleItem = { ...normalized, contentHash: await bundleItemContentHash(normalized) };
  return deepFreeze(item) as BundleItem;
}

export async function verifyBundleItem(value: unknown): Promise<boolean> {
  if (validateBundleItem(value).length) return false;
  const item = value as BundleItem;
  return item.contentHash === await bundleItemContentHash(item);
}

function normalizePattern(input: AssemblyResourcePatternInput): AssemblyResourcePatternInput {
  const normalized = normalizeNfcJson(input);
  normalized.mountStandardIds.sort(compareCanonical);
  normalized.evidenceFactIds.sort(compareCanonical);
  normalized.needs = normalized.needs.map((need) => ({ ...need, specification: normalizePredicateSet(need.specification) }))
    .sort((left, right) => compareCanonical(left.needTemplateId, right.needTemplateId));
  return normalized;
}

function validateNeedTemplate(value: unknown): string[] {
  const need = safeRecord(value);
  if (!need || !hasExactKeys(need, ["needTemplateId", "kind", "specification", "quantity", "criticality", "requiredBefore"])) return ["resource need template shape invalid"];
  const errors: string[] = [];
  if (!isPortableId(need.needTemplateId) || !NEED_KINDS.has(need.kind as AssemblyNeedKind)) errors.push("resource need template identity/kind invalid");
  errors.push(...validatePredicateSet(need.specification, "resource need template specification"));
  if (!isPositiveSafeInteger(need.quantity, 65_536)) errors.push("resource need template quantity invalid");
  if (!["normal", "boot", "safety"].includes(String(need.criticality))) errors.push("resource need template criticality invalid");
  if (!["assembly", "pre_power", "first_boot", "os_install"].includes(String(need.requiredBefore))) errors.push("resource need template requiredBefore invalid");
  return errors;
}

function validatePatternUnsafe(value: unknown, requireHash: boolean): string[] {
  const pattern = safeRecord(value);
  if (!pattern) return ["assembly resource pattern must be an object"];
  const required = ["schemaVersion", "patternId", "mountStandardIds", "needs", "evidenceFactIds"];
  const errors: string[] = [];
  if (!hasExactKeys(pattern, required, requireHash ? ["contentHash"] : []) || (requireHash && !("contentHash" in pattern))) errors.push("assembly resource pattern contains unknown fields");
  if (containsNonNfcText(pattern)) errors.push("assembly resource pattern contains non-NFC text");
  if (pattern.schemaVersion !== "assembly-resource-pattern-v1" || !isPortableId(pattern.patternId)) errors.push("assembly resource pattern identity invalid");
  if (!isUniquePortableIdArray(pattern.mountStandardIds)) errors.push("assembly resource pattern mountStandardIds invalid");
  if (!Array.isArray(pattern.needs) || pattern.needs.length === 0) errors.push("assembly resource pattern needs invalid");
  else {
    pattern.needs.forEach((need, index) => errors.push(...validateNeedTemplate(need).map((error) => `needs.${index}: ${error}`)));
    const ids = pattern.needs.map((need) => safeRecord(need)?.needTemplateId).filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("assembly resource pattern need IDs must be unique");
  }
  if (!isUniquePortableIdArray(pattern.evidenceFactIds)) errors.push("assembly resource pattern evidenceFactIds invalid");
  if (requireHash && !isSha256(pattern.contentHash)) errors.push("assembly resource pattern contentHash invalid");
  return errors;
}

export function validateAssemblyResourcePattern(value: unknown): string[] {
  try { return validatePatternUnsafe(value, true); }
  catch { return ["assembly resource pattern is inaccessible or invalid"]; }
}

export async function createAssemblyResourcePattern(input: AssemblyResourcePatternInput): Promise<AssemblyResourcePattern> {
  const normalized = normalizePattern(input);
  const errors = validatePatternUnsafe(normalized, false);
  if (errors.length) throw new TypeError(`Invalid assembly resource pattern: ${errors.join("; ")}`);
  const pattern: AssemblyResourcePattern = { ...normalized, contentHash: await hashContent(normalized, CONTRACT) };
  return deepFreeze(pattern) as AssemblyResourcePattern;
}

export async function verifyAssemblyResourcePattern(value: unknown): Promise<boolean> {
  if (validateAssemblyResourcePattern(value).length) return false;
  const pattern = value as AssemblyResourcePattern;
  return pattern.contentHash === await hashContent(pattern, CONTRACT);
}

export async function deriveAssemblyResourceNeeds(
  pattern: AssemblyResourcePattern,
  context: { mountStandardId: string; neededByStepId: string; requirementIdPrefix: string; region?: string; revision?: string },
): Promise<AssemblyResourceNeed[]> {
  if (!await verifyAssemblyResourcePattern(pattern)) throw new TypeError("assembly resource pattern invalid or content hash mismatch");
  if (!hasExactKeys(context as unknown as Record<string, unknown>, ["mountStandardId", "neededByStepId", "requirementIdPrefix"], ["region", "revision"])) throw new TypeError("assembly resource need context contains unknown fields");
  if (!isPortableId(context.mountStandardId) || !isPortableId(context.neededByStepId) || !isPortableId(context.requirementIdPrefix)) throw new TypeError("assembly resource need context invalid");
  if ((context.region !== undefined && !isPortableId(context.region))
    || (context.revision !== undefined && !isPortableId(context.revision))) throw new TypeError("assembly resource need context scope invalid");
  if (!pattern.mountStandardIds.includes(context.mountStandardId)) return [];
  return pattern.needs.map((template) => ({
    schemaVersion: "assembly-resource-need-v1",
    needId: `${context.requirementIdPrefix}.${template.needTemplateId}`,
    neededByStepId: context.neededByStepId,
    kind: template.kind,
    specification: structuredClone(template.specification),
    quantity: template.quantity,
    criticality: template.criticality,
    requiredBefore: template.requiredBefore,
    ...(context.region !== undefined ? { region: context.region.normalize("NFC") } : {}),
    ...(context.revision !== undefined ? { revision: context.revision.normalize("NFC") } : {}),
    evidenceFactIds: structuredClone(pattern.evidenceFactIds),
  }));
}

function projectionScopeMatches(item: BundleItem, input: BundleProjectionInput): boolean {
  return item.ownerSkuId === input.ownerSkuId
    && (item.region === undefined || item.region === input.region)
    && (item.revision === undefined || item.revision === input.revision);
}

function supplyMaterial(item: BundleItem, input: BundleProjectionInput, supplyId: string) {
  return {
    schemaVersion: "instance-supply-v1" as const,
    supplyId,
    ownerInstanceId: input.ownerInstanceId.normalize("NFC"),
    ownerSkuId: input.ownerSkuId.normalize("NFC"),
    bundleItemId: item.bundleItemId,
    bundleItemHash: item.contentHash,
    kind: item.kind,
    specification: structuredClone(item.specification),
    quantity: item.quantity,
    ...(item.region !== undefined ? { region: item.region } : {}),
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
    evidenceFactIds: structuredClone(item.evidenceFactIds),
  };
}

export async function projectBundleItemsForOwner(input: BundleProjectionInput): Promise<InstanceSupply[]> {
  const inputRecord = safeRecord(input);
  if (!inputRecord || !hasExactKeys(inputRecord, ["ownerInstanceId", "ownerSkuId", "bundleItems"], ["region", "revision"])) throw new TypeError("bundle projection contains unknown or missing fields");
  if (!isPortableId(input.ownerInstanceId) || !isPortableId(input.ownerSkuId)
    || (input.region !== undefined && !isPortableId(input.region))
    || (input.revision !== undefined && !isPortableId(input.revision))) throw new TypeError("bundle projection owner scope invalid");
  if (!Array.isArray(input.bundleItems)) throw new TypeError("bundle projection items invalid");
  const pairs = new Set<string>();
  const supplies: InstanceSupply[] = [];
  for (const item of input.bundleItems) {
    if (!await verifyBundleItem(item)) throw new TypeError("bundle projection item invalid or content hash mismatch");
    if (!projectionScopeMatches(item, input)) continue;
    const pair = `${input.ownerInstanceId}\0${item.bundleItemId}`;
    if (pairs.has(pair)) throw new TypeError("duplicate ownerInstanceId + bundleItemId projection");
    pairs.add(pair);
    const identityHash = await hashContent({
      schemaVersion: "instance-supply-identity-v1",
      ownerInstanceId: input.ownerInstanceId,
      bundleItemId: item.bundleItemId,
      bundleItemHash: item.contentHash,
    }, CONTRACT);
    const material = supplyMaterial(item, input, `instance-supply-sha256-${identityHash}`);
    const supply = { ...material, contentHash: await hashContent(material, CONTRACT) } as InstanceSupply;
    const supplyErrors = validateInstanceSupply(supply);
    if (supplyErrors.length) throw new TypeError(`projected instance supply invalid: ${supplyErrors.join("; ")}`);
    supplies.push(deepFreeze(supply) as InstanceSupply);
  }
  return supplies.sort((left, right) => compareCanonical(left.supplyId, right.supplyId));
}

function facetSatisfies(facet: ResourceFacet | undefined, predicate: ResourceFacetPredicate): boolean {
  if (!facet) return false;
  if (predicate.operator === "includes") return Array.isArray(facet.value) && typeof predicate.value === "string" && facet.value.includes(predicate.value);
  if (predicate.operator === "eq") return facet.value === predicate.value;
  if (typeof facet.value !== "number") return false;
  if (predicate.operator === "gte") return typeof predicate.value === "number" && facet.value >= predicate.value;
  if (predicate.operator === "lte") return typeof predicate.value === "number" && facet.value <= predicate.value;
  return Array.isArray(predicate.value) && facet.value >= predicate.value[0] && facet.value <= predicate.value[1];
}

function supplyMatchesNeed(supply: InstanceSupply, need: AssemblyResourceNeed): boolean {
  return supply.kind === need.kind
    && (need.region === undefined || supply.region === need.region)
    && (need.revision === undefined || supply.revision === need.revision)
    && need.specification.every((predicate) => facetSatisfies(supply.specification.find((facet) => facet.facetId === predicate.facetId), predicate));
}

function validateNeed(value: unknown): string[] {
  const need = safeRecord(value);
  if (!need) return ["assembly resource need must be an object"];
  const required = ["schemaVersion", "needId", "neededByStepId", "kind", "specification", "quantity", "criticality", "requiredBefore", "evidenceFactIds"];
  const errors: string[] = [];
  if (!hasExactKeys(need, required, ["region", "revision"])) errors.push("assembly resource need contains unknown fields");
  if (need.schemaVersion !== "assembly-resource-need-v1" || !isPortableId(need.needId) || !isPortableId(need.neededByStepId) || !NEED_KINDS.has(need.kind as AssemblyNeedKind)) errors.push("assembly resource need identity/kind invalid");
  errors.push(...validatePredicateSet(need.specification, "assembly resource need specification"));
  if (!isPositiveSafeInteger(need.quantity, 65_536)) errors.push("assembly resource need quantity invalid");
  if (!["normal", "boot", "safety"].includes(String(need.criticality)) || !["assembly", "pre_power", "first_boot", "os_install"].includes(String(need.requiredBefore))) errors.push("assembly resource need gate invalid");
  if (need.region !== undefined && !isPortableId(need.region)) errors.push("assembly resource need region invalid");
  if (need.revision !== undefined && !isPortableId(need.revision)) errors.push("assembly resource need revision invalid");
  if (!isUniquePortableIdArray(need.evidenceFactIds)) errors.push("assembly resource need evidenceFactIds invalid");
  return errors;
}

export function validateInstanceSupply(value: unknown): string[] {
  try {
  const supply = safeRecord(value);
  if (!supply) return ["instance supply must be an object"];
  const required = ["schemaVersion", "supplyId", "ownerInstanceId", "ownerSkuId", "bundleItemId", "bundleItemHash", "kind", "specification", "quantity", "evidenceFactIds", "contentHash"];
  const errors: string[] = [];
  if (!hasExactKeys(supply, required, ["region", "revision"])) errors.push("instance supply contains unknown fields");
  if (supply.schemaVersion !== "instance-supply-v1" || ![supply.supplyId, supply.ownerInstanceId, supply.ownerSkuId, supply.bundleItemId].every(isPortableId)) errors.push("instance supply identity invalid");
  if (!isSha256(supply.bundleItemHash) || !isSha256(supply.contentHash)) errors.push("instance supply hash invalid");
  if (!KINDS.has(supply.kind as BundleItemKind)) errors.push("instance supply kind invalid");
  errors.push(...validateFacetSet(supply.specification, "instance supply specification"));
  if (Array.isArray(supply.specification)) {
    const kindFacet = supply.specification.map(safeRecord).find((facet) => facet?.facetId === "resource.kind");
    if (!kindFacet || kindFacet.value !== supply.kind) errors.push("instance supply resource.kind must exactly match kind");
  }
  if (!isPositiveSafeInteger(supply.quantity, 65_536)) errors.push("instance supply quantity invalid");
  if (supply.region !== undefined && !isPortableId(supply.region)) errors.push("instance supply region invalid");
  if (supply.revision !== undefined && !isPortableId(supply.revision)) errors.push("instance supply revision invalid");
  if (!isUniquePortableIdArray(supply.evidenceFactIds)) errors.push("instance supply evidenceFactIds invalid");
  return errors;
  } catch {
    return ["instance supply is inaccessible or invalid"];
  }
}

export async function verifyInstanceSupply(value: unknown): Promise<boolean> {
  if (validateInstanceSupply(value).length) return false;
  const supply = value as InstanceSupply;
  return supply.contentHash === await hashContent(supply, CONTRACT);
}

export async function allocateBundleSupplies(
  needs: readonly AssemblyResourceNeed[],
  supplies: readonly InstanceSupply[],
): Promise<BundleAllocationResult> {
  if (!Array.isArray(needs) || !Array.isArray(supplies)) throw new TypeError("bundle allocation inputs must be arrays");
  for (const need of needs) {
    const errors = validateNeed(need);
    if (errors.length) throw new TypeError(`Invalid assembly resource need: ${errors.join("; ")}`);
  }
  if (new Set(needs.map((need) => need.needId)).size !== needs.length) throw new TypeError("assembly resource need IDs must be unique");
  for (const supply of supplies) if (!await verifyInstanceSupply(supply)) throw new TypeError("instance supply invalid or content hash mismatch");
  const supplyPairs = supplies.map((supply) => `${supply.ownerInstanceId}\0${supply.bundleItemId}`);
  if (new Set(supplyPairs).size !== supplyPairs.length) throw new TypeError("instance supplies duplicate ownerInstanceId + bundleItemId");
  const remaining = new Map(supplies.map((supply) => [`${supply.ownerInstanceId}\0${supply.bundleItemId}`, supply.quantity]));
  const orderedSupplies = [...supplies].sort((left, right) => compareCanonical(`${left.ownerInstanceId}\0${left.bundleItemId}`, `${right.ownerInstanceId}\0${right.bundleItemId}`));
  const allocations: BundleSupplyAllocation[] = [];
  const satisfactions: AssemblyResourceSatisfaction[] = [];
  for (const need of needs) {
    let residual = need.quantity;
    const needAllocations: BundleSupplyAllocation[] = [];
    for (const supply of orderedSupplies) {
      if (residual <= 0 || !supplyMatchesNeed(supply, need)) continue;
      const key = `${supply.ownerInstanceId}\0${supply.bundleItemId}`;
      const available = remaining.get(key) ?? 0;
      if (available <= 0) continue;
      const quantity = Math.min(available, residual);
      const allocationMaterial = {
        requirementId: need.needId,
        ownerInstanceId: supply.ownerInstanceId,
        bundleItemId: supply.bundleItemId,
        instanceSupplyHash: supply.contentHash,
        quantity,
        ...(supply.region !== undefined ? { region: supply.region } : {}),
        ...(supply.revision !== undefined ? { revision: supply.revision } : {}),
      };
      const allocationHash = await hashContent(allocationMaterial, CONTRACT);
      const allocation: BundleSupplyAllocation = {
        allocationId: `bundle-allocation-sha256-${allocationHash}`,
        ...allocationMaterial,
      };
      remaining.set(key, available - quantity);
      residual -= quantity;
      needAllocations.push(allocation);
      allocations.push(allocation);
    }
    satisfactions.push({
      requirementId: need.needId,
      status: residual === 0 ? "satisfied" : "open",
      allocations: needAllocations,
      residualQuantity: residual,
    });
  }
  return { allocations, satisfactions };
}
