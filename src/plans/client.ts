import type {
  BindPlanEvidenceInput,
  BuildPlan,
  BuildPlanSummary,
  CreatePlanInput,
  DuplicatePlanInput,
  PlanVersion,
  SaveVersionInput,
  UnbindPlanEvidenceInput,
  UpdateDraftInput,
  UpdatePlanInfoInput,
} from "./contracts";
import type { PlanEvidenceBinding } from "../evidence/contracts";

export class WorkspaceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

export interface WorkspacePlanApi {
  list(): Promise<BuildPlanSummary[]>;
  get(planId: string): Promise<BuildPlan>;
  create(input: CreatePlanInput): Promise<BuildPlan>;
  updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan>;
  updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan>;
  saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion>;
  duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan>;
  archive(planId: string): Promise<void>;
  restore(planId: string): Promise<void>;
  delete(planId: string): Promise<void>;
  listVersions(planId: string): Promise<PlanVersion[]>;
}

/** Evidence-edge operations used by the explicit browser review flow. */
export interface WorkspaceEvidenceApi {
  get(planId: string): Promise<BuildPlan>;
  listEvidenceBindings(planId: string): Promise<PlanEvidenceBinding[]>;
  bindEvidence(planId: string, input: BindPlanEvidenceInput): Promise<PlanEvidenceBinding>;
  unbindEvidence(planId: string, input: UnbindPlanEvidenceInput): Promise<void>;
}

async function payload<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({ error: "invalid_response", message: "Workspace returned invalid JSON" }));
  if (!response.ok) {
    const error = body as { error?: string; message?: string };
    throw new WorkspaceApiError(response.status, error.error ?? "request_failed", error.message ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export class WorkspaceApiClient implements WorkspacePlanApi, WorkspaceEvidenceApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "/api/workspace/plans",
  ) {}

  private request(path = "", init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl.call(globalThis, `${this.base}${path}`, {
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      ...init,
    });
  }

  async list(): Promise<BuildPlanSummary[]> {
    return (await payload<{ plans: BuildPlanSummary[] }>(await this.request())).plans;
  }
  async get(planId: string): Promise<BuildPlan> {
    return payload(await this.request(`/${encodeURIComponent(planId)}`));
  }
  async create(input: CreatePlanInput): Promise<BuildPlan> {
    return payload(await this.request("", { method: "POST", body: JSON.stringify(input) }));
  }
  async updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan> {
    return payload(await this.request(`/${encodeURIComponent(planId)}`, { method: "PATCH", body: JSON.stringify(input) }));
  }
  async updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan> {
    return payload(await this.request(`/${encodeURIComponent(planId)}/draft`, { method: "PATCH", body: JSON.stringify(input) }));
  }
  async saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion> {
    return payload(await this.request(`/${encodeURIComponent(planId)}/versions`, { method: "POST", body: JSON.stringify(input) }));
  }
  async duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan> {
    return payload(await this.request(`/${encodeURIComponent(planId)}/duplicate`, { method: "POST", body: JSON.stringify(input) }));
  }
  async archive(planId: string): Promise<void> {
    await payload(await this.request(`/${encodeURIComponent(planId)}/archive`, { method: "POST" }));
  }
  async restore(planId: string): Promise<void> {
    await payload(await this.request(`/${encodeURIComponent(planId)}/restore`, { method: "POST" }));
  }
  async delete(planId: string): Promise<void> {
    await payload(await this.request(`/${encodeURIComponent(planId)}`, { method: "DELETE" }));
  }
  async listVersions(planId: string): Promise<PlanVersion[]> {
    return (await payload<{ versions: PlanVersion[] }>(await this.request(`/${encodeURIComponent(planId)}/versions`))).versions;
  }
  async listEvidenceBindings(planId: string): Promise<PlanEvidenceBinding[]> {
    return (await payload<{ bindings: PlanEvidenceBinding[] }>(await this.request(`/${encodeURIComponent(planId)}/evidence-bindings`))).bindings;
  }
  async bindEvidence(planId: string, input: BindPlanEvidenceInput): Promise<PlanEvidenceBinding> {
    return payload(await this.request(`/${encodeURIComponent(planId)}/evidence-bindings`, { method: "POST", body: JSON.stringify(input) }));
  }
  async unbindEvidence(planId: string, input: UnbindPlanEvidenceInput): Promise<void> {
    await payload(await this.request(`/${encodeURIComponent(planId)}/evidence-bindings/${encodeURIComponent(input.bindingId)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: input.expectedRevision, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }) }));
  }
}
