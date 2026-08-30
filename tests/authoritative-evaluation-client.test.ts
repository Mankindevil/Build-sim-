import { describe, expect, it, vi } from "vitest";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { hashPlanConfig } from "../src/plans/canonical";
import { PLAN_SCHEMA_VERSION, type BuildPlan, type PlanVersion } from "../src/plans/contracts";
import { authoritativeEvaluationHash } from "../src/plans/evaluation";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import type { SnapshotHashes } from "../src/hash";
import type { AuthoritativeEvaluationReceipt, AuthoritativeEvaluationResponse } from "../src/server/evaluation-service";
import {
  canPublishLegacyEvaluation,
  canUsePlanAgentContext,
  governedBuildEvaluationForActivePlan,
  governedBuildEvaluationForSavedVersion,
  requestPlanEvaluation,
} from "../src/lab/authoritative-evaluation-client";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { progressiveInput, resolvedComponent } from "./helpers/progressive-evaluation-fixture";
import type { BuildConfigDocument } from "../src/config/types";

const now = "2026-08-28T12:00:00.000Z";
const digest = (letter: string): string => letter.repeat(64);

function plan(): BuildPlan {
  const config = createDefaultN6Config("plan-client-authority", now);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: config.id,
    name: config.name,
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeVersionId: null,
    draftRevision: 3,
    draft: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      baseVersionId: null,
      config,
      dirty: true,
      updatedAt: now,
    },
    metadata: {},
  };
}

async function governedReceipt(target = plan()): Promise<AuthoritativeEvaluationReceipt> {
  const configHash = await hashPlanConfig(target.draft.config);
  const hashes: SnapshotHashes = {
    configHash,
    requirementSpecHash: digest("1"),
    factSnapshotHash: digest("2"),
    userObservationSnapshotHash: digest("3"),
    priceSnapshotHash: digest("4"),
    ruleSetHash: digest("5"),
    systemProfileHash: digest("6"),
    adapterSnapshotHash: digest("7"),
    engineHash: digest("8"),
    simulationModelHash: digest("9"),
    simulationInputHash: digest("a"),
  };
  const evaluationLock = await createPlanEvaluationLock({
    planId: target.id,
    snapshotHashes: hashes,
    factSnapshotId: "fact-snapshot-client",
    userObservationSnapshotId: "observation-snapshot-client",
    artifactLockfileHash: digest("b"),
  });
  const evaluation = evaluateBuild(target.draft.config, loadBundledCatalog());
  return {
    schemaVersion: "authoritative-evaluation-receipt-v1",
    planId: target.id,
    target: { kind: "draft", draftRevision: target.draftRevision },
    runtimeGeneration: 1,
    preparedRevision: 10,
    committedRevision: 11,
    configHash,
    evaluationHash: await authoritativeEvaluationHash(evaluation, evaluationLock),
    evaluationLock,
    evaluatedAt: now,
    evaluation,
    catalogVersion: "catalog-client",
    priceSnapshotVersion: "price-client",
    cacheStatus: "miss",
  };
}

