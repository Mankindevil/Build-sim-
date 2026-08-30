import { hashContent } from "../hash";
import { validateFactRecord, type FactRecord } from "./contracts";

export type FactRecordInput = Omit<FactRecord, "contentHash">;

const FACT_RECORD_HASH_CONTRACT = Object.freeze({
  domain: "fact-record",
  schemaVersion: "fact-record-v1",
  canonicalizationPolicyId: "fact-record-content-v1",
} as const);

export async function factRecordContentHash(value: FactRecordInput | FactRecord): Promise<string> {
  return hashContent(value, FACT_RECORD_HASH_CONTRACT);
}

export async function createFactRecord(input: FactRecordInput): Promise<FactRecord> {
  const material = structuredClone(input);
  const record: FactRecord = Object.freeze({
    ...material,
    contentHash: await factRecordContentHash(material),
  });
  const errors = validateFactRecord(record);
  if (errors.length) throw new TypeError(`Invalid FactRecord: ${errors.join("; ")}`);
  return record;
}

export async function verifyFactRecord(value: unknown): Promise<boolean> {
  if (validateFactRecord(value).length) return false;
  const record = value as FactRecord;
  return record.contentHash === await factRecordContentHash(record);
}
