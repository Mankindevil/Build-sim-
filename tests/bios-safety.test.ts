import { describe, expect, it } from "vitest";
import { firmwarePlanFromPath } from "../src/build-execution/bios-plan";
import { firmwarePath } from "./helpers/u7-fixtures";

describe("U7 BIOS safety", () => {
  it("keeps missing observation or recovery requirements blocked", () => {
    const plan = firmwarePlanFromPath(firmwarePath({ verdict: "blocked", reason: "current_release_observation_missing", currentObservation: null, selectedTransitions: [], recovery: { status: "blocked", transitionIds: [], missingRequirementIds: ["req-recovery"], missingPowerPrerequisiteFactIds: [] } }));
    expect(plan.status).toBe("blocked");
    expect(plan.transitions).toEqual([]);
    expect(plan.versionIdentification.observationFieldId).toBe("firmware.bios_version");
  });
});
