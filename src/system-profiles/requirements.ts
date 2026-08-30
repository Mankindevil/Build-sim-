import type { RequirementNode } from "../requirements/contracts";
import type { SystemCheckId, SystemProfileDefinition } from "./contracts";

const KIND: Readonly<Record<SystemCheckId, RequirementNode["kind"]>> = Object.freeze({
  firmware_path: "firmware_action",
  uefi: "system_action",
  tpm: "system_action",
  secure_boot: "system_action",
  boot_device: "component",
  display_path: "component",
  network_driver: "evidence",
  storage_driver: "evidence",
  hba_it_mode: "firmware_action",
  ecc: "system_action",
  ipmi: "system_action",
  boot_data_separation: "user_decision",
  disk_unique_locator: "measurement",
});

export function systemCheckRequirement(profile: SystemProfileDefinition, checkId: SystemCheckId): RequirementNode {
  return {
    requirementId: `requirement.system.${profile.profileId}.${checkId}`,
    kind: KIND[checkId],
    predicates: [],
    quantity: 1,
    criticality: checkId === "disk_unique_locator" ? "safety" : "boot",
    requiredBefore: checkId === "disk_unique_locator" ? "os_install" : "first_boot",
    producedBy: { ruleId: `system-profile.${profile.profileId}.${checkId}`, ruleVersion: "1", instanceIds: [] },
    evidenceRefs: [...profile.officialSourceRefs].sort(),
  };
}
