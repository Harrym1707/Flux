import { type PriceCatalogue } from "./price-catalogue.js";
/** Published list rates as observed on the capture date. */
export declare const publishedModelPrices: PriceCatalogue;
/**
 * Anthropic's documented minimum cacheable prompt length, by model class:
 * 1,024 tokens for Opus- and Sonnet-class models, 2,048 tokens for
 * Haiku-class models (https://docs.claude.com/en/docs/build-with-claude/
 * prompt-caching, captured 2026-10-08, same capture date as `ANTHROPIC`
 * above). Below this minimum the provider processes the request without
 * caching at all — not an error, a silent no-op — so a breakpoint placed on
 * a shorter prefix can never be read back and would make MESH claim a
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
export declare function anthropicCacheableMinimumTokens(modelId: string): number;
