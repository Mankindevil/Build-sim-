import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let catalogPromise;

async function bundledCatalog() {
  catalogPromise ??= readFile(path.join(repositoryRoot, "data/skus/catalog.json"), "utf8").then(JSON.parse);
  return catalogPromise;
}

/** Keep local browser gates deterministic without requiring a price service. */
export async function installLocalCatalogRoute(page) {
  const catalog = await bundledCatalog();
  await page.route("**/api/price/catalog", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(catalog),
  }));
}
