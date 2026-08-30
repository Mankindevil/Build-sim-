import { hashContent } from "../hash";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isNfcText,
  isPortableId,
  isPositiveSafeInteger,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
} from "../capabilities/validation";

export const HARDWARE_STANDARD_FAMILIES = Object.freeze([
  "cpu_socket", "dimm", "pcie", "m2", "sata", "slimsas", "usb", "cooling_header", "power_connector",
] as const);
export type HardwareStandardFamily = (typeof HARDWARE_STANDARD_FAMILIES)[number];

export const STANDARD_PROPERTY_REGISTRY = deepFreeze({
  "socket.key": { valueType: "string" },
  "memory.generation": { valueType: "string" },
  "module.form_factor": { valueType: "string" },
  "pcie.generation": { valueType: "number" },
  "m2.key": { valueType: "string" },
  "connector.role": { valueType: "string" },
  "pin_count": { valueType: "number" },
  "lane_count": { valueType: "number" },
  "data_rate_gbps": { valueType: "number" },
  "control.methods": { valueType: "string_set" },
  "power.rails": { valueType: "string_set" },
  "mechanical.key": { valueType: "string" },
} as const);
export type StandardPropertyId = keyof typeof STANDARD_PROPERTY_REGISTRY;

export interface StandardProperty {
  propertyId: StandardPropertyId;
  value: string | number | readonly string[];
}

export interface HardwareStandardSeed {
  schemaVersion: "hardware-standard-v1";
  standardId: string;
  family: HardwareStandardFamily;
  revision: string;
  properties: StandardProperty[];
  matesWithStandardIds: string[];
  supersedesStandardIds: string[];
  sourceRefs: string[];
}

export interface HardwareStandard extends HardwareStandardSeed {
  contentHash: string;
}

export interface HardwareStandardLibrarySeed {
  schemaVersion: "hardware-standard-library-seed-v1";
  libraryVersion: string;
  standards: HardwareStandardSeed[];
}

export interface HardwareStandardLibrary {
  schemaVersion: "hardware-standard-library-v1";
  libraryVersion: string;
  standards: HardwareStandard[];
  contentHash: string;
}

const STANDARD_CONTRACT = Object.freeze({ domain: "artifact.standard-set", schemaVersion: "1.0.0" } as const);

const REQUIRED_PROPERTIES: Readonly<Record<HardwareStandardFamily, readonly StandardPropertyId[]>> = Object.freeze({
  cpu_socket: ["socket.key", "mechanical.key"],
  dimm: ["memory.generation", "module.form_factor", "pin_count", "mechanical.key"],
  pcie: ["pcie.generation", "lane_count", "connector.role", "mechanical.key"],
  m2: ["m2.key", "module.form_factor", "pcie.generation", "mechanical.key"],
  sata: ["connector.role", "data_rate_gbps", "mechanical.key"],
  slimsas: ["connector.role", "lane_count", "mechanical.key"],
  usb: ["connector.role", "data_rate_gbps", "mechanical.key"],
  cooling_header: ["connector.role", "pin_count", "control.methods", "mechanical.key"],
  power_connector: ["connector.role", "pin_count", "power.rails", "mechanical.key"],
});

function validateProperty(value: unknown): string[] {
  const property = safeRecord(value);
  if (!property || !hasExactKeys(property, ["propertyId", "value"])) return ["standard property shape invalid"];
  if (typeof property.propertyId !== "string" || !Object.prototype.hasOwnProperty.call(STANDARD_PROPERTY_REGISTRY, property.propertyId)) {
    return ["standard propertyId is not allowlisted"];
  }
  const definition = STANDARD_PROPERTY_REGISTRY[property.propertyId as StandardPropertyId];
  if (definition.valueType === "number") {
    return typeof property.value === "number" && Number.isFinite(property.value) && property.value > 0
      ? [] : ["standard numeric property value invalid"];
  }
  if (definition.valueType === "string_set") {
    return isUniquePortableIdArray(property.value) ? [] : ["standard string-set property value invalid"];
  }
  return isPortableId(property.value) ? [] : ["standard string property value invalid"];
}

