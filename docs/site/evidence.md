# Evidence — every published number, traced

Each figure on this site maps to the command that produces it and the commit it
was verified at. Reproduce any of them from the repo root. (Numbers were
independently re-verified by a checker separate from the implementer at each
listed commit; the harness run prints every row below.)

Harness: `node --import tsx evals/run-agent-ab.ts` · tests:
`./node_modules/.bin/vitest run` (320 passing) · gates: the three suites under
`evals/run-*-triage.ts` and `evals/run-analysis-regression.ts` against freshly
generated fixtures (27/27).

| Published figure | Where it comes from | Verified at |
|---|---|---|
| Async 64.3% ceiling / **57.7% net** (quote the net) | arm K rows, async-eligible segment: ceiling assumes 0% tier fallback; net assumes 10% default + 5% 429-retry, priced per event at the SERVED tier | `4e51734` |
| Interactive 25.9–29.4% | arm J across openai-30s / openai-600s / anthropic-5m blocks, clean 38/40 | `c7b03d4`, re-verified `4e51734` |
| Proxy mode: zero-code integration | `packages/sdk-js/src/proxy.ts` + `evals/run-proxy.ts`; e2e tests cover reduction-before-forward, byte-identical passthrough, SSE streaming with usage parsed after the last byte, per-app hash chains, credential passthrough | `pending` |
| Multi-turn Claude agents, previously uncached: 57.1% | arm M: the full lossless+capped stack plus a FLUX-placed 5m cache stamp vs the UNCACHED baseline the live export confirmed (Anthropic's cache is opt-in); 96% hit rate, clean 38/40; stamp verified metadata-only on all 200 requests | `6249f86` |
| Sparse interactive 34.0% | arm L, 1h cache TTL via the shipped `cacheTtl` stamp (stable-prefix placement), 600s spacing | `67eeac6` (re-verified after the placement fix `ec191c5`; was 34.0% at `cbbffb9`) |
| First real-traffic export: 9–25% measured per agent | `evals/run-live-agents.ts`, 30 requests on claude-sonnet-5-5, hash-chained spools audited; a smoke run, NOT a band — lossy levers recorded-unbilled pending gate verdicts | `d84e256` run 2026-10-19 |
| One-shot 45.5% / 72.8% | one-shot section, arms H and I ($0.569 → $0.310 / $0.155) | `7b08666`, re-verified `4e51734` |
| Provider cache's own 35–40% (never claimed by FLUX) | "what the cache itself is worth" section of the harness output | `33028df` onward |
| "Do not pay us" 0–5% | support-assistant fixture, 77% pre-cached, triage verdict | `ff04a70` |
| Replay gate approving fresh-cap at 0.00 quality delta and rejecting the 2000-token output cap at −5.50pp | `evals/run-replay-gate-freshcap.ts` | `ab5b4c7` |
| Ledger determinism, exclusions, recomputable invoice | `packages/core/src/savings-ledger.test.ts`; canonical-invoice contract | `597e842`, `10407bf` |

## Open items (also stated wherever the affected number appears)

- Per-model cacheable minimums not yet simulated → 34.0% may overstate on some
  models.
- Anthropic batch rate uncatalogued → async figures OpenAI-priced; Anthropic
  batch events are correctly *unpriced*, never zeroed.
- Package freshness gate and automated CJS smoke not yet in the build script
  (the CJS tarball was smoke-tested manually at `4e51734`).
- **The banded figures are simulator-measured.** A first real-traffic export
  exists (30 requests, see the table) and found one lever losing money on
  one-shot traffic — fixed at `ec191c5` and re-verified. The bands stay
  simulator-labelled until a pilot-scale export replaces them.

## Independent sources cited on the comparison page

- codepointer.dev — 614M-token replay of rtk/headroom/caveman: 3.7% actual.
- archestra.ai — progressive disclosure: ~77% modelled vs ~13% measured.
- RouterArena (arXiv:2510.00202) — independent router leaderboard.
- Anthropic & OpenAI published pricing pages — all rates in
  `packages/core/src/model-prices.ts` carry source URL and capture date.
