import type { ConflictHit, OccupancyModel } from "./occupancy";
import { detectConflicts } from "./occupancy";
import type { ConflictVerdict, EvidenceLevel } from "./evidence";

export interface EngineFinding {
  id: string;
  verdict: ConflictVerdict;
  evidence: EvidenceLevel;
  message: string;
  related?: string[];
}

export interface EngineResult {
  verdict: ConflictVerdict;
  findings: EngineFinding[];
  conflicts: ConflictHit[];
}

function worst(a: ConflictVerdict, b: ConflictVerdict): ConflictVerdict {
  const rank = { ok: 0, warn: 1, bad: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** Run occupancy conflicts; adapters may append domain-specific findings. */
export function evaluateOccupancy(model: OccupancyModel, extra: EngineFinding[] = []): EngineResult {
  const conflicts = detectConflicts(model);
  const findings: EngineFinding[] = [
    ...conflicts.map((c) => ({
      id: c.id,
      verdict: c.verdict,
      evidence: c.evidence,
      message: c.message,
      related: [c.a, c.b],
    })),
    ...extra,
  ];

  let verdict: ConflictVerdict = "ok";
  for (const f of findings) verdict = worst(verdict, f.verdict);
  return { verdict, findings, conflicts };
}
