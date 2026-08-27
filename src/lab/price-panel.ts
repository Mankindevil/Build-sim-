/**
 * Price panel wiring: talks to the local collector (npm run price:serve),
 * scores candidates against the catalog MPN, and only lets confirmed rows
 * become audited quotes.
 */

import type { SkuCatalog, SkuRecord } from "../sku/types";
import type { PriceProvenance, PriceQuote, PriceSnapshotFile } from "../price/types";
import { buildSkuSearchLinks, pickOfficialUrl } from "../price/search";
import { escapeRuntimeHtml, safeHttpsUrl } from "./runtime-dom";
import {
  canAuditWithoutOverride,
  scoreTitleAgainstMpn,
  specFromSku,
  type MatchResult,
} from "../price/match";
import { auditBlockReason, flagCandidates, median, type PriceCandidate } from "../price/sanity";

const API = "/api/price";

const CHANNEL_LABELS: Record<string, string> = {
  jd: "京东",
  taobao: "淘宝",
  pdd: "拼多多",
  amazon: "亚马逊",
  official: "官网",
};

/** One option on a listing, e.g. `n6 中型钢板机箱9盘位热插拔`. */
interface VariantRow {
  skuId: string;
  label: string;
  amount: number | null;
  currency: string | null;
  stock: number | null;
}

interface Candidate extends PriceCandidate {
  candidateId?: string;
  listingCaptureId?: string;
  variants?: VariantRow[];
  variantStatus?: string;
  variantSource?: string | null;
  variantNotes?: string[];
}

interface FxFile {
  asOf: string | null;
  source?: string;
  rates: Record<string, number>;
}

interface CollectResult {
  skuId: string;
  channel: string;
  status: string;
  via: string | null;
  reason: string | null;
  searchUrl: string | null;
  count: number;
}

interface ServiceState {
  asOf: string | null;
  channels: string[];
  availability: Record<string, { available: boolean; api: { available: boolean; reason?: string }; browser: { available: boolean; reason?: string } }>;
  counts: { manual: number; local: number; latest: number };
  localQuotes: { skuId: string; platform: string; priceCny: number; match?: PriceQuote["match"]; title?: string; variantLabel?: string; fetchedAt?: string; listingUrl?: string; provenanceId?: string; sourceHash?: string; priceAmount?: number; priceCurrency?: string; provenance?: PriceProvenance }[];
  snapshotMeta?: { schemaVersion?: string; snapshotId?: string | null; inputHash?: string | null; contentHash?: string | null; catalogVersion?: string | null; priceVersion?: string | null; generatedAt?: string | null } | null;
  candidates: Candidate[];
  fx?: FxFile;
  trackableSkus: { id: string; name: string; mpn: string; category?: string }[];
}

let state: ServiceState | null = null;
let lastResults: CollectResult[] = [];
let serviceOnline = false;
let catalogRef: SkuCatalog | null = null;
let onAudited: (() => Promise<void> | void) | null = null;

/** How many listings per SKU get their variant table read without being asked. */
const AUTO_RESOLVE_PER_SKU = 5;

const filters = { mpnOnly: false, hideSuspect: false };
/** Which SKU groups the user has expanded; kept across re-renders. */
const openGroups = new Set<string>();
/** Variant picks are per listing URL, so they survive a state refresh. */
const pickedVariant = new Map<string, number>();
const resolving = new Set<string>();
let resolveProgress = "";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(text: string): string {
  return escapeRuntimeHtml(text);
}

function safeHref(value: unknown): string | null {
  const href = safeHttpsUrl(value);
  return href ? esc(href) : null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`采集服务未返回 JSON（${res.status}）`);
  }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

function skuById(id: string): SkuRecord | undefined {
  return catalogRef?.skus.find((s) => s.id === id);
}

