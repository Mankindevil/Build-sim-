import { describe, expect, it } from "vitest";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { validateProgressiveBuildEvaluationClosure } from "../src/compatibility/contracts";
import { legacySha256Runtime } from "../src/facts/canonical-runtime.mjs";
import { hashPlanConfig } from "../src/plans/canonical";
import {
  assemblyCheckAssertionHashRuntime,
  type AssemblySafetyInput,
} from "../src/requirements/assembly-safety";
import type { ResolvedObservationRecord } from "../src/server/evaluation-service";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { evaluateElectricalSafety } from "../src/safety/electrical";
import type { InterconnectTopology, InstantiatedCable, InstantiatedPort } from "../src/interconnect";
import {
  fact,
  PROGRESSIVE_FIXTURE_NOW,
  progressiveInput,
  resolvedComponent,
} from "./helpers/progressive-evaluation-fixture";

function poweredBoard(id: string): BuildConfigV3 {
  const config = createEmptyBuildConfigV3(id, id, PROGRESSIVE_FIXTURE_NOW);
  config.components = [
    resolvedComponent("board-1", "motherboard", "board.fixture"),
    resolvedComponent("psu-1", "psu", "psu.fixture"),
    resolvedComponent("atx-cable", "cable", "cable.atx24"),
    resolvedComponent("eps-cable", "cable", "cable.eps"),
  ];
  config.connections = [
    {
      connectionId: "power-atx24",
      from: { instanceId: "psu-1", portId: "atx24-out" },
      to: { instanceId: "board-1", portId: "atx24-in" },
      cableInstanceId: "atx-cable",
      status: "planned",
    },
    {
      connectionId: "power-eps",
      from: { instanceId: "psu-1", portId: "eps-out" },
      to: { instanceId: "board-1", portId: "eps-in" },
      cableInstanceId: "eps-cable",
      status: "planned",
    },
  ];
  return config;
}

