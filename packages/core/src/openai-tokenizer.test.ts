import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Tiktoken as TiktokenType } from "js-tiktoken/lite";
import { OPENAI_CACHE, simulateCache } from "./cache-simulator.js";
import {
  MAX_EXACT_PRETOKEN_CHARS,
  countTokensForModel,
  exactTokenCount,
  openAIEncodingForModel,
  tokenCounterForModel,
} from "./openai-tokenizer.js";
import { approximateTokenCount } from "./token-reduction.js";

// An independent, unbounded js-tiktoken encoder to compare against: the
// reference is the library's own encode on the whole string.
const requireHere = createRequire(import.meta.url);
const { Tiktoken } = requireHere("js-tiktoken/lite") as { Tiktoken: typeof TiktokenType };
const reference = {
  o200k_base: new Tiktoken(requireHere("js-tiktoken/ranks/o200k_base")),
  cl100k_base: new Tiktoken(requireHere("js-tiktoken/ranks/cl100k_base")),
};

describe("exact OpenAI token counts", () => {
  it("matches the published token ids for known strings", () => {
    // The tiktoken README's o200k_base example, and the long-standing cl100k_base one.
    expect(reference.o200k_base.encode("hello world")).toEqual([24912, 2375]);
    expect(reference.cl100k_base.encode("hello world")).toEqual([15339, 1917]);
    expect(exactTokenCount("hello world", "o200k_base")).toBe(2);
    expect(exactTokenCount("hello world", "cl100k_base")).toBe(2);
    // OpenAI cookbook: "tiktoken is great!" is 6 tokens.
    expect(exactTokenCount("tiktoken is great!", "cl100k_base")).toBe(6);
    expect(exactTokenCount("tiktoken is great!", "o200k_base")).toBe(6);
    expect(exactTokenCount("", "o200k_base")).toBe(0);
  });

  it("pins exact counts for prose, JSON and code under both encodings", () => {
    const json = "{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}}}";
    const code = "function add(a, b) {\n  return a + b;\n}\n";
    expect(exactTokenCount(json, "o200k_base")).toBe(14);
    expect(exactTokenCount(code, "o200k_base")).toBe(14);
    for (const text of [json, code, "antidisestablishmentarianism", "Ünïcödé — 東京 🚀 test"]) {
      for (const encoding of ["o200k_base", "cl100k_base"] as const) {
        expect(exactTokenCount(text, encoding)).toBe(reference[encoding].encode(text, [], []).length);
      }
    }
  });

  it("counts special-token text as ordinary text instead of throwing", () => {
    const text = "<|endoftext|> hi";
    expect(() => exactTokenCount(text, "o200k_base")).not.toThrow();
    expect(exactTokenCount(text, "o200k_base")).toBe(reference.o200k_base.encode(text, [], []).length);
    expect(exactTokenCount(text, "o200k_base")).toBeGreaterThan(2);
  });

  it("stays exact when the long-run guard walks pre-tokens but finds none over the cap", () => {
    // Long runs of non-space characters that the encoder's own pattern splits
    // into short pre-tokens (case changes, punctuation), so nothing is chunked.
    const camel = "SomeVeryLongIdentifierName".repeat(12);
    const path = "/srv/data/archive/".repeat(10);
    for (const text of [camel, `prefix ${path} suffix`, `${camel}\n\n${path}`]) {
      expect(text.length).toBeGreaterThan(MAX_EXACT_PRETOKEN_CHARS);
      expect(exactTokenCount(text, "o200k_base")).toBe(reference.o200k_base.encode(text, [], []).length);
    }
  });

  it("bounds the cost of one over-long pre-token and stays close to the exact count", () => {
    const run = `Intro sentence here. ${"a".repeat(1_000)} and the tail of the sentence.`;
    const exact = reference.o200k_base.encode(run, [], []).length;
    expect(Math.abs(exactTokenCount(run, "o200k_base") - exact)).toBeLessThanOrEqual(8);

    // 50,000 identical letters take minutes through an unbounded encoder.
    const huge = "z".repeat(50_000);
    const started = performance.now();
    const count = exactTokenCount(huge, "o200k_base");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(50_000);
  });

  it("returns the same count when a large string is counted again (memoised)", () => {
    const text = "The refund policy covers closed cards and wallet credits. ".repeat(200);
    const first = exactTokenCount(text, "o200k_base");
    expect(exactTokenCount(text, "o200k_base")).toBe(first);
    expect(exactTokenCount(text, "cl100k_base")).toBe(reference.cl100k_base.encode(text, [], []).length);
    expect(first).toBe(reference.o200k_base.encode(text, [], []).length);
  });
});

