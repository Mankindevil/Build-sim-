import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservationProjectionContext, UserObservation } from "../src/observations/contracts";
import { ObservationRepository } from "../src/observations/repository";
import { canonicalJson } from "../src/plans/canonical";

const roots: string[] = [];
const sha = (letter: string): string => letter.repeat(64);
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

function proposal(): UserObservation {
  const material = {
    observationId: "observation-plan-a-proposal",
    planId: "plan-a",
    subjectRef: { kind: "placement" as const, placementId: "case-placement-a" },
    fieldId: "physical.clearance" as const,
    value: 5,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: false,
    observedAgainstConfigHash: sha("a"),
    subjectRevisionHash: sha("b"),
    capturedAt: "2026-08-30T00:00:00.000Z",
    status: "proposed" as const,
  };
  return { ...material, contentHash: digest(material) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 user observation plan isolation", () => {
  it("never exposes or snapshots plan A authority through plan B", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-observation-plan-isolation-"));
    roots.push(root);
    const context: ObservationProjectionContext = {
      planId: "plan-a",
      subjectExists: true,
      currentConfigHash: sha("a"),
      currentSubjectRevisionHash: sha("b"),
    };
    const repository = new ObservationRepository({
      root,
      now: () => "2026-08-30T00:01:00.000Z",
      attachments: { hasAvailable: async () => false },
      projectionContextForObservation: (observation) => ({ ...context, planId: observation.planId }),
    });
    const proposed = proposal();
    await repository.put({ observation: proposed });
    const active = await repository.activate({
      planId: "plan-a",
      observationId: proposed.observationId,
      expectedHash: digest(proposed),
      replacementObservationId: "observation-plan-a-active",
      context,
    });

    await expect(repository.resolveForFact("plan-a", active.observationId)).resolves.toMatchObject({
      observation: { planId: "plan-a", observationId: active.observationId },
    });
    await expect(repository.resolveForFact("plan-b", active.observationId)).resolves.toBeNull();
    await expect(repository.listCurrent("plan-b")).resolves.toEqual([]);
    await expect(repository.createSnapshot("plan-b", [active.observationId])).rejects.toMatchObject({ code: "invalid_input" });

    const planASnapshot = await repository.createSnapshot("plan-a", [active.observationId]);
    expect(planASnapshot).toMatchObject({ planId: "plan-a", observationIds: [active.observationId] });
    await expect(repository.getSnapshot("plan-b", planASnapshot.snapshotId)).rejects.toMatchObject({ code: "not_found" });
  });
});
