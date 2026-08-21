/**
 * Price panel wiring: talks to the local collector (npm run price:serve),
 * scores candidates against the catalog MPN, and only lets confirmed rows
 * become audited quotes.
 */

import type { SkuCatalog, SkuRecord } from "../sku/types";
import type { PriceQuote, PriceSnapshotFile } from "../price/types";
import { buildSkuSearchLinks, pickOfficialUrl } from "../price/search";
import {
  canAuditWithoutOverride,
  scoreTitleAgainstMpn,
  specFromSku,
  type MatchResult,
} from "../price/match";

const API = "/api/price";

const CHANNEL_LABELS: Record<string, string> = {
  jd: "京东",
  taobao: "淘宝",
  pdd: "拼多多",
  amazon: "亚马逊",
  official: "官网",
};

interface Candidate {
  skuId: string;
  mpn: string;
  /** Keyword string that produced this row. */
  query: string;
  channel: string;
  platform: string;
  title: string;
  priceCny: number | null;
  url: string;
  fetchedAt: string;
  note?: string;
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
  localQuotes: { skuId: string; platform: string; priceCny: number; title?: string }[];
  candidates: Candidate[];
  trackableSkus: { id: string; name: string; mpn: string; category?: string }[];
}

let state: ServiceState | null = null;
let lastResults: CollectResult[] = [];
let serviceOnline = false;
let catalogRef: SkuCatalog | null = null;
let onAudited: (() => Promise<void> | void) | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
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
      return `<label${hint}><input type="checkbox" data-price-channel="${c}" ${av?.available ? "checked" : ""}> ${CHANNEL_LABELS[c] ?? c}</label>`;
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

function renderCandidates(): void {
  const host = $("price-candidates");
  if (!host) return;

  const candidates = state?.candidates ?? [];
  const problems = lastResults.filter((r) => r.status !== "ok");

  const problemHtml = problems.length
    ? `<ul class="price-problem-list">${problems
        .map((r) => {
          const label = CHANNEL_LABELS[r.channel] ?? r.channel;
          const link = r.searchUrl
            ? ` <a href="${esc(r.searchUrl)}" target="_blank" rel="noreferrer">手动打开</a>`
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

  const rows = candidates
    .map((c, i) => {
      const match = matchFor(c);
      const sku = skuById(c.skuId);
      const priceText = typeof c.priceCny === "number" ? `¥${c.priceCny}` : "价格未取到";
      const canOneClick = canAuditWithoutOverride(match) && typeof c.priceCny === "number";
      const level = match.kind === "mpn" ? "ok" : match.kind === "reject" ? "bad" : "warn";
      const badge = {
        mpn: "料号匹配",
        spec: "规格匹配",
        weak: "需人工核对",
        reject: "已排除",
      }[match.kind];
      const override =
        match.kind !== "reject" && !canOneClick && typeof c.priceCny === "number"
          ? `<label class="price-override"><input type="checkbox" data-price-override="${i}"> 我已核对标题</label>`
          : "";
      const action =
        match.kind === "reject" || typeof c.priceCny !== "number"
          ? ""
          : `<button type="button" class="price-audit-btn" data-price-audit="${i}" ${canOneClick ? "" : "disabled"}>确认入账</button>`;
      return `<tr data-level="${level}">
        <td>${esc(CHANNEL_LABELS[c.channel] ?? c.channel)}<br><small>搜「${esc(c.query ?? "")}」</small></td>
        <td>${esc(sku?.name ?? c.skuId)}<br><small>${esc(c.mpn)}</small></td>
        <td><a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.title.slice(0, 90))}</a></td>
        <td><strong>${esc(priceText)}</strong></td>
        <td class="status-${level}">${badge}<br><small>${esc(match.reasons.join("；"))}</small></td>
        <td><small>${esc(c.fetchedAt.slice(0, 19).replace("T", " "))}</small></td>
        <td>${override}${action}</td>
      </tr>`;
    })
    .join("");

  host.innerHTML = `${problemHtml}<div class="table-responsive"><table class="table table-sm"><thead><tr><th>渠道</th><th>SKU / 料号</th><th>商品标题</th><th>抓到价</th><th>匹配</th><th>抓取时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  bindCandidateActions();
}

function bindCandidateActions(): void {
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
      const candidate = state?.candidates?.[idx];
      if (!candidate || typeof candidate.priceCny !== "number") return;
      const match = matchFor(candidate);
      btn.disabled = true;
      btn.textContent = "写入中…";
      try {
        await api("/audit", {
          method: "POST",
          body: JSON.stringify({
            skuId: candidate.skuId,
            platform: candidate.platform,
            priceCny: candidate.priceCny,
            listingUrl: candidate.url,
            title: candidate.title,
            match: match.kind === "mpn" ? "mpn" : "manual",
            fetchedAt: candidate.fetchedAt,
            note: [`${CHANNEL_LABELS[candidate.channel] ?? candidate.channel} 抓取后人工确认`, ...match.reasons]
              .filter(Boolean)
              .join("；"),
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
        `<li><b>${esc(skuById(q.skuId)?.name ?? q.skuId)}</b> · ${esc(CHANNEL_LABELS[q.platform] ?? q.platform)} · ¥${q.priceCny}
         <button type="button" class="price-unaudit-btn" data-price-unaudit="${esc(q.skuId)}" data-price-platform="${esc(q.platform)}">撤销</button></li>`,
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
        .map(
          (l) =>
            `<a href="${esc(l.url)}" target="_blank" rel="noreferrer" title="搜索词：${esc(l.query)}">${esc(l.label)}</a>`,
        )
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
    schemaVersion: "1.0.0",
    asOf: state.asOf ?? new Date().toISOString().slice(0, 10),
    quotes: state.localQuotes.map((q) => ({
      skuId: q.skuId,
      platform: q.platform as PriceQuote["platform"],
      priceCny: q.priceCny,
      currency: "CNY",
      match: "manual",
      evidence: "audited",
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
