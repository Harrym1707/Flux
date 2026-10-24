import { type TokenPrice } from "./cost.js";
/**
 * Token reduction: spend fewer tokens on the SAME model, rather than moving work
 * to a weaker one. Model substitution trades quality for cost and needs a quality
 * gate to be safe. Most of the levers here do not: removing a duplicated context
 * block, or letting a provider's prefix cache serve a prompt you already paid
 * for, changes the bill and not the answer.
 *
 * The economics that make this the primary lever rather than a secondary one,
 * using rates captured in model-prices.ts:
 *   - Output tokens cost 5x input (Claude Sonnet 5.5) to 8x (gpt-5), so trimming
 *     an over-long answer is worth several times trimming the prompt.
 *   - Cached input costs 1/20th of fresh input (Sonnet 5.5: $2.00 -> $0.10), so a
 *     stable prefix served from cache is close to free.
 *
 * Token counting here is an ESTIMATE used to decide what to cut and to project a
 * saving. It is never the basis of a realised-saving claim: those come from the
 * provider's own reported usage, priced through the catalogue. A deployment
 * should pass the tokenizer matching its model via `countTokens`, because a
 * tokenizer pinned inside FLUX would drift from the provider's own counting.
 */
export type TokenCounter = (text: string) => number;
/**
 * Tokenizer-free estimate. Byte-pair encoders average roughly 4 characters per
 * token on English prose and nearer 3 on code, punctuation and JSON, so this
 * counts word-like runs and separators separately instead of dividing the whole
 * string by one constant. Expect roughly +/-15% against a real tokenizer; good
 * enough to rank candidate reductions, not good enough to bill on.
 */
export declare const approximateTokenCount: TokenCounter;
export type ReductionRisk = "lossless" | "low" | "moderate";
export type ReductionOutcome = {
    reducer: string;
    version: string;
    risk: ReductionRisk;
    text: string;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    /** What the reducer removed, for review before anything is enabled. */
    notes: string[];
};
export type Reducer = {
    id: string;
    version: string;
    risk: ReductionRisk;
    reduce: (text: string) => {
        text: string;
        notes: string[];
    };
};
/**
 * Removes exact duplicate blocks. Retrieval pipelines routinely send the same
 * passage two or three times (overlapping chunks, a document that matched several
 * queries, a system prompt echoed into the first user turn). Dropping later exact
 * copies is lossless: the model already has the text.
 *
 * Only blocks at or above `minimumBlockTokens` are considered, so ordinary
 * repeated phrasing is left alone.
 *
 * Duplicates are caught at two granularities: whole blocks separated by a
 * blank line (as before), and, inside a block that survives that check,
 * individual lines separated by a single newline. A RAG prompt that joins
 * several retrieved excerpts with `picks.join("\n")` never produces a
 * duplicated top-level block — the whole joined block is unique per request
 * because the question text differs — but an excerpt pulled twice is still an
 * exact duplicate line inside it, and dropping it is exactly as lossless as
 * dropping a duplicate paragraph.
 */
export declare function dedupeRepeatedBlocks(minimumBlockTokens?: number, countTokens?: TokenCounter): Reducer;
/**
 * Collapses redundant whitespace outside fenced and inline code, where layout is
 * meaningful. Individually small; free, and it compounds across every request.
 */
