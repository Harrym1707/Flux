import { estimateTokenCost, type TokenPrice } from "./cost.js";

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
};

export type PriceLookup =
  | { status: "priced"; price: TokenPrice; entry: ModelPriceEntry; negotiated?: NegotiatedRate }
  | { status: "unpriced"; reason: string };

export type UsagePricing =
  | { status: "priced"; costUsd: number; price: TokenPrice; entry: ModelPriceEntry; negotiated?: NegotiatedRate }
  | { status: "unpriced"; reason: string };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type PriceQuery = {
  provider: string;
  model: string;
  mode?: ModelPriceEntry["mode"];
  /** ISO date the request was billed on. */
  at: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_ENDED = "9999-12-31";

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO calendar date (YYYY-MM-DD); received ${JSON.stringify(value)}.`);
  }
}

function assertRate(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number of USD per million tokens.`);
  }
}

function assertTiers(tiers: PriceTier[], label: string): void {
  if (tiers.length === 0) throw new Error(`${label} must declare at least one price tier.`);
  const unbounded = tiers.filter((tier) => tier.maxInputTokens === undefined);
  if (unbounded.length !== 1) {
    throw new Error(`${label} must declare exactly one tier without maxInputTokens; found ${unbounded.length}.`);
  }
  const bounds = tiers
    .map((tier) => tier.maxInputTokens)
    .filter((bound): bound is number => bound !== undefined);
  if (bounds.some((bound) => !Number.isInteger(bound) || bound <= 0)) {
    throw new Error(`${label} tier bounds must be positive integers.`);
  }
  if (new Set(bounds).size !== bounds.length) {
    throw new Error(`${label} declares duplicate tier bounds.`);
  }
  for (const tier of tiers) {
    assertRate(tier.inputPerMillion, `${label} inputPerMillion`);
    assertRate(tier.outputPerMillion, `${label} outputPerMillion`);
    assertRate(tier.cachedInputPerMillion, `${label} cachedInputPerMillion`);
    assertRate(tier.cacheWriteInputPerMillion, `${label} cacheWriteInputPerMillion`);
  }
}

function assertProvenance(provenance: PriceProvenance, label: string): void {
  if (!provenance || typeof provenance.source !== "string" || provenance.source.trim() === "") {
    throw new Error(`${label} needs a provenance.source so the rate can be traced to a published price.`);
  }
  assertIsoDate(provenance.capturedOn, `${label} provenance.capturedOn`);
}

function rangeKey(item: { provider: string; model: string; mode?: string }): string {
  return `${item.provider} ${item.model} ${item.mode ?? "standard"}`;
}

function overlaps(
  left: { effectiveFrom: string; effectiveTo?: string },
  right: { effectiveFrom: string; effectiveTo?: string },
): boolean {
  return left.effectiveFrom < (right.effectiveTo ?? OPEN_ENDED) &&
    right.effectiveFrom < (left.effectiveTo ?? OPEN_ENDED);
}

/**
 * Validate a catalogue. Overlapping date ranges for one provider/model/mode are
 * rejected rather than resolved, because silently picking one of two candidate
 * rates would make a cost figure unreproducible.
 */
