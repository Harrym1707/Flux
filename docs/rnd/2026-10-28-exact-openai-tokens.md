# 2026-10-28 — Exact OpenAI token counts, and how wrong the old counter was

Branch `rnd/2026-10-28-exact-openai-tokens`. Substrate work for lever-backlog
P6. Nothing here is a saving; it changes how FLUX *estimates* tokens on OpenAI
traffic. Billing semantics are unchanged: provider-verbatim usage still wins
wherever it exists, and the ledger event schema is untouched.

## What changed

- **`packages/core/src/openai-tokenizer.ts`** (new). Exact counting with
  `js-tiktoken@1.0.21` (MIT, pinned exactly; published 2025-08-09; its only
  dependency is `base64-js@1.5.1`; no network code).
  - `openAIEncodingForModel(id)`: `o200k_base` for gpt-4o / chatgpt-4o /
    gpt-4.1 / gpt-4.5 / gpt-5 (and `gpt-5-*`) / o1 / o3 / o4-mini;
    `cl100k_base` for gpt-4 (incl. turbo/32k), gpt-3.5-turbo, gpt-35-turbo,
    text-embedding-ada-002 / 3-small / 3-large. Handles dated snapshots,
    `ft:` fine-tunes and an `openai/` or `azure/` prefix. Every other id
    returns undefined. That includes Claude, `gpt-5.x` point releases,
    `gpt-6-*`, gpt-oss and other routing prefixes. The pinned tiktoken
    table does not name them, and assuming o200k for them would be a guess
    labelled as exact.
  - `tokenCounterForModel(id)` returns `{ countTokens, basis }` with basis
    `exact:o200k_base` | `exact:cl100k_base` | `approximate`. Unknown and
    Claude ids get the existing `approximateTokenCount`, labelled
    `approximate`.
  - Lazy and fail-open. js-tiktoken and its rank table are `require`d on
    the first exact count only. Picking a counter does not load them, and
    neither do Claude or unknown ids. The built encoder is cached for the
    life of the process. If js-tiktoken cannot be resolved, the basis is
    `approximate` and requests never fail. The bundled SDK artifact is
    dependency-free, so it falls back to `approximate`. It becomes exact
    when `js-tiktoken` is installed next to it. Both ESM and CJS builds were
    checked each way.
  - Hot-path guards:
    - js-tiktoken's BPE merge is quadratic in one pre-token's length.
      Measured: a 512-char unbroken run takes ~27 ms, 4,096 chars ~2 s and
      20,000 chars ~60 s. Pre-tokens over 128 chars are therefore counted
      in 128-char chunks, which is linear. Only that run can deviate, and
      the test bounds it at ≤8 tokens for a 1,000-char run. A cheap
      prefilter skips the pre-token walk for ordinary text.
    - Strings of 512 chars or more are memoised, bounded by 4M characters
      held in total.
- **Wired in** (default only when the caller passes no `countTokens`):
  - `reduceRequest` / `reduceRequestAsync` / `compactStaleContext`
    (`packages/sdk-js`): the request's own `model` picks the counter. This
    covers the proxy, `withFlux` and the replay gate. OpenAI-side
    decisions now use exact counts: the fresh-result cap threshold,
    description truncation to N tokens, history compaction sizing and the
    estimated-token figures that size `estimated-baseline` levers.
    `FluxReductionSummary.tokenCounter` records the basis. Anthropic
    requests (cache-minimum guard included) are byte-for-byte unchanged.
  - `measureTraffic` (`packages/core/src/traffic.ts`, behind triage and
    quotes): each (workload, provider, model) group is counted with its
    model's counter.
  - `simulateCache`: a new optional `model` option. With no counter and no
    model it behaves exactly as before.
- **`evals/run-tokenizer-calibration.ts`** (new; `pnpm tokenizer:calibrate`).
- Tests: `packages/core/src/openai-tokenizer.test.ts` (12) and a
  model-aware block in `packages/sdk-js/src/reduce-request.test.ts` (4).
  They cover exact counts on known strings (the tiktoken README's o200k
  `hello world` = `[24912, 2375]`, cl100k `[15339, 1917]`, the cookbook's
  6-token `tiktoken is great!`), the model→encoding mapping including
  look-alikes, unknown-id fallback, lazy loading on a fresh module
  instance, the long-run bound, and an OpenAI vs Claude cap decision on the
  same body. 433 → 449 tests, all green. No existing test was edited.

