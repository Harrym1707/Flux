import { createHash } from "node:crypto";

/**
 * Workload-aware cache-TTL advisor for the Anthropic cache stamp.
 *
 * The stamp can carry a 5-minute or a 1-hour TTL. They cost differently: a 5m
 * cache WRITE bills 1.25x base input, a 1h write 2x. The right choice depends
 * on how far apart a conversation's turns actually arrive:
 *
 *   - Turns arriving inside 5 minutes: a 5m entry is still warm, so the next
 *     turn READS it at 0.1x. Paying the 2x 1h write premium would be waste.
 *   - Turns arriving MORE than 5 minutes apart: a 5m entry has already expired,
 *     so the next turn re-pays FULL input (worse than any write premium). Here
 *     the 1h tier pays for itself — it is still warm, so the turn reads at 0.1x.
 *
 * So the lever is not "5m vs 1h" as a static flag; it is a function of the
 * conversation's realized inter-arrival gaps. This advisor watches those gaps
 * per conversation and recommends the TTL.
 *
 * The threshold is calibrated from real serving traces (docs/rnd/knowledge/
 * 2026-10-27-dataset-findings.md): Mooncake tool-agent reuse gaps have p90=243s
 * (a 5m TTL catches 92.6% of reuse — stay 5m), while conversational reuse gaps
 * have p90=519s with a tail to ~50min (a 5m TTL catches only 78.5% — the 1h tier
 * recovers the ~21.5% tail). The rule: recommend 1h once a conversation's
 * realized gap p90 exceeds 300s; otherwise 5m. WildChat corroborates the
 * interactive case (27.6% of continuations evict at 300s, 14.2% at 600s).
 *
 * Until a conversation has shown enough gaps to be trusted it defaults to 5m —
 * the cheaper write — so a brand-new conversation is never speculatively put on
 * the pricier tier. Time is injectable for deterministic tests; at runtime it
 * uses the wall clock.
 */

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null) ?? "null").digest("hex").slice(0, 32);

export type CacheTtlRecommendation = {
  ttl: "5m" | "1h";
  /** Why this TTL was chosen, for the stamp's change record. */
  reason: string;
};

export type CacheTtlAdvisorOptions = {
  /** LRU bound on tracked conversations. Default 1000. */
  maxConversations?: number;
  /** Gaps needed before the advisor will move off the 5m default. Default 3. */
  minObservations?: number;
  /** Recommend 1h once the realized gap p90 exceeds this many seconds. Default 300 (5m). */
  upgradeGapP90Seconds?: number;
  /** Most recent gaps retained per conversation for the p90. Default 20. */
  windowGaps?: number;
};

type ConversationArrival = { lastSeenSeconds: number; gaps: number[] };

/** p90 of a numeric array (nearest-rank, clamped). Empty -> 0. */
function p90(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export class CacheTtlAdvisor {
  /** Insertion-ordered; re-inserted on touch, so the first key is the LRU. */
  private readonly conversations = new Map<string, ConversationArrival>();
  private readonly maxConversations: number;
  private readonly minObservations: number;
  private readonly upgradeGapP90Seconds: number;
  private readonly windowGaps: number;

  constructor(options: CacheTtlAdvisorOptions = {}) {
    this.maxConversations = options.maxConversations ?? 1000;
    this.minObservations = options.minObservations ?? 3;
    this.upgradeGapP90Seconds = options.upgradeGapP90Seconds ?? 300;
    this.windowGaps = options.windowGaps ?? 20;
    for (const [name, value] of Object.entries({
      maxConversations: this.maxConversations,
      minObservations: this.minObservations,
      windowGaps: this.windowGaps,
    })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    }
    if (!(this.upgradeGapP90Seconds > 0)) throw new Error("upgradeGapP90Seconds must be positive.");
  }

  /**
   * Record this request's arrival and recommend a TTL for its conversation.
   * Call once per request. `nowSeconds` is injectable for tests; at runtime it
   * defaults to the wall clock.
   */
  recommend(request: unknown, nowSeconds: number = Date.now() / 1000): CacheTtlRecommendation {
    // A request with no conversation anchor (no messages) can't be tracked;
    // default to the cheaper 5m write.
    if (!isPlainObject(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
      return { ttl: "5m", reason: "no conversation to track arrival gaps; defaulting to the cheaper 5m write" };
    }
    const key = digest([request.model ?? null, request.messages[0]]);
    const prior = this.conversations.get(key);
    if (prior !== undefined) this.conversations.delete(key);

    const gaps = prior ? [...prior.gaps] : [];
    if (prior !== undefined) {
      const gap = nowSeconds - prior.lastSeenSeconds;
      // Guard against clock skew / out-of-order observations: ignore negatives.
      if (gap >= 0) {
        gaps.push(gap);
        while (gaps.length > this.windowGaps) gaps.shift();
      }
    }
    this.conversations.set(key, { lastSeenSeconds: nowSeconds, gaps });
    this.evict();

    if (gaps.length < this.minObservations) {
      return {
        ttl: "5m",
        reason: `only ${gaps.length} arrival gap(s) observed (need ${this.minObservations}); defaulting to the cheaper 5m write until the cadence is known`,
      };
    }
    const gapP90 = p90(gaps);
    if (gapP90 > this.upgradeGapP90Seconds) {
      return {
        ttl: "1h",
        reason: `arrival-gap p90 is ${Math.round(gapP90)}s (> ${this.upgradeGapP90Seconds}s): turns regularly arrive after a 5m entry would expire, so the 1h tier reads instead of re-paying full input`,
      };
    }
    return {
      ttl: "5m",
      reason: `arrival-gap p90 is ${Math.round(gapP90)}s (<= ${this.upgradeGapP90Seconds}s): turns arrive while a 5m entry is still warm, so 5m reads at 0.1x without paying the 2x 1h write premium`,
    };
  }

  private evict(): void {
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      if (oldest === undefined) return;
      this.conversations.delete(oldest);
    }
  }
}
