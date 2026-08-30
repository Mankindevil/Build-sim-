import { describe, expect, it } from "vitest";
import { createStorageCapability, validateStorageCapability, verifyStorageCapability } from "../src/capabilities/storage";
import { validateStorageCapabilityAgainstStandards } from "../src/capabilities/storage";
import { HardwareStandardRegistry, loadBundledHardwareStandardLibrary } from "../src/standards";

const H = "b".repeat(64);
const factSnapshotRef = { snapshotId: `fact-snapshot-sha256-${H}`, contentHash: H };

describe("storage capability facets", () => {
  it("models drive sector, recording, TRIM and endurance facts", async () => {
    const drive = await createStorageCapability({
      schemaVersion: "storage-drive-capability-v1",
      subjectSkuId: "drive.alpha",
      factSnapshotRef,
      interfaceStandardId: "sata.3.0-device",
      logicalSectorBytes: 512,
      physicalSectorBytes: 4096,
      recordingTechnology: "cmr",
      trimSupported: false,
      enduranceTbw: null,
      failureDomainIds: ["failure-domain.drive.alpha"],
      sourceFactIds: ["fact-drive-spec"],
    });
    expect(validateStorageCapability(drive)).toEqual([]);
    expect(validateStorageCapability({ ...drive, logicalSectorBytes: 1000 })).toContain("storage drive logicalSectorBytes invalid");
    expect(validateStorageCapability({ ...drive, recordingTechnology: "vendor-secret" })).toContain("storage drive recordingTechnology invalid");
  });

  it("models controller mode/passthrough and backplane hot-swap/failure domains", async () => {
    const controller = await createStorageCapability({
      schemaVersion: "storage-controller-capability-v1",
      subjectSkuId: "hba.alpha",
      factSnapshotRef,
      supportedInterfaceStandardIds: ["sata.3.0-device", "slimsas.sff-8654-4i"],
      modes: ["hba_it"],
      passthroughSupported: true,
      maximumDeviceCount: 8,
      failureDomainIds: ["failure-domain.controller.alpha"],
      sourceFactIds: ["fact-hba-mode"],
    });
    const backplane = await createStorageCapability({
      schemaVersion: "storage-backplane-capability-v1",
      subjectSkuId: "backplane.alpha",
      factSnapshotRef,
      upstreamStandardIds: ["slimsas.sff-8654-4i"],
      downstreamStandardIds: ["sata.3.0-device"],
      bayCount: 8,
      hotSwapSupported: true,
      failureDomainIds: ["failure-domain.backplane.alpha", "failure-domain.power.shared"],
      sourceFactIds: ["fact-backplane"],
    });
    expect(validateStorageCapability(controller)).toEqual([]);
    expect(validateStorageCapability(backplane)).toEqual([]);
    const standards = await HardwareStandardRegistry.create(await loadBundledHardwareStandardLibrary());
    await expect(validateStorageCapabilityAgainstStandards(controller, standards)).resolves.toEqual([]);
    const { contentHash: _controllerHash, ...controllerInput } = controller;
    const unknownStandard = await createStorageCapability({ ...controllerInput, supportedInterfaceStandardIds: ["vendor.unknown"] });
    await expect(validateStorageCapabilityAgainstStandards(unknownStandard, standards)).resolves.toContain("storage capability standard is unknown: vendor.unknown");
    expect(validateStorageCapability({ ...controller, modes: ["raid"], passthroughSupported: true })).toContain("storage controller passthrough requires hba_it mode");
    expect(validateStorageCapability({ ...backplane, failureDomainIds: [] })).toContain("storage backplane failureDomainIds invalid");
  });

  it("is strict, snapshot-bound and tamper evident", async () => {
    const capability = await createStorageCapability({
      schemaVersion: "storage-controller-capability-v1", subjectSkuId: "controller.café", factSnapshotRef,
      supportedInterfaceStandardIds: ["pcie.cem-gen4-x8"], modes: ["raid"], passthroughSupported: false,
      maximumDeviceCount: 16, failureDomainIds: ["failure-domain.controller"], sourceFactIds: ["fact-controller"],
    });
    expect(validateStorageCapability({ ...capability, subjectSkuId: "controller.cafe\u0301" })).toContain("storage capability contains non-NFC text");
    expect(validateStorageCapability({ ...capability, trusted: true })).toContain("storage controller capability contains unknown fields");
    expect(validateStorageCapability({ ...capability, factSnapshotRef: { ...factSnapshotRef, contentHash: "x" } })).toContain("storage capability factSnapshotRef identity/hash invalid");
    await expect(verifyStorageCapability({ ...capability, contentHash: "0".repeat(64) })).resolves.toBe(false);
    const standards = await HardwareStandardRegistry.create(await loadBundledHardwareStandardLibrary());
    await expect(validateStorageCapabilityAgainstStandards({ ...capability, contentHash: "0".repeat(64) }, standards)).resolves.toContain("storage capability invalid or content hash mismatch");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateStorageCapability(revoked.proxy)).not.toThrow();
  });
});