## Measured bias: `approximateTokenCount` vs exact o200k_base

`node --import tsx evals/run-tokenizer-calibration.ts`, run on this branch
(real output). FLUX-owned committed text only. Signed error is
(approx − exact) / exact, so **+ means the approximation overcounts**.
"aggregate" is token-weighted.

| class | n | chars | exact o200k | approx | aggregate err | median | p10 | p90 | err vs cl100k | ceil(len/4) err | chars/token |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| prose: wire-capture prompts | 26 | 167207 | 32124 | 50104 | +56.0% | +21.4% | +10.7% | +56.3% | +51.0% | +30.2% | 5.21 |
| prose: agent fixture (preamble + tool results) | 201 | 1121964 | 201911 | 308716 | +52.9% | +52.8% | +52.7% | +53.0% | +50.2% | +39.0% | 5.56 |
| prose: markdown docs | 66 | 525834 | 132239 | 175191 | +32.5% | +32.8% | +24.3% | +56.5% | +32.0% | -0.6% | 3.98 |
| JSON: tool schemas | 5 | 4639 | 998 | 1585 | +58.8% | +65.8% | +57.9% | +72.4% | +62.6% | +16.4% | 4.65 |
| JSON: request bodies (captures) | 23 | 311793 | 62488 | 92530 | +48.1% | +48.1% | +44.9% | +54.3% | +44.1% | +24.8% | 4.99 |
| JSON: other committed fixtures | 9 | 42534 | 16266 | 15984 | -1.7% | +12.9% | -9.9% | +39.5% | -1.9% | -34.6% | 2.61 |
| code: TypeScript sources | 46 | 501074 | 119407 | 162775 | +36.3% | +38.4% | +30.8% | +47.1% | +35.4% | +4.9% | 4.20 |
| code: Python | 2 | 19788 | 5033 | 6710 | +33.3% | +32.0% | +30.5% | +33.5% | +33.9% | -1.7% | 3.93 |

The bounded hot-path counter agreed with js-tiktoken's unbounded encoder on
every sample (0 mismatches).

What this says:

- Against OpenAI's tokenizer, the shipped counter **overcounts everything
  except number-heavy JSON**, by about +33% to +59% aggregate. The backlog
  P6 shape (prose +28%, JSON −13%) does not hold for OpenAI. JSON tool
  schemas and request bodies are the worst classes, at +59% and +48%. The
  cause is the per-word `ceil(len/4.5)`: a 5–9 letter word counts as 2,
  where o200k usually spends 1. Each punctuation run counts at least 1, and
  JSON is full of `":"` and `","`.
- The P6 figures were measured against Claude (`count_tokens`) and, per
  the backlog's own adversarial note (5), likely on `ceil(len/4)` rather
  than the shipped word-run counter. They are not comparable to this
  table, and this table says nothing about Claude.
- `ceil(len/4)` would be closer to o200k than the shipped counter on docs
  and code (about ±5%). It still overcounts prompts (+30–39%) and
  undercounts number-heavy JSON (−35%). For OpenAI the exact counter
  replaces both.

## Published numbers that depend on OpenAI token estimates (NOT edited)

None of the LIVE numbers move. The 18.2% and its per-agent split are
Anthropic traffic, and Anthropic counting is unchanged. The Anthropic-shaped
simulator rows also do not move: arm L 34.3%, arm M 37.9% / 57.3%, and
`run-cache-decomposition.ts`. The replay-gate figures re-ran unchanged: fresh
cap approved at 0.00 pp, and J rejected at a −5.50 pp lower bound.

The OpenAI-shaped `gpt-5` agent fixture in `evals/run-agent-ab.ts` *does*
depend on OpenAI token estimates. It enters in two ways:

1. through `reduceRequest`, which this branch changes (the "shipped" column
   below is `run-agent-ab.ts` re-run on this branch as committed); and
