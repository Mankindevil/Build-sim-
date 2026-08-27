import { describe, expect, it } from "vitest";
import { validateDestructiveActionPlan, validateDestructiveActionPlanAuthoritatively, validateLogicalLayoutSelection, type DestructiveActionValidationContext } from "../src/storage/contracts";
import type { UserObservation } from "../src/observations/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = (letter: string) => letter.repeat(64);
const locator = (diskInstanceId: string, observationId: string): UserObservation => ({
  observationId, planId: "plan", subjectRef: { kind: "instance", instanceId: diskInstanceId }, fieldId: "storage.disk_locator", value: `bay:${diskInstanceId}`,
  method: "label", attachmentRefs: ["photo"], confirmedByUser: true, observedAgainstConfigHash: digest("b"), subjectRevisionHash: digest("c"),
  capturedAt: "2026-08-27T00:00:00.000Z", validatedAt: "2026-08-27T00:01:00.000Z", status: "active", contentHash: digest("d"),
});
const context = (): DestructiveActionValidationContext => ({
  currentPlanId: "plan", currentPlanVersionId: "plan-v1", currentConfigHash: digest("b"), currentPlanRevisionHash: digest("e"), currentProcedureSafetyHash: digest("a"),
  diskRevisionHashes: { d1: digest("c"), d2: digest("c") },
  diskLocatorObservations: new Map([["d1", locator("d1", "loc1")], ["d2", locator("d2", "loc2")]]),
});
const action = () => ({ actionId: "wipe", diskInstanceIds: ["d1", "d2"], locatorObservationIds: ["loc1", "loc2"], inputPlanId: "plan", inputPlanVersionId: "plan-v1", inputConfigHash: digest("b"), inputPlanRevisionHash: digest("e"), inputProcedureSafetyHash: digest("a"), confirmation: "required" as const });

describe("U0 NAS layout selection contracts", () => {
  it("keeps every disk as an instance ID and prevents double allocation", () => {
    expect(validateLogicalLayoutSelection({ layoutId: "pool", bootPoolDiskIds: ["boot"], vdevs: [{ vdevId: "data", topology: "raidz1", diskInstanceIds: ["d1", "d2", "d3"] }], spareDiskIds: ["spare"] })).toEqual([]);
    expect(validateLogicalLayoutSelection({ layoutId: "pool", bootPoolDiskIds: ["d1"], vdevs: [{ vdevId: "data", topology: "mirror", diskInstanceIds: ["d1", "d2"] }], spareDiskIds: [] })).toContain("one disk cannot occupy multiple layout roles");
  });

  it("requires a unique locator per disk and hash-bound destructive confirmation", () => {
    expect(validateDestructiveActionPlan({ ...action(), locatorObservationIds: ["loc1"] }, context())).toContain("every disk requires one unique locator observation");
    expect(validateDestructiveActionPlan({ ...action(), confirmation: "confirmed", confirmationAt: "2026-08-27T00:00:00.000Z" }, { ...context(), currentProcedureSafetyHash: digest("f") })).toContain("destructive confirmation is stale for the current procedureSafetyHash");
    expect(validateDestructiveActionPlan({ ...action(), inputProcedureSafetyHash: "not-a-hash" }, context())).toContain("destructive action plan/config/safety hashes invalid");
    expect(validateDestructiveActionPlan(action(), context())).toEqual([]);
    const swapped = context();
    swapped.diskLocatorObservations = new Map([["d1", locator("d2", "loc1")], ["d2", locator("d1", "loc2")]]);
    expect(validateDestructiveActionPlan(action(), swapped)).toEqual(expect.arrayContaining([
      "disk d1 lacks a current active storage.disk_locator observation",
      "disk d2 lacks a current active storage.disk_locator observation",
    ]));
    expect(validateDestructiveActionPlan({ ...action(), inputConfigHash: digest("f") }, context())).toContain("destructive action confirmation is stale for the current plan/config/revision");
  });

  it("resolves destructive current state through a runner-issued resolver", async () => {
    const resolver = createAuthoritativeResolver("destructive-action-context", (ref) => ref === "destructive/current" ? context() : undefined);
    await expect(validateDestructiveActionPlanAuthoritatively(action(), "destructive/current", resolver)).resolves.toEqual([]);
    await expect(validateDestructiveActionPlanAuthoritatively(action(), "missing", resolver)).resolves.toEqual([
      expect.stringContaining("destructive action authoritative context resolution failed"),
    ]);
    await expect(validateDestructiveActionPlanAuthoritatively(action(), "destructive/current", JSON.parse(JSON.stringify(context())) as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
    const stale = createAuthoritativeResolver("destructive-action-context", () => ({ ...context(), currentConfigHash: digest("f") }));
    await expect(validateDestructiveActionPlanAuthoritatively(action(), "destructive/current", stale))
      .resolves.toContain("destructive action confirmation is stale for the current plan/config/revision");
  });
});