describe("model id to encoding", () => {
  it("maps the o200k_base families", () => {
    for (const id of [
      "gpt-4o", "gpt-4o-mini", "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18", "chatgpt-4o-latest",
      "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano-2025-04-14", "gpt-4.5-preview",
      "gpt-5", "gpt-5-mini", "gpt-5-nano-2025-08-07", "gpt-5-chat-latest",
      "o1", "o1-mini", "o1-pro", "o3", "o3-mini", "o3-mini-2025-01-31", "o4-mini", "o4-mini-2025-04-16",
      "GPT-4o", " gpt-4o ", "openai/gpt-4o", "azure/gpt-4.1", "ft:gpt-4o-mini-2024-07-18:acme::abc123",
    ]) {
      expect(openAIEncodingForModel(id), id).toBe("o200k_base");
    }
  });

  it("maps the cl100k_base families without swallowing gpt-4o or gpt-4.1", () => {
    for (const id of [
      "gpt-4", "gpt-4-0613", "gpt-4-32k", "gpt-4-turbo", "gpt-4-turbo-2024-04-09", "gpt-4-1106-preview",
      "gpt-3.5-turbo", "gpt-3.5-turbo-0125", "gpt-3.5-turbo-instruct", "gpt-35-turbo", "azure/gpt-35-turbo-16k",
      "text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large", "ft:gpt-3.5-turbo-0613:acme::x",
    ]) {
      expect(openAIEncodingForModel(id), id).toBe("cl100k_base");
    }
  });

  it("refuses to guess for ids it does not positively recognise", () => {
    for (const id of [
      // Claude: the tokenizer is not public.
      "claude-sonnet-5-5", "claude-sonnet-4-5", "us.anthropic.claude-sonnet-4-5-v1:0",
      // OpenAI ids outside the pinned tiktoken table.
      "gpt-5.2", "gpt-5.5", "gpt-6-astra", "gpt-6.1-sol", "gpt-oss-120b", "o5", "text-davinci-003",
      // Look-alikes and other routes.
      "gpt-4omega", "gpt-40", "o10", "openrouter/openai/gpt-4o", "bedrock/gpt-4o", "ft:", "", "unknown",
    ]) {
      expect(openAIEncodingForModel(id), id).toBeUndefined();
    }
    expect(openAIEncodingForModel(undefined)).toBeUndefined();
  });

  it("falls back to the approximation, labelled, for unknown and Claude ids", () => {
    const text = "Verify the account tier before quoting limits. {\"tier\": 3}";
    for (const id of ["claude-sonnet-5-5", "gpt-6-astra", undefined]) {
      const counter = tokenCounterForModel(id);
      expect(counter.basis).toBe("approximate");
      expect(counter.countTokens(text)).toBe(approximateTokenCount(text));
      expect(countTokensForModel(text, id)).toBe(approximateTokenCount(text));
    }
    expect(tokenCounterForModel("gpt-4o").basis).toBe("exact:o200k_base");
    expect(tokenCounterForModel("gpt-4").basis).toBe("exact:cl100k_base");
    expect(countTokensForModel(text, "gpt-4o")).toBe(reference.o200k_base.encode(text, [], []).length);
    expect(countTokensForModel(text, "gpt-3.5-turbo")).toBe(reference.cl100k_base.encode(text, [], []).length);
  });
});

describe("lazy loading", () => {
  it("parses no rank table until an OpenAI count is actually made, then caches it", async () => {
    vi.resetModules();
    const fresh = await import("./openai-tokenizer.js");
    expect(fresh.isEncodingLoaded("o200k_base")).toBe(false);
    expect(fresh.isEncodingLoaded("cl100k_base")).toBe(false);

    // Claude and unknown ids never load anything.
    fresh.countTokensForModel("some prose", "claude-sonnet-5-5");
    fresh.countTokensForModel("some prose", "gpt-6-astra");
    // Choosing the counter is not enough to load it either.
    const counter = fresh.tokenCounterForModel("gpt-4o");
    expect(fresh.isEncodingLoaded("o200k_base")).toBe(false);

    expect(counter.countTokens("hello world")).toBe(2);
    expect(fresh.isEncodingLoaded("o200k_base")).toBe(true);
    // Only the encoding that was used.
    expect(fresh.isEncodingLoaded("cl100k_base")).toBe(false);

    // The second count reuses the cached encoder: no reparse.
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) counter.countTokens(`hello world ${index}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("cache simulator model option", () => {
  it("counts a recognised OpenAI model exactly and keeps the approximation otherwise", () => {
    const prompt = "You are the FLUX support agent. Follow every policy below.\n".repeat(80);
    const requests = [{ atSeconds: 0, prompt, outputTokens: 10 }];
    const price = { inputPerMillion: 1, outputPerMillion: 1 };
    const exact = simulateCache(requests, OPENAI_CACHE, price, { model: "gpt-4o" });
    expect(exact.totalInputTokens).toBe(reference.o200k_base.encode(prompt, [], []).length);
    const approximate = simulateCache(requests, OPENAI_CACHE, price, { model: "claude-sonnet-5-5" });
    expect(approximate.totalInputTokens).toBe(approximateTokenCount(prompt));
    const noModel = simulateCache(requests, OPENAI_CACHE, price);
    expect(noModel.totalInputTokens).toBe(approximateTokenCount(prompt));
    // An explicit counter still wins over the model.
    const explicit = simulateCache(requests, OPENAI_CACHE, price, { model: "gpt-4o", countTokens: () => 7 });
    expect(explicit.totalInputTokens).toBe(7);
  });
});
