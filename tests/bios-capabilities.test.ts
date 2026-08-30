import { describe, expect, it } from "vitest";
import {
  createFirmwareCapability,
  evaluateCpuFirmwareSupport,
  findFirmwareUpgradePath,
  validateFirmwareCapability,
  verifyFirmwareCapability,
} from "../src/capabilities/firmware";

const H = "a".repeat(64);

async function capability() {
  return createFirmwareCapability({
    schemaVersion: "firmware-capability-v1",
    subjectSkuId: "board.alpha",
    subjectRevision: "rev-a",
    region: "CN",
    factSnapshotRef: { snapshotId: `fact-snapshot-sha256-${H}`, contentHash: H },
    versionIdentification: { method: "uefi_screen", sourceFactIds: ["fact-version-method"] },
    releases: [
      { releaseFactId: "fact-bios-100", label: "100", sourceFactIds: ["fact-bios-100"] },
      { releaseFactId: "fact-bios-200", label: "200", sourceFactIds: ["fact-bios-200"] },
      { releaseFactId: "fact-bios-300", label: "300", sourceFactIds: ["fact-bios-300"] },
    ],
    cpuSupport: [{ cpuSkuId: "cpu.new", minimumReleaseFactId: "fact-bios-300", sourceFactIds: ["fact-cpu-table"] }],
    transitions: [
      {
        transitionId: "transition-100-200", fromReleaseFactId: "fact-bios-100", toReleaseFactId: "fact-bios-200",
        purpose: "upgrade",
        method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-usb-fat32"],
        firmwareFileFactId: "fact-file-200", mediaFormat: "fat32", requiredFilename: "BOARD.CAP",
        checksumFactId: "fact-sha-200", powerPrerequisiteFactIds: ["fact-atx-power"], recoveryTransitionIds: [],
        resetsSettings: true, releaseFactIds: ["fact-bios-100", "fact-bios-200"], sourceFactIds: ["fact-procedure-200"],
      },
      {
        transitionId: "transition-200-300", fromReleaseFactId: "fact-bios-200", toReleaseFactId: "fact-bios-300",
        purpose: "upgrade",
        method: "uefi", requiresWorkingCpu: true, requirementIds: ["req-working-cpu", "req-ram"],
        firmwareFileFactId: "fact-file-300", mediaFormat: "fat32", requiredFilename: "BOARD.CAP",
        checksumFactId: "fact-sha-300", powerPrerequisiteFactIds: ["fact-atx-power"], recoveryTransitionIds: ["transition-300-200"],
        resetsSettings: true, releaseFactIds: ["fact-bios-200", "fact-bios-300"], sourceFactIds: ["fact-procedure-300"],
      },
      {
        transitionId: "transition-300-200", fromReleaseFactId: "fact-bios-300", toReleaseFactId: "fact-bios-200",
        purpose: "rollback",
        method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-usb-fat32"],
        firmwareFileFactId: "fact-file-200", mediaFormat: "fat32", requiredFilename: "BOARD.CAP",
        checksumFactId: "fact-sha-200", powerPrerequisiteFactIds: ["fact-atx-power"], recoveryTransitionIds: [],
        resetsSettings: true, releaseFactIds: ["fact-bios-300", "fact-bios-200"], sourceFactIds: ["fact-rollback"]
      },
    ],
    settings: [
      { settingId: "tpm", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-tpm"] },
      { settingId: "secure_boot", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-secure-boot"] },
      { settingId: "csm", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-csm"] },
      { settingId: "above_4g_decoding", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-4g"] },
      { settingId: "resizable_bar", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-rebar"] },
      { settingId: "iommu", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-setting-iommu"] },
      { settingId: "storage_controller_mode", supportedValues: ["ahci", "raid", "hba_it"], sourceFactIds: ["fact-setting-sata"] },
      { settingId: "ecc", supportedValues: ["enabled", "disabled", "auto"], sourceFactIds: ["fact-setting-ecc"] },
    ],
    rollbackSupported: true,
    recoveryMethod: "usb_flashback",
    sourceFactIds: ["fact-board-firmware"],
  });
}

describe("firmware capabilities", () => {
  it("uses an explicit directed release graph, never version-string ordering", async () => {
    const firmware = await capability();
    expect(validateFirmwareCapability(firmware)).toEqual([]);
    const path = await findFirmwareUpgradePath(firmware, "fact-bios-100", "fact-bios-300", new Set(["req-usb-fat32"]));
    expect(path.status).toBe("blocked");
    expect(path.transitionIds).toEqual(["transition-100-200", "transition-200-300"]);
    expect(path.missingRequirementIds).toEqual(["req-ram", "req-working-cpu"]);
    await expect(findFirmwareUpgradePath(firmware, "fact-bios-100", "fact-bios-300", new Set(["req-usb-fat32", "req-working-cpu", "req-ram"]))).resolves.toMatchObject({ status: "pass" });
    await expect(findFirmwareUpgradePath(firmware, "100", "300", new Set())).resolves.toMatchObject({ status: "blocked" });
  });

  it("binds CPU support to a reachable minimum release fact", async () => {
    const firmware = await capability();
    await expect(evaluateCpuFirmwareSupport(firmware, "cpu.new", "fact-bios-100", new Set(["req-usb-fat32", "req-working-cpu", "req-ram"]))).resolves.toMatchObject({ status: "upgrade_required", targetReleaseFactId: "fact-bios-300" });
    await expect(evaluateCpuFirmwareSupport(firmware, "cpu.new", "fact-bios-200", new Set(["req-working-cpu", "req-ram"]))).resolves.toMatchObject({ status: "upgrade_required", targetReleaseFactId: "fact-bios-300" });
    await expect(evaluateCpuFirmwareSupport(firmware, "cpu.new", "fact-bios-300", new Set())).resolves.toMatchObject({ status: "supported" });
    await expect(evaluateCpuFirmwareSupport(firmware, "cpu.unknown", "fact-bios-300", new Set())).resolves.toMatchObject({ status: "blocked", reason: "cpu_support_unknown" });
  });

  it("fails closed on undeclared settings, broken recovery edges, unknown fields and tampering", async () => {
    const firmware = await capability();
    expect(validateFirmwareCapability({ ...firmware, hiddenSemverComparator: true })).toContain("firmware capability contains unknown fields");
    expect(validateFirmwareCapability({ ...firmware, settings: [{ settingId: "vendor_magic", supportedValues: ["on"], sourceFactIds: ["fact"] }] })).toContain("firmware settings.0 firmware settingId/value invalid");
    expect(validateFirmwareCapability({ ...firmware, transitions: firmware.transitions.map((transition) => transition.transitionId === "transition-200-300" ? { ...transition, recoveryTransitionIds: ["missing"] } : transition) })).toContain("firmware transition recovery reference missing");
    await expect(verifyFirmwareCapability({ ...firmware, contentHash: "0".repeat(64) })).resolves.toBe(false);
    await expect(findFirmwareUpgradePath({ ...firmware, contentHash: "0".repeat(64) }, "fact-bios-100", "fact-bios-300", new Set())).rejects.toThrow(/content hash/);
  });
});
