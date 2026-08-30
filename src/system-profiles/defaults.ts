import type { MachineIntent } from "../requirements/contracts";
import type { BuildConfigV3, SystemSelection } from "../topology/contracts";
import type { SystemProfileDefinition, SystemSelectionRecommendation } from "./contracts";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY, type SystemProfileRegistry } from "./registry";

const DEFAULT_PROFILE: Readonly<Record<MachineIntent, SystemProfileDefinition["profileId"]>> = Object.freeze({
  pc: "system.windows-11",
  workstation: "system.windows-11",
  nas: "system.truenas-scale",
});

export function recommendSystemForIntent(
  intent: MachineIntent,
  registry: SystemProfileRegistry = DEFAULT_SYSTEM_PROFILE_REGISTRY,
): SystemSelectionRecommendation {
  const profile = registry.resolve(DEFAULT_PROFILE[intent]);
  return {
    selection: { profileId: profile.profileId, versionFactId: profile.releaseFactId, source: "defaulted", lockedByUser: false },
    reason: intent === "nas"
      ? "NAS intent defaults to a storage-focused profile with explicit disk-path and destructive-action gates."
      : "PC/workstation intent defaults to Windows while preserving an explicit alternative and user override.",
    alternativeProfileIds: [...profile.alternativeProfileIds],
    helpRef: profile.helpRef,
  };
}

export function userSystemSelection(profile: SystemProfileDefinition): SystemSelection {
  return { profileId: profile.profileId, versionFactId: profile.releaseFactId, source: "user", lockedByUser: true };
}

/** Defaults only an unanswered selection. A user choice is never overwritten. */
export function withRecommendedSystem(
  config: BuildConfigV3,
  registry: SystemProfileRegistry = DEFAULT_SYSTEM_PROFILE_REGISTRY,
): { config: BuildConfigV3; recommendation: SystemSelectionRecommendation | null } {
  if (config.system !== null) return { config: structuredClone(config), recommendation: null };
  if (config.intent?.state !== "answered") return { config: structuredClone(config), recommendation: null };
  const recommendation = recommendSystemForIntent(config.intent.value, registry);
  return { config: { ...structuredClone(config), system: recommendation.selection }, recommendation };
}
