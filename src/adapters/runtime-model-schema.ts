import type { CalibrationSnapshot } from "../core/calibration";
import type { DeclaredRule, InstallTravelDecl, PreinstalledDecl } from "../core/assembly";
import type { PortDecl, PortRowDecl, RouteEdge, Waypoint } from "../core/routing";
import type { CaseAdapterManifest } from "./contracts";
import { isNfcText, isPortableId, safeRecord } from "../capabilities/validation";
import type { PartKind, ThermalNodeId } from "../core/geometry";
import type { SlotKind } from "../core/occupancy";
import type { EvidenceLevel } from "../core/evidence";
import type { CaseCapabilities, PowerProfile, ThermalProfile } from "../core/capabilities";
import { validateCaseRuntimeDocumentsRuntime } from "./runtime-model-runtime.mjs";

export type DeclarativeEvidence = "official" | "standard" | "inferred" | "unknown" | "planning";
export type DeclarativeVec2 = [number, number];
export type DeclarativeVec3 = [number, number, number];

interface Box3Document {
  c: DeclarativeVec3;
  w: number;
  h: number;
  d: number;
}

interface RuntimeFanMountDocument {
  id: string;
  geometryRole: "front" | "rear" | "left" | "right";
  label: string;
  size: 120 | 140;
  count: number;
  supportedSizes: (120 | 140)[];
  maxCountBySize: Record<string, number>;
  direction: "intake" | "exhaust";
  chamber: "upper" | "lower";
  evidence: DeclarativeEvidence;
  source: string;
}

type FanAvailabilityRule =
  | { mountId: string; kind: "selection-in"; field: string; values: unknown[] }
  | { mountId: string; kind: "psu-form-and-selection-in"; form: "ATX" | "SFX"; field: string; values: unknown[] }
  | { mountId: string; kind: "cooler-attribute-equals"; attribute: string; value: unknown };

export interface DeclarativeProfileDocument {
  caseId: string;
  trayCount: number;
  backplanePower: {
    inlets: number;
    connectors: { sataPower: number; molex: number };
    evidence: DeclarativeEvidence;
    source: string;
  };
  runtime: {
    dialect: "storage-layout-v1";
    mountPartIds: Record<string, string>;
    psuPlacements: Record<"auto" | "bottom" | "dual", Record<"ATX" | "SFX", string>>;
    fanMounts: RuntimeFanMountDocument[];
    fanAvailabilityRules: FanAvailabilityRule[];
    coolerFanAssignments: Array<{
      coolerType: string;
      radiatorMm: number;
      geometryRole: "front" | "rear" | "left" | "right";
      size: 120 | 140;
      count: number;
    }>;
    lowerChamberPolicy: {
      fanMountId: string;
      geometryRole: "front" | "rear" | "left" | "right";
      unavailableWithPsuTopologies: Array<"auto" | "bottom" | "dual">;
      effectDescription: string;
    };
  };
  lowerChamber: { backplane: { inletRowOrder: Array<"sata" | "molex"> } };
  psuLimits: { atxMaxLengthMm: number; sfxMaxLengthMm: number };
  coolerLimits: { overheadAtxMm: number; openTopMm: number };
  gpuLimits: { planningMinMm: number; publishedMaxMm: number };
  domainFindings: Array<Record<string, unknown>>;
  powerProfile: {
    boardBaseW: number;
    fanBaseW: number;
    fan120W: number;
    fan140W: number;
    dualSyncW: number;
    cpuIdleW: number;
    cpuReadW: number;
    cpuQuickSyncW: number;
    hbaW: number;
    driveSpinUpExtraW: number;
    evidence: DeclarativeEvidence;
    source: string;
  };
  thermalProfile: {
    airDensityKgM3: number;
    airCpJPerKgK: number;
    systemDerate: { lo: number; hi: number };
    passiveCfm: { lo: number; hi: number };
    evidence: DeclarativeEvidence;
    source: string;
  };
  hba: { defaultSkuId: string };
  defaults: {
    diskSkuId: string;
    bootBaySkuId: string;
    ownedNvmeSkuId: string;
    ownedNvmeQty: number;
    hbaBreakoutSkuId: string;
    slimsasCableSkuId: string;
    dualSyncSkuId: string;
    secondaryPsuSkuId: string;
  };
}

interface AnchorDocument {
  c: DeclarativeVec2;
  w: number;
  h: number;
  zRear?: number;
  zFront?: number;
}

interface FanRowDocument {
  c: DeclarativeVec3;
  frameMm: number;
  thicknessMm: number;
  xOffsets?: number[];
  zOffsets?: number[];
}

export interface DeclarativeGeometryDocument {
  caseId: string;
  envelope: { w: number; h: number; d: number };
  interior: { yFloor: number };
  deck: { y: number; thicknessMm: number; note: string };
  board: Box3Document & { topY: number; dimsLabel: string };
  socket: { c: DeclarativeVec2; w: number; h: number; d: number; keepoutMm: number; mountPitchMm: number; dimsLabel: string };
  memory: { xTwoModules: number[]; xOneModule: number[]; w: number; d: number; zCenter: number };
  m2: { slots: Array<{ id: string; c: DeclarativeVec2; note?: string }>; w: number; h: number; d: number; dimsLabel: string };
  psu: { rearUpperAtx: AnchorDocument; frontSfx: AnchorDocument; bottomSfx: AnchorDocument };
  cooler: {
    baseHeightMm: number;
    downdraftFootprintMm: number;
    towerFootprintMm: number;
    footprintBySku: Record<string, number>;
    aioPump: Box3Document;
  };
  gpu: {
    zRear: number;
    x: number;
    slotPitchMm: number;
    heightWorkstationLowMm: number;
    heightWorkstationMm: number;
    heightConsumerMm: number;
  };
  hba: { c: DeclarativeVec2; w: number; h: number; d: number; dimsLabel: string };
  trays: {
    count: number;
    pitchMm: number;
    c: DeclarativeVec3;
    bootC: DeclarativeVec3;
    drive35: { w: number; h: number; d: number };
    boot25: { w: number; h: number; d: number };
    dimsLabel: string;
  };
  trayFrame: { bars: Array<Box3Document & { id: string }>; dimsLabel: string; source: string };
  backplane: {
    pcb: Box3Document;
    inlet: Box3Document & { pitchMm: number; x0: number };
    dimsLabel: string;
    source: string;
  };
  lowerLeftWall: {
    fanBracket: Box3Document & { dimsLabel: string; source: string };
    psuRackPlate: Box3Document;
    psuRackSide: Box3Document;
    driveFanZ: number[];
    driveFanC: DeclarativeVec2;
    dimsLabel: string;
  };
  fanMounts: {
    front140: FanRowDocument;
    front120: FanRowDocument;
    rear120: FanRowDocument;
    sideRight120: FanRowDocument;
    radiator240Front: Box3Document;
    radiator120Rear: Box3Document;
  };
  externalUsbBoot: Box3Document & { dimsLabel: string };
  clearances: Array<Box3Document & {
    id: string;
    name: string;
    dimsLabel: string;
    source: string;
    note?: string;
    onlyWithGpu?: boolean;
  }>;
}

