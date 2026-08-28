import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type BuildConfigDocument } from "../src/config/types";
import { hashPlanConfig, sha256Hex } from "../src/plans/canonical";
import { hashPlanConfigRuntime, validatePlanConfigRuntime, validatePlanRuntime, validatePlanVersionRuntime } from "../src/plans/canonical-runtime.mjs";
import { createDefaultN6Config, createEmptyBuildConfig } from "../src/plans/default-plan";
import { planEvidenceBindingId } from "../src/plans/validation";
import type { BuildConfigV3 } from "../src/topology/contracts";
import { validateBuildConfigV3 } from "../src/topology/validation";

describe("Plan config cross-runtime hashing", () => {
  it("matches the legacy V2 hash contract", async () => {
    const config = createDefaultN6Config("plan-hash-runtime", "2026-08-27T13:30:00.000Z");
    expect(hashPlanConfigRuntime(config)).toBe(await hashPlanConfig(config));
  });

  it("fails closed on malformed V2 fields while retaining a zero-hardware draft", () => {
    const valid = createDefaultN6Config("plan-v2-runtime", "2026-08-27T13:30:00.000Z");
    const empty = createEmptyBuildConfig("plan-v2-empty", "2026-08-27T13:30:00.000Z");
    const missingCase = structuredClone(valid) as unknown as Record<string, unknown>;
    delete missingCase.caseId;
    const negativeBom = structuredClone(valid);
    negativeBom.bom = [{ skuId: "case.jonsbo-n6", qty: -9, bucket: "owned" }];
    const unknown = { ...structuredClone(valid), hacked: true };
    expect(validatePlanConfigRuntime(valid, { topologyV3Enabled: false })).toEqual([]);
    expect(validatePlanConfigRuntime(empty, { topologyV3Enabled: false })).toEqual([]);
    expect(parseConfig(JSON.stringify(empty))).toEqual(empty);
    for (const candidate of [missingCase, negativeBom, unknown]) {
      expect(validatePlanConfigRuntime(candidate, { topologyV3Enabled: false })).not.toEqual([]);
      expect(() => parseConfig(JSON.stringify(candidate))).toThrow(/Malformed BuildConfig/);
    }
  });

  it("validates evidence binding owner/content closure in both drafts and versions", async () => {
    const config = createDefaultN6Config("plan-evidence-runtime", "2026-08-27T13:30:00.000Z");
    const planId = config.id;
    const versionId = "version-evidence-runtime";
    const contentHash = "a".repeat(64);
    const bindingBase = {
      schemaVersion: "1.0.0" as const, planId,
      documentId: `doc-sha256-${contentHash}` as `doc-sha256-${string}`, contentHash,
      subject: { kind: "plan" as const, id: planId }, purposes: ["identity" as const],
      locators: [{ page: 1 }], boundAt: "2026-08-27T13:30:00.000Z",
    };
    const binding = { ...bindingBase, id: planEvidenceBindingId(bindingBase) };
    const plan = {
      schemaVersion: "1.0.0", id: planId, name: config.name, status: "active",
      createdAt: config.updatedAt, updatedAt: config.updatedAt, activeVersionId: null, draftRevision: 0,
      draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [binding], dirty: true, updatedAt: config.updatedAt },
      metadata: {},
    };
    expect(validatePlanRuntime(plan, { topologyV3Enabled: false })).toEqual([]);
    expect(validatePlanRuntime({ ...plan, injected: true }, { topologyV3Enabled: false })).not.toEqual([]);
    expect(validatePlanRuntime({ ...plan, draft: { ...plan.draft, derivedEvaluation: {} } }, { topologyV3Enabled: false })).not.toEqual([]);
    expect(validatePlanRuntime({ ...plan, metadata: { injected: true } }, { topologyV3Enabled: false })).not.toEqual([]);
    expect(validatePlanRuntime({ ...plan, draft: { ...plan.draft, evidenceBindings: [{ ...binding, planId: "plan-forged-owner" }] } }, { topologyV3Enabled: false }))
      .toContain("evidenceBindings.0: evidence binding plan owner is invalid");

    const versionBinding = { ...binding, planVersionId: versionId };
    const version = {
      schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: config.updatedAt,
      reason: "manual-save", config, configHash: await hashPlanConfig(config), parentVersionId: null,
      evidenceBindings: [versionBinding], evidenceHash: await sha256Hex([versionBinding]),
    };
    expect(validatePlanVersionRuntime(version, { topologyV3Enabled: false })).toEqual([]);
    expect(validatePlanVersionRuntime({ ...version, injected: true }, { topologyV3Enabled: false })).not.toEqual([]);
    expect(validatePlanVersionRuntime({ ...version, summary: 42 }, { topologyV3Enabled: false })).not.toEqual([]);
    expect(validatePlanVersionRuntime({ ...version, evaluatedAt: 42 }, { topologyV3Enabled: false })).not.toEqual([]);
    const forgedBinding = { ...versionBinding, contentHash: "c".repeat(64) };
    const forgedVersion = { ...version, evidenceBindings: [forgedBinding], evidenceHash: await sha256Hex([forgedBinding]) };
    expect(validatePlanVersionRuntime(forgedVersion, { topologyV3Enabled: false }))
      .toContain("evidenceBindings.0: evidence binding identity/hash is invalid");
    const wrongVersionOwner = { ...versionBinding, planVersionId: "version-forged-owner" };
    expect(validatePlanVersionRuntime({ ...version, evidenceBindings: [wrongVersionOwner], evidenceHash: await sha256Hex([wrongVersionOwner]) }, { topologyV3Enabled: false }))
      .toContain("evidenceBindings.0: version evidence binding owner is invalid");
    const randomIdDuplicate = { ...binding, id: `binding-sha256-${"d".repeat(64)}` };
    expect(validatePlanRuntime({ ...plan, draft: { ...plan.draft, evidenceBindings: [binding, randomIdDuplicate] } }, { topologyV3Enabled: false }))
      .toContain("evidenceBindings.1: binding semantic identity is duplicated");
  });

  it("matches configV3Hash for governed nested sets and requirement ordering", async () => {
    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/builds/u0-requirements-only.json"), "utf8")) as { input: { buildConfig: BuildConfigV3 } };
    const config = structuredClone(fixture.input.buildConfig) as BuildConfigDocument;
    expect(hashPlanConfigRuntime(config)).toBe(await hashPlanConfig(config));
  });

  it("normalizes NFD before sorting nested requirement and vdev identities", async () => {
    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/builds/u0-requirements-only.json"), "utf8")) as { input: { buildConfig: BuildConfigV3 } };
    const config = structuredClone(fixture.input.buildConfig);
    const workload = structuredClone(config.requirementSpec!.workloads[0]!);
    workload.workloadId = "e\u0301";
    (workload as typeof workload & { evidenceOrBenchmarkRefs: string[] }).evidenceOrBenchmarkRefs = ["e\u0301", "f"];
    config.requirementSpec!.workloads.push({ ...structuredClone(workload), workloadId: "f" });
    config.requirementSpec!.constraints.push({ ...structuredClone(config.requirementSpec!.constraints[0]!), constraintId: "e\u0301" });
    config.components.push(
      { instanceId: "disk-e", kind: "storage_drive", role: "data-e", state: "planned", identity: { status: "unresolved", userText: "disk e" }, source: "agent" },
      { instanceId: "disk-f", kind: "storage_drive", role: "data-f", state: "planned", identity: { status: "unresolved", userText: "disk f" }, source: "agent" },
    );
    config.logicalLayouts.push({
      layoutId: "layout-nfd", bootPoolDiskIds: [], spareDiskIds: [],
      vdevs: [
        { vdevId: "e\u0301", topology: "stripe", diskInstanceIds: ["disk-e"] },
        { vdevId: "f", topology: "stripe", diskInstanceIds: ["disk-f"] },
      ],
    });
    expect(hashPlanConfigRuntime(config)).toBe(await hashPlanConfig(config));
  });

  it("agrees with the TS V3 validator on valid and fail-closed graph/requirement mutations", async () => {
    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/builds/u0-requirements-only.json"), "utf8")) as { input: { buildConfig: BuildConfigV3 } };
    const valid = fixture.input.buildConfig;
    const derived = { ...structuredClone(valid), requirementNodes: [] } as unknown as BuildConfigV3;
    const missingReference = structuredClone(valid);
    missingReference.placements.push({ placementId: "bad-placement", componentInstanceId: "missing", mountOwnerInstanceId: "missing", mountId: "slot" });
    const invalidMetric = structuredClone(valid);
    (invalidMetric.requirementSpec!.workloads[0]!.metrics[0] as any).metricId = "metric.not-governed";
    const missingBenchmark = structuredClone(valid);
    delete (missingBenchmark.requirementSpec!.workloads[0]!.metrics[0] as any).benchmarkId;
    delete (missingBenchmark.requirementSpec!.workloads[0]!.metrics[0] as any).benchmarkContext;
    const invalidFacetSemantics = structuredClone(valid);
    Object.assign((invalidFacetSemantics.requirementSpec!.constraints[0] as any).predicate, { facetId: "case.side_panel", operator: "gte", value: 42, unitId: "mm" });
    const invalidNotes = structuredClone(valid);
    (invalidNotes as any).notes = [42];
    const invalidUnicodeValue = structuredClone(valid);
    invalidUnicodeValue.notes = ["\ud800"];
    const invalidUnicodeKey = structuredClone(valid) as BuildConfigV3 & Record<string, unknown>;
    invalidUnicodeKey["bad\ud800"] = "value";
    const nfcCollision = structuredClone(valid);
    nfcCollision.components.push(
      { instanceId: "é", kind: "case_fan", role: "fan-a", state: "planned", identity: { status: "unresolved", userText: "a" }, source: "agent" },
      { instanceId: "e\u0301", kind: "case_fan", role: "fan-b", state: "planned", identity: { status: "unresolved", userText: "b" }, source: "agent" },
    );
    const crossLayoutReuse = structuredClone(valid);
    crossLayoutReuse.components.push({ instanceId: "disk-shared", kind: "storage_drive", role: "data", state: "planned", identity: { status: "unresolved", userText: "disk" }, source: "agent" });
    crossLayoutReuse.logicalLayouts.push(
      { layoutId: "layout-a", bootPoolDiskIds: ["disk-shared"], vdevs: [], spareDiskIds: [] },
      { layoutId: "layout-b", bootPoolDiskIds: [], vdevs: [], spareDiskIds: ["disk-shared"] },
    );
    const reusedEndpoint = structuredClone(valid);
    reusedEndpoint.components.push(
      { instanceId: "node-a", kind: "nic", role: "nic-a", state: "planned", identity: { status: "unresolved", userText: "a" }, source: "agent" },
      { instanceId: "node-b", kind: "nic", role: "nic-b", state: "planned", identity: { status: "unresolved", userText: "b" }, source: "agent" },
      { instanceId: "node-c", kind: "nic", role: "nic-c", state: "planned", identity: { status: "unresolved", userText: "c" }, source: "agent" },
    );
    reusedEndpoint.connections.push(
      { connectionId: "connection-a", from: { instanceId: "node-a", portId: "p0" }, to: { instanceId: "node-b", portId: "p0" }, status: "planned" },
      { connectionId: "connection-b", from: { instanceId: "node-a", portId: "p0" }, to: { instanceId: "node-c", portId: "p0" }, status: "planned" },
    );
    for (const candidate of [valid, derived, missingReference, invalidMetric, missingBenchmark, invalidFacetSemantics, invalidNotes, invalidUnicodeValue, invalidUnicodeKey, nfcCollision, crossLayoutReuse, reusedEndpoint]) {
      expect(validatePlanConfigRuntime(candidate).length === 0).toBe(validateBuildConfigV3(candidate).length === 0);
    }
  });

  it("keeps the persisted-version validator total for hostile Unicode", async () => {
    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/builds/u0-requirements-only.json"), "utf8")) as { input: { buildConfig: BuildConfigV3 } };
    const config = structuredClone(fixture.input.buildConfig);
    config.notes = ["\ud800"];
    expect(() => validatePlanVersionRuntime({
      schemaVersion: "1.0.0", id: "version-hostile", planId: config.id, versionNumber: 1,
      createdAt: "2026-08-27T13:30:00.000Z", reason: "manual-save", summary: "hostile",
      config, configHash: "0".repeat(64), parentVersionId: null,
    })).not.toThrow();
    expect(validatePlanVersionRuntime({
      schemaVersion: "1.0.0", id: "version-hostile", planId: config.id, versionNumber: 1,
      createdAt: "2026-08-27T13:30:00.000Z", reason: "manual-save", summary: "hostile",
      config, configHash: "0".repeat(64), parentVersionId: null,
    })).toContain("config: build config contains ill-formed Unicode text");
  });
});
