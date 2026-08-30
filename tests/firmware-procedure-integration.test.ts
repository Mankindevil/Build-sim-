import { describe, expect, it } from "vitest";
import { validateBuildProcedure } from "../src/build-execution/contracts";
import { generatedProcedure } from "./helpers/u7-fixtures";

describe("U7 firmware procedure integration", () => {
  it("binds exact firmware media and every safety step to the procedure safety hash", () => {
    const generated = generatedProcedure("system.windows-11");
    const firmware = generated.procedure.steps.find(({ stepId }) => stepId === "firmware-flash-a");
    expect(firmware?.action).toContain("BOARD.CAP");
    expect(firmware?.action).toContain("fact.checksum");
    expect(generated.procedure.steps.filter(({ safetyCritical }) => safetyCritical).every(({ dependencyHashes }) => dependencyHashes.procedureSafetyHash === generated.procedure.procedureSafetyHash)).toBe(true);
    expect(validateBuildProcedure(generated.procedure, generated.dependencyContext)).toEqual([]);
  });
});
