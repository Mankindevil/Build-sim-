import { describe, expect, it } from "vitest";
import { generatedProcedure } from "./helpers/u7-fixtures";

describe("U7 Windows first boot", () => {
  it("covers minimal POST, debug state, temperature, UEFI/TPM/Secure Boot, recovery key, media and drivers", () => {
    const procedure = generatedProcedure("system.windows-11").procedure;
    const text = procedure.steps.map(({ action }) => action).join("\n");
    expect(text).toMatch(/minimum CPU, one memory module/);
    expect(text).toMatch(/debug LED\/code/);
    expect(text).toMatch(/temperature/);
    expect(text).toMatch(/UEFI, TPM and Secure Boot/);
    expect(text).toMatch(/BitLocker or device-encryption recovery key/);
    expect(text).toMatch(/storage, network and display driver/);
    expect(procedure.steps.some(({ phase }) => phase === "system_install")).toBe(true);
  });
});
