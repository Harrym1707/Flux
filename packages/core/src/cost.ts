export type TokenPrice = {
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  /** Cache writes at the default (5m) TTL; Anthropic bills 1.25x base input. */
  cacheWriteInputPerMillion?: number;
  /** Cache writes at the 1h TTL; Anthropic bills 2x base input. */
  cacheWrite1hInputPerMillion?: number;
  outputPerMillion: number;
};

export function estimateTokenCost(
  inputTokens: number,
  outputTokens: number,
  price: TokenPrice,
  cacheUsage: {
    cachedInputTokens?: number;
    /** TOTAL cache writes, inclusive of any 1h share below. */
    cacheWriteInputTokens?: number;
    /** The share of the writes above that carried the 1h TTL. */
    cacheWrite1hInputTokens?: number;
  } = {},
): number {
  const cached = cacheUsage.cachedInputTokens ?? 0;
  const cacheWrite = cacheUsage.cacheWriteInputTokens ?? 0;
  const cacheWrite1h = cacheUsage.cacheWrite1hInputTokens ?? 0;
  if (!Number.isFinite(cached) || cached < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0 ||
      !Number.isFinite(cacheWrite1h) || cacheWrite1h < 0 ||
      cached + cacheWrite > inputTokens || cacheWrite1h > cacheWrite) {
    throw new Error("Cached input token counts must be non-negative and no greater than total input tokens.");
  }
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  if ((cached > 0 && price.cachedInputPerMillion === undefined) ||
      (cacheWrite5m > 0 && price.cacheWriteInputPerMillion === undefined) ||
      (cacheWrite1h > 0 && price.cacheWrite1hInputPerMillion === undefined)) {
    throw new Error("Cached input pricing is required to calculate actual cost for cached tokens.");
  }
  const uncached = inputTokens - cached - cacheWrite;
  return (
    (uncached / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * (price.cachedInputPerMillion ?? 0) +
    (cacheWrite5m / 1_000_000) * (price.cacheWriteInputPerMillion ?? 0) +
    (cacheWrite1h / 1_000_000) * (price.cacheWrite1hInputPerMillion ?? 0) +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}
