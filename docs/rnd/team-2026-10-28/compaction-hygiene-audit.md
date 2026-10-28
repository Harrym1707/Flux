# Compaction hygiene audit + usage.iterations ledger fix (round 2)

Branch: `rnd/2026-10-28-team-compaction-hygiene-audit-r2`. Lossless, advise-only. Bills nothing.

## Hypothesis

1. FLUX's ledger reads only the top-level `usage` fields. When Anthropic server-side compaction runs, the
   summarizer's cost sits only in `usage.iterations`, so FLUX under-states the customer's real spend. That is
   a ledger honesty defect, not a saving.
2. The compaction swap is the caller's job, and the docs list mistakes that raise no error. A local,
   hash-only auditor can spot them and give advice.

## Doc text relied on (fetched 2026-10-28)

- compaction-threshold, "Understanding usage": "The top-level `input_tokens` and `output_tokens` do not include
  compaction iteration usage. They reflect the sum of all non-compaction iterations. To calculate total tokens
  consumed and billed for a request, sum across all entries in the `usage.iterations` array." Also: "With the
  compaction beta enabled, every response includes `usage.iterations`, even if no compaction occurred."
  Beta header `compact-2026-01-12`, edit `compact_20260112`, default trigger 150,000, minimum 50,000. "The API
  automatically drops all content blocks prior to the `compaction` block". On caching: "add a `cache_control`
  breakpoint at the end of your system prompt", so "the system prompt cache remains valid".
- compaction-on-demand: beta header `compact-2026-09-04`, `"compaction": {"type": "summarize"}`, response
  `stop_reason: "compaction"` with `usage: {input_tokens: 0, output_tokens: 0, iterations: [{type:
  "compaction", ...}]}`. "The top-level `input_tokens` and `output_tokens` are zero because no reply was
  generated." Warning: "Two mistakes in the swap raise no error. If summarized messages remain after the block,
  the API sends them to Claude again. If a later request leaves the block out, Claude gets no summary."
  "`cache_control` on the block places a breakpoint after the summary." A missing summary "is still billed and
  reported in `usage.iterations`".
- compaction-keep-recent-turns: "No parameter sets which turns are kept ... send only the older turns, then put
  the block in front of the turns you kept." This gives case B: the whole history is compacted, and the tail is
  kept as well.
- Anthropic TS SDK (`anthropics/anthropic-sdk-typescript` main, package.json 1.3.0):
  `BetaCompactionIterationUsage` has `{cache_creation, cache_creation_input_tokens, cache_read_input_tokens,
  input_tokens, output_tokens, type: 'compaction'}`. `BetaMessageIterationUsage` has the same fields plus
  `model`. On `BetaMessageDeltaUsage.iterations`: "A `compaction` entry's tokens are not included in the
  top-level `usage` fields." The union also has advisor and fallback iteration types.

## What was built

- `packages/core/src/provider-usage.ts` `providerCompactionUsage()`. It sums the `compaction` entries of
  `usage.iterations` using the Anthropic convention for each entry. A broken TTL split returns invalid; it is not
  repaired. `normalizeProviderUsage` is unchanged.
- `packages/core/src/savings-ledger.ts`:
  - New optional `BillableEvent.compaction` field: `{attribution: "customer", iterations, usage, usd,
    pricingStatus}`.
  - `priceCompactionUsage`, which never attributes cache economics to FLUX.
  - `eventProviderCostUsd`.
  - `auditEventPricing` now also checks `compaction.usd` with zero tolerance.
  - The invoice gets an informational `customerCompaction` total, present only when compaction ran. It never
    enters `netVerifiedSavingsUsd`.
- SDK changes:
  - `compaction-usage.ts` builds the event field.
  - `openai.ts` and `proxy.ts` populate it. The proxy's `usageFromSse` now carries `message_delta`
    `usage.iterations` through.
  - `savings-ledger.ts` prices it.
