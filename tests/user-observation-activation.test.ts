import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservationProjectionContext, UserObservation } from "../src/observations/contracts";
import { ObservationRepository } from "../src/observations/repository";
import { canonicalJson } from "../src/plans/canonical";

const roots: string[] = [];
const sha = (character: string): string => character.repeat(64);
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const now = (): string => "2026-08-28T01:00:00.000Z";

function proposedObservation(observationId = "observation-proposed"): UserObservation {
  const base = {
    observationId,
    planId: "plan-a",
    subjectRef: { kind: "placement" as const, placementId: "placement-a" },
    fieldId: "physical.clearance" as const,
    value: 4,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: false,
    observedAgainstConfigHash: sha("a"),
    subjectRevisionHash: sha("b"),
    capturedAt: "2026-08-28T00:00:00.000Z",
    status: "proposed" as const,
  };
  return { ...base, contentHash: digest(base) };
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

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-activation-"));
  roots.push(root);
  let authority = context();
  const store = new ObservationRepository({
    root,
    now,
    attachments: { hasAvailable: async () => false },
    projectionContextForObservation: () => authority,
  });
  return { root, store, setAuthority: (next: ObservationProjectionContext) => { authority = next; } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 observation activation CAS", () => {
  it("keeps proposed and unconfirmed records out of fact projection", async () => {
    const { store } = await repository();
    const proposed = proposedObservation();
    await store.put({ observation: proposed });
    await expect(store.resolveForFact("plan-a", proposed.observationId)).resolves.toBeNull();

    const unconfirmedBase = {
      ...proposed,
      observationId: "observation-unconfirmed-active",
      status: "active" as const,
      validatedAt: now(),
    };
    const { contentHash: _contentHash, ...withoutHash } = unconfirmedBase;
    const unconfirmed = { ...withoutHash, contentHash: digest(withoutHash) };
    await expect(store.put({ observation: unconfirmed })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("activates one immutable successor and fences competing or stale writers by source hash", async () => {
    const { store, setAuthority } = await repository();
    const proposed = proposedObservation();
    await store.put({ observation: proposed });

    await expect(store.activate({
      planId: "plan-a",
      observationId: proposed.observationId,
      expectedHash: sha("f"),
      replacementObservationId: "observation-wrong-cas",
      context: context(),
    })).rejects.toMatchObject({ code: "conflict" });

    // Existing active records survive unrelated config changes, but a proposal
    // must still be activated against the exact config it was captured from.
    setAuthority(context({ currentConfigHash: sha("c") }));
    await expect(store.activate({
      planId: "plan-a",
      observationId: proposed.observationId,
      expectedHash: digest(proposed),
      replacementObservationId: "observation-stale-capture",
      context: context(),
    })).rejects.toMatchObject({ code: "conflict" });

    setAuthority(context({ currentSubjectRevisionHash: sha("d") }));
    await expect(store.activate({
      planId: "plan-a",
      observationId: proposed.observationId,
      expectedHash: digest(proposed),
      replacementObservationId: "observation-stale-subject",
      context: context(),
    })).rejects.toMatchObject({ code: "conflict" });

    setAuthority(context());
    const contenders = await Promise.allSettled([
      store.activate({
        planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed),
        replacementObservationId: "observation-active-a", context: context(),
      }),
      store.activate({
        planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed),
        replacementObservationId: "observation-active-b", context: context(),
      }),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);

    const active = (contenders.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<UserObservation>).value;
    expect(active).toMatchObject({
      status: "active",
      confirmedByUser: true,
      validatedAt: now(),
      supersedesObservationId: proposed.observationId,
    });
    await expect(store.resolveForFact("plan-a", proposed.observationId)).resolves.toBeNull();
    await expect(store.resolveForFact("plan-a", active.observationId)).resolves.toMatchObject({
      observation: { observationId: active.observationId },
    });
    await expect(store.resolveForFact("plan-b", active.observationId)).resolves.toBeNull();

    const invalidated = await store.invalidate({
      planId: "plan-a",
      observationId: active.observationId,
      expectedHash: digest(active),
      replacementObservationId: "observation-invalidated",
      context: context(),
      invalidationReason: "placement route changed",
    });
    expect(invalidated).toMatchObject({
      status: "active",
      invalidatedAt: now(),
      invalidationReason: "placement route changed",
      supersedesObservationId: active.observationId,
    });
    await expect(store.resolveForFact("plan-a", active.observationId)).resolves.toBeNull();
    await expect(store.resolveForFact("plan-a", invalidated.observationId)).resolves.toBeNull();
  });
});