function validateStandardUnsafe(value: unknown, requireHash: boolean): string[] {
  const standard = safeRecord(value);
  if (!standard) return ["hardware standard must be an object"];
  const required = ["schemaVersion", "standardId", "family", "revision", "properties", "matesWithStandardIds", "supersedesStandardIds", "sourceRefs"];
  const errors: string[] = [];
  if (!hasExactKeys(standard, required, requireHash ? ["contentHash"] : [])
    || (requireHash && !("contentHash" in standard))) errors.push("hardware standard contains unknown or missing fields");
  if (containsNonNfcText(standard)) errors.push("hardware standard contains non-NFC text");
  if (standard.schemaVersion !== "hardware-standard-v1") errors.push("hardware standard schemaVersion invalid");
  if (!isPortableId(standard.standardId) || !isNfcText(standard.revision)) errors.push("hardware standard identity invalid");
  if (!HARDWARE_STANDARD_FAMILIES.includes(standard.family as HardwareStandardFamily)) errors.push("hardware standard family invalid");
  if (!Array.isArray(standard.properties) || standard.properties.length === 0) errors.push("hardware standard properties invalid");
  else {
    standard.properties.forEach((property, index) => errors.push(...validateProperty(property).map((error) => `properties.${index}: ${error}`)));
    const ids = standard.properties.map((property) => safeRecord(property)?.propertyId).filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("hardware standard property IDs must be unique");
    if (HARDWARE_STANDARD_FAMILIES.includes(standard.family as HardwareStandardFamily)) {
      for (const propertyId of REQUIRED_PROPERTIES[standard.family as HardwareStandardFamily]) {
        if (!ids.includes(propertyId)) errors.push(`hardware standard missing required property ${propertyId}`);
      }
    }
  }
  for (const field of ["matesWithStandardIds", "supersedesStandardIds", "sourceRefs"] as const) {
    if (!isUniquePortableIdArray(standard[field], field === "sourceRefs")) errors.push(`hardware standard ${field} invalid`);
  }
  if (Array.isArray(standard.matesWithStandardIds) && standard.matesWithStandardIds.includes(standard.standardId)) errors.push("hardware standard cannot mate with itself explicitly");
  if (Array.isArray(standard.supersedesStandardIds) && standard.supersedesStandardIds.includes(standard.standardId)) errors.push("hardware standard cannot supersede itself");
  if (requireHash && !isSha256(standard.contentHash)) errors.push("hardware standard contentHash invalid");
  return errors;
}

export function validateHardwareStandardSeed(value: unknown): string[] {
  try { return validateStandardUnsafe(value, false); }
  catch { return ["hardware standard seed is inaccessible or invalid"]; }
}

export function validateHardwareStandard(value: unknown): string[] {
  try { return validateStandardUnsafe(value, true); }
  catch { return ["hardware standard is inaccessible or invalid"]; }
}

