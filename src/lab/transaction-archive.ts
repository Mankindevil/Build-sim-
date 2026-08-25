export interface TransactionArchiveItemSnapshot {
  id: string;
  skuId: string | null;
  name: string;
  category: string;
  qty: number;
  unitPriceCny: number | null;
  stage: string;
  source: string;
  transaction?: {
    receiptId: string;
    fileName: string;
    contentHash: string;
    capturedAt: string;
    ocrEngine: string;
    ocrConfidence: number | null;
    excerpt: string;
    verification: string;
    catalogJobId?: string | null;
    candidateId?: string | null;
    draftId?: string | null;
    officialUrl?: string | null;
    screenshotArchive?: "server";
    screenshotStoredAt?: string | null;
    screenshotMimeType?: string | null;
    screenshotSize?: number | null;
  };
}

export interface TransactionArchiveRecord {
  schemaVersion: 1;
  receiptId: string;
  storedAt: string;
  updatedAt: string;
  item: TransactionArchiveItemSnapshot;
  image: {
    fileName: string;
    mimeType: string;
    bytes: number;
    contentHash: string;
    imageUrl: string;
  } | null;
  pendingFile?: File;
}

export interface TransactionScreenshotArchive {
  stage: (receiptId: string, file: File, contentHash: string, capturedAt: string) => void;
  discard: (receiptIds?: Iterable<string>) => void;
  commit: (items: TransactionArchiveItemSnapshot[]) => Promise<TransactionArchiveRecord[]>;
  list: () => Promise<TransactionArchiveRecord[]>;
  pendingRecord: (receiptId: string, item: TransactionArchiveItemSnapshot) => TransactionArchiveRecord | null;
  deleteScreenshot: (receiptId: string) => Promise<void>;
  deleteRecord: (receiptId: string) => Promise<void>;
}

interface PendingScreenshot {
  file: File;
  contentHash: string;
  capturedAt: string;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({ error: "服务器返回了无效数据" }));
  if (!response.ok) throw new Error(String((payload as { error?: string }).error ?? `HTTP ${response.status}`));
  return payload as T;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取待归档截图"));
    reader.readAsDataURL(file);
  });
}

export function createTransactionScreenshotArchive(): TransactionScreenshotArchive {
  const pending = new Map<string, PendingScreenshot>();

  return {
    stage(receiptId, file, contentHash, capturedAt) {
      pending.set(receiptId, { file, contentHash, capturedAt });
    },
    discard(receiptIds) {
      if (!receiptIds) {
        pending.clear();
        return;
      }
      for (const receiptId of receiptIds) pending.delete(receiptId);
    },
    async commit(items) {
      const archived: TransactionArchiveRecord[] = [];
      for (const item of items) {
        const receiptId = item.transaction?.receiptId;
        const screenshot = receiptId ? pending.get(receiptId) : null;
        if (!receiptId || !screenshot) continue;
        if (screenshot.contentHash !== item.transaction?.contentHash) throw new Error("待归档截图与交易证据不一致");
        const record = await jsonResponse<TransactionArchiveRecord>(await fetch("/api/price/transactions/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptId, item, screenshotDataUrl: await readAsDataUrl(screenshot.file) }),
        }));
        pending.delete(receiptId);
        archived.push(record);
      }
      return archived;
    },
    async list() {
      const response = await jsonResponse<{ records: TransactionArchiveRecord[] }>(await fetch("/api/price/transactions/archive", { headers: { Accept: "application/json" } }));
      return response.records;
    },
    pendingRecord(receiptId, item) {
      const screenshot = pending.get(receiptId);
      if (!screenshot) return null;
      return {
        schemaVersion: 1,
        receiptId,
        storedAt: "",
        updatedAt: "",
        item,
        image: {
          fileName: screenshot.file.name,
          mimeType: screenshot.file.type,
          bytes: screenshot.file.size,
          contentHash: screenshot.contentHash,
          imageUrl: "",
        },
        pendingFile: screenshot.file,
      };
    },
    async deleteScreenshot(receiptId) {
      pending.delete(receiptId);
      await jsonResponse(await fetch(`/api/price/transactions/archive/${encodeURIComponent(receiptId)}/image`, { method: "DELETE" }));
    },
    async deleteRecord(receiptId) {
      pending.delete(receiptId);
      await jsonResponse(await fetch(`/api/price/transactions/archive/${encodeURIComponent(receiptId)}`, { method: "DELETE" }));
    },
  };
}