- `packages/sdk-js/src/compaction-audit.ts`. Off by default (`enabled: true` required). It runs in memory and
  keeps only SHA-256 message hashes (with `cache_control` stripped) plus approximate token counts. It flags:
  - `rebilled-summarized-history`
  - `compaction-block-dropped`
  - `repeated-compaction` (consecutive turns, or an identical growing prefix that is summarized again)
  - `threshold-compaction-cache` (breakpoints only in the dropped history, none on system or tools)

  `compactionAdviceLines()` renders the findings. It is not wired into `withFlux` yet.
- Tests (new files only; no existing test was touched):
  - `compaction-ledger.test.ts` (8): written failing-first. 6 of 8 failed before the fix.
  - `compaction-audit.test.ts` (8).
- Suite: 433 before, 449 after, all green.

## Measured / derived results

**Ledger.** Measured from the test, at Opus 5.5 catalogued rates ($4/M input, $20/M output, $0.20/M cached).

| Event | Before the fix | Provider bill | Error per event |
|---|---|---|---|
| Docs-scale threshold event | $0.112 | $0.902 | -$0.79 |
| On-demand summarize | $0 | $0.186 | -$0.186 (100%) |

Across the 28 compaction events in the fixture (derived from the fixture, `run-team-compaction-hygiene-audit.ts`
Part 1):

- Before the fix, the ledger showed $0.2950 against a provider bill of $6.8135. That is 95.67% under-stated, or
  $0.2328 per event on average.
- After the fix the error is $0.0000.
- The change in billed FLUX savings is $0.0000 on every event. The test proves levers and the invoice net are
  identical with and without iterations.

**Auditor precision** (derived from the fixture, `run-team-compaction-audit.ts`):

- Doc-JSON pairs: 3/3 findings correct.
- 30-turn sessions: 24/24 correct, no false positives, no missed cases. The two negative controls, A and E2,
  raised nothing.
- The first run gave 66% precision because of a real auditor bug: it used the first compaction block instead of
  the newest one. The bug is fixed. These figures come from the same author's fixture, so they are not
  independent.

**Waste per 30-turn session** (Opus 5.5, simulateCache, derived from the fixture):

| Case | 5m cache (agent already caches) | No cache (sensitivity) |
|---|---|---|
| B: leftover summarized turns | $0.0997 = 5.77% (~175K approx re-sent tokens, ±28%; mostly read at 0.1x) | 9.32% |
| C: block dropped (summary paid, never used) | $0.2098 = 13.24% | 12.53% |
| D: compaction every turn (running-total bug) | $1.6577 = 50.43% | 14.55% |
| E: threshold compaction, no system breakpoint, vs E2 | $0.0954 = 5.58% | 0% |

In case C the total bill is actually $0.045 lower than A, because the requests then carry no summary at all.
That is a quality loss, not a saving.

FLUX-billed saving: **$0**, by design.

## Caveats

- Prevalence is UNMEASURED. No FLUX capture uses the compaction beta. The waste figures apply only to sessions
  that make that specific mistake.
- Fixture sizes (6K system, ~3.2K per turn, 3K summary, 60K limit) are inventions. Case D's size depends on how
  long the bug runs.
- simulateCache does not model incremental cache writes on partial hits. It is optimistic about caching in every
  arm.
- Advisor and fallback iteration types, and the per-iteration `model` field, are not priced separately. All
  compaction iterations are priced at the event's model.
- Pricing compaction cache reads and writes as customer-owned is the conservative choice. In fact the summarizer
  may read a prefix FLUX stamped.
- Hashing requires byte-identical messages, apart from `cache_control` and the string/single-text-block form.
  A client that re-serializes messages differently will be missed (a false negative, never a false positive).

## Next

1. Wire `CompactionAuditor` into `withFlux` and the proxy behind `compactionAudit: {enabled}`, with a per-session
   key, and add the advice lines to `renderLedgerReport`.
2. Add a `customerCompaction` line to the ledger report and the Stripe sink statement (informational only).
3. Live probe, about $1 on Opus 5.5: verify whether the compaction iteration reports cache reads on a stamped
   prefix, and whether threshold-mode top-level usage carries cache fields.
4. Cache-stamp suppression on threshold routes. Skip FLUX's last-message breakpoint when the request is within one
   turn of `trigger.value`, and price it with a breakpoint-aware simulator.
