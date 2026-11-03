import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import {
  ANTHROPIC_CACHE_5M,
  OPENAI_CACHE,
  simulateCache,
  type SimulatedRequest,
} from "./cache-simulator.js";

// Base rates only, so the simulator derives cached and write rates from the
// policy's multipliers rather than from a catalogue entry.
const price: TokenPrice = { inputPerMillion: 1.25, outputPerMillion: 10 };

/** Roughly four characters per token, so sizes here are predictable. */
function filler(tokens: number): string {
  return Array.from({ length: tokens }, (_, index) => `word${index}`).join(" ");
}

function stream(prompts: string[], spacingSeconds = 10): SimulatedRequest[] {
  return prompts.map((prompt, index) => ({
    atSeconds: index * spacingSeconds,
    prompt,
    outputTokens: 100,
  }));
}

describe("cache simulator", () => {
  it("caches nothing below the provider's minimum prefix length", () => {
    const short = filler(200);
    const result = simulateCache(stream([short, short, short]), OPENAI_CACHE, price);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.savingUsd).toBe(0);
    expect(result.missReasons["below-minimum"] ?? result.missReasons["no-matching-prefix"])
      .toBeGreaterThan(0);
  });

  it("caches a long repeated prefix and charges the cached rate for it", () => {
    const prefix = filler(3_000);
    const prompts = Array.from({ length: 5 }, (_, index) => `${prefix}\nQuestion ${index}`);
    const result = simulateCache(stream(prompts), OPENAI_CACHE, price);
    expect(result.hitRate).toBeGreaterThan(0.5);
    expect(result.totalCostUsd).toBeLessThan(result.uncachedCostUsd);
    expect(result.savingPercent).toBeGreaterThan(10);
  });

  it("loses the whole prefix when an early character differs", () => {
    const body = filler(3_000);
    // A per-request value at the very front, which is what a clock in a system
    // prompt does: everything after it stops matching.
    const prompts = Array.from({ length: 5 }, (_, index) => `t=${index}\n${body}`);
    const result = simulateCache(stream(prompts), OPENAI_CACHE, price);
    expect(result.hitRate).toBe(0);
    // Floating-point summation, so compare against zero with a tolerance.
    expect(result.savingUsd).toBeCloseTo(0, 10);
  });

  it("recovers that prefix once the varying value moves to the end", () => {
    const body = filler(3_000);
    const broken = simulateCache(
      stream(Array.from({ length: 5 }, (_, index) => `t=${index}\n${body}`)),
      OPENAI_CACHE,
      price,
    );
    const repaired = simulateCache(
      stream(Array.from({ length: 5 }, (_, index) => `${body}\nt=${index}`)),
      OPENAI_CACHE,
      price,
    );
    expect(repaired.hitRate).toBeGreaterThan(broken.hitRate);
    expect(repaired.totalCostUsd).toBeLessThan(broken.totalCostUsd);
  });

  it("goes cold when requests are spread beyond the time to live", () => {
    const prefix = filler(3_000);
    const prompts = Array.from({ length: 6 }, (_, index) => `${prefix}\nQuestion ${index}`);
    const warm = simulateCache(stream(prompts, 30), OPENAI_CACHE, price);
    // Spacing beyond the 300s TTL means every entry has expired by the next call.
    const cold = simulateCache(stream(prompts, 600), OPENAI_CACHE, price);
    expect(warm.hitRate).toBeGreaterThan(0.5);
    expect(cold.hitRate).toBe(0);
    expect(cold.expiries).toBeGreaterThan(0);
    expect(cold.savingUsd).toBeLessThanOrEqual(warm.savingUsd);
  });

  it("can make caching a net loss where a write premium is charged and nothing repeats", () => {
    const prefix = filler(3_000);
    // Each prompt is unique and spaced past the TTL, so every call pays a write
    // premium and no call ever reads. Anthropic charges 1.25x to write.
    const prompts = Array.from({ length: 4 }, (_, index) => `${prefix}-${index}-${filler(50)}`);
    const result = simulateCache(stream(prompts, 900), ANTHROPIC_CACHE_5M, price);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.savingUsd).toBeLessThan(0);
  });

  it("grants hits in whole increments of the policy's granularity", () => {
    const prefix = filler(3_000);
    const result = simulateCache(
      stream([`${prefix}a`, `${prefix}b`]),
      OPENAI_CACHE,
      price,
    );
    const hit = result.calls[1]!;
    expect(hit.cachedInputTokens % OPENAI_CACHE.incrementTokens).toBe(0);
  });

  it("splits every call's input into cached, written and fresh without losing tokens", () => {
    const prefix = filler(3_000);
    const result = simulateCache(
      stream(Array.from({ length: 4 }, (_, index) => `${prefix}\nQ${index}`)),
      OPENAI_CACHE,
      price,
    );
    for (const call of result.calls) {
      expect(call.cachedInputTokens + call.writtenInputTokens + call.freshInputTokens)
        .toBe(call.totalInputTokens);
      expect(call.freshInputTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("never reports a saving on the very first call", () => {
    const result = simulateCache(stream([filler(3_000)]), OPENAI_CACHE, price);
    expect(result.calls[0]!.cachedInputTokens).toBe(0);
    expect(result.calls[0]!.missReason).toBe("first-request");
  });

  it("orders requests by time regardless of input order", () => {
    const prefix = filler(3_000);
    const out: SimulatedRequest[] = [
      { atSeconds: 60, prompt: `${prefix}\nsecond`, outputTokens: 10 },
      { atSeconds: 0, prompt: `${prefix}\nfirst`, outputTokens: 10 },
    ];
    const result = simulateCache(out, OPENAI_CACHE, price);
    expect(result.calls[0]!.atSeconds).toBe(0);
    expect(result.calls[1]!.atSeconds).toBe(60);
  });

  it("defaults to instant write visibility, unchanged from before visibleAfterSeconds existed", () => {
    const prefix = filler(3_000);
    const prompts = Array.from({ length: 4 }, (_, index) => `${prefix}\nQ${index}`);
    const result = simulateCache(stream(prompts), OPENAI_CACHE, price);
    expect(result.hitRate).toBeGreaterThan(0.5);
  });

  it("makes two requests sent at the same instant for the same prefix both miss and both write", () => {
    const prefix = filler(3_000);
    const racers: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 10, visibleAfterSeconds: 3 },
      { atSeconds: 0, prompt: `${prefix}\nagent-b`, outputTokens: 10, visibleAfterSeconds: 3 },
    ];
    const result = simulateCache(racers, ANTHROPIC_CACHE_5M, price);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.calls[1]!.missReason).toBe("not-yet-visible");
    expect(result.calls.every((call) => call.writtenInputTokens > 0)).toBe(true);
  });

  it("lets a later arrival read the cache once the writer's response has actually started", () => {
    const prefix = filler(3_000);
    const serialized: SimulatedRequest[] = [
      { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 10, visibleAfterSeconds: 3 },
      { atSeconds: 4, prompt: `${prefix}\nagent-b`, outputTokens: 10, visibleAfterSeconds: 3 },
    ];
    const result = simulateCache(serialized, ANTHROPIC_CACHE_5M, price);
    expect(result.calls[1]!.missReason).toBeUndefined();
    expect(result.calls[1]!.cachedInputTokens).toBeGreaterThan(0);
  });

  it("distinguishes a race loss from a genuinely absent prefix", () => {
    const prefix = filler(3_000);
    const noPriorWrite = simulateCache(
      [{ atSeconds: 0, prompt: `${prefix}\nsolo`, outputTokens: 10 }],
      ANTHROPIC_CACHE_5M,
      price,
    );
    expect(noPriorWrite.calls[0]!.missReason).toBe("first-request");

    const raced = simulateCache(
      [
        { atSeconds: 0, prompt: `${prefix}\nagent-a`, outputTokens: 10, visibleAfterSeconds: 3 },
        { atSeconds: 1, prompt: `${prefix}\nagent-b`, outputTokens: 10, visibleAfterSeconds: 3 },
      ],
      ANTHROPIC_CACHE_5M,
      price,
    );
    expect(raced.calls[1]!.missReason).toBe("not-yet-visible");
  });

  it("validates its inputs", () => {
    expect(() => simulateCache([], OPENAI_CACHE, price)).toThrow(/at least one request/);
    expect(() => simulateCache(stream([filler(100)]), { ...OPENAI_CACHE, incrementTokens: 0 }, price))
      .toThrow(/at least 1 token/);
  });
});
