import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import type { FileArtifactRepository } from "../artifacts/repository.mjs";
import type { BuildConfigDocument } from "../config/types";
import { agentInferenceEnabled, factGraphEnabled } from "../config/io";
import { hashPlanConfig } from "../plans/canonical";
import { FilePlanRepository } from "../plans/file-repository";
import { confined } from "../runtime/fs.mjs";
import type { FactRecord } from "./contracts";
import { factSubjectKey } from "./resolver";
import {
  InferenceCandidateService,
  InferenceCandidateServiceError,
  ensureBuiltinInferenceRuleRegistrations,
  type GovernedInferenceRuleRegistration,
  type InferenceCandidateServiceOptions,
  type InferencePlanAuthority,
} from "./inference-candidate-service";
import type { ReplayableInferenceTrace } from "./inference-policy";
import { inspectGovernedInferenceArtifactAtRoot } from "./inference-artifact-authority.mjs";

export const AGENT_INFERENCE_FEATURE_FLAG = "BUILD_SIM_AGENT_INFERENCE_ENABLED" as const;

/** Inference production writes exist only when both independent rollout gates are on. */
export function inferenceProductionEnabled(environment: Record<string, string | undefined>): boolean {
  const factsEnabled = factGraphEnabled(environment);
  const inferenceEnabled = agentInferenceEnabled(environment);
  return factsEnabled && inferenceEnabled;
}

function selectedSkuIds(config: BuildConfigDocument): Set<string> {
  if (config.schemaVersion === "3.0.0") {
    return new Set(config.components.flatMap((component) => (
      component.identity.status === "resolved" ? [component.identity.skuId] : []
    )));
  }
  return new Set([
    config.caseId,
    config.boardId,
    config.cpuId,
    config.selection.psuId,
    config.selection.secondaryPsuId,
    config.selection.coolerId,
    config.selection.gpuId,
    config.selection.memoryId,
    config.selection.diskSkuId,
    config.selection.hbaSkuId,
    ...config.bom.map((line) => line.skuId),
  ].filter((skuId): skuId is string => typeof skuId === "string" && skuId.length > 0));
}

/** Root-bound plan/SKU authority used by production inference composition. */
export function createFilePlanInferenceAuthority(options: {
  readonly topologyV3Enabled?: boolean;
} = {}): InferencePlanAuthority {
  return Object.freeze({
    async resolveAtRoot(activeRoot: string, planId: string, currentFacts: readonly Readonly<FactRecord>[]) {
      const catalog = loadMergedCatalogSync({ activeRoot, generationAware: true });
      const plans = new FilePlanRepository<BuildConfigDocument>({
        root: confined(activeRoot, "plans"),
        topologyV3Enabled: options.topologyV3Enabled === true,
        getCatalog: () => catalog,
      });
      const plan = await plans.get(planId);
      if (plan.status !== "active") {
        throw new InferenceCandidateServiceError("cross_plan", "inference plan authority is not active");
      }
      const skuIds = selectedSkuIds(plan.draft.config);
      const relevant = currentFacts.filter((fact) => fact.subject.kind === "plan_subject"
        ? fact.subject.planId === planId
        : skuIds.has(fact.subject.skuId));
      const productSubjectKeys = relevant.flatMap((fact) => fact.subject.kind === "product"
        ? [factSubjectKey(fact.subject)] : []);
      return {
        planDraftRevision: plan.draftRevision,
        planConfigHash: await hashPlanConfig(plan.draft.config),
        relevantFactIds: relevant.map(({ factId }) => factId),
        relevantProductSubjectKeys: [...new Set(productSubjectKeys)],
      };
    },
  });
}

/**
 * Server-owned registry whose hash resolver can be injected into FactRepository.
 * Disabled mode performs no artifact writes and cannot construct a write service;
 * repositories remain independently readable for rollback/audit.
 */
export class ProductionInferenceRuleRegistry {
  readonly enabled: boolean;
  private registrationsValue: readonly GovernedInferenceRuleRegistration[] = Object.freeze([]);
  private initialization: Promise<readonly GovernedInferenceRuleRegistration[]> | null = null;
  private artifactsValue: FileArtifactRepository | null = null;

  constructor(readonly environment: Record<string, string | undefined>) {
    this.enabled = inferenceProductionEnabled(environment);
  }

  registrations(): readonly GovernedInferenceRuleRegistration[] {
    return this.registrationsValue;
  }

  async initialize(
    artifacts: FileArtifactRepository,
    now: () => string = () => new Date().toISOString(),
  ): Promise<readonly GovernedInferenceRuleRegistration[]> {
    if (!this.enabled) return this.registrationsValue;
    this.artifactsValue = artifacts;
    if (!this.initialization) {
      this.initialization = ensureBuiltinInferenceRuleRegistrations(artifacts, now)
        .then((registrations) => {
          this.registrationsValue = Object.freeze([...registrations]);
          return this.registrationsValue;
        })
        .catch((error: unknown) => {
          this.initialization = null;
          throw error;
        });
    }
    return this.initialization;
  }

  currentArtifactHash = async (trace: ReplayableInferenceTrace, activeRoot?: string): Promise<string | null> => {
    if (!this.enabled) return null;
    const registration = this.registrationsValue.find(({ ruleId }) => ruleId === trace.ruleOrModelId);
    if (!registration || !this.artifactsValue || !activeRoot
      || registration.artifactRef !== `sha256:${trace.ruleOrModelArtifactHash}`) return null;
    const inspected = await inspectGovernedInferenceArtifactAtRoot({
      artifacts: this.artifactsValue,
      activeRoot,
      artifactRef: registration.artifactRef,
      trace,
      registration,
    });
    return inspected.ok ? inspected.artifactHash : null;
  };

  async createService(
    artifacts: FileArtifactRepository,
    options: Omit<InferenceCandidateServiceOptions, "artifacts" | "rules">,
    now: () => string = () => new Date().toISOString(),
  ): Promise<InferenceCandidateService> {
    if (!this.enabled) {
      throw new InferenceCandidateServiceError("invalid_input", "agent inference production writes are disabled");
    }
    const rules = await this.initialize(artifacts, now);
    return new InferenceCandidateService({ ...options, artifacts, rules });
  }
}
