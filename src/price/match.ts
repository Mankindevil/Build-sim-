import { brandZh, searchQueryFromMpn } from "./queries.mjs";
import type { SkuRecord } from "../sku/types";

/**
 * `mpn`    — title contains the full part number; safe to audit in one click.
 * `spec`   — every catalog spec is confirmed in the title, but no part number.
 * `weak`   — plausible listing with specs unconfirmed.
 * `reject` — second-hand, an accessory, or a spec that contradicts the SKU.
 */
export type MatchKind = "mpn" | "spec" | "weak" | "reject";

export interface MatchResult {
  kind: MatchKind;
  /** Human reasons shown next to the candidate row. */
  reasons: string[];
}

/** Spec fields worth checking against a listing title. */
export interface MatchSpec {
  brand?: string;
  ddr?: number;
  speedMt?: number;
  /** Kit total; per-module size is derived with `modules`. */
  capacityGb?: number;
  modules?: number;
  ecc?: boolean;
}

export interface MatchOptions {
  /** Module count for memory kits; a 2-module kit must not match a single stick. */
  modules?: number;
  spec?: MatchSpec;
}

/** Listing words that make a quote unusable as a new-retail price anchor. */
const REJECT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /二手|拆机|拆封|翻新/, reason: "二手 / 拆机" },
  { pattern: /散片|裸装无包装/, reason: "散片" },
  { pattern: /兼容|适用于|替换用/, reason: "兼容品 / 非原厂" },
  { pattern: /赠品|空盒|仅包装|仅支架|仅线材/, reason: "非整品" },
  { pattern: /咨询客服|定制|预售不发/, reason: "非可直接下单价" },
];

const SPEED_TOKENS =
  /\b(3200|3600|4000|4400|4800|5200|5600|5800|6000|6200|6400|6600|6800|7000|7200|7600|8000|8400)\b/g;