function matchFor(candidate: Candidate): MatchResult {
  const sku = skuById(candidate.skuId);
  const mpn = sku?.mpn ?? candidate.mpn;
  if (!sku && !mpn) return { kind: "weak", reasons: ["目录里找不到该 SKU"] };
  return scoreTitleAgainstMpn(candidate.title, mpn ?? "", {
    ...(sku ? { spec: specFromSku(sku) } : {}),
  });
}

function renderStatus(): void {
  const el = $("price-service-status");
  if (!el) return;

  if (!serviceOnline) {
    el.dataset.level = "warn";
    el.innerHTML = `采集服务未启动 · 运行 <code>npm run price:serve</code> 后点刷新（页面仍可用仓库快照与搜料号链接）`;
    return;
  }
  const usable = Object.entries(state?.availability ?? {})
    .filter(([, v]) => v.available)
    .map(([k]) => CHANNEL_LABELS[k] ?? k);
  el.dataset.level = usable.length > 1 ? "ok" : "warn";
  el.innerHTML =
    `服务在线 · 可用渠道：${usable.length ? esc(usable.join(" / ")) : "无"}` +
    ` · 快照 ${esc(state?.asOf ?? "—")} · 本地审计 ${state?.counts.local ?? 0} 条` +
    (usable.length <= 1
      ? ` · 淘宝/拼多多需先 <code>npm run price:login</code> 登录，或在 <code>.env.local</code> 配官方密钥`
      : "");
}

function renderChannelPicker(): void {
  const box = $("price-channel-picker");
  if (!box || box.dataset.ready === "true") return;
  const channels = state?.channels ?? ["jd", "taobao", "pdd", "amazon", "official"];
  box.innerHTML = channels
    .map((c) => {
      const av = state?.availability?.[c];
      const hint = av?.available ? "" : ` title="${esc(av?.api.reason ?? av?.browser.reason ?? "不可用")}"`;
      return `<label${hint}><input type="checkbox" data-price-channel="${esc(c)}" ${av?.available ? "checked" : ""}> ${esc(CHANNEL_LABELS[c] ?? c)}</label>`;
    })
    .join("");
  box.dataset.ready = "true";
}

function selectedChannels(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("[data-price-channel]"))
    .filter((el) => el.checked)
    .map((el) => el.dataset.priceChannel ?? "")
    .filter(Boolean);
}

const MATCH_BADGE: Record<string, string> = {
  mpn: "料号匹配",
  spec: "规格匹配",
  weak: "需人工核对",
  reject: "已排除",
};

const MATCH_RANK: Record<string, number> = { mpn: 0, spec: 1, weak: 2, reject: 3 };

function fxRate(currency: string | null | undefined): number | null {
  if (!currency || currency === "CNY") return null;
  return state?.fx?.rates?.[currency] ?? null;
}

/**
 * The option whose own text matches the part number. Returns null when none does:
 * with several variants on one listing, guessing which is ours is exactly the
 * mistake that made the captured prices wrong in the first place.
 */
function autoPickIndex(c: Candidate): number | null {
  const sku = skuById(c.skuId);
  const mpn = sku?.mpn ?? c.mpn;
  if (!mpn) return null;
  let best: number | null = null;
  let bestRank = 9;
  (c.variants ?? []).forEach((v, i) => {
    if (v.amount === null) return;
    // A blob of text is a container the resolver mistook for an option.
    if (v.label.length > 40) return;
    const rank = MATCH_RANK[scoreTitleAgainstMpn(v.label, mpn, sku ? { spec: specFromSku(sku) } : {}).kind] ?? 9;
    if (rank < bestRank && rank <= 1) {
      bestRank = rank;
      best = i;
    }
  });
  return best;
}

/** `-1` records an explicit "none"; absent means fall back to the automatic pick. */
function pickIndexFor(c: Candidate): number | null {
  const explicit = pickedVariant.get(c.url);
  if (explicit === -1) return null;
  if (explicit !== undefined) return explicit;
  return autoPickIndex(c);
}

