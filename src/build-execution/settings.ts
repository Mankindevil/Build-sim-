import type { FirmwarePlan } from "./contracts";

export interface FirmwareSettingProcedureItem {
  readonly itemId: string;
  readonly instanceId: string;
  readonly settingId: FirmwarePlan["requiredSettings"][number]["key"];
  readonly desiredValue: string;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export function firmwareSettingProcedureItems(plans: readonly FirmwarePlan[]): FirmwareSettingProcedureItem[] {
  return plans.flatMap((plan) => plan.requiredSettings.map((setting) => ({
    itemId: `firmware-setting.${plan.instanceId}.${setting.key}`,
    instanceId: plan.instanceId,
    settingId: setting.key,
    desiredValue: setting.value,
    reason: setting.reason,
    evidenceRefs: [...setting.evidenceRefs],
  }))).sort((left, right) => left.itemId.localeCompare(right.itemId));
}
