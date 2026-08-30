import { describe, expect, it } from "vitest";
import { generatedProcedure } from "./helpers/u7-fixtures";

describe("U7 TrueNAS first boot", () => {
  it("covers boot isolation, disk identity, HBA path, install target and data-disk protection", () => {
    const procedure = generatedProcedure("system.truenas-scale").procedure;
    const text = procedure.steps.map(({ action }) => action).join("\n");
    expect(text).toMatch(/HBA IT\/AHCI path/);
    expect(text).toMatch(/isolated boot-pool device/);
    expect(text).toMatch(/Exclude every data\/spare disk/);
    expect(procedure.steps.filter(({ action }) => /boot-pool|data\/spare/.test(action)).every(({ riskLevel, safetyCritical }) => riskLevel === "destructive" && safetyCritical)).toBe(true);
  });
});
