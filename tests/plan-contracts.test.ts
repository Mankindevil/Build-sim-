import { describe, expect, it } from "vitest";
import type { BuildConfig } from "../src/config/types";
import { canonicalJson, sha256Hex } from "../src/plans/canonical";
import { PLAN_SCHEMA_VERSION, type PlanChangeProposal } from "../src/plans/contracts";
import { assertExpectedConfigHash, assertExpectedRevision, PlanConflictError } from "../src/plans/conflict";
import { validateBuildPlan, validatePlanChangeProposal, validatePlanTransactionLink } from "../src/plans/validation";
import { createImmutablePlanVersion } from "../src/plans/version";

function config(): BuildConfig {
  return {
    schemaVersion: "2.0.0",
    id: "plan-1:draft",
    name: "N6 plan",
    updatedAt: "2026-08-25T00:00:00.000Z",
    caseId: "case",
    boardId: "board",
    cpuId: "cpu",
    selection: {
      psuId: "psu",
      psuTopology: "auto",
      coolerId: "cooler",
      gpuId: "gpu",
      memoryId: "memory",
      diskCount: 1,
      boot: "m2",
      hbaMode: "auto",
    },
    bom: [],
  };
}

describe("R0 plan contracts", () => {
  it("canonicalizes key order and hashes equal values identically", async () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalJson({ present: true, omitted: undefined, array: [undefined] })).toBe('{"array":[null],"present":true}');
    await expect(sha256Hex({ b: 2, a: 1 })).resolves.toBe(await sha256Hex({ a: 1, b: 2 }));
  });

  it("creates a deeply immutable version without sharing draft references", async () => {
    const draft = config();
    const version = await createImmutablePlanVersion({
      id: "version-1",
      planId: "plan-1",
      versionNumber: 1,
      createdAt: "2026-08-25T00:00:00.000Z",
      reason: "initial",
      config: draft,
      parentVersionId: null,
    });
    draft.name = "changed later";
    expect(version.config.name).toBe("N6 plan");
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.config.selection)).toBe(true);
    expect(() => { (version.config as BuildConfig).name = "mutate"; }).toThrow();
  });

  it("requires schema and explicit cross-domain relation keys", () => {
    expect(validateBuildPlan({})).toEqual(expect.arrayContaining([
      `schemaVersion must be ${PLAN_SCHEMA_VERSION}`,
      "draft.draft must be an object",
    ]));
    expect(validatePlanTransactionLink({
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: null,
      planVersionIdAtCapture: null,
      planItemId: null,
      linkStatus: "unlinked",
    })).toEqual([]);
  });

  it("rejects Agent patches outside the explicit config allowlist", () => {
    const proposal: PlanChangeProposal = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: "proposal-1",
      planId: "plan-1",
      expectedDraftRevision: 2,
      expectedConfigHash: "a".repeat(64),
      createdAt: "2026-08-25T00:00:00.000Z",
      summary: "Replace PSU",
      rationale: ["Resolve clearance"],
      operations: [{ op: "replace", path: "/selection/psuId", value: "new-psu" }],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
      status: "proposed",
    };
    expect(validatePlanChangeProposal(proposal)).toEqual([]);
    expect(validatePlanChangeProposal({
      ...proposal,
      operations: [{ op: "replace", path: "/schemaVersion", value: "evil" }],
    })).toContain("operations.0.operation path is not allowlisted");
    expect(validatePlanChangeProposal({
      ...proposal,
      operations: [{ op: "replace", path: "/selection/psuId", value: "new-psu", executable: "free text" }],
    })).toContain("operations.0.operation contains unknown fields");
  });

  it("rejects stale revisions and hashes as structured 409 conflicts", () => {
    expect(() => assertExpectedRevision(2, 3)).toThrow(PlanConflictError);
    try {
      assertExpectedRevision(2, 3);
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "stale_revision", expected: 2, actual: 3 });
    }
    expect(() => assertExpectedConfigHash("old", "new")).toThrow("stale_config_hash");
  });
});
