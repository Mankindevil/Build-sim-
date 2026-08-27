import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { PriceSnapshotFile } from "../price/types";

export interface RuntimePriceSnapshotOptions {
  runtimeRoot?: string;
  /** Trusted root resolved once for a catalog+price consistent snapshot. */
  activeRoot?: string;
  /** Packaged data is only valid for explicit offline fixtures, never production authority. */
  allowSeedFallback?: boolean;
}

export function resolveActiveGenerationRoot(runtimeRootValue: string): string {
  const runtimeRoot = path.resolve(runtimeRootValue);
  const pointerPath = path.join(runtimeRoot, "control", "active-pointer.json");
  const pointer: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
  if (!pointer || typeof pointer !== "object") throw new Error("runtime active pointer is invalid");
  const activeRoot = (pointer as { activeRoot?: unknown }).activeRoot;
  if (typeof activeRoot !== "string" || !/^generations\/[1-9]\d*$/.test(activeRoot)) throw new Error("runtime active pointer has invalid activeRoot");
  const resolved = path.resolve(runtimeRoot, activeRoot);
  const relative = path.relative(runtimeRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("runtime active pointer escapes its root");
  return resolved;
}

function validSnapshot(value: unknown, options: { allowLegacy: boolean }): value is PriceSnapshotFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as PriceSnapshotFile).quotes) || typeof (value as PriceSnapshotFile).schemaVersion !== "string") return false;
  const snapshot = value as PriceSnapshotFile & { contentHash?: unknown };
  if (snapshot.contentHash === undefined) return options.allowLegacy;
  if (typeof snapshot.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.contentHash)) return false;
  const { contentHash, ...material } = snapshot;
  return createHash("sha256").update(JSON.stringify(material)).digest("hex") === contentHash;
}

export function runtimePriceSnapshotPath(options: RuntimePriceSnapshotOptions = {}): string {
  const root = path.resolve(options.runtimeRoot ?? process.env.PRICE_RUNTIME_ROOT ?? process.env.RUNTIME_ROOT ?? path.join(process.cwd(), "runtime"));
  // Deliberately re-read the pointer for every evaluator invocation. A restore
  // flips generations atomically; caching this path would resurrect old data.
  const activeRoot = options.activeRoot ? path.resolve(options.activeRoot) : resolveActiveGenerationRoot(root);
  const relative = path.relative(root, activeRoot);
  if (!/^generations[/\\][1-9]\d*$/.test(relative) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("trusted runtime active root is outside the configured runtime generation");
  }
  return path.join(activeRoot, "prices", "latest.json");
}

/** Synchronous by design: evaluator calls are synchronous and snapshot reads are tiny. */
export function loadRuntimePriceSnapshot(options: RuntimePriceSnapshotOptions = {}): PriceSnapshotFile {
  // Resolve the pointer inside the guarded read so a missing uninitialised
  // runtime can use the explicit offline seed policy below. Production callers
  // still fail closed when that policy is not enabled.
  let runtimePath = "<active runtime price snapshot>";
  try {
    runtimePath = runtimePriceSnapshotPath(options);
    const value: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
    if (!validSnapshot(value, { allowLegacy: false })) throw new Error("runtime price snapshot schema/hash is invalid");
    return value;
  } catch (error) {
    // Test fixtures that use the process-wide bundled catalog may opt into the
    // seed implicitly, but an explicit runtime root is always authoritative.
    // This keeps a missing/partial restored generation from being masked by
    // the image seed in runtime and integration tests.
    const testFallback = (process.env.NODE_ENV === "test" || process.env.VITEST === "true")
      && options.runtimeRoot === undefined;
    if (!options.allowSeedFallback && process.env.PRICE_OFFLINE_SEED_FALLBACK !== "true" && !testFallback) {
      throw new Error(`authoritative runtime price snapshot is unavailable at ${runtimePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const seedPath = path.resolve(process.cwd(), "data/prices/latest.json");
    const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
    if (!validSnapshot(seed, { allowLegacy: true })) throw new Error("offline price seed snapshot schema is invalid");
    return seed;
  }
}
