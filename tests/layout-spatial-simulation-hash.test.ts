import { describe, expect, it } from "vitest";
import { logicalLayoutSimulationHash } from "../src/simulation/contracts";

describe("U9 NAS layout/spatial simulation identity", () => {
  it("binds vdev membership, topology and each disk's exact physical path", async () => {
    const base = {
      layoutId: "layout-nas",
      bootPoolDiskIds: [],
      vdevs: [{ vdevId: "data", topology: "mirror" as const, diskInstanceIds: ["disk-a", "disk-b"] }],
      spareDiskIds: [],
    };
    const paths = { "disk-a": "a".repeat(64), "disk-b": "b".repeat(64) };
    const first = await logicalLayoutSimulationHash(base, paths);
    await expect(logicalLayoutSimulationHash({ ...base, vdevs: [{ ...base.vdevs[0]!, topology: "raidz1" }] }, paths))
      .resolves.not.toBe(first);
    await expect(logicalLayoutSimulationHash(base, { ...paths, "disk-b": "c".repeat(64) }))
      .resolves.not.toBe(first);
  });
});
