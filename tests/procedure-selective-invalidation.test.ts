import { describe, expect, it } from "vitest";
import { staleExecutionStepIds, type ExecutionSession } from "../src/build-execution/contracts";
import { generatedProcedure, hash } from "./helpers/u7-fixtures";

describe("U7 procedure selective invalidation", () => {
  it("marks only steps whose domain dependency hash changed and ignores price-only refreshes", () => {
    const generated = generatedProcedure("system.windows-11");
    const first = generated.procedure.steps[0]!;
    const second = generated.procedure.steps[1]!;
    const session: ExecutionSession = {
      executionSessionId: "execution-u7", planVersionId: "version-u7", procedureId: generated.procedure.procedureId,
      evaluationHash: generated.procedure.inputEvaluationHash, procedureSafetyHash: generated.procedure.procedureSafetyHash, status: "active",
      results: [first, second].map((step) => ({ stepId: step.stepId, result: "confirmed" as const, at: "2026-08-29T00:00:00.000Z", actor: "user" as const, confirmedAgainstDependencyHash: step.dependencyHash })),
    };
    expect(staleExecutionStepIds(session, generated.procedure)).toEqual([]);
    const changed = structuredClone(generated.procedure);
    changed.steps[1]!.dependencyHash = hash("f");
    expect(staleExecutionStepIds(session, changed)).toEqual([second.stepId]);
  });
});
