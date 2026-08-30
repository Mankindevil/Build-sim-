import { describe, expect, it, vi } from "vitest";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import {
  BUILTIN_COMPATIBILITY_RULES,
  COMPATIBILITY_RULE_COVERAGE_MATRIX,
} from "../src/compatibility/rules";
import { firmwareCapabilityTupleKeyRuntime } from "../src/compatibility/runtime.mjs";
import type { ConflictSet } from "../src/facts/contracts";
import { createConflictSet } from "../src/facts/conflicts";
import { createFactRecord } from "../src/facts/hash";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import {
  fact,
  PROGRESSIVE_FIXTURE_NOW,
  progressiveInput,
  resolvedComponent,
} from "./helpers/progressive-evaluation-fixture";

function cpuBoardConfig(id: string): BuildConfigV3 {
  const config = createEmptyBuildConfigV3(id, id, PROGRESSIVE_FIXTURE_NOW);
  config.components = [
    resolvedComponent("board-1", "motherboard", "board.fixture"),
    resolvedComponent("cpu-1", "cpu", "cpu.fixture"),
  ];
  return config;
}

describe("U6 declared compatibility rules", () => {
  it("keeps thermal and acoustic rollout-off domains explicit instead of using a legacy default", async () => {
    const config = createEmptyBuildConfigV3("plan-thermal-rollout-off", "Thermal rollout off", PROGRESSIVE_FIXTURE_NOW);
    config.components = [resolvedComponent("case-rollout-off", "case", "case.rollout-off")];
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config), {
      thermalV3Enabled: false,
      acousticV3Enabled: false,
    });
    expect(evaluation.thermalAcousticEvaluation).toMatchObject({
      thermal: { verdict: "blocked", peakTemperatureC: null, blockedReasonCodes: ["thermal-v3-disabled"] },
      acoustic: { verdict: "blocked", totalDba: null, blockedReasonCodes: ["acoustic-v3-disabled"] },
    });
    expect(evaluation.domainEvaluations.find(({ domain }) => domain === "thermal")?.verdict).toBe("blocked");
    expect(evaluation.domainEvaluations.find(({ domain }) => domain === "acoustic")?.verdict).toBe("blocked");
  });

  it("uses collision-free firmware capability tuple identities", () => {
    expect(firmwareCapabilityTupleKeyRuntime({ subjectSkuId: "a:b", subjectRevision: "c", region: "d" }))
      .not.toBe(firmwareCapabilityTupleKeyRuntime({ subjectSkuId: "a", subjectRevision: "b:c", region: "d" }));
  });

  it("locks every checklist item to an executable, versioned rule", () => {
    const ruleIds = new Set(BUILTIN_COMPATIBILITY_RULES.map(({ definition }) => definition.ruleId));
    expect(COMPATIBILITY_RULE_COVERAGE_MATRIX.length).toBeGreaterThanOrEqual(60);
    expect(new Set(COMPATIBILITY_RULE_COVERAGE_MATRIX.map(({ checkId }) => checkId)).size)
      .toBe(COMPATIBILITY_RULE_COVERAGE_MATRIX.length);
    for (const entry of COMPATIBILITY_RULE_COVERAGE_MATRIX) {
      expect(ruleIds.has(entry.ruleId), entry.checkId).toBe(true);
      expect(entry.outcomes).toEqual(["pass", "fail", "blocked"]);
    }
    for (const { definition } of BUILTIN_COMPATIBILITY_RULES) {
      expect(definition.ruleVersion).toMatch(/^\d+\.\d+\.\d+/u);
      expect(definition.requiredInputs).toHaveProperty("componentKinds");
      expect(definition.requiredInputs).toHaveProperty("facts");
      expect(definition.requiredInputs).toHaveProperty("placements");
      expect(definition.requiredInputs).toHaveProperty("connections");
      expect(definition.requiredInputs).toHaveProperty("systemProfile");
    }
  });

  it("evaluates a known CPU/socket match and fails a known mismatch immediately", async () => {
    const matching = cpuBoardConfig("plan-cpu-socket-pass");
    const board = matching.components[0]!;
    const cpu = matching.components[1]!;
    const pass = await evaluateProgressiveCompatibility(await progressiveInput(matching, [
      fact(board, "motherboard.cpu_socket", "AM5"),
      fact(cpu, "cpu.socket", "AM5"),
    ]));
    expect(pass.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.cpu-socket")).toMatchObject({
      verdict: "pass", inputStatus: "complete",
    });

    const mismatch = cpuBoardConfig("plan-cpu-socket-fail");
    const failed = await evaluateProgressiveCompatibility(await progressiveInput(mismatch, [
      fact(mismatch.components[0]!, "motherboard.cpu_socket", "LGA1700"),
      fact(mismatch.components[1]!, "cpu.socket", "AM5"),
    ]));
    expect(failed.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.cpu-socket")).toMatchObject({
      verdict: "fail", inputStatus: "complete",
    });
    expect(failed.decisions.find(({ ruleId }) => ruleId === "compat.cpu-socket")).toMatchObject({
      verdict: "fail",
      factIds: expect.arrayContaining(["fact.board-1.motherboard.cpu-socket", "fact.cpu-1.cpu.socket"]),
      instanceIds: ["board-1", "cpu-1"],
    });
  });

  it("blocks only the rule touched by an open conflict and still evaluates an independent known field", async () => {
    const config = cpuBoardConfig("plan-local-conflict");
    const drive = resolvedComponent("drive-1", "storage_drive", "drive.fixture");
    config.components.push(drive);
    const board = config.components[0]!;
    const cpu = config.components[1]!;
    const boardSocket = fact(board, "motherboard.cpu_socket", "AM5");
    const cpuSocket = fact(cpu, "cpu.socket", "AM5");
    const { contentHash: _contentHash, ...cpuSocketMaterial } = cpuSocket;
    const alternateSocket = await createFactRecord({
      ...cpuSocketMaterial,
      factId: "fact.cpu-1.cpu.socket-alternate",
      value: "AM4",
    });
    const conflict: ConflictSet = await createConflictSet({
      schemaVersion: "fact-conflict-v1",
      conflictSetId: "conflict.cpu-socket",
      subject: { kind: "product", skuId: "cpu.fixture", revision: "fixture" },
      field: "cpu.socket",
      factIds: ["fact.cpu-1.cpu.socket", "fact.cpu-1.cpu.socket-alternate"],
      reason: "value_disagreement",
      status: "open",
      resolutionFactIds: [],
      decisionIds: [],
      createdAt: PROGRESSIVE_FIXTURE_NOW,
    });
    const input = await progressiveInput(config, [
      boardSocket,
      cpuSocket,
      alternateSocket,
      fact(drive, "storage.boot_support", true),
    ], [], [conflict]);
    const evaluation = await evaluateProgressiveCompatibility(input);

    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.cpu-socket")).toMatchObject({
      verdict: "blocked", inputStatus: "conflicted", conflictSetIds: ["conflict.cpu-socket"],
    });
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.storage-boot-support")).toMatchObject({
      verdict: "pass", inputStatus: "complete", conflictSetIds: [],
    });
    expect(evaluation.decisions.find(({ ruleId }) => ruleId === "compat.cpu-socket")?.factIds)
      .not.toContain("fact.drive-1.storage.boot-support");
  });

  it("does not generate GPU/HBA/fan/cable requirements when those instances are absent", async () => {
    const config = cpuBoardConfig("plan-no-optional-phantoms");
    const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config));
    const absent = new Set(["gpu", "hba", "case_fan", "cable"]);
    expect(evaluation.requirements.some((requirement) => requirement.kind === "component"
      && requirement.predicates.some((predicate) => predicate.facetId === "identity.category"
        && typeof predicate.value === "string" && absent.has(predicate.value)))).toBe(false);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.pcie-topology")?.applicability).toBe("not_applicable");
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.fan-rgb-header-budget")?.applicability).toBe("not_applicable");
  });

  it("fails closed when executable code attempts to read an undeclared fact", async () => {
    const config = createEmptyBuildConfigV3("plan-undeclared-fact", "Undeclared fact", PROGRESSIVE_FIXTURE_NOW);
    config.components = [resolvedComponent("case-1", "case", "case.fixture")];
    const rule = BUILTIN_COMPATIBILITY_RULES.find(({ definition }) => definition.ruleId === "compat.firmware-path")!;
    const original = rule.evaluate;
    const spy = vi.spyOn(rule, "evaluate").mockImplementation((context) => {
      context.factsFor(config.components[0]!, "identity.model");
      return original(context);
    });
    try {
      const evaluation = await evaluateProgressiveCompatibility(await progressiveInput(config));
      expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.firmware-path")).toMatchObject({
        verdict: "blocked",
        inputStatus: "complete",
      });
      expect(evaluation.decisions.find(({ ruleId, message }) => ruleId === "compat.firmware-path"
        && message.includes("failed closed"))).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
