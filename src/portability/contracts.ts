import type { BackupEnvelope, BackupManifest, ImportPlan, PortableReferenceEdge } from "../backup/contracts";

export const PORTABLE_PACKAGE_SCHEMA_VERSION = "buildsim-plan-portable-package-v1" as const;
export const PORTABLE_PAYLOAD_SCHEMA_VERSION = "buildsim-plan-portable-payload-v1" as const;

export interface PortablePackageFile {
  readonly logicalPath: string;
  readonly dataBase64: string;
}

export interface PortableReferenceGraph {
  readonly graphVersion: "portable-reference-graph-v1";
  readonly runtimeGeneration: number;
  readonly runtimeRevision: number;
  readonly createdAt: string;
  readonly nodes: readonly string[];
  readonly edges: readonly PortableReferenceEdge[];
  readonly requiredRoots: readonly string[];
  readonly snapshotPointers: readonly string[];
  readonly providerSnapshots: readonly [];
  readonly graphHash: string;
}

export interface PortablePlanPayload {
  readonly schemaVersion: typeof PORTABLE_PAYLOAD_SCHEMA_VERSION;
  readonly manifest: BackupManifest & { readonly mode: "plan_portable" };
  readonly sourcePlanId: string;
  readonly sourcePlanHash: string;
  readonly redacted: boolean;
  readonly requiredRefs: readonly string[];
  readonly includedRefs: readonly string[];
  readonly referenceGraph: PortableReferenceGraph;
  readonly files: readonly PortablePackageFile[];
}

export interface PortablePlanPackage {
  readonly schemaVersion: typeof PORTABLE_PACKAGE_SCHEMA_VERSION;
  readonly envelope: BackupEnvelope;
  readonly ciphertextBase64: string;
}

export interface PortableExportSummary {
  readonly schemaVersion: "portable-export-summary-v1";
  readonly exportId: string;
  readonly planId: string;
  readonly manifestHash: string;
  readonly portableProfile: "slim" | "complete";
  readonly resultMode: "exact_replay" | "reevaluate_with_current_runtime";
  readonly redacted: boolean;
  readonly entryCount: number;
  readonly createdAt: string;
  readonly downloadUrl: string;
}

export interface PortableImportPreview {
  readonly schemaVersion: "portable-import-preview-v1";
  readonly uploadId: string;
  readonly sourcePlanId: string;
  readonly sourcePlanName: string;
  readonly sourcePlanHash: string;
  readonly manifestHash: string;
  readonly portableProfile: "slim" | "complete";
  readonly exactReplayReady: boolean;
  readonly importPlan: ImportPlan;
}

export interface PortableImportResult {
  readonly schemaVersion: "portable-import-result-v1";
  readonly action: ImportPlan["action"];
  readonly sourcePlanId: string;
  readonly importedPlanId: string;
  readonly manifestHash: string;
  readonly resultMode: ImportPlan["resultMode"];
  readonly runtimeGeneration: number;
  readonly rollbackRef?: string;
}
