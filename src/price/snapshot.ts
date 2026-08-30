import { buildAndWriteLatest } from "../../scripts/price-server/store.mjs";
import { confined } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { projectCurrentChinaPrice } from "./policy";
import { PriceRepository } from "./repository";
import type { PriceObservation } from "./contracts";
import type { PriceQuote, PriceSnapshotFile } from "./types";

export interface CurrentPriceSnapshotBuildResult {
  readonly snapshot: PriceSnapshotFile & { readonly snapshotId: string; readonly contentHash: string; readonly inputHash: string };
  readonly selectedObservationIds: readonly string[];
  readonly omittedObservationIds: readonly string[];
}

export interface CurrentPriceSnapshotPreview {
  readonly quotes: readonly PriceQuote[];
  readonly selectedObservationIds: readonly string[];
  readonly omittedObservationIds: readonly string[];
}

function groupKey(observation: PriceObservation): string {
  return JSON.stringify([observation.skuId, [...observation.variantIdentityFactIds].sort()]);
}

function variantLabel(observation: PriceObservation): string {
  return [...observation.variantIdentityFactIds].sort().join("|");
}

/**
 * Materializes the only current-price snapshot consumed by evaluation, UI and
 * Agent views. It runs below the runtime writer barrier and derives every quote
 * from an immutable PriceObservation plus its saved listing capture.
 */
export class CurrentPriceSnapshotService {
  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly prices: PriceRepository;
    readonly catalog: (activeRoot: string) => unknown | Promise<unknown>;
    readonly now?: () => string;
  }) {}

  async rebuild(asOf?: string): Promise<CurrentPriceSnapshotBuildResult> {
    await this.options.coordinator.initialize();
    const currentTime = (this.options.now ?? (() => new Date().toISOString()))();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => this.rebuildAtRoot(activeRoot, asOf, currentTime))).result;
  }

  /** Root-pinned projection for a service already holding the runtime writer barrier. */
  async previewAtRoot(activeRoot: string, now?: string): Promise<CurrentPriceSnapshotPreview> {
    const currentTime = now ?? (this.options.now ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(currentTime))) throw new TypeError("price snapshot projection time must be an ISO timestamp");
    const [observations, captures, catalog] = await Promise.all([
      this.options.prices.listObservationsAtRoot(activeRoot),
      this.options.prices.listListingCapturesAtRoot(activeRoot),
      this.options.catalog(activeRoot),
    ]);
    const captureById = new Map(captures.map((capture) => [capture.listingCaptureId, capture]));
    const groups = new Map<string, PriceObservation[]>();
    for (const observation of observations) {
      const list = groups.get(groupKey(observation)) ?? [];
      list.push(observation); groups.set(groupKey(observation), list);
    }
    const selectedIds = new Set<string>();
    for (const group of groups.values()) {
      const first = group[0]!;
      const projection = projectCurrentChinaPrice({
        skuId: first.skuId,
        variantIdentityFactIds: first.variantIdentityFactIds,
        observations: group,
        now: currentTime,
      });
      for (const observationId of projection.selectedObservationIds) selectedIds.add(observationId);
    }
    const selected = observations.filter(({ observationId }) => selectedIds.has(observationId))
      .sort((left, right) => left.observationId.localeCompare(right.observationId));
    const quotes: PriceQuote[] = selected.map((observation) => {
      const capture = captureById.get(observation.listingCaptureId);
      if (!capture) throw new TypeError("current price observation listing capture is missing");
      return {
        skuId: observation.skuId,
        platform: observation.platform,
        priceCny: observation.comparableTotalCny,
        currency: "CNY",
        listingUrl: observation.canonicalUrl,
        match: "listingUrl",
        evidence: "audited",
        priceKind: "variant",
        variantLabel: variantLabel(observation),
        priceAmount: observation.comparableTotalCny,
        priceCurrency: "CNY",
        fetchedAt: observation.recheckedAt ?? observation.capturedAt,
        provenanceId: observation.observationId,
        sourceHash: capture.contentHash,
        note: [
          `seller-tier:${observation.sellerTier}`,
          `invoice:${observation.invoiceStatus}`,
          `warranty:${observation.warrantyStatus}`,
          ...(observation.requiredDiscountConditions ?? []).map((condition) => `condition:${condition}`),
        ].join(" · "),
      };
    });
    return {
      quotes,
      selectedObservationIds: [...selectedIds].sort(),
      omittedObservationIds: observations.filter(({ observationId }) => !selectedIds.has(observationId)).map(({ observationId }) => observationId).sort(),
    };
  }

  /** Root-pinned projection and write for a service already holding the runtime writer barrier. */
  async rebuildAtRoot(activeRoot: string, asOf?: string, now?: string): Promise<CurrentPriceSnapshotBuildResult> {
    const currentTime = now ?? (this.options.now ?? (() => new Date().toISOString()))();
    const snapshotDate = asOf ?? currentTime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) || !Number.isFinite(Date.parse(`${snapshotDate}T00:00:00.000Z`))) {
      throw new TypeError("price snapshot asOf must be a calendar date");
    }
    const preview = await this.previewAtRoot(activeRoot, currentTime);
    const catalog = await this.options.catalog(activeRoot);
    const snapshot = await buildAndWriteLatest(snapshotDate, "Derived from immutable current-new price observations.", {
      pricesDir: confined(activeRoot, "prices"),
      catalog,
      quotes: preview.quotes,
      generatedAt: currentTime,
    }) as CurrentPriceSnapshotBuildResult["snapshot"];
    return { snapshot, selectedObservationIds: preview.selectedObservationIds, omittedObservationIds: preview.omittedObservationIds };
  }
}
