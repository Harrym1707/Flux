/**
 * The single shared provider-usage normaliser.
 *
 * Hoisted from the replay gate (packages/sdk-js/src/replay-gate.ts replayUsage)
 * so every FLUX component - the request-path SDK wrapper, the replay gate, and
 * the ledger - reads provider usage through ONE parser. The old arrangement had
 * three divergent parsers: the SDK wrapper's tokenUsage returned undefined on
 * both the Chat Completions shape (prompt_tokens) and the Anthropic shape
 * (cache reads/writes OUTSIDE input_tokens), which silently dropped usage - and
 * therefore billing evidence - on every non-Responses surface.
 *
 * The two provider conventions, both normalised to a TOTAL-INCLUSIVE figure:
 *
 *   OpenAI (Responses and Chat Completions) reports cached tokens INSIDE
 *   input_tokens/prompt_tokens. `prompt_tokens_details.cache_write_tokens` is
 *   informational: OpenAI publishes no cache-write rate, so writes are
 *   normalised to zero and never priced ($0, informational).
 *
 *   Anthropic reports cache reads and writes ALONGSIDE input_tokens:
 *   total input = input_tokens + cache_read_input_tokens + cache writes.
 *   Cache writes may carry a TTL split in `usage.cache_creation`
 *   ({ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}); when both the
 *   split and the flat cache_creation_input_tokens are present they must sum
 *   exactly, or the usage is INVALID rather than silently repaired - a billing
 *   record built on inconsistent provider usage is a dispute, not an estimate.
 *
 * Response-side execution-tier evidence is normalised here too: OpenAI reports
 * a top-level `service_tier` on the response; Anthropic reports
 * `usage.service_tier` ("standard" | "priority" | "batch"). Billing reads the
 * tier the provider ANSWERED with, never the one the request asked for.
 * "priority" maps to standard pricing (FLUX claims no saving on it) and
 * "batch" maps to the batch execution mode.
 */
export type NormalizedProviderUsage = {
    /** Total input billed, inclusive of cache reads and cache writes. */
    inputTokens: number;
    /** Input billed at the full rate: total minus cached minus written. */
    uncachedInputTokens: number;
    /** Input served from the provider's cache, billed at the cached rate. */
    cachedInputTokens: number;
    /** Total input written into the provider's cache (Anthropic bills a premium). */
    cacheWriteInputTokens: number;
    /**
     * TTL split of the cache writes, present ONLY when the provider reported it
     * (Anthropic usage.cache_creation). Absent means the split is unknown, which
     * downstream pricing must treat conservatively, never as "all 5m".
     */
    cacheWrite5mInputTokens?: number;
    cacheWrite1hInputTokens?: number;
    outputTokens: number;
};
export type ProviderUsageResult = 
/** Usage read and internally consistent. */
{
    status: "ok";
    usage: NormalizedProviderUsage;
}
/** Usage present but unreadable or inconsistent; the reason is auditable. */
 | {
    status: "invalid";
    reason: string;
}
/** The response carries no usage object at all. */
 | {
    status: "missing";
};
/** Normalise one provider response's usage, or say exactly why it cannot be. */
export declare function normalizeProviderUsage(response: unknown): ProviderUsageResult;
/** Convenience view of normalizeProviderUsage: the usage, or undefined. */
export declare function providerUsage(response: unknown): NormalizedProviderUsage | undefined;
export type ResponseExecutionMode = "standard" | "flex" | "batch";
/**
 * The service tier the provider ANSWERED with: OpenAI's top-level
 * response.service_tier, else Anthropic's usage.service_tier. Returns the
 * provider's own string untouched; map it with executionModeFromServiceTier.
 */
export declare function responseServiceTier(response: unknown): string | undefined;
/**
 * Map response-side tier evidence onto a billing execution mode. "flex" and
 * "batch" are the only modes with their own catalogue rates; Anthropic's
 * "priority" (and every unknown value) maps to STANDARD pricing, so FLUX never
 * claims a tier saving it cannot price.
 */
export declare function executionModeFromServiceTier(serviceTier: string | undefined): ResponseExecutionMode;
