import { type TokenPrice } from "./cost.js";
import type { BillableEvent } from "./savings-ledger.js";
import { type TokenCounter } from "./token-reduction.js";
/**
 * Provider prompt-cache simulator.
 *
 * Prefix caching is the largest lever MESH has, and on a fixture it was worth 29
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
 * honest baseline for valuing a MESH-placed stamp.
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
/**
 * Context compaction, priced.
 *
 * An agent loop re-sends its whole transcript every turn, so the API bill grows
 * with the square of the session. Harnesses fight that by COMPACTING: at some
 * turn they throw the transcript away and replace it with a short summary, so
 * the prefix shrinks and growth restarts from a smaller base.
 *
 * The move is not free, and the cost that hides from a naive token count is the
 * one caching imposes. Prefix caching already defeats most of the quadratic tax
 * on its own: once a transcript is cached, every later turn READS it at 0.1x and
 * writes only the new tail. Compaction discards that cached prefix — the summary
 * does not match the bytes it replaced, so the longest-exact-prefix match
 * collapses to the stable system block, and everything after it is re-written at
 * the full (or write-premium) rate. That rewrite, plus the one-off summarisation
 * call that reads the transcript to produce the summary, is the price of
 * compaction. It only pays back if the session runs long enough afterwards for
 * the smaller prefix to save more than the rewrite cost.
 *
 * The counter-intuitive, and therefore worth-proving, result this models: under
 * a WARM cache and fast turns, compaction can be a net LOSS, because the thing
 * it shrinks was already being read at a tenth of its price. It wins when the
 * cache is cold — slow human-in-the-loop turns that expire the TTL, or traffic
 * with no cache_control placed at all — where the transcript really is re-sent
 * at full price every turn. Both regimes are reachable here by choice of policy
 * and turn spacing.
 */
export type AgentSessionSpec = {
    /** The stable system + tool block that leads every turn. Cached, never rewritten. */
    systemPromptTokens: number;
    /** How many model calls the session makes. */
    turns: number;
    /** New transcript appended before each turn (user message + tool results). */
    userTurnTokens: number;
    /** Model output each turn, which becomes input on the next turn. */
    assistantTurnTokens: number;
    /** Seconds between turns. Long gaps expire the cache TTL and change the verdict. */
    secondsPerTurn: number;
};
export type CompactionSpec = {
    /** The turn (1-based) whose prompt is the first to carry the summary. */
    atTurn: number;
    /** Size of the summary that replaces the discarded transcript. */
    summaryTokens: number;
    /**
     * Charge the one-off call that reads the transcript to write the summary.
     * Defaults to true; set false to isolate the cache-invalidation cost alone.
     */
    chargeSummarizationCall?: boolean;
};
export type CompactionEconomics = {
    compactionTurn: number;
    summaryTokens: number;
    /** The session run straight through, no compaction. */
    baseline: SimulationResult;
    /** The same session with the transcript compacted at `compactionTurn`. */
    withCompaction: SimulationResult;
    /**
     * The cache penalty of the compaction event, isolated from its size effect:
     * the compaction turn's actual cost minus what that same prompt would have
     * cost if every token had been served from cache. Always >= 0 — it is the
     * price of the prefix collapsing to the system block on that one turn.
     */
    cacheInvalidationCostUsd: number;
    /** Cost of the one-off call that reads the transcript to write the summary (0 if not charged). */
    summarizationCostUsd: number;
    /** baseline total minus compacted total. Positive means compaction paid off. */
    netSavingUsd: number;
    savingPercent: number;
    worthwhile: boolean;
    /**
     * Turns after the compaction point before compaction turns net-positive, or
     * null if it never does within the session's length.
     */
    breakEvenTurns: number | null;
};
/**
 * Build a turn-by-turn agent session as a request stream, with the transcript
 * growing by one segment each turn. With a `compaction`, turns from `atTurn`
 * on lead with a summary in place of the discarded transcript, and (unless
 * disabled) a summarisation call is inserted just before that turn.
 */