export function validatePriceCatalogue(catalogue: PriceCatalogue): PriceCatalogue {
  const seen = new Map<string, Array<{ effectiveFrom: string; effectiveTo?: string }>>();
  for (const entry of catalogue.entries) {
    const label = `Price entry ${entry.provider}/${entry.model} (${entry.mode}) from ${entry.effectiveFrom}`;
    if (!entry.provider.trim() || !entry.model.trim()) {
      throw new Error("Price entries need a non-empty provider and model.");
    }
    assertIsoDate(entry.effectiveFrom, `${label} effectiveFrom`);
    if (entry.effectiveTo !== undefined) {
      assertIsoDate(entry.effectiveTo, `${label} effectiveTo`);
      if (entry.effectiveTo <= entry.effectiveFrom) {
        throw new Error(`${label} ends on or before it starts.`);
      }
    }
    assertTiers(entry.tiers, label);
    assertProvenance(entry.provenance, label);
    const key = rangeKey(entry);
    const ranges = seen.get(key) ?? [];
    const clash = ranges.find((range) => overlaps(range, entry));
    if (clash) {
      throw new Error(
        `${label} overlaps another rate for the same model and mode starting ${clash.effectiveFrom}; ` +
        "close the earlier rate with effectiveTo so each billing date resolves to exactly one price.",
      );
    }
    ranges.push(entry);
    seen.set(key, ranges);
  }

  const negotiatedSeen = new Map<string, Array<{ effectiveFrom: string; effectiveTo?: string }>>();
  for (const rate of catalogue.negotiated) {
    const label = `Negotiated rate ${rate.provider}/${rate.model} from ${rate.effectiveFrom}`;
    const hasDiscount = rate.discountPercent !== undefined;
    const hasTiers = rate.tiers !== undefined;
    if (hasDiscount === hasTiers) {
      throw new Error(`${label} must set exactly one of discountPercent or tiers.`);
    }
    assertIsoDate(rate.effectiveFrom, `${label} effectiveFrom`);
    if (rate.effectiveTo !== undefined) {
      assertIsoDate(rate.effectiveTo, `${label} effectiveTo`);
      if (rate.effectiveTo <= rate.effectiveFrom) throw new Error(`${label} ends on or before it starts.`);
    }
    if (hasDiscount && (!Number.isFinite(rate.discountPercent) || rate.discountPercent! < 0 || rate.discountPercent! >= 100)) {
      throw new Error(`${label} discountPercent must be at least 0 and below 100.`);
    }
    if (hasTiers) assertTiers(rate.tiers!, label);
    assertProvenance(rate.provenance, label);
    const key = rangeKey(rate);
    const ranges = negotiatedSeen.get(key) ?? [];
    if (ranges.some((range) => overlaps(range, rate))) {
      throw new Error(`${label} overlaps another negotiated rate for the same model and mode.`);
    }
    ranges.push(rate);
    negotiatedSeen.set(key, ranges);
  }
  return catalogue;
}

function applicable<T extends { effectiveFrom: string; effectiveTo?: string }>(items: T[], at: string): T | undefined {
  return items.find((item) => item.effectiveFrom <= at && (item.effectiveTo === undefined || at < item.effectiveTo));
}

function tierFor(tiers: PriceTier[], inputTokens: number): PriceTier {
  const bounded = tiers
    .filter((tier): tier is PriceTier & { maxInputTokens: number } => tier.maxInputTokens !== undefined)
    .sort((left, right) => left.maxInputTokens - right.maxInputTokens);
  const match = bounded.find((tier) => inputTokens <= tier.maxInputTokens);
  return match ?? tiers.find((tier) => tier.maxInputTokens === undefined)!;
}

function withoutBound(tier: PriceTier): TokenPrice {
  const { maxInputTokens: _bound, ...price } = tier;
  return price;
}

function discounted(tier: PriceTier, discountPercent: number): TokenPrice {
  const factor = 1 - discountPercent / 100;
  return {
    inputPerMillion: tier.inputPerMillion * factor,
    outputPerMillion: tier.outputPerMillion * factor,
    ...(tier.cachedInputPerMillion === undefined
      ? {}
      : { cachedInputPerMillion: tier.cachedInputPerMillion * factor }),
    ...(tier.cacheWriteInputPerMillion === undefined
      ? {}
      : { cacheWriteInputPerMillion: tier.cacheWriteInputPerMillion * factor }),
  };
}

/**
 * Resolve the rate that applied to one model on one date. Returns an explicit
 * `unpriced` result rather than a zero, so a missing price can never be mistaken
 * for free inference.
 */
