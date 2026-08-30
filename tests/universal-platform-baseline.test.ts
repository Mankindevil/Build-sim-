import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config/types";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { validateBuildConfigV3 } from "../src/topology/contracts";
import { validateLegacyFactSnapshot, validateLegacyFactRecord } from "../src/facts/contracts";
import { isSha256Hex } from "../src/hash";
import { validateUserObservation } from "../src/observations/contracts";
import { validateRequirementSpec } from "../src/requirements/contracts";
import { validateSolveRequest, validateSolveResult } from "../src/solver/contracts";
import { validateScenarioBranch } from "../src/scenarios/contracts";
import { validateImmutableListingCapture, validatePriceObservation, validatePriceHistoryPoint, validatePriceTarget, validatePriceTargetEvent, type ImmutableListingCapture, type PriceObservation } from "../src/price/contracts";
import { validateBackgroundJob } from "../src/jobs/contracts";
import { validateBackupManifest, validateBackupEnvelope, validateBackupVerification, validatePortableProfile, verifyPortableProfileClosure } from "../src/backup/contracts";
import { validateDoctorReport } from "../src/doctor/contracts";
import { validateSimulationInput } from "../src/simulation/contracts";
import { validateLogicalLayoutSelection, validateStorageLayoutEvaluation } from "../src/storage/contracts";
import { validateAssemblyRequirement, validateBuildProcedure, validateBundleItem, validateFirmwarePlan, type BuildProcedure, type FirmwarePlan, type ProcedureDependencyContext } from "../src/build-execution/contracts";
import { evaluateNegativeCompatibilityFixture, type NegativeCompatibilityFixtureCase } from "./helpers/universal-fixture-oracle";
import { validateFacetPredicate } from "../src/contracts/registries";