export declare function buildAgentSession(spec: AgentSessionSpec, compaction?: CompactionSpec, options?: {
    countTokens?: TokenCounter;
}): SimulatedRequest[];
/**
 * Price a compaction decision: run the session with and without it under the
 * same cache policy, and decompose the difference into the cache-invalidation
 * cost, the summarisation cost, the net saving and the break-even horizon.
 */
export declare function estimateCompactionEconomics(spec: AgentSessionSpec, compaction: CompactionSpec, policy: CachePolicy, price: TokenPrice, options?: {
    countTokens?: TokenCounter;
}): CompactionEconomics;
/**
 * Compaction economics computed from the ledger instead of a synthetic session.
 *
 * The ledger keeps no prompt text — only provider-verbatim token counts — so
 * the string prefix model above cannot run on it. It does not need to: the
 * ledger already records what the cache DID (cachedInputTokens per turn), so the
 * realized per-turn input rate is known, and compaction can be priced as the
 * removal of context from later turns valued at that realized rate.
 *
 * What compaction removes is a fixed block. Replacing the history accumulated by
 * the compaction point with a shorter summary drops the same
 * `context_before - preserved_prefix - summary` tokens from EVERY later turn's
 * input. Those removed tokens are exactly the stable, repeated prefix — the part
 * the provider was most likely serving from cache — so on a turn where the
 * ledger shows cache reads they are valued at the cached rate, not the full
 * one. That is a deliberate under-claim on cache-heavy traffic (the ledger's own
 * convention): compaction is credited only with what the removed tokens actually
 * cost, which on a warm cache is a tenth of their face value. The one-off
 * summarisation call is charged at the FULL input rate, against compaction, so
 * the net never flatters the lever.
 */
/** One turn of a task, projected from a recorded ledger event to just what pricing needs. */
export type LedgerTurn = {
    taskId?: string;
    turnIndex: number;
    /** For ordering turns that share a turnIndex; optional. */
    timestampMs?: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
};
export type LedgerCompactionSpec = {
    /** The turn (1-based, within the task) that first carries the summary. */
    atTurn: number;
    /** Size of the summary that replaces the discarded history. */
    summaryTokens: number;
    /**
     * The always-present prefix (system + tools) compaction keeps verbatim.
     * Defaults to the smallest input seen in the task — a safe lower bound that,
     * if anything, under-states what is removed and so under-claims the saving.
     */
    preservedPrefixTokens?: number;
};
export type LedgerCompactionEstimate = {
    taskId?: string;
    turns: number;
    compactionTurn: number;
    summaryTokens: number;
    preservedPrefixTokens: number;
    /** Tokens dropped from every post-compaction turn's input. */
    removedTokensPerTurn: number;
    postCompactionTurns: number;
    /** Full task cost as recorded (sum of each turn priced at its realized usage). */
    recordedCostUsd: number;
    /** One-off cost of producing the summary, charged at the full input rate. */
    summarizationCostUsd: number;
    /** Realized value of the context compaction removes, summed over later turns. */
    grossSavingUsd: number;
    netSavingUsd: number;
    savingPercent: number;
    worthwhile: boolean;
    /** Turns after the compaction point before the one-off cost is repaid, or null. */
    breakEvenTurns: number | null;
};
/**
 * Project recorded ledger events into per-task turn streams: keep the succeeded
 * events that carry usage, group them by taskId, and order each group by turn.
 * Events with no taskId are each treated as their own single-turn task.
 */
export declare function ledgerTurnsByTask(events: readonly BillableEvent[]): Map<string, LedgerTurn[]>;
/**
 * Price a compaction decision from a single task's recorded turns. `price` is
 * the resolved catalogue rate for the task's model (look it up with
 * `priceUsage` / `lookupPrice` and pass `.price`).
 */
export declare function estimateCompactionFromLedger(turns: readonly LedgerTurn[], compaction: LedgerCompactionSpec, price: TokenPrice): LedgerCompactionEstimate;
