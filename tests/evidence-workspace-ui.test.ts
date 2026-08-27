// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceCapture,
  type EvidenceDocument,
  type PlanEvidenceBinding,
} from "../src/evidence/contracts";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import type { WorkspaceEvidenceApi } from "../src/plans/client";
import type { BindPlanEvidenceInput, UnbindPlanEvidenceInput } from "../src/plans/contracts";
import type { EvidenceServiceApi } from "../src/plans/evidence-client";
import { loadBundledCatalog } from "../src/sku/catalog";
import { initializedStore, makePlan, mountWorkspaceDom } from "./helpers/workspace-ui";

const documentHash = "a".repeat(64);
const captureHash = "b".repeat(64);
const bindingHash = "c".repeat(64);

const evidenceDocument: EvidenceDocument = {
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  id: `doc-sha256-${documentHash}`,
  sha256: documentHash,
  byteLength: 32768,
  mediaType: "application/pdf",
  createdAt: "2026-08-27T01:00:00.000Z",
};

const evidenceCapture: EvidenceCapture = {
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  id: `capture-sha256-${captureHash}`,
  documentId: evidenceDocument.id,
  acquisitionMethod: "official-fetch",
  kind: "manufacturer-manual",
  kindBasis: "content-verified",
  title: "JONSBO N6 User Manual",
  productIdentities: [{ brand: "JONSBO", basis: "official-document-explicit", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
  requestedUrl: "https://www.jonsbo.com/Upfiles/down/N6-manual.pdf",
  finalUrl: "https://www.jonsbo.com/Upfiles/down/N6-manual.pdf",
  canonicalUrl: "https://www.jonsbo.com/Upfiles/down/N6-manual.pdf",
  retrievedAt: "2026-08-27T01:00:00.000Z",
  status: 200,
  redirects: [],
  officialBrand: "JONSBO",
};

function planBinding(planId: string): PlanEvidenceBinding {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: `binding-sha256-${bindingHash}`,
    planId,
    planVersionId: null,
    documentId: evidenceDocument.id,
    contentHash: evidenceDocument.sha256,
    captureId: evidenceCapture.id,
    subject: { kind: "sku", id: "case.jonsbo-n6", category: "case" },
    purposes: ["compatibility", "geometry", "assembly"],
    locators: [{ page: 8, section: "Power supply installation" }],
    boundAt: "2026-08-27T01:05:00.000Z",
    note: "用户通过方案证据面板核对并绑定",
  };
}

function evidenceService(capture: EvidenceCapture = evidenceCapture): EvidenceServiceApi {
  return {
    discover: vi.fn(async () => ({
      startUrl: "https://www.jonsbo.com/en/products/N6.html",
      finalUrl: "https://www.jonsbo.com/en/products/N6.html",
      officialBrand: "JONSBO",
      candidates: [{
        url: capture.canonicalUrl,
        title: capture.title,
        mediaTypeHint: "application/pdf",
        kindHint: "manufacturer-manual" as const,
        score: 100,
        discoveredFrom: "https://www.jonsbo.com/en/products/N6.html",
      }],
      pagesInspected: 1,
      warnings: [],
    })),
    acquire: vi.fn(async () => ({
      document: evidenceDocument,
      capture,
      reusedDocument: false,
      reusedCapture: false,
      cacheStatus: "miss" as const,
    })),
    getDocument: vi.fn(async () => ({ document: evidenceDocument, captures: [capture] })),
    contentUrl: vi.fn((id) => `/api/evidence/documents/${encodeURIComponent(id)}/content`),
  };
}

describe("official evidence workspace UI", () => {
  it("requires explicit discovery, archive, bind, and unbind actions", async () => {
    const root = mountWorkspaceDom();
    const { api, store } = await initializedStore();
    const evidence = evidenceService();
    const bindEvidence = vi.fn(async (planId: string, input: BindPlanEvidenceInput) => {
      const plan = api.plans.find((item) => item.id === planId)!;
      expect(input.expectedRevision).toBe(plan.draftRevision);
      const binding = planBinding(planId);
      plan.draft.evidenceBindings = [binding];
      plan.draftRevision += 1;
      plan.draft.dirty = true;
      return structuredClone(binding);
    });
    const unbindEvidence = vi.fn(async (planId: string, input: UnbindPlanEvidenceInput) => {
      const plan = api.plans.find((item) => item.id === planId)!;
      expect(input.expectedRevision).toBe(plan.draftRevision);
      plan.draft.evidenceBindings = (plan.draft.evidenceBindings ?? []).filter((binding) => binding.id !== input.bindingId);
      plan.draftRevision += 1;
      plan.draft.dirty = true;
    });
    const workspace: WorkspaceEvidenceApi = {
      get: (planId) => api.get(planId),
      listEvidenceBindings: vi.fn(async (planId) => structuredClone(api.plans.find((plan) => plan.id === planId)?.draft.evidenceBindings ?? [])),
      bindEvidence,
      unbindEvidence,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter(), undefined, undefined, loadBundledCatalog, { evidence, workspace });

    expect(evidence.discover).not.toHaveBeenCalled();
    expect(evidence.acquire).not.toHaveBeenCalled();
    expect(bindEvidence).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('[data-evidence-action="discover"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("JONSBO N6 User Manual"));
    expect(evidence.discover).toHaveBeenCalledWith({ skuId: "case.jonsbo-n6" });
    expect(evidence.acquire).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('[data-evidence-action="archive"]')!.click();
    await vi.waitFor(() => expect(root.querySelector("[data-evidence-staged]")).not.toBeNull());
    expect(root.textContent).toContain("文档类型：内容已核验");
    expect(root.textContent).toContain("型号身份：文档明确写出");
    expect(evidence.acquire).toHaveBeenCalledWith({
      url: evidenceCapture.canonicalUrl,
      skuId: "case.jonsbo-n6",
      kind: "manufacturer-manual",
      title: evidenceCapture.title,
    });
    expect(bindEvidence).not.toHaveBeenCalled();

    const page = root.querySelector<HTMLInputElement>("[data-evidence-locator-page]")!;
    const section = root.querySelector<HTMLInputElement>("[data-evidence-locator-section]")!;
    page.value = "8";
    page.dispatchEvent(new Event("input", { bubbles: true }));
    section.value = "Power supply installation";
    section.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-evidence-action="bind"]')!.click();

    await vi.waitFor(() => expect(bindEvidence).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.getState().activePlan?.draftRevision).toBe(1));
    expect(bindEvidence.mock.calls[0]?.[1]).toMatchObject({
      expectedRevision: 0,
      documentId: evidenceDocument.id,
      contentHash: evidenceDocument.sha256,
      captureId: evidenceCapture.id,
      subject: { kind: "sku", id: "case.jonsbo-n6", category: "case" },
      purposes: expect.arrayContaining(["compatibility", "geometry", "assembly"]),
      locators: [{ page: 8, section: "Power supply installation" }],
    });
    expect(root.querySelector(`[data-evidence-binding="binding-sha256-${bindingHash}"]`)).not.toBeNull();
    expect(root.querySelector<HTMLAnchorElement>(`a[href="/api/evidence/documents/${evidenceDocument.id}/content"]`)).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-evidence-action="unbind"]')!.click();
    await vi.waitFor(() => expect(unbindEvidence).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.getState().activePlan?.draftRevision).toBe(2));
    expect(confirm).toHaveBeenCalledWith("只解除当前方案引用，共享原文仍会保留。确认继续？");
    expect(root.querySelector("[data-evidence-binding]")).toBeNull();
    expect(evidence.acquire).toHaveBeenCalledTimes(1);

    pages.dispose();
    store.dispose();
    confirm.mockRestore();
  });

  it("renders persisted bindings after restart and refreshes descriptive metadata without writing", async () => {
    const plan = makePlan("plan-12345678", "主方案");
    plan.draft.evidenceBindings = [planBinding(plan.id)];
    const root = mountWorkspaceDom();
    const { api, store } = await initializedStore([plan]);
    const assertedCapture: EvidenceCapture = {
      ...evidenceCapture,
      kindBasis: "user-asserted",
      productIdentities: [{ brand: "JONSBO", basis: "governed-sku-user-asserted", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
    };
    const evidence = evidenceService(assertedCapture);
    const workspace: WorkspaceEvidenceApi = {
      get: (planId) => api.get(planId),
      listEvidenceBindings: vi.fn(async () => [planBinding(plan.id)]),
      bindEvidence: vi.fn(),
      unbindEvidence: vi.fn(),
    };
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter(), undefined, undefined, loadBundledCatalog, { evidence, workspace });

    expect(root.querySelector(`[data-evidence-binding="binding-sha256-${bindingHash}"]`)).not.toBeNull();
    expect(root.textContent).toContain(documentHash);
    expect(evidence.getDocument).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('[data-evidence-action="refresh"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("JONSBO N6 User Manual"));
    expect(root.textContent).toContain("型号身份：来自审核目录关联，文档未证明精确型号");
    expect(root.textContent).not.toContain("型号身份：文档明确写出");
    expect(workspace.listEvidenceBindings).toHaveBeenCalledWith(plan.id);
    expect(evidence.getDocument).toHaveBeenCalledWith(evidenceDocument.id);
    expect(workspace.bindEvidence).not.toHaveBeenCalled();
    expect(workspace.unbindEvidence).not.toHaveBeenCalled();
    expect(evidence.acquire).not.toHaveBeenCalled();

    pages.dispose();
    store.dispose();
  });
});
