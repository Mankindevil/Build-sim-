import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileEvidenceRepository } from "../evidence/repository.mjs";
import { EvidenceClaimRepository } from "../evidence/claim-repository";
import { AttachmentRepository } from "../attachments/repository";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { ObservationRepository } from "../observations/repository";
import type { ObservationSubjectRef, UserObservation } from "../observations/contracts";
import { resolveObservationProjectionContext, type CaseObservationAnchorScope } from "../observations/subject-resolution";
import { FactRepository } from "../facts/repository";
import {
  InferenceCandidateService,
  builtinInferenceRuleRegistrations,
} from "../facts/inference-candidate-service";
import { InferenceCandidateRepository } from "../facts/inference-candidate-repository";
import { PlanInferenceSummaryService } from "../facts/inference-summary-service";
import { createFilePlanInferenceAuthority } from "../facts/inference-production";
import { inspectGovernedInferenceArtifactAtRoot } from "../facts/inference-artifact-authority.mjs";
import { UpdateDecisionRepository } from "../facts/update-decision-repository";
import { FactUpdateNoticeService } from "../facts/update-notice-service";
import { EvaluationLockRepository } from "../plans/evaluation-lock-repository";
import {
  ARTIFACT_LOCK_ROLES,
  canonicalize,
  createContentAddressedRef,
  createLockedArtifactRef,
  hashContent,
  type ArtifactPayload,
  type LockedArtifactRef,
  type SnapshotHashes,
} from "../hash";
import { FilePlanRepository } from "../plans/file-repository";
import { parseConfig, type BuildConfig, type BuildConfigDocument } from "../config/types";
import type { PlanAgentContext, PlanEvaluationLock, PlanRepository } from "../plans/contracts";
import { hashPlanConfig } from "../plans/canonical";
import { ensureDefaultPlan } from "../plans/seed";
import {
  handleWorkspaceRoute,
  withServerDerivedPlanResolution,
  type WorkspaceAgentContextRecordAuthority,
} from "./workspace-routes";
import { PlanProposalService } from "../plans/proposals";
import {
  FilePlanAgentContextAuditStore,
  MemoryPlanAgentContextAuditStore,
  recordPlanAgentRunContextAtRoot,
  type PlanAgentContextAuditStore,
} from "../plans/agent-context-audit";
import {
  AuthoritativeEvaluationSnapshotPipeline,
  factUpdateSnapshotReceipt,
  loadAuthoritativeCatalogAtRoot,
  verifyResolvedFactSnapshotClosure,
  type EvaluationSnapshotAuthority,
  type EvaluationTargetAuthority,
  type GovernedEvaluationExecutor,
  type LoadedArtifactInputs,
  type LoadedExternalSnapshot,
} from "./evaluation-service";
import { createPlanPartialEvaluationV3 } from "../plans/evaluation";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { agentInferenceEnabled, factGraphEnabled, topologyV3Enabled } from "../config/io";
import { loadRuntimePriceSnapshot } from "./runtime-price-snapshot";
import type { RequirementSpec } from "../requirements/contracts";
import type { SourcedSimulationInput } from "../simulation/contracts";
import { createProductionSimulationInput, type ProductionSimulationInputPayload } from "../simulation/production";
import {
  CaseAdapterRegistry,
  FileRootBoundProvisionalCaseAdapterAuthority,
  ProvisionalCaseAdapterService,
  createBundledCaseAdapterRegistry,
  loadCurrentRuntimeCaseAdapterManifestsAtRoot,
  type CaseAdapterArtifactPayload,
  type CaseInstanceOverrides,
} from "../adapters";
import { FileJobRepository } from "../jobs";
import { ProductionWorkspaceJobCenter } from "./job-center-production";
import { ProductionWorkspaceOperations } from "./operations-production";
import { ProductionWorkspacePortability } from "./portability-production";
import { handleWorkspacePortabilityBinaryRoute } from "./portability-routes";
import { handleWorkspaceOperationsBinaryRoute } from "./operations-routes";
import type { BuildConfigV3 } from "../topology/contracts";
import {
  createBundledCaseRuntimeModelSnapshot,
} from "../adapters/runtime-composition";
import { builtinCapabilityProviderManifests } from "../capabilities";
import { createBundledWorkspaceStandardSetPayload } from "../standards";
import {
  createProductionEvidenceJobRuntime,
  type EvidenceJobRouteRuntime,
  type ProductionEvidenceJobRuntime,
} from "../evidence/jobs/production";
import { createDefaultThirdPartyDiscovery } from "../../scripts/price-server/evidence/third-party-discovery.mjs";
import { createSearXngDiscoveryProvider } from "../../scripts/price-server/catalog/searxng-discovery.mjs";
import {
  ProductionPlanClaimScopeSummary,
  ProductionWorkspacePlanResolutionSummary,
  type RootBoundWorkspacePlanResolutionSummaryAuthority,
} from "./plan-resolution-summary";
import { evaluateProgressiveCompatibility, type ProgressiveCompatibilityAuthorityResolver } from "../compatibility/engine";
import {
  BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS,
  BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS,
  BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES,
} from "../compatibility/rules";
import {
  ProductionAuthoritativeSolverEvaluator,
  ProductionWholeBuildSolverRuntime,
  createProductionCapabilityCandidateService,
  createProductionSolverBaseAuthorities,
  createRootBoundSolverEvaluationAuthority,
  type WholeBuildSolverRouteRuntime,
} from "./solver-production";
import { SolverArtifactStore } from "./solver-service";
import { FileScenarioRepository, type ScenarioBaseSnapshot } from "../scenarios/repository";
import {
  ProductionScenarioWhatIfRuntime,
  createPipelineSolverCandidateInputAuthority,
  createPipelineWhatIfSnapshotAuthority,
  type ScenarioWhatIfRouteRuntime,
} from "./what-if-production";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../system-profiles/registry";
import { resolveProductionSystemCheckAuthorities } from "../system-profiles/production";
import { ProductionSystemExecutionRuntime } from "./system-execution-production";
import { ProductionWorkspaceSpatialScene, type WorkspaceSpatialSceneAuthority } from "./spatial-production";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import { PriceRepository } from "../price/repository";
import { ProductionPlanPriceService } from "../price/production";
import { ProductionPriceObservationIntake } from "../price/intake";
import { ProductionRecommendationService } from "../recommendation/production";
import { CurrentPriceSnapshotService } from "../price/snapshot";
import { ProductionPriceRuntime } from "../price/production-runtime";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5176;
const MAX_BODY_BYTES = 1_000_000;

export interface WorkspaceRepositoryEnvironment {
  [key: string]: string | undefined;
  RUNTIME_ROOT?: string;
  PLAN_REPOSITORY_ROOT?: string;
  EVIDENCE_REPOSITORY_ROOT?: string;
  BUILD_SIM_TOPOLOGY_V3_ENABLED?: string;
  BUILD_SIM_FACT_GRAPH_ENABLED?: string;
  BUILD_SIM_AGENT_INFERENCE_ENABLED?: string;
  BUILD_SIM_USER_OBSERVATIONS_ENABLED?: string;
  BUILD_SIM_GENERIC_ADAPTERS_ENABLED?: string;
  BUILD_SIM_SPATIAL_ROUTING_ENABLED?: string;
  BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED?: string;
  BUILD_SIM_THERMAL_V3_ENABLED?: string;
  BUILD_SIM_ACOUSTIC_V3_ENABLED?: string;
  BUILD_SIM_SYSTEM_PROFILES_ENABLED?: string;
  BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED?: string;
  BUILD_SIM_SCENARIO_WHAT_IF_ENABLED?: string;
  BUILD_SIM_BUILD_EXECUTION_V3_ENABLED?: string;
  BUILD_SIM_STORAGE_LAYOUT_ENABLED?: string;
  BUILD_SIM_PRICE_HISTORY_ENABLED?: string;
  BUILD_SIM_PRICE_TARGETS_ENABLED?: string;
  BUILD_SIM_RECOMMENDATIONS_ENABLED?: string;
  BUILD_SIM_PRICE_NETWORK_ENABLED?: string;
  BUILD_SIM_DURABLE_JOBS_ENABLED?: string;
  BUILD_SIM_PORTABILITY_ENABLED?: string;
  BUILD_SIM_BACKUP_RESTORE_ENABLED?: string;
  BUILD_SIM_DOCTOR_REPAIR_ENABLED?: string;
  BUILD_SIM_EVIDENCE_NETWORK_ENABLED?: string;
  SEARXNG_BASE_URL?: string;
  SEARXNG_TIMEOUT_MS?: string;
  SEARXNG_RESULT_LIMIT?: string;
  CATALOG_DISCOVERY_CACHE_TTL_MS?: string;
}

export interface WorkspaceEvaluationAuthority {
  pipeline?: AuthoritativeEvaluationSnapshotPipeline;
  /** Optional trusted replacement for repository-backed snapshot assembly. */
  snapshots?: EvaluationSnapshotAuthority;
  /** Optional governed engine; production defaults consume the locked catalog/price artifacts. */
  evaluator?: GovernedEvaluationExecutor;
  verifyArtifact?(ref: LockedArtifactRef): boolean | Promise<boolean>;
  verifyArtifactAtRoot?(activeRoot: string, ref: LockedArtifactRef): boolean | Promise<boolean>;
  verifyExternalSnapshotHashes?(hashes: SnapshotHashes): boolean | Promise<boolean>;
  verifyExternalSnapshotHashesAtRoot?(activeRoot: string, hashes: SnapshotHashes): boolean | Promise<boolean>;
}

function strictBoolean(environment: WorkspaceRepositoryEnvironment, name: keyof WorkspaceRepositoryEnvironment, fallback = false): boolean {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLocaleLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLocaleLowerCase())) return false;
  throw new Error(`${String(name)} must be true or false`);
}

const ARTIFACT_DOMAINS = Object.freeze({
  ruleSet: "artifact.rule-set",
  standardSet: "artifact.standard-set",
  systemProfile: "artifact.system-profile",
  adapterSnapshot: "artifact.adapter-snapshot",
  engine: "artifact.engine",
  simulationModel: "artifact.simulation-model",
} as const);

