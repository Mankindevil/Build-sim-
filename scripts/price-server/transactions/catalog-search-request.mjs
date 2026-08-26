/** Keep the transaction-review HTTP boundary explicit and independently testable. */
export function transactionCatalogSearchRequest(body = {}) {
  return {
    query: body.query,
    ...(body.brand ? { brand: body.brand } : {}),
    category: body.category,
    ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
    ...(body.trigger === "user-confirmed-review" ? { trigger: body.trigger } : {}),
    officialOnly: true,
    limit: 8,
  };
}
