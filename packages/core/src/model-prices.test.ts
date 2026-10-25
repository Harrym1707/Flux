import { describe, expect, it } from "vitest";
import { anthropicCacheableMinimumTokens } from "./model-prices.js";

describe("anthropicCacheableMinimumTokens", () => {
  it("is 1,024 tokens for non-Haiku Claude models", () => {
    expect(anthropicCacheableMinimumTokens("claude-sonnet-5-5-20260514")).toBe(1024);
    expect(anthropicCacheableMinimumTokens("claude-opus-5-5-latest")).toBe(1024);
    expect(anthropicCacheableMinimumTokens("claude-fable-5-1")).toBe(1024);
    // An id the price catalogue would not resolve to any entry still has a
    // real minimum; the lenient default (1,024) applies to anything that is
    // not recognisably Haiku-class, by name.
    expect(anthropicCacheableMinimumTokens("claude-sonnet-4-5")).toBe(1024);
  });

  it("is 2,048 tokens for Haiku-class models, matched by substring regardless of case or build date", () => {
    expect(anthropicCacheableMinimumTokens("claude-haiku-5-5-20260514")).toBe(2048);
    expect(anthropicCacheableMinimumTokens("claude-haiku-5-5-latest")).toBe(2048);
    expect(anthropicCacheableMinimumTokens("Claude-Haiku-3")).toBe(2048);
    expect(anthropicCacheableMinimumTokens("CLAUDE-HAIKU-5-5")).toBe(2048);
  });
});
