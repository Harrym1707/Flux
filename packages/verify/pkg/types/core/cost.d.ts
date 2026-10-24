export type TokenPrice = {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    /** Cache writes at the default (5m) TTL; Anthropic bills 1.25x base input. */
    cacheWriteInputPerMillion?: number;
    /** Cache writes at the 1h TTL; Anthropic bills 2x base input. */
    cacheWrite1hInputPerMillion?: number;
    outputPerMillion: number;
};
export declare function estimateTokenCost(inputTokens: number, outputTokens: number, price: TokenPrice, cacheUsage?: {
    cachedInputTokens?: number;
    /** TOTAL cache writes, inclusive of any 1h share below. */
    cacheWriteInputTokens?: number;
    /** The share of the writes above that carried the 1h TTL. */
    cacheWrite1hInputTokens?: number;
}): number;
