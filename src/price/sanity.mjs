/**
 * Plausibility gates for captured prices.
 *
 * Nothing here repairs a number. A price that fails a gate is marked and made
 * un-auditable, because the alternative — splitting `69948` into `699` and `48`
 * on a hunch — would be the model inventing a transaction price, which is the one
 * thing the price pipeline is not allowed to do.
 *
 * The magnitude gate compares a row against the other rows captured for the same
 * SKU rather than against any reference or MSRP, so it introduces no outside
 * assumption: it only says "this one disagrees with everything else we just saw".
 */

/** A row this many times above the SKU's typical reading is reported, never corrected. */
export const SUSPECT_RATIO = 4;

/** Below this many priced rows a median means little, so the gate stays quiet. */
export const MIN_ROWS_FOR_BASELINE = 3;

export function median(values) {
  const sorted = values.filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * A search-card price is the listing's headline number, which on Taobao/PDD is
 * its cheapest variant. Only a price resolved against one variant can stand for
 * our SKU, and a converted foreign price carries an exchange-rate assumption, so
 * neither of those may be audited.
 */
export function auditBlockReason(candidate) {
  if (typeof candidate.priceCny !== "number" || candidate.priceCny <= 0) return "没有可用价格";
  if (candidate.suspect) return candidate.suspect.message;
  if (candidate.fxAssumed) return "外币标价含汇率假设，不能作为成交价入账";
  if (candidate.priceKind !== "variant") return "这是列表起价，未确定规格；先解析规格价";
  return null;
}

export function isAuditable(candidate) {
  return auditBlockReason(candidate) === null;
}

/**
 * Adds `suspect` to every row: `null` when it passes, otherwise `{ code, message }`.
 *
 * The comparison is one-sided — only rows far *above* the group's median are
 * reported — because the failure this catches can only inflate a number: gluing a
 * sales count onto `699` gives `69948`, never `6`. Flagging cheap rows too would
 * mean flagging real prices, since a search page always mixes the part with
 * accessories: a genuine ¥2799 board looked "suspect" next to a ¥680 listing when
 * the cheapest row set the baseline.
 *
 * This is a backstop, not the main defence — a concatenated reading is refused
 * outright during extraction. So it is deliberately quiet: a false alarm here
 * costs a real price its one-click audit.
 *
 * `reference` optionally narrows which rows may form the baseline; the panel
 * passes it so a listing the matcher already rejected cannot skew the median.
 *
 * @param {Array<any>} candidates
 * @param {{ reference?: ((row: any) => boolean) | null | undefined }} [options]
 */
export function flagCandidates(candidates, { reference = null } = {}) {
  const bySku = new Map();
  for (const row of candidates) {
    const list = bySku.get(row.skuId) ?? [];
    list.push(row);
    bySku.set(row.skuId, list);
  }

  for (const [, rows] of bySku) {
    const eligible = rows.filter(
      (r) => !r.glued && typeof r.priceCny === "number" && r.priceCny > 0 && (!reference || reference(r)),
    );
    const baseline =
      eligible.length >= MIN_ROWS_FOR_BASELINE ? median(eligible.map((r) => r.priceCny)) : null;

    for (const row of rows) {
      if (row.glued) {
        row.suspect = {
          code: "glued",
          message: `读数可疑：价格与销量数字相连（原文「${row.priceText || row.gluedAmount || ""}」），已拒绝采信`,
        };
        continue;
      }
      if (typeof row.priceCny !== "number" || row.priceCny <= 0) {
        row.suspect = { code: "no-price", message: row.reason ?? "未取到价格" };
        continue;
      }
      if (baseline && row.priceCny / baseline > SUSPECT_RATIO) {
        const times = Math.round((row.priceCny / baseline) * 10) / 10;
        row.suspect = {
          code: "magnitude",
          message: `读数可疑：是同 SKU 候选中位数 ¥${baseline} 的 ${times} 倍（数字拼接只会放大价格，故只向上判）`,
        };
        continue;
      }
      row.suspect = null;
    }
  }
  return candidates;
}