/**
 * The row as it stands after a variant has been picked. A listing headline price
 * describes the listing, not our SKU, so only this object is ever banked.
 */
function effectiveCandidate(c: Candidate): Candidate {
  const picked = pickIndexFor(c);
  const variant = picked === null ? undefined : c.variants?.[picked];
  if (!variant || variant.amount === null) return c;
  const rate = fxRate(variant.currency ?? c.priceCurrency);
  const cny = rate ? Math.round(variant.amount * rate * 100) / 100 : variant.amount;
  return {
    ...c,
    priceAmount: variant.amount,
    priceCurrency: variant.currency ?? c.priceCurrency,
    priceCny: cny,
    priceKind: "variant",
    variantLabel: variant.label,
    variantSkuId: variant.skuId,
    // The number came from the variant table, not from the card's text, so the
    // card's reading problems no longer apply. The magnitude gate is re-run on the
    // new value where the group is assembled.
    suspect: null,
    glued: false,
    ...(rate
      ? { fxAssumed: { rate, asOf: state?.fx?.asOf ?? "", source: state?.fx?.source ?? "" } }
      : { fxAssumed: null }),
  };
}

function priceCell(c: Candidate): string {
  // Rows captured before extraction was reworked only carry `priceCny`.
  const shown = c.priceAmount ?? c.priceCny;
  if (typeof shown !== "number") {
    return `<span class="text-muted">未取到</span><br><small>${esc(c.reason ?? c.suspect?.message ?? "")}</small>`;
  }
  const sym = c.priceCurrency === "CNY" || !c.priceCurrency ? "¥" : c.priceCurrency === "USD" ? "$" : "";
  const main = `<strong>${sym}${shown}</strong>`;
  const bits: string[] = [];
  if (c.priceKind === "variant") bits.push(`规格：${esc(c.variantLabel ?? "")}`);
  else bits.push("起价 · 未定规格");
  if (c.fxAssumed) bits.push(`含汇率假设 1 ${c.priceCurrency}=${c.fxAssumed.rate} CNY → ¥${c.priceCny}`);
  if (c.priceText) bits.push(`原文「${esc(c.priceText)}」`);
  if (c.salesText) bits.push(esc(c.salesText));
  if (c.suspect) bits.push(`<span class="price-flag">${esc(c.suspect.message)}</span>`);
  return `${main}<br><small>${bits.join(" · ")}</small>`;
}

function variantCell(c: Candidate, i: number): string {
  if (resolving.has(c.url)) return `<small>解析中…</small>`;
  const variants = c.variants ?? [];
  if (variants.length === 0) {
    const note = c.variantStatus && c.variantStatus !== "ok" ? `<br><small>${esc((c.variantNotes ?? []).join("；"))}</small>` : "";
    return `<button type="button" class="price-variant-btn" data-price-variant="${i}">解析规格价</button>${note}`;
  }
  const picked = pickIndexFor(c);
  const auto = !pickedVariant.has(c.url) && picked !== null;
  const options = variants
    .map((v, vi) => {
      const price = v.amount === null ? "无价" : `${v.currency === "USD" ? "$" : "¥"}${v.amount}`;
      return `<option value="${vi}" ${picked === vi ? "selected" : ""}>${esc(v.label.slice(0, 40))} · ${price}</option>`;
    })
    .join("");
  return `<select class="price-variant-picker" data-price-pick="${i}">
      <option value="-1" ${picked === null ? "selected" : ""}>不选规格（共 ${variants.length} 个）</option>${options}
    </select>
    <br><small>${auto ? "按料号自动选中 · " : ""}来源 ${esc(c.variantSource ?? "-")}</small>`;
}

