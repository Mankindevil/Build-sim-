import { describe, expect, it } from "vitest";
import {
  canProjectUserObservation,
  observationLifecycle,
  validateObservationAttachment,
  validateUserObservationSnapshot,
  validateUserObservation,
  type UserObservation,
} from "../src/observations/contracts";
import { validateUserObservationRuntime } from "../src/observations/canonical-runtime.mjs";

const digest = (character = "a"): string => character.repeat(64);

const observation = (): UserObservation => ({
  observationId: "obs-clearance", planId: "plan-a", subjectRef: { kind: "placement", placementId: "gpu-placement" }, fieldId: "physical.clearance", value: 4, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement", attachmentRefs: ["photo-hash"], confirmedByUser: true, observedAgainstConfigHash: digest("a"), subjectRevisionHash: digest("b"), capturedAt: "2026-08-27T00:00:00.000Z", validatedAt: "2026-08-27T00:01:00.000Z", status: "active", contentHash: digest("c"),
});

const context = (overrides: Partial<{ planId: string; subjectExists: boolean; currentConfigHash: string; currentSubjectRevisionHash: string }> = {}) => ({
  planId: "plan-a",
  subjectExists: true,
  currentConfigHash: digest("a"),
  currentSubjectRevisionHash: digest("b"),
  ...overrides,
});

describe("U0 user observation lifecycle", () => {
  it("projects only confirmed, validated, plan-scoped current subjects", () => {
    const value = observation();
    expect(validateUserObservation(value)).toEqual([]);
    expect(canProjectUserObservation(value, context())).toBe(true);
    expect(canProjectUserObservation(value, context({ planId: "plan-b" }))).toBe(false);
    // Config hash is retained as capture/audit provenance. A non-plan subject
    // stays current across unrelated config edits; its typed revision is the
    // selective invalidation boundary.
    expect(canProjectUserObservation(value, context({ currentConfigHash: digest("d") }))).toBe(true);
    expect(canProjectUserObservation(value, context({ currentSubjectRevisionHash: digest("d") }))).toBe(false);
    expect(canProjectUserObservation(value, context({ subjectExists: false }))).toBe(false);
  });

  it("derives stale from subject revision and never persists stale status", () => {
    const value = observation();
    expect(observationLifecycle(value, context({ currentSubjectRevisionHash: digest("d") }))).toBe("stale");
    expect(validateUserObservation({ ...value, status: "stale" })).toContain("status invalid");
    expect(validateUserObservation({ ...value, uncertainty: undefined })).toContain("uncertainty is required for observation fieldId");
    expect(validateUserObservation({ ...value, uncertainty: { plusMinus: 0 } })).toContain("uncertainty invalid");
    expect(validateUserObservation({ ...value, uncertainty: { min: 5, max: 3 } })).toContain("uncertainty invalid");
    expect(validateUserObservation({ ...value, uncertainty: { min: 3, max: 5, plusMinus: 1 } })).toContain("uncertainty invalid");
  });

  it("retains a private hash tombstone after attachment erasure", () => {
    expect(validateObservationAttachment({ attachmentId: "attachment", contentHash: digest(), mediaType: "image/jpeg", privacyClass: "private_user", deletionPolicy: "retain_until_user_deletes", status: "deleted_tombstone", deletedAt: "2026-08-27T00:00:00.000Z" })).toEqual([]);
    expect(validateObservationAttachment({ attachmentId: "attachment", contentHash: "", mediaType: "image/jpeg", privacyClass: "private_user", deletionPolicy: "retain_until_user_deletes", status: "deleted_tombstone" })).toEqual(expect.arrayContaining(["deleted attachment must retain a timestamped tombstone", "attachment tombstone must retain sha256 contentHash"]));
  });

  it("requires exact workload, method, distance and RPM context for sound measurements", () => {
    const value: UserObservation = {
      ...observation(),
      observationId: "obs-sound",
      subjectRef: { kind: "instance", instanceId: "fan-1" },
      fieldId: "acoustics.sound_pressure",
      value: 31,
      unit: "dba",
      uncertainty: { plusMinus: 1 },
      measurementContext: {
        workloadId: "requirements:quiet-load",
        testMethodId: "method.bounded-chamber",
        referenceDistanceM: 1,
        rpm: { lo: 900, hi: 1100 },
      },
    };
    expect(validateUserObservation(value)).toEqual([]);
    expect(validateUserObservationRuntime(value)).toEqual([]);
    expect(validateUserObservation({ ...value, measurementContext: undefined })).toContain("measurementContext invalid for observation fieldId");
    expect(validateUserObservation({ ...value, measurementContext: { ...value.measurementContext!, referenceDistanceM: 0 } }))
      .toContain("measurementContext invalid for observation fieldId");
    expect(validateUserObservation({ ...value, measurementContext: { ...value.measurementContext!, rpm: { lo: 1200, hi: 900 } } }))
      .toContain("measurementContext invalid for observation fieldId");
  });

  it("rejects fake hashes, nested subject fields and unsafe projection state", () => {
    const value = observation();
    expect(validateUserObservation({ ...value, contentHash: "hash" })).toContain("contentHash must be sha256");
    expect(validateUserObservation({ ...value, subjectRef: { ...value.subjectRef, extra: true } })).toContain("subjectRef fields invalid");
    expect(validateUserObservation({ ...value, unexpected: true })).toContain("user observation contains derived or unknown fields");
    expect(validateUserObservation({ ...value, validatedAt: 1 })).toEqual(expect.arrayContaining(["validatedAt invalid", "active observation must be user-confirmed and validated"]));
    expect(canProjectUserObservation({ ...value, status: "proposed", confirmedByUser: false }, context())).toBe(false);
    expect(canProjectUserObservation({ ...value, invalidatedAt: "2026-08-27T01:00:00.000Z", invalidationReason: "route changed" }, context())).toBe(false);
    expect(validateUserObservation({ ...value, capturedAt: "August 27, 2026" })).toContain("capturedAt must be an ISO timestamp");
    expect(validateUserObservation({ ...value, validatedAt: "2026-08-26T23:59:00.000Z" })).toContain("validatedAt cannot precede capturedAt");
    expect(validateUserObservation({ ...value, invalidatedAt: "2026-08-27T00:00:30.000Z", invalidationReason: "stale" })).toContain("invalidatedAt cannot precede capture/validation");
    expect(() => validateUserObservation({ subjectRef: null })).not.toThrow();
  });

  it("validates content-addressed snapshots and replacement direction", () => {
    expect(validateUserObservationSnapshot({ schemaVersion: "user-observation-snapshot-v1", snapshotId: "snapshot", planId: "plan-a", observationIds: ["obs"], createdAt: "2026-08-27T00:00:00.000Z", contentHash: digest() })).toEqual([]);
    expect(validateUserObservationSnapshot({ schemaVersion: "user-observation-snapshot-v1", snapshotId: "snapshot", planId: "plan-a", observationIds: [], createdAt: "now", contentHash: "sha256", extra: true })).toEqual(expect.arrayContaining([
      "user observation snapshot contains unknown fields",
      "user observation snapshot contentHash must be sha256",
    ]));
    expect(validateUserObservation({ ...observation(), status: "superseded", supersedesObservationId: "old" })).toContain("only an active replacement observation may declare supersedesObservationId");
  });
});
