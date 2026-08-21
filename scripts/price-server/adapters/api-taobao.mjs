/** Taobao union material search (taobao.tbk.dg.material.optional.upgrade). */

import { loadEnv } from "../env.mjs";
import { md5ConcatSign, postForm, topTimestamp } from "./sign.mjs";

const GATEWAY = "https://eco.taobao.com/router/rest";

export const channel = "taobao";
export const platform = "taobao";

export async function availability() {
  const env = await loadEnv();
  if (!env.TAOBAO_APP_KEY || !env.TAOBAO_APP_SECRET) {
    return { available: false, reason: "缺少 TAOBAO_APP_KEY / TAOBAO_APP_SECRET" };
  }
  if (!env.TAOBAO_ADZONE_ID) {
    return { available: false, reason: "缺少 TAOBAO_ADZONE_ID（联盟推广位）" };
  }
  return { available: true };
}

export function normalizeTaobaoResponse(json, limit = 5) {
  const list =
    json?.tbk_dg_material_optional_upgrade_response?.result_list?.map_data ??
    json?.tbk_dg_material_optional_response?.result_list?.map_data ??
    [];
  return list.slice(0, limit).map((item) => {
    const price = Number(item?.zk_final_price ?? item?.reserve_price ?? NaN);
    const id = item?.item_id ?? item?.num_iid;
    return {
      title: item?.title ?? "",
      priceCny: Number.isFinite(price) ? price : null,
      url: id ? `https://item.taobao.com/item.htm?id=${id}` : (item?.url ?? ""),
    };
  });
}

export async function collect({ query, limit = 5 }) {
  const env = await loadEnv();
  const params = {
    method: "taobao.tbk.dg.material.optional.upgrade",
    app_key: env.TAOBAO_APP_KEY,
    format: "json",
    v: "2.0",
    sign_method: "md5",
    timestamp: topTimestamp(),
    adzone_id: env.TAOBAO_ADZONE_ID,
    q: query,
    page_no: 1,
    page_size: Math.max(20, limit),
    ...(env.TAOBAO_SESSION ? { session: env.TAOBAO_SESSION } : {}),
  };
  params.sign = md5ConcatSign(params, env.TAOBAO_APP_SECRET);

  const json = await postForm(GATEWAY, params);
  if (json?.error_response) {
    return { status: "error", reason: json.error_response.sub_msg ?? json.error_response.msg };
  }
  return { status: "ok", candidates: normalizeTaobaoResponse(json, limit) };
}
