# FLUX Sprint — Day 3 EOD (2026-10-13)

**Theme:** The savings meter and the installable package — append-only billable events with recomputable invoices, plus npm-pack-able SDK artifacts.
**HEAD:** d983e51 (3 commits: 597e842 savings ledger, 530244a packaging, d983e51 flux-quote). Manager grades: Research A / Eng A / Commercial A. Verifier: tsc green, 27/27 gates green, vitest 310/311 (one red test, see below).

## Floor and stretch status

Floor is 50%, stretch is 70%. All numbers below are **measured** (independent verifier, fresh run-agent-ab.ts matrix at d983e51) unless marked projected.

| Segment | Quality-held measured savings | vs floor (50%) | vs stretch (70%) |
|---|---|---|---|
| Interactive warm (arm J) | 26.0–29.4% (38/40, gate-approved fresh tool-result cap) | below | below |
| Interactive sparse + 1h TTL (arm L) | 34.1% — **simulator-only**, not billable/quotable for warm or one-shot | below | below |
| Async, caller-flagged flex (arm K) | **64.3%** (38/40 fully good, quality held) | **MET** | below |
| One-shot | 45.5% | below | below |
| One-shot async | **72.8%** | **MET** | **MET** |

- **Today's measured headline:** 64.3% async (arm K), 38/40 fully good, quality held — re-verified on a fresh matrix run after the ledger wiring.
- **Chain best:** 64.3% (set at cbbffb9, re-confirmed today at d983e51).
- **Delta vs yesterday:** 0.0pp (measured). Day 3 was a meter-and-packaging day by design; the job was to add billing and installability without moving the bands, and the bands held exactly (arm J 26.0/28.6/25.9/29.4, arm K 64.3, arm L 34.1). The rejected 2000-output-cap stays rejected at -5.50pp, not tuned away.

## What got better for the end user today

A design partner can now npm-install FLUX, record their own hash-chained billable events, and recompute their invoice to the cent on their own machine — including a do_not_charge verdict of $0 when FLUX saved them nothing — which is the first day the honesty apparatus is something a customer can hold in their hands.

## Research

Direction held end to end: the ledger is FLUX's own append-only system of record (Stripe demoted to a replaceable sink), the invoice is a pure function over (events, pinned content-hash catalogueVersion) that the customer runs themselves, and every honesty trap specified in the brief passed in code — negative per-request savings net on the bill instead of being clamped (measured: the 1h-TTL 2x write surcharge shows as a loss on sparse traffic), flex-429 fallback bills from the RESPONSE service_tier, failed tasks void all their turns, lossy levers bill only with approved replay-gate verdicts, and customer-owned gateway/provider cache value is excluded ($2.20 routed to excludedAlreadyOwned in the verifier's smoke, measured). The deduction from a clean A: the one red vitest is a self-contradictory determinism test committed in 597e842, and it exposes a real undecided contract — whether replay metadata (duplicatesIgnored) belongs inside the canonical customer-recomputable invoice body. Tomorrow: settle the canonical invoice schema (Orb/Metronome precedent), per-TTL cache-write evidence from usage.cache_creation, Stripe-sink projection spec, and the Anthropic/Chat Completions billing-block mapping for day 4.

## Engineering

Both commercial blockers from the status ranking (no meter, not installable) are closed, measured by the verifier not the builders: npm pack (40 files) installed into a fresh directory with CJS and ESM smokes both emitting and verifying a hash-chained ledger event; strict NodeNext consumer typecheck green; recomputeInvoice byte-identical across separate node runs and invariant under shuffle, doubled replay, and 25h-late redelivery; tamper at seq 1 detected with exit 1. npm publish provably never run (clean git status, no .npmrc, registry 404) per the hard rule. The ledger is opt-in, try/caught, and structurally unable to throw into the customer's request path. Blemish: 310/311 vitest — the determinism test asserts a doubled replay is byte-identical AND that duplicatesIgnored=3 appears in the same invoice JSON; every billing field is identical, so it is a test bug, not a billing defect, but the suite is not green and testsPassed was reported false rather than papered over. Builders declined five out-of-bounds asks correctly (billing from FLUX's own token estimates, inventing a TTL split, touching gate suites, wiring the harness, running their own verification). Tomorrow: fix the test by moving replay metadata out of the canonical body with a shape-freeze test, first end-to-end metered invoice from a real harness run, day-4 SDK surface.

## Commercial

The %-of-savings pricing story now has its structural artifact: recomputability to the cent from the customer's own event file is the answer to disputed baselines — the documented failure mode incumbents charging 20–30% have never solved; FLUX prices at 25% of verified savings. flux-quote (packaged bin, not a repo script) turns a LiteLLM/Helicone/Langfuse export into a shareable quote with bands, caveats, reconciliation, and DO NOT CHARGE verdicts, so the LiteLLM /spend/logs/v2 outreach email is now fully demo-backed. It is still in drafts — sending it is the single highest-leverage unblocked action and it is Harry's, not code. Standing constraints on all outreach: 34.1% only as simulator-only sparse-regime, 64.3% only for caller-flagged latency-tolerant traffic (provider-documented batch+caching stacking), no mention of the typosquat incident. Misses to carry: no explicit test yet for expired batch items (~6% real-world, projected) voiding savings, and no ledger file from a real harness run.

## Standing risks (unchanged)

- **Zero real traffic, day 3 of saying so.** Every number above is measured against fixtures/synthetic traffic; the fresh-cap yield scales with oversized-result share in real traces (fixtures ~96% compressible). One real LiteLLM export retires the biggest caveat on every band.
- Interactive warm (26.0–29.4% measured) remains well under the 50% floor for that segment; honest ceiling for the segment is ~35–45% (projected).
- Arm L's 34.1% stays unquotable and unbillable until the per-TTL cache-write split is evidenced from provider usage data.
