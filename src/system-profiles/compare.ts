import type { MachineIntent } from "../requirements/contracts";
import type { SystemComparisonEntry } from "./contracts";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY, type SystemProfileRegistry } from "./registry";

export function compareSystemProfiles(
  intent: MachineIntent,
  registry: SystemProfileRegistry = DEFAULT_SYSTEM_PROFILE_REGISTRY,
): SystemComparisonEntry[] {
  return registry.list().map((profile) => ({
    profileId: profile.profileId,
    label: profile.label,
    family: profile.family,
    recommendedForIntent: profile.machineIntents.includes(intent),
    helpRef: profile.helpRef,
    facts: [
      { key: "release", value: profile.releaseFactId, sourceRefs: [...profile.officialSourceRefs] },
      { key: "requiredChecks", value: profile.requiredChecks.join(", "), sourceRefs: [...profile.officialSourceRefs] },
    ],
  })).sort((left, right) => Number(right.recommendedForIntent) - Number(left.recommendedForIntent)
    || left.profileId.localeCompare(right.profileId));
}
