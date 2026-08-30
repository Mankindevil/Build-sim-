import type { FactRecord } from "../facts/contracts";
import type { FirmwarePathEvaluation } from "../firmware/contracts";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import { canonicalJson } from "../plans/canonical";
import type { ProgressiveBuildEvaluation } from "../compatibility/contracts";
import type { GovernedEvaluationInput } from "../server/evaluation-service";
import type { ComponentInstance } from "../topology/contracts";
import type {
  SystemCheckAuthority,
  SystemCheckId,
  SystemProfileDefinition,
  SystemProfileEvaluation,
} from "./contracts";

type CheckId = Exclude<SystemCheckId, "firmware_path">;

function componentFact(input: GovernedEvaluationInput, component: ComponentInstance, fact: FactRecord): boolean {
  if (fact.status !== "active" || fact.authority !== "official") return false;
  if (fact.subject.kind === "product") {
    return component.identity.status === "resolved" && fact.subject.skuId === component.identity.skuId;
  }
  if (fact.subject.planId !== input.planId) return false;
  return "instanceId" in fact.subject.subjectRef && fact.subject.subjectRef.instanceId === component.instanceId;
}

function authority(checkId: CheckId, status: SystemCheckAuthority["status"], message: string, instanceIds: readonly string[] = [], factIds: readonly string[] = []): SystemCheckAuthority {
  return {
    checkId,
    status,
    message,
    instanceIds: [...new Set(instanceIds)].sort(),
    factIds: [...new Set(factIds)].sort(),
  };
}

function firmwareFactIds(input: GovernedEvaluationInput, evaluations: readonly FirmwarePathEvaluation[]): string[] {
  const available = new Set(input.factClosure.facts.map(({ factId }) => factId));
  return [...new Set(evaluations.flatMap((evaluation) => [
    ...evaluation.selectedTransitions.flatMap(({ sourceFactIds }) => sourceFactIds),
  ]).filter((factId) => available.has(factId)))].sort();
}

function firmwareSetting(
  input: GovernedEvaluationInput,
  evaluations: readonly FirmwarePathEvaluation[],
  checkId: "uefi" | "tpm" | "secure_boot" | "ecc",
  settingId: "csm" | "tpm" | "secure_boot" | "ecc",
  desiredValues: readonly string[],
): SystemCheckAuthority {
  const instanceIds = evaluations.map(({ instanceId }) => instanceId);
  const facts = firmwareFactIds(input, evaluations);
  if (evaluations.length === 0 || evaluations.some(({ verdict }) => verdict !== "pass")) {
    return authority(checkId, "unknown", `${checkId} support is not proven until every selected firmware path is executable.`, instanceIds, facts);
  }
  const supported = evaluations.every(({ searchAuthority }) => searchAuthority.requestedSettings.some((setting) => (
    setting.settingId === settingId && desiredValues.includes(setting.desiredValue)
  )));
  return supported
    ? authority(checkId, "pass", `${checkId} has an exact governed firmware setting path.`, instanceIds, facts)
    : authority(checkId, "unknown", `${checkId} lacks an exact governed setting path.`, instanceIds, facts);
}

function driverSupport(input: GovernedEvaluationInput, checkId: "network_driver" | "storage_driver", kinds: readonly ComponentInstance["kind"][]): SystemCheckAuthority {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0" || config.system === null) return authority(checkId, "unknown", "A selected system release is required before driver support can be evaluated.");
  const components = config.components.filter(({ kind }) => kinds.includes(kind));
  if (components.length === 0) return authority(checkId, "unknown", `No ${checkId.replace("_", " ")} device identity is present.`);
  const factsByInstance = components.map((component) => ({
    component,
    facts: input.factClosure.facts.filter((fact) => fact.field === "driver.supported_operating_systems" && componentFact(input, component, fact)),
  }));
  const supports = (fact: FactRecord) => Array.isArray(fact.value)
    && (fact.value.includes(config.system!.profileId) || fact.value.includes(config.system!.versionFactId));
  const unsupported = factsByInstance.some(({ facts }) => facts.length > 0 && !facts.some(supports));
  const complete = factsByInstance.every(({ facts }) => facts.some(supports));
  const factIds = factsByInstance.flatMap(({ facts }) => facts.map(({ factId }) => factId));
  return complete ? authority(checkId, "pass", "Every present device in this path has exact-release driver support.", components.map(({ instanceId }) => instanceId), factIds)
    : unsupported ? authority(checkId, "fail", "At least one present device has governed driver data that excludes the selected system release.", components.map(({ instanceId }) => instanceId), factIds)
      : authority(checkId, "unknown", "Driver support is incomplete for one or more present devices.", components.map(({ instanceId }) => instanceId), factIds);
}

