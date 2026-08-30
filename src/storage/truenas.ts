import { canonicalJson } from "../plans/canonical";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import type { EvaluationDecision, RequirementNode } from "../requirements/contracts";
import type { LogicalLayoutSelection } from "../topology/contracts";
import { calculateVdevCapacity } from "./capacity";
import type { DestructiveActionPlan, StorageLayoutEvaluation } from "./contracts";
import { validateLogicalLayoutSelection, validateStorageLayoutEvaluation } from "./contracts";
import { deriveExpansionOptions } from "./expansion";
import { STORAGE_HELP } from "./explain";

export interface StorageDiskAuthority {
  readonly instanceId: string;
  readonly capacityBytes: number;
  readonly media: "CMR" | "SMR" | "SSD";
  readonly faultDomain: string;
  readonly revisionHash: string;
  readonly factIds: readonly string[];
  readonly locatorObservationId: string | null;
  readonly path: {
    readonly controllerInstanceId: string;
    readonly controllerPortId: string;
    readonly backplaneInstanceId?: string | null;
    readonly connectionIds?: readonly string[];
    readonly cableInstanceIds?: readonly string[];
    readonly transport: "sata" | "sas" | "nvme" | "usb";
    readonly controllerMode: "it" | "ahci" | "raid" | "unknown";
    readonly factIds: readonly string[];
  };
}

export interface TrueNasLayoutEvaluationInput {
  readonly selection: LogicalLayoutSelection;
  readonly disks: readonly StorageDiskAuthority[];
  readonly systemProfileId: "system.truenas-scale";
}

function requirement(check: string, instanceIds: readonly string[]): RequirementNode {
  return {
    requirementId: `requirement.storage.${check}`,
    kind: check.includes("locator") ? "measurement" : "system_action",
    predicates: [], quantity: 1, criticality: "safety", requiredBefore: "os_install",
    producedBy: { ruleId: `storage.truenas.${check}`, ruleVersion: "1", instanceIds: [...instanceIds].sort() },
    evidenceRefs: [],
  };
}

function decision(id: string, verdict: EvaluationDecision["verdict"], message: string, instanceIds: readonly string[], factIds: readonly string[], remediation: readonly RequirementNode[] = []): EvaluationDecision {
  return { decisionId: `decision.storage.${id}`, verdict, domain: "storage", message, instanceIds: [...instanceIds].sort(), factIds: [...factIds].sort(), ruleId: `storage.truenas.${id}`, ruleVersion: "1", assumptions: [], remediation: [...remediation] };
}

