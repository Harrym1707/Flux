export type TokenPrice = {
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWriteInputPerMillion?: number;
  outputPerMillion: number;
};

export function estimateTokenCost(
  inputTokens: number,
  outputTokens: number,
  price: TokenPrice,
  cacheUsage: { cachedInputTokens?: number; cacheWriteInputTokens?: number } = {},
): number {
  const cached = cacheUsage.cachedInputTokens ?? 0;
  const cacheWrite = cacheUsage.cacheWriteInputTokens ?? 0;
  if (!Number.isFinite(cached) || cached < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0 ||
      cached + cacheWrite > inputTokens) {
    throw new Error("Cached input token counts must be non-negative and no greater than total input tokens.");
  }
  if ((cached > 0 && price.cachedInputPerMillion === undefined) ||
      (cacheWrite > 0 && price.cacheWriteInputPerMillion === undefined)) {
    throw new Error("Cached input pricing is required to calculate actual cost for cached tokens.");
  }
  const uncached = inputTokens - cached - cacheWrite;
  return (
    (uncached / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * (price.cachedInputPerMillion ?? 0) +
    (cacheWrite / 1_000_000) * (price.cacheWriteInputPerMillion ?? 0) +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}
