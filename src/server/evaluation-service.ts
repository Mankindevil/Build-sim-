import { createHash } from "node:crypto";
import { parseConfig, type BuildConfig } from "../config/types";
import { assertValidConfig } from "../config/validate";
import { evaluateBuild, type BuildEvaluation } from "../core/evaluate";
import { authoritativeEvaluationPayload, stableAgentJson, AGENT_EVALUATION_SCHEMA_VERSION } from "../agent/evaluation-contract";
import { loadBundledPriceSnapshot } from "../sku/catalog";
import type { SkuCatalog } from "../sku/types";
import { applyPriceSnapshot } from "../price/merge";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";

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
  baseCatalogPath?: string;
}

let catalogRepositoryOptions: AuthoritativeCatalogRepositoryOptions = {};

export function sha256AgentValue(value: unknown): string {
  return createHash("sha256").update(stableAgentJson(value)).digest("hex");
}

export function configureAuthoritativeCatalogRepository(options: AuthoritativeCatalogRepositoryOptions): void {
  catalogRepositoryOptions = { ...options };
}

export function loadAuthoritativeCatalog(): SkuCatalog {
  return applyPriceSnapshot(loadMergedCatalogSync(catalogRepositoryOptions) as SkuCatalog, loadBundledPriceSnapshot());
}

export function parseAuthoritativeBuildConfig(value: unknown, catalog: SkuCatalog = loadAuthoritativeCatalog()): BuildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("buildConfig must be an object");
  const config = parseConfig(JSON.stringify(value));
  assertValidConfig(config, catalog);
  return config;
}

export function evaluateBuildAuthoritatively(value: unknown, catalog: SkuCatalog = loadAuthoritativeCatalog()): AuthoritativeEvaluationResponse {
  const snapshot = loadBundledPriceSnapshot();
  const config = parseAuthoritativeBuildConfig(value, catalog);
  const evaluation = evaluateBuild(config, catalog);
  const payload = authoritativeEvaluationPayload(evaluation);
  return {
    schemaVersion: AGENT_EVALUATION_SCHEMA_VERSION,
    configHash: sha256AgentValue(config),
    evaluationHash: sha256AgentValue(payload),
    catalogVersion: catalog.catalogVersion ?? `${catalog.schemaVersion}:${catalog.updatedAt}`,
    priceSnapshotVersion: `${snapshot.schemaVersion}:${snapshot.asOf}`,
    evaluation,
  };
}