export interface DeclarativeRoutingDocument {
  caseId: string;
  ports: Array<PortDecl | PortRowDecl>;
  waypoints: Waypoint[];
  edges: RouteEdge[];
}

export interface DeclarativeAssemblyDocument {
  caseId: string;
  preinstalled: PreinstalledDecl[];
  install: InstallTravelDecl[];
  declared: DeclaredRule[];
}

export interface ValidatedDeclarativeCaseDocuments {
  profile: DeclarativeProfileDocument;
  geometry: DeclarativeGeometryDocument;
  routing: DeclarativeRoutingDocument;
  assembly: DeclarativeAssemblyDocument;
  calibration: CalibrationSnapshot;
}

export type PrimitiveSkuSelector = "case" | "board" | "cpu" | "psu" | "cooler" | "memory" | "gpu" | "disk" | "nvme" | "hba";
export type PrimitiveDimension = number | {
  source: "catalog-dimension";
  selector: PrimitiveSkuSelector;
  field: "widthMm" | "heightMm" | "lengthMm";
  fallback: number;
};
export type PrimitiveCount = number | {
  source: "selection";
  field: "diskCount" | "nvmeCount";
  fallback: number;
} | {
  source: "catalog-attribute";
  selector: PrimitiveSkuSelector;
  field: string;
  fallback: number;
};

export interface PrimitiveCaseProfileDocument {
  schemaVersion: "case-runtime-profile-primitives-v1";
  caseId: string;
  capabilities: Omit<CaseCapabilities, "caseId" | "fanMounts"> & {
    fanMounts: Array<CaseCapabilities["fanMounts"][number] & { geometryRole: "front" | "rear" | "left" | "right" }>;
  };
  powerProfile: PowerProfile;
  thermalProfile: ThermalProfile;
  defaults: {
    diskSkuId?: string;
    ownedNvmeSkuId?: string;
    ownedNvmeQty: number;
    hbaSkuId?: string;
  };
}

export interface PrimitiveCaseGeometryDocument {
  schemaVersion: "case-runtime-geometry-primitives-v1";
  caseId: string;
  envelope: { centerMm: DeclarativeVec3; sizeMm: DeclarativeVec3 };
  interior: { centerMm: DeclarativeVec3; sizeMm: DeclarativeVec3 };
  /** Part whose box represents the case instance envelope and consumes plan-scoped measurements. */
  envelopePartId: string;
  thermalDeckY: number;
  mountPartIds: Record<string, string>;
  parts: Array<{
    id: string;
    name: string;
    kind: PartKind;
    centerMm: DeclarativeVec3;
    sizeMm: [PrimitiveDimension, PrimitiveDimension, PrimitiveDimension];
    sizeEvidence: EvidenceLevel;
    anchorEvidence: EvidenceLevel;
    dimsLabel: string;
    skuSelector?: PrimitiveSkuSelector;
    repeat?: PrimitiveCount;
    repeatOffsetMm?: DeclarativeVec3;
    slotId?: string;
    mountedOn?: string;
    group?: string;
    thermalId?: ThermalNodeId;
    chamber?: "upper" | "lower";
  }>;
  slots: Array<{
    id: string;
    kind: SlotKind;
    centerMm: DeclarativeVec3;
    sizeMm: DeclarativeVec3;
    evidence: EvidenceLevel;
    exclusiveWith: string[];
  }>;
}

export interface PrimitiveCaseRoutingDocument {
  schemaVersion: "case-runtime-routing-primitives-v1";
  caseId: string;
  mode: "no-case-managed-cables";
  ports: [];
  waypoints: [];
  edges: [];
}

export interface PrimitiveCaseAssemblyDocument extends DeclarativeAssemblyDocument {
  schemaVersion: "case-runtime-assembly-primitives-v1";
}

export interface ValidatedPrimitiveCaseDocuments {
  profile: PrimitiveCaseProfileDocument;
  geometry: PrimitiveCaseGeometryDocument;
  routing: PrimitiveCaseRoutingDocument;
  assembly: PrimitiveCaseAssemblyDocument;
  calibration: CalibrationSnapshot;
}

type Schema =
  | { kind: "string"; portable?: boolean; nonempty?: boolean }
  | { kind: "number"; integer?: boolean; positive?: boolean; nonnegative?: boolean }
  | { kind: "boolean" }
  | { kind: "literal"; value: unknown }
  | { kind: "enum"; values: readonly unknown[] }
  | { kind: "tuple"; items: readonly Schema[] }
  | { kind: "array"; item: Schema; min?: number; unique?: boolean }
  | { kind: "record"; value: Schema; min?: number }
  | { kind: "object"; fields: Readonly<Record<string, Schema>>; optional?: Readonly<Record<string, Schema>> }
  | { kind: "union"; variants: readonly Schema[] }
  | { kind: "nullable"; value: Schema };

const text = (portable = false): Schema => ({ kind: "string", portable, nonempty: true });
const finite: Schema = { kind: "number" };
const positive: Schema = { kind: "number", positive: true };
const nonnegative: Schema = { kind: "number", nonnegative: true };
const positiveInteger: Schema = { kind: "number", integer: true, positive: true };
const nonnegativeInteger: Schema = { kind: "number", integer: true, nonnegative: true };
const bool: Schema = { kind: "boolean" };
const vec2: Schema = { kind: "tuple", items: [finite, finite] };
const vec3: Schema = { kind: "tuple", items: [finite, finite, finite] };
const evidence: Schema = { kind: "enum", values: ["official", "standard", "inferred", "unknown", "planning"] };
const box = (extra: Record<string, Schema> = {}, optional: Record<string, Schema> = {}): Schema => ({
  kind: "object",
  fields: { c: vec3, w: positive, h: positive, d: positive, ...extra },
  optional,
});
const metadata = {
  sizeEvidence: evidence,
  anchorEvidence: evidence,
  dimsLabel: text(),
  source: text(),
} satisfies Record<string, Schema>;

