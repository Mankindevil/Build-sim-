import { describe, expect, it } from "vitest";
import type { BuildEvaluation } from "../src/core/evaluate";
import { diffEvaluations } from "../src/plans/evaluation";

function value(findings: Array<{ id: string; verdict: "ok" | "warn" | "bad" }>, knownCny: number): BuildEvaluation {
  return { findings, price: { knownCny, unknownSkuIds: [] } } as unknown as BuildEvaluation;
}

describe("R4 evaluation diff", () => {
  it("reports deterministic finding and known-budget changes", () => {
    const diff = diffEvaluations(value([{ id: "old", verdict: "bad" }, { id: "kept", verdict: "warn" }], 1000), value([{ id: "kept", verdict: "warn" }, { id: "new", verdict: "warn" }], 1250));
    expect(diff).toEqual({ resolvedFindingIds: ["old"], introducedFindingIds: ["new"], budgetDeltaCny: 250, beforeVerdict: "bad", afterVerdict: "warn" });
  });
});

