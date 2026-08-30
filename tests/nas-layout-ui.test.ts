// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderNasLayouts } from "../src/lab/nas-layout";
import type { ProductionStorageLayoutProjection } from "../src/storage/production";

afterEach(() => document.body.replaceChildren());

describe("U11 NAS layout UI", () => {
  it("keeps physical disks, logical vdevs, paths, capacity, tolerance, and blocked reasons visible", () => {
    const host = document.createElement("section"); document.body.append(host);
    const layouts = [{
      status: "ready", layoutId: "layout-mirror", disks: [], evaluation: {
        usableBytes: { min: 4_000_000_000_000, max: 4_000_000_000_000 }, assumptions: ["同容量镜像"],
        vdevResults: [{
          vdevId: "data-mirror", estimatedUsableBytes: { min: 4_000_000_000_000, max: 4_000_000_000_000 },
          faultTolerance: { diskFailures: 1 }, mixedCapacityLossBytes: 500_000_000_000,
          controllerPaths: [
            { diskInstanceId: "disk-a", controllerInstanceId: "hba-main", controllerPortId: "p1", transport: "sas" },
            { diskInstanceId: "disk-b", controllerInstanceId: "hba-main", controllerPortId: "p2", transport: "sas" },
          ],
        }],
      },
    }, {
      status: "blocked", layoutId: "layout-raidz", reasons: ["启动盘与数据盘尚未唯一定位"],
    }] as unknown as ProductionStorageLayoutProjection[];

    renderNasLayouts(host, layouts);

    expect(host.textContent).toContain("RAID/RAIDZ 不是备份");
    expect(host.textContent).toContain("可容忍 1 块盘故障");
    expect(host.textContent).toContain("混盘损失 500 GB");
    expect(host.textContent).toContain("disk-a → hba-main/p1 (sas)");
    expect(host.textContent).toContain("启动盘与数据盘尚未唯一定位");
  });
});