type Dict = Record<string, unknown>;
const entityIdKeys = new Set([
  "id", "instanceId", "roleDecisionId", "placementId", "connectionId", "layoutId", "vdevId", "caseId",
  "observationId", "procedureId", "stepId", "bundleItemId", "firmwarePlanId", "requirementId", "scenarioId",
  "jobId", "eventId", "workloadId", "constraintId", "metricId",
]);
const buildsDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/builds");
const readJson = (file: string): Dict => JSON.parse(readFileSync(resolve(buildsDir, file), "utf8")) as Dict;
const asDict = (value: unknown, label: string): Dict => {
  expect(value, label).toBeTypeOf("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as Dict;
};
const asArray = (value: unknown, label: string): unknown[] => {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
};
const stringValue = (value: unknown, label: string): string => {
  expect(value, label).toBeTypeOf("string");
  return String(value);
};

function expectUniqueIds(rows: unknown[], key: string, label: string): void {
  const ids = rows.map((row, index) => stringValue(asDict(row, `${label}[${index}]`)[key], `${label}[${index}].${key}`));
  expect(new Set(ids).size, `${label}.${key} must be unique`).toBe(ids.length);
}

function expectUniqueNestedEntityIds(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    const rows = value.filter((item): item is Dict => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    if (rows.length === value.length && rows.length > 1) {
      const keys = Object.keys(rows[0] ?? {}).filter((key) => entityIdKeys.has(key));
      for (const key of keys) if (rows.every((row) => typeof row[key] === "string")) expectUniqueIds(rows, key, label);
    }
    value.forEach((item, index) => expectUniqueNestedEntityIds(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value as Dict)) expectUniqueNestedEntityIds(child, `${label}.${key}`);
}

function expectRequiredBuildConfig(config: Dict, label: string): void {
  for (const key of [
    "schemaVersion", "id", "name", "updatedAt", "intent", "requirementSpec", "system",
    "components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets", "notes",
  ]) expect(config, `${label} missing ${key}`).toHaveProperty(key);
  expect(config.schemaVersion, `${label}.schemaVersion`).toBe("3.0.0");
  stringValue(config.id, `${label}.id`);
  for (const [key, idKey] of [
    ["components", "instanceId"], ["roleDecisions", "roleDecisionId"], ["placements", "placementId"],
    ["connections", "connectionId"], ["logicalLayouts", "layoutId"],
  ] as const) expectUniqueIds(asArray(config[key], `${label}.${key}`), idKey, `${label}.${key}`);
  for (const component of asArray(config.components, `${label}.components`)) {
    const row = asDict(component, `${label}.component`);
    expect(["planned", "ordered"]).toContain(row.state);
    expect(row.identity, `${label}.component.identity`).toBeDefined();
  }
  for (const layout of asArray(config.logicalLayouts, `${label}.logicalLayouts`)) {
    const row = asDict(layout, `${label}.logicalLayout`);
    for (const vdev of asArray(row.vdevs ?? [], `${label}.logicalLayout.vdevs`)) {
      const vdevRow = asDict(vdev, `${label}.vdev`);
      stringValue(vdevRow.vdevId, `${label}.vdevId`);
    }
  }
}

function parseListingCapture(value: unknown, label: string): ImmutableListingCapture {
  expect(validateImmutableListingCapture(value), `${label} must satisfy the exact immutable capture contract`).toEqual([]);
  return value as ImmutableListingCapture;
}

function expectGenericCatalogFactFixture(fixture: Dict): { skuIds: Set<string>; factIds: Set<string>; claimToSku: Map<string, string>; variantFactIds: Set<string> } {
  expect(fixture.schemaVersion).toBe("u0.catalog-fact-fixture/1.0.0");
  expect(fixture.provenance).toMatchObject({ namespace: "fixture", synthetic: true, officialProductionEvidence: false });
  const catalog = asDict(fixture.catalog, "generic catalog");
  expect(catalog.schemaVersion).toBe("u0.offline-catalog/1.0.0");
  expect(isSha256Hex(catalog.contentHash)).toBe(true);
  const entries = asArray(catalog.entries, "generic catalog entries");
  const skuIds = new Set<string>();
  const claimToSku = new Map<string, string>();
  const identityFactIds = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const entry = asDict(raw, `generic catalog entry ${index}`);
    expect(Object.keys(entry).sort()).toEqual(["brand", "category", "identityClaimIds", "identityFactId", "model", "revision", "skuId", "variant"].sort());
    const skuId = stringValue(entry.skuId, `generic catalog entry ${index}.skuId`);
    expect(skuId).toMatch(/^fixture\.[a-z0-9.-]+$/);
    expect(skuId).not.toMatch(/\.reference(?:$|[.-])/);
    expect(skuIds.has(skuId)).toBe(false);
    skuIds.add(skuId);
    for (const key of ["category", "brand", "model", "variant", "revision", "identityFactId"] as const) stringValue(entry[key], `generic catalog entry ${index}.${key}`);
    const claims = asArray(entry.identityClaimIds, `generic catalog entry ${index}.identityClaimIds`).map((claim) => stringValue(claim, "identity claim"));
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claimToSku.has(claim)).toBe(false);
      claimToSku.set(claim, skuId);
    }
    identityFactIds.add(String(entry.identityFactId));
  }
  const facts = asDict(fixture.facts, "generic facts");
  expect(facts.schemaVersion).toBe("u0.fact-store/1.0.0");
  const records = asArray(facts.records, "generic fact records");
  const factIds = new Set<string>();
  const factById = new Map<string, Dict>();
  for (const [index, raw] of records.entries()) {
    const record = asDict(raw, `generic fact ${index}`);
    expect(validateLegacyFactRecord(record), `generic fact ${index} must satisfy the explicit U0 legacy fact contract`).toEqual([]);
    const factId = stringValue(record.factId, `generic fact ${index}.factId`);
    expect(factIds.has(factId)).toBe(false);
    factIds.add(factId);
    factById.set(factId, record);
  }
  expect(identityFactIds).toEqual(new Set([...identityFactIds].filter((factId) => factIds.has(factId))));
  const snapshot = asDict(fixture.factSnapshot, "generic fact snapshot");
  expect(validateLegacyFactSnapshot(snapshot), "generic FactSnapshot must satisfy the explicit U0 legacy contract").toEqual([]);
  expect(new Set(asArray(snapshot.factIds, "generic snapshot factIds"))).toEqual(factIds);
  expect(asArray(snapshot.conflictSetIds, "generic snapshot conflictSetIds")).toHaveLength(0);
  const variantFactIds = new Set<string>();
  for (const binding of asArray(fixture.priceBindings, "generic price bindings")) {
    const row = asDict(binding, "price binding");
    const skuId = stringValue(row.skuId, "price binding skuId");
    expect(skuIds.has(skuId)).toBe(true);
    for (const factId of asArray(row.variantIdentityFactIds, "price binding variantIdentityFactIds")) {
      const id = stringValue(factId, "price variant fact id");
      expect(factIds.has(id)).toBe(true);
      variantFactIds.add(id);
      expect(factById.get(id)?.subject).toMatchObject({ kind: "product", skuId });
    }
  }
  return { skuIds, factIds, claimToSku, variantFactIds };
}

