import type { CaseAdapterArtifactPayload } from "../adapters";
import { verifyCaseAdapterSnapshotPayload } from "../adapters";
import type { BuildConfigV3 } from "../topology/contracts";
import type { PlanVersion } from "../plans/contracts";
import type { LoadedArtifactInputs } from "./evaluation-service";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { buildAuthoritativeSpatialScene, type AuthoritativeSpatialSceneSnapshot } from "../spatial/authoritative-scene";

export class SpatialProductionError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "invalid_authority", message: string) {
    super(message);
    this.name = "SpatialProductionError";
  }
}

export interface WorkspaceSpatialSceneAuthority {
  get(planId: string, planVersionId: string): Promise<AuthoritativeSpatialSceneSnapshot>;
}

interface RootBoundSpatialPlanAuthority {
  versionAtRoot(activeRoot: string, planId: string, planVersionId: string): Promise<PlanVersion<BuildConfigV3> | null>;
}

interface RootBoundSpatialArtifactAuthority {
  hydrateArtifactInputsAtRoot(activeRoot: string, lock: NonNullable<PlanVersion["evaluationLock"]>): Promise<LoadedArtifactInputs>;
}

export class ProductionWorkspaceSpatialScene implements WorkspaceSpatialSceneAuthority {
  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    plans: RootBoundSpatialPlanAuthority;
    locks: RootBoundSpatialArtifactAuthority;
  }) {}

  async get(planId: string, planVersionId: string): Promise<AuthoritativeSpatialSceneSnapshot> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const version = await this.options.plans.versionAtRoot(activeRoot, planId, planVersionId);
      if (!version) throw new SpatialProductionError("not_found", "spatial scene plan version was not found");
      if (!version.evaluationLock || !version.evaluationHash) {
        throw new SpatialProductionError("not_ready", "spatial scene requires an immutable governed evaluation");
      }
      const artifacts = await this.options.locks.hydrateArtifactInputsAtRoot(activeRoot, version.evaluationLock);
      const payload = artifacts.adapterSnapshot.payload;
      if (!await verifyCaseAdapterSnapshotPayload(payload)) {
        throw new SpatialProductionError("invalid_authority", "spatial scene adapter snapshot authority is invalid");
      }
      try {
        return buildAuthoritativeSpatialScene({
          planId,
          planVersionId,
          config: version.config,
          configHash: version.configHash,
          evaluationHash: version.evaluationHash,
          evaluationLockHash: version.evaluationLock.contentHash,
          adapterSnapshotHash: artifacts.adapterSnapshot.ref.contentHash,
          adapterPayload: payload as CaseAdapterArtifactPayload,
        });
      } catch (error) {
        throw new SpatialProductionError("not_ready", error instanceof Error ? error.message : "spatial scene cannot be projected");
      }
    })).result;
  }
}