/** Uppercase and drop separators so `KF564C32RSK2-32` matches `KF564C32RSK2 32`. */
export function normalizeForMatch(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A part number short enough that a substring hit proves nothing: `N6` is inside
 * `N600` and `N6P`, and JONSBO sells a C6, an N2, an N3 and an N5 besides. Long
 * numbers (`KF564C32RSK2-32`, `CP-9020284`) carry their own uniqueness and keep
 * using the substring rule.
 */
const MODEL_DESIGNATOR = /^[A-Z]{1,3}\d{1,4}[A-Z]?$/;

/** Interface names shaped like a model designator; never a rival product. */
const INTERFACE_TOKENS = new Set(["M2", "U2"]);

export function modelDesignator(core: string): string | null {
  const upper = core.trim().toUpperCase();
  return MODEL_DESIGNATOR.test(upper) ? upper : null;
}

/**
 * Alphanumeric runs of a title. CJK separates tokens, so `乔思伯N6机箱` yields
 * `N6` — the model has to appear as its own word, not as a prefix of `N600`.
 */
export function titleTokens(title: string): string[] {
  return title
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Tokens shaped like our designator, worth naming in a rejection reason. */
function rivalModels(tokens: string[], designator: string): string[] {
  const letters = designator.replace(/[^A-Z]/g, "").length;
  const digits = designator.replace(/[^0-9]/g, "").length;
  return tokens.filter(
    (t) =>
      t !== designator &&
      !INTERFACE_TOKENS.has(t) &&
      MODEL_DESIGNATOR.test(t) &&
      t.replace(/[^A-Z]/g, "").length === letters &&
      t.replace(/[^0-9]/g, "").length === digits,
  );
}

/** Part number without trailing notes such as `(Ver 5.43.13)`. */
export function mpnCore(mpn: string): string {
  return searchQueryFromMpn(mpn);
}

/** Corsair and similar vendors gate QVL rows on a board revision. */
export function mpnVersionNote(mpn: string): string | null {
  const m = mpn.match(/Ver\s*([\w.]+)/i);
  return m?.[1] ? `需核对 Ver ${m[1]}` : null;
}

/** Catalog attributes → the specs a marketplace title can be checked against. */
export function specFromSku(sku: SkuRecord): MatchSpec {
  const attrs = (sku.attrs ?? {}) as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const v = Number(attrs[key]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const spec: MatchSpec = {};
  if (sku.brand) spec.brand = sku.brand;
  if (sku.category === "memory") spec.ddr = 5;
  const speed = num("speedMt") ?? num("jedecMt");
  if (speed !== undefined) spec.speedMt = speed;
  const capacity = num("capacityGb");
  if (capacity !== undefined) spec.capacityGb = capacity;
  const modules = num("modules");
  if (modules !== undefined) spec.modules = modules;
  if (typeof attrs["ecc"] === "boolean") spec.ecc = attrs["ecc"];
  return spec;
}

interface SpecVerdict {
  conflicts: string[];
  confirmed: string[];
  unconfirmed: string[];
  /**
   * Confirmations that actually narrow the field. The brand is excluded: it
   * cannot tell an N6 from anything else JONSBO sells, so a brand hit on its own
   * must never read as "all specs line up".
   */
  discriminating: number;
}

function checkSpec(title: string, spec: MatchSpec): SpecVerdict {
  const conflicts: string[] = [];
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  const upper = title.toUpperCase();

  if (spec.ddr) {
    const gen = title.match(/DDR\s?([345])/i)?.[1];
    if (!gen) unconfirmed.push("未写 DDR 代数");
    else if (Number(gen) !== spec.ddr) conflicts.push(`标题 DDR${gen} ≠ DDR${spec.ddr}`);
    else confirmed.push(`DDR${spec.ddr}`);
  }

  if (spec.speedMt) {
    const speeds = [...title.matchAll(SPEED_TOKENS)].map((m) => Number(m[1]));
    if (speeds.length === 0) unconfirmed.push("未写频率");
    else if (!speeds.includes(spec.speedMt)) conflicts.push(`频率 ${speeds.join("/")} ≠ ${spec.speedMt}`);
    else confirmed.push(`${spec.speedMt}MT/s`);
  }

  if (spec.capacityGb) {
    const modules = spec.modules && spec.modules > 0 ? spec.modules : 1;
    const perModule = Math.round(spec.capacityGb / modules);
    const accepted = new Set([spec.capacityGb, perModule]);
    const caps = [...title.matchAll(/(\d+)\s*G(?:B)?\b/gi)].map((m) => Number(m[1]));
    if (caps.length === 0) unconfirmed.push("未写容量");
    else if (!caps.some((c) => accepted.has(c))) {
      conflicts.push(`容量 ${caps.join("/")}G ≠ ${[...accepted].join("/")}G`);
    } else confirmed.push(`${caps.find((c) => accepted.has(c))}G`);
  }

  if (spec.ecc === true) {
    if (/非\s?ECC|无\s?ECC|NON-?ECC/i.test(title)) conflicts.push("标题标注非 ECC");
    else if (/\bECC\b/i.test(upper)) confirmed.push("ECC");
    else unconfirmed.push("未写 ECC");
  } else if (spec.ecc === false && /\bECC\b/i.test(upper)) {
    // Consumer kits do advertise on-die ECC, so this is a review flag, not a conflict.
    unconfirmed.push("标题含 ECC，目标为非 ECC 内存");
  }

  const discriminating = confirmed.length;

  if (spec.brand) {
    const zh = brandZh(spec.brand) as string | null;
    const hit =
      upper.includes(spec.brand.toUpperCase()) || (zh !== null && title.includes(zh));
    if (hit) confirmed.push(zh ?? spec.brand);
    else unconfirmed.push("品牌未出现");
  }

  return { conflicts, confirmed, unconfirmed, discriminating };
}

export function scoreTitleAgainstMpn(
  title: string,
  mpn: string,
  options: MatchOptions = {},
): MatchResult {
  const spec = options.spec;
  const core = mpnCore(mpn);
  if (!title.trim() || (!core && !spec)) {
    return { kind: "reject", reasons: ["标题或料号为空"] };
  }

  for (const { pattern, reason } of REJECT_PATTERNS) {
    if (pattern.test(title)) {
      return { kind: "reject", reasons: [reason] };
    }
  }

  const modules = options.modules ?? spec?.modules ?? 0;
  if (modules > 1 && /单条|1条装|单根/.test(title) && !spec?.ecc) {
    return { kind: "reject", reasons: [`套装料号（${modules} 条）匹配到单条商品`] };
  }

  const reasons: string[] = [];
  const versionNote = core ? mpnVersionNote(mpn) : null;
  if (versionNote) reasons.push(versionNote);

  const verdict = spec ? checkSpec(title, spec) : null;
  if (verdict?.conflicts.length) {
    return { kind: "reject", reasons: verdict.conflicts };
  }
  if (verdict?.confirmed.length) reasons.push(`规格 ${verdict.confirmed.join(" / ")} ✓`);

  const designator = core ? modelDesignator(core) : null;
  if (designator) {
    const tokens = titleTokens(title);
    if (tokens.includes(designator)) {
      reasons.unshift(`型号 ${designator} ✓`);
      return { kind: "mpn", reasons };
    }
    // Nothing else identifies a part whose whole part number is its model name,
    // so an unnamed model is not a cheaper listing of it — it is an unknown
    // product, and pricing it would be a guess dressed up as a quote.
    const rivals = rivalModels(tokens, designator);
    return {
      kind: "reject",
      reasons: rivals.length
        ? [`标题型号 ${rivals.join("/")} ≠ ${designator}`, `标题未出现型号 ${designator}`]
        : [`标题未出现型号 ${designator}`],
    };
  }

  const hasMpn = Boolean(core) && normalizeForMatch(title).includes(normalizeForMatch(core));
  if (hasMpn) {
    return { kind: "mpn", reasons };
  }

  reasons.push(...(verdict?.unconfirmed ?? []));
  if (verdict && verdict.unconfirmed.length === 0 && verdict.discriminating > 0) {
    reasons.unshift("规格全部对上，但标题无料号");
    return { kind: "spec", reasons };
  }

  reasons.unshift("标题未出现完整料号");
  return { kind: "weak", reasons };
}

/** Only exact part-number hits may be audited without an explicit override. */
export function canAuditWithoutOverride(result: MatchResult): boolean {
  return result.kind === "mpn";
}
