import { estimateTokenCost, type TokenPrice } from "./cost.js";
import { anthropicCacheableMinimumTokens } from "./model-prices.js";
import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

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
export const OPENAI_CACHE: CachePolicy = {
  name: "openai-automatic",
  minimumCacheableTokens: 1_024,
  incrementTokens: 128,
  // 5-10 minutes of inactivity is documented; the shorter end is the honest one.
  ttlSeconds: 300,
  writeMultiplier: 1,
  readMultiplier: 0.1,
};

/** Explicit breakpoints, 5-minute TTL, writes at 1.25x base. */
export const ANTHROPIC_CACHE_5M: CachePolicy = {
  name: "anthropic-ephemeral-5m",
  minimumCacheableTokens: 1_024,
  incrementTokens: 1,
  ttlSeconds: 300,
  writeMultiplier: 1.25,
  readMultiplier: 0.1,
};

/**
 * Anthropic with NO cache_control placed: the cache is opt-in, so nothing
 * caches and every token bills at the full input rate. This is the measured
 * reality of unstamped Claude traffic (the first live export recorded a
 * five-turn agent with zero cache reads and zero writes), and therefore the
 * honest baseline for valuing a FLUX-placed stamp.
 */
export const ANTHROPIC_NO_CACHE: CachePolicy = {
  name: "anthropic-uncached",
  minimumCacheableTokens: Number.MAX_SAFE_INTEGER,
  incrementTokens: 1,
  ttlSeconds: 0,
  writeMultiplier: 1,
  readMultiplier: 1,
};

/** The hour-long TTL, which doubles the write charge. */
export const ANTHROPIC_CACHE_1H: CachePolicy = {
  name: "anthropic-ephemeral-1h",
  minimumCacheableTokens: 1_024,
  incrementTokens: 1,
  ttlSeconds: 3_600,
  writeMultiplier: 2,
  readMultiplier: 0.1,
};

/**
 * `ANTHROPIC_CACHE_5M` / `ANTHROPIC_CACHE_1H` hardcode the 1,024-token
 * minimum, which is only correct for non-Haiku models; Haiku-class models
 * need 2,048 (the same split `anthropicCacheableMinimumTokens` already
 * enforces on the production stamping path). Every published band runs a
 * Sonnet-class model, so the flat constants above are exactly right for
 * them and are left alone; these factories are for simulating a named
 * model's actual minimum, Haiku included.
 */
export function anthropicCache5m(modelId: string): CachePolicy {
  return { ...ANTHROPIC_CACHE_5M, minimumCacheableTokens: anthropicCacheableMinimumTokens(modelId) };
}

export function anthropicCache1h(modelId: string): CachePolicy {
  return { ...ANTHROPIC_CACHE_1H, minimumCacheableTokens: anthropicCacheableMinimumTokens(modelId) };
}

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

type Entry = { prompt: string; lastUsedAt: number };

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Run a request stream against a cache policy and price it.
 *
 * Deliberately pessimistic where the published behaviour is a range: the
 * shorter documented TTL is used, and a prefix must clear the minimum AFTER
 * being rounded down to the policy's increment.
 */