function renderCandidates(): void {
  const host = $("price-candidates");
  if (!host) return;

  const candidates = state?.candidates ?? [];
  const problems = lastResults.filter((r) => r.status !== "ok");

  const problemHtml = problems.length
    ? `<ul class="price-problem-list">${problems
        .map((r) => {
          const label = CHANNEL_LABELS[r.channel] ?? r.channel;
          const href = safeHref(r.searchUrl);
          const link = href
            ? ` <a href="${href}" target="_blank" rel="noreferrer">手动打开</a>`
            : "";
          const tag = r.status === "needsLogin" ? "需登录" : "未取到";
          return `<li><b>${esc(label)}</b> ${tag}：${esc(r.reason ?? "")}${link}</li>`;
        })
        .join("")}</ul>`
    : "";

  if (candidates.length === 0) {
    host.innerHTML = `${problemHtml}<p class="text-muted">暂无候选。点「抓取全部」或某行的「抓取」，也可以直接点搜料号链接人工查价。</p>`;
    bindCandidateActions();
    return;
  }

  // Index first: rows are grouped per SKU, but the audit handlers address rows by
  // their position in the unfiltered state array.
  const indexed = candidates.map((c, i) => ({ c, i, match: matchFor(c) }));
  const groups = new Map<string, typeof indexed>();
  for (const entry of indexed) {
    const list = groups.get(entry.c.skuId) ?? [];
    list.push(entry);
    groups.set(entry.c.skuId, list);
  }

  const filterBar = `<div class="price-filters">
      <label><input type="checkbox" data-price-filter="mpnOnly" ${filters.mpnOnly ? "checked" : ""}> 只看料号匹配</label>
      <label><input type="checkbox" data-price-filter="hideSuspect" ${filters.hideSuspect ? "checked" : ""}> 隐藏可疑价格</label>
      <span class="text-muted">${groups.size} 个部件 · ${candidates.length} 条候选${resolveProgress ? ` · ${esc(resolveProgress)}` : ""}</span>
    </div>`;

  const groupHtml = Array.from(groups.entries())
    .map(([skuId, entries]) => {
      const sku = skuById(skuId);

      // Judge the rows as they now stand: once a variant is picked its price, not
      // the card's, is what has to look plausible next to the other captures.
      const effByIndex = new Map(entries.map((e) => [e.i, effectiveCandidate(e.c)]));
      flagCandidates(Array.from(effByIndex.values()), {
        reference: (row) => matchFor(row as Candidate).kind !== "reject",
      });
      const eff = (i: number) => effByIndex.get(i) as Candidate;

      const visible = entries
        .filter((e) => !filters.mpnOnly || e.match.kind === "mpn")
        .filter((e) => !filters.hideSuspect || !eff(e.i).suspect)
        .sort((a, b) => {
          const sa = eff(a.i);
          const sb = eff(b.i);
          // Suspect rows sink; then best match; then cheapest.
          const suspect = Number(Boolean(sa.suspect)) - Number(Boolean(sb.suspect));
          if (suspect !== 0) return suspect;
          const rank = (MATCH_RANK[a.match.kind] ?? 9) - (MATCH_RANK[b.match.kind] ?? 9);
          if (rank !== 0) return rank;
          return (sa.priceCny ?? Infinity) - (sb.priceCny ?? Infinity);
        });

      const effective = entries.map((e) => eff(e.i));
      const banked = effective.filter((c) => auditBlockReason(c) === null && typeof c.priceCny === "number");
      const plausible = effective
        .filter((c) => !c.suspect && typeof c.priceCny === "number")
        .map((c) => c.priceCny as number);
      const cheapest = banked.length > 0 ? Math.min(...banked.map((c) => c.priceCny as number)) : null;
      const spread =
        plausible.length === 0
          ? ""
          : plausible.length === 1
            ? `候选 ¥${plausible[0]}`
            : `候选 ¥${Math.min(...plausible)}–¥${Math.max(...plausible)} · 中位 ¥${median(plausible)}`;
      const chips = Array.from(
        entries.reduce((acc, e) => acc.set(e.c.channel, (acc.get(e.c.channel) ?? 0) + 1), new Map<string, number>()),
      )
        .map(([ch, n]) => `<span class="price-chip">${esc(CHANNEL_LABELS[ch] ?? ch)} ${n}</span>`)
        .join("");
      const flagged = effective.filter((c) => c.suspect).length;
      const summary = [
        cheapest !== null ? `规格价最低 ¥${cheapest}` : "还没有规格级价格",
        spread,
        flagged > 0 ? `<span class="price-flag">${flagged} 条读数可疑</span>` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      const rows = visible
        .map(({ c: raw, i, match }) => {
          const c = eff(i);
          const block = auditBlockReason(c);
          const canOneClick = canAuditWithoutOverride(match) && block === null;
          const level = c.suspect ? "bad" : match.kind === "mpn" ? "ok" : match.kind === "reject" ? "bad" : "warn";
          const override =
            match.kind !== "reject" && !canOneClick && block === null
              ? `<label class="price-override"><input type="checkbox" data-price-override="${i}"> 我已核对标题</label>`
              : "";
          const action =
            match.kind === "reject"
              ? ""
              : `<button type="button" class="price-audit-btn" data-price-audit="${i}" ${canOneClick ? "" : "disabled"} ${block ? `title="${esc(block)}"` : ""}>确认入账</button>`;
          const blockNote = block && match.kind !== "reject" ? `<br><small>${esc(block)}</small>` : "";
          const href = safeHref(c.url);
          const title = esc(c.title.slice(0, 80));
          const listing = href
            ? `<a href="${href}" target="_blank" rel="noreferrer">${title}</a>`
            : `<span>${title}</span>`;
          return `<tr data-level="${level}">
            <td>${esc(CHANNEL_LABELS[c.channel] ?? c.channel)}<br><small>搜「${esc(c.query ?? "")}」</small></td>
            <td>${listing}</td>
            <td>${priceCell(c)}</td>
            <td>${variantCell(raw, i)}</td>
            <td class="status-${level}">${MATCH_BADGE[match.kind]}<br><small>${esc(match.reasons.join("；"))}</small></td>
            <td>${override}${action}${blockNote}</td>
          </tr>`;
        })
        .join("");

      const body =
        visible.length === 0
          ? `<p class="text-muted">当前过滤条件下这个部件没有候选。</p>`
          : `<div class="table-responsive"><table class="table table-sm">
              <thead><tr><th>渠道</th><th>商品标题</th><th>价格</th><th>规格</th><th>匹配</th><th>操作</th></tr></thead>
              <tbody>${rows}</tbody></table></div>`;

      return `<details class="price-group" data-price-group="${esc(skuId)}" ${openGroups.has(skuId) ? "open" : ""}>
          <summary class="price-group-summary">
            <b>${esc(sku?.name ?? skuId)}</b> <small>${esc(sku?.mpn ?? entries[0]?.c.mpn ?? "")}</small>
            <span class="price-group-meta">${chips} ${summary}</span>
          </summary>
          ${body}
        </details>`;
    })
    .join("");

  host.innerHTML = `${problemHtml}${filterBar}${groupHtml}`;
  bindCandidateActions();
}

/** Ask the collector for one listing's variant table. */
async function resolveVariantsFor(candidate: Candidate): Promise<void> {
  if (resolving.has(candidate.url)) return;
  resolving.add(candidate.url);
  renderCandidates();
  try {
    const res = await api<{
      status: string;
      variants: VariantRow[];
      source?: string;
      notes?: string[];
      reason?: string;
    }>("/variants", {
      method: "POST",
      body: JSON.stringify({ skuId: candidate.skuId, channel: candidate.channel, url: candidate.url }),
    });
    candidate.variants = res.variants ?? [];
    candidate.variantStatus = res.status;
    candidate.variantSource = res.source ?? null;
    candidate.variantNotes = res.notes ?? (res.reason ? [res.reason] : []);
    // Which option is ours is decided at render time by `autoPickIndex`, so a
    // variant table that arrives from the server file behaves the same as one
    // fetched by this button.
    pickedVariant.delete(candidate.url);
  } catch (err) {
    candidate.variantStatus = "error";
    candidate.variantNotes = [(err as Error).message];
  } finally {
    resolving.delete(candidate.url);
    renderCandidates();
  }
}

/** After a capture, read the variant table of the most promising few per SKU. */
async function autoResolveVariants(): Promise<void> {
  const bySku = new Map<string, Candidate[]>();
  for (const c of state?.candidates ?? []) {
    const match = matchFor(c);
    if (match.kind === "reject" || match.kind === "weak") continue;
    if ((c.variants ?? []).length > 0) continue;
    const list = bySku.get(c.skuId) ?? [];
    list.push(c);
    bySku.set(c.skuId, list);
  }

  const queue: Candidate[] = [];
  for (const [, list] of bySku) {
    list.sort((a, b) => (MATCH_RANK[matchFor(a).kind] ?? 9) - (MATCH_RANK[matchFor(b).kind] ?? 9));
    queue.push(...list.slice(0, AUTO_RESOLVE_PER_SKU));
  }

  for (let i = 0; i < queue.length; i++) {
    resolveProgress = `解析规格价 ${i + 1}/${queue.length}`;
    await resolveVariantsFor(queue[i]!);
  }
  resolveProgress = "";
  renderCandidates();
}

function bindCandidateActions(): void {
  document.querySelectorAll<HTMLInputElement>("[data-price-filter]").forEach((box) => {
    box.addEventListener("change", () => {
      const key = box.dataset.priceFilter as keyof typeof filters;
      filters[key] = box.checked;
      renderCandidates();
    });
  });

  document.querySelectorAll<HTMLDetailsElement>("[data-price-group]").forEach((el) => {
    el.addEventListener("toggle", () => {
      const id = el.dataset.priceGroup ?? "";
      if (el.open) openGroups.add(id);
      else openGroups.delete(id);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-price-variant]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const candidate = state?.candidates?.[Number(btn.dataset.priceVariant)];
      if (candidate) void resolveVariantsFor(candidate);
    });
  });

  document.querySelectorAll<HTMLSelectElement>("[data-price-pick]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const candidate = state?.candidates?.[Number(sel.dataset.pricePick)];
      if (!candidate) return;
      pickedVariant.set(candidate.url, Number(sel.value));
      renderCandidates();
    });
  });

  document.querySelectorAll<HTMLInputElement>("[data-price-override]").forEach((box) => {
    box.addEventListener("change", () => {
      const idx = box.dataset.priceOverride;
      const btn = document.querySelector<HTMLButtonElement>(`[data-price-audit="${idx}"]`);
      if (btn) btn.disabled = !box.checked;
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-price-audit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.priceAudit);
      const raw = state?.candidates?.[idx];
      if (!raw) return;
      const candidate = effectiveCandidate(raw);
      const block = auditBlockReason(candidate);
      if (block) {
        window.alert(`不能入账：${block}`);
        return;
      }
      btn.disabled = true;
      btn.textContent = "写入中…";
      try {
        await api("/audit", {
          method: "POST",
          body: JSON.stringify({
            listingCaptureId: candidate.listingCaptureId,
            candidateId: candidate.candidateId,
            skuId: candidate.skuId,
            variantLabel: candidate.variantLabel ?? "",
          }),
        });
        btn.textContent = "已入账";
        await refreshState();
        await onAudited?.();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "确认入账";
        window.alert(`写入失败：${(err as Error).message}`);
      }
    });
  });
}

