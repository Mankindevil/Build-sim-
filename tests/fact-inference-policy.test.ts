import { describe, expect, it } from "vitest";
import { createFactRecord } from "../src/facts/hash";
import { createReplayableInferenceTrace, inferenceTraceIsCurrent, verifyReplayableInferenceTrace } from "../src/facts/inference-policy";

const digest = (letter: string): string => letter.repeat(64);

async function inputFact(id: string, value: number, supersedes?: { factId: string; contentHash: string }) {
  return createFactRecord({
    schemaVersion: "fact-record-v1", factId: id,
    subject: { kind: "plan_subject", planId: "plan-a", subjectRef: { kind: "placement", placementId: "gpu" } },
    field: "physical.clearance", value, unit: "mm", scope: "plan_subject", authority: "user_observation",
    safetyClass: "compatibility_critical", status: "active", evidenceRefs: [`observation:clearance@sha256:${digest("a")}`],
    derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
    ...(supersedes ? { supersedesFactId: supersedes.factId, supersededFactHash: supersedes.contentHash } : {}),
  });
}

describe("U3 replayable inference policy", () => {
  it("binds every input fact hash and the rule/model artifact", async () => {
    const input = await inputFact("fact-clearance-a", 4);
    const trace = await createReplayableInferenceTrace({
      schemaVersion: "fact-inference-v1", inputFactRefs: [{ factId: input.factId, contentHash: input.contentHash }], outputFactIds: ["fact-derived"],
      engine: "rule", ruleOrModelId: "clearance-rule", ruleOrModelVersion: "1.0.0", ruleOrModelArtifactHash: digest("b"),
      assumptions: ["orthogonal placement"], confidence: 0.9, outputRange: { min: 3.5, max: 4.5, unit: "mm" },
      invalidationConditions: ["input fact changes", "placement changes", "rule artifact changes"], createdAt: "2026-08-28T00:01:00.000Z",
    });
    expect(await verifyReplayableInferenceTrace(trace)).toBe(true);
    expect(await inferenceTraceIsCurrent(trace, [input], digest("b"))).toBe(true);
    expect(await inferenceTraceIsCurrent(trace, [input], digest("c"))).toBe(false);
  });

  it("becomes stale when an input is replaced even though immutable history is retained", async () => {
    const old = await inputFact("fact-clearance-a", 4);
    const trace = await createReplayableInferenceTrace({
      schemaVersion: "fact-inference-v1", inputFactRefs: [{ factId: old.factId, contentHash: old.contentHash }], outputFactIds: ["fact-derived"],
      engine: "model", ruleOrModelId: "geometry-model", ruleOrModelVersion: "2.0.0", ruleOrModelArtifactHash: digest("d"),
      assumptions: [], confidence: 0.7, invalidationConditions: ["input fact changes"], createdAt: "2026-08-28T00:01:00.000Z",
    });
    const replacement = await inputFact("fact-clearance-b", 5, old);
    expect(await inferenceTraceIsCurrent(trace, [old, replacement], digest("d"))).toBe(false);
    expect(await inferenceTraceIsCurrent(trace, [replacement], digest("d"))).toBe(false);
    expect(await verifyReplayableInferenceTrace({ ...trace, inputFactRefs: [{ ...trace.inputFactRefs[0]!, contentHash: digest("e") }] })).toBe(false);
  });
});
