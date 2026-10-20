import { createHash } from "node:crypto";

/**
 * Cross-turn volatility guard for the Anthropic cache stamp.
 *
 * The second live export measured the failure this prevents: an agent whose
 * system prompt carried a per-turn clock was stamped every turn, so every
 * turn paid the cache-write premium and no turn ever read — a real loss,
 * honestly ledgered against FLUX, but better never made. Prompt caching is a
 * prefix match: content that changes between the turns of one conversation
 * can never be read back, so stamping it only buys write premiums.
 *
 * The guard watches conversations across requests (something the pure
 * per-request reducer cannot do) and answers one question before each stamp:
 * has this conversation's prefix actually been stable so far?
 *
 * - A conversation is identified by its model and FIRST message, which a
 *   multi-turn client re-sends verbatim every turn.
 * - The watched prefix is {tools, system}: if it changes between turns, the
 *   provider's cache misses from position zero and every breakpoint behind
 *   it is worthless.
 * - The message history must EXTEND turn over turn (prior messages a prefix
 *   of current messages). A client-side framework that rewrites history also
 *   invalidates the provider cache every turn.
 *
 * On observed churn the stamp is suppressed for that conversation. Suppression
 * is not permanent: after two consecutive stable observations (e.g. a one-off
 * history compaction followed by normal growth) stamping resumes, so a single
 * disturbance does not forfeit a long conversation's cache earnings. A prefix
 * that churns every turn — the per-turn clock — never produces two stable
 * observations and stays suppressed.
 *
 * The guard observes the RAW incoming request (the client's own bytes),
 * never FLUX's reduced copy, so FLUX's own deterministic levers cannot be
 * mistaken for client-side churn.
 */

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null) ?? "null").digest("hex").slice(0, 32);

export type CacheStampDecision = {
  stamp: boolean;
  /** Present when stamp is false: why this conversation is not being stamped. */
  reason?: string;
};

type ConversationEntry = {
  prefixHash: string;
  messageHashes: string[];
  volatile: boolean;
  stableStreak: number;
};

export class CachePrefixVolatilityGuard {
  /** Insertion-ordered; re-inserted on touch, so the first key is the LRU. */
  private readonly conversations = new Map<string, ConversationEntry>();

  constructor(private readonly maxConversations = 1000) {
    if (!Number.isInteger(maxConversations) || maxConversations < 1) {
      throw new Error("maxConversations must be a positive integer.");
    }
  }

  /**
   * Record this request and decide whether its conversation has earned a
   * cache stamp. Call once per request, with the raw (unreduced) request.
   */
  observe(request: unknown): CacheStampDecision {
    if (!isPlainObject(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
      return { stamp: true };
    }
    const key = digest([request.model ?? null, request.messages[0]]);
    const prefixHash = digest([request.tools ?? null, request.system ?? null]);
    const messageHashes = (request.messages as unknown[]).map(digest);

    const prior = this.conversations.get(key);
    if (prior !== undefined) this.conversations.delete(key);

    if (prior === undefined) {
      this.conversations.set(key, { prefixHash, messageHashes, volatile: false, stableStreak: 0 });
      this.evict();
      return { stamp: true };
    }

    const prefixChanged = prior.prefixHash !== prefixHash;
    const historyExtends =
      messageHashes.length >= prior.messageHashes.length &&
      prior.messageHashes.every((hash, index) => messageHashes[index] === hash);

    const entry: ConversationEntry = { prefixHash, messageHashes, volatile: prior.volatile, stableStreak: prior.stableStreak };
    let decision: CacheStampDecision = { stamp: true };

    if (prefixChanged || !historyExtends) {
      entry.volatile = true;
      entry.stableStreak = 0;
      decision = {
        stamp: false,
        reason: prefixChanged
          ? "tools/system changed between turns of this conversation, so a cached prefix could never be read back"
          : "the conversation history was rewritten between turns, so a cached prefix could never be read back",
      };
    } else if (entry.volatile) {
      entry.stableStreak += 1;
      if (entry.stableStreak >= 2) {
        entry.volatile = false;
        entry.stableStreak = 0;
      } else {
        decision = {
          stamp: false,
          reason: "this conversation's prefix changed on an earlier turn; waiting for it to prove stable before stamping again",
        };
      }
    }

    this.conversations.set(key, entry);
    return decision;
  }

  private evict(): void {
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      if (oldest === undefined) return;
      this.conversations.delete(oldest);
    }
  }
}