function renderLocalQuotes(): void {
  const host = $("price-local-quotes");
  if (!host) return;
  const quotes = state?.localQuotes ?? [];
  if (quotes.length === 0) {
    host.innerHTML = `<p class="text-muted">本地还没有审计价。确认入账后会写入 <code>data/prices/local-quotes.json</code> 并重算 <code>latest.json</code>。</p>`;
    return;
  }
  host.innerHTML = `<ul class="price-local-list">${quotes
    .map(
      (q) =>
        `<li><b>${esc(skuById(q.skuId)?.name ?? q.skuId)}</b> · ${esc(CHANNEL_LABELS[q.platform] ?? q.platform)} · ¥${q.priceCny}${
          q.variantLabel ? ` · <small>规格「${esc(q.variantLabel)}」</small>` : ""
        }${q.fetchedAt ? ` · <small>snapshot ${esc(q.fetchedAt.slice(0, 10))}</small>` : ""}${
          safeHref(q.listingUrl) ? ` · <a href="${safeHref(q.listingUrl)}" target="_blank" rel="noreferrer">来源</a>` : ""
        }${q.provenanceId ? ` · <small>prov ${esc(q.provenanceId.slice(0, 12))}</small>` : ""}
         <button type="button" class="price-unaudit-btn" data-price-unaudit="${esc(q.skuId)}" data-price-platform="${esc(q.platform)}" data-price-variant-label="${esc(q.variantLabel ?? "")}">撤销</button></li>`,
    )
    .join("")}</ul>`;

  host.querySelectorAll<HTMLButtonElement>("[data-price-unaudit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const params = new URLSearchParams({
          skuId: btn.dataset.priceUnaudit ?? "",
          platform: btn.dataset.pricePlatform ?? "",
        });
        if (btn.dataset.priceVariantLabel) params.set("variantLabel", btn.dataset.priceVariantLabel);
        await api(`/audit?${params.toString()}`, { method: "DELETE" });
        await refreshState();
        await onAudited?.();
      } catch (err) {
        btn.disabled = false;
        window.alert(`撤销失败：${(err as Error).message}`);
      }
    });
  });
}

