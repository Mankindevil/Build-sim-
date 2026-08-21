#!/usr/bin/env node
/**
 * Rebuild data/prices/latest.json (and a dated snapshot) from the two curated
 * inputs: manual-quotes.json and local-quotes.json. Audited rows only.
 *
 *   npm run price:refresh
 *   npm run price:refresh -- --asOf=2026-08-21
 *
 * Fetching lives in the local price server (npm run price:serve).
 */

import { buildAndWriteLatest, loadLocalQuotes, loadManualQuotes, today } from "../price-server/store.mjs";

function parseArgs(argv) {
  const out = { asOf: today() };
  for (const a of argv) {
    if (a.startsWith("--asOf=")) out.asOf = a.slice("--asOf=".length);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [manual, local] = await Promise.all([loadManualQuotes(), loadLocalQuotes()]);
const snapshot = await buildAndWriteLatest(args.asOf);

console.log(
  `Wrote ${snapshot.quotes.length} audited quote(s) → data/prices/latest.json and snapshots/${args.asOf}.json`,
);
console.log(`  manual-quotes.json: ${manual.length} · local-quotes.json: ${local.length}`);
if (snapshot.quotes.length === 0) {
  console.log('Tip: 用 npm run price:serve 在页面里抓价并确认，或手填 manual-quotes.json（evidence: "audited"）');
}