export function simulateCache(
  requests: SimulatedRequest[],
  policy: CachePolicy,
  price: TokenPrice,
  options: { countTokens?: TokenCounter } = {},
): SimulationResult {
  if (requests.length === 0) throw new Error("A cache simulation needs at least one request.");
  if (policy.minimumCacheableTokens < 1 || policy.incrementTokens < 1) {
    throw new Error("Cache policy minimums and increments must be at least 1 token.");
  }
  const countTokens = options.countTokens ?? approximateTokenCount;

  // The policy's read and write rates are derived from the base input rate, so
  // a catalogue that already carries cached rates stays consistent with it.
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion * policy.readMultiplier;
  const writeRate = price.cacheWriteInputPerMillion ?? price.inputPerMillion * policy.writeMultiplier;

  const entries: Entry[] = [];
  const calls: SimulatedCall[] = [];
  const missReasons: Record<string, number> = {};
  let expiries = 0;

  const ordered = [...requests].sort((left, right) => left.atSeconds - right.atSeconds);

  for (const request of ordered) {
    // Drop anything not used within the TTL before looking for a match.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (request.atSeconds - entries[index]!.lastUsedAt > policy.ttlSeconds) {
        entries.splice(index, 1);
        expiries += 1;
      }
    }

    const totalInputTokens = countTokens(request.prompt);
    let cachedInputTokens = 0;
    let missReason: SimulatedCall["missReason"] | undefined;

    if (entries.length === 0) {
      missReason = calls.length === 0 ? "first-request" : "expired";
    } else {
      // Longest exact prefix across live entries, as the providers describe.
      let bestChars = 0;
      let bestEntry: Entry | undefined;
      for (const entry of entries) {
        const shared = commonPrefixLength(entry.prompt, request.prompt);
        if (shared > bestChars) {
          bestChars = shared;
          bestEntry = entry;
        }
      }
      const sharedTokens = bestChars === 0 ? 0 : countTokens(request.prompt.slice(0, bestChars));
      // Rounded down to the policy's granularity before the minimum is applied.
      const granted = Math.floor(sharedTokens / policy.incrementTokens) * policy.incrementTokens;
      if (granted >= policy.minimumCacheableTokens) {
        cachedInputTokens = Math.min(granted, totalInputTokens);
        bestEntry!.lastUsedAt = request.atSeconds;
      } else {
        missReason = granted === 0 ? "no-matching-prefix" : "below-minimum";
      }
    }

    // A prefix long enough to cache is written when it was not already served.
    const writtenInputTokens = cachedInputTokens === 0 &&
      Math.floor(totalInputTokens / policy.incrementTokens) * policy.incrementTokens >=
        policy.minimumCacheableTokens
      ? Math.floor(totalInputTokens / policy.incrementTokens) * policy.incrementTokens
      : 0;

    const freshInputTokens = totalInputTokens - cachedInputTokens - writtenInputTokens;
    const costUsd =
      (freshInputTokens / 1_000_000) * price.inputPerMillion +
      (cachedInputTokens / 1_000_000) * cachedRate +
      (writtenInputTokens / 1_000_000) * writeRate +
      (request.outputTokens / 1_000_000) * price.outputPerMillion;

    if (missReason) missReasons[missReason] = (missReasons[missReason] ?? 0) + 1;
    calls.push({
      atSeconds: request.atSeconds,
      totalInputTokens,
      cachedInputTokens,
      writtenInputTokens,
      freshInputTokens,
      outputTokens: request.outputTokens,
      costUsd,
      ...(missReason === undefined ? {} : { missReason }),
    });

    entries.push({ prompt: request.prompt, lastUsedAt: request.atSeconds });
    // Providers keep a bounded cache; holding every prompt forever would
    // overstate hit rates on long runs.
    if (entries.length > 64) entries.shift();
  }

  const totalCostUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
  const totalInputTokens = calls.reduce((sum, call) => sum + call.totalInputTokens, 0);
  const cachedInputTokens = calls.reduce((sum, call) => sum + call.cachedInputTokens, 0);
  const uncachedCostUsd = calls.reduce((sum, call) =>
    sum + estimateTokenCost(call.totalInputTokens, call.outputTokens, price), 0);

  return {
    policy: policy.name,
    calls,
    totalCostUsd,
    uncachedCostUsd,
    savingUsd: uncachedCostUsd - totalCostUsd,
    savingPercent: uncachedCostUsd === 0 ? 0 : ((uncachedCostUsd - totalCostUsd) / uncachedCostUsd) * 100,
    totalInputTokens,
    cachedInputTokens,
    hitRate: totalInputTokens === 0 ? 0 : cachedInputTokens / totalInputTokens,
    expiries,
    missReasons,
  };
}
