/**
 * Shared-prefix fan-out serialization (lever P5 in docs/rnd/lever-backlog.md).
 *
 * The mechanism this exists to fix: a provider's prompt cache entry exists
 * only once the WRITING request's response has started — not at the moment
 * the request was sent. When a multi-agent orchestrator fans two or more
 * sub-agents out at (near) the same instant, all of them share one system +
 * tool-catalogue prefix, and all of them arrive before any of them has a
 * cache entry to read. Every one of them pays the write premium
 * (Anthropic: 1.25x/2x base) instead of N-1 of them reading at 0.1x. This is
 * not a bug in FLUX's cache stamping — the stamp is correct on every single
 * request — it is a timing race between siblings that stamping alone cannot
 * fix, confirmed by `evals/run-fanout-serialization.ts` against the
 * concurrency-aware cache simulator (see `packages/core/src/cache-simulator.ts`,
 * `visibleAfterSeconds`).
 *
 * The fix is pure timing, never bytes: hold same-prefix-hash arrivals behind
 * an in-flight latch until the first ("leader") request's response has
 * actually started, then release the rest ("followers") to send in order.
 * The provider never sees anything different about any individual request —
 * every byte it reads is identical to the unlatched request. This is why the
 * lever is classified lossless rather than lossy-gate-required.
 *
 * What this module deliberately does NOT do (left for a live-hardening
 * pass before this ever defaults on, per the lever backlog's adversarial
 * conditions): verify FLUX's own prefix-hash keying actually matches the
 * provider's own cache key byte-for-byte; watch real latency/timeout/retry
 * impact in production; auto-disable per key on repeated hold-timeout
 * misses. `holdTimeoutMs` below is this version's entire safety margin —
 * it is intentionally generous (hold caps scale with prefix size per the
 * backlog's P5 condition 2) and a follower NEVER waits past it no matter
 * what the leader does, including the leader erroring or hanging.
 */

/**
 * The shared-prefix identity two fanned-out sibling requests must agree on
 * to be worth serializing: provider, model, and the stable system + tool
 * catalogue a FLUX cache stamp would place `cache_control` on — never the
 * per-agent messages, which are exactly the part that legitimately differs
 * between siblings. Deliberately coarser than the actual stamped byte span
 * (hashing up to FLUX's own breakpoint bytes needs the live byte-match
 * against provider-side cache keying this backlog item is still waiting
 * on): two requests that share this key but would NOT actually share a
 * provider cache entry only cost a few seconds of needless holding, never
 * a wrong answer or a dropped request, so the coarser key is safe to ship
 * ahead of that verification and tighten later.
 */
export function fanOutLatchKey(request: {
  provider: "anthropic" | "openai";
  model: unknown;
  system?: unknown;
  tools?: unknown;
}): string {
  return JSON.stringify([
    request.provider,
    typeof request.model === "string" ? request.model : "",
    request.system ?? null,
    request.tools ?? null,
  ]);
}

export type FanOutLatchOptions = {
  /**
   * How long a follower will wait for its leader before giving up and
   * sending anyway, in milliseconds. A held request that times out sends
   * exactly as it would have with no latch at all — the latch can only
   * ever convert a write into a read; it can never turn a request into one
   * that is never sent, and it can never make a request wait longer than
   * this no matter how many followers are queued behind the same leader.
   */
  holdTimeoutMs?: number;
};

export type LatchLeaderHandle = {
  role: "leader";
  /**
   * Call once the leader's own upstream call has produced its first
   * response byte ("started") so followers can now expect a warm cache,
   * or has failed before producing one ("errored") so they stop waiting
   * and proceed exactly as if there had been no latch. Idempotent: a
   * second call is a no-op, so a caller racing its own timeout and its
   * own response handler can call this from either path safely.
   */
  release(outcome: "started" | "errored"): void;
};

export type LatchFollowerHandle = {
  role: "follower";
  /** Resolves once released by the leader, or once holdTimeoutMs elapses. */
  wait: Promise<void>;
};

export type FanOutLatch = {
  /**
   * Register arrival of a request whose shared-prefix identity is `key`
   * (see `fanOutLatchKey` below for how FLUX derives this from a request).
   * The first caller for a given key becomes the leader and must send
   * immediately; every caller that arrives while that leader is still
   * in flight becomes a follower and must await `wait` before sending.
   * Once a leader releases (or times out), the key clears: the NEXT
   * caller becomes a fresh leader, exactly as it would if this round's
   * write had happened with no latch at all.
   */
  acquire(key: string): LatchLeaderHandle | LatchFollowerHandle;
};

type PendingLeader = {
  followers: Array<() => void>;
  settled: boolean;
};

const DEFAULT_HOLD_TIMEOUT_MS = 10_000;

export function createFanOutLatch(options: FanOutLatchOptions = {}): FanOutLatch {
  const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  const inFlight = new Map<string, PendingLeader>();

  return {
    acquire(key: string): LatchLeaderHandle | LatchFollowerHandle {
      const existing = inFlight.get(key);
      if (existing === undefined) {
        const pending: PendingLeader = { followers: [], settled: false };
        inFlight.set(key, pending);
        return {
          role: "leader",
          release(_outcome: "started" | "errored"): void {
            if (pending.settled) return;
            pending.settled = true;
            // The round is over the instant the leader's response starts (or
            // fails) — later arrivals are a NEW round and get their own
            // leader, whether or not the provider actually ends up warm.
            if (inFlight.get(key) === pending) inFlight.delete(key);
            for (const resolve of pending.followers) resolve();
            pending.followers.length = 0;
          },
        };
      }

      let resolve!: () => void;
      const wait = new Promise<void>((settle) => {
        resolve = settle;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      existing.followers.push(release);
      timer = setTimeout(release, holdTimeoutMs);
      timer.unref?.();
      return { role: "follower", wait };
    },
  };
}
