import crypto from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { catalogCandidateInputHash } from "../scripts/price-server/catalog/contracts.mjs";
import { inspectUrl } from "../scripts/price-server/catalog/service.mjs";
import { confirmDraft, createDraft, previewDraft, rejectDraft } from "../scripts/price-server/catalog/write.mjs";

function officialField(url: string, id: string, field: string, value: unknown): any {
  return {
    provenanceId: id,
    field,
    value,
    evidence: "official",
    sourceUrl: url,
    sourceKind: "official-page",
    retrievedAt: "2026-08-26T00:00:00.000Z",
    extractor: "governed-draft-fixture-v1",
    locator: `fixture:${field}`,
    snippet: `${field}: ${String(value)}`,
    confidence: 1,
    unexpectedMetadata: "must not reach confirmed sku",
  };
}

function governedCandidate(input: { candidateId: string; category?: "motherboard" | "gpu" | "psu"; model?: string; mpn?: string; fields?: any[] }): any {
  const category = input.category ?? "motherboard";
  const model = input.model ?? "No MPN Board";
  const brand = category === "gpu" ? "MSI" : category === "psu" ? "Seasonic" : "ASUS";
  const domain = category === "gpu" ? "www.msi.com" : category === "psu" ? "seasonic.com" : "www.asus.com";
  const url = `https://${domain}/governed/${input.candidateId}`;
  const fields = input.fields ?? [
    officialField(url, `${input.candidateId}-brand`, "brand", brand),
    officialField(url, `${input.candidateId}-model`, "model", model),
    ...(input.mpn ? [officialField(url, `${input.candidateId}-mpn`, "mpn", input.mpn)] : []),
    officialField(url, `${input.candidateId}-length`, "dims.lengthMm", 244),
    officialField(url, `${input.candidateId}-width`, "dims.widthMm", 244),
  ];
  return {
    candidateId: input.candidateId,
    query: { raw: `${brand} ${model}`, brand, model, ...(input.mpn ? { mpn: input.mpn } : {}), category, locale: "zh-CN", tokens: [brand.toLocaleLowerCase(), ...model.toLocaleLowerCase().split(/\s+/)] },
    brand, model, ...(input.mpn ? { mpn: input.mpn } : {}), category, title: `${brand} ${model}`, url, canonicalUrl: url,
    source: { kind: "official", domain, retrievedAt: "2026-08-26T00:00:00.000Z", httpStatus: 200, finalUrl: url },
    official: { trustStatus: "trusted", brand, pageKind: category === "gpu" ? "spec" : "product", reasons: [] },
    identity: { verdict: "exact", score: input.mpn ? 1 : 0.95, criticalMatches: [], criticalConflicts: [], unknowns: [], reasons: [input.mpn ? "official MPN exactly matches" : "official brand and model exactly match"], agentReviewRequired: false },
    match: { score: input.mpn ? 1 : 0.95, kind: input.mpn ? "exact-mpn" : "brand-model", reasons: ["fixture exact"] },
    extraction: { status: "ok", fieldsFound: fields.length, fieldsMissing: 0, adapter: "governed-draft-fixture-v1", contentHash: crypto.createHash("sha256").update(input.candidateId).digest("hex") },
    fields,
    conflicts: [],
  };
}

function enrichmentOptions(candidate: any, root: string, catalogPath: string) {
  return {
    candidate,
    expectedHash: catalogCandidateInputHash(candidate),
    autoEnrichTrustedOfficial: true,
    catalogWriteEnabled: true,
    catalogPath,
    draftRoot: path.join(root, "drafts"),
    rollbackRoot: path.join(root, "rollback"),
    rollbackManifestPath: path.join(root, "rollback", "catalog-manifest.json"),
    auditRoot: path.join(root, "audit"),
  };
}

async function emptyCatalog(catalogPath: string): Promise<void> {
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-26", skus: [] }), "utf8");
}

