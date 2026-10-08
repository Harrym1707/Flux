import { validatePriceCatalogue, type ModelPriceEntry, type PriceCatalogue } from "./price-catalogue.js";

/**
 * Published list rates, read from each provider's own pricing page.
 *
 * `effectiveFrom` is the date the rate was OBSERVED, not the date the provider
 * introduced it, because published pages do not carry change history. A lookup
 * for an earlier billing date therefore returns `unpriced` instead of quietly
 * applying today's rate to last quarter's traffic. Backfill earlier rates with
 * their own dated entries when auditing older spend.
 *
 * Model keys are the names as published. Providers' marketing names and API
 * model identifiers do not always match, so map them explicitly for your own
 * traffic rather than assuming a key matches the string your SDK sends.
 */

const ANTHROPIC = {
  source: "https://claude.com/pricing",
  capturedOn: "2026-10-08",
  note: "Published display names; cache read/write rates as listed.",
} as const;

const OPENAI = {
  source: "https://developers.openai.com/api/docs/pricing",
  capturedOn: "2026-10-08",
  note: "Standard tier unless the entry says otherwise.",
} as const;

const OBSERVED_FROM = "2026-10-08";

type Rates = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
  maxInputTokens?: number;
};

function entry(
  provider: string,
  model: string,
  provenance: ModelPriceEntry["provenance"],
  bands: Rates[],
  mode: ModelPriceEntry["mode"] = "standard",
): ModelPriceEntry {
  return {
    provider,
    model,
    mode,
    effectiveFrom: OBSERVED_FROM,
    provenance,
    tiers: bands.map((band) => ({
      ...(band.maxInputTokens === undefined ? {} : { maxInputTokens: band.maxInputTokens }),
      inputPerMillion: band.input,
      outputPerMillion: band.output,
      ...(band.cachedInput === undefined ? {} : { cachedInputPerMillion: band.cachedInput }),
      ...(band.cacheWriteInput === undefined ? {} : { cacheWriteInputPerMillion: band.cacheWriteInput }),
    })),
  };
}

const anthropic: ModelPriceEntry[] = [
  entry("anthropic", "Fable 5.1", ANTHROPIC, [
    { input: 10, output: 50, cachedInput: 0.25, cacheWriteInput: 12.5 },
  ]),
  entry("anthropic", "Opus 5.5", ANTHROPIC, [
    { input: 4, output: 20, cachedInput: 0.2, cacheWriteInput: 5 },
  ]),
  entry("anthropic", "Sonnet 5.5", ANTHROPIC, [
    { input: 2, output: 10, cachedInput: 0.1, cacheWriteInput: 2.5 },
  ]),
  // Haiku 5.5 is tiered by prompt size: the higher band applies above 100K input tokens.
  entry("anthropic", "Haiku 5.5", ANTHROPIC, [
    { maxInputTokens: 100_000, input: 0.1, output: 0.5, cachedInput: 0.01, cacheWriteInput: 0.125 },
    { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWriteInput: 0.625 },
  ]),
];

const openai: ModelPriceEntry[] = [
  entry("openai", "gpt-6-astra", OPENAI, [{ input: 10, output: 50, cachedInput: 1 }]),
  entry("openai", "gpt-6.1-sol", OPENAI, [{ input: 2, output: 10, cachedInput: 0.1 }]),
  entry("openai", "gpt-6-luna", OPENAI, [{ input: 0.1, output: 0.5, cachedInput: 0.01 }]),
  entry("openai", "gpt-5.5", OPENAI, [{ input: 5, output: 30, cachedInput: 0.5 }]),
  entry("openai", "gpt-5.4", OPENAI, [{ input: 2.5, output: 15, cachedInput: 0.25 }]),
  entry("openai", "gpt-5.2", OPENAI, [{ input: 1.75, output: 14, cachedInput: 0.175 }]),
  entry("openai", "gpt-5", OPENAI, [{ input: 1.25, output: 10, cachedInput: 0.125 }]),
  entry("openai", "gpt-4o", OPENAI, [{ input: 2.5, output: 10, cachedInput: 1.25 }]),
  entry("openai", "gpt-4o-mini", OPENAI, [{ input: 0.15, output: 0.6, cachedInput: 0.075 }]),
  entry("openai", "o1", OPENAI, [{ input: 15, output: 60, cachedInput: 7.5 }]),
  entry("openai", "o3-mini", OPENAI, [{ input: 1.1, output: 4.4, cachedInput: 0.55 }]),
  // Only the batch rate published explicitly is catalogued. The page describes batch
  // and flex as "typically" half of standard; that is not a rate, so it is not seeded.
  entry("openai", "gpt-6-astra", OPENAI, [{ input: 5, output: 25, cachedInput: 0.5 }], "batch"),
];

/** Published list rates as observed on the capture date. */
export const publishedModelPrices: PriceCatalogue = validatePriceCatalogue({
  entries: [...anthropic, ...openai],
  negotiated: [],
});