export function validateHardwareStandardLibrarySeed(value: unknown): string[] {
  try {
    const library = safeRecord(value);
    if (!library) return ["hardware standard library seed must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(library, ["schemaVersion", "libraryVersion", "standards"])) errors.push("hardware standard library seed contains unknown or missing fields");
    if (library.schemaVersion !== "hardware-standard-library-seed-v1" || !isPortableId(library.libraryVersion)) errors.push("hardware standard library seed identity invalid");
    if (!Array.isArray(library.standards) || library.standards.length === 0) errors.push("hardware standard library seed standards invalid");
    else library.standards.forEach((standard, index) => errors.push(...validateHardwareStandardSeed(standard).map((error) => `standards.${index}: ${error}`)));
    return errors;
  } catch {
    return ["hardware standard library seed is inaccessible or invalid"];
  }
}

export function validateHardwareStandardLibrary(value: unknown): string[] {
  try {
    const library = safeRecord(value);
    if (!library) return ["hardware standard library must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(library, ["schemaVersion", "libraryVersion", "standards", "contentHash"])) errors.push("hardware standard library contains unknown or missing fields");
    if (library.schemaVersion !== "hardware-standard-library-v1" || !isPortableId(library.libraryVersion)) errors.push("hardware standard library identity invalid");
    if (!isSha256(library.contentHash)) errors.push("hardware standard library contentHash invalid");
    if (!Array.isArray(library.standards) || library.standards.length === 0) errors.push("hardware standard library standards invalid");
    else {
      library.standards.forEach((standard, index) => errors.push(...validateHardwareStandard(standard).map((error) => `standards.${index}: ${error}`)));
      const ids = library.standards.map((standard) => safeRecord(standard)?.standardId).filter((id): id is string => typeof id === "string");
      if (new Set(ids).size !== ids.length) errors.push("hardware standard library standard IDs must be unique");
      const known = new Set(ids);
      for (const standard of library.standards) {
        const record = safeRecord(standard);
        if (!record) continue;
        for (const field of ["matesWithStandardIds", "supersedesStandardIds"] as const) {
          if (Array.isArray(record[field]) && record[field].some((id) => typeof id !== "string" || !known.has(id))) {
            errors.push(`hardware standard library ${String(record.standardId)} has unknown ${field} reference`);
          }
        }
      }
    }
    if (containsNonNfcText(library)) errors.push("hardware standard library contains non-NFC text");
    return errors;
  } catch {
    return ["hardware standard library is inaccessible or invalid"];
  }
}

function normalizeStandardSeed(seed: HardwareStandardSeed): HardwareStandardSeed {
  const normalized = normalizeNfcJson(seed);
  normalized.properties = normalized.properties.map((property) => ({
    ...property,
    ...(Array.isArray(property.value) ? { value: [...property.value].sort(compareCanonical) } : {}),
  })).sort((left, right) => compareCanonical(left.propertyId, right.propertyId));
  normalized.matesWithStandardIds = [...normalized.matesWithStandardIds].sort(compareCanonical);
  normalized.supersedesStandardIds = [...normalized.supersedesStandardIds].sort(compareCanonical);
  normalized.sourceRefs = [...normalized.sourceRefs].sort(compareCanonical);
  return normalized;
}

export async function hardwareStandardContentHash(value: HardwareStandardSeed | HardwareStandard): Promise<string> {
  return hashContent(value, STANDARD_CONTRACT);
}

export async function createHardwareStandard(seed: HardwareStandardSeed): Promise<HardwareStandard> {
  const normalized = normalizeStandardSeed(seed);
  const errors = validateHardwareStandardSeed(normalized);
  if (errors.length) throw new TypeError(`Invalid hardware standard: ${errors.join("; ")}`);
  const standard: HardwareStandard = { ...normalized, contentHash: await hardwareStandardContentHash(normalized) };
  return deepFreeze(standard) as HardwareStandard;
}

export async function verifyHardwareStandard(value: unknown): Promise<boolean> {
  if (validateHardwareStandard(value).length) return false;
  const standard = value as HardwareStandard;
  return standard.contentHash === await hardwareStandardContentHash(standard);
}

export async function createHardwareStandardLibrary(seed: HardwareStandardLibrarySeed): Promise<HardwareStandardLibrary> {
  const normalized = normalizeNfcJson(seed);
  const errors = validateHardwareStandardLibrarySeed(normalized);
  if (errors.length) throw new TypeError(`Invalid hardware standard library seed: ${errors.join("; ")}`);
  const standards = await Promise.all(normalized.standards.map(createHardwareStandard));
  standards.sort((left, right) => compareCanonical(left.standardId, right.standardId));
  const material = {
    schemaVersion: "hardware-standard-library-v1" as const,
    libraryVersion: normalized.libraryVersion,
    standards,
  };
  const library: HardwareStandardLibrary = { ...material, contentHash: await hashContent(material, STANDARD_CONTRACT) };
  const libraryErrors = validateHardwareStandardLibrary(library);
  if (libraryErrors.length) throw new TypeError(`Invalid hardware standard library: ${libraryErrors.join("; ")}`);
  return deepFreeze(library) as HardwareStandardLibrary;
}

export async function verifyHardwareStandardLibrary(value: unknown): Promise<boolean> {
  if (validateHardwareStandardLibrary(value).length) return false;
  const library = value as HardwareStandardLibrary;
  if (!(await Promise.all(library.standards.map(verifyHardwareStandard))).every(Boolean)) return false;
  return library.contentHash === await hashContent({
    schemaVersion: library.schemaVersion,
    libraryVersion: library.libraryVersion,
    standards: library.standards,
  }, STANDARD_CONTRACT);
}
