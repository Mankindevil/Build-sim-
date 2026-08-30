import { describe, expect, it } from "vitest";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import {
  PROGRESSIVE_FIXTURE_NOW,
  progressiveInput,
  resolvedComponent,
} from "./helpers/progressive-evaluation-fixture";

describe("U12 partial build false-completion gate", () => {
  it("keeps a resolvable but incomplete build partial and never power-ready", async () => {
    const config = createEmptyBuildConfigV3(
      "plan-partial-no-completion",
      "Partial build",
      PROGRESSIVE_FIXTURE_NOW,
    );
    config.components = [
      resolvedComponent("case-partial-1", "case", "case.fixture"),
      resolvedComponent("board-partial-1", "motherboard", "board.fixture"),
      resolvedComponent("cpu-partial-1", "cpu", "cpu.fixture"),
      resolvedComponent("psu-partial-1", "psu", "psu.fixture"),
    ];

    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config));

    expect(evaluation.topologyBom).toHaveLength(config.components.length);
    expect(evaluation.readiness).toMatchObject({
      profileCompleteness: "partial",
      powerReady: false,
      firstBootReady: false,
      osInstallReady: false,
    });
    expect(evaluation.requirementReadiness).toMatchObject({
      powerReady: false,
      firstBootReady: false,
      osInstallReady: false,
    });
    expect(evaluation.requirements.some((requirement) => requirement.kind === "component")).toBe(true);
    expect(evaluation.domainEvaluations.some(({ verdict }) => verdict === "blocked" || verdict === "unknown")).toBe(true);
    expect(evaluation.domainEvaluations.every(({ verdict }) => verdict === "pass")).toBe(false);
  });
});