describe("U0 universal platform fixture baseline", () => {
  const manifest = readJson("manifest.json");
  const entries = asArray(manifest.fixtures, "manifest.fixtures").map((entry, index) => asDict(entry, `manifest.fixtures[${index}]`));

  it("indexes every fixture with its frozen schema, required sections, and unique entity ids", () => {
    expect(manifest.schemaVersion).toBe("u0.fixture-manifest/1.0.0");
    expect(manifest.id).toBe("u0-build-fixtures");
    expect(asArray(asDict(manifest.coverageRules, "manifest.coverageRules").verdicts, "manifest verdicts")).toEqual(["pass", "fail", "blocked"]);
    expect(asDict(manifest.coverageRules, "manifest.coverageRules").safeUnknownVerdict).toBe("blocked");
    const listedFiles = entries.map((entry) => stringValue(entry.file, "manifest fixture file"));
    expect(new Set(listedFiles).size).toBe(listedFiles.length);
    expect(new Set(listedFiles)).toEqual(new Set(readdirSync(buildsDir).filter((file) => /^u0-.*\.json$/.test(file))));

    const fixtureIds = new Set<string>();
    for (const file of listedFiles) {
      const fixture = readJson(file);
      if (file === "u0-generic-catalog-fact-snapshot.json") {
        expectGenericCatalogFactFixture(fixture);
        continue;
      }
      expect(fixture.schemaVersion).toBe("u0.fixture/1.0.0");
      const fixtureId = stringValue(fixture.id, `${file}.id`);
      expect(fixtureIds.has(fixtureId), `${file} duplicates fixture id ${fixtureId}`).toBe(false);
      fixtureIds.add(fixtureId);
      stringValue(fixture.purpose, `${file}.purpose`);
      expect(["golden", "capability", "negative"]).toContain(entries.find((entry) => entry.file === file)?.kind);
      expect(asArray(entries.find((entry) => entry.file === file)?.coverage, `${file}.coverage`).length).toBeGreaterThan(0);
      expectUniqueNestedEntityIds(fixture, file);
      const input = asDict(fixture.input, `${file}.input`);
      const expected = asDict(fixture.expected, `${file}.expected`);
      const decisions = asArray(expected.decisions, `${file}.expected.decisions`);
      const requirements = asArray(expected.requirements, `${file}.expected.requirements`);
      const invariants = asArray(expected.invariants, `${file}.expected.invariants`);
      expect(decisions.length, `${file} must have expected decisions`).toBeGreaterThan(0);
      expect(invariants.length, `${file} must have invariants`).toBeGreaterThan(0);
      expectUniqueIds(decisions, "domain", `${file}.expected.decisions`);
      expectUniqueIds(requirements, "id", `${file}.expected.requirements`);
      for (const decision of decisions) {
        const row = asDict(decision, `${file}.decision`);
        expect(["pass", "fail", "blocked"]).toContain(row.verdict);
        stringValue(row.reason, `${file}.decision.reason`);
      }
      for (const requirement of requirements) {
        const row = asDict(requirement, `${file}.requirement`);
        stringValue(row.id, `${file}.requirement.id`);
        expect(["hard", "soft", "important", "nice_to_have"]).toContain(row.strength);
        stringValue(row.status, `${file}.requirement.status`);
      }
      for (const invariant of invariants) stringValue(invariant, `${file}.invariant`);
      if (input.buildConfig !== undefined) {
        const config = asDict(input.buildConfig, `${file}.input.buildConfig`);
        expectRequiredBuildConfig(config, file);
        expect(validateBuildConfigV3(config), `${file} must satisfy the frozen BuildConfigV3 contract`).toEqual([]);
        if (file === "u0-blank.json") {
          for (const collection of ["components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets", "notes"]) {
            expect(asArray(config[collection], `${file}.${collection}`), `${file}.${collection} must remain empty`).toHaveLength(0);
          }
          expect(config.intent, `${file}.intent must remain unanswered`).toBeNull();
          expect(config.system, `${file}.system must remain unanswered`).toBeNull();
          expect(config.requirementSpec, `${file}.requirementSpec must remain unanswered`).toBeNull();
        }
      }
      if (input.observations !== undefined && file === "u0-user-observations.json") {
        const observations = asArray(input.observations, `${file}.input.observations`);
        expectUniqueIds(observations, "observationId", `${file}.input.observations`);
        observations.forEach((observation, index) => {
          expect(validateUserObservation(observation), `${file}.input.observations[${index}] must satisfy the frozen observation contract`).toEqual([]);
        });
      }
      if (input.requirementSpec !== undefined) {
        expect(validateRequirementSpec(input.requirementSpec), `${file}.input.requirementSpec must satisfy the frozen requirement contract`).toEqual([]);
      }
      if (input.solveRequest !== undefined) {
        expect(validateSolveRequest(input.solveRequest), `${file}.input.solveRequest must satisfy the frozen solver request contract`).toEqual([]);
      }
      if (input.solverResult !== undefined) {
        const solverResult = asDict(input.solverResult, `${file}.input.solverResult`);
        expect(validateSolveResult(solverResult as never, solverResult.unsatProof as never), `${file}.input.solverResult must satisfy the frozen solver result contract`).toEqual([]);
      }
      if (input.scenarioBranches !== undefined) {
        for (const [index, rawBranch] of asArray(input.scenarioBranches, `${file}.input.scenarioBranches`).entries()) {
          expect(validateScenarioBranch(rawBranch), `${file}.input.scenarioBranches[${index}] must satisfy the frozen scenario contract`).toEqual([]);
        }
      }
      if (input.observations !== undefined && file === "u0-price-history.json") {
        const observations = asArray(input.observations, `${file}.input.observations`) as unknown as PriceObservation[];
        const captures = new Map<string, ImmutableListingCapture>(asArray(input.listingCaptures, `${file}.input.listingCaptures`).map((capture) => {
          const parsed = parseListingCapture(capture, `${file}.listingCapture`);
          return [parsed.listingCaptureId, parsed] as const;
        }));
        expect(captures.size).toBe(observations.length);
        for (const [index, observation] of observations.entries()) expect(validatePriceObservation(observation as never, captures), `${file}.price observation ${index} must satisfy the frozen price contract`).toEqual([]);
        for (const [index, point] of asArray(input.history, `${file}.input.history`).entries()) expect(validatePriceHistoryPoint(point as never, observations as never[]), `${file}.history[${index}] must satisfy the frozen history contract`).toEqual([]);
        expect(validatePriceTarget(input.target as never), `${file}.target must satisfy the frozen target contract`).toEqual([]);
        for (const [index, event] of asArray(input.events, `${file}.input.events`).entries()) expect(validatePriceTargetEvent(event as never), `${file}.events[${index}] must satisfy the frozen event contract`).toEqual([]);
      }
      if (input.jobs !== undefined) for (const [index, job] of asArray(input.jobs, `${file}.input.jobs`).entries()) expect(validateBackgroundJob(job as never), `${file}.jobs[${index}] must satisfy the frozen job contract`).toEqual([]);
      if (input.backup !== undefined) {
        const backup = asDict(input.backup, `${file}.input.backup`);
        expect(validateBackupManifest(backup.manifest), `${file}.backup.manifest must satisfy the governed backup-v1 contract`).toEqual([]);
        expect(validateBackupEnvelope(backup.envelope, backup.manifest), `${file}.backup.envelope must satisfy authenticated production parameters`).toEqual([]);
        expect(validateBackupVerification(backup.verification), `${file}.backup.verification must contain entry and temporary-restore evidence`).toEqual([]);
      }
      if (input.portableManifest !== undefined) {
        const manifest = input.portableManifest as never;
        expect(validatePortableProfile(manifest), `${file}.portableManifest must satisfy the structural portable contract`).toMatchObject({ valid: true, exactReplayReady: false });
      }
      if (input.doctor !== undefined) expect(validateDoctorReport(input.doctor), `${file}.doctor self-reported checks without governed evidence artifacts must be rejected`).toContain("doctor report identity/version/hash/timestamp invalid");
      if (input.simulationInput !== undefined) expect(validateSimulationInput(input.simulationInput as never), `${file}.input.simulationInput must satisfy the frozen simulation contract`).toEqual([]);
      if (input.layouts !== undefined) for (const [index, layout] of asArray(input.layouts, `${file}.input.layouts`).entries()) expect(validateLogicalLayoutSelection(layout), `${file}.layouts[${index}] must satisfy the frozen layout selection contract`).toEqual([]);
      if (input.storageEvaluation !== undefined) expect(validateStorageLayoutEvaluation(input.storageEvaluation as never), `${file}.storageEvaluation must satisfy the frozen storage evaluation contract`).toEqual([]);
      if (input.plans !== undefined && file === "u0-firmware-paths.json") for (const [index, plan] of asArray(input.plans, `${file}.input.plans`).entries()) {
        expect(validateFirmwarePlan(plan), `${file}.plans[${index}] must satisfy the frozen firmware contract`).toEqual([]);
      }
      if (input.cases !== undefined && file === "u0-assembly-gaps.json") {
        for (const [caseIndex, assemblyCase] of asArray(input.cases, `${file}.input.cases`).entries()) {
          for (const [itemIndex, item] of asArray(asDict(assemblyCase, `${file}.case`).bundleItems, `${file}.case.bundleItems`).entries()) {
            expect(validateBundleItem(item), `${file}.cases[${caseIndex}].bundleItems[${itemIndex}] must satisfy BundleItem`).toEqual([]);
            for (const [predicateIndex, predicate] of asArray(asDict(item, `${file}.bundleItem`).specification, `${file}.bundleItem.specification`).entries()) {
              expect(validateFacetPredicate(predicate), `${file}.cases[${caseIndex}].bundleItems[${itemIndex}].specification[${predicateIndex}] must use a governed facet`).toEqual([]);
            }
          }
        }
        for (const [requirementIndex, requirement] of asArray(input.assemblyRequirements, `${file}.input.assemblyRequirements`).entries()) {
          expect(validateAssemblyRequirement(requirement), `${file}.assemblyRequirements[${requirementIndex}] must satisfy AssemblyRequirement`).toEqual([]);
        }
      }
      if (input.procedures !== undefined) {
        const procedures = asArray(input.procedures, `${file}.input.procedures`);
        const trustedContexts = new Map(asArray(fixture.trustedProcedureContexts, `${file}.trustedProcedureContexts`).map((rawContext) => {
          const context = asDict(rawContext, `${file}.trustedProcedureContext`);
          return [stringValue(context.procedureId, `${file}.trustedProcedureContext.procedureId`), context as unknown as ProcedureDependencyContext] as const;
        }));
        expectUniqueIds(procedures, "procedureId", `${file}.input.procedures`);
        for (const procedure of procedures) {
          const typedProcedure = procedure as BuildProcedure;
          const context = trustedContexts.get(typedProcedure.procedureId);
          expect(context, `${file}.procedure ${typedProcedure.procedureId} must have an independent trusted dependency context`).toBeDefined();
          expect(validateBuildProcedure(typedProcedure, context), `${file}.procedure must satisfy the frozen build procedure contract`).toEqual([]);
          const steps = asArray(asDict(procedure, `${file}.procedure`).steps, `${file}.procedure.steps`);
          expectUniqueIds(steps, "stepId", `${file}.procedure.steps`);
        }
      }
      if (input.cases !== undefined) expectUniqueIds(asArray(input.cases, `${file}.input.cases`), "caseId", `${file}.input.cases`);
    }
  });

  it("resolves every V3 identity, price variant, and variant-scoped fact through the offline catalog snapshot", () => {
    const oracle = expectGenericCatalogFactFixture(readJson("u0-generic-catalog-fact-snapshot.json"));
    const genericFact = new Set(oracle.factIds);
    const visited = new Set(["u0-generic-catalog-fact-snapshot.json"]);
    const collect = (value: unknown, key = ""): void => {
      if (Array.isArray(value)) { value.forEach((item) => collect(item, key)); return; }
      if (!value || typeof value !== "object") return;
      for (const [childKey, child] of Object.entries(value as Dict)) {
        if (childKey === "variantIdentityFactIds" || childKey === "evidenceFactIds" || childKey === "identityFactId") {
          const refs = Array.isArray(child) ? child : [child];
          for (const ref of refs) {
            const id = stringValue(ref, `${childKey} reference`);
            expect(genericFact.has(id), `${childKey} ${id} must resolve in the generic FactSnapshot`).toBe(true);
          }
        }
        collect(child, childKey);
      }
    };
    for (const entry of entries) {
      const file = stringValue(entry.file, "manifest fixture file");
      if (visited.has(file)) continue;
      const fixture = readJson(file);
      visited.add(file);
      collect(fixture);
      const input = asDict(fixture.input, `${file}.input`);
      const config = input.buildConfig === undefined ? undefined : asDict(input.buildConfig, `${file}.buildConfig`);
      for (const rawComponent of config ? asArray(config.components, `${file}.components`) : []) {
        const component = asDict(rawComponent, `${file}.component`);
        const identity = asDict(component.identity, `${file}.component.identity`);
        if (identity.status !== "resolved") continue;
        const skuId = stringValue(identity.skuId, `${file}.resolved skuId`);
        expect(oracle.skuIds.has(skuId), `${file} resolved SKU ${skuId} must be cataloged`).toBe(true);
        for (const claim of asArray(identity.identityClaimIds, `${file}.identityClaimIds`)) {
          const claimId = stringValue(claim, `${file}.identityClaimId`);
          expect(oracle.claimToSku.get(claimId), `${file} identity claim ${claimId} must resolve to its SKU`).toBe(skuId);
        }
      }
    }
    const price = readJson("u0-price-history.json");
    const priceInput = asDict(price.input, "price fixture input");
    expect(oracle.skuIds.has(stringValue(priceInput.skuId, "price skuId"))).toBe(true);
    for (const observation of asArray(priceInput.observations, "price observations")) {
      const row = asDict(observation, "price observation");
      expect(oracle.skuIds.has(stringValue(row.skuId, "price observation skuId"))).toBe(true);
      for (const ref of asArray(row.variantIdentityFactIds, "price variant refs")) expect(genericFact.has(stringValue(ref, "price variant fact"))).toBe(true);
    }
  });

  it("verifies the portable complete fixture against an independent trusted repository graph and lockfile", async () => {
    const fixture = readJson("u0-durable-jobs-portability-doctor.json");
    const input = asDict(fixture.input, "durable fixture input");
    const trust = asDict(input.portableTrust, "portable trusted context");
    const portable = input.portableManifest;
    const result = await verifyPortableProfileClosure(portable, {
      trustedRepositoryGraph: trust.trustedGraph as never,
      requiredRoots: asArray(trust.requiredRoots, "portable required roots") as string[],
      stagedIncludedRefs: asArray(trust.stagedIncludedRefs, "portable staged refs") as string[],
      artifactLockfile: trust.artifactLockfile as never,
    });
    expect(result, "complete portable package must close over trusted required refs").toMatchObject({ valid: true, exactReplayReady: true, missingRequiredRefs: [], errors: [] });
  });

  it("covers PC/workstation/NAS, ATX/mATX/ITX, blank/partial, and all three verdicts", () => {
    const coverage = entries.flatMap((entry) => asArray(entry.coverage, "manifest coverage").map(String));
    for (const token of ["atx", "mini-itx", "blank", "partial"]) expect(coverage).toContain(token);
    const intents = new Set<string>();
    const verdicts = new Set<string>();
    for (const entry of entries) {
      const file = stringValue(entry.file, "manifest fixture file");
      if (file === "u0-generic-catalog-fact-snapshot.json") continue;
      const fixture = readJson(file);
      const input = asDict(fixture.input, `${file}.input`);
      const config = input.buildConfig === undefined ? null : asDict(input.buildConfig, `${file}.buildConfig`);
      if (config && config.intent !== undefined && config.intent !== null) intents.add(String(asDict(config.intent, `${file}.intent`).value));
      if (config && config.components !== undefined) {
        const skuIds = asArray(config.components, `${file}.components`).map((item) => String(asDict(asDict(item, "component").identity, "component.identity").skuId ?? ""));
        if (skuIds.some((id) => id.includes("m-atx"))) coverage.push("m-atx");
      }
      for (const decision of asArray(asDict(fixture.expected, `${file}.expected`).decisions, `${file}.decisions`)) verdicts.add(String(asDict(decision, `${file}.decision`).verdict));
    }
    expect(intents).toEqual(new Set(["pc", "workstation", "nas"]));
    expect(verdicts).toEqual(new Set(["pass", "fail", "blocked"]));
    expect(entries.map((entry) => entry.file)).toEqual(expect.arrayContaining(["u0-blank.json", "u0-progressive-partial.json"]));
  });

  it("keeps user requirements, derived remediation, observations, and procedure steps structurally independent", () => {
    const requirements = readJson("u0-requirements-only.json");
    const requirementInput = asDict(asDict(requirements.input, "requirements input").requirementSpec, "requirementSpec");
    const requirementConfig = asDict(asDict(requirements.input, "requirements input").buildConfig, "requirements buildConfig");
    expect(asDict(requirementConfig.requirementSpec, "requirements buildConfig.requirementSpec")).toEqual(requirementInput);
    const derived = asArray(asDict(readJson("u0-progressive-partial.json").expected, "partial expected").requirements, "partial expected requirements");
    expect(derived.some((item) => asDict(item, "derived requirement").status === "residual")).toBe(true);
    const userConstraintIds = asArray(requirementInput.constraints, "user constraints").map((item) => String(asDict(item, "user constraint").constraintId));
    const userMetricIds = asArray(requirementInput.workloads, "user workloads").flatMap((workload) => asArray(asDict(workload, "user workload").metrics, "user metrics").map((metric) => String(asDict(metric, "user metric").metricId)));
    const derivedIds = derived.filter((item) => asDict(item, "derived requirement").status === "residual").map((item) => String(asDict(item, "derived requirement").id));
    expect(derivedIds.some((id) => userConstraintIds.includes(id) || userMetricIds.includes(id))).toBe(false);
    for (const item of derived) {
      const row = asDict(item, "derived requirement");
      for (const foreignKey of ["method", "attachmentRefs", "phase", "action", "observationId", "stepId"]) expect(row).not.toHaveProperty(foreignKey);
    }
    const observations = asArray(asDict(readJson("u0-user-observations.json").input, "observations input").observations, "observations");
    for (const observation of observations) {
      const row = asDict(observation, "observation");
      for (const foreignKey of ["requirementId", "requirementSpec", "phase", "action", "stepId"]) expect(row).not.toHaveProperty(foreignKey);
      stringValue(row.observationId, "observationId");
      stringValue(row.planId, "observation.planId");
      stringValue(row.subjectRevisionHash, "observation.subjectRevisionHash");
    }
    const procedures = asArray(asDict(readJson("u0-procedures-windows-truenas.json").input, "procedures input").procedures, "procedures");
    for (const procedure of procedures) for (const step of asArray(asDict(procedure, "procedure").steps, "procedure steps")) {
      const row = asDict(step, "procedure step");
      for (const foreignKey of ["observationId", "requirementSpec", "constraintId"]) expect(row).not.toHaveProperty(foreignKey);
      stringValue(row.stepId, "stepId");
      expect(Array.isArray(row.requirementIds)).toBe(true);
      expect(Array.isArray(row.instanceIds)).toBe(true);
      stringValue(row.dependencyHash, "step.dependencyHash");
    }
  });

  it("evaluates every negative compatibility input through an independent frozen oracle", () => {
    const fixture = readJson("u0-negative-compatibility.json");
    const inputCases = asArray(asDict(fixture.input, "negative input").cases, "negative cases");
    const decisions = new Map(asArray(asDict(fixture.expected, "negative expected").decisions, "negative decisions").map((item) => {
      const row = asDict(item, "negative decision");
      return [String(row.domain), String(row.verdict)] as const;
    }));
    for (const item of inputCases) {
      const row = asDict(item, "negative case");
      const verdict = evaluateNegativeCompatibilityFixture(row as unknown as NegativeCompatibilityFixtureCase);
      expect(["fail", "blocked"]).toContain(verdict);
      const decisionDomain = String(row.caseId) === "unknown-safety-field" ? "unknown-safety" : String(row.domain);
      expect(decisions.get(decisionDomain)).toBe(verdict);
    }
    expect(decisions.get("unknown-safety")).toBe("blocked");
  });

  it("runs the preserved v2-empty fixture through the current parser/evaluator as a legacy baseline", () => {
    const legacyRaw = readJson("v2-empty.json");
    expect(legacyRaw.schemaVersion).toBe("2.0.0");
    expect(asArray(manifest.preservedLegacyFixtures, "manifest.preservedLegacyFixtures")).toContain("v2-empty.json");
    const config = parseConfig(JSON.stringify(legacyRaw));
    expect(config.caseId).toBe("");
    expect(config.boardId).toBe("");
    expect(config.cpuId).toBe("");
    expect(config.selection).toMatchObject({ psuId: "", coolerId: "", gpuId: "", memoryId: "", diskCount: 0 });
    const evaluation = evaluateBuild(config, loadBundledCatalog());
    expect(evaluation.readiness.status).toBe("incomplete");
    expect(evaluation.bom).toEqual([]);
    expect(evaluation.price.items).toEqual([]);
    expect(evaluation.geometry).toEqual([]);
    expect(evaluation.routing.cables).toEqual([]);
    expect(evaluation.routing.ports).toEqual([]);
    expect(evaluation.wiring.bayPaths).toEqual([]);
    expect(evaluation.assembly.steps).toEqual([]);
  });
});
