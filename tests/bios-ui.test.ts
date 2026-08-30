// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderFirmwarePlan } from "../src/lab/build-procedure";
import type { FirmwarePathEvaluation } from "../src/firmware/contracts";

afterEach(() => document.body.replaceChildren());

describe("U11 BIOS path UI", () => {
  it("shows current, minimum, target, transition, missing inputs, reset, and recovery without an automatic update action", () => {
    const host = document.createElement("section"); document.body.append(host);
    const evaluation = {
      instanceId: "motherboard-main",
      verdict: "blocked",
      reason: "requirements_missing",
      currentObservation: { releaseFactId: "bios-1001" },
      minimumReleaseFactId: "bios-1200",
      targetReleaseFactId: "bios-1600",
      selectedTransitions: [{
        transitionId: "bios-path-1", fromReleaseFactId: "bios-1001", toReleaseFactId: "bios-1600",
        method: "usb_flashback", requiredFilename: "BOARD.CAP", mediaFormat: "fat32", resetsSettings: true,
      }],
      missingRequirementIds: ["requirement-usb-fat32"],
      missingPowerPrerequisiteFactIds: ["fact-stable-power"],
      recovery: { status: "available" },
    } as unknown as FirmwarePathEvaluation;

    renderFirmwarePlan(host, [evaluation]);

    expect(host.textContent).toContain("当前 bios-1001 · 最低 bios-1200 · 目标 bios-1600");
    expect(host.textContent).toContain("bios-1001 → bios-1600");
    expect(host.textContent).toContain("BOARD.CAP");
    expect(host.textContent).toContain("升级后需要重新核对设置");
    expect(host.textContent).toContain("待满足：requirement-usb-fat32");
    expect(host.textContent).toContain("待确认供电前提：fact-stable-power");
    expect(host.querySelector("[data-firmware-recovery='available']")).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
});
