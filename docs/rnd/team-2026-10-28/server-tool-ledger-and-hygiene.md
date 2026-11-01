# Server-tool ledger completeness + web_search/web_fetch accumulation meter (R&D round 3)

Branch: `rnd/2026-10-28-team-server-tool-ledger-and-hygiene-r3`. Vertical: autonomous (research agents, Managed-Agents-style loops).
Eval: `node --import tsx evals/run-team-server-tool-ledger-and-hygiene.ts` (alias `evals/run-team-server-tool-hygiene.ts`).

## Hypothesis

1. **Ledger honesty.** Anthropic bills web search per search, on top of tokens. FLUX's ledger read token usage only, so it dropped that fee without a trace.
2. **Accumulation.** Server-tool result blocks get resent verbatim on every later turn. In a research loop they become most of the input. An advise-only meter can measure this and point at the provider's own knobs (dynamic filtering, `max_content_tokens`, `max_uses`, context editing).

## Sources (fetched 2026-11-01, primary pages)

- web-search-tool page: "Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs for search-generated content. Web search results retrieved throughout a conversation are counted as input tokens, in search iterations run during a single turn and in subsequent conversation turns." "If an error occurs during web search, the web search will not be billed." The usage field is `usage.server_tool_use.web_search_requests`. The page lists no default for `max_uses`. Versions are `web_search_20250305` (basic), `web_search_20260209` (dynamic filtering, `allowed_callers` defaults to `["code_execution_20260120"]`) and `web_search_20260318` (adds `response_inclusion`, default `"full"`).
- web-fetch-tool page: "Web fetch usage has **no additional charges** beyond standard token costs". The usage field is `web_fetch_requests`. On `max_uses`: "There is currently no default limit." `max_content_tokens` has no documented default (the example shows 100000), truncates, and applies to text only, not PDFs. Versions are `web_fetch_20250910`, `_20260209` (dynamic filtering), `_20260309` (adds `use_cache`) and `_20260318` (adds `response_inclusion`). Typical sizes: "Average webpage (10 kB): ~2,500 tokens; Large documentation page (100 kB): ~25,000 tokens".
- code-execution-tool page: "free when used with web search or web fetch (`web_search_20260209`, `web_fetch_20260209`, or later)". Otherwise there is a 5-minute minimum, 1,550 free hours per org per month, then $0.05 per hour per container. The usage field is `code_execution_requests`. A response does not report execution time, so FLUX cannot price it from the response and flags it as an `unpriced component`.
- claude.com/blog/improved-web-search-with-dynamic-filtering (2026-02-17): "improved performance by an average of 11% while using 24% fewer input tokens". "Price-weighted tokens decreased for Sonnet 4.6 on both benchmarks but increased for Opus 4.6." The blog gives no size for the Opus increase.

## What was built

- **Ledger (lossless):**
  - `providerServerToolUsage()` / `sumServerToolUsage()` in `packages/core/src/provider-usage.ts`. `normalizeProviderUsage` is unchanged, and a test pins that.
  - A separate fee catalogue, `packages/core/src/server-tool-fees.ts`, with its own content hash, so `catalogueVersion(publishedModelPrices)` and every pinned event audit stay unchanged. Search is priced at $0.01 per request and fetch at its published $0. Each entry carries the source URL and a quote. Code execution, other providers and back-dated events come out as `unpriced component`.
  - An optional field, `BillableEvent.serverToolUsage`, with `attributedTo: "customer"`. `recomputeInvoice` never reads it.
  - `auditServerToolFees` checks the fee with zero tolerance.
  - The field is filled in `openai.ts` (summed across fallback attempts), in the `proxy.ts` JSON path and in the SSE merge path, where the last `message_delta` `server_tool_use` wins.
- **Meter (lossless, advise-only, flag `serverToolMeter`, off by default):** `meterServerToolHygiene()` in `packages/sdk-js/src/server-tool-hygiene.ts`. It reports:
  - the share of input that is `web_search_tool_result` / `web_fetch_tool_result` blocks (client `tool_result` blocks are ignored);
  - which tool versions are pinned;
  - whether code execution is enabled or auto-provisioned.

  It gives advice in these cases:
  - recommend dynamic filtering on Sonnet-class routes only;
  - warn on Opus-class routes;
  - suggest `max_content_tokens`, `max_uses`, or context editing (`clear_tool_uses_20250919`), and flag `exclude_tools` that shields web results;
  - suggest `response_inclusion`.

  Every advice line is marked `lossy: true` and carries its basis.
