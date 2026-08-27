export type FixtureVerdict = "pass" | "fail" | "blocked";

export interface NegativeCompatibilityFixtureCase {
  caseId: string;
  domain: string;
  facts: Record<string, unknown>;
}
function strings(facts: Record<string, unknown>, ...keys: string[]): string[] {
  return keys.map((key) => typeof facts[key] === "string" ? facts[key] as string : "");
}

/**
 * Independent U0 fixture oracle.
 *
 * This freezes the meaning of negative input values without reading the same
 * fixture's expected verdict. U6 must replace it with the authoritative
 * fact/capability evaluator before universal runtime coverage is claimed.
 */
export function evaluateNegativeCompatibilityFixture(input: NegativeCompatibilityFixtureCase): FixtureVerdict {
  const facts = input.facts;
  switch (input.caseId) {
    case "socket-mismatch": {
      const [cpuSocket, boardSocket] = strings(facts, "cpuSocket", "boardSocket");
      return !cpuSocket || !boardSocket ? "blocked" : cpuSocket === boardSocket ? "pass" : "fail";
    }
    case "bios-below-minimum": {
      const [current, minimum] = strings(facts, "current", "minimum");
      return !current || !minimum ? "blocked" : current === minimum ? "pass" : "fail";
    }
    case "ddr-mismatch": {
      const [dimmType, boardType] = strings(facts, "dimmType", "boardType");
      return !dimmType || !boardType ? "blocked" : dimmType === boardType ? "pass" : "fail";
    }
    case "psu-connector-missing": {
      const [required, available] = strings(facts, "required", "available");
      return !required || !available ? "blocked" : required === available ? "pass" : "fail";
    }
    case "pcie-lane-shortage":
      return typeof facts.requiredLanes !== "number" || typeof facts.availableLanes !== "number"
        ? "blocked"
        : facts.requiredLanes <= facts.availableLanes ? "pass" : "fail";
    case "case-clearance-interference":
      return typeof facts.requiredMm !== "number" || typeof facts.availableMm !== "number" || typeof facts.uncertaintyMm !== "number"
        ? "blocked"
        : facts.requiredMm <= facts.availableMm ? "pass" : "fail";
    case "no-boot-device":
      return !Array.isArray(facts.bootDevices) ? "blocked" : facts.bootDevices.length > 0 ? "pass" : "fail";
    case "no-display-path":
      return facts.integratedGraphics === true || (Array.isArray(facts.boardVideoPorts) && facts.boardVideoPorts.length > 0) || facts.gpu !== "none"
        ? "pass"
        : facts.integratedGraphics === false && Array.isArray(facts.boardVideoPorts) ? "fail" : "blocked";
    case "missing-nic-driver":
      return !Array.isArray(facts.driverRefs) ? "blocked" : facts.driverRefs.length > 0 ? "pass" : "blocked";
    case "wrong-modular-cable": {
      const [psuFamily, cableFamily] = strings(facts, "psuFamily", "cableFamily");
      return !psuFamily || !cableFamily ? "blocked" : psuFamily === cableFamily ? "pass" : "fail";
    }
    case "12v2x6-bend":
      return typeof facts.bendDistanceMm !== "number" || typeof facts.minimumBendDistanceMm !== "number"
        ? "blocked"
        : facts.bendDistanceMm >= facts.minimumBendDistanceMm ? "pass" : "fail";
    case "unknown-safety-field": {
      const [pinout, cableFamily] = strings(facts, "psuPinout", "cableFamily");
      return !pinout || !cableFamily || pinout === "unknown" || cableFamily === "unknown" ? "blocked" : "pass";
    }
    default:
      throw new TypeError(`Unknown negative compatibility fixture case: ${input.caseId}`);
  }
}
