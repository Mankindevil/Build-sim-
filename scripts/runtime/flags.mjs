import { loadEnv } from "../price-server/env.mjs";

function boolEnv(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(raw).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(raw).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

/** Server-side rollout switches. Safe defaults keep the existing app read-only. */
export async function loadRuntimeFlags(envOverride) {
  const env = envOverride ?? await loadEnv();
  const autoTrustNewDomains = boolEnv(env, "CATALOG_AUTO_TRUST_NEW_DOMAINS", false);
  if (autoTrustNewDomains) throw new Error("CATALOG_AUTO_TRUST_NEW_DOMAINS must remain false");
  return Object.freeze({
    catalogWriteEnabled: boolEnv(env, "BUILD_SIM_CATALOG_WRITE_ENABLED", false),
    catalogAutoEnrichTrustedOfficial: boolEnv(env, "CATALOG_AUTO_ENRICH_TRUSTED_OFFICIAL", true),
    catalogAutoAcceptExactMpn: boolEnv(env, "CATALOG_AUTO_ACCEPT_EXACT_MPN", false),
    catalogAutoTrustNewDomains: false,
    adviceEnabled: boolEnv(env, "BUILD_SIM_ADVICE_ENABLED", false),
    topologyV3Enabled: boolEnv(env, "BUILD_SIM_TOPOLOGY_V3_ENABLED", false),
    factGraphEnabled: boolEnv(env, "BUILD_SIM_FACT_GRAPH_ENABLED", false),
    userObservationsEnabled: boolEnv(env, "BUILD_SIM_USER_OBSERVATIONS_ENABLED", false),
    genericAdaptersEnabled: boolEnv(env, "BUILD_SIM_GENERIC_ADAPTERS_ENABLED", false),
    progressiveEvaluationEnabled: boolEnv(env, "BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED", false),
    wholeBuildSolverEnabled: boolEnv(env, "BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED", false),
    scenarioWhatIfEnabled: boolEnv(env, "BUILD_SIM_SCENARIO_WHAT_IF_ENABLED", false),
    buildExecutionV3Enabled: boolEnv(env, "BUILD_SIM_BUILD_EXECUTION_V3_ENABLED", false),
    storageLayoutEnabled: boolEnv(env, "BUILD_SIM_STORAGE_LAYOUT_ENABLED", false),
    priceHistoryEnabled: boolEnv(env, "BUILD_SIM_PRICE_HISTORY_ENABLED", false),
    priceTargetsEnabled: boolEnv(env, "BUILD_SIM_PRICE_TARGETS_ENABLED", false),
    durableJobsEnabled: boolEnv(env, "BUILD_SIM_DURABLE_JOBS_ENABLED", false),
    portabilityEnabled: boolEnv(env, "BUILD_SIM_PORTABILITY_ENABLED", false),
    backupRestoreEnabled: boolEnv(env, "BUILD_SIM_BACKUP_RESTORE_ENABLED", false),
    doctorRepairEnabled: boolEnv(env, "BUILD_SIM_DOCTOR_REPAIR_ENABLED", false),
  });
}
