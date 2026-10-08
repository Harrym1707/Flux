# Price catalogue

FLUX does not read prices out of the traffic it audits. A cost figure is only as
trustworthy as the rate behind it, so rates live in a catalogue with dates and a
published source, and a missing rate is reported as missing.

## Why this exists

Benchmark exports and provider logs carry a `cost` field, and that field is
frequently wrong or absent. The clearest case: in LLMRouterBench, nine models
record `cost: 0` on every record while reporting millions of tokens. Treated as
prices, those zeros made the cheapest model look free and produced a 100% cost
saving on `finqa` for a model that lost 9.83 points of quality. A $0 record is a
missing price, not free inference.

So: token counts come from the traffic. Rates come from the catalogue.

## Properties

- **Dated.** Each rate carries `effectiveFrom` and optional `effectiveTo`. A
  billing date resolves to exactly one rate, which is what makes a cost figure
  reproducible after a provider changes prices.
- **Sourced.** Every rate carries `provenance.source` and `provenance.capturedOn`,
  so any number in a report can be traced to a published page on a known date.
  Validation rejects a rate without a source.
- **Explicit about ignorance.** `lookupPrice` and `priceUsage` return
  `{ status: "unpriced", reason }`, never a zero. An audit of traffic the
  catalogue does not cover says so instead of inventing a comparison.
- **Non-overlapping by construction.** Two rates covering the same
  provider/model/mode on the same date are rejected at validation time rather
  than resolved by ordering.
- **Tiered.** Providers band some models by prompt size. A model may carry
  several bands and exactly one unbounded band.
- **Contract-aware.** `negotiated` rates layer over published list prices, as
  either a flat discount or a replacement set of bands, so an audit can run at
  the rates a customer actually pays.
- **Mode-aware.** `standard`, `batch`, and `flex` price independently.

## Seeded rates

`publishedModelPrices` holds list rates read from each provider's own pricing
page. `effectiveFrom` is the date the rate was **observed**, not the date the
provider introduced it, because published pages carry no change history. A lookup
for an earlier billing date therefore returns `unpriced` rather than applying
today's rate to last quarter's spend. Backfill earlier rates as dated entries
when auditing older traffic.

Model keys are the names as published. Marketing names and API model identifiers
do not always match, so map them explicitly for your own traffic rather than
assuming a key matches the string your SDK sends.

## Usage

```ts
import { publishedModelPrices, priceUsage, repriceUsage } from "@flux/core";

const cost = priceUsage(
  publishedModelPrices,
  { provider: "openai", model: "gpt-5", at: "2026-10-08" },
  { inputTokens: 2_000_000, outputTokens: 500_000 },
);
if (cost.status === "unpriced") throw new Error(cost.reason);
cost.costUsd; // 7.5

// What the same recorded tokens would have cost elsewhere.
const comparison = repriceUsage(
  publishedModelPrices,
  { provider: "openai", model: "gpt-6-astra", at: "2026-10-08" },
  { provider: "openai", model: "gpt-6.1-sol", at: "2026-10-08" },
  { inputTokens: 2_000_000, outputTokens: 500_000 },
);
comparison.savingsPercent; // undefined if either side is unpriced
```

`repriceUsage` reports a saving only when both sides price. A comparison against
an unpriced model is not a comparison.

## Keeping it current

Rates change. Adding a new rate means adding a dated entry and closing the
previous one with `effectiveTo` — never editing a rate in place, which would
silently change the cost of every past audit that cited it.
