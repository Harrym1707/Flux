# An honest comparison — including where FLUX loses

Most cost-saving tools publish their best number. Independent measurement keeps
finding a gap between claimed and delivered, so this page compares *methods*,
and includes the rows where we lose. Competitor facts below come from each
vendor's own documentation and pricing pages, checked 2026-10-22; if we have
something wrong, [tell us](https://github.com/Harrym1707/Flux/issues) and we
will correct it.

## The independent findings this market needs to answer

- Three popular open-source token trimmers (rtk, headroom, caveman), claiming
  60–90%, were independently replayed over a 614M-token corpus of real coding
  sessions: **3.7% combined actual saving** (codepointer.dev deep dive).
- Progressive disclosure of tool schemas, modelled at ~77% token savings,
  measured **~13% in production**, because the router it adds costs an extra
  round trip per novel tool call (archestra.ai bench). Per-request measurement
  cannot see this; per-task measurement can.
- The best-funded commercial router ranked **12th of 12** on the independent
  RouterArena leaderboard while advertising 30%+ savings.
- Our own history is on this page too: our first caching claim was 29%; our own
  per-task harness cut it to ~2% on busy agent traffic because the provider's
  cache was already doing the work. We published the correction and kept the
  gate that caught it. Later, our own ledger caught one of our levers *losing*
  money on live traffic (−$0.0063, a cache breakpoint over a volatile prefix);
  the loss billed against us, and the fix shipped with a test that prices both
  placements.

## Method comparison

| | Typical trimmer / router | FLUX |
|---|---|---|
| Unit of measurement | per request | **per completed task** |
| Quality check | self-graded or none | replay gate on your recorded requests; failed tasks void savings |
| Cache economics | usually ignored (trimming can *raise* bills: one measured case cut tokens 38% and raised cost +6.8%) | simulated to provider rules; a cross-turn volatility guard refuses to stamp prefixes that churn |
| Customer's existing savings | silently absorbed into the claim | itemised, excluded, never billed |
| Headline number | one global percentage | per-segment bands, including "do not pay us" |
| The invoice | trust us | hash-chained events; recompute it yourself |

## Where FLUX loses, stated plainly

- **Busy interactive agents: ~29% ceiling.** The provider's cache already
  delivers 35–40% there. Anyone promising such traffic 70% is claiming either
  the provider's savings or quality you will lose.
- **Already-optimised stacks: 0–5%.** Our triage will tell you not to buy.
- **A free trimmer may be all you need** if your waste is one obvious thing and
  you don't need the saving verified. FLUX's value is the *verified, billable*
  number; if you don't need that, rtk is free.
- **Most FLUX figures are simulator-measured and labelled so.** The live
  numbers so far come from small runs (the latest: 18.2% of real spend across
  30 requests, hash-chained spools committed to the repo so you can recompute
  it). The pilot exists to replace every number with ones from your own
  traffic before any fee applies.

## The comparison grid

Facts dated 2026-10-22 from each vendor's own documentation (the LiteLLM
volatility row is our own empirical test, wire captures published in the
repo). Blank praise sells nothing: each tool wins its own rows.

| | FLUX | LiteLLM | Helicone | Langfuse |
|---|---|---|---|---|
| What it is | Cost-reduction proxy with verified-savings billing | MIT gateway + SDK, 100+ providers | Observability platform + AI gateway | Observability, prompt mgmt, evals |
| Licence | BUSL-1.1 (verifier MIT) | MIT (enterprise carve-out) | Apache-2.0 | MIT except ee/ |
| Price | 1% of verified savings; $0 if nothing saved | $0 core; enterprise custom | Free tier; Pro $79/mo; Team $799/mo | Free tier; Core $29/mo; Ent $2,499/mo |
| Reduces request tokens | Yes — schema compaction, exact dedup, prefix repair (lossless, on every request) | Partially — MCP tool-schema deferral; compression via third-party sidecar | No | No (not in request path, by design) |
| Automatic Anthropic cache placement | Yes, with a cross-turn volatility guard and per-model minimum guard | Yes (one flag) — but stamps volatile prefixes verbatim every turn, no guard, no zero-read warning (our empirical test, v1.106.4) | No — customer writes their own cache_control | No |
| Response caching (identical repeats) | No | Yes (exact + semantic) | Yes (edge, exact-match) | No |
| Measures the saving | Yes — per lever, net of cache write premiums, per completed task | No | Cost tracking (best-effort on direct integrations) | Cost tracking (best-in-class auditability) |
| Customer-recomputable invoice | Yes — hash-chained ledger + MIT verifier; if your recompute disagrees, yours wins | No | No | Partially — exact-cost ingestion can match your provider invoice |
| Losses counted against the vendor | Yes — negatives never clamped, deficits carry forward | n/a (nothing measured) | n/a | n/a |
| "Do not pay us" verdict | Yes — literal output for already-optimised stacks | No | No | n/a (free tier exists) |
| Prompts leave your machine | Never — local proxy, analysis in-process | Self-hosted: no; their cloud: yes | Cloud-hosted path: yes | Yes (traces to their backend or your self-host) |

