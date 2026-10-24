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
  numbers so far come from small runs (the latest: 18.0% of real spend across
  30 requests, receipt published line by line). The pilot exists to replace
  every number with ones from your own traffic before any fee applies.

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
net accounting, no counterfactual baseline, no customer-recomputable record,
and cache placement is not metered against the write premium it costs. Our
own live export showed exactly why that matters: placement without metering
lost money silently until the ledger caught it. If you want the levers, LiteLLM
ships good ones for free; if you need to *know what they saved, net, with the
receipt* — that is the product FLUX is.

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