export function evaluateTrueNasLayout(input: TrueNasLayoutEvaluationInput): StorageLayoutEvaluation {
  const selectionErrors = validateLogicalLayoutSelection(input.selection);
  if (selectionErrors.length) throw new TypeError(`invalid logical layout selection: ${selectionErrors.join("; ")}`);
  const diskById = new Map(input.disks.map((disk) => [disk.instanceId, disk]));
  if (diskById.size !== input.disks.length) throw new TypeError("storage disk authority IDs must be unique");
  const selectedIds = [
    ...input.selection.bootPoolDiskIds,
    ...input.selection.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
    ...input.selection.spareDiskIds,
  ];
  for (const id of selectedIds) if (!diskById.has(id)) throw new TypeError(`selected disk lacks authority: ${id}`);
  const decisions: EvaluationDecision[] = [];
  const hbaAndPathDecisionIds: string[] = [];
  const usedPorts = new Set<string>();
  for (const diskId of selectedIds) {
    const disk = diskById.get(diskId)!;
    const portKey = `${disk.path.controllerInstanceId}:${disk.path.controllerPortId}`;
    const duplicate = usedPorts.has(portKey); usedPorts.add(portKey);
    const safeMode = disk.path.controllerMode === "it" || disk.path.controllerMode === "ahci";
    const req = requirement(`path.${diskId}`, [diskId, disk.path.controllerInstanceId]);
    const pathDecision = decision(`path.${diskId}`, duplicate || !safeMode ? "fail" : "pass",
      duplicate ? "The controller port is assigned to more than one active disk."
        : safeMode ? "The disk has one direct IT/AHCI controller path." : "TrueNAS data disks cannot use an opaque hardware RAID path.",
      [diskId, disk.path.controllerInstanceId], [...disk.factIds, ...disk.path.factIds], duplicate || !safeMode ? [req] : []);
    decisions.push(pathDecision); hbaAndPathDecisionIds.push(pathDecision.decisionId);
  }
  const vdevResults: StorageLayoutEvaluation["vdevResults"] = input.selection.vdevs.map((vdev) => {
    const disks = vdev.diskInstanceIds.map((id) => diskById.get(id)!);
    const capacity = calculateVdevCapacity(vdev.topology, disks);
    const mixedMedia = new Set(disks.map(({ media }) => media)).size > 1;
    const sharedFaultDomain = new Set(disks.map(({ faultDomain }) => faultDomain)).size < disks.length;
    const risks = [
      "Resilver/rebuild temporarily increases failure exposure and reads every surviving member.",
      ...(mixedMedia ? ["Mixed media characteristics can widen rebuild time and latency."] : []),
      ...(sharedFaultDomain ? ["Members share a failure domain; nominal disk tolerance is not chassis/controller tolerance."] : []),
    ];
    decisions.push(decision(`capacity.${vdev.vdevId}`, "pass", `${vdev.topology} usable capacity is derived from the smallest member; RAID/RAIDZ is not backup.`, vdev.diskInstanceIds, disks.flatMap(({ factIds }) => factIds)));
    if (disks.some(({ media }) => media === "SMR")) {
      const req = requirement(`cmr.${vdev.vdevId}`, vdev.diskInstanceIds);
      decisions.push(decision(`media.${vdev.vdevId}`, "fail", "An SMR member is not accepted for this TrueNAS data vdev.", vdev.diskInstanceIds, disks.flatMap(({ factIds }) => factIds), [req]));
    }
    return {
      vdevId: vdev.vdevId,
      estimatedUsableBytes: { min: capacity.usableBytes, max: capacity.usableBytes },
      faultTolerance: { diskFailures: capacity.faultToleranceDiskFailures, conditions: ["failures remain within this vdev", "surviving members and controller path remain readable"] },
      diskInstanceIds: [...vdev.diskInstanceIds],
      mixedCapacityLossBytes: capacity.mixedCapacityLossBytes,
      controllerPaths: disks.map((disk) => ({ diskInstanceId: disk.instanceId, controllerInstanceId: disk.path.controllerInstanceId, controllerPortId: disk.path.controllerPortId, transport: disk.path.transport })),
      resilverRisks: risks,
    };
  });
  if (input.selection.bootPoolDiskIds.some((id) => input.selection.vdevs.some(({ diskInstanceIds }) => diskInstanceIds.includes(id)))) {
    throw new TypeError("boot and data pools must be disjoint");
  }
  const total = vdevResults.reduce((sum, result) => sum + result.estimatedUsableBytes.min, 0);
  const selectionHash = sha256Utf8Runtime(`buildsim:logical-layout:${canonicalJson(input.selection)}`);
  if (selectionHash === null) throw new TypeError("logical layout cannot be hashed");
  const evaluation: StorageLayoutEvaluation = {
    layoutSelectionHash: selectionHash,
    systemProfileId: input.systemProfileId,
    usableBytes: { min: total, max: total },
    vdevResults,
    hbaAndPathDecisionIds: hbaAndPathDecisionIds.sort(),
    expansionOptions: deriveExpansionOptions(input.selection),
    decisions: decisions.sort((left, right) => left.decisionId.localeCompare(right.decisionId)),
    assumptions: ["RAID/RAIDZ is not backup."],
    spareDiskIds: [...input.selection.spareDiskIds].sort(),
    helpRefs: Object.values(STORAGE_HELP).map(({ helpRef }) => helpRef).sort(),
  };
  const errors = validateStorageLayoutEvaluation(evaluation);
  if (errors.length) throw new TypeError(`derived storage layout invalid: ${errors.join("; ")}`);
  return evaluation;
}

export interface DestructiveActionPlanInput {
  readonly actionId: string;
  readonly diskInstanceIds: readonly string[];
  readonly disks: readonly StorageDiskAuthority[];
  readonly planId: string;
  readonly planVersionId: string;
  readonly configHash: string;
  readonly planRevisionHash: string;
  readonly procedureSafetyHash: string;
}

/** No locator means no executable destructive plan; callers render the blocked disks instead. */
export function createDestructiveActionPlan(input: DestructiveActionPlanInput): DestructiveActionPlan | null {
  const byId = new Map(input.disks.map((disk) => [disk.instanceId, disk]));
  const locators = input.diskInstanceIds.map((id) => byId.get(id)?.locatorObservationId ?? null);
  if (locators.some((id) => id === null) || new Set(locators).size !== locators.length) return null;
  return {
    actionId: input.actionId,
    diskInstanceIds: [...input.diskInstanceIds],
    locatorObservationIds: locators as string[],
    inputPlanId: input.planId,
    inputPlanVersionId: input.planVersionId,
    inputConfigHash: input.configHash,
    inputPlanRevisionHash: input.planRevisionHash,
    inputProcedureSafetyHash: input.procedureSafetyHash,
    confirmation: "required",
  };
}
