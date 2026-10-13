# FLUX Sprint — Day 5 EOD (2026-10-13)

**Theme:** The shop window, built from measured numbers only — GEO-ready website content as repo files, the finished pilot kit, and the carried engineering fixes that keep every published number honest.

## Floor and stretch

- **Floor (50%): MET** — async-eligible segment (arm K) clears it on both rows: ceiling 64.3% (measured, 0% fallback) and net 57.7% (measured, under an ASSUMED 10% default-fallback + 5% 429 rate), 38/40 fully-good tasks, 40/40 tool-ok, quality held, at HEAD 4e51734 (320/320 tests, 27/27 gates, full harness re-run, independently reproduced, not just builder-claimed).
- **Stretch (70%): NOT MET** on the chain's quality-held headline (async: 64.3% ceiling / 57.7% net, both under 70%). The one-shot-flex cell measures 72.8% (measured, quality held) but — consistent with day 4's framing — is not treated as the headline band.
- **Quality-held measured numbers per segment** (all measured in harness unless marked):
  - Interactive: 25.9–29.4% (arm J) — unchanged
  - One-shot: 45.5% / one-shot-flex: 72.8% — unchanged
  - Async-eligible: 64.3% ceiling (0% fallback) / 57.7% net (ASSUMED 10% default + 5% 429 fallback) — both new rows today, both clean 38/40
  - Sparse 1h-TTL: 34.1% (**simulator-measured**, arm L — per-model cacheable-minimums gap still open, real-traffic validation still open)
- **Today's measured number:** 57.7% net (the harness's own labeling: this is the figure to quote until real flex-traffic telemetry lands). The structural ceiling, 64.3%, reproduces unchanged from day 3/4.
- **Chain's best:** 64.3% (async ceiling, arm K, 38/40, quality held) — the figure the chain has carried as its headline since day 3.
- **Delta vs yesterday:** 0.0 pts on the headline/ceiling — byte-identical to day 3 (10407bf) and day 4 (4e9e774). The real change today is disclosure, not percentage: the chain now computes and prints a second, lower, fallback-adjusted number (57.7% net) that didn't exist as a distinct figure yesterday, 6.6 pts below the ceiling it had been quoting.

## What got better for the end user today

Nothing did — the served-tier-per-event pricing fix is real (it closes the hole that would have let FLUX overstate savings on a real customer's flex fallbacks or 429s), but FLUX still has zero real end-user traffic, and the one deliverable actually meant to reach a prospective customer today — the GEO-ready site that was day 5's named theme — did not ship, so no one outside the chain saw or received anything different.

## Research (grade: B)

Floor met and independently reproduced (not just taken on the builder's word): tsc clean, harness reproduces 64.3%/57.7% exactly, all other bands unchanged as claimed, pilot-kit numbers spot-checked and still trace correctly to commit 4e9e774. The integrity catch of the day was procedural, not numeric — flagging that the harness prints two async numbers and insisting 57.7% (net), not 64.3% (ceiling), is the one to quote externally. Miss: day 5's primary deliverable, docs/site/, does not exist anywhere in the repo or its history — confirmed by direct search. The "shop window" theme produced an engineering fix, not a shop window. Also carried, unmoved: per-model cacheable minimums still absent (flat 1024-token default everywhere), Anthropic batch rate still uncatalogued. Top tomorrow: build docs/site/ for real — comparison page citing codepointer.dev (3.7% actual vs 60–90% advertised) and archestra.ai (77% modelled vs 13% measured), entity.json rewritten off the day-4 measured matrix.

## Engineering (grade: B)

Shipped a genuine billing-honesty fix, commit 4e51734: `serviceTierOf()` hoisted into sdk-js/openai.ts (exported, re-exported from index.ts); arm K in evals/run-agent-ab.ts now prices every event at the tier actually served, not an assumed uniform flex discount — 429s produce zero billable events (proved via absent provider usage data) plus one standard-billed retry, with a request-path audit that aborts the run if any reduced request lacks `service_tier:flex` evidence. Result: ceiling 64.3% reproduces exactly; a new, more honest net figure of 57.7% sits alongside it under explicitly ASSUMED fallback rates. All other bands held unchanged; full suite regenerated clean (tsc, 320/320 vitest, 27/27 gates) plus a manual CJS smoke test (npm pack + require) confirming the tarball loads and exposes the expected surface. Misses, all carried and independently reverified today: no docs/site/ (zero lines shipped on the day's named theme); no per-model cache-minimum table; no Anthropic batch catalogue entry; build-sdk-package still has no freshness gate — live-tested again today, it silently packages stale dist/ output with no refusal, the exact install-embarrassment risk flagged before any tarball goes out. Top tomorrow: land the freshness gate and wire the CJS smoke test into an automated check so this can't regress silently again.

## Commercial (grade: B)

Goal met on a technicality the harness itself flags: the mechanically-best qualifying arm is the 64.3% ceiling, but the figure to actually quote is 57.7% net — commercial material going forward must use net, not ceiling. The pilot kit (docs/pilot/: README, runbook, data-handling answer, two outreach letters, engagement list) was checked number-by-number against 4e9e774 again today — every traced number correctly labeled measured/simulator-measured/sourced, only one cosmetic rounding looseness found (interactive printed as "26.0–29.4%" vs. the precise 25.9% low end), no untraceable number presented as measured. Misses: the GEO shop window didn't ship (confirmed by direct filesystem and git-log search — docs/site/ doesn't exist); content/entity.json still calls shipped levers "planned"; per-model cache minimums and Anthropic batch pricing are both still open, independently reconfirmed by grep today; the pkg/ build script still has no freshness gate, live-tested again today with the same silent-stale-bundle result. The single highest-leverage non-code action is unchanged from every prior day and still not done: Harry has not sent the LiteLLM outreach letter (docs/pilot/outreach-litellm.md), ideally directly to the #34801 reporter — the one action that would retire the zero-real-traffic caveat sitting on every published band.

---

*All percentages harness-measured at HEAD 4e51734 unless explicitly marked simulator-measured or ASSUMED; the async net figure's fallback rates (10% default-tier, 5% 429) are stated assumptions, not measurements, pending real flex traffic. No real end-user traffic exists yet.*