async function connectionObservation(
  config: BuildConfigV3,
  observationId: string,
  connectionId: string,
): Promise<ResolvedObservationRecord> {
  const configHash = await hashPlanConfig(config);
  const subjectRevisionHash = "a".repeat(64);
  const material = {
    observationId,
    planId: config.id,
    subjectRef: { kind: "connection" as const, connectionId },
    fieldId: "connection.connected" as const,
    value: true,
    method: "visual_confirmation" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash,
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation = { ...material, contentHash: legacySha256Runtime(material)! };
  return {
    recordHash: legacySha256Runtime(observation)!,
    observation,
    projectionContext: {
      planId: config.id,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

async function checkAssertionObservation(
  config: BuildConfigV3,
  observationId: string,
  check: AssemblySafetyInput["checks"][number],
): Promise<ResolvedObservationRecord> {
  const configHash = await hashPlanConfig(config);
  const subjectRevisionHash = "c".repeat(64);
  const assertionHash = assemblyCheckAssertionHashRuntime(check);
  if (assertionHash === null) throw new TypeError("assembly check assertion is invalid");
  const material = {
    observationId,
    planId: config.id,
    subjectRef: { kind: "instance" as const, instanceId: check.ownerInstanceId },
    fieldId: "assembly.check_assertion_hash" as const,
    value: assertionHash,
    method: "visual_confirmation" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash,
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation = { ...material, contentHash: legacySha256Runtime(material)! };
  return {
    recordHash: legacySha256Runtime(observation)!,
    observation,
    projectionContext: {
      planId: config.id,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

describe("U6 electrical safety rules", () => {
  it("passes exact official ATX24/EPS authority but remains not power-ready without physical checks", async () => {
    const config = poweredBoard("plan-main-power-pass");
    const board = config.components[0]!;
    const psu = config.components[1]!;
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config, [
      fact(board, "io.port_types", ["power.atx-24pin", "power.eps-8pin"]),
      fact(psu, "psu.connectors", ["power.atx-24pin", "power.eps-8pin"]),
    ]));

    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.main-power-connectors")).toMatchObject({
      verdict: "pass", inputStatus: "complete",
    });
    expect(evaluation.readiness.powerReady).toBe(false);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.assembly-safety")?.verdict).toBe("blocked");
  });

  it("fails a known missing EPS family immediately", async () => {
    const config = poweredBoard("plan-main-power-fail");
    const board = config.components[0]!;
    const psu = config.components[1]!;
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config, [
      fact(board, "io.port_types", ["power.atx-24pin", "power.eps-8pin"]),
      fact(psu, "psu.connectors", ["power.atx-24pin"]),
    ]));

    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.main-power-connectors")).toMatchObject({
      verdict: "fail", inputStatus: "complete",
    });
    expect(evaluation.decisions.find(({ ruleId }) => ruleId === "compat.main-power-connectors")).toMatchObject({
      verdict: "fail",
      instanceIds: ["board-1", "psu-1"],
      factIds: expect.arrayContaining(["fact.board-1.io.port-types", "fact.psu-1.psu.connectors"]),
      remediation: [expect.objectContaining({ criticality: "safety", requiredBefore: "pre_power" })],
    });
  });

  it("blocks agent-inferred connector data instead of using it for an electrical pass", async () => {
    const config = poweredBoard("plan-main-power-inference");
    const board = config.components[0]!;
    const psu = config.components[1]!;
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config, [
      fact(board, "io.port_types", ["power.atx-24pin", "power.eps-8pin"]),
      fact(psu, "psu.connectors", ["power.atx-24pin", "power.eps-8pin"], { authority: "agent_inference" }),
    ]));

    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.main-power-connectors")).toMatchObject({
      verdict: "blocked", inputStatus: "missing",
      missingInputs: [expect.objectContaining({ kind: "fact", ref: "psu-1:psu.connectors", safetyClass: "electrical_safety" })],
    });
    expect(evaluation.readiness.powerReady).toBe(false);
  });

  it("fails a known GPU connector mismatch without waiting for a complete machine", async () => {
    const config = createEmptyBuildConfigV3("plan-gpu-power-fail", "GPU power", PROGRESSIVE_FIXTURE_NOW);
    const psu = resolvedComponent("psu-1", "psu", "psu.fixture");
    const gpu = resolvedComponent("gpu-1", "gpu", "gpu.fixture");
    config.components = [psu, gpu];
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config, [
      fact(psu, "psu.connectors", ["power.pcie-8pin"]),
      fact(gpu, "gpu.power_connectors", ["power.12v-2x6"]),
    ]));

    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.gpu-power-connectors")).toMatchObject({
      verdict: "fail", inputStatus: "complete",
    });
    expect(evaluation.readiness.powerReady).toBe(false);
  });

  it("binds assembly connection state to the exact locked edge scope", async () => {
    const config = poweredBoard("plan-assembly-observation-scope");
    config.components.push(resolvedComponent("gpu-1", "gpu", "gpu.fixture"));
    config.connections.push({
      connectionId: "gpu-power",
      from: { instanceId: "psu-1", portId: "gpu-out" },
      to: { instanceId: "gpu-1", portId: "gpu-in" },
      status: "planned",
    });
    const assemblyInput: AssemblySafetyInput = {
      assemblyId: "assembly-power",
      checks: [{
        checkId: "eps-physical",
        checkType: "connection",
        ownerInstanceId: "board-1",
        instanceIds: ["board-1", "psu-1"],
        factIds: [],
        observationIds: ["obs-check-assertion", "obs-connection"],
        connectionKind: "eps",
        connectorStandard: "power.eps-8pin",
        state: "connected_verified",
      }],
    };
    const exactAssertion = await checkAssertionObservation(config, "obs-check-assertion", assemblyInput.checks[0]!);
    const legitimate = await connectionObservation(config, "obs-connection", "power-eps");
    const input = await progressiveInput(config, [], [exactAssertion, legitimate]);
    const legitimateEvaluation = await evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveAssemblySafetyInputs: async () => [assemblyInput] },
    });
    expect(legitimateEvaluation).toMatchObject({
      assemblySafetyEvaluations: [{ assemblyId: "assembly-power", decisions: [{ verdict: "pass" }] }],
    });
    const forgedAssemblyInput: AssemblySafetyInput = {
      ...assemblyInput,
      checks: assemblyInput.checks.map((check) => check.checkType === "connection"
        ? { ...check, state: "disconnected_verified" as const } : check),
    };
    expect(validateProgressiveBuildEvaluationClosure(legitimateEvaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      assemblySafetyInputs: [forgedAssemblyInput],
      requirementRoots: legitimateEvaluation.requirements.filter(({ requirementId }) => (
        legitimateEvaluation.requirementClosure.rootRequirementIds.includes(requirementId)
      )),
    })).toContain("assembly safety evaluations differ from locked resolver inputs");
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveAssemblySafetyInputs: async () => [forgedAssemblyInput] },
    })).rejects.toThrow(/exact owner\/check assertion/);

    const unrelated = await connectionObservation(config, "obs-connection", "gpu-power");
    const forgedInput = await progressiveInput(config, [], [exactAssertion, unrelated]);
    await expect(evaluateProgressiveCompatibility(forgedInput, {
      authorityResolver: { resolveAssemblySafetyInputs: async () => [assemblyInput] },
    })).rejects.toThrow(/not bound to a locked edge between target instances/);
  });
});

const interconnectPort = (
  ownerInstanceId: string,
  portId: string,
  connectorFamily: string,
  pinoutFamily: string,
): InstantiatedPort => ({
  portId,
  ownerInstanceId,
  ownerGeometryEntityId: `geo-${ownerInstanceId}`,
  connectorStandardId: `${connectorFamily}-${ownerInstanceId === "psu" ? "receptacle" : "receptacle"}`,
  localPose: { positionMm: [0, 0, 0], rotationDeg: [0, 0, 0] },
  insertionDirection: [1, 0, 0],
  ratedUses: connectorFamily === "power.12v-2x6" ? ["gpu-power"] : ["storage-power"],
  shared: false,
  maxConnections: 1,
  provenance: { authority: "official", sourceRefs: ["fact:port"], derivationIds: [], scope: "product" },
  connectorFamily,
  gender: "female",
  keying: connectorFamily,
  pinoutFamily,
  worldPose: { positionMm: [0, 0, 0], rotationDeg: [0, 0, 0] },
  worldInsertionDirection: [1, 0, 0],
  insertionMm: 20,
  sectionMm: [10, 10],
});

