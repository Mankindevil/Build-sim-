#!/usr/bin/env node
/**
 * Save real search-result cards as test fixtures.
 *
 *   npm run price:fixture -- --channel taobao --query "乔思伯 N6 机箱" --limit 3
 *
 * Extraction used to be exercisable only against a live marketplace, which is how
 * a price/sales concatenation bug survived unnoticed. Cards saved here are the
 * regression input for `tests/price-extract.test.ts`: whatever the site actually
 * served is what the parser has to handle.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { browser } from "./adapters/index.mjs";
import { root, today } from "./store.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const channel = arg("channel", "taobao");
const query = arg("query", "乔思伯 N6 机箱");
const limit = Number(arg("limit", "3"));
const outDir = path.join(root, "tests/fixtures/price-cards");

const result = await browser.captureCardHtml({ channel, query, limit });
if (result.status !== "ok") {
  console.error(`抓取失败（${result.status}）：${result.reason ?? ""}`);
  console.error(`搜索链接：${result.searchUrl ?? "-"}`);
  if (result.status === "needsLogin") console.error("先跑 npm run price:login 完成登录/验证。");
  await browser.closeBrowser();
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `${channel}-${today()}.html`);
const html = [
  `<!-- channel: ${channel} -->`,
  `<!-- query: ${query} -->`,
  `<!-- capturedAt: ${new Date().toISOString()} -->`,
  `<!-- searchUrl: ${result.searchUrl} -->`,
  ...result.cards.map((card, i) => `<!-- card ${i + 1} -->\n${card}`),
].join("\n");
await writeFile(file, `${html}\n`, "utf8");
console.log(`存了 ${result.cards.length} 张卡片 → ${path.relative(root, file)}`);
await browser.closeBrowser();
