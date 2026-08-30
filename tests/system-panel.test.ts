// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderSystemPanel } from "../src/lab/system-panel";
import { createHelpButton } from "../src/lab/help-link";
import { configFor } from "./helpers/u7-fixtures";

afterEach(() => { document.body.replaceChildren(); });

describe("U7 system panel", () => {
  it("shows a system default without adding components and emits a locked user selection", () => {
    const host = document.createElement("div"); document.body.append(host);
    const config = configFor("system.windows-11"); config.system = null; config.components = [];
    let selected: unknown = null;
    renderSystemPanel(host, config, { evaluation: null, onSelect(value) { selected = value; } });
    const select = host.querySelector<HTMLSelectElement>("[data-v3-system-profile]")!;
    expect(select.value).toBe("system.windows-11");
    expect(host.textContent).toContain("机械兼容：unknown · 系统可用：unknown");
    select.value = "system.linux-desktop"; select.dispatchEvent(new Event("change"));
    expect(selected).toMatchObject({ profileId: "system.linux-desktop", source: "user", lockedByUser: true });
    expect(config.components).toEqual([]);
  });

  it("uses a keyboard-accessible shared help dialog and returns focus", () => {
    const button = createHelpButton("help.system.windows-11", "Windows 11"); document.body.append(button);
    button.click();
    const dialog = document.querySelector<HTMLDialogElement>("[data-buildsim-help-dialog]")!;
    expect(button.getAttribute("aria-label")).toBe("了解Windows 11");
    expect(dialog.querySelector("#buildsim-help-title")?.textContent).toBe("Windows 11");
    dialog.dispatchEvent(new Event("close"));
    expect(document.activeElement).toBe(button);
  });

  it("records only an explicit non-overlapping TrueNAS layout selection", () => {
    const host = document.createElement("div"); document.body.append(host);
    const config = configFor("system.truenas-scale");
    config.components.push(...["boot-1", "disk-1", "disk-2", "spare-1"].map((instanceId) => ({
      instanceId,
      kind: "storage_drive" as const,
      role: "storage",
      state: "planned" as const,
      identity: { status: "resolved" as const, skuId: `sku.${instanceId}`, identityClaimIds: [`claim.${instanceId}`] },
      source: "user" as const,
    })));
    let layouts: unknown = null;
    renderSystemPanel(host, config, {
      evaluation: null,
      onSelect() {},
      onLayoutsChange(value) { layouts = value; },
    });
    const boot = host.querySelector<HTMLSelectElement>("[data-nas-boot-disk]")!;
    const topology = host.querySelector<HTMLSelectElement>("[data-nas-topology]")!;
    const data = host.querySelector<HTMLSelectElement>("[data-nas-data-disks]")!;
    const spare = host.querySelector<HTMLSelectElement>("[data-nas-spare-disks]")!;
    boot.value = "boot-1";
    topology.value = "mirror";
    for (const option of data.options) option.selected = ["disk-1", "disk-2"].includes(option.value);
    for (const option of spare.options) option.selected = option.value === "spare-1";
    host.querySelector<HTMLButtonElement>("[data-save-nas-layout]")!.click();
    expect(layouts).toEqual([{
      layoutId: "layout.plan-u7.truenas-primary",
      bootPoolDiskIds: ["boot-1"],
      vdevs: [{ vdevId: "vdev.data-primary", topology: "mirror", diskInstanceIds: ["disk-1", "disk-2"] }],
      spareDiskIds: ["spare-1"],
    }]);
    expect(host.textContent).toContain("RAID/RAIDZ 不是备份");

    layouts = null;
    boot.value = "disk-1";
    host.querySelector<HTMLButtonElement>("[data-save-nas-layout]")!.click();
    expect(layouts).toBeNull();
    expect(host.querySelector<HTMLElement>("[data-nas-layout-status]")!.textContent).toContain("同一磁盘不能同时属于");
  });
});
