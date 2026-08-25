import { registryForUrl } from "./price-server/catalog/registry.mjs";
import { SearXngDiscoveryProvider } from "./price-server/catalog/searxng-discovery.mjs";

const query = String(process.env.SEARXNG_SMOKE_QUERY || "JONSBO N6").slice(0, 240);
const mpn = String(process.env.SEARXNG_SMOKE_MPN || "N6").slice(0, 120);
const domain = String(process.env.SEARXNG_SMOKE_DOMAIN || "jonsbo.com").toLocaleLowerCase();
if (!registryForUrl(new URL(`https://${domain}`))) throw new Error("SEARXNG_SMOKE_DOMAIN must be present in the trusted official registry");

const provider = new SearXngDiscoveryProvider({
  baseUrl: process.env.SEARXNG_BASE_URL || "http://127.0.0.1:8080",
  timeoutMs: 30_000,
  resultLimit: 5,
});
const results = await provider.discover({
  query: { raw: query, mpn },
  allowedDomains: [domain],
  limit: 5,
  signal: AbortSignal.timeout(30_000),
});
const report = {
  ok: results.length > 0,
  query,
  domain,
  count: results.length,
  providers: [...new Set(results.map((entry) => entry.provider))],
  officialDomainOnly: results.every((entry) => {
    const hostname = new URL(entry.url).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }),
  urls: results.map((entry) => entry.url),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok || !report.officialDomainOnly) process.exitCode = 1;
