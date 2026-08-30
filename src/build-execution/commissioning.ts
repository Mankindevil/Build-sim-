import type { SystemProfileDefinition } from "../system-profiles/contracts";

export interface CommissioningCheck {
  readonly checkId: string;
  readonly action: string;
  readonly expectedResult: string;
  readonly stopConditions: readonly string[];
  readonly safetyCritical: boolean;
}

export function commissioningChecks(profile: SystemProfileDefinition): CommissioningCheck[] {
  const common: CommissioningCheck[] = [
    { checkId: "post", action: "Confirm POST and record debug LED/code state.", expectedResult: "Stable POST with expected CPU and memory detected.", stopConditions: ["no POST", "repeating debug code"], safetyCritical: true },
    { checkId: "temperature", action: "Inspect firmware temperature readings before sustained operation.", expectedResult: "Temperatures remain within the governed stop threshold.", stopConditions: ["rapid temperature rise", "cooler or pump not detected"], safetyCritical: true },
    { checkId: "inventory", action: "Verify firmware/OS inventory against the current topology.", expectedResult: "Every expected instance is present exactly once.", stopConditions: ["unexpected or missing device"], safetyCritical: false },
  ];
  if (profile.profileId === "system.windows-11") return [
    ...common,
    { checkId: "windows-security", action: "Verify UEFI, TPM and Secure Boot state before installation.", expectedResult: "Selected Windows requirements are satisfied.", stopConditions: ["boot mode or security state differs from profile"], safetyCritical: false },
    { checkId: "bitlocker-recovery", action: "Before firmware/security changes, confirm the BitLocker or device-encryption recovery key is available.", expectedResult: "Recovery material is available or encryption is confirmed inactive.", stopConditions: ["encrypted device with no recovery key"], safetyCritical: true },
    { checkId: "windows-drivers", action: "Verify storage, network and display driver paths from governed sources.", expectedResult: "Installation and recovery driver paths are available.", stopConditions: ["boot/storage/network/display driver unavailable"], safetyCritical: false },
  ];
  if (profile.profileId === "system.truenas-scale") return [
    ...common,
    { checkId: "truenas-hba", action: "Verify HBA IT/AHCI path and controller-to-port mapping.", expectedResult: "Each disk has one direct governed path.", stopConditions: ["hardware RAID path", "ambiguous controller port"], safetyCritical: true },
    { checkId: "truenas-install-target", action: "Match the isolated boot-pool device to its current physical locator before install.", expectedResult: "Only intended boot devices are selected.", stopConditions: ["target is ambiguous", "target belongs to an active data vdev"], safetyCritical: true },
    { checkId: "truenas-data-protection", action: "Exclude every data/spare disk from installer wipe targets.", expectedResult: "No active data or spare disk is selected for installation.", stopConditions: ["data-disk locator mismatch"], safetyCritical: true },
  ];
  return common;
}
