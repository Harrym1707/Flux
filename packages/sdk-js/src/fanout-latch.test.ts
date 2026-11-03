import { describe, expect, it, vi } from "vitest";
import { createFanOutLatch, fanOutLatchKey } from "./fanout-latch.js";

describe("fanOutLatchKey", () => {
  it("is the same for siblings that share provider, model, system and tools", () => {
    const a = fanOutLatchKey({ provider: "anthropic", model: "claude-sonnet-5-5", system: "x", tools: ["t"] });
    const b = fanOutLatchKey({ provider: "anthropic", model: "claude-sonnet-5-5", system: "x", tools: ["t"] });
    expect(a).toBe(b);
  });

  it("differs when the messages-independent shared prefix differs", () => {
    const base = { provider: "anthropic" as const, model: "claude-sonnet-5-5", system: "x", tools: ["t"] };
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, system: "y" }));
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, model: "claude-haiku-5" }));
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, provider: "openai" }));
  });
});

describe("fan-out latch", () => {
  it("makes the first arrival the leader and every later same-key arrival a follower", () => {
    const latch = createFanOutLatch();
    const leader = latch.acquire("k");
    expect(leader.role).toBe("leader");
    const follower = latch.acquire("k");
    expect(follower.role).toBe("follower");
  });

  it("releases every waiting follower the instant the leader's response starts", async () => {
    const latch = createFanOutLatch();
    const leader = latch.acquire("k");
    if (leader.role !== "leader") throw new Error("expected leader");
    const f1 = latch.acquire("k");
    const f2 = latch.acquire("k");
    if (f1.role !== "follower" || f2.role !== "follower") throw new Error("expected followers");

    let f1Resolved = false;
    let f2Resolved = false;
    f1.wait.then(() => { f1Resolved = true; });
    f2.wait.then(() => { f2Resolved = true; });
    await Promise.resolve();
    expect(f1Resolved).toBe(false);
    expect(f2Resolved).toBe(false);

    leader.release("started");
    await Promise.all([f1.wait, f2.wait]);
    expect(f1Resolved).toBe(true);
    expect(f2Resolved).toBe(true);
  });

  it("releases followers on a leader error too, exactly as if there had been no latch", async () => {
    const latch = createFanOutLatch();
    const leader = latch.acquire("k");
    if (leader.role !== "leader") throw new Error("expected leader");
    const follower = latch.acquire("k");
    if (follower.role !== "follower") throw new Error("expected follower");
    leader.release("errored");
    await expect(follower.wait).resolves.toBeUndefined();
  });

  it("starts a fresh round once the leader has released, even for the same key", () => {
    const latch = createFanOutLatch();
    const first = latch.acquire("k");
    if (first.role !== "leader") throw new Error("expected leader");
    first.release("started");
    const next = latch.acquire("k");
    expect(next.role).toBe("leader");
  });

  it("is a complete no-op for a key nobody else is using", () => {
    const latch = createFanOutLatch();
    const solo = latch.acquire("solo-key");
    expect(solo.role).toBe("leader");
  });

  it("never holds a follower past the hold timeout, however long the leader takes", async () => {
    vi.useFakeTimers();
    try {
      const latch = createFanOutLatch({ holdTimeoutMs: 50 });
      const leader = latch.acquire("k");
      if (leader.role !== "leader") throw new Error("expected leader");
      const follower = latch.acquire("k");
      if (follower.role !== "follower") throw new Error("expected follower");

      let resolved = false;
      follower.wait.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(49);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(resolved).toBe(true);
      // The leader hanging forever and never releasing must not matter.
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps multiple distinct keys fully independent", () => {
    const latch = createFanOutLatch();
    const leaderA = latch.acquire("a");
    const leaderB = latch.acquire("b");
    expect(leaderA.role).toBe("leader");
    expect(leaderB.role).toBe("leader");
  });

  it("tolerates a leader calling release twice", () => {
    const latch = createFanOutLatch();
    const leader = latch.acquire("k");
    if (leader.role !== "leader") throw new Error("expected leader");
    expect(() => {
      leader.release("started");
      leader.release("started");
    }).not.toThrow();
  });
});
