import { formatSnapshotStamp } from "../price/types";
import { buildSkuSearchLinks, pickOfficialUrl } from "../price/search";
import type { SkuCatalog, SkuRecord } from "../sku/types";

/** Runtime catalog rows are persisted server data, not trusted UI copy. */
export function escapeRuntimeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

/** External product/search links must never inherit executable browser schemes. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) return null;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Images may be HTTPS resources or assets shipped below the app's asset roots. */
export function safeCatalogImageUrl(value: unknown): string | null {
  const external = safeHttpsUrl(value);
  if (external) return external;
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (
    !input
    || input.startsWith("//")
    || /[%\\?#\u0000-\u001f\u007f]/.test(input)
    || !/^(?:\.\/|\/)?(?:public\/)?assets\/[A-Za-z0-9_./@+-]+$/.test(input)
  ) return null;
  let path = input.replace(/^\.\//, "").replace(/^\//, "");
  if (path.split("/").some((segment) => segment === "." || segment === ".." || segment === "")) return null;
  // Vite serves files below public/ from the root; normalize both catalog spellings
  // to the same browser path before checking that resolution stayed in /assets/.
  if (path.startsWith("public/assets/")) path = path.slice("public/".length);
  const normalized = new URL(`/${path}`, "https://build-lab.invalid/");
  if (normalized.origin !== "https://build-lab.invalid" || !normalized.pathname.startsWith("/assets/")) return null;
  return normalized.pathname;
}

export interface RuntimeProductCard {
  name: string;
  status: string;
  skuId: string;
  note?: string;
}

function productPriceText(sku: SkuRecord | undefined): string {
  const snapshot = sku?.price.snapshot;
  if (snapshot) {
    const variant = snapshot.variantLabel ? ` · 规格 ${snapshot.variantLabel}` : "";
    const provenance = snapshot.provenanceId ? ` · prov ${snapshot.provenanceId.slice(0, 12)}` : "";
    return ` · ¥${sku?.price.current} (${formatSnapshotStamp(snapshot)}${variant}${provenance})`;
  }
  if (typeof sku?.price.current === "number") return ` · ¥${sku.price.current}`;
  if (typeof sku?.price.paid === "number") return ` · 成交 ¥${sku.price.paid}`;
  return " · 价 unknown";
}

function appendSeparatedLinks(
  host: HTMLElement,
  links: { label: string; query: string; url: string }[],
): void {
  let appended = 0;
  for (const link of links) {
    const href = safeHttpsUrl(link.url);
    if (!href) continue;
    if (appended > 0) host.append(document.createTextNode(" · "));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.title = `搜索词：${link.query}`;
    anchor.textContent = link.label;
    host.append(anchor);
    appended += 1;
  }
}

/** Product gallery uses nodes/textContent so accepted catalog text is never markup. */
export function renderRuntimeProductGallery(
  gallery: HTMLElement,
  cards: RuntimeProductCard[],
  catalog: SkuCatalog,
): void {
  const fragment = document.createDocumentFragment();
  for (const card of cards) {
    const sku = catalog.skus.find((entry) => entry.id === card.skuId);
    const appearance = sku?.appearance;
    const imageUrl = safeCatalogImageUrl(appearance?.image);

    const article = document.createElement("article");
    article.className = "product-card";
    const visual = document.createElement("div");
    visual.className = "product-visual";
    visual.dataset.missing = imageUrl ? "false" : "true";
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = `${card.name} 厂商官方产品图`;
      image.loading = "lazy";
      image.addEventListener("error", () => { visual.dataset.missing = "true"; });
      visual.append(image);
      const fallback = document.createElement("div");
      fallback.className = "product-placeholder";
      fallback.textContent = "图片未加载；可打开官方页";
      visual.append(fallback);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "product-placeholder";
      placeholder.textContent = appearance?.note ?? card.note ?? "尚无对应官方缓存图";
      visual.append(placeholder);
    }

    const body = document.createElement("div");
    body.className = "product-card-body";
    const name = document.createElement("b");
    name.textContent = card.name;
    const status = document.createElement("span");
    status.textContent = `${card.status}${productPriceText(sku)}`;
    const note = document.createElement("small");
    note.textContent = appearance?.note ?? card.note ?? "精确 SKU 外观卡";
    body.append(name, status, note);

    const officialPage = safeHttpsUrl(appearance?.page);
    if (officialPage) {
      const link = document.createElement("a");
      link.href = officialPage;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "查看厂商官方页";
      body.append(link);
    }

    if (sku) {
      const searchRow = document.createElement("small");
      searchRow.className = "price-search-links";
      searchRow.append(document.createTextNode("搜料号："));
      appendSeparatedLinks(searchRow, buildSkuSearchLinks(sku, pickOfficialUrl(sku)));
      if (searchRow.querySelector("a")) body.append(searchRow);
    }

    article.append(visual, body);
    fragment.append(article);
  }
  gallery.replaceChildren(fragment);
}

export function renderBackplaneHarnessSummary(
  host: HTMLElement,
  role: string,
  psuName: string,
  leads: string,
): void {
  const name = document.createElement("b");
  name.textContent = psuName;
  host.replaceChildren(
    document.createTextNode(role),
    document.createElement("br"),
    name,
    document.createElement("br"),
    document.createTextNode(leads),
  );
}
