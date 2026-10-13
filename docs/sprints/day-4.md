# FLUX Sprint — Day 4 EOD (2026-10-13)

**Theme:** SDK surface and billable completeness — Chat Completions and Anthropic SDK through the same reduce+ledger path, cache-write TTL split on billable events, ledger projected into a local Stripe meter sink.

## Floor and stretch

- **Floor (50%): MET** — 64.3% (measured) on the async-eligible segment (arm K, flex x0.5 stacked with caching), 38/40 fully-good tasks, 40/40 tool-ok, quality held, at HEAD 4e9e774 (320 tests, 27/27 gates, full harness re-run).
- **Stretch (70%): NOT MET** on the quality-held headline. The one-shot workload's async cell shows 72.8% (measured, harness) but the chain's quality-held headline remains 64.3%.
- **Quality-held measured numbers per segment** (all measured in harness unless marked):
  - Interactive: 26.0–29.4% (arm J band; full recorded band is 25.9–29.4 and the quoted 26.0 floor already excluded the 25.9 row — nothing moved today)
  - One-shot: 45.5% / async variant 72.8%
  - Async-eligible: 64.3% (arm K)
  - Sparse 1h-TTL: 34.1% (**simulator-measured**, arm L — now billable at event level, real-traffic validation still open)
- **Today's measured number:** 64.3% | **Chain best:** 64.3% | **Delta vs yesterday: 0.0 pts** — the matrix is byte-stable against day 3 (10407bf); today's gains were billable completeness and surface coverage, not new savings percentage.

## What got better for the end user today

A customer on Chat Completions or the Anthropic SDK — not just the Responses API — can now get the identical measured reduction, recomputable ledger, and dispute-safe invoice on one hash chain, and the 34.1% (simulator-measured) sparse-1h arm became billable at event level; but no real end user experienced any of it, because real traffic is still zero on day 4 of 4.

## Research (grade: A)

The day-4 brief was load-bearing: all three repo-verified breakers it named (Responses-only usage parser rejecting valid Anthropic/Chat shapes; per-surface field mapping; tool_result blocks hidden inside user-role messages, which would have made both compaction levers fire on zero Anthropic tokens in production) were real and fixed along the exact lines specified. Source-confirmed facts (verbatim `usage.cache_creation` field names, 2.0x 1h write rate, OpenAI flex exactly 50%, Anthropic batch 50% stacking with 0.05x batch cache reads) converted directly into billable code. Misses: one phantom claim shipped (a "divergent parser in traffic.ts" grep disproved); the per-model cacheable-minimum correction (flat 1024 → 512–4096 per model) did not land, so one known simulator overstatement survives; Anthropic batch rate remains uncatalogued.

## Engineering (grade: B)

Six commits, HEAD 4e9e774, tree clean: shared provider-usage normaliser in core (one parser for Responses/Chat/Anthropic with sum-checked 5m/1h split); TTL split billable (5m 1.25x / 1h 2x; mismatched split → UNPRICED, never repaired; splitless FLUX-placed writes priced at 2x so FLUX can only under-claim); reducer preconditions per surface including the Anthropic tool_result traversal fix; both new surfaces wrapped through the ONE shared withFlux handler on a single hash chain; local network-free Stripe meter sink sharing billability selection with the invoice (doubled spool → byte-identical rows). Independently verified: 320 tests, 27/27 gates, harness matrix unchanged, both surfaces smoked from the installed tarball (ESM). B not A because: a stale day-3 pkg/ bundle sat on disk with no freshness gate (verifier caught it), CJS mode was not re-executed at HEAD, and the builder's new surface tests were run by the verifier, not the builder. Deliberately cut: replay-gate convenience API (founder item 5).

## Commercial (grade: A)

The day's commercial substance is billable completeness: arm L (34.1%, simulator-measured) upgraded from unbillable to ledger-grade — verified at event level, a surface-emitted event carries the 5m/1h pair, prices 3.2 USD (measured, fixture) with the 1h premium, and recomputeInvoice nets its −1.2 USD negative-cache surcharge rather than clamping it. Every piece of the pilot kit that is code now exists; the piece that is not code — one real export from a machine we never touch — is still at zero. The drafted LiteLLM reconciliation outreach (issues #34801/#33772/#19681, diagnostic-first, 25%-of-verified-savings as postscript) and the Helicone-migration variant remain unsent; sending is Harry's action and the single highest-leverage unblocked step.

## Carried into day 5

- Hand Harry three send-ready LiteLLM outreach packets; time-boxed Helicone variant.
- Website/GEO copy strictly from the measured matrix, per the end-user rule (bands not point claims, caveats in the copy).
- Replay-gate adapter (~60 lines) so an approved run flips a lossy lever billable without manual steps.
- pkg/ freshness gate + CJS smoke at HEAD.
- Catalogue Anthropic batch rate; per-model cacheable minimums (512–4096) to stop sparse-1h overstatement.

*All percentages harness-measured at HEAD 4e9e774 unless explicitly marked simulator-measured; no projected numbers appear in this report — blended real-traffic savings remain unknowable until real traffic exists.*
