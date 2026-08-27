import { describe, expect, it } from "vitest";
import { validateLogicalLayoutSelection, validateStorageLayoutEvaluation } from "../src/storage/contracts";

const digest = "a".repeat(64);

describe("U0 storage selection/evaluation separation", () => {
  it("rejects capacity, tolerance, path and decision outputs in config selection", () => {
    const selection = { layoutId: "pool", bootPoolDiskIds: [], vdevs: [{ vdevId: "data", topology: "mirror", diskInstanceIds: ["d1", "d2"] }], spareDiskIds: [] };
    expect(validateLogicalLayoutSelection(selection)).toEqual([]);
    expect(validateLogicalLayoutSelection({ ...selection, usableBytes: { min: 1, max: 2 }, decisions: [] })).toContain("layout selection contains derived evaluation fields");
    expect(validateLogicalLayoutSelection({ ...selection, vdevs: [{ ...selection.vdevs[0], usableBytes: 1 }] })).toContain("vdevs.0 contains derived or unknown fields");
  });

  it("accepts storage conclusions only in a separately hashed evaluation", () => {
    expect(validateStorageLayoutEvaluation({ layoutSelectionHash: digest, systemProfileId: "truenas-25", usableBytes: { min: 8, max: 9 }, vdevResults: [{ vdevId: "data", estimatedUsableBytes: { min: 8, max: 9 }, faultTolerance: { diskFailures: 1, conditions: ["one disk in vdev"] } }], hbaAndPathDecisionIds: ["hba-path"], expansionOptions: [], decisions: [{ decisionId: "storage-pass", verdict: "pass", domain: "storage", message: "mirror valid", instanceIds: ["d1", "d2"], factIds: [], ruleId: "storage", ruleVersion: "1", assumptions: [], remediation: [] }], assumptions: [] })).toEqual([]);
  });
});