export function lookupPrice(
  catalogue: PriceCatalogue,
  query: PriceQuery,
  inputTokens = 0,
): PriceLookup {
  assertIsoDate(query.at, "Price query `at`");
  const mode = query.mode ?? "standard";
  const candidates = catalogue.entries.filter((entry) =>
    entry.provider === query.provider && entry.model === query.model && entry.mode === mode);
  if (candidates.length === 0) {
    return { status: "unpriced", reason: `No ${mode} rate is catalogued for ${query.provider}/${query.model}.` };
  }
  const entry = applicable(candidates, query.at);
  if (!entry) {
    const ranges = candidates
      .map((candidate) => `${candidate.effectiveFrom} to ${candidate.effectiveTo ?? "current"}`)
      .join("; ");
    return {
      status: "unpriced",
      reason: `No ${mode} rate for ${query.provider}/${query.model} covers ${query.at}; catalogued ranges are ${ranges}.`,
    };
  }
  const tier = tierFor(entry.tiers, inputTokens);
  const override = applicable(
    catalogue.negotiated.filter((rate) =>
      rate.provider === query.provider && rate.model === query.model && (rate.mode ?? "standard") === mode),
    query.at,
  );
  if (!override) return { status: "priced", price: withoutBound(tier), entry };
  const price = override.tiers
    ? withoutBound(tierFor(override.tiers, inputTokens))
    : discounted(tier, override.discountPercent!);
  return { status: "priced", price, entry, negotiated: override };
}

/**
 * Cost of one recorded request. Token counts come from the provider's own usage
 * fields; the rate comes from the catalogue, never from the traffic itself.
 */
export function priceUsage(
  catalogue: PriceCatalogue,
  query: PriceQuery,
  usage: TokenUsage,
): UsagePricing {
  for (const [name, value] of Object.entries(usage)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Token usage ${name} must be a non-negative finite number.`);
    }
  }
  const lookup = lookupPrice(catalogue, query, usage.inputTokens);
  if (lookup.status === "unpriced") return lookup;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  if ((cached > 0 && lookup.price.cachedInputPerMillion === undefined) ||
      (cacheWrite > 0 && lookup.price.cacheWriteInputPerMillion === undefined)) {
    return {
      status: "unpriced",
      reason: `${query.provider}/${query.model} billed cached input tokens on ${query.at}, but the catalogue has no cached-input rate for it.`,
    };
  }
  const costUsd = estimateTokenCost(usage.inputTokens, usage.outputTokens, lookup.price, {
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
  });
  return { status: "priced", costUsd, price: lookup.price, entry: lookup.entry, negotiated: lookup.negotiated };
}

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
export function repriceUsage(
  catalogue: PriceCatalogue,
  baseline: PriceQuery,
  candidate: PriceQuery,
  usage: TokenUsage,
): RepriceComparison {
  const left = priceUsage(catalogue, baseline, usage);
  const right = priceUsage(catalogue, candidate, usage);
  if (left.status !== "priced" || right.status !== "priced") return { baseline: left, candidate: right };
  const savingsUsd = left.costUsd - right.costUsd;
  return {
    baseline: left,
    candidate: right,
    savingsUsd,
    savingsPercent: left.costUsd === 0 ? 0 : (savingsUsd / left.costUsd) * 100,
  };
}

/** Parse an externally supplied catalogue, for example a customer's contracted rates. */
export function parsePriceCatalogue(value: unknown): PriceCatalogue {
  if (typeof value !== "object" || value === null) throw new Error("A price catalogue must be an object.");
  const raw = value as { entries?: unknown; negotiated?: unknown };
  if (!Array.isArray(raw.entries)) throw new Error("A price catalogue needs an `entries` array.");
  if (raw.negotiated !== undefined && !Array.isArray(raw.negotiated)) {
    throw new Error("A price catalogue `negotiated` field must be an array when present.");
  }
  return validatePriceCatalogue({
    entries: raw.entries as ModelPriceEntry[],
    negotiated: (raw.negotiated ?? []) as NegotiatedRate[],
  });
}

/** Combine catalogues, for example published rates plus a customer's contract. */
export function mergePriceCatalogues(...catalogues: PriceCatalogue[]): PriceCatalogue {
  return validatePriceCatalogue({
    entries: catalogues.flatMap((catalogue) => catalogue.entries),
    negotiated: catalogues.flatMap((catalogue) => catalogue.negotiated),
  });
}
