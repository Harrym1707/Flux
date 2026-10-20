# Draft outreach 2 — Helicone user re-evaluating their stack

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team that adopted Helicone for LLM observability/cost tracking and
is deciding what to do next. **VERIFY BEFORE SENDING:** the "maintenance mode"
framing must be re-confirmed against Helicone's repo/announcements on the day
of sending; if it cannot be confirmed, use the alternate opening below.
Personalise the [bracketed] fields.

---

**Subject:** Your Helicone request data is still worth something

Hi [name],

With Helicone in maintenance mode, teams I've spoken to are deciding whether to
migrate observability — but the request logs you already have answer a more
valuable question first: *how much of your LLM bill is actually reducible?*

I built a local CLI that reads a Helicone request export (your file, your
machine, no upload) and produces a triage: each traffic stream classified by
shape, an honest savings band per stream, your existing cache savings credited
to you and excluded, unpriced models flagged rather than zeroed — and an
explicit "do not pay us" verdict when your traffic is already well-optimised.
It's a quote derived from your traffic, not a benchmark slide.

Two things it is **not**: it is not a gateway (nothing sits in your request
path; the SDK piece is a provider-client wrapper you can read in an afternoon),
and it is not a migration pitch (the quote is useful whatever you do about
observability).

Calibration from our harness (synthetic traffic, quality held per completed
task): interactive agents 26.0–29.4% **(measured)**, one-shot 45.5%
**(measured)**, latency-tolerant workloads on discounted execution tiers 64.3%
**(measured, OpenAI-priced)**. Segment bands, not promises — your export
produces your number, with every caveat printed in the report.

If you'd run it on one export and tell me where it's wrong, you'd be one of the
2–3 design partners I'm looking for. Five minutes, one JSON file out, full
methodology shared.

[sign-off]

P.S. Business model, stated up front: 1% of verified savings only — measured
from provider-reported usage into an append-only ledger whose invoice you can
recompute to the cent yourself, $0 when verified savings are $0. The quote is
free and stays on your machine regardless.

---

## Alternate opening (if maintenance-mode framing is not confirmable)

> Teams that invested in Helicone have months of request logs sitting in
> exports — and those logs answer a question observability dashboards don't:
> how much of the bill is actually reducible, stream by stream?

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Helicone "maintenance mode" | **UNVERIFIED in repo** — carried from sprint brief; re-verify on send day or use alternate opening | sprint-chain brief 2026-10-13 |
| 26.0–29.4% / 45.5% / 64.3% | measured | run-agent-ab.ts at 4e9e774; async figure OpenAI-priced only |
| "no upload, your machine" | code-enforced | quote-report.ts + packaged local bin, no network path |
| Helicone export parsing works | implemented, fixture-tested | packages/core/src/helicone.ts; gateway-triage gate 9/9 |
| 1% of verified savings / $0 verdict | implemented | savings-ledger.ts recomputeInvoice, do_not_charge verdict |
| 34.1% sparse-1h | omitted deliberately | simulator-measured only |
