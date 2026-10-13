# FLUX pilot runbook (one page)

**What FLUX is.** An SDK wrapper that reduces LLM spend with cache-safe token
reduction, prompt-cache placement, and execution-tier arbitrage — and bills 25%
of *verified* savings. Verified means: measured per completed task from
provider-reported usage, quality held by a gated replay, recorded in an
append-only hash-chained ledger you can recompute to the cent on your own
machine. If FLUX saves you nothing, the verdict is **do_not_charge** and the
invoice is $0.

**What the pilot costs you.** One file export, one wrapper line, two weeks of
normal traffic. No infrastructure change, no proxy in your request path, no
data leaves your machines (see [data-handling.md](./data-handling.md)).

---

## Day 0 — the quote (30 minutes, your machine, read-only)

1. Export spend logs from your gateway (LiteLLM `/spend/logs`, Helicone
   requests, or Langfuse generations — JSON).
2. `npx flux-quote <export-file> --format litellm` (runs locally, no network).
3. Read the quote: each traffic stream classified into a segment
   (consumer / app-layer / in-house-agent / already-optimised), an honest band
   per stream citing the measurement it is an analogue of, your own gateway and
   provider-cache savings **credited to you and excluded**, unpriced models
   reported as unpriced (never zeroed), and — when true — the explicit
   **"do not pay us"** answer.

If the quote says FLUX is not worth it on your traffic, the pilot ends here and
that is the correct outcome.

## Day 1 — install (five minutes, cannot break your app)

1. `npm install` the FLUX SDK tarball.
2. Wrap your client: `withFlux(openai)` — OpenAI Responses, Chat Completions,
   and Anthropic `messages.create` all go through one shared handler.
3. Ledger on: billable events (token counts and hashes only, never prompt
   content) append to a local file. The ledger is opt-in and try/caught — a
   ledger failure can never throw into your request path.

Only lossless levers run by default (schema compaction, duplicate removal,
cache-prefix repair, output caps). Lossy levers stay off until step 3.

## Days 2–13 — measure

- FLUX records provider-verbatim usage per request; failed tasks void all their
  turns; savings you already had (provider cache on appended history, gateway
  cache hits) are recorded and never billed.
- Optional: run the replay gate on a sample of your traffic. A lossy lever
  (e.g. fresh tool-result capping) bills **only** with an approved replay-gate
  verdict; a changed tool call is a hard zero.
- Latency-tolerant workloads you flag get tier arbitrage (OpenAI flex /
  batch, 50% off list, zero quality mechanism involved).

## Day 14 — the invoice you can check

1. `recomputeInvoice(events, catalogue)` — a pure function over your own event
   file and a content-hashed, dated, sourced price catalogue. Byte-identical
   across runs; tampering with any event is detected and the position named.
2. Negative components **net against FLUX** (e.g. a 1h cache-write surcharge
   that never earned its reads), never clamped.
3. Invoice = 25% of the net verified savings for the period, or
   **do_not_charge**.

---

## What FLUX never does in a pilot

- Never proxies or stores your prompts; never sends your data anywhere
  (the metering sink itself is local and network-free).
- Never bills from its own token estimates — provider-reported usage only.
- Never claims savings your gateway or the provider's default caching already
  gave you.
- Never quotes a number without its measured / simulator-measured / projected
  label and segment caveat.

## What a pilot partner should expect, numerically

Bands from the quotable matrix in [README.md](./README.md) — e.g. interactive
agents 26.0–29.4% (measured, synthetic harness), async-tolerant 64.3%
(measured, OpenAI-priced), one-shot 45.5% (measured). These are harness
numbers against synthetic traffic: **your** number comes from your export on
day 0 and your ledger on day 14, and only the day-14 number is ever billed.
