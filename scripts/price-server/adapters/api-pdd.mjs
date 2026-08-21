/** Pinduoduo DDK goods search (pdd.ddk.goods.search). */

import { loadEnv } from "../env.mjs";
import { md5ConcatSign, postForm } from "./sign.mjs";

const GATEWAY = "https://gw-api.pinduoduo.com/api/router";

export const channel = "pdd";
export const platform = "pdd";

export async function availability() {
  const env = await loadEnv();
  if (!env.PDD_CLIENT_ID || !env.PDD_CLIENT_SECRET) {
    return { available: false, reason: "缺少 PDD_CLIENT_ID / PDD_CLIENT_SECRET" };
  }
  return { available: true };
}

/** PDD returns fen (1/100 CNY) for every price field. */
export function normalizePddResponse(json, limit = 5) {
  const list = json?.goods_search_response?.goods_list ?? [];
  return list.slice(0, limit).map((item) => {
    const fen = item?.min_group_price ?? item?.min_normal_price ?? null;
    const sign = item?.goods_sign;
    return {
      title: item?.goods_name ?? "",
      priceCny: typeof fen === "number" ? Number((fen / 100).toFixed(2)) : null,
      url: sign
        ? `https://mobile.yangkeduo.com/goods.html?goods_sign=${sign}`
        : (item?.goods_id ? `https://mobile.yangkeduo.com/goods.html?goods_id=${item.goods_id}` : ""),
    };
  });
}

export async function collect({ query, limit = 5 }) {
  const env = await loadEnv();
  const params = {
    type: "pdd.ddk.goods.search",
    client_id: env.PDD_CLIENT_ID,
    data_type: "JSON",
    timestamp: Math.floor(Date.now() / 1000),
    keyword: query,
    page: 1,
    page_size: Math.max(10, limit),
    ...(env.PDD_PID ? { pid: env.PDD_PID } : {}),
  };
  params.sign = md5ConcatSign(params, env.PDD_CLIENT_SECRET);

  const json = await postForm(GATEWAY, params);
  if (json?.error_response) {
    return { status: "error", reason: json.error_response.error_msg ?? "PDD error" };
  }
  return { status: "ok", candidates: normalizePddResponse(json, limit) };
}
