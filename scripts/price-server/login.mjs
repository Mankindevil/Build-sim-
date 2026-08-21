#!/usr/bin/env node
/**
 * Open each marketplace in the persistent profile so you can sign in once.
 *
 *   npm run price:login
 *   npm run price:login -- jd taobao
 *
 * Leave the browser open until you are logged in, then press Ctrl+C.
 */

import { availability, openForLogin, closeBrowser } from "./adapters/browser.mjs";

const channels = process.argv.slice(2).filter(Boolean);

const av = await availability();
if (!av.available) {
  console.error(av.reason);
  process.exit(1);
}

await openForLogin(channels.length ? channels : ["jd", "taobao", "pdd"]);
console.log("浏览器已打开：逐个登录后按 Ctrl+C 退出，登录态会保存在 .cache/price-browser-profile");

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});