function electricalTopology(kind: "backplane" | "12v-2x6", cablePinout = kind === "backplane" ? "sata-power" : "12v-2x6"): InterconnectTopology {
  const connectorFamily = kind === "backplane" ? "power.sata" : "power.12v-2x6";
  const target = kind === "backplane" ? "backplane" : "gpu";
  const ports = [
    interconnectPort("psu", "out", connectorFamily, cablePinout),
    interconnectPort(target, "in", connectorFamily, cablePinout),
  ];
  const cable: InstantiatedCable = {
    cableInstanceId: "cable",
    endpoints: [
      { instanceId: "psu", portId: "out", connectorStandardId: "fixture-plug-a", connectorStyle: "straight" },
      { instanceId: target, portId: "in", connectorStandardId: "fixture-plug-b", connectorStyle: "straight" },
    ],
    branches: [], pinoutFamily: cablePinout, lengthMm: 500, conductorGaugeAwg: 18, ratedCurrentA: 8,
    outerDiameterMm: 5, minimumBendRadiusMm: kind === "12v-2x6" ? 35 : 10,
    ratedUses: kind === "backplane" ? ["storage-power"] : ["gpu-power"],
    provenance: { authority: "official", sourceRefs: ["fact:cable"], derivationIds: [], scope: "product" },
    endpointPortKeys: ["psu:out", `${target}:in`], branchPortKeys: [],
  };
  return { schemaVersion: "interconnect-topology-v1", ports, cables: [cable] };
}

describe("U8 cable-level electrical safety is independent from mechanical fit", () => {
  it("fails a modular PSU pinout mismatch even when the connector shell is routable", () => {
    const topology = electricalTopology("backplane", "vendor-b-pinout");
    const evaluation = evaluateElectricalSafety({
      topology,
      sources: [{
        sourcePortKey: "psu:out", pinoutFamily: "vendor-a-pinout", continuousCurrentA: 10, transientCurrentA: 14,
        authority: "official", sourceFactIds: ["fact:psu-pinout"],
      }],
      loads: [{
        consumerPortKey: "backplane:in", continuousCurrentA: 4, startupCurrentA: 8, loadKind: "backplane",
        authority: "official", sourceFactIds: ["fact:backplane-load"],
      }],
      seatingObservations: [],
    });
    expect(evaluation.verdict).toBe("fail");
    expect(evaluation.decisions.filter(({ check }) => check.includes("current"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: "fail", reason: expect.stringContaining("pinout") }),
    ]));
  });

  it("fails backplane startup surge separately from continuous load", () => {
    const evaluation = evaluateElectricalSafety({
      topology: electricalTopology("backplane"),
      sources: [{
        sourcePortKey: "psu:out", pinoutFamily: "sata-power", continuousCurrentA: 8, transientCurrentA: 7,
        authority: "official", sourceFactIds: ["fact:source-rating"],
      }],
      loads: [{
        consumerPortKey: "backplane:in", continuousCurrentA: 4, startupCurrentA: 8, loadKind: "backplane",
        authority: "official", sourceFactIds: ["fact:startup"],
      }],
      seatingObservations: [],
    });
    expect(evaluation.decisions.find(({ check }) => check === "continuous_current")?.verdict).toBe("pass");
    expect(evaluation.decisions.find(({ check }) => check === "startup_current")).toMatchObject({
      verdict: "fail", reason: expect.stringContaining("backplane"),
    });
  });

  it("blocks 12V-2x6 without observation and fails a too-early first bend", () => {
    const topology = electricalTopology("12v-2x6");
    const base = {
      topology,
      sources: [{
        sourcePortKey: "psu:out", pinoutFamily: "12v-2x6", continuousCurrentA: 30, transientCurrentA: 35,
        authority: "official" as const, sourceFactIds: ["fact:source"],
      }],
      loads: [{
        consumerPortKey: "gpu:in", continuousCurrentA: 25, startupCurrentA: 28, loadKind: "component" as const,
        authority: "official" as const, sourceFactIds: ["fact:gpu-load"],
      }],
    };
    expect(evaluateElectricalSafety({ ...base, seatingObservations: [] }).decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "connector_seating", verdict: "blocked" }),
    ]));
    const observed = evaluateElectricalSafety({
      ...base,
      seatingObservations: [
        { observationId: "obs-psu", cableInstanceId: "cable", portKey: "psu:out", fullySeated: true, bendStartDistanceMm: 20 },
        { observationId: "obs-gpu", cableInstanceId: "cable", portKey: "gpu:in", fullySeated: true, bendStartDistanceMm: 20 },
      ],
    });
    expect(observed.decisions.find(({ check }) => check === "connector_seating")?.verdict).toBe("pass");
    expect(observed.decisions.find(({ check }) => check === "bend_clearance")?.verdict).toBe("fail");
  });
});
