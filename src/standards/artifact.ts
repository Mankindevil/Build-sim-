import bundledSeedBytes from "../../data/standards/hardware-standards.json?raw";
import { canonicalize } from "../hash";
import { compareCanonical, deepFreeze, hasExactKeys, safeRecord } from "../capabilities/validation";
import {
  createHardwareStandardLibrary,
  validateHardwareStandardLibrarySeed,
  verifyHardwareStandardLibrary,
  type HardwareStandardLibrary,
  type HardwareStandardLibrarySeed,
} from "./contracts";

export interface WorkspaceArtifactSource {
  moduleId: string;
  bytes: string;
}

export interface WorkspaceStandardSetPayload {
  schemaVersion: "workspace-standard-set-v1";
  standardIds: string[];
  library: HardwareStandardLibrary;
  sources: WorkspaceArtifactSource[];
}

export const HARDWARE_STANDARD_SEED_MODULE_ID = "data/standards/hardware-standards.json";

function parseSeed(bytes: string): HardwareStandardLibrarySeed {
  let value: unknown;
  try { value = JSON.parse(bytes); }
  catch { throw new TypeError("hardware standard seed bytes are not valid JSON"); }
  const errors = validateHardwareStandardLibrarySeed(value);
  if (errors.length) throw new TypeError(`Invalid hardware standard seed bytes: ${errors.join("; ")}`);
  return value as HardwareStandardLibrarySeed;
}

function normalizeSources(seedBytes: string, sources: readonly WorkspaceArtifactSource[]): WorkspaceArtifactSource[] {
  const result = [
    { moduleId: HARDWARE_STANDARD_SEED_MODULE_ID, bytes: seedBytes },
    ...sources.filter((source) => source.moduleId !== HARDWARE_STANDARD_SEED_MODULE_ID),
  ].map((source) => ({ moduleId: source.moduleId.normalize("NFC"), bytes: source.bytes }));
  result.sort((left, right) => compareCanonical(left.moduleId, right.moduleId));
  if (result.some((source) => !source.moduleId || !source.bytes) || new Set(result.map((source) => source.moduleId)).size !== result.length) {
    throw new TypeError("workspace standard artifact sources invalid or duplicated");
  }
  return result;
}

export async function createWorkspaceStandardSetPayload(
  seedBytes: string,
  sources: readonly WorkspaceArtifactSource[] = [],
): Promise<WorkspaceStandardSetPayload> {
  const library = await createHardwareStandardLibrary(parseSeed(seedBytes));
  const payload: WorkspaceStandardSetPayload = {
    schemaVersion: "workspace-standard-set-v1",
    standardIds: library.standards.map((standard) => standard.standardId).sort(compareCanonical),
    library,
    sources: normalizeSources(seedBytes, sources),
  };
  if (!await verifyWorkspaceStandardSetPayload(payload)) throw new TypeError("workspace standard artifact payload failed closure validation");
  return deepFreeze(payload) as WorkspaceStandardSetPayload;
}

export function createBundledWorkspaceStandardSetPayload(
  sources: readonly WorkspaceArtifactSource[] = [],
): Promise<WorkspaceStandardSetPayload> {
  return createWorkspaceStandardSetPayload(bundledSeedBytes, sources);
}

export async function verifyWorkspaceStandardSetPayload(value: unknown): Promise<boolean> {
  try {
    const payload = safeRecord(value);
    if (!payload || !hasExactKeys(payload, ["schemaVersion", "standardIds", "library", "sources"])
      || payload.schemaVersion !== "workspace-standard-set-v1"
      || !Array.isArray(payload.standardIds) || payload.standardIds.length === 0
      || payload.standardIds.some((id) => typeof id !== "string" || !id)
      || new Set(payload.standardIds).size !== payload.standardIds.length
      || !Array.isArray(payload.sources) || payload.sources.length === 0) return false;
    const sources = payload.sources.map(safeRecord);
    if (sources.some((source) => !source || !hasExactKeys(source, ["moduleId", "bytes"])
      || typeof source.moduleId !== "string" || !source.moduleId
      || typeof source.bytes !== "string" || !source.bytes)) return false;
    const moduleIds = sources.map((source) => source!.moduleId as string);
    if (new Set(moduleIds).size !== moduleIds.length) return false;
    const seedSource = sources.find((source) => source!.moduleId === HARDWARE_STANDARD_SEED_MODULE_ID);
    if (!seedSource) return false;
    const seed = parseSeed(seedSource.bytes as string);
    const rebuilt = await createHardwareStandardLibrary(seed);
    if (!await verifyHardwareStandardLibrary(payload.library)) return false;
    const library = payload.library as HardwareStandardLibrary;
    return canonicalize(rebuilt) === canonicalize(library)
      && canonicalize(payload.standardIds) === canonicalize(library.standards.map((standard) => standard.standardId).sort(compareCanonical));
  } catch {
    return false;
  }
}

export function bundledHardwareStandardSeedBytes(): string {
  return bundledSeedBytes;
}