export declare function collapseWhitespace(): Reducer;
/** Run reducers in order, reporting what each one saved. */
export declare function applyReducers(text: string, reducers: Reducer[], countTokens?: TokenCounter): {
    text: string;
    outcomes: ReductionOutcome[];
    tokensBefore: number;
    tokensAfter: number;
};
export type PrefixBreaker = {
    /** What kind of per-request value is sitting inside the would-be stable prefix. */
    kind: "timestamp" | "date" | "uuid" | "long-number" | "unknown";
    example: string;
    occurrences: number;
};
export type CachingProjection = {
    status: "priced";
    baselineCostUsd: number;
    cachedCostUsd: number;
    savingUsd: number;
    savingPercent: number;
    recoverableSavingUsd: number;
} | {
    status: "unpriced";
    reason: string;
};
export type CachingAnalysis = {
    requests: number;
    meanInputTokens: number;
    /** Tokens identical across every sampled request, from the start of the prompt. */
    sharedPrefixTokens: number;
    /** Share of a request's input that the provider could serve from cache today. */
    cacheablePrefixShare: number;
    /**
     * Shared prefix that would exist if the per-request values listed in
     * `prefixBreakers` were moved out of the prefix. The gap between this and
     * `sharedPrefixTokens` is the cost of a timestamp in a system prompt.
     */
    recoverablePrefixTokens: number;
    prefixBreakers: PrefixBreaker[];
    projection: CachingProjection;
};
export declare function commonPrefixLength(left: string, right: string): number;
/**
 * Removes a repeated LEADING block from texts after the first, when that
 * block is an exact match for the start of the first text in the group.
 *
 * This is the shape a continuous-learning / continuous-memory agent
 * produces: the application glues the same memory or persistent-instruction
 * block to the front of every turn, with only a short turn-specific
 * remainder varying underneath it. `dedupeRepeatedBlocks` never catches
 * this, because it only ever sees one text at a time and the memory block
 * is not a standalone paragraph inside any single text - it is the shared
 * PREFIX of several texts that each continue differently.
 *
 * LOSSY, not lossless, unlike `dedupeRepeatedBlocks`: a same-text duplicate
 * sits right next to its twin, so the model reads both in the same breath.
 * The duplicate removed here can be many turns upstream of the current one,
 * which is a real behaviour change - a model that attends less to context
 * far back in a long history may act differently with the block restated
 * fresh every turn versus present once near the start. Callers must run
 * this behind a replay-gate pass on their own traffic before billing it;
 * it is never enabled by default.
 *
 * The cut point is always snapped to the last newline at or before the raw
 * common-prefix length (never cut THROUGH a line), unless the match is a
 * complete containment of one text inside the other, which needs no
 * snapping because there is no partially-matched line to protect. This
 * means a false positive - two texts that happen to start with the same
 * few words before diverging mid-line, e.g. two turns both opening "Turn "
 * - can only ever leave that differing line untouched, never truncate into it.
 */
export declare function dedupeRepeatedLeadingBlock(texts: readonly string[], minimumBlockTokens?: number, countTokens?: TokenCounter): {
    texts: string[];
    notes: string[];
};
/**
 * How much of a workload's prompt a provider's prefix cache could serve, and what
 * is stopping it.
 *
 * Providers cache on an exact prefix match, so a single value that changes per
 * request invalidates everything after it. A current-date line at the top of a
 * system prompt can therefore cost the entire prompt's cache discount, which is
 * the difference between paying full input rate and one twentieth of it. That
 * failure is invisible in a cost dashboard: spend simply stays high.
 *
 * `requests` should be a representative sample of real prompts for one workload.
 */
export declare function analysePromptCaching(requests: string[], options?: {
    price?: TokenPrice;
    countTokens?: TokenCounter;
    /** Minimum prefix a provider will cache at all; OpenAI's floor is 1024 tokens. */
    minimumCacheableTokens?: number;
}): CachingAnalysis;
export type OutputCapAdvice = {
    observations: number;
    /** Cap that would have truncated none of the observed responses. */
    maxObserved: number;
    recommendedCap: number;
    /** Share of observed responses the recommended cap would have truncated. */
    truncationRate: number;
    meanOutputTokens: number;
    /**
     * Saving only materialises on responses that would have run past the cap, so
     * this is deliberately conservative: it counts the tokens above the cap and
     * nothing else.
     */
    projectedTokensSaved: number;
    projectedSavingUsd?: number;
};
/**
 * Recommend `max_output_tokens` from observed response lengths.
 *
 * Output is the expensive half of the bill (5x input on Sonnet 5.5, 8x on gpt-5),
 * and an uncapped request lets a model ramble at that rate. A cap set at a high
 * quantile of what a workload actually produces removes the tail without touching
 * the responses that were already the right length.
 *
 * This caps length; it does not make answers shorter at equal quality. Any
 * response that would have exceeded the cap gets truncated, so `truncationRate`
 * is the number to judge it on, and a cap belongs behind a replay check before
 * rollout.
 */
export declare function recommendOutputCap(observedOutputTokens: number[], options?: {
    quantile?: number;
    price?: TokenPrice;
    headroom?: number;
}): OutputCapAdvice;
export type ReductionSaving = {
    inputTokensSaved: number;
    outputTokensSaved: number;
    savingUsd?: number;
};
/** Price a projected reduction. Returns tokens only when no price is supplied. */
export declare function priceReduction(inputTokensSaved: number, outputTokensSaved: number, price?: TokenPrice): ReductionSaving;
