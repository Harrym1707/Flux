import { describe, expect, it } from "vitest";
import { anthropicCacheableMinimumTokens, publishedModelPrices } from "./model-prices.js";
import { lookupPrice, resolveModelId } from "./price-catalogue.js";

describe("DeepSeek pricing (OpenAI-compatible provider)", () => {
  const priceOf = (id: string) => {
    const r = resolveModelId(publishedModelPrices, "deepseek", id);
    if (r.status !== "resolved") return r;
    return lookupPrice(publishedModelPrices, { provider: "deepseek", model: r.model, at: "2026-11-03" });
  };

  it("prices deepseek-flash and deepseek-v4-pro at their off-peak rates (never over-valued)", () => {
    const flash = priceOf("deepseek-flash");
    expect(flash.status).toBe("priced");
    if (flash.status === "priced") expect(flash.price.inputPerMillion).toBe(0.15);
    const pro = priceOf("deepseek-v4-pro");
    expect(pro.status).toBe("priced");
    if (pro.status === "priced") expect(pro.price.outputPerMillion).toBe(1.98);
  });

  it("maps the legacy deepseek-v4-flash id to the Flash rate", () => {
    const legacy = priceOf("deepseek-v4-flash");
    expect(legacy.status).toBe("priced");
    if (legacy.status === "priced") expect(legacy.price.inputPerMillion).toBe(0.15);
  });

  it("leaves an unknown DeepSeek model unpriced rather than guessing", () => {
    const unknown = priceOf("deepseek-does-not-exist");
    expect(unknown.status).not.toBe("priced");
  });
});

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
