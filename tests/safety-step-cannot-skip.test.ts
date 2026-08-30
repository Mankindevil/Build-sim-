import { describe, expect, it } from "vitest";
import { validateExecutionSession, type ExecutionSession } from "../src/build-execution/contracts";
import { generatedProcedure } from "./helpers/u7-fixtures";

describe("U7 safety step execution", () => {
  it("does not allow a safety or destructive step to be skipped", () => {
    const generated = generatedProcedure("system.truenas-scale");
    const step = generated.procedure.steps.find(({ safetyCritical }) => safetyCritical)!;
    const session: ExecutionSession = {
      executionSessionId: "execution-u7", planVersionId: "version-u7", procedureId: generated.procedure.procedureId,
      evaluationHash: generated.procedure.inputEvaluationHash, procedureSafetyHash: generated.procedure.procedureSafetyHash,
      status: "active", results: [{ stepId: step.stepId, result: "skipped_non_safety", at: "2026-08-29T00:00:00.000Z", actor: "user", confirmedAgainstDependencyHash: step.dependencyHash }],
    };
    expect(validateExecutionSession(session, generated.procedure, generated.dependencyContext)).toContain(`${step.stepId}: safety step cannot be skipped`);
  });
});
