import type { EvidenceLevel } from "../core/evidence";

export interface NumericRange {
  readonly lo: number;
  readonly hi: number;
}

export interface ThermalProvenance {
  readonly evidence: EvidenceLevel;
  readonly sourceRefs: readonly string[];
  readonly assumptions: readonly string[];
}

export interface AirflowChamber {
  readonly chamberId: string;
  readonly label: string;
  readonly volumeLitres: number;
  readonly maximumTemperatureC: number | null;
  readonly provenance: ThermalProvenance;
}

export interface FanCurvePoint {
  readonly airflowCfm: number;
  readonly staticPressurePa: number;
  readonly rpm: number;
}

export interface FanCurve {
  readonly curveId: string;
  readonly points: readonly FanCurvePoint[];
  readonly uncertaintyFraction: number;
  readonly provenance: ThermalProvenance;
}

export type AirflowEdgeKind = "fan" | "opening" | "filter" | "radiator" | "heatsink" | "leak";

export interface AirflowEdge {
  readonly edgeId: string;
  /** null is ambient. */
  readonly fromChamberId: string | null;
  /** null is ambient. */
  readonly toChamberId: string | null;
  readonly kind: AirflowEdgeKind;
  /** Pressure drop is K·Q², with Q in CFM. */
  readonly resistancePaPerCfm2: NumericRange;
  readonly fanCurve?: FanCurve;
  readonly enabled: boolean;
  readonly provenance: ThermalProvenance;
}

export interface AirflowNetwork {
  readonly schemaVersion: "airflow-network-v1";
  readonly chambers: readonly AirflowChamber[];
  readonly edges: readonly AirflowEdge[];
}

export interface FanOperatingPoint {
  readonly schemaVersion: "fan-operating-point-v1";
  readonly edgeId: string;
  readonly airflowCfm: NumericRange;
  readonly staticPressurePa: NumericRange;
  readonly rpm: NumericRange;
  readonly evidence: EvidenceLevel;
  readonly sourceRefs: readonly string[];
  readonly assumptions: readonly string[];
}

export interface ChamberAirflowResult {
  readonly chamberId: string;
  readonly airflowCfm: NumericRange;
  readonly evidence: EvidenceLevel;
  readonly fanEdgeIds: readonly string[];
}

export interface AirflowNetworkResult {
  readonly schemaVersion: "airflow-network-result-v1";
  readonly fanOperatingPoints: readonly FanOperatingPoint[];
  readonly chambers: readonly ChamberAirflowResult[];
  readonly blockedReasonCodes: readonly string[];
  readonly assumptions: readonly string[];
}

export interface ThermalHeatSource {
  readonly sourceId: string;
  readonly componentInstanceId: string;
  readonly chamberId: string;
  readonly workloadId: string;
  readonly watts: NumericRange;
  readonly caseToAirResistanceKPerW: NumericRange;
  readonly maximumTemperatureC: number | null;
  readonly provenance: ThermalProvenance;
}

export interface ThermalEnvironmentProfile {
  readonly ambientC: NumericRange;
  readonly source: "user" | "requirement" | "model_default";
  readonly sourceRef: string;
  readonly confirmedByUser: boolean;
}

export interface ThermalChamberResult {
  readonly chamberId: string;
  readonly heatW: NumericRange;
  readonly airflowCfm: NumericRange;
  readonly outletTemperatureC: NumericRange | null;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly sourceRefs: readonly string[];
  readonly assumptions: readonly string[];
}

export interface ThermalComponentResult {
  readonly sourceId: string;
  readonly componentInstanceId: string;
  readonly chamberId: string;
  readonly temperatureC: NumericRange | null;
  readonly maximumTemperatureC: number | null;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly evidence: EvidenceLevel;
  readonly sourceRefs: readonly string[];
}

export interface ThermalNetworkEvaluation {
  readonly schemaVersion: "thermal-network-evaluation-v1";
  readonly ambientC: NumericRange;
  readonly airflow: AirflowNetworkResult;
  readonly chambers: readonly ThermalChamberResult[];
  readonly components: readonly ThermalComponentResult[];
  readonly peakTemperatureC: NumericRange | null;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly energyBalanceToleranceW: number;
  readonly energyBalanceResidualW: number;
  readonly blockedReasonCodes: readonly string[];
  readonly assumptions: readonly string[];
  readonly evidence: EvidenceLevel;
  readonly displayNotice: "规划热场插值，非 CFD、非实测";
}

export function assertRange(value: NumericRange, label: string, options: { nonnegative?: boolean } = {}): void {
  if (!Number.isFinite(value.lo) || !Number.isFinite(value.hi) || value.lo > value.hi
    || (options.nonnegative === true && value.lo < 0)) throw new TypeError(`${label} range invalid`);
}
