import { createHash } from "node:crypto";
import { hashContent } from "../hash";
import { confined, readJson, sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { BuildConfigDocument } from "../config/types";
import type { BuildConfigV3 } from "../topology/contracts";
import { canonicalizeListingUrl, derivePriceObservationFromCapture } from "../../scripts/price-server/price-observations.mjs";
import type { ImmutableListingCapture, PriceObservation } from "./contracts";
import { PriceRepository } from "./repository";
import { CurrentPriceSnapshotService, type CurrentPriceSnapshotBuildResult } from "./snapshot";

const LEGACY_CAPTURE_ID = /^listing-capture-[a-f0-9]{20}$/;
const LEGACY_CANDIDATE_ID = /^price-candidate-[a-f0-9]{20}$/;
const ALLOWED_CAPTURE_FIELDS = new Set([
  "schemaVersion", "candidateId", "skuId", "platform", "channel", "title", "canonicalUrl",
  "redirectChain", "fetchedAt", "variants", "variantSource", "source", "contentHash",
]);
const EXCLUDED_LISTING_TERMS = /(?:二手|中古|拆机|翻新|预售|定金|订金|预约|样机|展示机|闲置)/u;

interface LegacyVariant {
  readonly skuId: string;
  readonly label: string;
  readonly amount: number;
  readonly currency: "CNY";
  readonly stock: number | null;
}

interface LegacyListingCapture {
  readonly schemaVersion: "1.0.0";
  readonly candidateId: string;
  readonly skuId: string;
  readonly platform: string;
  readonly channel: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly redirectChain: string[];
  readonly fetchedAt: string;
  readonly variants: LegacyVariant[];
  readonly variantSource: unknown;
  readonly source: unknown;
  readonly contentHash: string;
}

export interface PriceObservationIntakeInput {
  readonly planId: string;
  readonly instanceId: string;
  readonly listingCaptureId: string;
  readonly variantLabel: string;
}

export interface PriceObservationIntakeResult {
  readonly schemaVersion: "price-observation-intake-result-v1";
  readonly planId: string;
  readonly instanceId: string;
  readonly listingCapture: ImmutableListingCapture;
  readonly observation: PriceObservation;
  readonly snapshot: CurrentPriceSnapshotBuildResult["snapshot"];
  readonly requiresEvaluationRefresh: true;
}

export interface PriceObservationPlanAuthority {
  getAtRoot(activeRoot: string, planId: string): Promise<{ draft: { config: BuildConfigDocument } }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyContentHash(material: unknown): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function parseLegacyCapture(value: unknown, expectedId: string): LegacyListingCapture {
  if (!record(value) || Object.keys(value).some((key) => !ALLOWED_CAPTURE_FIELDS.has(key))) {
    throw new TypeError("captured listing fields are invalid");
  }
  const capture = value as unknown as LegacyListingCapture;
  if (capture.schemaVersion !== "1.0.0" || !LEGACY_CANDIDATE_ID.test(capture.candidateId)
    || typeof capture.skuId !== "string" || !capture.skuId || typeof capture.platform !== "string" || !capture.platform
    || typeof capture.channel !== "string" || !capture.channel || typeof capture.title !== "string" || !capture.title
    || !Number.isFinite(Date.parse(capture.fetchedAt)) || !Array.isArray(capture.redirectChain) || capture.redirectChain.length === 0
    || !Array.isArray(capture.variants) || typeof capture.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(capture.contentHash)) {
    throw new TypeError("captured listing identity is invalid");
  }
  const canonicalUrl = canonicalizeListingUrl(capture.canonicalUrl);
  if (canonicalUrl !== capture.canonicalUrl || capture.redirectChain.at(-1) !== capture.canonicalUrl
    || capture.redirectChain.some((entry) => canonicalizeListingUrl(entry) !== entry)) {
    throw new TypeError("captured listing URL closure is invalid");
  }
  const { contentHash, ...material } = capture;
  if (legacyContentHash(material) !== contentHash || expectedId !== `listing-capture-${contentHash.slice(0, 20)}`) {
    throw new TypeError("captured listing content identity is invalid");
  }
  if (capture.variants.some((variant) => !record(variant)
    || Object.keys(variant).some((key) => !["skuId", "label", "amount", "currency", "stock"].includes(key))
    || typeof variant.skuId !== "string" || typeof variant.label !== "string" || !variant.label.trim()
    || !Number.isFinite(variant.amount) || variant.amount <= 0 || variant.currency !== "CNY"
    || (variant.stock !== null && (!Number.isInteger(variant.stock) || variant.stock < 0)))) {
    throw new TypeError("captured listing variants are invalid");
  }
  return structuredClone(capture);
}

function platform(value: string): ImmutableListingCapture["platform"] {
  if (["jd", "tmall", "taobao", "pdd", "official"].includes(value)) return value as ImmutableListingCapture["platform"];
  throw new TypeError("captured listing is not a supported China-new price channel");
}

function resolvedComponent(config: BuildConfigV3, instanceId: string) {
  const component = config.components.find((candidate) => candidate.instanceId === instanceId);
  if (!component || component.identity.status !== "resolved" || component.identity.identityClaimIds.length === 0) {
    throw new TypeError("price observation instance identity is unresolved");
  }
  return component as typeof component & { identity: Extract<typeof component.identity, { status: "resolved" }> };
}

/**
 * Converts one immutable price-server listing into the formal U10 price domain.
 * Request JSON supplies only server-owned IDs and the selected captured label;
 * price, URL, exact SKU/claim identity and market fields are reconstructed.
 */
export class ProductionPriceObservationIntake {
  private readonly now: () => string;

  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly plans: PriceObservationPlanAuthority;
    readonly prices: PriceRepository;
    readonly snapshots: CurrentPriceSnapshotService;
    readonly now?: () => string;
  }) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ingest(input: PriceObservationIntakeInput): Promise<PriceObservationIntakeResult> {
    if (!input.planId || !input.instanceId || !LEGACY_CAPTURE_ID.test(input.listingCaptureId) || !input.variantLabel.trim()) {
      throw new TypeError("price observation intake identifiers are invalid");
    }
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const plan = await this.options.plans.getAtRoot(activeRoot, input.planId);
      if (plan.draft.config.schemaVersion !== "3.0.0") throw new TypeError("price observation intake requires BuildConfig V3");
      const component = resolvedComponent(plan.draft.config, input.instanceId);
      const source = parseLegacyCapture(
        await readJson(confined(activeRoot, "prices", "listing-captures", `${input.listingCaptureId}.json`)),
        input.listingCaptureId,
      );
      if (source.skuId !== component.identity.skuId) throw new TypeError("captured listing SKU differs from the current plan instance");
      if (EXCLUDED_LISTING_TERMS.test(source.title)) throw new TypeError("captured listing is not eligible as a current-new observation");
      const label = input.variantLabel.trim();
      const matches = source.variants.filter((variant) => variant.label.trim() === label);
      if (matches.length !== 1) throw new TypeError("captured listing variant selection is missing or ambiguous");
      const variant = matches[0]!;
      if (variant.stock === 0) throw new TypeError("captured listing variant is out of stock");
      const identityClaimIds = [...component.identity.identityClaimIds].sort();
      const listingCaptureId = `price-capture-${sha256Json({
        sourceListingCaptureId: input.listingCaptureId,
        sourceListingCaptureContentHash: source.contentHash,
        skuId: component.identity.skuId,
        variantIdentityFactIds: identityClaimIds,
        variantLabel: label,
      }).slice(0, 32)}`;
      const material = {
        schemaVersion: "listing-capture-v1" as const,
        listingCaptureId,
        skuId: component.identity.skuId,
        variantIdentityFactIds: identityClaimIds,
        platform: platform(source.platform),
        sellerTier: "unknown" as const,
        condition: "new" as const,
        stockStatus: variant.stock === null ? "seller_claimed" as const : "in_stock" as const,
        priceCny: variant.amount,
        comparableTotalCny: variant.amount,
        invoiceStatus: "unknown" as const,
        warrantyStatus: "unknown" as const,
        canonicalUrl: source.canonicalUrl,
        capturedAt: source.fetchedAt,
        sourceListingCaptureId: input.listingCaptureId,
        sourceListingCaptureContentHash: source.contentHash,
      };
      const listingCapture: ImmutableListingCapture = {
        ...material,
        contentHash: await hashContent(material, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }),
      };
      const observation = derivePriceObservationFromCapture(listingCapture);
      await this.options.prices.putListingCaptureAtRoot(activeRoot, listingCapture, { expectedRevision: 0 });
      await this.options.prices.putObservationAtRoot(activeRoot, observation, { expectedRevision: 0 });
      const currentTime = this.now();
      const rebuilt = await this.options.snapshots.rebuildAtRoot(activeRoot, currentTime.slice(0, 10), currentTime);
      return {
        schemaVersion: "price-observation-intake-result-v1",
        planId: input.planId,
        instanceId: input.instanceId,
        listingCapture: structuredClone(listingCapture),
        observation: structuredClone(observation),
        snapshot: structuredClone(rebuilt.snapshot),
        requiresEvaluationRefresh: true,
      };
    })).result;
  }
}
