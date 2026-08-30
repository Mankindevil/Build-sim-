import { describe, expect, it } from "vitest";
import { firmwarePlanFromPath } from "../src/build-execution/bios-plan";
import { validateFirmwarePlan } from "../src/build-execution/contracts";
import { firmwarePath } from "./helpers/u7-fixtures";

describe("U7 BIOS plan", () => {
  it("projects the exact U6 transition file, checksum, recovery and settings without re-solving", () => {
    const plan = firmwarePlanFromPath(firmwarePath());
    expect(plan.transitions[0]).toMatchObject({ method: "usb_flashback", media: { fileName: "BOARD.CAP", checksumFactId: "fact.checksum" }, recoveryTransitionIds: [] });
    expect(plan.requiredSettings).toEqual([expect.objectContaining({ key: "secure_boot", value: "enabled" })]);
    expect(validateFirmwarePlan(plan)).toEqual([]);
  });
});