## Claimed vs independently measured — the market's problem in one table

| Tool / class | Claimed | Independently measured | Source |
|---|---|---|---|
| Three popular OSS token trimmers | 60–90% | **3.7%** combined, 614M-token real-traffic replay | codepointer.dev deep dive |
| Progressive tool-schema disclosure | ~77% modelled | **~13%** in production | archestra.ai bench |
| Best-funded commercial router | 30%+ | ranked **12th of 12** | RouterArena leaderboard |
| FLUX, per-workload bands | 26–81% by shape, simulator-measured and labelled | **18.2% live** on a deliberately mixed 30-request basket incl. two shapes designed to save ~0% (hash-chained spools committed to the repo; third consecutive live run) | our evidence page — every number traces to a command |

We publish the right-hand column for ourselves because we demand it of
everyone else. Your pilot replaces every FLUX number with your own traffic's
numbers before any fee exists.

## LiteLLM, Helicone, Langfuse — what each actually does about cost

These three are excellent tools we are often mentioned alongside. They solve
different problems, they are each genuinely better than FLUX at those
problems, and FLUX reads all three of their export formats directly — if you
run any of them, you are one file export away from a quote.
[Runbook →](../pilot/runbook.md)

### LiteLLM (MIT gateway + SDK)

Better than FLUX at: breadth (100+ providers behind one OpenAI-format API),
production routing (six load-balancing strategies, fallbacks, cooldowns,
budgets, virtual keys), community and maturity — and the core is free.

On cost specifically, as of 2026-10-22 it **does** have reduction levers:
one-flag automatic Anthropic `cache_control` placement (5-minute default,
1-hour option), MCP tool-schema deferral (collapsing tool catalogues to two
virtual tools), exact-match and semantic **response** caching, and prompt
compression via a third-party sidecar (Headroom). Spend tracking prices usage
against a community-maintained price map, with per-deployment overrides.

What it does not do: **measure or verify the saving.** There is no per-lever
net accounting, no counterfactual baseline, and no customer-recomputable
record. And placement without metering can lose money silently: we tested
LiteLLM 1.106.4's auto-placement empirically against a system prompt carrying
a per-turn timestamp — it stamped the changed block verbatim on every one of
six turns, with no stability check and no signal after six consecutive
zero-read responses (wire captures in our repo under evals/wire-captures/).
Under Anthropic's documented billing that traffic pays the 1.25× write
premium every turn and never reads — the exact loss our own ledger once
caught us making, which is why FLUX ships a volatility guard and nets every
cache write against its reads. If you want free levers, LiteLLM ships good
ones; if you need to *know what they saved, net, with the receipt* — that is
the product FLUX is.

### Helicone (Apache-2.0 observability + AI gateway)

Better than FLUX at: observability (dashboards, sessions, custom query
language, alerts), a hosted multi-provider gateway with unified billing, and
prompt management — a mature platform (Pro $79/mo, Team $799/mo, as of
2026-10-22).

On cost: its gateway's exact-match **response caching genuinely avoids
provider charges on byte-identical repeated requests** — credit where due —
but it does nothing for novel requests or growing agent contexts, which is
where agent spend lives. It does not reduce request tokens, and for
Anthropic's prompt cache the customer writes their own `cache_control`.
Cost figures on direct integrations are self-described best-effort estimates.

### Langfuse (MIT-except-ee observability)

Better than FLUX at: tracing and evals depth (agent graphs, LLM-as-judge,
datasets, experiments), team features, and — worth crediting plainly —
**cost-tracking auditability**: daily automated price audits against provider
sources, customer-overridable model prices, and exact-cost ingestion that can
make its numbers match your invoice (Cloud from $29/mo; unlimited MIT
self-host; as of 2026-10-22).

On cost reduction: none, by design — Langfuse is async observability and is
never in the request path, so it cannot compact, dedupe, place cache
breakpoints, or cache responses, and it does not claim to. It tells you where
the money went; FLUX changes what the next request costs and proves the
difference.
