import { describe, expect, it } from "vitest";
import { runUniversalReleaseCanary } from "../scripts/release/universal-canary";

describe("U12 universal release canary", () => {
  it("runs the exact N6 partial plan through production authority and reports only real remaining blockers", async () => {
    const report = await runUniversalReleaseCanary();
    expect(report).toMatchObject({
      schemaVersion: "universal-release-canary-v1",
      status: "blocked",
      blockers: [
        "stage-a.official-fact-closure",
        "stage-a.cpu-max-turbo-power-is-official",
      ],
    });
    expect(report.checks.filter(({ status }) => status === "pass").map(({ checkId }) => checkId)).toEqual([
      "stage-a.two-distinct-ssd-instances",
      "stage-a.no-profile-default-components",
      "stage-a.agent-claim-scopes-are-explicit",
      "stage-a.partial-remains-not-power-ready",
      "stage-a.no-empty-bay-data-cables",
      "stage-a.spatial-scene-is-locked-and-blocked",
      "stage-a.thermal-acoustic-remains-blocked",
      "stage-a.price-is-not-invented",
      "stage-a.no-executable-first-power-completion",
    ]);
    const factCheck = report.checks.find(({ checkId }) => checkId === "stage-a.official-fact-closure");
    expect(factCheck?.evidence).toMatchObject({
      missingSkuIds: [
        "cpu.i5-14500",
        "storage.samsung-980-pro",
        "psu.seasonic-focus-plus-gold-850-fx",
      ],
    });
  }, 30_000);
});