async function storedExternalArtifact(artifactId: string, mediaType: string, payload: unknown): Promise<LoadedExternalSnapshot> {
  const candidate = {
    schemaVersion: "artifact-payload-v1" as const,
    artifactId,
    mediaType,
    payload,
    contentHash: "0".repeat(64),
  };
  const contentHash = await hashContent(candidate, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const artifact: ArtifactPayload = { ...candidate, payload: payload as never, contentHash };
  return {
    ref: await createContentAddressedRef(artifact, { domain: "artifact", schemaVersion: "artifact-payload-v1" }),
    payload: artifact,
  };
}

async function defaultSimulationInput(
  target: { config: BuildConfigDocument },
  caseInstanceOverrides: readonly CaseInstanceOverrides[],
  simulationModelHash: string,
): Promise<(SourcedSimulationInput & { caseInstanceOverrides: CaseInstanceOverrides[] }) | ProductionSimulationInputPayload> {
  if (target.config.schemaVersion === "3.0.0") {
    return createProductionSimulationInput({ config: target.config, simulationModelHash, caseInstanceOverrides });
  }
  const input = {
    workloadMetricRefs: [],
    ambientC: { min: 20, max: 35 },
    fanPolicyId: "universal-balanced-v1",
    storageActivity: [],
    placementIds: [],
    routeIds: [],
    modelVersion: "pending-governed-simulation-v1",
  };
  const paths = [
    "/workloadMetricRefs", "/ambientC/min", "/ambientC/max", "/fanPolicyId", "/storageActivity",
    "/placementIds", "/routeIds", "/modelVersion",
  ];
  return {
    input,
    sources: paths.map((fieldPath) => ({
      fieldPath,
      source: "system_profile_default" as const,
      userOverridable: true as const,
      sourceRef: `universal-system-profile:${target.config.schemaVersion}`,
    })),
    caseInstanceOverrides: caseInstanceOverrides.map((entry) => structuredClone(entry)),
  };
}

export async function builtinArtifactInputs(
  activeRoot: string,
  runtimeRoot: string,
  options: {
    genericAdaptersEnabled?: boolean;
    progressiveEvaluationEnabled?: boolean;
    thermalV3Enabled?: boolean;
    acousticV3Enabled?: boolean;
    systemProfilesEnabled?: boolean;
    activeRuntimeGeneration?: number;
  } = {},
): Promise<LoadedArtifactInputs> {
  const catalog = loadAuthoritativeCatalogAtRoot(activeRoot, { runtimeRoot });
  const serverRoot = path.dirname(fileURLToPath(import.meta.url));
  // In source/vite-node the optional module files provide fine-grained
  // invalidation. In the production build those paths no longer exist, so the
  // actual executing workspace bundle is the mandatory authority byte source.
  // A new deployment therefore always changes every conservative artifact
  // binding when any bundled evaluator/validator implementation changes.
  const runtimeBundleSource = {
    moduleId: "workspace-server-runtime-bundle",
    bytes: await readFile(fileURLToPath(import.meta.url), "utf8").catch((error) => {
      throw new Error(`governed evaluation runtime bundle bytes unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }),
  };
  const runtimeBundleHash = sha256Utf8Runtime(runtimeBundleSource.bytes);
  if (runtimeBundleHash === null) throw new Error("governed evaluation runtime bundle bytes cannot be hashed");
  const sources = async (...entries: ReadonlyArray<readonly [moduleId: string, relativePath: string]>) => {
    const resolved = await Promise.all(entries.map(async ([moduleId, relativePath]) => {
      const bytes = await readFile(path.resolve(serverRoot, relativePath), "utf8").catch(() => null);
      return bytes === null ? null : { moduleId, bytes };
    }));
    return [runtimeBundleSource, ...resolved.filter((entry): entry is { moduleId: string; bytes: string } => entry !== null)];
  };
  const exactSources = async (...entries: ReadonlyArray<readonly [moduleId: string, relativePath: string]>) => Promise.all(
    entries.map(async ([moduleId, relativePath]) => {
      const moduleBytes = await readFile(path.resolve(serverRoot, relativePath), "utf8").catch(() => null);
      return {
        moduleId,
        // A production SSR bundle already contains every implementation below.
        // Repeating the complete bundle once per logical module made one lock
        // tens of megabytes and stalled every evaluation. Keep the bundle once
        // as `workspace-server-runtime-bundle`; each missing fine-grained file
        // carries a small, exact binding to those executing bytes instead.
        bytes: moduleBytes ?? canonicalize({
          schemaVersion: "workspace-bundled-module-source-v1",
          moduleId,
          bundleModuleId: runtimeBundleSource.moduleId,
          bundleHash: runtimeBundleHash,
        }),
      };
    }),
  );
  const canonicalSources = (entries: ReadonlyArray<{ moduleId: string; bytes: string }>) => {
    const byModule = new Map<string, string>();
    for (const entry of entries) {
      const previous = byModule.get(entry.moduleId);
      if (previous !== undefined && previous !== entry.bytes) {
        throw new Error(`artifact source module has conflicting bytes: ${entry.moduleId}`);
      }
      byModule.set(entry.moduleId, entry.bytes);
    }
    return [...byModule].map(([moduleId, bytes]) => ({ moduleId, bytes }))
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  };
  const legacyPayloads = {
    ruleSet: {
      schemaVersion: "workspace-rule-set-v1",
      ruleIds: ["compatibility-core-v1", "price-known-only-v1"],
      sources: await sources(["core/evaluate", "../core/evaluate.ts"]),
    },
    standardSet: {
      schemaVersion: "workspace-standard-set-v1",
      standardIds: ["buildsim-hash-spec-v1", "buildsim-plan-v3"],
      sources: await sources(["hash/contracts", "../hash/contracts.ts"], ["requirements/contracts", "../requirements/contracts.ts"]),
    },
    systemProfile: {
      schemaVersion: "workspace-system-profile-v1",
      profileId: "universal-consumer-hardware",
      supportedPlanSchemas: ["2.0.0", "3.0.0"],
      sources: await sources(["contracts/registries", "../contracts/registries.ts"]),
    },
    adapterSnapshot: {
      schemaVersion: "workspace-adapter-snapshot-v1",
      catalog,
      sources: await sources(["catalog/repository", "../../scripts/price-server/catalog/repository.mjs"]),
    },
    engine: {
      schemaVersion: "workspace-engine-v1",
      engineId: "buildsim-core-evaluate",
      engineVersion: "1",
      sources: await sources(
        ["core/evaluate", "../core/evaluate.ts"],
        ["server/evaluation-service", "evaluation-service.ts"],
      ),
    },
    simulationModel: {
      schemaVersion: "workspace-simulation-model-binding-v1",
      modelId: "pending-governed-simulation",
      modelVersion: "1",
      claims: "unknown",
      sources: await sources(["simulation/contracts", "../simulation/contracts.ts"]),
    },
  } as const;
  let payloads: Record<(typeof ARTIFACT_LOCK_ROLES)[number], unknown> = legacyPayloads;
  if (options.progressiveEvaluationEnabled === true && options.genericAdaptersEnabled !== true) {
    throw new TypeError("progressive evaluation requires generic adapter artifacts");
  }
  if (options.genericAdaptersEnabled === true) {
    if (!Number.isSafeInteger(options.activeRuntimeGeneration) || Number(options.activeRuntimeGeneration) < 1) {
      throw new TypeError("generic adapter artifact composition requires the active runtime generation from its coordinator barrier");
    }
    const standardSet = await createBundledWorkspaceStandardSetPayload(await sources(
      ["standards/contracts", "../standards/contracts.ts"],
      ["standards/registry", "../standards/registry.ts"],
    ));
    const bundledAdapterRegistry = await createBundledCaseAdapterRegistry();
    const bundledManifests = bundledAdapterRegistry.list();
    const runtimeModelSnapshot = await createBundledCaseRuntimeModelSnapshot(bundledManifests);
    const runtimeAdapterSnapshot = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      activeRoot,
      Number(options.activeRuntimeGeneration),
    );
    // Registering the immutable runtime manifests into one exact-identity map
    // rejects a runtime/bundle collision instead of silently choosing either.
    const adapterRegistry = await CaseAdapterRegistry.create([
      ...bundledManifests,
      ...runtimeAdapterSnapshot.manifests,
    ]);
    // Identity-only overlay derived exclusively from locked manifests. It is
    // not a projection of the product catalog and cannot become authority for
    // any non-case SKU name, price, dimension, or compatibility attribute.
    const adapterCatalog: CaseAdapterArtifactPayload["catalog"] = {
      schemaVersion: "case-adapter-identity-catalog-v1",
      skus: adapterRegistry.list().map((manifest) => ({
        id: manifest.identity.skuId,
        category: "case",
        name: manifest.identity.skuId,
      })),
    };
    const adapterImplementationSources = await sources(
      ["adapters/registry", "../adapters/registry.ts"],
      ["adapters/contracts", "../adapters/contracts.ts"],
      ["adapters/data-driven-case", "../adapters/data-driven-case.ts"],
      ["adapters/runtime", "../adapters/runtime.ts"],
      ["adapters/runtime-compiler", "../adapters/runtime-compiler.ts"],
      ["adapters/runtime-model", "../adapters/runtime-model.ts"],
      ["adapters/runtime-model-runtime", "../adapters/runtime-model-runtime.mjs"],
      ["adapters/runtime-model-schema", "../adapters/runtime-model-schema.ts"],
      ["adapters/runtime-composition", "../adapters/runtime-composition.ts"],
      ["adapters/case-manifest-runtime", "../adapters/case-manifest-runtime.mjs"],
      ["adapters/provisional-runtime", "../adapters/provisional-runtime.mjs"],
      ["adapters/artifact-runtime", "../adapters/artifact-runtime.mjs"],
      ["adapters/spatial-projection", "../adapters/spatial-projection.ts"],
      ["adapters/declarative-case/runtime", "../adapters/declarative-case/runtime.ts"],
      ["adapters/declarative-case/primitive-runtime", "../adapters/declarative-case/primitive-runtime.ts"],
      ["adapters/declarative-case/geometry", "../adapters/declarative-case/geometry.ts"],
      ["adapters/declarative-case/occupancy", "../adapters/declarative-case/occupancy.ts"],
      ["adapters/declarative-case/routing", "../adapters/declarative-case/routing.ts"],
      ["core/assembly", "../core/assembly.ts"],
      ["core/geometry", "../core/geometry.ts"],
      ["core/occupancy", "../core/occupancy.ts"],
      ["core/routing", "../core/routing.ts"],
      ["core/physical", "../core/physical.ts"],
      ["core/calibration", "../core/calibration.ts"],
      ["core/policy", "../core/policy.ts"],
      ["wiring/plan", "../wiring/plan.ts"],
      ["wiring/panel", "../wiring/panel.ts"],
      ["sku/catalog", "../sku/catalog.ts"],
      ["capabilities/provider", "../capabilities/provider.ts"],
      ["capabilities/registry", "../capabilities/registry.ts"],
    );
    const adapterImplementationModuleIds = adapterImplementationSources.map((source) => source.moduleId);
    const capabilityProviderImplementationModuleIds = adapterImplementationSources
      .filter((source) => source.moduleId === runtimeBundleSource.moduleId || source.moduleId.startsWith("capabilities/"))
      .map((source) => source.moduleId);
    const adapterArtifact = await adapterRegistry.createArtifact({
      catalog: adapterCatalog,
      capabilityProviderManifests: builtinCapabilityProviderManifests(),
      runtimeRegistry: runtimeAdapterSnapshot,
      runtimeModels: runtimeModelSnapshot.models,
      sources: [...adapterImplementationSources, ...runtimeModelSnapshot.sources],
      // The executing SSR bundle is mandatory in both source and dist. Fine-
      // grained source modules close the declarative compiler/interpreter's
      // transitive implementation identity when source bytes are available.
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const progressiveSources = options.progressiveEvaluationEnabled === true
      ? await exactSources(
        ["compatibility/engine", "../compatibility/engine.ts"],
        ["compatibility/explain", "../compatibility/explain.ts"],
        ["compatibility/requirements", "../compatibility/requirements.ts"],
        ["compatibility/rules", "../compatibility/rules.ts"],
        ["compatibility/runtime", "../compatibility/runtime.mjs"],
        ["firmware/evaluate", "../firmware/evaluate.ts"],
        ["firmware/fixed-point", "../firmware/fixed-point.ts"],
        ["firmware/fixed-point-runtime", "../firmware/fixed-point-runtime.mjs"],
        ["firmware/runtime", "../firmware/runtime.mjs"],
        ["requirements/allocation", "../requirements/allocation.ts"],
        ["requirements/assembly-safety-runtime", "../requirements/assembly-safety-runtime.mjs"],
        ["requirements/closure", "../requirements/closure.ts"],
        ["requirements/patterns", "../requirements/patterns.ts"],
        ["requirements/runtime", "../requirements/runtime.mjs"],
        ["simulation/evaluate", "../simulation/evaluate.ts"],
        ["thermal/airflow-graph", "../thermal/airflow-graph.ts"],
        ["thermal/fan-operating-point", "../thermal/fan-operating-point.ts"],
        ["thermal/steady-state", "../thermal/steady-state.ts"],
        ["acoustics/aggregate", "../acoustics/aggregate.ts"],
        ["acoustics/operating-point", "../acoustics/operating-point.ts"],
      ) : [];
    if (options.progressiveEvaluationEnabled === true
      && progressiveSources.some(({ moduleId }) => !BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS.includes(moduleId))) {
      throw new Error("progressive evaluator implementation source map differs from the builtin manifest");
    }
    const ruleSet = {
      schemaVersion: "workspace-rule-set-v1" as const,
      ruleIds: [
        "compatibility-core-v1",
        "generic-capability-registry-v1",
        "price-known-only-v1",
        ...(options.progressiveEvaluationEnabled === true ? BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS : []),
      ].sort(),
      sources: canonicalSources([
        ...await sources(["core/evaluate", "../core/evaluate.ts"]),
        { moduleId: "artifact/standard-set-transitive-closure", bytes: canonicalize(standardSet) },
        ...(options.progressiveEvaluationEnabled === true ? [{
          moduleId: "compatibility/rule-manifest",
          bytes: JSON.stringify(BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES),
        }] : []),
      ]),
    };
    const engine = {
      schemaVersion: "workspace-engine-v1" as const,
      engineId: "buildsim-core-evaluate",
      engineVersion: "2",
      sources: canonicalSources([
        ...await sources(
          ["core/evaluate", "../core/evaluate.ts"],
          ["server/evaluation-service", "evaluation-service.ts"],
        ),
        ...progressiveSources,
        ...(options.progressiveEvaluationEnabled === true ? [{
          moduleId: "configuration/thermal-acoustic-v3",
          bytes: canonicalize({
            thermalV3Enabled: options.thermalV3Enabled !== false,
            acousticV3Enabled: options.acousticV3Enabled !== false,
          }),
        }] : []),
        {
          moduleId: "artifact/evaluation-transitive-closure",
          bytes: canonicalize({ ruleSet, standardSet, adapterSnapshot: adapterArtifact.payload }),
        },
      ]),
    };
    const systemProfile = options.systemProfilesEnabled === true ? {
      schemaVersion: "workspace-system-profile-v2" as const,
      registry: structuredClone(DEFAULT_SYSTEM_PROFILE_REGISTRY.document),
      registryHash: DEFAULT_SYSTEM_PROFILE_REGISTRY.contentHash,
      supportedPlanSchemas: ["2.0.0", "3.0.0"],
      sources: canonicalSources([
        ...await sources(
          ["system-profiles/contracts", "../system-profiles/contracts.ts"],
          ["system-profiles/registry", "../system-profiles/registry.ts"],
          ["system-profiles/requirements", "../system-profiles/requirements.ts"],
          ["system-profiles/evaluate", "../system-profiles/evaluate.ts"],
          ["system-profiles/compare", "../system-profiles/compare.ts"],
          ["system-profiles/runtime", "../system-profiles/runtime.mjs"],
        ),
        { moduleId: "data/systems/profiles", bytes: canonicalize(DEFAULT_SYSTEM_PROFILE_REGISTRY.document) },
      ]),
    } : legacyPayloads.systemProfile;
    payloads = {
      ruleSet,
      standardSet,
      systemProfile,
      adapterSnapshot: adapterArtifact.payload,
      engine,
      simulationModel: legacyPayloads.simulationModel,
    };
  }
  const entries = await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => [role, {
    ref: await createLockedArtifactRef(
      payloads[role],
      role,
      `workspace-${role}-v1`,
      `application/vnd.buildsim.${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}+json`,
      { domain: ARTIFACT_DOMAINS[role], schemaVersion: "1.0.0" },
    ),
    payload: payloads[role],
  }] as const));
  return Object.fromEntries(entries) as unknown as LoadedArtifactInputs;
}

export const builtinGovernedEvaluator: GovernedEvaluationExecutor = (input) => {
  if (input.factClosure.conflicts.some((conflict) => conflict.status === "open")
    || input.factClosure.facts.some((fact) => fact.status === "unresolved_blocker")) {
    throw new Error("locked fact closure contains an unresolved blocker");
  }
  if (input.config.schemaVersion === "3.0.0") {
    return {
      evaluation: createPlanPartialEvaluationV3(input.config),
      catalogVersion: "topology-v3-partial",
      priceSnapshotVersion: null,
    };
  }
  throw new Error("fact graph V2 evaluation is unavailable until the governed fact-driven engine replaces legacy catalog-attribute conclusions");
};

export function createBuiltinGovernedEvaluator(options: {
  progressiveEvaluationEnabled: boolean;
  thermalV3Enabled?: boolean;
  acousticV3Enabled?: boolean;
  authorityResolver?: ProgressiveCompatibilityAuthorityResolver;
}): GovernedEvaluationExecutor {
  if (!options.progressiveEvaluationEnabled) return builtinGovernedEvaluator;
  return async (input) => {
    if (input.config.schemaVersion !== "3.0.0") return builtinGovernedEvaluator(input);
    return {
      evaluation: await evaluateProgressiveCompatibility(input, {
        ...(options.authorityResolver ? { authorityResolver: options.authorityResolver } : {}),
        thermalV3Enabled: options.thermalV3Enabled !== false,
        acousticV3Enabled: options.acousticV3Enabled !== false,
      }),
      catalogVersion: `progressive:${input.snapshotHashes.adapterSnapshotHash}`,
      priceSnapshotVersion: `snapshot:${input.snapshotHashes.priceSnapshotHash}`,
    };
  };
}

export interface RepositoryBackedEvaluationSnapshotAuthorityOptions {
  runtimeRoot: string;
  facts: FactRepository;
  observations: ObservationRepository;
  decisions: UpdateDecisionRepository;
  locks: EvaluationLockRepository;
  genericAdaptersEnabled?: boolean;
  progressiveEvaluationEnabled?: boolean;
  thermalV3Enabled?: boolean;
  acousticV3Enabled?: boolean;
  systemProfilesEnabled?: boolean;
  userObservationsEnabled?: boolean;
  capabilityUniverseEnabled?: boolean;
  loadArtifactsAtRoot?: EvaluationSnapshotAuthority["loadArtifactsAtRoot"];
  loadExternalInputsAtRoot?: EvaluationSnapshotAuthority["loadExternalInputsAtRoot"];
}

function evaluationRelevantSkuIds(config: import("../config/types").BuildConfigDocument): Set<string> {
  if (config.schemaVersion === "3.0.0") {
    return new Set(config.components.flatMap((component) => component.identity.status === "resolved" ? [component.identity.skuId] : []));
  }
  return new Set([
    config.caseId, config.boardId, config.cpuId, config.selection.psuId,
    config.selection.secondaryPsuId, config.selection.coolerId, config.selection.gpuId,
    config.selection.memoryId, config.selection.diskSkuId, config.selection.hbaSkuId,
    ...config.bom.map((line) => line.skuId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0));
}

function lockedCaseObservationScope(
  target: import("./evaluation-service").EvaluationTargetSnapshot,
  artifacts: LoadedArtifactInputs | undefined,
  subject: ObservationSubjectRef,
): CaseObservationAnchorScope | undefined {
  if (!artifacts || target.config.schemaVersion !== "3.0.0") return undefined;
  let instanceId: string | undefined;
  if (subject.kind === "instance" || subject.kind === "port") instanceId = subject.instanceId;
  else if (subject.kind === "mount") instanceId = subject.ownerInstanceId;
  else if (subject.kind === "placement") {
    instanceId = target.config.placements.find((placement) => placement.placementId === subject.placementId)?.mountOwnerInstanceId;
  } else if (subject.kind === "connection") {
    const connection = target.config.connections.find((candidate) => candidate.connectionId === subject.connectionId);
    const caseIds = [connection?.from.instanceId, connection?.to.instanceId]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .filter((candidate) => target.config.schemaVersion === "3.0.0"
        && target.config.components.some((component) => component.instanceId === candidate && component.kind === "case"));
    if (new Set(caseIds).size === 1) instanceId = caseIds[0];
  }
  if (!instanceId) return undefined;
  const component = target.config.components.find((candidate) => candidate.instanceId === instanceId);
  if (!component || component.kind !== "case" || component.identity.status !== "resolved") return undefined;
  const skuId = component.identity.skuId;
  const payload = artifacts.adapterSnapshot.payload as Partial<CaseAdapterArtifactPayload>;
  const manifests = Array.isArray(payload.caseManifests)
    ? payload.caseManifests.filter((manifest) => manifest.identity.skuId === skuId)
    : [];
  if (manifests.length === 0) return undefined;
  if (manifests.length !== 1) throw new Error(`locked case adapter identity is ambiguous for ${instanceId}`);
  return { caseInstanceId: instanceId, baseManifestHash: manifests[0]!.contentHash, manifest: structuredClone(manifests[0]!) };
}

/** Production selector: immutable versions stay pinned; drafts move only through plan-scoped decision memory. */
export function createRepositoryBackedEvaluationSnapshotAuthority(
  options: RepositoryBackedEvaluationSnapshotAuthorityOptions,
): EvaluationSnapshotAuthority {
  return {
    resolveFactSnapshotAtRoot: async (activeRoot, target) => {
      const binding = target.planVersionId
        ? { kind: "version" as const, versionId: target.planVersionId }
        : { kind: "draft" as const, draftRevision: target.draftRevision };
      const versionPin = target.pinnedEvaluationLock
        ? { snapshotId: target.pinnedEvaluationLock.factSnapshotId, contentHash: target.pinnedEvaluationLock.snapshotHashes.factSnapshotHash }
        : null;
      const selected = versionPin
        ?? (!target.planVersionId ? await options.decisions.getSelectedSnapshotForPlanAtRoot(activeRoot, target.planId) : null)
        ?? (!target.planVersionId
          ? await options.locks.currentLockAtRoot(activeRoot, target.planId, binding).then((lock) => lock && ({
            snapshotId: lock.factSnapshotId,
            contentHash: lock.snapshotHashes.factSnapshotHash,
          }))
          : null);
      const base = selected
        ? await options.facts.getSnapshotClosureAtRoot(activeRoot, selected.snapshotId)
        : await (async () => {
          const skuIds = evaluationRelevantSkuIds(target.config);
          const current = await options.facts.listCurrentFactsAtRoot(activeRoot);
          const factIds = current.filter((fact) => fact.subject.kind === "plan_subject"
            ? fact.subject.planId === target.planId
            : options.capabilityUniverseEnabled === true || skuIds.has(fact.subject.skuId)).map((fact) => fact.factId);
          const snapshot = await options.facts.createSnapshotAtRoot(activeRoot, { factIds });
          const closure = await options.facts.getSnapshotClosureAtRoot(activeRoot, snapshot.snapshotId);
          if (!closure) throw new Error("new plan-relevant fact snapshot closure disappeared");
          return closure;
        })();
      if (!base || (selected && base.snapshot.contentHash !== selected.contentHash)) {
        throw new Error("selected plan fact snapshot closure is unavailable");
      }
      const decisionIds = [...new Set(base.conflicts.flatMap((conflict) => conflict.decisionIds))].sort();
      const decisions = await Promise.all(decisionIds.map(async (decisionId) => {
        const decision = await options.decisions.getDecisionAtRoot(activeRoot, decisionId);
        if (!decision) throw new Error(`fact conflict decision closure is unavailable: ${decisionId}`);
        return decision;
      }));
      return { ...base, decisions };
    },
    resolveObservationSnapshotAtRoot: async (activeRoot, target, artifacts) => {
      const resolver = (observation: UserObservation) => resolveObservationProjectionContext(
        target.planId,
        target.config,
        observation.subjectRef,
        lockedCaseObservationScope(target, artifacts, observation.subjectRef),
      );
      if (target.pinnedEvaluationLock) {
        const pinned = await options.observations.getSnapshotClosureAtRoot(
          activeRoot,
          target.planId,
          target.pinnedEvaluationLock.userObservationSnapshotId,
          resolver,
        );
        if (!pinned || pinned.snapshot.contentHash !== target.pinnedEvaluationLock.snapshotHashes.userObservationSnapshotHash) {
          throw new Error("PlanVersion observation snapshot closure is unavailable");
        }
        return pinned;
      }
      const binding = { kind: "draft" as const, draftRevision: target.draftRevision };
      const priorLock = await options.locks.currentLockAtRoot(activeRoot, target.planId, binding);
      const prior = priorLock
        ? await options.observations.getSnapshotClosureAtRoot(activeRoot, target.planId, priorLock.userObservationSnapshotId, resolver)
        : null;
      const current = options.userObservationsEnabled !== false
        ? await options.observations.createCurrentSnapshotClosureAtRoot(activeRoot, target.planId, resolver)
        : await options.observations.createEmptySnapshotClosureAtRoot(activeRoot, target.planId, resolver);
      if (prior && prior.snapshot.contentHash === priorLock?.snapshotHashes.userObservationSnapshotHash
        && JSON.stringify(prior.snapshot.observationIds) === JSON.stringify(current.snapshot.observationIds)
        && JSON.stringify(prior.snapshot.observationRecordHashes) === JSON.stringify(current.snapshot.observationRecordHashes)) {
        return prior;
      }
      return current;
    },
    loadArtifactsAtRoot: options.loadArtifactsAtRoot
      ?? (async (activeRoot, target, activeRuntimeGeneration) => {
        if (target.pinnedEvaluationLock) {
          return options.locks.hydrateArtifactInputsAtRoot(activeRoot, target.pinnedEvaluationLock);
        }
        if (options.genericAdaptersEnabled === true && activeRuntimeGeneration === undefined) {
          throw new Error("current generic adapter composition requires its coordinator barrier generation");
        }
        return builtinArtifactInputs(activeRoot, options.runtimeRoot, options.genericAdaptersEnabled === true
          ? {
            genericAdaptersEnabled: true,
            progressiveEvaluationEnabled: options.progressiveEvaluationEnabled === true,
            thermalV3Enabled: options.thermalV3Enabled === true,
            acousticV3Enabled: options.acousticV3Enabled === true,
            systemProfilesEnabled: options.systemProfilesEnabled === true,
            activeRuntimeGeneration: activeRuntimeGeneration!,
          }
          : { genericAdaptersEnabled: false });
      }),
    loadExternalInputsAtRoot: options.loadExternalInputsAtRoot ?? (async (activeRoot, target, closure) => {
      if (target.pinnedEvaluationLock) {
        return options.locks.hydrateExternalInputsAtRoot(activeRoot, target.pinnedEvaluationLock);
      }
      const requirementSpec: RequirementSpec = target.config.schemaVersion === "3.0.0" && target.config.requirementSpec
        ? structuredClone(target.config.requirementSpec)
        : {
          requirementSpecId: `requirements-${target.planId}`,
          schemaVersion: "1.0.0",
          workloads: [],
          constraints: [],
        };
      const priceSnapshot = loadRuntimePriceSnapshot({ runtimeRoot: options.runtimeRoot, activeRoot, allowSeedFallback: false });
      return {
        requirementSpec: {
          ref: await createContentAddressedRef(requirementSpec, { domain: "requirement-spec", schemaVersion: "1.0.0" }),
          payload: requirementSpec,
        },
        priceSnapshot: await storedExternalArtifact(
          `price-${priceSnapshot.snapshotId ?? priceSnapshot.asOf}`,
          "application/vnd.buildsim.price-snapshot+json",
          priceSnapshot,
        ),
        simulationInput: await storedExternalArtifact(
          `simulation-input-${target.planId}-${target.planVersionId ?? `draft-${target.draftRevision}`}`,
          "application/vnd.buildsim.sourced-simulation-input+json",
          await defaultSimulationInput(
            target,
            closure.caseInstanceOverrides,
            closure.artifactLockfile.artifacts.simulationModel.contentHash,
          ),
        ),
      };
    }),
  };
}

export function createWorkspaceRepositories<TConfig extends BuildConfigDocument = BuildConfig>(
  environment: WorkspaceRepositoryEnvironment = process.env,
  authority: WorkspaceEvaluationAuthority = {},
): {
  repository: FilePlanRepository<TConfig>;
  evidenceRepository: FileEvidenceRepository;
  evidenceClaimRepository: EvidenceClaimRepository;
  attachmentRepository: AttachmentRepository;
  observationRepository: ObservationRepository;
  factRepository: FactRepository;
  updateDecisionRepository: UpdateDecisionRepository;
  evaluationLockRepository: EvaluationLockRepository;
  artifactRepository: FileArtifactRepository;
  evaluationPipeline?: AuthoritativeEvaluationSnapshotPipeline;
  factUpdateNoticeService?: FactUpdateNoticeService;
  evidenceJobs?: ProductionEvidenceJobRuntime;
  inferenceSummary?: PlanInferenceSummaryService;
  planResolutionSummary?: ProductionWorkspacePlanResolutionSummary;
  wholeBuildSolver?: ProductionWholeBuildSolverRuntime;
  scenarioWhatIf?: ProductionScenarioWhatIfRuntime;
  systemExecution?: ProductionSystemExecutionRuntime;
  spatialScene?: WorkspaceSpatialSceneAuthority;
  priceRepository: PriceRepository;
  currentPriceSnapshots?: CurrentPriceSnapshotService;
  priceObservationIntake?: ProductionPriceObservationIntake;
  planPrices?: ProductionPlanPriceService;
  priceRuntime?: ProductionPriceRuntime;
  recommendations?: ProductionRecommendationService;
  jobCenter?: ProductionWorkspaceJobCenter;
  operations?: ProductionWorkspaceOperations;
  portability?: ProductionWorkspacePortability;
  planRoot: string;
  evidenceRoot: string;
  coordinator?: RuntimeCoordinator;
} {
  // Parse both independent gates eagerly. A malformed inference flag must not
  // hide behind a false fact-graph flag, and flag-off keeps historical records
  // readable without letting inference facts participate in current snapshots.
  const factsFeatureEnabled = factGraphEnabled(environment);
  const inferenceFeatureEnabled = agentInferenceEnabled(environment);
  const genericAdaptersFeatureEnabled = strictBoolean(environment, "BUILD_SIM_GENERIC_ADAPTERS_ENABLED");
  const spatialRoutingFeatureEnabled = strictBoolean(environment, "BUILD_SIM_SPATIAL_ROUTING_ENABLED");
  const progressiveEvaluationFeatureEnabled = strictBoolean(environment, "BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED");
  const thermalV3FeatureEnabled = strictBoolean(environment, "BUILD_SIM_THERMAL_V3_ENABLED");
  const acousticV3FeatureEnabled = strictBoolean(environment, "BUILD_SIM_ACOUSTIC_V3_ENABLED");
  const systemProfilesFeatureEnabled = strictBoolean(environment, "BUILD_SIM_SYSTEM_PROFILES_ENABLED");
  const userObservationsFeatureEnabled = strictBoolean(environment, "BUILD_SIM_USER_OBSERVATIONS_ENABLED");
  // Parse the later U6 switches eagerly even before their route services are
  // composed, so a malformed deployment value cannot remain latent.
  const wholeBuildSolverFeatureEnabled = strictBoolean(environment, "BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED");
  const scenarioWhatIfFeatureEnabled = strictBoolean(environment, "BUILD_SIM_SCENARIO_WHAT_IF_ENABLED");
  const buildExecutionFeatureEnabled = strictBoolean(environment, "BUILD_SIM_BUILD_EXECUTION_V3_ENABLED");
  const storageLayoutFeatureEnabled = strictBoolean(environment, "BUILD_SIM_STORAGE_LAYOUT_ENABLED");
  const durableJobsEnabled = strictBoolean(environment, "BUILD_SIM_DURABLE_JOBS_ENABLED");
  const priceHistoryFeatureEnabled = strictBoolean(environment, "BUILD_SIM_PRICE_HISTORY_ENABLED");
  const priceTargetsFeatureEnabled = strictBoolean(environment, "BUILD_SIM_PRICE_TARGETS_ENABLED");
  const recommendationsFeatureEnabled = strictBoolean(environment, "BUILD_SIM_RECOMMENDATIONS_ENABLED");
  const backupRestoreFeatureEnabled = strictBoolean(environment, "BUILD_SIM_BACKUP_RESTORE_ENABLED");
  const doctorFeatureEnabled = strictBoolean(environment, "BUILD_SIM_DOCTOR_REPAIR_ENABLED");
  const portabilityFeatureEnabled = strictBoolean(environment, "BUILD_SIM_PORTABILITY_ENABLED");
  const priceNetworkFeatureEnabled = strictBoolean(environment, "BUILD_SIM_PRICE_NETWORK_ENABLED");
  if (progressiveEvaluationFeatureEnabled
    && (!topologyV3Enabled(environment) || !factsFeatureEnabled || !genericAdaptersFeatureEnabled)) {
    throw new Error("progressive evaluation requires topology V3, fact graph, and generic adapters");
  }
  if (spatialRoutingFeatureEnabled && (!topologyV3Enabled(environment) || !genericAdaptersFeatureEnabled)) {
    throw new Error("spatial routing requires topology V3 and generic adapters");
  }
  if ((wholeBuildSolverFeatureEnabled || scenarioWhatIfFeatureEnabled) && !progressiveEvaluationFeatureEnabled) {
    throw new Error("whole-build solver and scenario what-if require progressive evaluation");
  }
  if (systemProfilesFeatureEnabled && !progressiveEvaluationFeatureEnabled) {
    throw new Error("system profiles require progressive evaluation");
  }
  if ((thermalV3FeatureEnabled || acousticV3FeatureEnabled) && !progressiveEvaluationFeatureEnabled) {
    throw new Error("thermal/acoustic V3 require progressive evaluation");
  }
  if (acousticV3FeatureEnabled && !thermalV3FeatureEnabled) {
    throw new Error("acoustic V3 requires thermal V3");
  }
  if (wholeBuildSolverFeatureEnabled && !durableJobsEnabled) {
    throw new Error("whole-build solver requires durable jobs");
  }
  if (priceHistoryFeatureEnabled && (!progressiveEvaluationFeatureEnabled || !durableJobsEnabled)) {
    throw new Error("price history requires progressive evaluation and durable jobs");
  }
  if (priceTargetsFeatureEnabled && (!priceHistoryFeatureEnabled || !durableJobsEnabled)) {
    throw new Error("price targets require price history and durable jobs");
  }
  if (recommendationsFeatureEnabled && (!wholeBuildSolverFeatureEnabled || !priceHistoryFeatureEnabled)) {
    throw new Error("recommendations require whole-build solver and price history");
  }
  if (userObservationsFeatureEnabled && (!topologyV3Enabled(environment) || !factsFeatureEnabled)) {
    throw new Error("user observations require topology V3 and fact graph");
  }
  if (buildExecutionFeatureEnabled && !systemProfilesFeatureEnabled) {
    throw new Error("build execution V3 requires system profiles");
  }
  if (storageLayoutFeatureEnabled && !buildExecutionFeatureEnabled) {
    throw new Error("storage layout requires build execution V3");
  }
  if (portabilityFeatureEnabled && !backupRestoreFeatureEnabled) {
    throw new Error("portability requires backup and restore");
  }
  const inferenceRegistrations = builtinInferenceRuleRegistrations();
  const configuredRuntimeRoot = environment.RUNTIME_ROOT ? path.resolve(environment.RUNTIME_ROOT) : undefined;
  const defaultRuntimeRoot = configuredRuntimeRoot ?? path.resolve("runtime");
  const planRoot = path.resolve(environment.PLAN_REPOSITORY_ROOT ?? path.join(defaultRuntimeRoot, "plans"));
  const evidenceRoot = path.resolve(environment.EVIDENCE_REPOSITORY_ROOT ?? path.join(defaultRuntimeRoot, "evidence"));
  if (configuredRuntimeRoot && (planRoot !== path.join(configuredRuntimeRoot, "plans") || evidenceRoot !== path.join(configuredRuntimeRoot, "evidence"))) {
    throw new Error("RUNTIME_ROOT conflicts with legacy plan/evidence repository roots; migrate or remove the conflicting configuration");
  }
  const configuredAsRuntimePair = path.basename(planRoot) === "plans" && path.basename(evidenceRoot) === "evidence" && path.dirname(planRoot) === path.dirname(evidenceRoot);
  const useCoordinator = Boolean(environment.RUNTIME_ROOT) || (!environment.PLAN_REPOSITORY_ROOT && !environment.EVIDENCE_REPOSITORY_ROOT) || configuredAsRuntimePair;
  const runtimeRoot = configuredRuntimeRoot ?? path.resolve(configuredAsRuntimePair ? path.dirname(planRoot) : "runtime");
  const coordinator = useCoordinator ? new RuntimeCoordinator({ root: runtimeRoot }) : undefined;
  if ((priceHistoryFeatureEnabled || priceTargetsFeatureEnabled) && !coordinator) {
    throw new Error("production price history requires the shared runtime coordinator");
  }
  const priceRepository = new PriceRepository(coordinator ? { coordinator } : { runtimeRoot });
  const evidenceRepository = useCoordinator ? new FileEvidenceRepository({ coordinator, runtimeRoot }) : new FileEvidenceRepository({ root: evidenceRoot });
  const evidenceClaimRepository = useCoordinator
    ? new EvidenceClaimRepository({ coordinator: coordinator!, runtimeRoot, evidence: evidenceRepository })
    : new EvidenceClaimRepository({ root: evidenceRoot, evidence: evidenceRepository });
  const attachmentRepository = useCoordinator
    ? new AttachmentRepository({ coordinator: coordinator!, runtimeRoot })
    : new AttachmentRepository({ root: path.join(runtimeRoot, "attachments") });
  const artifactRepository = useCoordinator
    ? new FileArtifactRepository({ coordinator: coordinator! })
    : new FileArtifactRepository({ root: path.join(runtimeRoot, "artifacts") });
  let repository!: FilePlanRepository<TConfig>;
  let evaluationLockRepository!: EvaluationLockRepository;
  const localPlanAtRoot = (activeRoot: string) => new FilePlanRepository<TConfig>({
    root: path.join(activeRoot, "plans"), topologyV3Enabled: topologyV3Enabled(environment),
    factGraphEnabled: factsFeatureEnabled,
    verifyEvaluationLock: (lock) => evaluationLockRepository.verifyAtRoot(activeRoot, lock),
    verifyIssuedEvaluation: (proof) => evaluationLockRepository.verifyIssuedEvaluationAtRoot(activeRoot, proof),
    getCatalog: () => loadAuthoritativeCatalogAtRoot(activeRoot, { runtimeRoot }),
    getEvidenceDocument: (documentId) => evidenceRepository.getDocumentAtRoot(activeRoot, documentId),
    getEvidenceCapture: (captureId) => evidenceRepository.getCaptureAtRoot(activeRoot, captureId),
  });
  const observationRepository = new ObservationRepository({
    ...(useCoordinator ? { coordinator: coordinator!, runtimeRoot } : { root: path.join(runtimeRoot, "observations") }),
    attachments: attachmentRepository,
    projectionContextForObservation: async (observation, activeRoot) => {
      const plan = activeRoot ? await localPlanAtRoot(activeRoot).get(observation.planId) : await repository.get(observation.planId);
      return resolveObservationProjectionContext(observation.planId, plan.draft.config, observation.subjectRef);
    },
  });
  let updateDecisionRepository!: UpdateDecisionRepository;
  // Candidate history remains readable when the inference kill switch is off.
  // The switch controls replay/current participation and all new writes, not
  // deletion or concealment of immutable approval history.
  const workspaceInferenceCandidates = useCoordinator
    ? new InferenceCandidateRepository(coordinator!) : null;
  const workspaceInferenceApprovalCapability = Object.freeze({ kind: "workspace-inference-read-authority" });
  let workspaceInferenceService: InferenceCandidateService | null = null;
  let factRepository: FactRepository;
  factRepository = new FactRepository({
    ...(useCoordinator ? { coordinator: coordinator!, runtimeRoot } : { root: path.join(runtimeRoot, "facts") }),
    evidenceClaims: evidenceClaimRepository,
    observations: observationRepository,
    acceptedUpdateDecisions: {
      getActiveDecision: (decisionId) => updateDecisionRepository.getActiveDecision(decisionId),
      getActiveDecisionAtRoot: (activeRoot, decisionId) => updateDecisionRepository.getActiveDecisionAtRoot(activeRoot, decisionId),
    },
    currentInferenceArtifactHash: async (trace, activeRoot) => {
      if (!factsFeatureEnabled || !inferenceFeatureEnabled) return null;
      try {
        if (!activeRoot) return null;
        const registration = inferenceRegistrations.find(({ ruleId }) => ruleId === trace.ruleOrModelId);
        if (!registration || registration.artifactRef !== `sha256:${trace.ruleOrModelArtifactHash}`) return null;
        const inspected = await inspectGovernedInferenceArtifactAtRoot({
          artifacts: artifactRepository,
          activeRoot,
          artifactRef: registration.artifactRef,
          trace,
          registration,
        });
        return inspected.ok ? inspected.artifactHash : null;
      } catch (error) {
        if (["missing_manifest", "not_found"].includes(String((error as { code?: unknown }).code ?? ""))) return null;
        throw error;
      }
    },
    requireCandidateApprovalForInference: useCoordinator,
    ...(workspaceInferenceCandidates ? {
      inferenceCandidateApprovalAuthority: {
        approvalCapability: workspaceInferenceApprovalCapability,
        async resolveForApprovalAtRoot(): Promise<never> {
          throw new Error("workspace inference authority is read-only");
        },
        async resolveCurrentFactAtRoot(
          activeRoot: string,
          runtimeGeneration: number,
          candidateId: string,
          expectedCandidateHash: string,
          currentFacts: readonly Readonly<import("../facts/contracts").FactRecord>[],
        ): Promise<import("../facts/inference-candidate-service").ResolvedInferenceCandidateApproval | null> {
          workspaceInferenceService ??= new InferenceCandidateService({
            coordinator: coordinator!,
            facts: factRepository,
            artifacts: artifactRepository,
            candidates: workspaceInferenceCandidates,
            planAuthority: createFilePlanInferenceAuthority({ topologyV3Enabled: topologyV3Enabled(environment) }),
            rules: inferenceRegistrations,
          });
          return workspaceInferenceService.resolveCurrentFactAtRoot(
            activeRoot,
            runtimeGeneration,
            candidateId,
            expectedCandidateHash,
            currentFacts,
          );
        },
      },
    } : {}),
  });
  updateDecisionRepository = new UpdateDecisionRepository({
    ...(useCoordinator ? { coordinator: coordinator!, runtimeRoot } : { root: path.join(runtimeRoot, "facts") }),
    snapshots: factRepository,
  });
  const inferenceSummary = workspaceInferenceCandidates && coordinator
    ? new PlanInferenceSummaryService({
      coordinator,
      candidates: workspaceInferenceCandidates,
      facts: factRepository,
      featureEnabled: factsFeatureEnabled && inferenceFeatureEnabled,
      resolveCurrentFactAtRoot: async (activeRoot, runtimeGeneration, candidateId, expectedCandidateHash, currentFacts) => {
        workspaceInferenceService ??= new InferenceCandidateService({
          coordinator,
          facts: factRepository,
          artifacts: artifactRepository,
          candidates: workspaceInferenceCandidates,
          planAuthority: createFilePlanInferenceAuthority({ topologyV3Enabled: topologyV3Enabled(environment) }),
          rules: inferenceRegistrations,
        });
        return workspaceInferenceService.resolveCurrentFactAtRoot(
          activeRoot,
          runtimeGeneration,
          candidateId,
          expectedCandidateHash,
          currentFacts,
        );
      },
    })
    : undefined;
  evaluationLockRepository = new EvaluationLockRepository({
    ...(useCoordinator ? { coordinator: coordinator!, runtimeRoot } : { root: path.join(runtimeRoot, "snapshots") }),
    facts: factRepository,
    observations: observationRepository,
    ...(useCoordinator ? {
      verifyFactSnapshotClosureAtRoot: async (activeRoot: string, snapshotId: string, expectedHash: string) => {
        const closure = await factRepository.getSnapshotClosureAtRoot(activeRoot, snapshotId);
        if (!closure || closure.snapshot.contentHash !== expectedHash) return false;
        const decisionIds = [...new Set(closure.conflicts.flatMap((conflict) => conflict.decisionIds))];
        const decisions = await Promise.all(decisionIds.map((decisionId) => updateDecisionRepository.getDecisionAtRoot(activeRoot, decisionId)));
        return decisions.every(Boolean)
          && await verifyResolvedFactSnapshotClosure({ ...closure, decisions: decisions.filter((decision) => decision !== null) });
      },
      verifyObservationSnapshotClosureAtRoot: async (
        activeRoot: string,
        planId: string,
        snapshotId: string,
        expectedConfigHash: string,
        expectedHash: string,
      ) => {
        const snapshot = await observationRepository.getSnapshotAtRoot(activeRoot, planId, snapshotId);
        return snapshot?.contentHash === expectedHash
          && await observationRepository.verifySnapshotClosureAtRoot(activeRoot, planId, snapshotId, expectedConfigHash);
      },
    } : {}),
    verifyArtifact: authority.verifyArtifact ?? (() => false),
    ...(authority.verifyArtifactAtRoot ? { verifyArtifactAtRoot: authority.verifyArtifactAtRoot } : useCoordinator ? { verifyArtifactAtRoot: async () => false } : {}),
    verifyExternalSnapshotHashes: authority.verifyExternalSnapshotHashes ?? (() => false),
    ...(authority.verifyExternalSnapshotHashesAtRoot ? { verifyExternalSnapshotHashesAtRoot: authority.verifyExternalSnapshotHashesAtRoot } : useCoordinator ? { verifyExternalSnapshotHashesAtRoot: async () => false } : {}),
  });
  repository = new FilePlanRepository<TConfig>({
    ...(useCoordinator ? { coordinator: coordinator!, runtimeRoot } : { root: planRoot }),
    topologyV3Enabled: topologyV3Enabled(environment),
    factGraphEnabled: factsFeatureEnabled,
    verifyEvaluationLock: (lock) => evaluationLockRepository.verify(lock),
    ...(useCoordinator ? { verifyEvaluationLockAtRoot: (activeRoot: string, lock: Parameters<EvaluationLockRepository["verifyAtRoot"]>[1]) => evaluationLockRepository.verifyAtRoot(activeRoot, lock) } : {}),
    ...(useCoordinator ? {
      verifyIssuedEvaluationAtRoot: (activeRoot: string, proof: import("../plans/file-repository").IssuedEvaluationProof) =>
        evaluationLockRepository.verifyIssuedEvaluationAtRoot(activeRoot, proof),
    } : {}),
    getCatalog: () => loadMergedCatalogSync({ persistRoot: runtimeRoot, direct: true, generationAware: false }),
    ...(useCoordinator ? { getCatalogAtRoot: (activeRoot: string) => loadAuthoritativeCatalogAtRoot(activeRoot, { runtimeRoot }) } : {}),
    getEvidenceDocument: (documentId) => evidenceRepository.getDocument(documentId),
    getEvidenceCapture: (captureId) => evidenceRepository.getCapture(captureId),
    ...(useCoordinator ? {
      getEvidenceDocumentAtRoot: (activeRoot: string, documentId: string) => evidenceRepository.getDocumentAtRoot(activeRoot, documentId),
      getEvidenceCaptureAtRoot: (activeRoot: string, captureId: string) => evidenceRepository.getCaptureAtRoot(activeRoot, captureId),
    } : {}),
  });
  let evaluationPipeline = authority.pipeline;
  let factUpdateNoticeService: FactUpdateNoticeService | undefined;
  let productionSnapshots: EvaluationSnapshotAuthority | undefined;
  let productionTargets: EvaluationTargetAuthority | undefined;
  if (!evaluationPipeline && useCoordinator && factsFeatureEnabled) {
    const targetAuthority: EvaluationTargetAuthority = {
      readTargetAtRoot: async (activeRoot: string, planId: string, target: import("./evaluation-service").EvaluationTargetRequest) => {
        const local = localPlanAtRoot(activeRoot);
        const plan = await local.get(planId);
        if (target.kind === "draft") {
          return {
            planId,
            planVersionId: null,
            draftRevision: plan.draftRevision,
            config: parseConfig(JSON.stringify(plan.draft.config), { topologyV3Enabled: true }),
          };
        }
        const version = (await local.listVersions(planId)).find((candidate) => candidate.id === target.versionId);
        if (!version) throw new Error("evaluation target version was not found");
        if (!version.evaluationLock) throw new Error("fact graph PlanVersion is missing its immutable evaluation lock");
        return {
          planId,
          planVersionId: version.id,
          draftRevision: 0,
          config: parseConfig(JSON.stringify(version.config), { topologyV3Enabled: true }),
          pinnedEvaluationLock: structuredClone(version.evaluationLock),
        };
      },
    };
    const repositorySnapshots = createRepositoryBackedEvaluationSnapshotAuthority({
      runtimeRoot,
      facts: factRepository,
      observations: observationRepository,
      decisions: updateDecisionRepository,
      locks: evaluationLockRepository,
      genericAdaptersEnabled: genericAdaptersFeatureEnabled,
      progressiveEvaluationEnabled: progressiveEvaluationFeatureEnabled,
      thermalV3Enabled: thermalV3FeatureEnabled,
      acousticV3Enabled: acousticV3FeatureEnabled,
      systemProfilesEnabled: systemProfilesFeatureEnabled,
      userObservationsEnabled: userObservationsFeatureEnabled,
      capabilityUniverseEnabled: wholeBuildSolverFeatureEnabled,
    });
    productionTargets = targetAuthority;
    productionSnapshots = authority.snapshots ?? repositorySnapshots;
    let repositoryNoticeService!: FactUpdateNoticeService;
    evaluationPipeline = new AuthoritativeEvaluationSnapshotPipeline({
      runtimeRoot,
      coordinator: coordinator!,
      factGraphEnabled: true,
      genericAdaptersEnabled: genericAdaptersFeatureEnabled,
      targets: targetAuthority,
      snapshots: productionSnapshots,
      locks: evaluationLockRepository,
      receipts: evaluationLockRepository,
      factCandidates: {
        resolveAtRoot: async (activeRoot, input) => {
          const closure = await repositoryNoticeService.resolveFactUpdateSnapshotAtRoot(activeRoot, {
            planId: input.planId,
            target: input.targetRequest,
            updateNoticeId: input.updateNoticeId,
            phase: input.phase,
          });
          const decisionIds = [...new Set(closure.conflicts.flatMap((conflict) => conflict.decisionIds))].sort();
          const decisions = await Promise.all(decisionIds.map(async (decisionId) => {
            const decision = await updateDecisionRepository.getDecisionAtRoot(activeRoot, decisionId);
            if (!decision) throw new Error(`fact candidate conflict decision closure is unavailable: ${decisionId}`);
            return decision;
          }));
          return { ...closure, decisions };
        },
      },
      evaluator: authority.evaluator ?? createBuiltinGovernedEvaluator({
        progressiveEvaluationEnabled: progressiveEvaluationFeatureEnabled,
        thermalV3Enabled: thermalV3FeatureEnabled,
        acousticV3Enabled: acousticV3FeatureEnabled,
        ...(systemProfilesFeatureEnabled ? { authorityResolver: { resolveSystemCheckAuthorities: resolveProductionSystemCheckAuthorities } } : {}),
      }),
    });
    repositoryNoticeService = new FactUpdateNoticeService({
      runtimeRoot,
      coordinator: coordinator!,
      facts: factRepository,
      decisions: updateDecisionRepository,
      plans: {
        resolvePlanNoticeContextAtRoot: async (activeRoot, planId) => {
          const plan = await localPlanAtRoot(activeRoot).get(planId);
          const target = {
            kind: "draft" as const,
            expectedDraftRevision: plan.draftRevision,
            expectedConfigHash: await hashPlanConfig(plan.draft.config),
          };
          const lock = await evaluationLockRepository.currentLockAtRoot(activeRoot, planId, {
            kind: "draft",
            draftRevision: plan.draftRevision,
          });
          if (!lock) throw new Error("fact update notices require an initial authoritative plan evaluation");
          return {
            target,
            pinnedSnapshotRef: { snapshotId: lock.factSnapshotId, contentHash: lock.snapshotHashes.factSnapshotHash },
          };
        },
      },
      relevantFacts: {
        selectRelevantProductFactIdsAtRoot: async (activeRoot, planId, target, currentProductFacts) => {
          const plan = await localPlanAtRoot(activeRoot).get(planId);
          if (target.kind !== "draft" || target.expectedDraftRevision !== plan.draftRevision
            || target.expectedConfigHash !== await hashPlanConfig(plan.draft.config)) {
            throw new Error("fact update relevance target changed");
          }
          const skuIds = evaluationRelevantSkuIds(plan.draft.config);
          return currentProductFacts
            .filter((fact) => fact.subject.kind === "product" && skuIds.has(fact.subject.skuId))
            .map((fact) => fact.factId)
            .sort();
        },
      },
      evaluator: {
        evaluateFactUpdateTarget: async (input) => {
          const notice = await repositoryNoticeService.view(input.planId, input.updateNoticeId);
          const receipt = await evaluationPipeline!.evaluateAuthorizedFactCandidate(input);
          return factUpdateSnapshotReceipt(receipt, notice.affectedDomains);
        },
      },
    });
    factUpdateNoticeService = repositoryNoticeService;
  }
  const evidenceNetworkEnabled = strictBoolean(environment, "BUILD_SIM_EVIDENCE_NETWORK_ENABLED");
  const provisionalCaseAdapterAuthority = durableJobsEnabled && genericAdaptersFeatureEnabled
    && topologyV3Enabled(environment) && coordinator
    ? new FileRootBoundProvisionalCaseAdapterAuthority({
      plans: repository as unknown as FilePlanRepository<BuildConfigV3>,
      facts: factRepository,
      claims: evidenceClaimRepository,
      evidence: evidenceRepository,
      jobs: new FileJobRepository({ coordinator }),
      catalogAtRoot: (activeRoot) => loadAuthoritativeCatalogAtRoot(activeRoot, { runtimeRoot }),
    })
    : undefined;
  const jobCenter = durableJobsEnabled && coordinator
    ? new ProductionWorkspaceJobCenter(new FileJobRepository({ coordinator }))
    : undefined;
  const operations = coordinator && (backupRestoreFeatureEnabled || doctorFeatureEnabled)
    ? new ProductionWorkspaceOperations({ coordinator, runtimeRoot })
    : undefined;
  const portability = coordinator && portabilityFeatureEnabled && backupRestoreFeatureEnabled && operations
    ? new ProductionWorkspacePortability({ coordinator, runtimeRoot, operations })
    : undefined;
  const evidenceJobs = durableJobsEnabled && coordinator
    ? createProductionEvidenceJobRuntime({
      runtimeRoot,
      coordinator,
      evidenceRepository,
      artifactRepository,
      factRepository,
      topologyV3Enabled: topologyV3Enabled(environment),
      // Network is a separate fail-closed production switch. Neither enqueue
      // nor any route can replace this authority callback.
      online: () => evidenceNetworkEnabled,
      thirdPartyDiscovery: createDefaultThirdPartyDiscovery({
        provider: createSearXngDiscoveryProvider(environment) as ReturnType<typeof createSearXngDiscoveryProvider> & { readonly id: "searxng" },
      }),
      ...(provisionalCaseAdapterAuthority ? {
        provisionalCaseAdapter: {
          service: new ProvisionalCaseAdapterService(coordinator, provisionalCaseAdapterAuthority),
          resolveCaseComponentInstanceIdAtRoot: provisionalCaseAdapterAuthority.resolveCaseComponentInstanceIdAtRoot
            .bind(provisionalCaseAdapterAuthority),
        },
      } : {}),
    })
    : undefined;
  let planResolutionSummary: ProductionWorkspacePlanResolutionSummary | undefined;
  let wholeBuildSolver: ProductionWholeBuildSolverRuntime | undefined;
  let recommendations: ProductionRecommendationService | undefined;
  let scenarioWhatIf: ProductionScenarioWhatIfRuntime | undefined;
  if (wholeBuildSolverFeatureEnabled || scenarioWhatIfFeatureEnabled) {
    if (!coordinator || !productionSnapshots || !productionTargets || !evaluationPipeline) {
      throw new Error("solver and scenario what-if require the repository-backed evaluation composition");
    }
    const solverArtifacts = new SolverArtifactStore(artifactRepository);
    const solverEvaluationAuthority = createRootBoundSolverEvaluationAuthority({
      targets: productionTargets,
      snapshots: productionSnapshots,
      locks: evaluationLockRepository,
    });
    const candidateInputs = createPipelineSolverCandidateInputAuthority(evaluationPipeline);
    const evaluator = new ProductionAuthoritativeSolverEvaluator({
      coordinator,
      authority: solverEvaluationAuthority,
      candidateInputs,
      governedEvaluator: {
        authorityKind: "governed-solver-candidate-evaluator-v1",
        evaluate: (input) => evaluationPipeline.evaluateDetachedGovernedInput(input),
      },
      artifacts: solverArtifacts,
    });
    if (wholeBuildSolverFeatureEnabled) {
      const solverAuthorities = createProductionSolverBaseAuthorities({
        evaluationAuthority: solverEvaluationAuthority,
        receipts: evaluationLockRepository,
        versionAtRoot: async (activeRoot, planId, versionId) => {
          const version = (await localPlanAtRoot(activeRoot).listVersions(planId))
            .find((candidate) => candidate.id === versionId);
          return version?.config.schemaVersion === "3.0.0"
            ? structuredClone(version as import("../plans/contracts").PlanVersion<BuildConfigV3>)
            : null;
        },
        artifactsAtRoot: (activeRoot) => new SolverArtifactStore(new FileArtifactRepository({
          root: path.join(activeRoot, "artifacts"),
        })),
      });
      wholeBuildSolver = new ProductionWholeBuildSolverRuntime({
        coordinator,
        artifacts: solverArtifacts,
        ...solverAuthorities,
        candidateService: createProductionCapabilityCandidateService({
          coordinator,
          facts: factRepository,
          claims: evidenceClaimRepository,
        }),
        evaluator,
      });
      if (recommendationsFeatureEnabled) {
        recommendations = new ProductionRecommendationService({
          coordinator,
          solver: wholeBuildSolver.service,
          candidateInputs,
          evaluator: {
            authorityKind: "governed-solver-candidate-evaluator-v1",
            evaluate: (input) => evaluationPipeline.evaluateDetachedGovernedInput(input),
          },
          prices: priceRepository,
        });
      }
    }
    if (scenarioWhatIfFeatureEnabled) {
      const resolveScenarioBaseAtRoot = async (activeRoot: string, versionId: string): Promise<ScenarioBaseSnapshot | null> => {
        const local = localPlanAtRoot(activeRoot);
        const matches: ScenarioBaseSnapshot[] = [];
        for (const summary of await local.list()) {
          const version = (await local.listVersions(summary.id)).find((candidate) => candidate.id === versionId);
          if (!version || version.config.schemaVersion !== "3.0.0" || !version.evaluationLock || !version.evaluationHash) continue;
          matches.push({
            planId: summary.id,
            planVersionId: version.id,
            config: structuredClone(version.config as unknown as BuildConfigV3),
            configHash: version.configHash,
            snapshotHashes: structuredClone(version.evaluationLock.snapshotHashes),
          });
        }
        if (matches.length > 1) throw new Error("scenario base version identity is ambiguous");
        return matches[0] ?? null;
      };
      const scenarios = new FileScenarioRepository({
        coordinator,
        runtimeRoot,
        resolveBaseAtRoot: resolveScenarioBaseAtRoot,
      });
      scenarioWhatIf = new ProductionScenarioWhatIfRuntime({
        scenarios,
        plans: repository as unknown as FilePlanRepository<BuildConfigV3>,
        evaluator,
        artifacts: solverArtifacts.writer(),
        snapshotAuthority: createPipelineWhatIfSnapshotAuthority({ coordinator, candidates: candidateInputs }),
      });
    }
  }
  const systemExecution = buildExecutionFeatureEnabled && systemProfilesFeatureEnabled && coordinator && evaluationPipeline
    ? new ProductionSystemExecutionRuntime({
      coordinator,
      locks: evaluationLockRepository,
      facts: factRepository,
      observations: observationRepository,
      storageLayoutEnabled: storageLayoutFeatureEnabled,
      plans: {
        versionAtRoot: async (activeRoot, planId, planVersionId) => {
          const version = (await localPlanAtRoot(activeRoot).listVersions(planId))
            .find((candidate) => candidate.id === planVersionId);
          return version?.config.schemaVersion === "3.0.0"
            ? structuredClone(version as import("../plans/contracts").PlanVersion<BuildConfigV3>) : null;
        },
        versionIdsAtRoot: async (activeRoot, planId) => (
          (await localPlanAtRoot(activeRoot).listVersions(planId)).map(({ id }) => id).sort()
        ),
        activeVersionIdAtRoot: async (activeRoot, planId) => (
          (await localPlanAtRoot(activeRoot).get(planId)).activeVersionId
        ),
      },
    }) : undefined;
  const spatialScene = spatialRoutingFeatureEnabled && genericAdaptersFeatureEnabled && topologyV3Enabled(environment) && coordinator
    ? new ProductionWorkspaceSpatialScene({
      coordinator,
      locks: evaluationLockRepository,
      plans: {
        versionAtRoot: async (activeRoot, planId, planVersionId) => {
          const version = (await localPlanAtRoot(activeRoot).listVersions(planId))
            .find((candidate) => candidate.id === planVersionId);
          return version?.config.schemaVersion === "3.0.0"
            ? structuredClone(version as import("../plans/contracts").PlanVersion<BuildConfigV3>)
            : null;
        },
      },
    })
    : undefined;
  const planPrices = priceHistoryFeatureEnabled && coordinator
    ? new ProductionPlanPriceService({
      coordinator,
      prices: priceRepository,
      plans: repository,
      locks: {
        currentLockAtRoot: (activeRoot, planId, target) => evaluationLockRepository.currentLockAtRoot(activeRoot, planId, target),
        hydrateExternalInputsAtRoot: (activeRoot, lock) => evaluationLockRepository.hydrateExternalInputsAtRoot(activeRoot, lock as PlanEvaluationLock),
      },
    })
    : undefined;
  const currentPriceSnapshots = priceHistoryFeatureEnabled && coordinator
    ? new CurrentPriceSnapshotService({
      coordinator,
      prices: priceRepository,
      catalog: (activeRoot) => loadMergedCatalogSync({ activeRoot, runtimeRoot }),
    })
    : undefined;
  const priceObservationIntake = priceHistoryFeatureEnabled && coordinator && currentPriceSnapshots
    ? new ProductionPriceObservationIntake({
      coordinator,
      plans: repository,
      prices: priceRepository,
      snapshots: currentPriceSnapshots,
    })
    : undefined;
  planResolutionSummary = coordinator
    ? new ProductionWorkspacePlanResolutionSummary({
      coordinator,
      ...(evidenceJobs ? { evidenceJobs } : {}),
      ...(inferenceSummary ? { inferenceSummary } : {}),
      ...(planPrices ? { planPrices } : {}),
      claimScopes: new ProductionPlanClaimScopeSummary({
        plans: repository,
        claims: evidenceClaimRepository,
      }),
    })
    : undefined;
  const priceRuntime = priceHistoryFeatureEnabled && coordinator && planPrices && currentPriceSnapshots
    ? new ProductionPriceRuntime({
      coordinator,
      prices: priceRepository,
      planPrices,
      snapshots: currentPriceSnapshots,
      currentSnapshotAtRoot: (activeRoot) => loadRuntimePriceSnapshot({ runtimeRoot, activeRoot, allowSeedFallback: false }),
      online: () => priceNetworkFeatureEnabled,
    })
    : undefined;
  return {
    repository, evidenceRepository, evidenceClaimRepository, attachmentRepository, observationRepository,
    artifactRepository, priceRepository,
    factRepository, updateDecisionRepository, evaluationLockRepository,
    ...(evaluationPipeline ? { evaluationPipeline } : {}),
    ...(factUpdateNoticeService ? { factUpdateNoticeService } : {}),
    ...(evidenceJobs ? { evidenceJobs } : {}),
    ...(inferenceSummary ? { inferenceSummary } : {}),
    ...(planResolutionSummary ? { planResolutionSummary } : {}),
    ...(wholeBuildSolver ? { wholeBuildSolver } : {}),
    ...(scenarioWhatIf ? { scenarioWhatIf } : {}),
    ...(systemExecution ? { systemExecution } : {}),
    ...(spatialScene ? { spatialScene } : {}),
    ...(currentPriceSnapshots ? { currentPriceSnapshots } : {}),
    ...(priceObservationIntake ? { priceObservationIntake } : {}),
    ...(planPrices ? { planPrices } : {}),
    ...(priceRuntime ? { priceRuntime } : {}),
    ...(recommendations ? { recommendations } : {}),
    ...(jobCenter ? { jobCenter } : {}),
    ...(operations ? { operations } : {}),
    ...(portability ? { portability } : {}),
    planRoot, evidenceRoot, ...(coordinator ? { coordinator } : {}),
  };
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}

/**
 * Production Agent-context authority. Summary derivation, plan validation and
 * audit persistence are one coordinator writer over one immutable active root.
 */
export function createProductionWorkspaceAgentContextAuthority(options: {
  coordinator: RuntimeCoordinator;
  repository: FilePlanRepository;
  auditStore: FilePlanAgentContextAuditStore;
  planResolutionSummary?: RootBoundWorkspacePlanResolutionSummaryAuthority;
  now?: () => string;
}): WorkspaceAgentContextRecordAuthority {
  return Object.freeze({
    async record(input: { sessionId: string; runId: string; context: PlanAgentContext }) {
      await options.coordinator.initialize();
      await options.planResolutionSummary?.initialize();
      return (await options.coordinator.withWrite(async ({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => {
        const serverSummary = options.planResolutionSummary
          ? await options.planResolutionSummary.forPlanAtRoot(
            activeRoot,
            state.runtimeGeneration,
            input.context.planId,
          )
          : { resolutions: [], inferences: [], claimScopeCount: 0, claimScopes: [], price: null };
        const context = withServerDerivedPlanResolution(input.context, serverSummary);
        const audit = await recordPlanAgentRunContextAtRoot(
          options.repository,
          options.auditStore,
          activeRoot,
          { ...input, context },
          options.now,
        );
        return { audit, context };
      })).result;
    },
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createWorkspaceServer(repository: PlanRepository, options: {
  agentContextAuditStore?: PlanAgentContextAuditStore;
  agentContextAuthority?: WorkspaceAgentContextRecordAuthority;
  coordinator?: RuntimeCoordinator;
  evaluationPipeline?: AuthoritativeEvaluationSnapshotPipeline;
  factUpdateNoticeService?: FactUpdateNoticeService;
  evidenceJobs?: EvidenceJobRouteRuntime;
  evidenceJobsEnabled?: boolean;
  factGraphEnabled?: boolean;
  planResolutionSummary?: RootBoundWorkspacePlanResolutionSummaryAuthority;
  wholeBuildSolver?: WholeBuildSolverRouteRuntime;
  wholeBuildSolverEnabled?: boolean;
  scenarioWhatIf?: ScenarioWhatIfRouteRuntime;
  scenarioWhatIfEnabled?: boolean;
  systemExecution?: ProductionSystemExecutionRuntime;
  spatialScene?: WorkspaceSpatialSceneAuthority;
  spatialRoutingEnabled?: boolean;
  topologyV3Enabled?: boolean;
  systemProfilesEnabled?: boolean;
  userObservationsEnabled?: boolean;
  buildExecutionV3Enabled?: boolean;
  storageLayoutEnabled?: boolean;
  planPrices?: ProductionPlanPriceService;
  priceObservationIntake?: ProductionPriceObservationIntake;
  priceHistoryEnabled?: boolean;
  priceTargetsEnabled?: boolean;
  recommendations?: ProductionRecommendationService;
  recommendationsEnabled?: boolean;
  jobCenter?: ProductionWorkspaceJobCenter;
  jobCenterEnabled?: boolean;
  operations?: ProductionWorkspaceOperations;
  backupRestoreEnabled?: boolean;
  doctorEnabled?: boolean;
  portability?: ProductionWorkspacePortability;
  portabilityEnabled?: boolean;
} = {}): http.Server {
  const agentContextAuditStore = options.agentContextAuditStore ?? new MemoryPlanAgentContextAuditStore();
  const agentContextAuthority = options.agentContextAuthority ?? (
    options.coordinator
      && repository instanceof FilePlanRepository
      && agentContextAuditStore instanceof FilePlanAgentContextAuditStore
      ? createProductionWorkspaceAgentContextAuthority({
        coordinator: options.coordinator,
        repository,
        auditStore: agentContextAuditStore,
        ...(options.planResolutionSummary ? { planResolutionSummary: options.planResolutionSummary } : {}),
      })
      : undefined
  );
  const proposalService = new PlanProposalService(repository);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (await handleWorkspaceOperationsBinaryRoute({
      request,
      response,
      pathname: url.pathname,
      ...(options.operations ? { operations: options.operations } : {}),
      enabled: options.doctorEnabled === true,
    })) return;
    if (await handleWorkspacePortabilityBinaryRoute({
      request,
      response,
      pathname: url.pathname,
      ...(options.portability ? { portability: options.portability } : {}),
      enabled: options.portabilityEnabled === true,
    })) return;
    let body: unknown = {};
    try {
      if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") body = await readJson(request);
    } catch (error) {
      send(response, 400, { error: "invalid_request", message: error instanceof Error ? error.message : "Invalid request" });
      return;
    }
    const result = await handleWorkspaceRoute(request.method, url.pathname, body, repository, {
      proposalService,
      agentContextAuditStore,
      ...(agentContextAuthority ? { agentContextAuthority } : {}),
      ...(options.evaluationPipeline ? { evaluationPipeline: options.evaluationPipeline } : {}),
      ...(options.factUpdateNoticeService ? { factUpdateNoticeService: options.factUpdateNoticeService } : {}),
      ...(options.evidenceJobs ? { evidenceJobs: options.evidenceJobs } : {}),
      evidenceJobsEnabled: options.evidenceJobsEnabled === true,
      factGraphEnabled: options.factGraphEnabled === true,
      ...(options.planResolutionSummary ? { planResolutionSummary: options.planResolutionSummary } : {}),
      ...(options.wholeBuildSolver ? { wholeBuildSolver: options.wholeBuildSolver } : {}),
      wholeBuildSolverEnabled: options.wholeBuildSolverEnabled === true,
      ...(options.scenarioWhatIf ? { scenarioWhatIf: options.scenarioWhatIf } : {}),
      scenarioWhatIfEnabled: options.scenarioWhatIfEnabled === true,
      ...(options.systemExecution ? { systemExecution: options.systemExecution } : {}),
      ...(options.spatialScene ? { spatialScene: options.spatialScene } : {}),
      spatialRoutingEnabled: options.spatialRoutingEnabled === true,
      topologyV3Enabled: options.topologyV3Enabled === true,
      systemProfilesEnabled: options.systemProfilesEnabled === true,
      userObservationsEnabled: options.userObservationsEnabled === true,
      buildExecutionV3Enabled: options.buildExecutionV3Enabled === true,
      storageLayoutEnabled: options.storageLayoutEnabled === true,
      ...(options.planPrices ? { planPrices: options.planPrices } : {}),
      ...(options.priceObservationIntake ? { priceObservationIntake: options.priceObservationIntake } : {}),
      priceHistoryEnabled: options.priceHistoryEnabled === true,
      priceTargetsEnabled: options.priceTargetsEnabled === true,
      ...(options.recommendations ? { recommendations: options.recommendations } : {}),
      recommendationsEnabled: options.recommendationsEnabled === true,
      ...(options.jobCenter ? { jobCenter: options.jobCenter } : {}),
      jobCenterEnabled: options.jobCenterEnabled === true,
      ...(options.operations ? { operations: options.operations } : {}),
      backupRestoreEnabled: options.backupRestoreEnabled === true,
      doctorEnabled: options.doctorEnabled === true,
      ...(options.portability ? { portability: options.portability } : {}),
      portabilityEnabled: options.portabilityEnabled === true,
    });
    send(response, result.status, result.payload);
  });
}

const isMain = process.argv[1] !== undefined
  && path.basename(process.argv[1]) === "workspace-server.js"
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void (async () => {
    const port = Number(process.env.WORKSPACE_SERVER_PORT ?? DEFAULT_PORT);
    if (!strictBoolean(process.env, "BUILD_SIM_GENERIC_ADAPTERS_ENABLED")) {
      // The rollback runtime is a separate lazy chunk. A flag-on production
      // bundle never evaluates or eagerly imports a concrete case runtime.
      const { registerLegacyV2CaseRuntimeAdapter } = await import("../adapters/legacy-runtime-bootstrap");
      registerLegacyV2CaseRuntimeAdapter();
    }
    const {
      repository, planRoot, coordinator, evaluationPipeline, factUpdateNoticeService,
      evidenceJobs, planResolutionSummary, wholeBuildSolver, scenarioWhatIf,
      systemExecution, spatialScene, planPrices, priceObservationIntake, priceRuntime, recommendations,
      jobCenter,
      operations,
      portability,
    } = createWorkspaceRepositories();
    await ensureDefaultPlan(repository);
    await evidenceJobs?.start();
    await wholeBuildSolver?.start();
    await priceRuntime?.start();
    const agentContextAuditStore = coordinator
      ? new FilePlanAgentContextAuditStore({ coordinator })
      : new FilePlanAgentContextAuditStore(path.join(planRoot, ".agent-context-audit"));
    const server = createWorkspaceServer(repository, {
      agentContextAuditStore,
      ...(coordinator ? { coordinator } : {}),
      ...(evaluationPipeline ? { evaluationPipeline } : {}),
      ...(factUpdateNoticeService ? { factUpdateNoticeService } : {}),
      ...(evidenceJobs ? { evidenceJobs } : {}),
      evidenceJobsEnabled: strictBoolean(process.env, "BUILD_SIM_DURABLE_JOBS_ENABLED"),
      factGraphEnabled: factGraphEnabled(process.env),
      ...(planResolutionSummary ? { planResolutionSummary } : {}),
      ...(wholeBuildSolver ? { wholeBuildSolver } : {}),
      wholeBuildSolverEnabled: strictBoolean(process.env, "BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED"),
      ...(scenarioWhatIf ? { scenarioWhatIf } : {}),
      scenarioWhatIfEnabled: strictBoolean(process.env, "BUILD_SIM_SCENARIO_WHAT_IF_ENABLED"),
      ...(systemExecution ? { systemExecution } : {}),
      ...(spatialScene ? { spatialScene } : {}),
      spatialRoutingEnabled: strictBoolean(process.env, "BUILD_SIM_SPATIAL_ROUTING_ENABLED"),
      topologyV3Enabled: topologyV3Enabled(process.env),
      systemProfilesEnabled: strictBoolean(process.env, "BUILD_SIM_SYSTEM_PROFILES_ENABLED"),
      userObservationsEnabled: strictBoolean(process.env, "BUILD_SIM_USER_OBSERVATIONS_ENABLED"),
      buildExecutionV3Enabled: strictBoolean(process.env, "BUILD_SIM_BUILD_EXECUTION_V3_ENABLED"),
      storageLayoutEnabled: strictBoolean(process.env, "BUILD_SIM_STORAGE_LAYOUT_ENABLED"),
      ...(planPrices ? { planPrices } : {}),
      ...(priceObservationIntake ? { priceObservationIntake } : {}),
      priceHistoryEnabled: strictBoolean(process.env, "BUILD_SIM_PRICE_HISTORY_ENABLED"),
      priceTargetsEnabled: strictBoolean(process.env, "BUILD_SIM_PRICE_TARGETS_ENABLED"),
      ...(recommendations ? { recommendations } : {}),
      recommendationsEnabled: strictBoolean(process.env, "BUILD_SIM_RECOMMENDATIONS_ENABLED"),
      ...(jobCenter ? { jobCenter } : {}),
      jobCenterEnabled: strictBoolean(process.env, "BUILD_SIM_DURABLE_JOBS_ENABLED"),
      ...(operations ? { operations } : {}),
      backupRestoreEnabled: strictBoolean(process.env, "BUILD_SIM_BACKUP_RESTORE_ENABLED"),
      doctorEnabled: strictBoolean(process.env, "BUILD_SIM_DOCTOR_REPAIR_ENABLED"),
      ...(portability ? { portability } : {}),
      portabilityEnabled: strictBoolean(process.env, "BUILD_SIM_PORTABILITY_ENABLED"),
    });
    server.once("close", () => { void Promise.all([evidenceJobs?.stop(), wholeBuildSolver?.stop(), priceRuntime?.stop()]); });
    server.listen(port, HOST, () => {
      console.log(`Build Sim workspace server listening on http://${HOST}:${port}`);
    });
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : "Workspace server failed to start");
    process.exitCode = 1;
  });
}
