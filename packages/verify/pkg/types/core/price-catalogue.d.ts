import { type TokenPrice } from "./cost.js";
/**
 * Where a rate came from, so a cost figure in a report can be traced back to a
 * published price rather than taken on trust.
 */
export type PriceProvenance = {
    /** Published source the rate was read from. */
    source: string;
    /** ISO date (YYYY-MM-DD) the rate was read. */
    capturedOn: string;
    note?: string;
};
/**
 * One rate band. Providers tier some models by prompt size, so a single model can
 * carry several bands; exactly one band is unbounded.
 */
export type PriceTier = TokenPrice & {
    /** Applies when input tokens are at most this value; omit for the unbounded band. */
    maxInputTokens?: number;
};
/** A provider's published rate for one model over one date range. */
export type ModelPriceEntry = {
    provider: string;
    model: string;
    /** Billing mode; distinct modes price independently over the same dates. */
    mode: "standard" | "batch" | "flex";
    /** Inclusive ISO date this rate took effect. */
    effectiveFrom: string;
    /** Exclusive ISO date this rate stopped applying; omit while current. */
    effectiveTo?: string;
    tiers: PriceTier[];
    provenance: PriceProvenance;
};
/**
 * A customer's contracted rate, layered over published prices. Either a flat
 * discount on the published rate or a full replacement set of bands.
 */
export type NegotiatedRate = {
    provider: string;
    model: string;
    mode?: ModelPriceEntry["mode"];
    effectiveFrom: string;
    effectiveTo?: string;
    /** Percentage off every published rate, 0-100. Mutually exclusive with `tiers`. */
    discountPercent?: number;
    /** Replacement bands. Mutually exclusive with `discountPercent`. */
    tiers?: PriceTier[];
    provenance: PriceProvenance;
};
export type PriceCatalogue = {
    entries: ModelPriceEntry[];
    negotiated: NegotiatedRate[];
    /** API-identifier to catalogue-key mappings; see resolveModelId. */
    aliases?: ModelAlias[];
};
export type PriceLookup = {
    status: "priced";
    price: TokenPrice;
    entry: ModelPriceEntry;
    negotiated?: NegotiatedRate;
} | {
    status: "unpriced";
    reason: string;
};
export type UsagePricing = {
    status: "priced";
    costUsd: number;
    price: TokenPrice;
    entry: ModelPriceEntry;
    negotiated?: NegotiatedRate;
} | {
    status: "unpriced";
    reason: string;
};
export type TokenUsage = {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    /** TOTAL cache writes, inclusive of any 1h share below. */
    cacheWriteInputTokens?: number;
    /** The share of the writes above that carried the 1h TTL (bills a premium). */
    cacheWrite1hInputTokens?: number;
};
export type PriceQuery = {
    provider: string;
    model: string;
    mode?: ModelPriceEntry["mode"];
    /** ISO date the request was billed on. */
    at: string;
};
/**
 * Validate a catalogue. Overlapping date ranges for one provider/model/mode are
 * rejected rather than resolved, because silently picking one of two candidate
 * rates would make a cost figure unreproducible.
 */
export declare function validatePriceCatalogue(catalogue: PriceCatalogue): PriceCatalogue;
/**
 * Resolve the rate that applied to one model on one date. Returns an explicit
 * `unpriced` result rather than a zero, so a missing price can never be mistaken
 * for free inference.
 */
export declare function lookupPrice(catalogue: PriceCatalogue, query: PriceQuery, inputTokens?: number): PriceLookup;
/**
 * Cost of one recorded request. Token counts come from the provider's own usage
 * fields; the rate comes from the catalogue, never from the traffic itself.
 */
export declare function priceUsage(catalogue: PriceCatalogue, query: PriceQuery, usage: TokenUsage): UsagePricing;
export type RepriceComparison = {
    baseline: UsagePricing;
    candidate: UsagePricing;
    /** Set only when both sides priced; positive means the candidate is cheaper. */
    savingsUsd?: number;
    savingsPercent?: number;
};
/**
 * Re-price recorded usage against a different model, provider, or billing mode.
 * Both sides must price before a saving is reported: a comparison against an
 * unpriced model is not a comparison.
 */
export declare function repriceUsage(catalogue: PriceCatalogue, baseline: PriceQuery, candidate: PriceQuery, usage: TokenUsage): RepriceComparison;
/** Parse an externally supplied catalogue, for example a customer's contracted rates. */
export declare function parsePriceCatalogue(value: unknown): PriceCatalogue;
/** Combine catalogues, for example published rates plus a customer's contract. */
export declare function mergePriceCatalogues(...catalogues: PriceCatalogue[]): PriceCatalogue;
/**
 * Deterministic JSON: object keys sorted recursively, `undefined` members
 * omitted. Two structurally equal values always serialise to identical bytes,
 * which is what makes content hashes over catalogues and ledger events stable.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * Content hash of a catalogue. Pinned onto every ledger event at write time, so
 * an invoice names the exact rates it was computed against and a later
 * catalogue update can never silently re-price history.
 */
export declare function catalogueVersion(catalogue: PriceCatalogue): string;
/** Maps an API model identifier onto a catalogue key. */
export type ModelAlias = {
    provider: string;
    /** Exact API model id, or a prefix ending in "*". */
    id: string;
    /** Catalogue model key this resolves to. */
    model: string;
};
export type ModelResolution = {
    status: "resolved";
    model: string;
    via: "exact" | "alias" | "normalised";
} | {
    status: "unresolved";
    reason: string;
    candidates: string[];
};
/**
 * Resolve the model id a log carries onto a catalogue key.
 *
 * Catalogue keys are the names providers publish on their pricing pages
 * ("Sonnet 5.5"); logs carry API identifiers ("claude-sonnet-5-5-20260514").
 * Without this every real row prices as unpriced.
 *
 * Resolution never guesses. Exact matches win, then explicit aliases, then a
 * normalised comparison that strips punctuation, case and a trailing release
 * date. Where normalisation admits more than one catalogue key the longest
 * match wins, so "sonnet 5.5" beats "sonnet 5" on `claude-sonnet-5-5`; where two
 * keys tie, the result is unresolved and names the candidates, because pricing
 * traffic against a coin flip is a billing error rather than a convenience.
 */
export declare function resolveModelId(catalogue: PriceCatalogue, provider: string, rawModelId: string): ModelResolution;
