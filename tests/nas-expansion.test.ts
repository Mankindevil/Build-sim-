import { describe, expect, it } from "vitest";
import { deriveExpansionOptions } from "../src/storage/expansion";

describe("U7 NAS expansion", () => {
  it("offers whole-vdev, replacement and spare paths with explicit risk decisions", () => {
    const options = deriveExpansionOptions({ layoutId: "layout", bootPoolDiskIds: ["boot"], vdevs: [{ vdevId: "data", topology: "raidz2", diskInstanceIds: ["d1", "d2", "d3", "d4"] }], spareDiskIds: [] });
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ optionId: "expansion.add-vdev.raidz2", requiredInstanceCount: 4 }),
      expect.objectContaining({ optionId: "expansion.replace-drives.raidz2", requiredInstanceCount: 4 }),
      expect.objectContaining({ optionId: "expansion.add-spare", requiredInstanceCount: 1 }),
    ]));
    expect(options.every(({ riskDecisionIds }) => riskDecisionIds.length > 0)).toBe(true);
  });
});