- **Caps half (lossy): not built as a mutation.** Injecting `max_uses` or `max_content_tokens`, or upgrading tool versions, would change what the model reads, so it stays as advice only. Applying it would need the replay gate (`packages/sdk-js/src/replay-gate.ts`) before it could ever bill.

## Failing-first (measured)

`packages/sdk-js/src/server-tool-ledger.test.ts` was run against unmodified HEAD source (git archive of `d006973`). It fails with `AssertionError: expected undefined to be defined`: a response carrying `web_search_requests: 3` produced a ledger event with no trace of the $0.03 fee. It passes on this branch. The invariance tests (`server-tool-fees.test.ts`) show billed savings, fee and verdict are byte-identical with and without the field, and a period with only fees still bills $0.

## Measured result (eval, catalogued rates for 2026-10-28, simulator)

Fixture (synthetic, sizes labelled in the eval header):
- 3,000-token system + tools;
- 12 turns, 45 s apart;
- per turn: 200 tokens in, 700 tokens out;
- result blocks of S tokens at turns 2 and 5, with S = 2,500 / 8,000 / 25,000 (taken from the fetch page's own sizes).

Opus 5.5 is exactly 2x Sonnet 5.5 on every rate, so the percentages are identical across the two models. Only the dollar amounts differ.

| S | cache | Sonnet bill | result re-bill share | cap 8k (lossy) | dyn -24%, +0% out | break-even output increase |
|---|---|---|---|---|---|---|
| 2,500 | unstamped | $0.3746 | 25.4% | 0% | 6.1% | +60% |
| 2,500 | stamped 5m | $0.1345 | 10.6% | 0% | 2.5% | +19% |
| 8,000 | unstamped | $0.5836 | 52.1% | 0% | 12.5% | +193% |
| 8,000 | stamped 5m | $0.1659 | 27.5% | 0% | 6.6% | +61% |
| 25,000 | unstamped | $1.2296 | 77.3% | 52.5% | 18.5% | +603% |
| 25,000 | stamped 5m | $0.2628 | 54.2% | 36.9% | 13.0% | +192% |

How to read the table:
- **Net of caching:** caching removes **85.0%** of the "re-billed every turn" cost in every case. It is 85% rather than 90% because of the one-time 1.25x write premium. On stamped traffic the dynamic-filtering prize at S=8,000 is $0.011 per conversation on Sonnet, and it turns negative once the filtering code adds more than about 61% to the search turns' output.
- **Basis of the remedy columns:** the 24% figure is a literature claim. The output band is reasoned, because no source publishes it. The cap column is lossy truncation.
- **Ledger understatement (derived):** $0.01 per search event. A loop with 6 searches had its true spend understated by 26.6% on stamped Sonnet at S=8,000 ($0.06 against a $0.1659 token bill), 15.3% on stamped Opus, and 9.3% / 4.9% unstamped. With 20 searches the figures are 54.7% / 37.6% stamped.
- **Meter (measured):** the request bytes are identical before and after metering (89,718 bytes). The final-turn share is about 83% (local estimate). The advice codes fire as designed on Sonnet versus Opus.

## Verdict

netSavingPct = **0**: FLUX bills nothing for the audit, and the meter only advises. This is a completeness fix: the ledger now matches the provider bill, and the gap it closes is large (5-55% of a research loop's spend). It is not a saving. The lossy remedies' savings (2.5-37%) belong to the customer if they adopt them, not to FLUX, and are not billable without the replay gate.

## Caveats

- The fixture is synthetic: turn count, spacing, message sizes and searches per turn are reasoned, not taken from captured traffic.
- `encrypted_content` hides the restored size of a search result on the wire, so the meter's token figures are local estimates.
- The 24% figure is an average over two benchmarks on 4.6-generation models, not per model and not on 5.5-generation models.
- In-turn search iterations are modelled as one request. How the provider caches mid-turn iterations is not documented.
- `max_content_tokens` does not apply to PDFs or to web_search results.
- Managed Agents does not expose `max_uses`.

## Next

- Measure the dynamic-filtering output band on real Sonnet 5.5 traffic through the replay gate.
- Get a real research-agent capture (Managed Agents or LangGraph deep-research) to replace the synthetic fixture.
- Surface `summarizeServerToolFees` in `renderLedgerReport` so customers see the line item.
- Track code-execution container hours if a usage field for them appears.
