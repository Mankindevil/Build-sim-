/** Typed facade over the shared query builders in `queries.mjs` (no network). */

import * as impl from "./queries.mjs";
import type { SkuRecord } from "../sku/types";

export type SearchChannel = "jd" | "taobao" | "pdd" | "amazon" | "amazon_cn" | "official";

export interface ChannelSearchLink {
  channel: SearchChannel;
  label: string;
  /** The keyword string actually sent to that marketplace. */
  query: string;
  /** Ready-to-open search or product URL */
  url: string;
}

export function searchQueryFromMpn(mpn: string): string {
  return impl.searchQueryFromMpn(mpn);
}

export function buildChannelSearchLinks(
  mpn: string,
  officialUrl?: string | null,
): ChannelSearchLink[] {
  return impl.buildChannelSearchLinks(mpn, officialUrl ?? undefined) as ChannelSearchLink[];
}

/** Per-SKU links: part number where it indexes well, spec words on Taobao/PDD. */
export function buildSkuSearchLinks(
  sku: SkuRecord,
  officialUrl?: string | null,
): ChannelSearchLink[] {
  return impl.buildSkuSearchLinks(sku, officialUrl ?? undefined) as ChannelSearchLink[];
}

export function buildSearchQueries(sku: SkuRecord): { exact: string | null; spec: string[] } {
  return impl.buildSearchQueries(sku) as { exact: string | null; spec: string[] };
}

export function channelQueries(channel: string, sku: SkuRecord): string[] {
  return impl.channelQueries(channel, sku) as string[];
}

export function pickOfficialUrl(sku: {
  appearance?: { page?: string };
  price?: { listingUrl?: string };
}): string | undefined {
  return impl.pickOfficialUrl(sku) as string | undefined;
}
