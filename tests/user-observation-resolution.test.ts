import { describe, expect, it } from "vitest";
import {
  canProjectUserObservation,
  observationLifecycle,
  validateUserObservation,
  type ObservationProjectionContext,
  type UserObservation,
} from "../src/observations/contracts";

const sha = (character: string): string => character.repeat(64);

function observation(overrides: Partial<UserObservation> = {}): UserObservation {
  return {
    observationId: "observation-clearance",
    planId: "plan-a",
    subjectRef: { kind: "placement", placementId: "placement-a" },
    fieldId: "physical.clearance",
    value: 4,
    unit: "mm",
    uncertainty: { plusMinus: 0.5 },
    method: "measurement",
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: sha("a"),
    subjectRevisionHash: sha("b"),
    capturedAt: "2026-08-28T00:00:00.000Z",
    validatedAt: "2026-08-28T00:01:00.000Z",
    status: "active",
    contentHash: sha("c"),
    ...overrides,
  };
}

function context(overrides: Partial<ObservationProjectionContext> = {}): ObservationProjectionContext {
  return {
    planId: "plan-a",
    subjectExists: true,
    currentConfigHash: sha("a"),
    currentSubjectRevisionHash: sha("b"),
    ...overrides,
  };
}

describe("U3 user observation resolution", () => {
  it("projects only a confirmed, validated, current active record", () => {
    const active = observation();
    expect(validateUserObservation(active)).toEqual([]);
    expect(canProjectUserObservation(active, context())).toBe(true);

    const { validatedAt: _ignoredValidatedAt, ...proposed } = observation({ status: "proposed", confirmedByUser: false });
    const unconfirmed = observation({ confirmedByUser: false });
    const invalidated = observation({
      invalidatedAt: "2026-08-28T00:02:00.000Z",
      invalidationReason: "route changed",
    });
    const retracted = observation({ status: "retracted" });

    expect(canProjectUserObservation(proposed, context())).toBe(false);
    expect(validateUserObservation(unconfirmed)).toContain("active observation must be user-confirmed and validated");
    expect(canProjectUserObservation(unconfirmed, context())).toBe(false);
    expect(observationLifecycle(active, context({ currentSubjectRevisionHash: sha("d") }))).toBe("stale");
    expect(canProjectUserObservation(active, context({ currentSubjectRevisionHash: sha("d") }))).toBe(false);
    expect(canProjectUserObservation(invalidated, context())).toBe(false);
    expect(canProjectUserObservation(retracted, context())).toBe(false);
    expect(canProjectUserObservation(active, context({ planId: "plan-b" }))).toBe(false);
    expect(canProjectUserObservation(active, context({ subjectExists: false }))).toBe(false);
  });

  it("governs method, uncertainty, unit, and observation time", () => {
    expect(validateUserObservation(observation({ unit: "count" as never }))).toContain("unitId is not allowlisted for this registry entry");
    const { uncertainty: _ignoredUncertainty, ...withoutUncertainty } = observation();
    expect(validateUserObservation(withoutUncertainty)).toContain("uncertainty is required for observation fieldId");
    expect(validateUserObservation(observation({ uncertainty: { plusMinus: 0 } }))).toContain("uncertainty invalid");
    expect(validateUserObservation(observation({ uncertainty: { min: 3, max: 5 } }))).toEqual([]);
    expect(validateUserObservation(observation({ method: "photo", attachmentRefs: [] }))).toContain("photo/label observation requires an attachment");
    expect(validateUserObservation(observation({ method: "label", attachmentRefs: ["label-photo"] }))).toEqual([]);
    expect(validateUserObservation(observation({ capturedAt: "2026-08-28" }))).toContain("capturedAt must be an ISO timestamp");
    expect(validateUserObservation(observation({ validatedAt: "2026-08-27T23:59:59.000Z" }))).toContain("validatedAt cannot precede capturedAt");
    expect(validateUserObservation(observation({
      invalidatedAt: "2026-08-28T00:00:30.000Z",
      invalidationReason: "invalid early event",
    }))).toContain("invalidatedAt cannot precede capture/validation");
  });

  it("uses the typed subject revision for freshness without invalidating unrelated instances", () => {
    const active = observation();
    expect(observationLifecycle(active, context({ currentConfigHash: sha("d") }))).toBe("active");
    expect(observationLifecycle(active, context({ currentSubjectRevisionHash: sha("d") }))).toBe("stale");
  });
});
