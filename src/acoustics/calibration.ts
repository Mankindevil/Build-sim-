import { normalizeAcousticSource } from "./normalize";
import type { NormalizedAcousticSource } from "./types";

export interface AcousticCalibrationObservation {
  readonly observationId: string;
  readonly planId: string;
  readonly componentInstanceId: string;
  readonly loadId: string;
  readonly rpm: { lo: number; hi: number };
  readonly soundPressureDba: number;
  readonly uncertaintyPlusMinusDba: number;
  readonly weighting: "A";
  readonly referenceDistanceM: number;
  readonly testMethodId: string;
  readonly observedAt: string;
  readonly status: "active" | "retracted";
}

/** Produces plan-local normalized sources; it never creates reusable product facts. */
export function acousticObservationSources(input: {
  readonly planId: string;
  readonly loadId: string;
  readonly testMethodId: string;
  readonly observations: readonly AcousticCalibrationObservation[];
}): { sources: NormalizedAcousticSource[]; rejectedObservationIds: string[] } {
  const sources: NormalizedAcousticSource[] = [];
  const rejectedObservationIds: string[] = [];
  for (const observation of input.observations) {
    if (!observation.observationId || !observation.componentInstanceId || !Number.isFinite(Date.parse(observation.observedAt))
      || !Number.isFinite(observation.soundPressureDba) || !Number.isFinite(observation.uncertaintyPlusMinusDba)
      || observation.uncertaintyPlusMinusDba < 0) throw new TypeError("acoustic observation invalid");
    if (observation.status !== "active" || observation.planId !== input.planId || observation.loadId !== input.loadId
      || observation.testMethodId !== input.testMethodId) {
      rejectedObservationIds.push(observation.observationId);
      continue;
    }
    sources.push(normalizeAcousticSource({
      sourceId: `observation:${observation.observationId}`,
      componentInstanceId: observation.componentInstanceId,
      soundPressureDba: {
        lo: observation.soundPressureDba - observation.uncertaintyPlusMinusDba,
        hi: observation.soundPressureDba + observation.uncertaintyPlusMinusDba,
      },
      weighting: observation.weighting,
      referenceDistanceM: observation.referenceDistanceM,
      loadId: observation.loadId,
      rpm: observation.rpm,
      testMethodId: observation.testMethodId,
      sourceRefs: [`observation:${observation.observationId}`],
      evidence: "inferred",
    }));
  }
  return {
    sources: sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    rejectedObservationIds: [...new Set(rejectedObservationIds)].sort(),
  };
}
