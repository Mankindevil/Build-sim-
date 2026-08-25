import { describe, expect, it } from "vitest";
import { buildN6Evaluation } from "./helpers/spatial";
import { buildSpatialSceneModel } from "../src/spatial/model";
import { buildSpatialOverlayModel, configFieldPartIds } from "../src/spatial/overlays";

describe("R6 plan and 3D sync", () => {
  it("maps editor fields and finding repair targets back to scene parts", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const model = buildSpatialSceneModel(evaluation, catalog);
    expect(configFieldPartIds("selection.psuId", model)).toContain("psu.primary");
    expect(configFieldPartIds("selection.diskCount", model).some((id) => id.startsWith("tray."))).toBe(true);
    expect(configFieldPartIds("selection.memoryId", model).every((id) => id.startsWith("ram."))).toBe(true);
    expect(buildSpatialOverlayModel(evaluation, model).findings.every((finding) => Boolean(finding.editorField))).toBe(true);
  });
});