/**
 * Server-only projection from the exact locked config/fact/observation closure.
 * It emits raw checks; evaluateSystemProfile remains the sole verdict builder.
 */
export async function resolveProductionSystemCheckAuthorities(
  input: GovernedEvaluationInput,
  firmwareEvaluations: readonly FirmwarePathEvaluation[],
): Promise<readonly SystemCheckAuthority[]> {
  const config = input.config;
  if (config.schemaVersion !== "3.0.0" || config.system === null) return [];
  const checks: SystemCheckAuthority[] = [];
  checks.push(firmwareSetting(input, firmwareEvaluations, "uefi", "csm", ["disabled"]));
  checks.push(firmwareSetting(input, firmwareEvaluations, "tpm", "tpm", ["enabled"]));
  checks.push(firmwareSetting(input, firmwareEvaluations, "secure_boot", "secure_boot", ["enabled"]));
  checks.push(firmwareSetting(input, firmwareEvaluations, "ecc", "ecc", ["enabled", "auto"]));

  const displayInstances = firmwareEvaluations.map(({ instanceId }) => instanceId);
  const displayFacts = firmwareFactIds(input, firmwareEvaluations);
  const displayStates = firmwareEvaluations.map(({ searchAuthority }) => searchAuthority.preflight.displayPathAvailable);
  checks.push(displayStates.length > 0 && displayStates.every((value) => value === true)
    ? authority("display_path", "pass", "A verified display path is available for every firmware target.", displayInstances, displayFacts)
    : displayStates.some((value) => value === false)
      ? authority("display_path", "fail", "A required firmware target has no verified display path.", displayInstances, displayFacts)
      : authority("display_path", "unknown", "The display path has not been verified.", displayInstances, displayFacts));

  const storage = config.components.filter(({ kind }) => kind === "storage_drive");
  const bootFacts = storage.flatMap((component) => input.factClosure.facts.filter((fact) => fact.field === "storage.boot_support" && componentFact(input, component, fact)));
  checks.push(bootFacts.some(({ value }) => value === true)
    ? authority("boot_device", "pass", "At least one present storage device has governed boot support.", storage.map(({ instanceId }) => instanceId), bootFacts.map(({ factId }) => factId))
    : bootFacts.length > 0
      ? authority("boot_device", "fail", "Present storage facts do not provide a boot-capable device.", storage.map(({ instanceId }) => instanceId), bootFacts.map(({ factId }) => factId))
      : authority("boot_device", "unknown", "Boot-device support facts are missing.", storage.map(({ instanceId }) => instanceId)));

  checks.push(driverSupport(input, "network_driver", ["motherboard", "nic"]));
  checks.push(driverSupport(input, "storage_driver", ["motherboard", "storage_drive", "hba", "raid_controller"]));

  const hbas = config.components.filter(({ kind }) => kind === "hba");
  const hbaFacts = hbas.flatMap((component) => input.factClosure.facts.filter((fact) => fact.field === "hba.mode" && componentFact(input, component, fact)));
  checks.push(hbas.length === 0
    ? authority("hba_it_mode", "not_applicable", "No HBA is present; direct AHCI paths remain subject to storage-path checks.")
    : hbaFacts.length !== hbas.length
      ? authority("hba_it_mode", "unknown", "HBA mode is not governed for every present HBA.", hbas.map(({ instanceId }) => instanceId), hbaFacts.map(({ factId }) => factId))
      : hbaFacts.every(({ value }) => value === "it")
        ? authority("hba_it_mode", "pass", "Every present HBA is governed in IT mode.", hbas.map(({ instanceId }) => instanceId), hbaFacts.map(({ factId }) => factId))
        : authority("hba_it_mode", "fail", "At least one present HBA is not in IT mode.", hbas.map(({ instanceId }) => instanceId), hbaFacts.map(({ factId }) => factId)));

  const layouts = config.logicalLayouts;
  const selectedDiskIds = layouts.flatMap((layout) => [
    ...layout.bootPoolDiskIds,
    ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
    ...layout.spareDiskIds,
  ]);
  const bootIds = new Set(layouts.flatMap(({ bootPoolDiskIds }) => bootPoolDiskIds));
  const dataIds = new Set(layouts.flatMap(({ vdevs }) => vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds)));
  const uniqueRoles = new Set(selectedDiskIds).size === selectedDiskIds.length && [...bootIds].every((id) => !dataIds.has(id));
  checks.push(layouts.length === 0 ? authority("boot_data_separation", "unknown", "Boot, data and spare roles have not been selected.")
    : uniqueRoles ? authority("boot_data_separation", "pass", "Boot, data and spare disk ownership is disjoint.", [...new Set(selectedDiskIds)])
      : authority("boot_data_separation", "fail", "A disk is reused across active boot, data or spare roles.", [...new Set(selectedDiskIds)]));

  const locatorObservations = input.observationClosure.observations.filter(({ observation }) => observation.status === "active"
    && observation.fieldId === "storage.disk_locator" && observation.subjectRef.kind === "instance"
    && selectedDiskIds.includes(observation.subjectRef.instanceId));
  const located = new Set(locatorObservations.map(({ observation }) => observation.subjectRef.kind === "instance" ? observation.subjectRef.instanceId : ""));
  checks.push(selectedDiskIds.length === 0 ? authority("disk_unique_locator", "unknown", "No selected disk set exists for physical locator verification.")
    : [...new Set(selectedDiskIds)].every((id) => located.has(id))
      ? authority("disk_unique_locator", "pass", "Every selected disk has one current physical locator observation.", [...new Set(selectedDiskIds)])
      : authority("disk_unique_locator", "unknown", "One or more selected disks lacks a current unique locator observation.", [...new Set(selectedDiskIds)]));

  checks.push(authority("ipmi", "unknown", "IPMI availability has no current governed support record."));
  return checks.sort((left, right) => left.checkId.localeCompare(right.checkId));
}

