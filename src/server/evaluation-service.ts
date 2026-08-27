import { createHash } from "node:crypto";
import path from "node:path";
import { parseConfig, type BuildConfig } from "../config/types";
import { assertValidConfig } from "../config/validate";
import { evaluateBuild, type BuildEvaluation } from "../core/evaluate";
import { authoritativeEvaluationPayload, stableAgentJson, AGENT_EVALUATION_SCHEMA_VERSION } from "../agent/evaluation-contract";
import type { SkuCatalog } from "../sku/types";
import type { PriceSnapshotFile } from "../price/types";
import { applyPriceSnapshot } from "../price/merge";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { loadRuntimePriceSnapshot, resolveActiveGenerationRoot } from "./runtime-price-snapshot";

export interface AuthoritativeEvaluationResponse {
  schemaVersion: typeof AGENT_EVALUATION_SCHEMA_VERSION;
  configHash: string;
  evaluationHash: string;
  catalogVersion: string;
  priceSnapshotVersion: string;
  evaluation: BuildEvaluation;
}
interface AuthoritativeCatalogRepositoryOptions {
  persistRoot?: string;
  runtimeRoot?: string;
  generationAware?: boolean;
  baseCatalogPath?: string;
  priceRuntimeRoot?: string;
  allowSeedPriceFallback?: boolean;
}

let catalogRepositoryOptions: AuthoritativeCatalogRepositoryOptions = {};

export function sha256AgentValue(value: unknown): string {
  return createHash("sha256").update(stableAgentJson(value)).digest("hex");
}

export function configureAuthoritativeCatalogRepository(options: AuthoritativeCatalogRepositoryOptions): void {
  catalogRepositoryOptions = { ...options };
}

function configuredRuntimeRoot(): string | undefined {
  const configured = [catalogRepositoryOptions.runtimeRoot, catalogRepositoryOptions.priceRuntimeRoot]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => path.resolve(value));
  if (new Set(configured).size > 1) throw new Error("catalog and price runtime roots must resolve to the same active generation");
  return configured[0];
}

function consistentRuntimeSnapshot(): { runtimeRoot: string; activeRoot: string; priceSnapshot: PriceSnapshotFile } | null {
  const runtimeRoot = configuredRuntimeRoot();
  if (!runtimeRoot) return null;
  const activeRoot = resolveActiveGenerationRoot(runtimeRoot);
  return {
    runtimeRoot,
    activeRoot,
    priceSnapshot: loadRuntimePriceSnapshot({ runtimeRoot, activeRoot, allowSeedFallback: false }),
  };
}

function catalogReadOptions(): AuthoritativeCatalogRepositoryOptions & { direct?: boolean } {
  if (configuredRuntimeRoot() || catalogRepositoryOptions.generationAware === true) return catalogRepositoryOptions;
  // Unit/offline callers without a runtime root consume the immutable seed (and
  // an explicitly configured legacy test overlay) rather than inventing an
  // uninitialised active-generation pointer in the source checkout.
  return { ...catalogRepositoryOptions, direct: true, generationAware: false };
}

export function loadAuthoritativeCatalog(snapshot?: PriceSnapshotFile): SkuCatalog {
  // An evaluation must bind its catalog merge and reported price version to the
  // same immutable generation. Callers that already resolved a snapshot pass it
  // through instead of resolving the active pointer a second time.
  const consistent = consistentRuntimeSnapshot();
  if (consistent) {
    const catalog = loadMergedCatalogSync({ ...catalogRepositoryOptions, activeRoot: consistent.activeRoot, generationAware: true }) as SkuCatalog;
    return applyPriceSnapshot(catalog, snapshot ?? consistent.priceSnapshot);
  }
  return applyPriceSnapshot(loadMergedCatalogSync(catalogReadOptions()) as SkuCatalog, snapshot ?? loadAuthoritativePriceSnapshot());
}

export function loadAuthoritativeCatalogAtRoot(activeRoot: string, options: { runtimeRoot?: string } = {}): SkuCatalog {
  return loadMergedCatalogSync({
    activeRoot,
    ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
    generationAware: true,
  }) as SkuCatalog;
}

export function loadAuthoritativePriceSnapshot() {
  return loadRuntimePriceSnapshot({
    ...(catalogRepositoryOptions.priceRuntimeRoot ?? catalogRepositoryOptions.runtimeRoot ?? catalogRepositoryOptions.persistRoot ? { runtimeRoot: catalogRepositoryOptions.priceRuntimeRoot ?? catalogRepositoryOptions.runtimeRoot ?? catalogRepositoryOptions.persistRoot } : {}),
    ...(catalogRepositoryOptions.allowSeedPriceFallback !== undefined ? { allowSeedFallback: catalogRepositoryOptions.allowSeedPriceFallback } : {}),
  });
}

export function parseAuthoritativeBuildConfig(value: unknown, catalog: SkuCatalog = loadAuthoritativeCatalog()): BuildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("buildConfig must be an object");
  const config = parseConfig(JSON.stringify(value));
  assertValidConfig(config, catalog);
  return config;
}

export function evaluateBuildAuthoritatively(value: unknown, catalog?: SkuCatalog): AuthoritativeEvaluationResponse {
  const consistent = catalog ? null : consistentRuntimeSnapshot();
  const snapshot = consistent?.priceSnapshot ?? loadAuthoritativePriceSnapshot();
  // When the caller did not supply a pre-resolved catalog, merge the exact
  // snapshot selected above. This avoids a restore/pointer switch between the
  // catalog read and the version reported in the response.
  const resolvedCatalog = catalog ?? (consistent
    ? applyPriceSnapshot(loadMergedCatalogSync({ ...catalogRepositoryOptions, activeRoot: consistent.activeRoot, generationAware: true }) as SkuCatalog, snapshot)
    : loadAuthoritativeCatalog(snapshot));
  const config = parseAuthoritativeBuildConfig(value, resolvedCatalog);
  const evaluation = evaluateBuild(config, resolvedCatalog);
  const payload = authoritativeEvaluationPayload(evaluation);
  return {
    schemaVersion: AGENT_EVALUATION_SCHEMA_VERSION,
    configHash: sha256AgentValue(config),
    evaluationHash: sha256AgentValue(payload),
    catalogVersion: resolvedCatalog.catalogVersion ?? `${resolvedCatalog.schemaVersion}:${resolvedCatalog.updatedAt}`,
    priceSnapshotVersion: `${snapshot.schemaVersion}:${snapshot.asOf}`,
    evaluation,
  };
}
