/** JD union goods search (jd.union.open.goods.query). */

import { loadEnv } from "../env.mjs";
import { md5ConcatSign, postForm, topTimestamp } from "./sign.mjs";

const GATEWAY = "https://api.jd.com/routerjson";

export const channel = "jd";
export const platform = "jd";

export async function availability() {
  const env = await loadEnv();
  if (!env.JD_APP_KEY || !env.JD_APP_SECRET) {
    return { available: false, reason: "缺少 JD_APP_KEY / JD_APP_SECRET" };
  }
  return { available: true };
}

/** Union responses nest a JSON string under result; unwrap defensively. */
export function normalizeJdResponse(json, limit = 5) {
  const wrapper =
    json?.jd_union_open_goods_query_response ?? json?.jd_union_open_goods_jingfen_query_response;
  const raw = wrapper?.result;
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  const list = result?.data ?? [];
  return list.slice(0, limit).map((item) => {
    const price = item?.priceInfo?.lowestCouponPrice ?? item?.priceInfo?.price ?? null;
    const skuId = item?.skuId;
    return {
      title: item?.skuName ?? item?.materialName ?? "",
      priceCny: typeof price === "number" ? price : null,
      url: skuId ? `https://item.jd.com/${skuId}.html` : (item?.materialUrl ?? ""),
    };
  });
}

export async function collect({ query, limit = 5 }) {
  const env = await loadEnv();
  const params = {
    method: "jd.union.open.goods.query",
    app_key: env.JD_APP_KEY,
    format: "json",
    v: "1.0",
    sign_method: "md5",
    timestamp: topTimestamp(),
    param_json: JSON.stringify({ goodsReqDTO: { keyword: query, pageIndex: 1, pageSize: limit } }),
    ...(env.JD_ACCESS_TOKEN ? { access_token: env.JD_ACCESS_TOKEN } : {}),
  };
  params.sign = md5ConcatSign(params, env.JD_APP_SECRET);

  const json = await postForm(GATEWAY, params);
  if (json?.error_response) {
    return { status: "error", reason: json.error_response.zh_desc ?? json.error_response.msg };
  }
  return { status: "ok", candidates: normalizeJdResponse(json, limit) };
}