function existingBoard(id: string, dims: Record<string, unknown> = { evidence: "inferred", widthMm: 244 }): any {
  return {
    id,
    category: "motherboard",
    brand: "ASUS",
    model: "No MPN Board",
    name: "ASUS No MPN Board",
    dims,
    power: { evidence: "unknown", retainedLimitW: 75 },
    harness: { evidence: "official", retainedConnector: "ATX-24-pin" },
    attrs: { retainedChipset: "W680" },
    price: { currency: "CNY", paid: 2_799, historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    tags: ["owned", "reviewed"],
    appearance: { image: "assets/retained-board.png" },
    provenance: [{ provenanceId: `${id}-existing`, field: "attrs.retainedChipset", value: "W680", evidence: "official" }],
  };
}

async function writeCatalog(catalogPath: string, skus: any[], extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-26", skus, ...extra }), "utf8");
}

describe("governed catalog draft security and inference", () => {
  it("derives GPU slots from official thickness and requires length, slots and TGP at confirmation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-gpu-draft-"));
    const catalogPath = path.join(root, "catalog.json");
    const id = `gpu-${Date.now()}`;
    const url = `https://www.msi.com/governed/${id}`;
    const fields = [
      officialField(url, `${id}-brand`, "brand", "MSI"),
      officialField(url, `${id}-model`, "model", "RTX 3070 VENTUS 2X OC"),
      officialField(url, `${id}-length`, "dims.lengthMm", 232),
      officialField(url, `${id}-thickness`, "dims.thicknessMm", 52),
      officialField(url, `${id}-tgp`, "power.tgpW", 220),
      officialField(url, `${id}-noise`, "attrs.noiseDba", 35),
      officialField(url, `${id}-temperature`, "attrs.maxOperatingTempC", 93),
    ];
    const candidate = governedCandidate({ candidateId: id, category: "gpu", model: "RTX 3070 VENTUS 2X OC", fields });
    try {
      await emptyCatalog(catalogPath);
      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      const inferred = draft.fields.find((field: any) => field.field === "dims.slots");
      expect(draft).toMatchObject({ status: "draft", missing: [], proposed: { dims: { lengthMm: 232, thicknessMm: 52, slots: 3, evidence: "inferred" }, power: { tgpW: 220 }, attrs: { noiseDba: 35, maxOperatingTempC: 93 } } });
      expect(inferred).toMatchObject({ value: 3, evidence: "inferred", sourceUrl: url, extractor: "inferred-pcie-slot-pitch-v1", derivedFromProvenanceId: `${id}-thickness` });
      expect(inferred.note).toContain("20.32 mm");
      expect(draft.fields.some((field: any) => /idle/i.test(field.field))).toBe(false);
      expect(draft.fields.find((field: any) => field.field === "attrs.noiseDba")).toMatchObject({ value: 35, evidence: "official" });

      const confirmed = await confirmDraft(draft.draftId, { ...enrichmentOptions(candidate, root, catalogPath), approved: true, expectedHash: draft.expectedHash });
      expect(confirmed).toMatchObject({ status: "confirmed", sku: { dims: { slots: 3, evidence: "inferred" }, power: { tgpW: 220 } } });
      expect(JSON.stringify(confirmed.sku)).not.toContain("unexpectedMetadata");
      expect(JSON.stringify(confirmed.sku)).not.toContain("idleW");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps an exact but incomplete GPU draft reviewable and blocks confirmation until TGP exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-gpu-missing-"));
    const catalogPath = path.join(root, "catalog.json");
    const id = `gpu-missing-${Date.now()}`;
    const url = `https://www.msi.com/governed/${id}`;
    const fields = [
      officialField(url, `${id}-brand`, "brand", "MSI"),
      officialField(url, `${id}-model`, "model", "RTX 3070 VENTUS 2X OC"),
      officialField(url, `${id}-length`, "dims.lengthMm", 232),
      officialField(url, `${id}-thickness`, "dims.thicknessMm", 52),
    ];
    const candidate = governedCandidate({ candidateId: id, category: "gpu", model: "RTX 3070 VENTUS 2X OC", fields });
    try {
      await emptyCatalog(catalogPath);
      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      expect(draft).toMatchObject({ status: "draft", missing: ["power.tgpW"] });
      const confirmed = await confirmDraft(draft.draftId, { ...enrichmentOptions(candidate, root, catalogPath), approved: true, expectedHash: draft.expectedHash });
      expect(confirmed.status).toBe("blocked");
      expect(confirmed.reasons).toContain("missing power.tgpW");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("confirms no-MPN exact brand/model drafts idempotently without duplicate IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-no-mpn-"));
    const catalogPath = path.join(root, "catalog.json");
    const firstCandidate = governedCandidate({ candidateId: `no-mpn-a-${Date.now()}`, model: "No MPN Board" });
    const secondCandidate = governedCandidate({ candidateId: `no-mpn-b-${Date.now()}`, model: "No MPN Board" });
    try {
      await emptyCatalog(catalogPath);
      const firstDraft = await runAutoEnrichment(firstCandidate.candidateId, enrichmentOptions(firstCandidate, root, catalogPath));
      const first = await confirmDraft(firstDraft.draftId, { ...enrichmentOptions(firstCandidate, root, catalogPath), approved: true, expectedHash: firstDraft.expectedHash });
      const secondDraft = await runAutoEnrichment(secondCandidate.candidateId, enrichmentOptions(secondCandidate, root, catalogPath));
      const second = await confirmDraft(secondDraft.draftId, { ...enrichmentOptions(secondCandidate, root, catalogPath), approved: true, expectedHash: secondDraft.expectedHash });
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(first).toMatchObject({ status: "confirmed", sku: { brand: "ASUS", model: "No MPN Board" } });
      expect(first.sku).not.toHaveProperty("mpn");
      expect(second).toMatchObject({ status: "confirmed", skuId: first.skuId, changedFields: ["provenance"] });
      expect(second).toMatchObject({ catalogChanged: true, created: false, sku: catalog.skus[0] });
      expect(catalog.skus).toHaveLength(1);
      expect(catalog.skus[0].id).toBe(first.skuId);
      expect(catalog.skus[0].provenance).toHaveLength(first.sku.provenance.length + secondCandidate.fields.length);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("previews an existing SKU without persistence, fills only missing facts and preserves owned metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-existing-preview-"));
    const catalogPath = path.join(root, "catalog.json");
    const draftRoot = path.join(root, "drafts");
    const base = existingBoard("board.review-existing");
    const candidate = governedCandidate({ candidateId: `existing-preview-${Date.now()}`, model: "No MPN Board" });
    candidate.skuId = base.id;
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await writeCatalog(catalogPath, [base]);
      const preview = await previewDraft(candidate.candidateId, {}, options);
      expect(preview).toMatchObject({
        status: "preview",
        operation: "update",
        baseSkuId: base.id,
        baseSkuHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        baseCatalogVersion: "2.0.0",
        candidateInputHash: catalogCandidateInputHash(candidate),
        proposed: {
          id: base.id,
          dims: { evidence: "official", lengthMm: 244, widthMm: 244 },
          power: base.power,
          harness: base.harness,
          price: base.price,
          tags: base.tags,
          attrs: base.attrs,
          appearance: { image: "assets/retained-board.png", page: candidate.canonicalUrl },
        },
        conflicts: [],
        missing: [],
      });
      expect(preview.changedFields).toEqual(expect.arrayContaining(["dims.lengthMm", "dims.evidence", "appearance.page", "provenance"]));
      await expect(access(draftRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const persisted = await createDraft(candidate.candidateId, {}, { ...options, expectedDraftHash: preview.inputHash });
      expect(persisted).toMatchObject({ status: "draft", draftId: preview.draftId, candidateId: preview.candidateId, inputHash: preview.inputHash });
      const confirmed = await confirmDraft(persisted.draftId, { ...options, approved: true, expectedHash: persisted.inputHash });
      expect(confirmed).toMatchObject({ status: "confirmed", skuId: base.id, created: false, catalogChanged: true, changedFields: preview.changedFields });
      const saved = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(saved.skus).toHaveLength(1);
      expect(saved.skus[0]).toMatchObject({ id: base.id, price: base.price, tags: base.tags, harness: base.harness, attrs: base.attrs, dims: { evidence: "official", lengthMm: 244, widthMm: 244 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps preview and persisted draft IDs deterministic for reviewed manual selections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-preview-hash-"));
    const catalogPath = path.join(root, "catalog.json");
    const candidate = governedCandidate({ candidateId: `preview-hash-${Date.now()}`, model: "Preview Hash Board" });
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await emptyCatalog(catalogPath);
      const selections = { "dims.heightMm": 40 };
      const preview = await previewDraft(candidate.candidateId, selections, options);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const stale = await createDraft(candidate.candidateId, selections, { ...options, expectedDraftHash: "f".repeat(64) });
      expect(stale).toMatchObject({ status: "blocked", reasons: ["draft preview hash mismatch"] });
      await expect(access(path.join(root, "drafts"))).rejects.toMatchObject({ code: "ENOENT" });
      const draft = await createDraft(candidate.candidateId, selections, { ...options, expectedDraftHash: preview.inputHash });
      expect(draft).toMatchObject({ status: "draft", draftId: preview.draftId, candidateId: preview.candidateId, inputHash: preview.inputHash });
      expect(draft.fields.find((field: any) => field.field === "dims.heightMm")).toMatchObject({ value: 40, sourceKind: "manual", retrievedAt: candidate.source.retrievedAt });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports different existing values as conflicts and blocks confirmation without overwriting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-existing-conflict-"));
    const catalogPath = path.join(root, "catalog.json");
    const base = existingBoard("board.review-conflict", { evidence: "unknown", lengthMm: 250, widthMm: 244 });
    const candidate = governedCandidate({ candidateId: `existing-conflict-${Date.now()}`, model: "No MPN Board" });
    candidate.skuId = base.id;
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await writeCatalog(catalogPath, [base]);
      const preview = await previewDraft(candidate.candidateId, {}, options);
      expect(preview).toMatchObject({ status: "preview", operation: "update", proposed: { id: base.id, dims: { lengthMm: 250, widthMm: 244, evidence: "unknown" } } });
      expect(preview.conflicts).toContainEqual({ field: "dims.lengthMm", existing: 250, proposed: 244, reason: "existing governed value differs from official candidate" });
      const draft = await createDraft(candidate.candidateId, {}, { ...options, expectedDraftHash: preview.inputHash });
      const confirmed = await confirmDraft(draft.draftId, { ...options, approved: true, expectedHash: draft.inputHash });
      expect(confirmed).toMatchObject({ status: "blocked", reasons: ["unresolved draft field conflict"] });
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toEqual([base]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks a candidate SKU link when the official page resolves to a same-brand sibling model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-existing-sibling-"));
    const catalogPath = path.join(root, "catalog.json");
    const base = existingBoard("board.review-sibling");
    const candidate = governedCandidate({ candidateId: `existing-sibling-${Date.now()}`, model: "No MPN Board" });
    candidate.skuId = base.id;
    candidate.fields = candidate.fields.map((field: any) => field.field === "model" ? { ...field, value: "No MPN Board Sibling" } : field);
    candidate.extraction = { ...candidate.extraction, fieldsFound: candidate.fields.length };
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await writeCatalog(catalogPath, [base]);
      const preview = await previewDraft(candidate.candidateId, {}, options);
      expect(preview).toMatchObject({ status: "blocked" });
      expect(preview.reasons).toContain("candidate catalog SKU official model mismatch");
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toEqual([base]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows a controlled catalog model when an official family page omits only its suffix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-existing-family-"));
    const catalogPath = path.join(root, "catalog.json");
    const base = { ...existingBoard("board.review-family"), model: "No MPN Board 2026", name: "ASUS No MPN Board 2026" };
    const candidate = governedCandidate({ candidateId: `existing-family-${Date.now()}`, model: "No MPN Board" });
    candidate.skuId = base.id;
    candidate.query = { ...candidate.query, raw: "ASUS No MPN Board 2026", model: base.model };
    candidate.model = base.model;
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await writeCatalog(catalogPath, [base]);
      const preview = await previewDraft(candidate.candidateId, {}, options);
      expect(preview).toMatchObject({ status: "preview", operation: "update", baseSkuId: base.id, proposed: { id: base.id, model: base.model } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks a reviewed existing-SKU patch when its base hash becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-existing-stale-"));
    const catalogPath = path.join(root, "catalog.json");
    const base = existingBoard("board.review-stale");
    const candidate = governedCandidate({ candidateId: `existing-stale-${Date.now()}`, model: "No MPN Board" });
    candidate.skuId = base.id;
    const options = enrichmentOptions(candidate, root, catalogPath);
    try {
      await writeCatalog(catalogPath, [base]);
      const preview = await previewDraft(candidate.candidateId, {}, options);
      const draft = await createDraft(candidate.candidateId, {}, { ...options, expectedDraftHash: preview.inputHash });
      const changedBase = { ...base, tags: [...base.tags, "changed-after-review"] };
      await writeCatalog(catalogPath, [changedBase]);
      const confirmed = await confirmDraft(draft.draftId, { ...options, approved: true, expectedHash: draft.inputHash });
      expect(confirmed).toMatchObject({ status: "blocked", reasons: ["base SKU changed after review"] });
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toEqual([changedBase]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes concurrent confirmations and atomically retains both runtime SKU IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-concurrent-confirm-"));
    const catalogPath = path.join(root, "catalog.json");
    const firstCandidate = governedCandidate({ candidateId: `concurrent-a-${Date.now()}`, model: "Concurrent Board A" });
    const secondCandidate = governedCandidate({ candidateId: `concurrent-b-${Date.now()}`, model: "Concurrent Board B" });
    const firstOptions = { ...enrichmentOptions(firstCandidate, root, catalogPath), retainRuntimeSkuMetadata: true };
    const secondOptions = { ...enrichmentOptions(secondCandidate, root, catalogPath), retainRuntimeSkuMetadata: true };
    try {
      await writeCatalog(catalogPath, [], { runtimeCatalog: { schemaVersion: "1.0.0", acceptedSkuIds: [], baseCatalogVersion: "2.0.0", baseUpdatedAt: "2026-08-26" } });
      const firstDraft = await createDraft(firstCandidate.candidateId, {}, firstOptions);
      const secondDraft = await createDraft(secondCandidate.candidateId, {}, secondOptions);
      const [first, second] = await Promise.all([
        confirmDraft(firstDraft.draftId, { ...firstOptions, approved: true, expectedHash: firstDraft.inputHash }),
        confirmDraft(secondDraft.draftId, { ...secondOptions, approved: true, expectedHash: secondDraft.inputHash }),
      ]);
      expect(first).toMatchObject({ status: "confirmed", runtimeCatalogRetained: true });
      expect(second).toMatchObject({ status: "confirmed", runtimeCatalogRetained: true });
      const saved = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(saved.skus.map((sku: any) => sku.id).sort()).toEqual([first.skuId, second.skuId].sort());
      expect(saved.runtimeCatalog.acceptedSkuIds).toEqual([first.skuId, second.skuId].sort());
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes draft-file RMW and recovers a confirmed audit event after draft-state loss", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-concurrent-drafts-"));
    const catalogPath = path.join(root, "catalog.json");
    const candidates = ["A", "B", "C"].map((suffix) => governedCandidate({ candidateId: `draft-rmw-${suffix}-${Date.now()}`, model: `Draft RMW Board ${suffix}` }));
    const options = candidates.map((candidate) => enrichmentOptions(candidate, root, catalogPath));
    try {
      await emptyCatalog(catalogPath);
      const [firstDraft, secondDraft] = await Promise.all([
        createDraft(candidates[0].candidateId, {}, options[0]),
        createDraft(candidates[1].candidateId, {}, options[1]),
      ]);
      const draftFile = path.join(root, "drafts", `${new Date().toISOString().slice(0, 10)}.json`);
      expect(JSON.parse(await readFile(draftFile, "utf8")).drafts.map((draft: any) => draft.draftId).sort()).toEqual([firstDraft.draftId, secondDraft.draftId].sort());

      const [confirmed, thirdDraft] = await Promise.all([
        confirmDraft(firstDraft.draftId, { ...options[0], approved: true, expectedHash: firstDraft.inputHash }),
        createDraft(candidates[2].candidateId, {}, options[2]),
      ]);
      expect(confirmed.status).toBe("confirmed");
      expect(thirdDraft.status).toBe("draft");
      const interleaved = JSON.parse(await readFile(draftFile, "utf8"));
      expect(interleaved.drafts).toEqual(expect.arrayContaining([
        expect.objectContaining({ draftId: firstDraft.draftId, status: "confirmed" }),
        expect.objectContaining({ draftId: secondDraft.draftId, status: "draft" }),
        expect.objectContaining({ draftId: thirdDraft.draftId, status: "draft" }),
      ]));

      // Simulate a process crash after catalog + audit commit but before the
      // confirmed draft state reached durable storage.
      interleaved.drafts = interleaved.drafts.map((draft: any) => draft.draftId === firstDraft.draftId
        ? { ...draft, status: "draft", confirmation: undefined }
        : draft);
      await writeFile(draftFile, JSON.stringify(interleaved), "utf8");
      const recovered = await confirmDraft(firstDraft.draftId, { ...options[0], approved: true, expectedHash: firstDraft.inputHash });
      expect(recovered).toMatchObject({ status: "confirmed", skuId: confirmed.skuId, recoveredDraftState: true });
      const repaired = JSON.parse(await readFile(draftFile, "utf8"));
      expect(repaired.drafts.find((draft: any) => draft.draftId === firstDraft.draftId)).toMatchObject({ status: "confirmed", confirmation: { skuId: confirmed.skuId } });
      expect(repaired.drafts).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes confirm/reject transitions so only the first terminal decision wins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-draft-transition-"));
    const catalogPath = path.join(root, "catalog.json");
    const rejectedCandidate = governedCandidate({ candidateId: `transition-reject-${Date.now()}`, model: "Transition Reject Board" });
    const confirmedCandidate = governedCandidate({ candidateId: `transition-confirm-${Date.now()}`, model: "Transition Confirm Board" });
    const rejectedOptions = enrichmentOptions(rejectedCandidate, root, catalogPath);
    const confirmedOptions = enrichmentOptions(confirmedCandidate, root, catalogPath);
    try {
      await emptyCatalog(catalogPath);
      const rejectedDraft = await createDraft(rejectedCandidate.candidateId, {}, rejectedOptions);
      const rejectFirst = rejectDraft(rejectedDraft.draftId, { ...rejectedOptions, approved: false, expectedHash: rejectedDraft.inputHash });
      const staleConfirm = confirmDraft(rejectedDraft.draftId, { ...rejectedOptions, approved: true, expectedHash: rejectedDraft.inputHash });
      const [rejected, blockedConfirm] = await Promise.all([rejectFirst, staleConfirm]);
      expect(rejected).toMatchObject({ status: "rejected" });
      expect(blockedConfirm).toMatchObject({ status: "blocked", reasons: ["draft is rejected"] });

      const confirmedDraft = await createDraft(confirmedCandidate.candidateId, {}, confirmedOptions);
      const confirmFirst = confirmDraft(confirmedDraft.draftId, { ...confirmedOptions, approved: true, expectedHash: confirmedDraft.inputHash });
      const staleReject = rejectDraft(confirmedDraft.draftId, { ...confirmedOptions, approved: false, expectedHash: confirmedDraft.inputHash });
      const [confirmed, blockedReject] = await Promise.all([confirmFirst, staleReject]);
      expect(confirmed).toMatchObject({ status: "confirmed" });
      expect(blockedReject).toMatchObject({ status: "blocked", reasons: ["draft is confirmed"] });

      const savedCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(savedCatalog.skus.map((sku: any) => sku.id)).toEqual([confirmed.skuId]);
      const draftFile = path.join(root, "drafts", `${new Date().toISOString().slice(0, 10)}.json`);
      const savedDrafts = JSON.parse(await readFile(draftFile, "utf8")).drafts;
      expect(savedDrafts.find((draft: any) => draft.draftId === rejectedDraft.draftId)?.status).toBe("rejected");
      expect(savedDrafts.find((draft: any) => draft.draftId === confirmedDraft.draftId)?.status).toBe("confirmed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers a durable confirmation intent after a crash between catalog and audit writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-confirm-wal-"));
    const catalogPath = path.join(root, "catalog.json");
    const candidate = governedCandidate({ candidateId: `confirm-wal-${Date.now()}`, model: "Confirm WAL Board" });
    const options = { ...enrichmentOptions(candidate, root, catalogPath), retainRuntimeSkuMetadata: true };
    try {
      await writeCatalog(catalogPath, [], { runtimeCatalog: { schemaVersion: "1.0.0", acceptedSkuIds: [], baseCatalogVersion: "2.0.0", baseUpdatedAt: "2026-08-26" } });
      const draft = await createDraft(candidate.candidateId, {}, options);
      await expect(confirmDraft(draft.draftId, {
        ...options,
        approved: true,
        expectedHash: draft.inputHash,
        testFailpoint: "after-catalog-write",
      })).rejects.toThrow("test failpoint after catalog write");

      const draftFile = path.join(root, "drafts", `${new Date().toISOString().slice(0, 10)}.json`);
      const pending = JSON.parse(await readFile(draftFile, "utf8")).drafts.find((entry: any) => entry.draftId === draft.draftId);
      expect(pending).toMatchObject({ status: "confirming", confirmationIntent: { catalogBeforeHash: expect.stringMatching(/^[a-f0-9]{64}$/), catalogAfterHash: expect.stringMatching(/^[a-f0-9]{64}$/), result: { skuId: draft.proposed.id } } });
      const committed = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(committed.skus.filter((sku: any) => sku.id === draft.proposed.id)).toHaveLength(1);
      expect(committed.runtimeCatalog.acceptedSkuIds).toEqual([draft.proposed.id]);
      await expect(access(path.join(root, "audit"))).rejects.toMatchObject({ code: "ENOENT" });

      const rejected = await rejectDraft(draft.draftId, { ...options, approved: false, expectedHash: draft.inputHash });
      expect(rejected).toMatchObject({ status: "blocked", reasons: ["draft is confirming"] });

      // A query-qualified import creates a fresh module instance, matching a
      // process restart with empty in-memory draft/lock registries.
      const restartedSpecifier = new URL("../scripts/price-server/catalog/write.mjs?wal-restart", import.meta.url).href;
      const restarted = await import(/* @vite-ignore */ restartedSpecifier);
      const recovered = await restarted.recoverPendingDrafts(options);
      expect(recovered).toEqual([expect.objectContaining({ status: "confirmed", skuId: draft.proposed.id, recoveredDraftState: true })]);
      const repaired = JSON.parse(await readFile(draftFile, "utf8")).drafts.find((entry: any) => entry.draftId === draft.draftId);
      expect(repaired).toMatchObject({ status: "confirmed", confirmation: { skuId: draft.proposed.id } });
      expect(repaired).not.toHaveProperty("confirmationIntent");
      const audit = JSON.parse(await readFile(path.join(root, "audit", `${new Date().toISOString().slice(0, 10)}.json`), "utf8"));
      expect(audit.events.filter((event: any) => event.draftId === draft.draftId)).toHaveLength(1);

      const replay = await restarted.confirmDraft(draft.draftId, { ...options, approved: true, expectedHash: draft.inputHash });
      expect(replay).toMatchObject({ status: "confirmed", skuId: draft.proposed.id });
      const finalCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(finalCatalog.skus.filter((sku: any) => sku.id === draft.proposed.id)).toHaveLength(1);
      expect(finalCatalog.runtimeCatalog.acceptedSkuIds).toEqual([draft.proposed.id]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains standalone inspect results for the inspect-to-preview workflow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-inspect-preview-"));
    const catalogPath = path.join(root, "catalog.json");
    const body = await readFile(new URL("./fixtures/catalog/asus-product.html", import.meta.url), "utf8");
    const url = "https://www.asus.com/example/g4";
    try {
      await emptyCatalog(catalogPath);
      const inspected = await inspectUrl({ url, query: "ASUS-G4-001", brand: "ASUS", category: "motherboard" }, {
        fetcher: async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-26T00:00:00.000Z", body, contentHash: crypto.createHash("sha256").update(body).digest("hex"), redirects: [] }),
      });
      expect(inspected).toMatchObject({ extraction: { status: "ok" }, identity: { verdict: "exact" }, expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const preview = await previewDraft(inspected.candidateId, {}, {
        expectedHash: inspected.expectedHash,
        catalogPath,
        draftRoot: path.join(root, "drafts"),
        rollbackRoot: path.join(root, "rollback"),
        auditRoot: path.join(root, "audit"),
      });
      expect(preview).toMatchObject({ status: "preview", candidateId: inspected.candidateId, candidateInputHash: inspected.expectedHash });
      await expect(access(path.join(root, "drafts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects prototype paths, out-of-range values, stale hashes and non-governed snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-draft-security-"));
    const catalogPath = path.join(root, "catalog.json");
    const candidate = governedCandidate({ candidateId: `security-${Date.now()}`, model: "Secure Board" });
    try {
      await emptyCatalog(catalogPath);
      const prototype = await createDraft(candidate.candidateId, { "__proto__.polluted": 1 }, { ...enrichmentOptions(candidate, root, catalogPath), candidate });
      const outOfRange = await createDraft(candidate.candidateId, { "dims.lengthMm": 999_999 }, { ...enrichmentOptions(candidate, root, catalogPath), candidate });
      const gpu = governedCandidate({ candidateId: `security-gpu-${Date.now()}`, category: "gpu", model: "Secure GPU", fields: [
        officialField("https://www.msi.com/governed/security-gpu", "security-gpu-brand", "brand", "MSI"),
        officialField("https://www.msi.com/governed/security-gpu", "security-gpu-model", "model", "Secure GPU"),
        officialField("https://www.msi.com/governed/security-gpu", "security-gpu-length", "dims.lengthMm", 200),
        officialField("https://www.msi.com/governed/security-gpu", "security-gpu-slots", "dims.slots", 2),
        officialField("https://www.msi.com/governed/security-gpu", "security-gpu-tgp", "power.tgpW", 200),
      ] });
      const invalidNoise = await createDraft(gpu.candidateId, { "attrs.noiseDba": 999 }, { ...enrichmentOptions(gpu, root, catalogPath), candidate: gpu });
      expect(prototype.status).toBe("blocked");
      expect(prototype.reasons.join(" ")).toContain("field path is not allowed");
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
      expect(outOfRange.status).toBe("blocked");
      expect(outOfRange.reasons.join(" ")).toContain("outside allowed range");
      expect(invalidNoise.status).toBe("blocked");
      expect(invalidNoise.reasons.join(" ")).toContain("outside allowed range");

      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      const missingApproval = await confirmDraft(draft.draftId, { ...enrichmentOptions(candidate, root, catalogPath), expectedHash: draft.expectedHash });
      expect(missingApproval).toMatchObject({ status: "blocked", reasons: ["draft confirmation requires approved=true"] });
      const stale = await confirmDraft(draft.draftId, { ...enrichmentOptions(candidate, root, catalogPath), approved: true, expectedHash: "f".repeat(64) });
      expect(stale).toMatchObject({ status: "blocked", reasons: ["draft expected hash mismatch"] });
      const draftFile = path.join(root, "drafts", `${new Date().toISOString().slice(0, 10)}.json`);
      const stored = JSON.parse(await readFile(draftFile, "utf8"));
      stored.drafts.find((entry: any) => entry.draftId === draft.draftId).fields[0].value = "tampered";
      await writeFile(draftFile, JSON.stringify(stored), "utf8");
      const tampered = await confirmDraft(draft.draftId, { ...enrichmentOptions(candidate, root, catalogPath), approved: true, expectedHash: draft.expectedHash });
      expect(tampered.status).toBe("blocked");
      expect(tampered.reasons).toContain("draft immutable input changed");

      const missingHash = await createDraft(candidate.candidateId, {}, { ...enrichmentOptions(candidate, root, catalogPath), candidate, expectedHash: undefined });
      expect(missingHash).toMatchObject({ status: "blocked" });
      expect(missingHash.reasons).toContain("candidate expected hash is required");

      for (const [name, mutate, reason] of [
        ["untrusted", (value: any) => { value.official.trustStatus = "untrusted"; }, "candidate official trust is not trusted"],
        ["search", (value: any) => { value.official.pageKind = "search"; }, "expected product/spec/datasheet/support"],
        ["conflict", (value: any) => { value.conflicts = [{ field: "model", values: ["A", "B"], reason: "fixture" }]; }, "unresolved official field conflict"],
        ["partial", (value: any) => { value.extraction.status = "partial"; }, "extraction status is partial; expected ok"],
      ] as const) {
        const denied = governedCandidate({ candidateId: `denied-${name}-${Date.now()}`, model: "Denied Board" });
        mutate(denied);
        const deniedDraft = await createDraft(denied.candidateId, {}, { ...enrichmentOptions(denied, root, catalogPath), candidate: denied });
        expect(deniedDraft.status).toBe("blocked");
        expect(deniedDraft.reasons.join(" ")).toContain(reason);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the immutable exact identity verdict for MSI marketing-prefix and capacity-suffix differences", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-msi-identity-"));
    const catalogPath = path.join(root, "catalog.json");
    const id = `msi-natural-language-${Date.now()}`;
    const url = `https://www.msi.com/governed/${id}`;
    const fields = [
      officialField(url, `${id}-brand`, "brand", "MSI"),
      officialField(url, `${id}-model`, "model", "GeForce RTX 3070 VENTUS 2X OC"),
      officialField(url, `${id}-length`, "dims.lengthMm", 232),
      officialField(url, `${id}-slots`, "dims.slots", 2.5),
      officialField(url, `${id}-tgp`, "power.tgpW", 220),
    ];
    const candidate = governedCandidate({ candidateId: id, category: "gpu", model: "GeForce RTX 3070 VENTUS 2X OC", fields });
    candidate.query.model = "RTX 3070 Ventus 2X OC 8GB";
    candidate.query.raw = "MSI RTX 3070 Ventus 2X OC 8GB";
    candidate.model = candidate.query.model;
    candidate.title = candidate.query.raw;
    try {
      await emptyCatalog(catalogPath);
      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      expect(draft).toMatchObject({ status: "draft", proposed: { brand: "MSI", model: "GeForce RTX 3070 VENTUS 2X OC" } });
      const identityEdit = await createDraft(candidate.candidateId, { model: "GeForce RTX 3070 VENTUS 2X OC V2" }, enrichmentOptions(candidate, root, catalogPath));
      expect(identityEdit).toMatchObject({ status: "blocked" });
      expect(identityEdit.reasons.join(" ")).toContain("identity fields must remain equal");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows bounded official PSU environmental fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-psu-environment-"));
    const catalogPath = path.join(root, "catalog.json");
    const id = `seasonic-environment-${Date.now()}`;
    const url = `https://seasonic.com/governed/${id}`;
    const fields = [
      officialField(url, `${id}-brand`, "brand", "Seasonic"),
      officialField(url, `${id}-model`, "model", "FOCUS PLUS Gold 850"),
      officialField(url, `${id}-rated`, "power.ratedW", 850),
      officialField(url, `${id}-noise`, "attrs.noiseDba", 25),
      officialField(url, `${id}-temperature`, "attrs.maxOperatingTempC", 50),
    ];
    const candidate = governedCandidate({ candidateId: id, category: "psu", model: "FOCUS PLUS Gold 850", fields });
    try {
      await emptyCatalog(catalogPath);
      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      expect(draft).toMatchObject({ status: "draft", missing: [], proposed: { power: { ratedW: 850 }, attrs: { noiseDba: 25, maxOperatingTempC: 50 } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires the draft hash for rejection and finds a draft stored under a prior date", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-draft-cross-day-"));
    const catalogPath = path.join(root, "catalog.json");
    const candidate = governedCandidate({ candidateId: `cross-day-${Date.now()}`, model: "Cross Day Board" });
    try {
      await emptyCatalog(catalogPath);
      const draft = await runAutoEnrichment(candidate.candidateId, enrichmentOptions(candidate, root, catalogPath));
      const missing = await rejectDraft(draft.draftId, { draftRoot: path.join(root, "drafts"), rollbackRoot: path.join(root, "rollback") });
      expect(missing).toMatchObject({ status: "blocked", reasons: ["draft expected hash is required"] });

      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await rename(path.join(root, "drafts", `${today}.json`), path.join(root, "drafts", `${yesterday}.json`));
      const missingApproval = await rejectDraft(draft.draftId, { draftRoot: path.join(root, "drafts"), rollbackRoot: path.join(root, "rollback"), expectedHash: draft.expectedHash });
      expect(missingApproval).toMatchObject({ status: "blocked", reasons: ["draft rejection requires approved=false"] });
      const rejected = await rejectDraft(draft.draftId, { approved: false, draftRoot: path.join(root, "drafts"), rollbackRoot: path.join(root, "rollback"), expectedHash: draft.expectedHash });
      expect(rejected).toMatchObject({ status: "rejected", draftId: draft.draftId, inputHash: draft.inputHash });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
