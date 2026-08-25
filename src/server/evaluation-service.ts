import { createHash } from "node:crypto";
import { parseConfig, type BuildConfig } from "../config/types";
import { assertValidConfig } from "../config/validate";
import { evaluateBuild, type BuildEvaluation } from "../core/evaluate";
import { authoritativeEvaluationPayload, stableAgentJson, AGENT_EVALUATION_SCHEMA_VERSION } from "../agent/evaluation-contract";
import { loadBundledCatalog, loadBundledPriceSnapshot } from "../sku/catalog";

export interface AuthoritativeEvaluationResponse {
  schemaVersion: typeof AGENT_EVALUATION_SCHEMA_VERSION;
  configHash: string;
  evaluationHash: string;
  catalogVersion: string;
  priceSnapshotVersion: string;
  evaluation: BuildEvaluation;
}
export function sha256AgentValue(value: unknown): string {
  return createHash("sha256").update(stableAgentJson(value)).digest("hex");
}

export function parseAuthoritativeBuildConfig(value: unknown): BuildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("buildConfig must be an object");
  const config = parseConfig(JSON.stringify(value));
  assertValidConfig(config, loadBundledCatalog());
  return config;
}

export function evaluateBuildAuthoritatively(value: unknown): AuthoritativeEvaluationResponse {
  const catalog = loadBundledCatalog();
  const snapshot = loadBundledPriceSnapshot();
  const config = parseAuthoritativeBuildConfig(value);
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