/**
 * Reconstructs the exact U7 system-profile projection from the governed rule
 * output carried by a progressive receipt.  The progressive engine rewrites
 * producer rule IDs so the requirement graph has one registered rule; this
 * projection restores the profile-specific IDs and hashes the resulting
 * immutable procedure input.  It never invents checks that the receipt did
 * not evaluate.
 */
export function systemProfileEvaluationFromProgressive(
  evaluation: ProgressiveBuildEvaluation,
  profile: SystemProfileDefinition,
  selectionSource: SystemProfileEvaluation["selectionSource"],
): SystemProfileEvaluation | null {
  const decisionById = new Map(evaluation.decisions.map((decision) => [decision.decisionId, decision]));
  const requirementById = new Map(evaluation.requirements.map((requirement) => [requirement.requirementId, requirement]));
  const decisions = [] as SystemProfileEvaluation["decisions"][number][];
  const requirements = [] as SystemProfileEvaluation["requirements"][number][];
  for (const checkId of profile.requiredChecks) {
    const decisionId = `decision.system.${profile.profileId}.${checkId}`;
    const adapted = decisionById.get(decisionId);
    if (!adapted || adapted.domain !== "system" || adapted.ruleId !== "compat.system-profile-selection") return null;
    const producer = { ruleId: `system-profile.${profile.profileId}.${checkId}`, ruleVersion: "1" };
    const restoredRemediation = adapted.remediation.map((item) => {
      const canonical = requirementById.get(item.requirementId);
      if (!canonical || canonical.producedBy.ruleId !== "compat.system-profile-selection") {
        throw new TypeError(`system decision ${decisionId} remediation lacks progressive requirement closure`);
      }
      return {
        ...structuredClone(canonical),
        producedBy: { ...producer, instanceIds: [...canonical.producedBy.instanceIds] },
      };
    });
    for (const requirement of restoredRemediation) {
      if (!requirements.some(({ requirementId }) => requirementId === requirement.requirementId)) requirements.push(requirement);
    }
    decisions.push({
      ...structuredClone(adapted),
      ...producer,
      remediation: restoredRemediation,
    });
  }
  decisions.sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  requirements.sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  const verdict: SystemProfileEvaluation["verdict"] = decisions.some((decision) => decision.verdict === "fail") ? "fail"
    : decisions.some((decision) => decision.verdict === "blocked") ? "blocked" : "pass";
  const base = {
    schemaVersion: "system-profile-evaluation-v1" as const,
    profileId: profile.profileId,
    releaseFactId: profile.releaseFactId,
    selectionSource,
    verdict,
    decisions,
    requirements,
    helpRefs: [profile.helpRef],
  };
  const contentHash = sha256Utf8Runtime(`buildsim:system-profile-evaluation:${canonicalJson(base)}`);
  if (contentHash === null) throw new TypeError("system profile procedure projection cannot be hashed");
  return { ...base, contentHash };
}
