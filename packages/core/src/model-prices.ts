import {
  validatePriceCatalogue,
  type ModelAlias,
  type ModelPriceEntry,
  type PriceCatalogue,
} from "./price-catalogue.js";

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
  note: "Published display names; cache read/write rates as listed. 5m cache writes bill 1.25x base input, " +
    "1h cache writes 2x base input, per the published prompt-caching pricing.",
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
  cacheWrite1hInput?: number;
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
      ...(band.cacheWrite1hInput === undefined ? {} : { cacheWrite1hInputPerMillion: band.cacheWrite1hInput }),
    })),
  };
}

const anthropic: ModelPriceEntry[] = [
  entry("anthropic", "Fable 5.1", ANTHROPIC, [
    { input: 10, output: 50, cachedInput: 0.25, cacheWriteInput: 12.5, cacheWrite1hInput: 20 },
  ]),
  entry("anthropic", "Opus 5.5", ANTHROPIC, [
    { input: 4, output: 20, cachedInput: 0.2, cacheWriteInput: 5, cacheWrite1hInput: 8 },
  ]),
  entry("anthropic", "Sonnet 5.5", ANTHROPIC, [
    { input: 2, output: 10, cachedInput: 0.1, cacheWriteInput: 2.5, cacheWrite1hInput: 4 },
  ]),
  // Haiku 5.5 is tiered by prompt size: the higher band applies above 100K input tokens.
  entry("anthropic", "Haiku 5.5", ANTHROPIC, [
    { maxInputTokens: 100_000, input: 0.1, output: 0.5, cachedInput: 0.01, cacheWriteInput: 0.125, cacheWrite1hInput: 0.2 },
    { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWriteInput: 0.625, cacheWrite1hInput: 1 },
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
  // Flex processing is billed at Batch API rates = 50% of standard, on a
  // synchronous API, per OpenAI's flex-processing guide. Cached-input discount
  // stacks on top. Catalogued so the ledger can price flex-tier events rather
  // than leaving async savings unpriced.
  entry("openai", "gpt-5", OPENAI, [{ input: 0.625, output: 5, cachedInput: 0.0625 }], "flex"),
];

/**
 * API identifiers to catalogue keys.
 *
 * Catalogue keys are the names on the pricing pages; application logs carry API
 * identifiers. Normalised matching in resolveModelId handles the common case
 * (stripping case, punctuation and a trailing release date), so these entries
 * exist for the ids normalisation cannot reach: aliases, "-latest" pointers, and
 * ids whose shape does not contain the published name.
 *
 * A wrong entry here mis-prices real traffic, so each one is an exact id or an
 * explicit prefix. Nothing is inferred.
 */
const aliases: ModelAlias[] = [
  // Anthropic ids embed the published name, so normalisation covers dated
  // builds such as claude-sonnet-5-5-20260514. These cover the pointers.
  { provider: "anthropic", id: "claude-sonnet-5-5-latest", model: "Sonnet 5.5" },
  { provider: "anthropic", id: "claude-opus-5-5-latest", model: "Opus 5.5" },
  { provider: "anthropic", id: "claude-haiku-5-5-latest", model: "Haiku 5.5" },
  { provider: "anthropic", id: "claude-fable-5-1-latest", model: "Fable 5.1" },
  // OpenAI ids match their published names directly; these are the pointers
  // and the dated snapshots that do not normalise onto a catalogued key.
  { provider: "openai", id: "chatgpt-4o-latest", model: "gpt-4o" },
  { provider: "openai", id: "gpt-4o-2024-*", model: "gpt-4o" },
  { provider: "openai", id: "gpt-4o-mini-2024-*", model: "gpt-4o-mini" },
  { provider: "openai", id: "o3-mini-2025-*", model: "o3-mini" },
];

/** Published list rates as observed on the capture date. */
export const publishedModelPrices: PriceCatalogue = validatePriceCatalogue({
  entries: [...anthropic, ...openai],
  negotiated: [],
  aliases,
});

/**
 * Anthropic's documented minimum cacheable prompt length, by model class:
 * 1,024 tokens for Opus- and Sonnet-class models, 2,048 tokens for
 * Haiku-class models (https://docs.claude.com/en/docs/build-with-claude/
 * prompt-caching, captured 2026-10-08, same capture date as `ANTHROPIC`
 * above). Below this minimum the provider processes the request without
 * caching at all — not an error, a silent no-op — so a breakpoint placed on
 * a shorter prefix can never be read back and would make FLUX claim a
 * saving that cannot happen.
 *
 * Matched on the raw model id by substring rather than through
 * `resolveModelId`, because the minimum only depends on which model
 * CLASS was called (Haiku vs. everything else), not on resolving the exact
 * dated build to a catalogued price entry — a model id the price catalogue
 * cannot resolve (an older or unlisted Claude build) still has a real
 * minimum, and guessing wrong in the lenient direction (1,024 for an
 * unrecognised id) risks stamping a Haiku-class model's too-short prefix.
 * An id that is not recognisably Claude at all should never reach this
 * function; callers only call it after confirming an Anthropic-shaped
 * request.
 */
export function anthropicCacheableMinimumTokens(modelId: string): number {
  return /haiku/i.test(modelId) ? 2048 : 1024;
}
