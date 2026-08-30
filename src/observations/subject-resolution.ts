import type { BuildConfigDocument } from "../config/types";
import type { CaseAdapterManifest } from "../adapters/contracts";
import { hashPlanConfig, sha256Hex } from "../plans/canonical";
import type { BuildConfigV3 } from "../topology/contracts";
import type { ObservationProjectionContext, ObservationSubjectRef } from "./contracts";

/**
 * A manifest authority resolved under the same runtime root as the plan.  The
 * resolver deliberately consumes the locked manifest, never a transport-
 * supplied anchor, so an empty mount/port is still a real measurable subject.
 */
export interface CaseObservationAnchorScope {
  caseInstanceId: string;
  baseManifestHash: string;
  manifest: CaseAdapterManifest;
}

function governedCaseOwner(
  topology: BuildConfigV3,
  scope: CaseObservationAnchorScope | undefined,
): BuildConfigV3["components"][number] | null {
  if (!scope || scope.baseManifestHash !== scope.manifest.contentHash) return null;
  const owner = topology.components.find((item) => item.instanceId === scope.caseInstanceId);
  if (!owner || owner.kind !== "case" || owner.identity.status !== "resolved"
    || owner.identity.skuId !== scope.manifest.identity.skuId) return null;
  return owner;
}

function canonicalSubject(
  config: BuildConfigDocument,
  subject: ObservationSubjectRef,
  caseScope?: CaseObservationAnchorScope,
): unknown | null {
  if (subject.kind === "plan") return config;
  if (config.schemaVersion !== "3.0.0") return null;
  const topology = config as BuildConfigV3;
  if (subject.kind === "instance") return topology.components.find((item) => item.instanceId === subject.instanceId) ?? null;
  if (subject.kind === "placement") {
    const placement = topology.placements.find((item) => item.placementId === subject.placementId);
    if (!placement) return null;
    const component = topology.components.find((item) => item.instanceId === placement.componentInstanceId);
    const mountOwner = topology.components.find((item) => item.instanceId === placement.mountOwnerInstanceId);
    return component && mountOwner ? { placement, component, mountOwner } : null;
  }
  if (subject.kind === "connection") {
    const connection = topology.connections.find((item) => item.connectionId === subject.connectionId);
    if (!connection) return null;
    const from = topology.components.find((item) => item.instanceId === connection.from.instanceId);
    const to = topology.components.find((item) => item.instanceId === connection.to.instanceId);
    const cable = connection.cableInstanceId ? topology.components.find((item) => item.instanceId === connection.cableInstanceId) : null;
    return from && to && (!connection.cableInstanceId || cable) ? { connection, from, to, cable } : null;
  }
  if (subject.kind === "port") {
    const owner = topology.components.find((item) => item.instanceId === subject.instanceId);
    if (!owner) return null;
    const connections = topology.connections.filter((item) => item.from.instanceId === subject.instanceId && item.from.portId === subject.portId
      || item.to.instanceId === subject.instanceId && item.to.portId === subject.portId);
    if (caseScope?.caseInstanceId === subject.instanceId) {
      const governedOwner = governedCaseOwner(topology, caseScope);
      const anchor = caseScope.manifest.ports.find((item) => item.portId === subject.portId);
      return governedOwner && anchor ? { owner: governedOwner, portId: subject.portId, anchor, connections } : null;
    }
    return connections.length ? { owner, portId: subject.portId, connections } : null;
  }
  if (subject.kind === "mount") {
    const owner = topology.components.find((item) => item.instanceId === subject.ownerInstanceId);
    const placements = topology.placements.filter((item) => item.mountOwnerInstanceId === subject.ownerInstanceId && item.mountId === subject.mountId);
    if (caseScope?.caseInstanceId === subject.ownerInstanceId) {
      const governedOwner = governedCaseOwner(topology, caseScope);
      const anchor = caseScope.manifest.mounts.find((item) => item.mountId === subject.mountId);
      return governedOwner && anchor ? { owner: governedOwner, mountId: subject.mountId, anchor, placements } : null;
    }
    return owner && placements.length ? { owner, mountId: subject.mountId, placements } : null;
  }
  const owner = topology.components.find((item) => item.instanceId === subject.instanceId);
  const firmwareTarget = topology.firmwareTargets.find((item) => item.instanceId === subject.instanceId);
  return owner && firmwareTarget ? { owner, firmwareTarget } : null;
}

/** Binds an observation to the exact current plan entity and all route-dependent inputs. */
export async function resolveObservationProjectionContext(
  planId: string,
  config: BuildConfigDocument,
  subjectRef: ObservationSubjectRef,
  caseScope?: CaseObservationAnchorScope,
): Promise<ObservationProjectionContext> {
  const subject = canonicalSubject(config, subjectRef, caseScope);
  return {
    planId,
    subjectExists: subject !== null,
    currentConfigHash: await hashPlanConfig(config),
    currentSubjectRevisionHash: await sha256Hex(subject ?? { missingSubject: subjectRef }),
  };
}
