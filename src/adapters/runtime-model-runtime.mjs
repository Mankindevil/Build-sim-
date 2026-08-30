import { verifyCaseAdapterManifestRuntime } from "./case-manifest-runtime.mjs";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

const HASH = /^[a-f0-9]{64}$/;
const MODEL_FIELDS = [
  "schemaVersion", "runtimeId", "runtimeVersion", "interpreterId", "authorityStatus",
  "authorityRefs", "identity", "manifestHash", "documents", "sourceRefs",
];
const DOCUMENT_FIELDS = ["profile", "geometry", "routing", "assembly", "calibration"];

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional = []) {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function nfc(value, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function portable(value) { return nfc(value) && value.length <= 256 && !/\s/u.test(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function positive(value) { return finite(value) && value > 0; }
function nonnegative(value) { return finite(value) && value >= 0; }
function positiveInt(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeInt(value) { return Number.isSafeInteger(value) && value >= 0; }
function unique(values) { return new Set(values.map((value) => JSON.stringify(value))).size === values.length; }
function uniqueBy(values, field) { return new Set(values.map((value) => value?.[field])).size === values.length; }
function ids(value, allowEmpty = false) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(portable) && unique(value);
}
function sorted(values) { return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0); }

function canonical(value, atRoot = true, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite runtime model number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if ((!object(value) && !Array.isArray(value)) || ancestors.has(value)) throw new TypeError("non-canonical runtime model value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse runtime model array");
      return `[${value.map((item) => canonical(item, false, ancestors)).join(",")}]`;
    }
    return `{${Object.entries(value)
      .filter(([key]) => !(atRoot && key === "contentHash"))
      .map(([key, child]) => [key.normalize("NFC"), child])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, false, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

function canonicalValueErrors(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || finite(value)) return [];
  if (typeof value === "string") return nfc(value, true) ? [] : [`${path} contains invalid or non-NFC text`];
  if ((!object(value) && !Array.isArray(value)) || ancestors.has(value)) return [`${path} is not canonical JSON`];
  ancestors.add(value);
  const errors = [];
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) errors.push(`${path} is a sparse array`);
      value.forEach((child, index) => errors.push(...canonicalValueErrors(child, `${path}.${index}`, ancestors)));
    } else {
      const normalized = new Set();
      for (const [key, child] of Object.entries(value)) {
        if (!nfc(key, true) || normalized.has(key.normalize("NFC"))) errors.push(`${path}.${key} key is invalid or non-canonical`);
        normalized.add(key.normalize("NFC"));
        errors.push(...canonicalValueErrors(child, `${path}.${key}`, ancestors));
      }
    }
  } finally { ancestors.delete(value); }
  return errors;
}

function modelMaterial(value) {
  if (!object(value)) throw new TypeError("runtime model material must be an object");
  const material = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentHash"));
  if (Array.isArray(material.sourceRefs)) material.sourceRefs = sorted(material.sourceRefs);
  return material;
}

export function caseRuntimeModelCanonicalBytesRuntime(value) {
  try { return canonical(modelMaterial(value)); } catch { return null; }
}

export function caseRuntimeModelContentHashRuntime(value) {
  try {
    const preimage = [
      "buildsim", "hash-spec-v1", "artifact.adapter-snapshot", "1.0.0",
      canonical(modelMaterial(value)),
    ].join("\0");
    return sha256Utf8Runtime(preimage);
  } catch { return null; }
}

// A compact schema algebra keeps the pure-JS verifier exact without depending
// on TypeScript erasure or a package that may not be present during restore.
const S = (portableText = false) => ({ k: "s", portableText });
const N = { k: "n" }; const POS = { k: "n", positive: true }; const NN = { k: "n", nonnegative: true };
const PI = { k: "n", positive: true, integer: true }; const NI = { k: "n", nonnegative: true, integer: true };
const B = { k: "b" };
const L = (value) => ({ k: "l", value });
const E = (...values) => ({ k: "e", values });
const T = (...items) => ({ k: "t", items });
const A = (item, options = {}) => ({ k: "a", item, ...options });
const R = (value, options = {}) => ({ k: "r", value, ...options });
const O = (fields, optional = {}) => ({ k: "o", fields, optional });
const U = (...variants) => ({ k: "u", variants });
const Q = (value) => ({ k: "q", value });

function schemaErrors(value, schema, path) {
  if (schema.k === "s") return (schema.portableText ? portable(value) : nfc(value)) ? [] : [`${path} invalid`];
  if (schema.k === "n") return finite(value) && (!schema.integer || Number.isSafeInteger(value))
    && (!schema.positive || value > 0) && (!schema.nonnegative || value >= 0) ? [] : [`${path} invalid`];
  if (schema.k === "b") return typeof value === "boolean" ? [] : [`${path} invalid`];
  if (schema.k === "l") return value === schema.value ? [] : [`${path} invalid`];
  if (schema.k === "e") return schema.values.includes(value) ? [] : [`${path} invalid`];
  if (schema.k === "t") {
    if (!Array.isArray(value) || value.length !== schema.items.length) return [`${path} invalid`];
    return schema.items.flatMap((entry, index) => schemaErrors(value[index], entry, `${path}.${index}`));
  }
  if (schema.k === "a") {
    if (!Array.isArray(value) || value.length < (schema.min ?? 0)) return [`${path} invalid`];
    const errors = value.flatMap((entry, index) => schemaErrors(entry, schema.item, `${path}.${index}`));
    if (schema.unique && !unique(value)) errors.push(`${path} must be unique`);
    return errors;
  }
  if (schema.k === "r") {
    if (!object(value) || Object.keys(value).length < (schema.min ?? 0)) return [`${path} invalid`];
    return Object.entries(value).flatMap(([key, entry]) => portable(key)
      ? schemaErrors(entry, schema.value, `${path}.${key}`) : [`${path}.${key} key invalid`]);
  }
  if (schema.k === "o") {
    if (!object(value)) return [`${path} invalid`];
    const required = Object.keys(schema.fields); const optional = Object.keys(schema.optional);
    const errors = [];
    for (const key of required) if (!(key in value)) errors.push(`${path}.${key} missing`);
    for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) errors.push(`${path}.${key} unknown`);
    for (const [key, child] of Object.entries(schema.fields)) if (key in value) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
    for (const [key, child] of Object.entries(schema.optional)) if (key in value) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
    return errors;
  }
  if (schema.k === "u") return schema.variants.some((entry) => schemaErrors(value, entry, path).length === 0) ? [] : [`${path} invalid`];
  return value === null ? [] : schemaErrors(value, schema.value, path);
}

const V2 = T(N, N); const V3 = T(N, N, N);
const EVIDENCE = E("official", "standard", "inferred", "unknown", "planning");
const RUNTIME_EVIDENCE = E("official", "standard", "inferred", "unknown");
const RANGE = O({ lo: N, hi: N });
const META = { sizeEvidence: EVIDENCE, anchorEvidence: EVIDENCE, dimsLabel: S(), source: S() };
const BOX = (extra = {}, optional = {}) => O({ c: V3, w: POS, h: POS, d: POS, ...extra }, optional);
const BOX_DIMS = O({ w: POS, h: POS, d: POS });
const FINDING = O({ id: S(true), verdict: E("good", "warn", "bad"), evidence: EVIDENCE, message: S(), related: A(S(true), { min: 1, unique: true }) });
const FAN_ROLE = E("front", "rear", "left", "right");
const FACE = E("+x", "-x", "+y", "-y", "+z", "-z");

const STORAGE_PROFILE = O({
  caseId: S(true), trayCount: PI, backplanePowerInlets: PI,
  backplanePower: O({
    inlets: PI, connectors: O({ sataPower: NI, molex: NI }), oneLeadPerInlet: B,
    daisyChainAllowed: B, fillAllInlets: B, requiresFanBracketRemoval: B,
    independentPsuSupported: B, evidence: EVIDENCE, source: S(), note: S(),
  }),
  bottomPsu: O({ form: E("ATX", "SFX"), removesLeftFanBracket: B, evidence: EVIDENCE, source: S() }),
  fanMounts: O({
    front: O({ size: PI, count: PI, altSize: PI, altCount: PI, radiator240: B }),
    left: O({ size: PI, count: PI, onRemovableBracket: B }), right: O({ size: PI, count: PI }),
    rear: O({ size: PI, count: PI }), evidence: EVIDENCE, source: S(), note: S(),
  }),
  runtime: O({
    dialect: L("storage-layout-v1"), mountPartIds: R(S(true), { min: 1 }),
    psuPlacements: O(Object.fromEntries(["auto", "bottom", "dual"].map((key) => [key, O({ ATX: S(true), SFX: S(true) })]))),
    fanMounts: A(O({
      id: S(true), geometryRole: FAN_ROLE, label: S(), size: E(120, 140), count: PI,
      supportedSizes: A(E(120, 140), { min: 1, unique: true }), maxCountBySize: R(PI, { min: 1 }),
      direction: E("intake", "exhaust"), chamber: E("upper", "lower"), evidence: EVIDENCE, source: S(),
    }), { min: 1 }),
    fanAvailabilityRules: A(U(
      O({ mountId: S(true), kind: L("selection-in"), field: S(true), values: A(S(true), { min: 1, unique: true }) }),
      O({ mountId: S(true), kind: L("psu-form-and-selection-in"), form: E("ATX", "SFX"), field: S(true), values: A(S(true), { min: 1, unique: true }) }),
      O({ mountId: S(true), kind: L("cooler-attribute-equals"), attribute: S(true), value: S(true) }),
    )),
    coolerFanAssignments: A(O({ coolerType: S(true), radiatorMm: PI, geometryRole: FAN_ROLE, size: E(120, 140), count: PI })),
    lowerChamberPolicy: O({ fanMountId: S(true), geometryRole: FAN_ROLE, unavailableWithPsuTopologies: A(E("auto", "bottom", "dual"), { min: 1, unique: true }), effectDescription: S() }),
  }),
  lowerChamber: O({
    backplane: O({ inletRowOrder: A(E("sata", "molex"), { min: 1 }), reachRequiresBracketRemoval: B, evidence: EVIDENCE, source: S(), note: S() }),
    leftFanBracket: O({ screws: PI, carriesFans: O({ size: PI, count: PI }), removedForBottomPsu: B, evidence: EVIDENCE, source: S(), note: S() }),
    bottomPsuRack: O({ shippedWithCase: B, installOrder: A(S(), { min: 1 }), evidence: EVIDENCE, source: S(), note: S() }),
  }),
  psuLimits: O({ atxMaxLengthMm: POS, sfxMaxLengthMm: POS }), coolerLimits: O({ overheadAtxMm: POS, openTopMm: POS }),
  gpuLimits: O({ planningMinMm: POS, publishedMaxMm: POS }),
  domainFindings: A(U(
    O({ kind: L("placement-in"), placements: A(S(true), { min: 1, unique: true }), finding: FINDING }),
    O({ kind: L("boot-bay-full"), finding: FINDING }),
    O({ kind: L("selected-sku-boolean"), attribute: S(true), value: B, andField: S(true), andValue: S(true), finding: FINDING }),
    O({ kind: L("selection-equals"), field: S(true), value: S(true), finding: FINDING }),
  )),
  powerProfile: O({ boardBaseW: NN, fanBaseW: NN, fan120W: NN, fan140W: NN, dualSyncW: NN, cpuIdleW: NN, cpuReadW: NN, cpuQuickSyncW: NN, hbaW: NN, driveSpinUpExtraW: NN, evidence: EVIDENCE, source: S() }),
  thermalProfile: O({ airDensityKgM3: POS, airCpJPerKgK: POS, systemDerate: RANGE, passiveCfm: RANGE, evidence: EVIDENCE, source: S() }),
  hba: O({ defaultSkuId: S(true) }),
  defaults: O({ diskSkuId: S(true), bootBaySkuId: S(true), ownedNvmeSkuId: S(true), ownedNvmeQty: NI, hbaBreakoutSkuId: S(true), slimsasCableSkuId: S(true), dualSyncSkuId: S(true), secondaryPsuSkuId: S(true) }),
});

const ANCHOR = (face, note = false) => O({ c: V2, [face]: N, w: POS, h: POS, ...META }, note ? { note: S() } : {});
const FAN_ROW = (offset) => O({ c: V3, [offset]: A(N, { min: 1, unique: true }), frameMm: POS, thicknessMm: POS });
const STORAGE_GEOMETRY = O({
  caseId: S(true), frame: O({ unit: L("mm"), origin: S(), axes: O({ x: S(), y: S(), z: S() }), evidence: EVIDENCE, note: S() }),
  envelope: O({ w: POS, h: POS, d: POS, evidence: EVIDENCE, source: S() }),
  interior: O({ baseHeightMm: NN, yFloor: N, evidence: EVIDENCE, source: S(), note: S() }),
  deck: O({ y: N, thicknessMm: POS, anchorEvidence: EVIDENCE, sizeEvidence: EVIDENCE, source: S(), note: S() }),
  board: BOX({ topY: N, ...META }), socket: O({ c: V2, w: POS, h: POS, d: POS, keepoutMm: POS, mountPitchMm: POS, ...META, note: S() }),
  memory: O({ xTwoModules: A(N, { min: 1, unique: true }), xOneModule: A(N, { min: 1, unique: true }), w: POS, d: POS, zCenter: N, ...META }),
  m2: O({ slots: A(O({ id: S(true), c: V2 }, { note: S() }), { min: 1 }), w: POS, h: POS, d: POS, ...META }),
  psu: O({ rearUpperAtx: ANCHOR("zRear", true), frontSfx: ANCHOR("zFront"), bottomSfx: ANCHOR("zRear", true) }),
  cooler: O({ baseHeightMm: POS, downdraftFootprintMm: POS, towerFootprintMm: POS, footprintBySku: R(POS), aioPump: BOX(), ...META, note: S() }),
  gpu: O({ zRear: N, x: N, slotPitchMm: POS, heightWorkstationLowMm: POS, heightWorkstationMm: POS, heightConsumerMm: POS, ...META, note: S() }),
  hba: O({ c: V2, w: POS, h: POS, d: POS, ...META }),
  trays: O({ count: PI, pitchMm: POS, c: V3, bootC: V3, drive35: BOX_DIMS, boot25: BOX_DIMS, ...META, note: S() }),
  trayFrame: O({ bars: A(BOX({ id: S(true) }), { min: 1 }), ...META }),
  backplane: O({ pcb: BOX(), inlet: BOX({ pitchMm: POS, x0: N }), ...META }),
  lowerLeftWall: O({ fanBracket: BOX({ dimsLabel: S(), source: S() }), psuRackPlate: BOX(), psuRackSide: BOX(), driveFanZ: A(N, { min: 1, unique: true }), driveFanC: V2, ...META }),
  fanMounts: O({ front140: FAN_ROW("xOffsets"), front120: FAN_ROW("xOffsets"), rear120: FAN_ROW("xOffsets"), sideRight120: FAN_ROW("zOffsets"), radiator240Front: BOX(), radiator120Rear: BOX(), ...META }),
  externalUsbBoot: BOX({ ...META }),
  clearances: A(BOX({ id: S(true), name: S(), ...META }, { note: S(), onlyWithGpu: B })),
});

const PORT = O({ id: S(true), onPart: S(true), face: FACE, offset: V2, kind: S(true), insertionMm: POS, sectionMm: V2, source: S() }, { whenSlot: A(S(true), { min: 1, unique: true }) });
const PORT_ROW = O({ id: S(true), onPart: S(true), face: FACE, offsetsAlong: E("x", "y", "z"), offsetPitchMm: POS, offsetV: N, kind: S(true), insertionMm: POS, sectionMm: V2, source: S() });
const STORAGE_ROUTING = O({
  caseId: S(true), frame: O({ note: S(), anchorEvidence: EVIDENCE }), ports: A(U(PORT, PORT_ROW), { min: 1 }),
  waypoints: A(O({ id: S(true), c: V3, kind: E("free", "channel", "deck_opening"), apertureMm: POS, source: S() }), { min: 1 }),
  edges: A(O({ from: S(true), to: S(true), note: S() }), { min: 1 }),
});
const PREINSTALLED = O({ match: S(true), removable: B, source: S() });
const INSTALL = O({ match: S(true), axis: FACE, travelMm: U(POS, L("self")), source: S() });
const DECLARED = (ev = EVIDENCE) => O({ id: S(true), before: S(true), after: S(true), evidence: ev, source: S() });
const STORAGE_ASSEMBLY = O({ caseId: S(true), frame: O({ note: S(), anchorEvidence: EVIDENCE }), preinstalled: A(PREINSTALLED), install: A(INSTALL), declared: A(DECLARED()) });

const CAL_SCALAR = (unit) => O({ value: Q(N), evidence: EVIDENCE, unit: L(unit), source: Q(S()) });
const CAL_RANGE = (unit) => O({ min: Q(N), max: Q(N), evidence: EVIDENCE, unit: L(unit), source: Q(S()) });
const CALIBRATION = O({
  schemaVersion: L("1.0.0"), calibrationVersion: S(true), caseId: S(true), capturedAt: Q(S()), source: S(), provenance: A(S(true), { unique: true }),
  wallPowerW: CAL_SCALAR("W"), smartTemperatureC: CAL_RANGE("°C"), cpuTemperatureC: CAL_RANGE("°C"), gpuTemperatureC: CAL_RANGE("°C"), noiseDba: CAL_SCALAR("dBA"),
  fanCurve: O({ mode: Q(S(true)), rpm: Q(N), cfm: Q(N), evidence: EVIDENCE, source: Q(S()) }),
});

const NULL_NN = Q(NN);
const PRIMITIVE_FAN = O({
  id: S(true), label: S(), size: E(120, 140), count: PI, supportedSizes: A(E(120, 140), { min: 1, unique: true }),
  maxCountBySize: R(PI, { min: 1 }), direction: E("intake", "exhaust"), chamber: E("upper", "lower"),
  evidence: RUNTIME_EVIDENCE, source: S(), geometryRole: FAN_ROLE,
});
const PRIMITIVE_PROFILE = O({
  schemaVersion: L("case-runtime-profile-primitives-v1"), caseId: S(true),
  capabilities: O({
    trayCount: NI, backplane: O({ sataPowerInlets: NI, molexInlets: NI, evidence: RUNTIME_EVIDENCE }), fanMounts: A(PRIMITIVE_FAN),
    psuLimits: O({ atxMaxLengthMm: NULL_NN, sfxMaxLengthMm: NULL_NN }), coolerLimits: O({ overheadAtxMm: NULL_NN, openTopMm: NULL_NN }),
    gpuLimits: O({ planningMinMm: NULL_NN, publishedMaxMm: NULL_NN }),
  }),
  powerProfile: O({ boardBaseW: NULL_NN, fanBaseW: NULL_NN, fan120W: NULL_NN, fan140W: NULL_NN, dualSyncW: NULL_NN, cpuIdleW: NULL_NN, cpuReadW: NULL_NN, cpuQuickSyncW: NULL_NN, hbaW: NULL_NN, driveSpinUpExtraW: NULL_NN, evidence: RUNTIME_EVIDENCE, source: S() }),
  thermalProfile: O({ airDensityKgM3: POS, airCpJPerKgK: POS, systemDerate: RANGE, passiveCfm: RANGE, evidence: RUNTIME_EVIDENCE }),
  defaults: O({ ownedNvmeQty: NI }, { diskSkuId: S(true), ownedNvmeSkuId: S(true), hbaSkuId: S(true) }),
});
const SELECTOR = E("case", "board", "cpu", "psu", "cooler", "memory", "gpu", "disk", "nvme", "hba");
const DIMENSION = U(POS, O({ source: L("catalog-dimension"), selector: SELECTOR, field: E("widthMm", "heightMm", "lengthMm"), fallback: POS }));
const COUNT = U(NI, O({ source: L("selection"), field: E("diskCount", "nvmeCount"), fallback: NI }), O({ source: L("catalog-attribute"), selector: SELECTOR, field: S(true), fallback: NI }));
const PART_KIND = E("deck", "board", "cpu", "ram", "m2", "psu", "cooler", "radiator", "gpu", "hba", "drive", "empty", "boot", "usb", "fan", "chassis", "pcb", "connector", "reserve", "clearance");
const SLOT_KIND = E("drive_bay", "pcie", "fan", "psu", "radiator", "cooler", "memory", "m2", "cable_clearance", "structure");
const PRIMITIVE_GEOMETRY = O({
  schemaVersion: L("case-runtime-geometry-primitives-v1"), caseId: S(true), envelope: O({ centerMm: V3, sizeMm: T(POS, POS, POS) }),
  interior: O({ centerMm: V3, sizeMm: T(POS, POS, POS) }), envelopePartId: S(true), thermalDeckY: N, mountPartIds: R(S(true)),
  parts: A(O({ id: S(true), name: S(), kind: PART_KIND, centerMm: V3, sizeMm: T(DIMENSION, DIMENSION, DIMENSION), sizeEvidence: RUNTIME_EVIDENCE, anchorEvidence: RUNTIME_EVIDENCE, dimsLabel: S() }, {
    skuSelector: SELECTOR, repeat: COUNT, repeatOffsetMm: V3, slotId: S(true), mountedOn: S(true), group: S(true), thermalId: E("cpu", "gpu", "hba", "psu", "hdd"), chamber: E("upper", "lower"),
  }), { min: 1 }),
  slots: A(O({ id: S(true), kind: SLOT_KIND, centerMm: V3, sizeMm: T(POS, POS, POS), evidence: RUNTIME_EVIDENCE, exclusiveWith: A(S(true), { unique: true }) })),
});
const EMPTY = A(U());
const PRIMITIVE_ROUTING = O({ schemaVersion: L("case-runtime-routing-primitives-v1"), caseId: S(true), mode: L("no-case-managed-cables"), ports: EMPTY, waypoints: EMPTY, edges: EMPTY });
const PRIMITIVE_ASSEMBLY = O({ schemaVersion: L("case-runtime-assembly-primitives-v1"), caseId: S(true), preinstalled: A(PREINSTALLED), install: A(INSTALL), declared: A(DECLARED(RUNTIME_EVIDENCE)) });

function centeredInside(center, size, envelopeCenter, envelopeSize) {
  return [0, 1, 2].every((axis) => Math.abs(center[axis] - envelopeCenter[axis]) + size[axis] / 2 <= envelopeSize[axis] / 2 + 1e-9);
}
function storageInside(center, size, envelope) { return centeredInside(center, size, [0, 0, 0], [envelope.w, envelope.h, envelope.d]); }
function cycle(rules) {
  const adjacency = new Map();
  for (const rule of rules) adjacency.set(rule.before, [...(adjacency.get(rule.before) ?? []), rule.after]);
  const visiting = new Set(); const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((adjacency.get(node) ?? []).some(visit)) return true;
    visiting.delete(node); visited.add(node); return false;
  };
  return [...adjacency.keys()].some(visit);
}

function calibrationCrossErrors(calibration) {
  const errors = [];
  for (const field of ["smartTemperatureC", "cpuTemperatureC", "gpuTemperatureC"]) {
    const range = calibration[field];
    if (range.min !== null && range.max !== null && range.min > range.max) errors.push(`runtime model calibration ${field} range inverted`);
  }
  if ([calibration.wallPowerW.value, calibration.noiseDba.value, calibration.fanCurve.rpm, calibration.fanCurve.cfm]
    .some((value) => value !== null && value < 0)) errors.push("runtime model calibration contains negative physical measurement");
  return errors;
}

function assemblyCrossErrors(assembly) {
  const errors = [];
  if (!uniqueBy(assembly.preinstalled, "match") || !uniqueBy(assembly.install, "match") || !uniqueBy(assembly.declared, "id")) errors.push("runtime model assembly IDs duplicate");
  if (assembly.declared.some((rule) => rule.before === rule.after) || cycle(assembly.declared)) errors.push("runtime model assembly declarations contain a dependency cycle");
  return errors;
}

function primitiveCrossErrors(documents, manifest) {
  const { profile, geometry, routing, assembly, calibration } = documents;
  const errors = [];
  const caseIds = [profile.caseId, geometry.caseId, routing.caseId, assembly.caseId, calibration.caseId];
  if (new Set(caseIds).size !== 1 || (manifest && profile.caseId !== manifest.identity.skuId)) errors.push("runtime model primitive exact case identity mismatch");
  const normalizedPartIds = geometry.parts.map((part) => part.id.replaceAll("{index}", "1"));
  if (new Set(normalizedPartIds).size !== normalizedPartIds.length) errors.push("runtime model primitive part IDs duplicate");
  if (!normalizedPartIds.includes(geometry.envelopePartId)) errors.push("runtime model primitive envelope part reference invalid");
  const envelopeTemplate = geometry.parts.find((part) => part.id.replaceAll("{index}", "1") === geometry.envelopePartId);
  if (!envelopeTemplate || envelopeTemplate.repeat !== undefined || envelopeTemplate.kind !== "chassis") errors.push("runtime model primitive envelope part must be one fixed chassis primitive");
  const slotIds = new Set(geometry.slots.map((slot) => slot.id));
  if (slotIds.size !== geometry.slots.length) errors.push("runtime model primitive slot IDs duplicate");
  for (const slot of geometry.slots) {
    if (slot.exclusiveWith.some((id) => id === slot.id || !slotIds.has(id))) errors.push(`runtime model primitive slot ${slot.id} exclusive reference invalid`);
    if (!centeredInside(slot.centerMm, slot.sizeMm, geometry.envelope.centerMm, geometry.envelope.sizeMm)) errors.push(`runtime model primitive slot ${slot.id} exceeds envelope`);
  }
  const manifestMounts = new Set(manifest?.mounts.map((mount) => mount.mountId) ?? []);
  for (const [mountId, partId] of Object.entries(geometry.mountPartIds)) {
    if (manifest && !manifestMounts.has(mountId)) errors.push(`runtime model primitive mount ${mountId} not in manifest`);
    if (!normalizedPartIds.includes(partId.replaceAll("{index}", "1"))) errors.push(`runtime model primitive mount ${mountId} part reference invalid`);
  }
  if (!centeredInside(geometry.interior.centerMm, geometry.interior.sizeMm, geometry.envelope.centerMm, geometry.envelope.sizeMm)) errors.push("runtime model primitive interior exceeds envelope");
  if (geometry.thermalDeckY < geometry.envelope.centerMm[1] - geometry.envelope.sizeMm[1] / 2
    || geometry.thermalDeckY > geometry.envelope.centerMm[1] + geometry.envelope.sizeMm[1] / 2) errors.push("runtime model primitive thermal deck exceeds envelope");
  for (const part of geometry.parts) {
    const size = part.sizeMm.map((dimension) => typeof dimension === "number" ? dimension : dimension.fallback);
    if (!centeredInside(part.centerMm, size, geometry.envelope.centerMm, geometry.envelope.sizeMm)) errors.push(`runtime model primitive part ${part.id} fallback envelope exceeds case`);
    if (part.slotId && !slotIds.has(part.slotId.replaceAll("{index}", "1"))) errors.push(`runtime model primitive part ${part.id} slot reference invalid`);
    if (part.mountedOn && !normalizedPartIds.includes(part.mountedOn.replaceAll("{index}", "1"))) errors.push(`runtime model primitive part ${part.id} parent reference invalid`);
  }
  const fanIds = new Set(profile.capabilities.fanMounts.map((mount) => mount.id));
  if (fanIds.size !== profile.capabilities.fanMounts.length) errors.push("runtime model primitive fan mount IDs duplicate");
  for (const fan of profile.capabilities.fanMounts) {
    const keys = Object.keys(fan.maxCountBySize).map(Number).sort((a, b) => a - b);
    const sizes = [...fan.supportedSizes].sort((a, b) => a - b);
    if (JSON.stringify(keys) !== JSON.stringify(sizes) || sizes.some((size) => fan.maxCountBySize[String(size)] > fan.count)) errors.push(`runtime model primitive fan ${fan.id} size/count map mismatch`);
  }
  if (profile.thermalProfile.systemDerate.lo > profile.thermalProfile.systemDerate.hi || profile.thermalProfile.passiveCfm.lo > profile.thermalProfile.passiveCfm.hi) errors.push("runtime model primitive thermal ranges invalid");
  errors.push(...assemblyCrossErrors(assembly), ...calibrationCrossErrors(calibration));
  return errors;
}

function storageCrossErrors(documents, manifest) {
  const { profile, geometry, routing, assembly, calibration } = documents;
  const errors = [];
  const caseIds = [profile.caseId, geometry.caseId, routing.caseId, assembly.caseId, calibration.caseId];
  if (new Set(caseIds).size !== 1 || (manifest && profile.caseId !== manifest.identity.skuId)) errors.push("runtime model document exact case identity mismatch");
  if (profile.trayCount !== geometry.trays.count || profile.backplanePower.inlets !== profile.lowerChamber.backplane.inletRowOrder.length
    || profile.backplanePower.inlets !== profile.backplanePowerInlets) errors.push("runtime model tray/backplane counts do not close across documents");
  if (profile.backplanePower.connectors.sataPower + profile.backplanePower.connectors.molex
    !== profile.backplanePower.inlets) errors.push("runtime model backplane connector counts do not close to inlet count");
  const inletOrder = profile.lowerChamber.backplane.inletRowOrder;
  if (inletOrder.some((connector) => connector !== "sata" && connector !== "molex")
    || inletOrder.filter((connector) => connector === "sata").length !== profile.backplanePower.connectors.sataPower
    || inletOrder.filter((connector) => connector === "molex").length !== profile.backplanePower.connectors.molex) {
    errors.push("runtime model backplane inlet order does not close to connector counts");
  }
  if (manifest) {
    const mounts = new Set(manifest.mounts.map((mount) => mount.mountId));
    for (const mountId of Object.keys(profile.runtime.mountPartIds)) if (!mounts.has(mountId)) errors.push(`runtime model mountPartIds references unknown manifest mount ${mountId}`);
  }
  const fanIds = new Set(profile.runtime.fanMounts.map((mount) => mount.id));
  if (fanIds.size !== profile.runtime.fanMounts.length || new Set(profile.runtime.fanMounts.map((mount) => mount.geometryRole)).size !== profile.runtime.fanMounts.length) errors.push("runtime model fan mounts duplicate");
  for (const mount of profile.runtime.fanMounts) {
    const keys = Object.keys(mount.maxCountBySize).map(Number).sort((a, b) => a - b);
    const sizes = [...mount.supportedSizes].sort((a, b) => a - b);
    if (JSON.stringify(keys) !== JSON.stringify(sizes) || sizes.some((size) => mount.maxCountBySize[String(size)] > mount.count)) errors.push(`runtime model fan ${mount.id} size/count map mismatch`);
  }
  for (const rule of profile.runtime.fanAvailabilityRules) if (!fanIds.has(rule.mountId)) errors.push(`runtime model fan rule references unknown mount ${rule.mountId}`);
  const chamberPolicy = profile.runtime.lowerChamberPolicy;
  if (!fanIds.has(chamberPolicy.fanMountId) || profile.runtime.fanMounts.find((mount) => mount.id === chamberPolicy.fanMountId)?.geometryRole !== chamberPolicy.geometryRole) errors.push("runtime model lower chamber policy fan reference mismatch");
  const placements = new Set(["rearUpperAtx", "frontSfx", "bottomSfx", "rearUpperAtx+bottomSfx", "frontSfx+bottomSfx", "invalidAtxBottom"]);
  for (const mapping of Object.values(profile.runtime.psuPlacements)) for (const value of Object.values(mapping)) if (!placements.has(value)) errors.push("runtime model PSU placement token invalid");
  for (const [values, field] of [[geometry.m2.slots, "id"], [geometry.trayFrame.bars, "id"], [geometry.clearances, "id"]]) if (!uniqueBy(values, field)) errors.push(`runtime model geometry ${field} values duplicate`);
  const boxes = [
    ["board", geometry.board.c, [geometry.board.w, geometry.board.h, geometry.board.d]],
    ...geometry.trayFrame.bars.map((part) => [`trayFrame.${part.id}`, part.c, [part.w, part.h, part.d]]),
    ["backplane.pcb", geometry.backplane.pcb.c, [geometry.backplane.pcb.w, geometry.backplane.pcb.h, geometry.backplane.pcb.d]],
    ["lowerLeftWall.fanBracket", geometry.lowerLeftWall.fanBracket.c, [geometry.lowerLeftWall.fanBracket.w, geometry.lowerLeftWall.fanBracket.h, geometry.lowerLeftWall.fanBracket.d]],
    ["lowerLeftWall.psuRackPlate", geometry.lowerLeftWall.psuRackPlate.c, [geometry.lowerLeftWall.psuRackPlate.w, geometry.lowerLeftWall.psuRackPlate.h, geometry.lowerLeftWall.psuRackPlate.d]],
    ["lowerLeftWall.psuRackSide", geometry.lowerLeftWall.psuRackSide.c, [geometry.lowerLeftWall.psuRackSide.w, geometry.lowerLeftWall.psuRackSide.h, geometry.lowerLeftWall.psuRackSide.d]],
    ...geometry.clearances.map((part) => [part.id, part.c, [part.w, part.h, part.d]]),
  ];
  for (const [id, center, size] of boxes) if (!storageInside(center, size, geometry.envelope)) errors.push(`runtime model geometry ${id} exceeds envelope`);
  if (geometry.interior.yFloor < -geometry.envelope.h / 2 || geometry.interior.yFloor >= geometry.deck.y || geometry.deck.y >= geometry.envelope.h / 2) errors.push("runtime model interior/deck bounds invalid");
  const waypointIds = new Set(routing.waypoints.map((waypoint) => waypoint.id));
  if (waypointIds.size !== routing.waypoints.length) errors.push("runtime model waypoint IDs duplicate");
  const adjacency = new Map(); const edgeIds = new Set();
  for (const waypoint of routing.waypoints) if (!storageInside(waypoint.c, [0, 0, 0], geometry.envelope)) errors.push(`runtime model waypoint ${waypoint.id} exceeds envelope`);
  for (const edge of routing.edges) {
    if (!waypointIds.has(edge.from) || !waypointIds.has(edge.to) || edge.from === edge.to) errors.push("runtime model routing edge reference invalid");
    const edgeId = [edge.from, edge.to].sort().join("\0");
    if (edgeIds.has(edgeId)) errors.push("runtime model routing edge duplicate");
    edgeIds.add(edgeId);
    adjacency.set(edge.from, new Set([...(adjacency.get(edge.from) ?? []), edge.to]));
    adjacency.set(edge.to, new Set([...(adjacency.get(edge.to) ?? []), edge.from]));
  }
  if (waypointIds.size) {
    const visited = new Set(); const pending = [waypointIds.values().next().value];
    while (pending.length) { const current = pending.pop(); if (visited.has(current)) continue; visited.add(current); pending.push(...(adjacency.get(current) ?? [])); }
    if (visited.size !== waypointIds.size) errors.push("runtime model routing waypoint graph is disconnected");
  }
  const allowedParts = new Set(["board", "psu", "backplane.inlet", "backplane.pcb", "hba", "gpu"]); const variants = new Set();
  for (const port of routing.ports) {
    if (!allowedParts.has(port.onPart)) errors.push(`runtime model port ${port.id} references unsupported part role`);
    const variant = `${port.id}\0${port.face}\0${"whenSlot" in port ? sorted(port.whenSlot ?? []).join(",") : "row"}`;
    if (variants.has(variant)) errors.push(`runtime model port ${port.id} duplicate variant`); variants.add(variant);
  }
  const portIds = new Set(routing.ports.map((port) => port.id));
  for (const id of ["port.board.atx24", "port.board.eps", "port.board.sata", "port.board.slimsas", "port.backplane.power", "port.backplane.data"]) if (!portIds.has(id)) errors.push(`runtime model required semantic port ${id} missing`);
  if (profile.thermalProfile.systemDerate.lo > profile.thermalProfile.systemDerate.hi || profile.thermalProfile.passiveCfm.lo > profile.thermalProfile.passiveCfm.hi) errors.push("runtime model thermal ranges invalid");
  errors.push(...assemblyCrossErrors(assembly), ...calibrationCrossErrors(calibration));
  return errors;
}

export function validateCaseRuntimeDocumentsRuntime(value, manifest = null) {
  try {
    if (!exact(value, DOCUMENT_FIELDS)) return ["runtime model documents invalid"];
    if (manifest !== null && !verifyCaseAdapterManifestRuntime(manifest)) return ["runtime model manifest integrity invalid"];
    const primitive = value.profile?.schemaVersion === "case-runtime-profile-primitives-v1";
    const schemas = primitive
      ? [PRIMITIVE_PROFILE, PRIMITIVE_GEOMETRY, PRIMITIVE_ROUTING, PRIMITIVE_ASSEMBLY, CALIBRATION]
      : [STORAGE_PROFILE, STORAGE_GEOMETRY, STORAGE_ROUTING, STORAGE_ASSEMBLY, CALIBRATION];
    const errors = DOCUMENT_FIELDS.flatMap((field, index) => schemaErrors(value[field], schemas[index], `runtime model ${field}`));
    if (errors.length) return [...new Set(errors)];
    errors.push(...(primitive ? primitiveCrossErrors(value, manifest) : storageCrossErrors(value, manifest)));
    return [...new Set(errors)];
  } catch { return ["runtime model document validation failed closed"]; }
}

function validateModel(value, requireHash, manifest) {
  try {
    const errors = [];
    if (!exact(value, MODEL_FIELDS, requireHash ? ["contentHash"] : []) || (requireHash && !("contentHash" in value))) return ["case runtime model fields invalid"];
    errors.push(...canonicalValueErrors(value));
    if (value.schemaVersion !== "case-runtime-model-v1" || value.interpreterId !== "declarative-case-v1"
      || !portable(value.runtimeId) || !portable(value.runtimeVersion)) errors.push("case runtime model identity/version invalid");
    if (!["legacy_unverified", "governed_fact_derivation_bound"].includes(value.authorityStatus)) errors.push("case runtime model authorityStatus invalid");
    const refs = value.authorityRefs;
    if (!exact(refs, ["factIds", "derivationIds", "evidenceContentHashes"])
      || !ids(refs?.factIds, true) || !ids(refs?.derivationIds, true)
      || !Array.isArray(refs?.evidenceContentHashes) || refs.evidenceContentHashes.some((hash) => !HASH.test(hash)) || !unique(refs.evidenceContentHashes)) errors.push("case runtime model authorityRefs invalid");
    else if (value.authorityStatus === "legacy_unverified"
      ? refs.factIds.length + refs.derivationIds.length + refs.evidenceContentHashes.length !== 0
      : true) {
      errors.push(value.authorityStatus === "governed_fact_derivation_bound"
        ? "governed case runtime models require per-field fact/derivation bindings not present in case-runtime-model-v1"
        : "case runtime model authority status/reference closure invalid");
    }
    if (!exact(value.identity, ["skuId", "region", "revision"]) || ![value.identity?.skuId, value.identity?.region, value.identity?.revision].every(portable)) errors.push("case runtime model exact identity invalid");
    if (!HASH.test(String(value.manifestHash ?? "")) || (requireHash && !HASH.test(String(value.contentHash ?? "")))) errors.push("case runtime model hashes invalid");
    if (!ids(value.sourceRefs) || JSON.stringify(value.sourceRefs) !== JSON.stringify(sorted(value.sourceRefs))) errors.push("case runtime model sourceRefs invalid or non-canonical");
    if (manifest !== null) {
      if (!verifyCaseAdapterManifestRuntime(manifest)) errors.push("case runtime model manifest integrity invalid");
      else if (value.manifestHash !== manifest.contentHash || value.identity?.skuId !== manifest.identity.skuId
        || value.identity?.region !== manifest.identity.region || value.identity?.revision !== manifest.identity.revision) errors.push("case runtime model exact manifest binding invalid");
    }
    errors.push(...validateCaseRuntimeDocumentsRuntime(value.documents, manifest));
    return [...new Set(errors)];
  } catch { return ["case runtime model validation failed closed"]; }
}

export function validateCaseRuntimeModelInputRuntime(value, manifest = null) { return validateModel(value, false, manifest); }
export function validateCaseRuntimeModelRuntime(value, manifest = null) { return validateModel(value, true, manifest); }

export function verifyCaseRuntimeModelRuntime(value, manifest = null) {
  if (validateCaseRuntimeModelRuntime(value, manifest).length) return false;
  return caseRuntimeModelContentHashRuntime(value) === value.contentHash;
}

/** Content-addressed references consumed by graph/Doctor/backup closure. */
export function runtimeModelSnapshotReferencesRuntime(value, manifest = null) {
  if (!verifyCaseRuntimeModelRuntime(value, manifest)) return null;
  return Object.freeze({
    manifestHash: value.manifestHash,
    runtimeModelHash: value.contentHash,
    sourceRefs: Object.freeze([...value.sourceRefs]),
    factIds: Object.freeze([...value.authorityRefs.factIds]),
    derivationIds: Object.freeze([...value.authorityRefs.derivationIds]),
    evidenceContentHashes: Object.freeze([...value.authorityRefs.evidenceContentHashes]),
  });
}