2. through the script's own explicit `simulateCache(..., { countTokens:
   approximateTokenCount })`, which prices every call. The eval scripts are
   not edited. The "fully exact" column is a scratch run (not committed)
   that swapped only those four `gpt-5`-fixture simulator calls to the
   exact o200k counter.

| Published figure (where) | Published | Shipped (this branch) | Fully exact (o200k) |
|---|---:|---:|---:|
| Async arm K net (README, NUMBERS, site) | 57.7% | 57.6% | 55.2% |
| Async arm K ceiling | 64.3% | 64.2% | 62.3% |
| One-shot arm H ($0.569 → $0.310) | 45.5% | 44.5% ($0.316) | 35.0% ($0.451 → $0.293) |
| One-shot arm I | 72.8% | 72.2% ($0.158) | 67.4% ($0.147) |
| Busy interactive arm J band (openai-30s / openai-600s / anthropic-5m-30s / anthropic-5m-600s) | 25.9–29.4% | 25.6–29.3% | 22.4–24.7% |
| README "busy / sparse" 25.9% / 34.3% | 25.9% / 34.3% | 25.6% / 34.3% | 22.4% / 34.3% |
| "Simulator 25–73%" (NUMBERS, faq) | 25–73% | ~26–72% | ~22–67% |
| Provider cache's own saving, reference 35–40% (39.7% @30s / 35.4% @600s) | 35–40% | unchanged | 31.4% / 27.9% |
| J@1h vs A@5m policy-applied row (evidence, beside arm L) | 34.5% | 34.2% | 28.6% |

Caveats on this table:

- The two anthropic-5m J rows and the J@1h row run the **gpt-5 fixture,
  priced at gpt-5 rates**, under Anthropic cache rules. o200k is that
  fixture's tokenizer, but the scenario itself is mixed.
- The 34.3% sparse figure is arm L, which is Claude-shaped, so it does not
  move.

**Traffic analyser gates** (`evals/run-analysis-regression.ts`, part of the
"27/27" the evidence page cites). The `gpt-5` agent fixture's projected
saving falls from 50.9% to 36.9%, and risk-free from 30.2% to 22.8% (with
repair, 42.1% → 30.6%). The two size gates now **fail**: "agent clears 25%
risk-free as-is" and "agent clears 35% risk-free with repair". The suites
therefore read **25/27**. The other 8 regression gates and all 17 triage
gates pass. The cause is that the analyser prices counted prompt tokens
against verbatim usage totals, so the counter's overcount went straight
into the projected share. The gates are left as they are. Whether the
fixture or the bar should change is a decision, not something to relax
quietly.

## Caveats

- **Exact for a string, not for a request.** OpenAI adds per-message
  framing tokens and renders tool schemas into its own internal format, so
  exact counts of `JSON.stringify(...)` are still not billed
  `prompt_tokens`. They are much closer than the approximation, but billing
  and realised savings still come only from provider-verbatim usage.
- **Model coverage is deliberately narrow.** `gpt-5.2`, `gpt-5.4`,
  `gpt-5.5` and `gpt-6-*` stay `approximate` until a published tiktoken
  table names them. Most of the current catalogue's OpenAI models therefore
  still run on the approximation. A deployment can pass its own
  `countTokens`.
- **Cold start.** The first exact count in a process parses o200k_base,
  which took ~1.1 s here. Warm, `reduceRequest` on the ~26 KB gpt-5 agent
  request went from p50 6.6 ms / p95 11–12 ms (approximate) to p50 11 ms /
  p95 17–26 ms (exact) on this container.
- **Long-run chunking.** Unbroken pre-tokens over 128 chars (a run of one
  character, DNA, padding) are counted in chunks, so they are not
  guaranteed exact. None occurred in the calibration corpus.
- **Fixture weight.** The corpus is small (5 distinct tool catalogues, 26
  capture prompts), and the agent-fixture prose is one repetitive template.
  It is kept as its own row so it cannot swamp the capture prompts.
- **Not done here (P6 follow-ups):**
  - stamping the counter basis into ledger `estimatedReduction` (P6
    adversarial 6; it would change the ledger event schema);
  - switching `run-agent-ab.ts`'s simulator to the exact counter (it would
    move the published simulator numbers above, so it needs a deliberate
    re-publish);
  - Claude calibration against `count_tokens`.