/** Per-SKU row: search links always, single-SKU fetch when the service is up. */
function renderSkuList(): void {
  const host = $("price-sku-list");
  if (!host) return;
  const tracked = state?.trackableSkus ?? [];
  const source: { id: string; name: string; mpn: string }[] = tracked.length
    ? tracked
    : (catalogRef?.skus ?? [])
        .filter((s) => s.mpn)
        .map((s) => ({ id: s.id, name: s.name, mpn: s.mpn ?? "" }));

  if (source.length === 0) {
    host.innerHTML = `<p class="text-muted">目录里还没有带料号的 SKU。</p>`;
    return;
  }

  host.innerHTML = `<ul class="price-sku-list">${source
    .map((entry) => {
      const sku = skuById(entry.id);
      const links = (sku ? buildSkuSearchLinks(sku, pickOfficialUrl(sku)) : [])
        .map((l) => {
          const href = safeHref(l.url);
          return href
            ? `<a href="${href}" target="_blank" rel="noreferrer" title="搜索词：${esc(l.query)}">${esc(l.label)}</a>`
            : "";
        })
        .filter(Boolean)
        .join(" · ");
      const fetchBtn = serviceOnline
        ? `<button type="button" class="price-fetch-btn" data-price-fetch="${esc(entry.id)}">抓取</button>`
        : "";
      return `<li><b>${esc(entry.name)}</b> <small>${esc(entry.mpn)}</small><br><small class="price-search-links">${links}</small> ${fetchBtn}</li>`;
    })
    .join("")}</ul>`;

  host.querySelectorAll<HTMLButtonElement>("[data-price-fetch]").forEach((btn) => {
    btn.addEventListener("click", () => collect([btn.dataset.priceFetch ?? ""]));
  });
}

