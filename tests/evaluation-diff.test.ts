import { describe, expect, it } from "vitest";
import type { BuildEvaluation } from "../src/core/evaluate";
import { diffEvaluations } from "../src/plans/evaluation";

function value(findings: Array<{ id: string; verdict: "ok" | "warn" | "bad" }>, knownCny: number): BuildEvaluation {
  return { findings, price: { knownCny, unknownSkuIds: [], complete: true } } as unknown as BuildEvaluation;
}

describe("R4 evaluation diff", () => {
  it("reports deterministic finding and known-budget changes", () => {
    const diff = diffEvaluations(value([{ id: "old", verdict: "bad" }, { id: "kept", verdict: "warn" }], 1000), value([{ id: "kept", verdict: "warn" }, { id: "new", verdict: "warn" }], 1250));
    expect(diff).toEqual({ resolvedFindingIds: ["old"], introducedFindingIds: ["new"], budgetDeltaCny: 250, beforeVerdict: "bad", afterVerdict: "warn" });
  });

  it("does not report a partial known sum as a budget delta", () => {
    const before = value([], 1000);
    const after = value([], 1000);
    after.price.complete = false;
    after.price.unresolvedRequirements = [{ id: "case-fan:front:140mm:2" }] as never;
    expect(diffEvaluations(before, after).budgetDeltaCny).toBeNull();

    const legacyIncomplete = value([], 1200);
    delete (legacyIncomplete.price as Partial<typeof legacyIncomplete.price>).complete;
    legacyIncomplete.price.unknownSkuIds = ["fan.sku-not-yet-reviewed"];
    expect(diffEvaluations(before, legacyIncomplete).budgetDeltaCny).toBeNull();
  });
});
