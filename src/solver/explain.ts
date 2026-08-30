import type { SolveResult } from "./contracts";

export interface SolverExplanation {
  schemaVersion: "solver-explanation-v1";
  status: SolveResult["status"];
  title: string;
  statements: string[];
  assumptions: string[];
  remediationIds: string[];
  globalOptimalityClaimed: false;
}

export function explainSolveResult(result: SolveResult): SolverExplanation {
  const unexplored = result.unexploredRanges ?? [];
  if (result.status === "unsat_proven") {
    return {
      schemaVersion: "solver-explanation-v1",
      status: result.status,
      title: "No whole-build candidate satisfies the proven search space",
      statements: [
        `The bounded candidate space was exhausted (${result.explored} assignment(s) evaluated).`,
        "Conflict sets are reported only where irreducibility was separately proven.",
      ],
      assumptions: ["Capability pools and every evaluation use the locked FactSnapshot."],
      remediationIds: [...result.unsatisfiedHardConstraintIds].sort(),
      globalOptimalityClaimed: false,
    };
  }
  if (result.status === "feasible_partial") {
    const searchIncomplete = unexplored.length > 0;
    return {
      schemaVersion: "solver-explanation-v1",
      status: result.status,
      title: searchIncomplete
        ? "Feasibility candidates found; search remains incomplete"
        : "Feasibility candidates found with unresolved authoritative coverage",
      statements: searchIncomplete ? [
        `${result.candidates.length} candidate(s) were found within the active limits.`,
        `${unexplored.length} deterministic search range(s) remain unexplored; these candidates are not a global optimum.`,
      ] : [
        `${result.candidates.length} candidate(s) were found after exhausting the bounded candidate space.`,
        "At least one candidate retains a residual requirement or a required domain that is blocked/not yet passing.",
      ],
      assumptions: ["A partial feasibility candidate requires authoritative revalidation before any purchase claim."],
      remediationIds: [],
      globalOptimalityClaimed: false,
    };
  }
  if (result.status === "blocked_inputs") {
    return {
      schemaVersion: "solver-explanation-v1",
      status: result.status,
      title: "The solver needs authoritative inputs before generating candidates",
      statements: ["No missing identity, safety fact, or requirement was guessed."],
      assumptions: [],
      remediationIds: [...result.unsatisfiedHardConstraintIds].sort(),
      globalOptimalityClaimed: false,
    };
  }
  return {
    schemaVersion: "solver-explanation-v1",
    status: result.status,
    title: "Bounded whole-build feasibility search completed",
    statements: [`${result.candidates.length} feasibility candidate(s) passed the currently evaluated hard domains.`],
    assumptions: ["A feasibility candidate is not yet a purchase recommendation."],
    remediationIds: [],
    globalOptimalityClaimed: false,
  };
}
