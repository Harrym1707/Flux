# An honest comparison — including where FLUX loses

Most cost-saving tools publish their best number. Independent measurement keeps
finding a gap between claimed and delivered, so this page compares *methods*,
and includes the rows where we lose.

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
  gate that caught it.

## Method comparison

| | Typical trimmer / router | FLUX |
|---|---|---|
| Unit of measurement | per request | **per completed task** |
| Quality check | self-graded or none | replay gate on your recorded requests; failed tasks void savings |
| Cache economics | usually ignored (trimming can *raise* bills: one measured case cut tokens 38% and raised cost +6.8%) | simulated to provider rules; cache-safe levers only |
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
- **All current FLUX figures are simulator-measured.** The pilot exists to
  replace them with numbers from your own traffic before any fee applies.

## Not competitors: LiteLLM, Helicone, Langfuse

These are gateways and tracers — excellent at routing, logging and spend
tracking, and none of them performs token reduction or savings verification.
FLUX reads their exports directly: if you run any of them, you are one file
export away from a quote. [Runbook →](../pilot/runbook.md)