function schemaErrors(value: unknown, schema: Schema, path: string): string[] {
  const errors: string[] = [];
  if (schema.kind === "string") {
    if (!(schema.portable ? isPortableId(value) : isNfcText(value)) || (schema.nonempty && String(value).length === 0)) errors.push(`${path} invalid`);
  } else if (schema.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.integer && !Number.isSafeInteger(value))
      || (schema.positive && value <= 0) || (schema.nonnegative && value < 0)) errors.push(`${path} invalid`);
  } else if (schema.kind === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} invalid`);
  } else if (schema.kind === "literal") {
    if (value !== schema.value) errors.push(`${path} invalid`);
  } else if (schema.kind === "enum") {
    if (!schema.values.includes(value)) errors.push(`${path} invalid`);
  } else if (schema.kind === "tuple") {
    if (!Array.isArray(value) || value.length !== schema.items.length) errors.push(`${path} invalid`);
    else schema.items.forEach((entry, index) => errors.push(...schemaErrors(value[index], entry, `${path}.${index}`)));
  } else if (schema.kind === "array") {
    if (!Array.isArray(value) || value.length < (schema.min ?? 0)) errors.push(`${path} invalid`);
    else {
      value.forEach((entry, index) => errors.push(...schemaErrors(entry, schema.item, `${path}.${index}`)));
      if (schema.unique && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) errors.push(`${path} must be unique`);
    }
  } else if (schema.kind === "record") {
    const record = safeRecord(value);
    if (!record || Object.keys(record).length < (schema.min ?? 0)) errors.push(`${path} invalid`);
    else for (const [key, entry] of Object.entries(record)) {
      if (!isPortableId(key)) errors.push(`${path}.${key} key invalid`);
      errors.push(...schemaErrors(entry, schema.value, `${path}.${key}`));
    }
  } else if (schema.kind === "object") {
    const record = safeRecord(value);
    if (!record) errors.push(`${path} invalid`);
    else {
      const allowed = new Set([...Object.keys(schema.fields), ...Object.keys(schema.optional ?? {})]);
      for (const key of Object.keys(schema.fields)) if (!(key in record)) errors.push(`${path}.${key} missing`);
      for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`${path}.${key} unknown`);
      for (const [key, entry] of Object.entries(schema.fields)) if (key in record) errors.push(...schemaErrors(record[key], entry, `${path}.${key}`));
      for (const [key, entry] of Object.entries(schema.optional ?? {})) if (key in record) errors.push(...schemaErrors(record[key], entry, `${path}.${key}`));
    }
  } else if (schema.kind === "union") {
    if (!schema.variants.some((variant) => schemaErrors(value, variant, path).length === 0)) errors.push(`${path} invalid`);
  } else if (value !== null) {
    errors.push(...schemaErrors(value, schema.value, path));
  }
  return errors;
}

const profileSchema: Schema = {
  kind: "object",
  fields: {
    caseId: text(true),
    trayCount: positiveInteger,
    backplanePowerInlets: positiveInteger,
    backplanePower: {
      kind: "object",
      fields: {
        inlets: positiveInteger,
        connectors: { kind: "object", fields: { sataPower: nonnegativeInteger, molex: nonnegativeInteger } },
        oneLeadPerInlet: bool,
        daisyChainAllowed: bool,
        fillAllInlets: bool,
        requiresFanBracketRemoval: bool,
        independentPsuSupported: bool,
        evidence,
        source: text(),
        note: text(),
      },
    },
    bottomPsu: { kind: "object", fields: { form: { kind: "enum", values: ["ATX", "SFX"] }, removesLeftFanBracket: bool, evidence, source: text() } },
    fanMounts: {
      kind: "object",
      fields: {
        front: { kind: "object", fields: { size: positiveInteger, count: positiveInteger, altSize: positiveInteger, altCount: positiveInteger, radiator240: bool } },
        left: { kind: "object", fields: { size: positiveInteger, count: positiveInteger, onRemovableBracket: bool } },
        right: { kind: "object", fields: { size: positiveInteger, count: positiveInteger } },
        rear: { kind: "object", fields: { size: positiveInteger, count: positiveInteger } },
        evidence,
        source: text(),
        note: text(),
      },
    },
    runtime: {
      kind: "object",
      fields: {
        dialect: { kind: "literal", value: "storage-layout-v1" },
        mountPartIds: { kind: "record", value: text(true), min: 1 },
        psuPlacements: {
          kind: "object",
          fields: Object.fromEntries(["auto", "bottom", "dual"].map((key) => [key, { kind: "object", fields: { ATX: text(true), SFX: text(true) } }])) as Record<string, Schema>,
        },
        fanMounts: {
          kind: "array",
          min: 1,
          item: {
            kind: "object",
            fields: {
              id: text(true), geometryRole: { kind: "enum", values: ["front", "rear", "left", "right"] }, label: text(),
              size: { kind: "enum", values: [120, 140] }, count: positiveInteger,
              supportedSizes: { kind: "array", item: { kind: "enum", values: [120, 140] }, min: 1, unique: true },
              maxCountBySize: { kind: "record", value: positiveInteger, min: 1 },
              direction: { kind: "enum", values: ["intake", "exhaust"] }, chamber: { kind: "enum", values: ["upper", "lower"] },
              evidence, source: text(),
            },
          },
        },
        fanAvailabilityRules: {
          kind: "array",
          item: {
            kind: "union",
            variants: [
              { kind: "object", fields: { mountId: text(true), kind: { kind: "literal", value: "selection-in" }, field: text(true), values: { kind: "array", item: text(true), min: 1, unique: true } } },
              { kind: "object", fields: { mountId: text(true), kind: { kind: "literal", value: "psu-form-and-selection-in" }, form: { kind: "enum", values: ["ATX", "SFX"] }, field: text(true), values: { kind: "array", item: text(true), min: 1, unique: true } } },
              { kind: "object", fields: { mountId: text(true), kind: { kind: "literal", value: "cooler-attribute-equals" }, attribute: text(true), value: text(true) } },
            ],
          },
        },
        coolerFanAssignments: {
          kind: "array",
          item: { kind: "object", fields: { coolerType: text(true), radiatorMm: positiveInteger, geometryRole: { kind: "enum", values: ["front", "rear", "left", "right"] }, size: { kind: "enum", values: [120, 140] }, count: positiveInteger } },
        },
        lowerChamberPolicy: {
          kind: "object",
          fields: { fanMountId: text(true), geometryRole: { kind: "enum", values: ["front", "rear", "left", "right"] }, unavailableWithPsuTopologies: { kind: "array", item: { kind: "enum", values: ["auto", "bottom", "dual"] }, min: 1, unique: true }, effectDescription: text() },
        },
      },
    },
    lowerChamber: {
      kind: "object",
      fields: {
        backplane: { kind: "object", fields: { inletRowOrder: { kind: "array", item: { kind: "enum", values: ["sata", "molex"] }, min: 1 }, reachRequiresBracketRemoval: bool, evidence, source: text(), note: text() } },
        leftFanBracket: { kind: "object", fields: { screws: positiveInteger, carriesFans: { kind: "object", fields: { size: positiveInteger, count: positiveInteger } }, removedForBottomPsu: bool, evidence, source: text(), note: text() } },
        bottomPsuRack: { kind: "object", fields: { shippedWithCase: bool, installOrder: { kind: "array", item: text(), min: 1 }, evidence, source: text(), note: text() } },
      },
    },
    psuLimits: { kind: "object", fields: { atxMaxLengthMm: positive, sfxMaxLengthMm: positive } },
    coolerLimits: { kind: "object", fields: { overheadAtxMm: positive, openTopMm: positive } },
    gpuLimits: { kind: "object", fields: { planningMinMm: positive, publishedMaxMm: positive } },
    domainFindings: {
      kind: "array",
      item: {
        kind: "union",
        variants: [
          { kind: "object", fields: { kind: { kind: "literal", value: "placement-in" }, placements: { kind: "array", item: text(true), min: 1, unique: true }, finding: findingSchema() } },
          { kind: "object", fields: { kind: { kind: "literal", value: "boot-bay-full" }, finding: findingSchema() } },
          { kind: "object", fields: { kind: { kind: "literal", value: "selected-sku-boolean" }, attribute: text(true), value: bool, andField: text(true), andValue: text(true), finding: findingSchema() } },
          { kind: "object", fields: { kind: { kind: "literal", value: "selection-equals" }, field: text(true), value: text(true), finding: findingSchema() } },
        ],
      },
    },
    powerProfile: { kind: "object", fields: { boardBaseW: nonnegative, fanBaseW: nonnegative, fan120W: nonnegative, fan140W: nonnegative, dualSyncW: nonnegative, cpuIdleW: nonnegative, cpuReadW: nonnegative, cpuQuickSyncW: nonnegative, hbaW: nonnegative, driveSpinUpExtraW: nonnegative, evidence, source: text() } },
    thermalProfile: { kind: "object", fields: { airDensityKgM3: positive, airCpJPerKgK: positive, systemDerate: rangeSchema(), passiveCfm: rangeSchema(), evidence, source: text() } },
    hba: { kind: "object", fields: { defaultSkuId: text(true) } },
    defaults: { kind: "object", fields: { diskSkuId: text(true), bootBaySkuId: text(true), ownedNvmeSkuId: text(true), ownedNvmeQty: nonnegativeInteger, hbaBreakoutSkuId: text(true), slimsasCableSkuId: text(true), dualSyncSkuId: text(true), secondaryPsuSkuId: text(true) } },
  },
};

function findingSchema(): Schema {
  return { kind: "object", fields: { id: text(true), verdict: { kind: "enum", values: ["good", "warn", "bad"] }, evidence, message: text(), related: { kind: "array", item: text(true), min: 1, unique: true } } };
}

function rangeSchema(): Schema {
  return { kind: "object", fields: { lo: finite, hi: finite } };
}

const anchor = (face: "zRear" | "zFront", note = false): Schema => ({
  kind: "object",
  fields: { c: vec2, [face]: finite, w: positive, h: positive, ...metadata },
  optional: note ? { note: text() } : {},
});

const fanRow = (offset: "xOffsets" | "zOffsets"): Schema => ({
  kind: "object",
  fields: { c: vec3, [offset]: { kind: "array", item: finite, min: 1, unique: true }, frameMm: positive, thicknessMm: positive },
});

const geometrySchema: Schema = {
  kind: "object",
  fields: {
    caseId: text(true),
    frame: { kind: "object", fields: { unit: { kind: "literal", value: "mm" }, origin: text(), axes: { kind: "object", fields: { x: text(), y: text(), z: text() } }, evidence, note: text() } },
    envelope: { kind: "object", fields: { w: positive, h: positive, d: positive, evidence, source: text() } },
    interior: { kind: "object", fields: { baseHeightMm: nonnegative, yFloor: finite, evidence, source: text(), note: text() } },
    deck: { kind: "object", fields: { y: finite, thicknessMm: positive, anchorEvidence: evidence, sizeEvidence: evidence, source: text(), note: text() } },
    board: box({ topY: finite, ...metadata }),
    socket: { kind: "object", fields: { c: vec2, w: positive, h: positive, d: positive, keepoutMm: positive, mountPitchMm: positive, ...metadata, note: text() } },
    memory: { kind: "object", fields: { xTwoModules: { kind: "array", item: finite, min: 1, unique: true }, xOneModule: { kind: "array", item: finite, min: 1, unique: true }, w: positive, d: positive, zCenter: finite, ...metadata } },
    m2: { kind: "object", fields: { slots: { kind: "array", min: 1, item: { kind: "object", fields: { id: text(true), c: vec2 }, optional: { note: text() } } }, w: positive, h: positive, d: positive, ...metadata } },
    psu: { kind: "object", fields: { rearUpperAtx: anchor("zRear", true), frontSfx: anchor("zFront"), bottomSfx: anchor("zRear", true) } },
    cooler: { kind: "object", fields: { baseHeightMm: positive, downdraftFootprintMm: positive, towerFootprintMm: positive, footprintBySku: { kind: "record", value: positive }, aioPump: box(), ...metadata, note: text() } },
    gpu: { kind: "object", fields: { zRear: finite, x: finite, slotPitchMm: positive, heightWorkstationLowMm: positive, heightWorkstationMm: positive, heightConsumerMm: positive, ...metadata, note: text() } },
    hba: { kind: "object", fields: { c: vec2, w: positive, h: positive, d: positive, ...metadata } },
    trays: { kind: "object", fields: { count: positiveInteger, pitchMm: positive, c: vec3, bootC: vec3, drive35: boxDimensions(), boot25: boxDimensions(), ...metadata, note: text() } },
    trayFrame: { kind: "object", fields: { bars: { kind: "array", min: 1, item: box({ id: text(true) }) }, ...metadata } },
    backplane: { kind: "object", fields: { pcb: box(), inlet: box({ pitchMm: positive, x0: finite }), ...metadata } },
    lowerLeftWall: { kind: "object", fields: { fanBracket: box({ dimsLabel: text(), source: text() }), psuRackPlate: box(), psuRackSide: box(), driveFanZ: { kind: "array", item: finite, min: 1, unique: true }, driveFanC: vec2, ...metadata } },
    fanMounts: { kind: "object", fields: { front140: fanRow("xOffsets"), front120: fanRow("xOffsets"), rear120: fanRow("xOffsets"), sideRight120: fanRow("zOffsets"), radiator240Front: box(), radiator120Rear: box(), ...metadata } },
    externalUsbBoot: box({ ...metadata }),
    clearances: { kind: "array", item: box({ id: text(true), name: text(), ...metadata }, { note: text(), onlyWithGpu: bool }) },
  },
};

function boxDimensions(): Schema {
  return { kind: "object", fields: { w: positive, h: positive, d: positive } };
}

const normalPort: Schema = {
  kind: "object",
  fields: { id: text(true), onPart: text(true), face: { kind: "enum", values: ["+x", "-x", "+y", "-y", "+z", "-z"] }, offset: vec2, kind: text(true), insertionMm: positive, sectionMm: vec2, source: text() },
  optional: { whenSlot: { kind: "array", item: text(true), min: 1, unique: true } },
};
const rowPort: Schema = {
  kind: "object",
  fields: { id: text(true), onPart: text(true), face: { kind: "enum", values: ["+x", "-x", "+y", "-y", "+z", "-z"] }, offsetsAlong: { kind: "enum", values: ["x", "y", "z"] }, offsetPitchMm: positive, offsetV: finite, kind: text(true), insertionMm: positive, sectionMm: vec2, source: text() },
};
const routingSchema: Schema = {
  kind: "object",
  fields: {
    caseId: text(true),
    frame: { kind: "object", fields: { note: text(), anchorEvidence: evidence } },
    ports: { kind: "array", min: 1, item: { kind: "union", variants: [normalPort, rowPort] } },
    waypoints: { kind: "array", min: 1, item: { kind: "object", fields: { id: text(true), c: vec3, kind: { kind: "enum", values: ["free", "channel", "deck_opening"] }, apertureMm: positive, source: text() } } },
    edges: { kind: "array", min: 1, item: { kind: "object", fields: { from: text(true), to: text(true), note: text() } } },
  },
};

const assemblySchema: Schema = {
  kind: "object",
  fields: {
    caseId: text(true),
    frame: { kind: "object", fields: { note: text(), anchorEvidence: evidence } },
    preinstalled: { kind: "array", item: { kind: "object", fields: { match: text(true), removable: bool, source: text() } } },
    install: { kind: "array", item: { kind: "object", fields: { match: text(true), axis: { kind: "enum", values: ["+x", "-x", "+y", "-y", "+z", "-z"] }, travelMm: { kind: "union", variants: [positive, { kind: "literal", value: "self" }] }, source: text() } } },
    declared: { kind: "array", item: { kind: "object", fields: { id: text(true), before: text(true), after: text(true), evidence, source: text() } } },
  },
};

const nullableFinite: Schema = { kind: "nullable", value: finite };
const scalarCalibration = (unit: string): Schema => ({ kind: "object", fields: { value: nullableFinite, evidence, unit: { kind: "literal", value: unit }, source: { kind: "nullable", value: text() } } });
const rangeCalibration = (unit: string): Schema => ({ kind: "object", fields: { min: nullableFinite, max: nullableFinite, evidence, unit: { kind: "literal", value: unit }, source: { kind: "nullable", value: text() } } });
const calibrationSchema: Schema = {
  kind: "object",
  fields: {
    schemaVersion: { kind: "literal", value: "1.0.0" }, calibrationVersion: text(true), caseId: text(true), capturedAt: { kind: "nullable", value: text() }, source: text(),
    provenance: { kind: "array", item: text(true), unique: true },
    wallPowerW: scalarCalibration("W"), smartTemperatureC: rangeCalibration("°C"), cpuTemperatureC: rangeCalibration("°C"), gpuTemperatureC: rangeCalibration("°C"), noiseDba: scalarCalibration("dBA"),
    fanCurve: { kind: "object", fields: { mode: { kind: "nullable", value: text(true) }, rpm: nullableFinite, cfm: nullableFinite, evidence, source: { kind: "nullable", value: text() } } },
  },
};

const evidenceLevel: Schema = { kind: "enum", values: ["official", "standard", "inferred", "unknown"] };
const nullableNonnegative: Schema = { kind: "nullable", value: nonnegative };
const primitiveFanMountSchema: Schema = {
  kind: "object",
  fields: {
    id: text(true), label: text(), size: { kind: "enum", values: [120, 140] }, count: positiveInteger,
    supportedSizes: { kind: "array", item: { kind: "enum", values: [120, 140] }, min: 1, unique: true },
    maxCountBySize: { kind: "record", value: positiveInteger, min: 1 }, direction: { kind: "enum", values: ["intake", "exhaust"] },
    chamber: { kind: "enum", values: ["upper", "lower"] }, evidence: evidenceLevel, source: text(),
    geometryRole: { kind: "enum", values: ["front", "rear", "left", "right"] },
  },
};
const primitiveProfileSchema: Schema = {
  kind: "object",
  fields: {
    schemaVersion: { kind: "literal", value: "case-runtime-profile-primitives-v1" }, caseId: text(true),
    capabilities: {
      kind: "object",
      fields: {
        trayCount: nonnegativeInteger,
        backplane: { kind: "object", fields: { sataPowerInlets: nonnegativeInteger, molexInlets: nonnegativeInteger, evidence: evidenceLevel } },
        fanMounts: { kind: "array", item: primitiveFanMountSchema },
        psuLimits: { kind: "object", fields: { atxMaxLengthMm: nullableNonnegative, sfxMaxLengthMm: nullableNonnegative } },
        coolerLimits: { kind: "object", fields: { overheadAtxMm: nullableNonnegative, openTopMm: nullableNonnegative } },
        gpuLimits: { kind: "object", fields: { planningMinMm: nullableNonnegative, publishedMaxMm: nullableNonnegative } },
      },
    },
    powerProfile: { kind: "object", fields: { boardBaseW: nullableNonnegative, fanBaseW: nullableNonnegative, fan120W: nullableNonnegative, fan140W: nullableNonnegative, dualSyncW: nullableNonnegative, cpuIdleW: nullableNonnegative, cpuReadW: nullableNonnegative, cpuQuickSyncW: nullableNonnegative, hbaW: nullableNonnegative, driveSpinUpExtraW: nullableNonnegative, evidence: evidenceLevel, source: text() } },
    thermalProfile: { kind: "object", fields: { airDensityKgM3: positive, airCpJPerKgK: positive, systemDerate: rangeSchema(), passiveCfm: rangeSchema(), evidence: evidenceLevel } },
    defaults: { kind: "object", fields: { ownedNvmeQty: nonnegativeInteger }, optional: { diskSkuId: text(true), ownedNvmeSkuId: text(true), hbaSkuId: text(true) } },
  },
};
const primitiveSelector: Schema = { kind: "enum", values: ["case", "board", "cpu", "psu", "cooler", "memory", "gpu", "disk", "nvme", "hba"] };
const primitiveDimensionSchema: Schema = {
  kind: "union",
  variants: [positive, { kind: "object", fields: { source: { kind: "literal", value: "catalog-dimension" }, selector: primitiveSelector, field: { kind: "enum", values: ["widthMm", "heightMm", "lengthMm"] }, fallback: positive } }],
};
const primitiveCountSchema: Schema = {
  kind: "union",
  variants: [
    nonnegativeInteger,
    { kind: "object", fields: { source: { kind: "literal", value: "selection" }, field: { kind: "enum", values: ["diskCount", "nvmeCount"] }, fallback: nonnegativeInteger } },
    { kind: "object", fields: { source: { kind: "literal", value: "catalog-attribute" }, selector: primitiveSelector, field: text(true), fallback: nonnegativeInteger } },
  ],
};
const primitiveGeometrySchema: Schema = {
  kind: "object",
  fields: {
    schemaVersion: { kind: "literal", value: "case-runtime-geometry-primitives-v1" }, caseId: text(true),
    envelope: { kind: "object", fields: { centerMm: vec3, sizeMm: { kind: "tuple", items: [positive, positive, positive] } } },
    interior: { kind: "object", fields: { centerMm: vec3, sizeMm: { kind: "tuple", items: [positive, positive, positive] } } },
    envelopePartId: text(true),
    thermalDeckY: finite,
    mountPartIds: { kind: "record", value: text(true) },
    parts: {
      kind: "array", min: 1,
      item: {
        kind: "object",
        fields: {
          id: text(true), name: text(), kind: { kind: "enum", values: ["deck", "board", "cpu", "ram", "m2", "psu", "cooler", "radiator", "gpu", "hba", "drive", "empty", "boot", "usb", "fan", "chassis", "pcb", "connector", "reserve", "clearance"] },
          centerMm: vec3, sizeMm: { kind: "tuple", items: [primitiveDimensionSchema, primitiveDimensionSchema, primitiveDimensionSchema] },
          sizeEvidence: evidenceLevel, anchorEvidence: evidenceLevel, dimsLabel: text(),
        },
        optional: {
          skuSelector: primitiveSelector, repeat: primitiveCountSchema, repeatOffsetMm: vec3,
          slotId: text(true), mountedOn: text(true), group: text(true), thermalId: { kind: "enum", values: ["cpu", "gpu", "hba", "psu", "hdd"] }, chamber: { kind: "enum", values: ["upper", "lower"] },
        },
      },
    },
    slots: {
      kind: "array",
      item: { kind: "object", fields: { id: text(true), kind: { kind: "enum", values: ["drive_bay", "pcie", "fan", "psu", "radiator", "cooler", "memory", "m2", "cable_clearance", "structure"] }, centerMm: vec3, sizeMm: { kind: "tuple", items: [positive, positive, positive] }, evidence: evidenceLevel, exclusiveWith: { kind: "array", item: text(true), unique: true } } },
    },
  },
};
const primitiveRoutingSchema: Schema = {
  kind: "object",
  fields: { schemaVersion: { kind: "literal", value: "case-runtime-routing-primitives-v1" }, caseId: text(true), mode: { kind: "literal", value: "no-case-managed-cables" }, ports: { kind: "array", item: { kind: "union", variants: [] } }, waypoints: { kind: "array", item: { kind: "union", variants: [] } }, edges: { kind: "array", item: { kind: "union", variants: [] } } },
};
const primitiveAssemblySchema: Schema = {
  kind: "object",
  fields: {
    schemaVersion: { kind: "literal", value: "case-runtime-assembly-primitives-v1" }, caseId: text(true),
    preinstalled: { kind: "array", item: { kind: "object", fields: { match: text(true), removable: bool, source: text() } } },
    install: { kind: "array", item: { kind: "object", fields: { match: text(true), axis: { kind: "enum", values: ["+x", "-x", "+y", "-y", "+z", "-z"] }, travelMm: { kind: "union", variants: [positive, { kind: "literal", value: "self" }] }, source: text() } } },
    declared: { kind: "array", item: { kind: "object", fields: { id: text(true), before: text(true), after: text(true), evidence: evidenceLevel, source: text() } } },
  },
};

function primitiveDocumentErrors(manifest: CaseAdapterManifest | null, documents: Record<string, unknown>): string[] {
  const errors = [
    ...schemaErrors(documents.profile, primitiveProfileSchema, "runtime model profile"),
    ...schemaErrors(documents.geometry, primitiveGeometrySchema, "runtime model geometry"),
    ...schemaErrors(documents.routing, primitiveRoutingSchema, "runtime model routing"),
    ...schemaErrors(documents.assembly, primitiveAssemblySchema, "runtime model assembly"),
    ...schemaErrors(documents.calibration, calibrationSchema, "runtime model calibration"),
  ];
  if (errors.length) return errors;
  const typed = documents as unknown as ValidatedPrimitiveCaseDocuments;
  const caseId = typed.profile.caseId;
  if ([typed.geometry.caseId, typed.routing.caseId, typed.assembly.caseId, typed.calibration.caseId].some((value) => value !== caseId)
    || (manifest && caseId !== manifest.identity.skuId)) errors.push("runtime model primitive exact case identity mismatch");
  const partIds = typed.geometry.parts.map((part) => part.id.replaceAll("{index}", "1"));
  if (new Set(partIds).size !== partIds.length) errors.push("runtime model primitive part IDs duplicate");
  if (!partIds.includes(typed.geometry.envelopePartId)) errors.push("runtime model primitive envelope part reference invalid");
  const slotIds = new Set(typed.geometry.slots.map((slot) => slot.id));
  if (slotIds.size !== typed.geometry.slots.length) errors.push("runtime model primitive slot IDs duplicate");
  for (const slot of typed.geometry.slots) if (slot.exclusiveWith.some((id) => id === slot.id || !slotIds.has(id))) errors.push(`runtime model primitive slot ${slot.id} exclusive reference invalid`);
  const manifestMounts = new Set(manifest?.mounts.map((mount) => mount.mountId) ?? []);
  for (const [mountId, partId] of Object.entries(typed.geometry.mountPartIds)) {
    if (manifest && !manifestMounts.has(mountId)) errors.push(`runtime model primitive mount ${mountId} not in manifest`);
    if (!partIds.includes(partId)) errors.push(`runtime model primitive mount ${mountId} part reference invalid`);
  }
  if (!insideEnvelope(typed.geometry.interior.centerMm, typed.geometry.interior.sizeMm, {
    w: typed.geometry.envelope.sizeMm[0], h: typed.geometry.envelope.sizeMm[1], d: typed.geometry.envelope.sizeMm[2],
  })) errors.push("runtime model primitive interior exceeds envelope");
  for (const part of typed.geometry.parts) {
    const size = part.sizeMm.map((dimension) => typeof dimension === "number" ? dimension : dimension.fallback) as DeclarativeVec3;
    if (!insideEnvelope(part.centerMm, size, { w: typed.geometry.envelope.sizeMm[0], h: typed.geometry.envelope.sizeMm[1], d: typed.geometry.envelope.sizeMm[2] })) {
      errors.push(`runtime model primitive part ${part.id} fallback envelope exceeds case`);
    }
  }
  const fanIds = new Set(typed.profile.capabilities.fanMounts.map((mount) => mount.id));
  if (fanIds.size !== typed.profile.capabilities.fanMounts.length) errors.push("runtime model primitive fan mount IDs duplicate");
  for (const fan of typed.profile.capabilities.fanMounts) {
    if (fan.supportedSizes.some((size) => fan.maxCountBySize[size] === undefined)) errors.push(`runtime model primitive fan ${fan.id} size/count map mismatch`);
  }
  return errors;
}

function uniqueIds(values: readonly unknown[], field: string, path: string): string[] {
  const ids = values.map((entry) => safeRecord(entry)?.[field]);
  return ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length ? [] : [`${path} IDs invalid or duplicate`];
}

function insideEnvelope(c: readonly number[], size: readonly number[], envelope: DeclarativeGeometryDocument["envelope"]): boolean {
  const limits = [envelope.w, envelope.h, envelope.d];
  return [0, 1, 2].every((axis) => Math.abs(c[axis] ?? Infinity) + (size[axis] ?? Infinity) / 2 <= (limits[axis] ?? 0) / 2 + 1e-9);
}

function modelCrossReferenceErrors(
  manifest: CaseAdapterManifest,
  documents: ValidatedDeclarativeCaseDocuments,
): string[] {
  const { profile, geometry, routing, assembly } = documents;
  const errors: string[] = [];
  if ([profile.caseId, geometry.caseId, routing.caseId, assembly.caseId, documents.calibration.caseId]
    .some((caseId) => caseId !== manifest.identity.skuId)) errors.push("runtime model document exact case identity mismatch");
  if (profile.trayCount !== geometry.trays.count || profile.backplanePower.inlets !== profile.lowerChamber.backplane.inletRowOrder.length) {
    errors.push("runtime model tray/backplane counts do not close across documents");
  }
  const inletOrder = profile.lowerChamber.backplane.inletRowOrder;
  if (inletOrder.some((connector) => connector !== "sata" && connector !== "molex")
    || inletOrder.filter((connector) => connector === "sata").length !== profile.backplanePower.connectors.sataPower
    || inletOrder.filter((connector) => connector === "molex").length !== profile.backplanePower.connectors.molex) {
    errors.push("runtime model backplane inlet order does not close to connector counts");
  }
  const manifestMounts = new Set(manifest.mounts.map((mount) => mount.mountId));
  for (const mountId of Object.keys(profile.runtime.mountPartIds)) if (!manifestMounts.has(mountId)) errors.push(`runtime model mountPartIds references unknown manifest mount ${mountId}`);
  const fanIds = new Set(profile.runtime.fanMounts.map((mount) => mount.id));
  errors.push(...uniqueIds(profile.runtime.fanMounts, "id", "runtime model fanMounts"));
  if (new Set(profile.runtime.fanMounts.map((mount) => mount.geometryRole)).size !== profile.runtime.fanMounts.length) errors.push("runtime model fan geometry roles must be unique");
  for (const mount of profile.runtime.fanMounts) {
    if (mount.supportedSizes.some((size) => mount.maxCountBySize[String(size)] === undefined)
      || Object.keys(mount.maxCountBySize).some((size) => !mount.supportedSizes.includes(Number(size) as 120 | 140))) {
      errors.push(`runtime model fan ${mount.id} size/count map mismatch`);
    }
  }
  for (const rule of profile.runtime.fanAvailabilityRules) if (!fanIds.has(rule.mountId)) errors.push(`runtime model fan rule references unknown mount ${rule.mountId}`);
  if (!fanIds.has(profile.runtime.lowerChamberPolicy.fanMountId)
    || profile.runtime.fanMounts.find((mount) => mount.id === profile.runtime.lowerChamberPolicy.fanMountId)?.geometryRole !== profile.runtime.lowerChamberPolicy.geometryRole) {
    errors.push("runtime model lower chamber policy fan reference mismatch");
  }
  const allowedPlacements = new Set(["rearUpperAtx", "frontSfx", "bottomSfx", "rearUpperAtx+bottomSfx", "frontSfx+bottomSfx", "invalidAtxBottom"]);
  for (const mapping of Object.values(profile.runtime.psuPlacements)) for (const placement of Object.values(mapping)) if (!allowedPlacements.has(placement)) errors.push("runtime model PSU placement token invalid");
  errors.push(...uniqueIds(geometry.m2.slots, "id", "runtime model M.2 slots"));
  errors.push(...uniqueIds(geometry.trayFrame.bars, "id", "runtime model tray frame bars"));
  errors.push(...uniqueIds(geometry.clearances, "id", "runtime model clearances"));
  const staticBoxes: Array<{ id: string; c: DeclarativeVec3; size: DeclarativeVec3 }> = [
    { id: "board", c: geometry.board.c, size: [geometry.board.w, geometry.board.h, geometry.board.d] },
    ...geometry.trayFrame.bars.map((entry) => ({ id: `trayFrame.${entry.id}`, c: entry.c, size: [entry.w, entry.h, entry.d] as DeclarativeVec3 })),
    { id: "backplane.pcb", c: geometry.backplane.pcb.c, size: [geometry.backplane.pcb.w, geometry.backplane.pcb.h, geometry.backplane.pcb.d] },
    { id: "lowerLeftWall.fanBracket", c: geometry.lowerLeftWall.fanBracket.c, size: [geometry.lowerLeftWall.fanBracket.w, geometry.lowerLeftWall.fanBracket.h, geometry.lowerLeftWall.fanBracket.d] },
    { id: "lowerLeftWall.psuRackPlate", c: geometry.lowerLeftWall.psuRackPlate.c, size: [geometry.lowerLeftWall.psuRackPlate.w, geometry.lowerLeftWall.psuRackPlate.h, geometry.lowerLeftWall.psuRackPlate.d] },
    { id: "lowerLeftWall.psuRackSide", c: geometry.lowerLeftWall.psuRackSide.c, size: [geometry.lowerLeftWall.psuRackSide.w, geometry.lowerLeftWall.psuRackSide.h, geometry.lowerLeftWall.psuRackSide.d] },
    ...geometry.clearances.map((entry) => ({ id: entry.id, c: entry.c, size: [entry.w, entry.h, entry.d] as DeclarativeVec3 })),
  ];
  for (const entry of staticBoxes) if (!insideEnvelope(entry.c, entry.size, geometry.envelope)) errors.push(`runtime model geometry ${entry.id} exceeds envelope`);
  if (geometry.interior.yFloor < -geometry.envelope.h / 2 || geometry.interior.yFloor >= geometry.deck.y
    || geometry.deck.y >= geometry.envelope.h / 2) errors.push("runtime model interior/deck bounds invalid");
  const waypointIds = new Set(routing.waypoints.map((waypoint) => waypoint.id));
  errors.push(...uniqueIds(routing.waypoints, "id", "runtime model waypoints"));
  for (const waypoint of routing.waypoints) if (!insideEnvelope(waypoint.c, [0, 0, 0], geometry.envelope)) errors.push(`runtime model waypoint ${waypoint.id} exceeds envelope`);
  const edgeIds = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  for (const edge of routing.edges) {
    if (!waypointIds.has(edge.from) || !waypointIds.has(edge.to) || edge.from === edge.to) errors.push("runtime model routing edge reference invalid");
    const edgeId = [edge.from, edge.to].sort().join("\0");
    if (edgeIds.has(edgeId)) errors.push("runtime model routing edge duplicate");
    edgeIds.add(edgeId);
    const neighbors = adjacency.get(edge.from) ?? new Set<string>();
    neighbors.add(edge.to);
    adjacency.set(edge.from, neighbors);
    const reverse = adjacency.get(edge.to) ?? new Set<string>();
    reverse.add(edge.from);
    adjacency.set(edge.to, reverse);
  }
  if (waypointIds.size) {
    const visited = new Set<string>();
    const pending = [waypointIds.values().next().value as string];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...adjacency.get(current) ?? []);
    }
    if (visited.size !== waypointIds.size) errors.push("runtime model routing waypoint graph is disconnected");
  }
  const allowedPartRefs = new Set(["board", "psu", "backplane.inlet", "backplane.pcb", "hba", "gpu"]);
  const portVariants = new Set<string>();
  for (const port of routing.ports) {
    if (!allowedPartRefs.has(port.onPart)) errors.push(`runtime model port ${port.id} references unsupported part role`);
    const slots = "whenSlot" in port ? [...(port.whenSlot ?? [])].sort().join(",") : "row";
    const variant = `${port.id}\0${port.face}\0${slots}`;
    if (portVariants.has(variant)) errors.push(`runtime model port ${port.id} duplicate variant`);
    portVariants.add(variant);
  }
  const requiredPortIds = ["port.board.atx24", "port.board.eps", "port.board.sata", "port.board.slimsas", "port.backplane.power", "port.backplane.data"];
  const portIds = new Set(routing.ports.map((port) => port.id));
  for (const id of requiredPortIds) if (!portIds.has(id)) errors.push(`runtime model required semantic port ${id} missing`);
  errors.push(...uniqueIds(assembly.preinstalled, "match", "runtime model preinstalled declarations"));
  errors.push(...uniqueIds(assembly.install, "match", "runtime model install declarations"));
  errors.push(...uniqueIds(assembly.declared, "id", "runtime model declared assembly rules"));
  const directed = new Map<string, Set<string>>();
  for (const rule of assembly.declared) {
    const targets = directed.get(rule.before) ?? new Set<string>();
    targets.add(rule.after);
    directed.set(rule.before, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of directed.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  if ([...directed.keys()].some(visit)) errors.push("runtime model assembly declarations contain a dependency cycle");
  return errors;
}

export function validateDeclarativeCaseRuntimeDocuments(
  manifest: CaseAdapterManifest | null,
  value: unknown,
): string[] {
  return validateCaseRuntimeDocumentsRuntime(value, manifest);
}

export function asValidatedDeclarativeCaseDocuments(value: unknown): ValidatedDeclarativeCaseDocuments {
  return value as ValidatedDeclarativeCaseDocuments;
}

export function isPrimitiveCaseRuntimeDocuments(value: unknown): value is ValidatedPrimitiveCaseDocuments {
  const documents = safeRecord(value);
  return safeRecord(documents?.profile)?.schemaVersion === "case-runtime-profile-primitives-v1";
}

export function asValidatedPrimitiveCaseDocuments(value: unknown): ValidatedPrimitiveCaseDocuments {
  return value as ValidatedPrimitiveCaseDocuments;
}