async function refreshState(): Promise<void> {
  try {
    state = await api<ServiceState>("/state");
    // Re-run the plausibility gates on load, so rows captured by an older version
    // of the collector are judged by the current rules too. Listings the matcher
    // rejected are excluded from the baseline: a mis-matched cheap accessory must
    // not become the yardstick that makes the real part look overpriced.
    flagCandidates(state.candidates ?? [], { reference: (row) => matchFor(row as Candidate).kind !== "reject" });
    serviceOnline = true;
  } catch {
    serviceOnline = false;
    state = null;
  }
  renderStatus();
  renderChannelPicker();
  renderCandidates();
  renderLocalQuotes();
  renderSkuList();
}

async function collect(skuIds: string[] | null): Promise<void> {
  const btn = $("price-collect-all") as HTMLButtonElement | null;
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "抓取中…";
  }
  try {
    const payload = await api<{ results: CollectResult[]; candidates: Candidate[] }>("/collect", {
      method: "POST",
      body: JSON.stringify({
        ...(skuIds ? { skuIds } : {}),
        channels: selectedChannels(),
        limit: 5,
      }),
    });
    lastResults = payload.results;
    await refreshState();
    // A card price is only a listing headline, so the useful number comes from the
    // variant table. Read it for the most promising few without being asked.
    await autoResolveVariants();
  } catch (err) {
    window.alert(`抓取失败：${(err as Error).message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || "抓取全部";
    }
  }
}

/** Audited local quotes as a snapshot the catalog merge can consume in-memory. */
export function getLocalSnapshot(): PriceSnapshotFile | null {
  if (!state || state.localQuotes.length === 0) return null;
  return {
    schemaVersion: state.snapshotMeta?.schemaVersion === "1.1.0" ? "1.1.0" : "1.0.0",
    asOf: state.asOf ?? new Date().toISOString().slice(0, 10),
    ...(state.snapshotMeta?.snapshotId ? { snapshotId: state.snapshotMeta.snapshotId } : {}),
    ...(state.snapshotMeta?.inputHash ? { inputHash: state.snapshotMeta.inputHash } : {}),
    ...(state.snapshotMeta?.contentHash ? { contentHash: state.snapshotMeta.contentHash } : {}),
    ...(state.snapshotMeta?.catalogVersion ? { catalogVersion: state.snapshotMeta.catalogVersion } : {}),
    ...(state.snapshotMeta?.priceVersion ? { priceVersion: state.snapshotMeta.priceVersion } : {}),
    quotes: state.localQuotes.map((q) => ({
      skuId: q.skuId,
      platform: q.platform as PriceQuote["platform"],
      priceCny: q.priceCny,
      currency: "CNY",
      match: q.match ?? "manual",
      evidence: "audited",
      priceKind: "variant",
      ...(q.variantLabel ? { variantLabel: q.variantLabel } : {}),
      ...(q.priceCurrency ? { priceCurrency: q.priceCurrency } : {}),
      ...(q.priceAmount ? { priceAmount: q.priceAmount } : {}),
      ...(q.fetchedAt ? { fetchedAt: q.fetchedAt } : {}),
      ...(q.provenanceId ? { provenanceId: q.provenanceId } : {}),
      ...(q.sourceHash ? { sourceHash: q.sourceHash } : {}),
      ...(q.provenance ? { provenance: q.provenance } : {}),
      ...(q.listingUrl ? { listingUrl: q.listingUrl } : {}),
    })),
  };
}

export async function initPricePanel(options: {
  catalog: SkuCatalog;
  onAudited: () => Promise<void> | void;
}): Promise<void> {
  catalogRef = options.catalog;
  onAudited = options.onAudited;

  $("price-collect-all")?.addEventListener("click", () => collect(null));
  $("price-reload-state")?.addEventListener("click", () => void refreshState());

  await refreshState();
}

export function updatePriceCatalog(catalog: SkuCatalog): void {
  catalogRef = catalog;
}

export function isServiceOnline(): boolean {
  return serviceOnline;
}