function response(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("browser authoritative evaluation gate", () => {
  it("uses the target-only workspace route first and installs the exact locked receipt", async () => {
    const target = plan();
    const receipt = await governedReceipt(target);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(receipt, 201));
    const result = await requestPlanEvaluation(target, fetcher);
    expect(result.mode).toBe("enabled");
    if (result.mode !== "enabled") throw new Error("expected governed result");
    expect(result.snapshot).toMatchObject({
      planId: target.id,
      draftRevision: 3,
      evaluationHash: receipt.evaluationHash,
      evaluatedAt: receipt.evaluatedAt,
      evaluationLock: receipt.evaluationLock,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/workspace/plans/${target.id}/evaluations`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      target: { kind: "draft", expectedDraftRevision: 3, expectedConfigHash: await hashPlanConfig(target.draft.config) },
    });
  });

  it("accepts the exact progressive V3 receipt instead of rejecting it as an old partial shape", async () => {
    const config = createEmptyBuildConfigV3("plan-client-progressive", "Progressive client", now);
    config.components = [resolvedComponent("psu-progressive-client-0001", "psu", "psu.fixture")];
    const target: BuildPlan<BuildConfigDocument> = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: config.id,
      name: config.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
      activeVersionId: null,
      draftRevision: 4,
      draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: null, config, dirty: true, updatedAt: now },
      metadata: {},
    };
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);
    const receipt: AuthoritativeEvaluationReceipt = {
      schemaVersion: "authoritative-evaluation-receipt-v1",
      planId: target.id,
      target: { kind: "draft", draftRevision: target.draftRevision },
      runtimeGeneration: 1,
      preparedRevision: 1,
      committedRevision: 2,
      configHash: input.snapshotHashes.configHash,
      evaluationHash: await authoritativeEvaluationHash(evaluation, input.evaluationLock),
      evaluationLock: input.evaluationLock,
      evaluatedAt: now,
      evaluation,
      catalogVersion: "progressive-client",
      priceSnapshotVersion: "snapshot:progressive-client",
      cacheStatus: "miss",
    };
    const result = await requestPlanEvaluation(target, vi.fn(async () => response(receipt, 201)));
    expect(result).toMatchObject({ mode: "enabled", snapshot: { evaluation: { kind: "topology-v3-progressive" } } });
    if (result.mode !== "enabled") throw new Error("expected governed progressive result");
    expect(canUsePlanAgentContext("enabled", result.snapshot, target)).toBe(true);
  });

  it("falls back only for the route's explicit feature-disabled response", async () => {
    const target = plan();
    const evaluation = evaluateBuild(target.draft.config, loadBundledCatalog());
    const legacy: AuthoritativeEvaluationResponse = {
      schemaVersion: "1.0.0",
      configHash: await hashPlanConfig(target.draft.config),
      evaluationHash: digest("d"),
      catalogVersion: "legacy",
      priceSnapshotVersion: "legacy-price",
      evaluation,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/api/agent/evaluate")
      ? response(legacy, 200)
      : response({ error: "fact_graph_evaluation_disabled" }, 404));
    expect(await requestPlanEvaluation(target, fetcher)).toEqual({ mode: "disabled", response: legacy });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/api/workspace/plans/${target.id}/evaluations`,
      "/api/agent/evaluate",
    ]);
  });

  it.each([
    [503, { error: "evaluation_authority_failed", message: "closure invalid" }],
    [404, { error: "not_found" }],
  ])("never falls back after authority or unrelated route failure (%s)", async (status, payload) => {
    const fetcher = vi.fn(async () => response(payload, status));
    await expect(requestPlanEvaluation(plan(), fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("blocks startup/Agent context and legacy publication until the probe resolves", async () => {
    const target = plan();
    const receipt = await governedReceipt(target);
    const lockedSnapshot = (await requestPlanEvaluation(target, vi.fn(async () => response(receipt, 201))));
    if (lockedSnapshot.mode !== "enabled") throw new Error("expected governed result");
    expect(canPublishLegacyEvaluation("probing")).toBe(false);
    expect(canUsePlanAgentContext("probing", lockedSnapshot.snapshot, target)).toBe(false);
    expect(canPublishLegacyEvaluation("unavailable")).toBe(false);
    expect(canUsePlanAgentContext("unavailable", lockedSnapshot.snapshot, target)).toBe(false);
    expect(canPublishLegacyEvaluation("enabled")).toBe(false);
    expect(canUsePlanAgentContext("enabled", lockedSnapshot.snapshot, target)).toBe(true);
    expect(canPublishLegacyEvaluation("disabled")).toBe(true);
  });

  it("does not recreate V2 advice from the browser when governed authority is unavailable or stale", async () => {
    const target = plan();
    const receipt = await governedReceipt(target);
    const resolved = await requestPlanEvaluation(target, vi.fn(async () => response(receipt, 201)));
    if (resolved.mode !== "enabled") throw new Error("expected governed result");
    expect(governedBuildEvaluationForActivePlan("enabled", target, resolved.snapshot))
      .toEqual(receipt.evaluation);
    expect(governedBuildEvaluationForActivePlan("probing", target, resolved.snapshot)).toBeNull();
    expect(governedBuildEvaluationForActivePlan("unavailable", target, resolved.snapshot)).toBeNull();
    expect(governedBuildEvaluationForActivePlan("enabled", { ...target, draftRevision: 4 }, resolved.snapshot)).toBeNull();
    const editedBeforeSave = structuredClone(target);
    editedBeforeSave.draft.config.selection.diskCount += 1;
    expect(governedBuildEvaluationForActivePlan("enabled", editedBeforeSave, resolved.snapshot)).toBeNull();
    expect(canUsePlanAgentContext("enabled", resolved.snapshot, editedBeforeSave)).toBe(false);
  });

  it("exports a governed V2 version only from its exact immutable receipt", async () => {
    const target = plan();
    const receipt = await governedReceipt(target);
    const resolved = await requestPlanEvaluation(target, vi.fn(async () => response(receipt, 201)));
    if (resolved.mode !== "enabled") throw new Error("expected governed result");
    const version: PlanVersion = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: "version-client-authority",
      planId: target.id,
      versionNumber: 1,
      createdAt: now,
      reason: "manual-save",
      config: structuredClone(target.draft.config),
      configHash: receipt.configHash,
      evaluationHash: receipt.evaluationHash,
      evaluatedAt: receipt.evaluatedAt,
      evaluationLock: receipt.evaluationLock,
      parentVersionId: null,
    };
    const snapshot = { ...resolved.snapshot, planVersionId: version.id };
    expect(governedBuildEvaluationForSavedVersion("enabled", version, snapshot)).toEqual(receipt.evaluation);
    expect(governedBuildEvaluationForSavedVersion("unavailable", version, snapshot)).toBeNull();
    const { evaluationLock: _evaluationLock, ...unlockedVersion } = version;
    expect(governedBuildEvaluationForSavedVersion("enabled", unlockedVersion, snapshot)).toBeNull();
    expect(governedBuildEvaluationForSavedVersion("enabled", version, { ...snapshot, evaluationHash: digest("f") })).toBeNull();
  });
});
