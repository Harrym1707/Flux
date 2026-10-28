# FLUX savings numbers — the single source of truth

One rule: **never quote a savings number without saying which of these it is.**
LIVE = measured on real API traffic, real money. SIMULATOR = modelled on a
harness, labelled as such, NOT yet proven on anyone's real bill. If a number
isn't in this table, it isn't a FLUX number — don't state it.

Last reconciled: 2026-10-27.

## LIVE numbers (real API traffic — this is what actually happened)

| Number | What it measures | Command / commit | Status |
|---|---|---|---|
| **18.2%** | Net savings on a mixed 30-request basket (coding/rag/support/batch/lean), claude-sonnet-5-5. $0.0365 saved of $0.2010 spent. | `FLUX_LIVE_KEEP=1 evals/run-live-agents.ts`, run 2026-10-26, spools in `evals/live-exports-2026-10-26/` | **CURRENT headline live number** |
| 18.0% | Same basket, run 2026-10-19 | `evals/run-live-agents.ts` | superseded by 18.2% |
| 9.3% | First live smoke run; old cache placement lost money | `d84e256` | superseded |

Per-agent inside the 18.2% basket: coding **38.1%**, rag **22.0%**, support
**10.3%**, batch **0%** (correctly suppressed), already-lean **0%** (correct).

## SIMULATOR numbers (modelled, labelled, NOT live-proven)

| Number | What it measures | Command / commit |
|---|---|---|
| 57.7% net (64.3% ceiling) | Async/batch-eligible workload, served-tier priced | arm K, `4e51734` |
| 45.5% / 72.8% | One-shot templated traffic (two arms) | arms H/I, `7b08666` |
| 37.9% | Multi-turn Claude cache lever ALONE vs cache-off | `evals/run-cache-decomposition.ts`, `6f08b72` |
| 57.3% | Full lossless+cache stack vs raw uncached (−5pp quality cost) | same script |
| 34.3% | Sparse interactive, 1h TTL | arm L, `6f08b72` |
| 25.9–29.4% | Busy interactive agents | arm J, `4e51734` |

## Reference numbers (not FLUX savings — context only)

| Number | What it is |
|---|---|
| 35–40% | The provider's OWN cache saving — FLUX never claims this |
| 0–5% | "Do not pay us" — already-optimised stacks |

## How to answer "how much does FLUX save?"
> "On real traffic, our one measured number is **18.2%** on a mixed basket.
> Simulator models suggest 25–73% depending on workload, but those aren't
> proven on a real bill yet. Your pilot replaces all of it with your own number."

Always lead with the live 18.2% and label the rest simulator. Update this file
when a new live export runs; quote from here, verbatim.
