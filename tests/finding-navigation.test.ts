import { describe, expect, it } from "vitest";
import { targetForFinding } from "../src/plans/finding-targets";

describe("R4 finding navigation", () => {
  it("maps findings to editor, spatial and task targets without UI guesses", () => {
    expect(targetForFinding("physical.psu-clearance")).toEqual({ section: "power", field: "selection.psuId", spatialPartId: "psu-primary", taskRef: "verification:physical.psu-clearance" });
    expect(targetForFinding("wiring.sata-capacity")).toMatchObject({ section: "storage", field: "selection.diskCount", spatialPartId: "drive-array" });
    expect(targetForFinding("physical.gpu-hba-overlap")).toMatchObject({ section: "expansion", field: "selection.hbaMode", spatialPartId: "hba" });
    expect(targetForFinding("n6.bay9-boot-vs-9hdd")).toMatchObject({ section: "storage", field: "selection.diskCount", spatialPartId: "drive-array" });
  });
});
