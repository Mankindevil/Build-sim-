/** Keep the transaction-review HTTP boundary explicit and independently testable. */
export function transactionCatalogSearchRequest(body = {}) {
  const hasExpectedSkuId = Object.prototype.hasOwnProperty.call(body, "expectedSkuId");
  if (hasExpectedSkuId && (typeof body.expectedSkuId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.expectedSkuId))) {
    throw new Error("expectedSkuId must be a valid catalog SKU id");
  }
  return {
    query: body.query,
    ...(body.brand ? { brand: body.brand } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.mpn ? { mpn: body.mpn } : {}),
    ...(body.officialUrl ? { officialUrl: body.officialUrl } : {}),
    ...(hasExpectedSkuId ? { expectedSkuId: body.expectedSkuId } : {}),
    category: body.category,
    ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
    ...(body.trigger === "user-confirmed-review" ? { trigger: body.trigger } : {}),
    officialOnly: true,
    limit: 8,
  };
}
