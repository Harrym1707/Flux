import { createHash } from "node:crypto";

/**
 * Cross-turn stability pin for semantic compaction (./semantic-compaction.ts).
 *
 * compactStaleContext calls a CUSTOMER-SUPPLIED local model to paraphrase
 * stale tool-result bodies. A stale body is RESENT on every subsequent turn
 * (it just gets further from "live"), so if the model were re-invoked on
 * every call it would very likely return a different paraphrase each time —
 * and a provider's exact-prefix cache misses the instant one byte differs
 * from what it cached last turn. Re-compacting on every turn would make a
 * cached agent MORE expensive, not less: a cache-write premium paid again and
 * again for a body the cache already held cheaply.
 *
 * This is the "hard blocker" flagged in
 * docs/rnd/semantic-compaction-design.md (2026-10-27 review): semantic
 * compaction "MUST NOT be enabled alongside caching until the compacted
 * result is pinned: compact a given body once, key the result by a hash of
 * the original bytes, and re-emit the identical compacted bytes on every
 * subsequent turn."
 *
 * The pin is keyed on the body's own bytes (plus maxTokens/kind), not on a
 * conversation or turn index: the SAME tool-result body recompacted in a
 * different conversation, or resent by a retry, gets the same pinned answer
 * too — strictly more stable, never less.
 *
 * Usage mirrors CachePrefixVolatilityGuard (cache-volatility-guard.ts):
 * create ONE instance and reuse it across every call for the life of the
 * proxy/process, so turn N+1 sees what turn N decided. A fresh store on every
 * call (what happens when none is supplied) is still byte-correct within
 * that single call, but buys none of the cross-turn stability — callers that
 * run compaction alongside caching MUST hold one instance across calls.
 */

export type CompactionPinOutcome = {
  /** The pinned compacted text, or null when the body was pinned to "not shorter" (use the original verbatim). */
  compacted: string | null;
};

const digest = (parts: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts) ?? "null").digest("hex");

export class CompactionPinStore {
  /** Insertion-ordered; re-inserted on touch, so the first key is the LRU. */
  private readonly pins = new Map<string, CompactionPinOutcome>();

  constructor(private readonly maxEntries = 5000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer.");
    }
  }

  private key(text: string, maxTokens: number, kind: string): string {
    return digest([kind, maxTokens, text]);
  }

  /** A previously-pinned outcome for this exact body, cap, and kind. Undefined on a miss. */
  get(text: string, maxTokens: number, kind: string): CompactionPinOutcome | undefined {
    const key = this.key(text, maxTokens, kind);
    const hit = this.pins.get(key);
    if (hit !== undefined) {
      this.pins.delete(key);
      this.pins.set(key, hit);
    }
    return hit;
  }

  /** Pin the outcome for this exact body so every future call on it returns the same bytes. */
  set(text: string, maxTokens: number, kind: string, compacted: string | null): void {
    const key = this.key(text, maxTokens, kind);
    this.pins.set(key, { compacted });
    this.evict();
  }

  get size(): number {
    return this.pins.size;
  }

  private evict(): void {
    while (this.pins.size > this.maxEntries) {
      const oldest = this.pins.keys().next().value;
      if (oldest === undefined) return;
      this.pins.delete(oldest);
    }
  }
}
