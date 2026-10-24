import { type TokenPrice } from "./cost.js";
import { type TokenCounter } from "./token-reduction.js";
/**
 * Provider prompt-cache simulator.
 *
 * Prefix caching is the largest lever FLUX has, and on a fixture it was worth 29
 * of 32 points. A claim that large cannot rest on a stub that simply says "the
 * prefix was cached". This models the published rules, including the ones that
 * make caching fail:
 *
 *   - a minimum cacheable prefix (1,024 tokens on both providers; 2,048 on
 *     Claude Haiku), below which nothing caches at all
 *   - longest EXACT prefix matching, so one changed character early in the
 *     prompt discards everything after it
 *   - hit granularity (OpenAI grants hits in 128-token increments)
 *   - a time to live measured from last use, so traffic spread thinly over time
 *     never accumulates a hit rate
 *   - a write premium where the provider charges one (Anthropic bills a cache
 *     write at 1.25x base for the 5-minute TTL, 2x for the hour)
 *
 * The TTL is the honest part. A simulation that assumes every repeat hits will
 * overstate caching badly for low-traffic workloads: with a 5-minute TTL and
 * requests ten minutes apart, the cache never pays for itself and the write
 * premium makes it worse than doing nothing. That outcome is reachable here.
 *
 * Sources: OpenAI's prompt-caching guide (automatic above 1,024 tokens, 128-token
 * increments, longest exact prefix, 5-10 minutes of inactivity up to an hour) and
 * Anthropic's (explicit breakpoints, 5-minute default TTL or 1 hour, writes at
 * 1.25x or 2x base, reads at 0.1x).
 */
export type CachePolicy = {
    name: string;
    /** Nothing below this caches at all. */
    minimumCacheableTokens: number;
    /** Hits are granted in whole multiples of this many tokens. */
    incrementTokens: number;
    /** Entry is dropped after this long without being used. */
    ttlSeconds: number;
    /** Charge for writing a prefix, as a multiple of the base input rate. */
    writeMultiplier: number;
    /** Charge for reading a cached prefix, as a multiple of the base input rate. */
    readMultiplier: number;
};
/** Automatic, no write premium, hits in 128-token steps. */
export declare const OPENAI_CACHE: CachePolicy;
/** Explicit breakpoints, 5-minute TTL, writes at 1.25x base. */
export declare const ANTHROPIC_CACHE_5M: CachePolicy;
/**
 * Anthropic with NO cache_control placed: the cache is opt-in, so nothing
 * caches and every token bills at the full input rate. This is the measured
 * reality of unstamped Claude traffic (the first live export recorded a
 * five-turn agent with zero cache reads and zero writes), and therefore the
 * honest baseline for valuing a FLUX-placed stamp.
 */
export declare const ANTHROPIC_NO_CACHE: CachePolicy;
/** The hour-long TTL, which doubles the write charge. */
export declare const ANTHROPIC_CACHE_1H: CachePolicy;
export type SimulatedRequest = {
    /** Seconds since the run began. Drives TTL expiry. */
    atSeconds: number;
    /** The exact prompt text the provider would see, in order. */
    prompt: string;
    /** Output tokens the model produced, for costing. */
    outputTokens: number;
};
export type SimulatedCall = {
    atSeconds: number;
    totalInputTokens: number;
    cachedInputTokens: number;
    writtenInputTokens: number;
    freshInputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** Why nothing was cached, when nothing was. */
    missReason?: "below-minimum" | "no-matching-prefix" | "expired" | "first-request";
};
export type SimulationResult = {
    policy: string;
    calls: SimulatedCall[];
    totalCostUsd: number;
    /** What the same traffic would cost with caching unavailable. */
    uncachedCostUsd: number;
    savingUsd: number;
    savingPercent: number;
    totalInputTokens: number;
    cachedInputTokens: number;
    /** Share of input tokens served from cache. */
    hitRate: number;
    expiries: number;
    missReasons: Record<string, number>;
};
/**
 * Run a request stream against a cache policy and price it.
 *
 * Deliberately pessimistic where the published behaviour is a range: the
 * shorter documented TTL is used, and a prefix must clear the minimum AFTER
 * being rounded down to the policy's increment.
 */
export declare function simulateCache(requests: SimulatedRequest[], policy: CachePolicy, price: TokenPrice, options?: {
    countTokens?: TokenCounter;
}): SimulationResult;
