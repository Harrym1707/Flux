# FAQ — built from the caveats we already print

**How do I install FLUX?**
One command: `npx -y -p @flux-ai/sdk flux-proxy` starts a local proxy with a
hash-chained ledger — then set your client's `baseURL` to
`http://127.0.0.1:8787` (Anthropic) or `http://127.0.0.1:8787/v1` (OpenAI).
No signup, no account, and your API key passes through without being stored.
The full walk-through, including recomputing the invoice yourself, is on
[Get started](start.md).

**Does FLUX work with my language or framework?**
Yes, if it can set a base URL — which is Python, TypeScript, Go, curl,
LangChain, LlamaIndex, and effectively everything else. Proxy mode is
language-agnostic by construction; the one-line SDK mode (`withFlux(client)`)
is TypeScript/JavaScript today. It covers Claude (Anthropic), OpenAI, and any
OpenAI-compatible endpoint.

**My agents run 24/7 — what does FLUX actually do for always-on workloads?**
Long-lived agents re-send their whole history every turn, so they re-buy
their own memory forever — on real agent traffic, each output token gets
re-read ~27 more times downstream. FLUX keeps that history on the provider's
cached rate (with guards that refuse placements that would lose money),
digests stale context byte-stably, caps oversized tool results behind a
quality gate, flags byte-identical retries, and meters output re-emission on
your statement. The measured always-on shapes are our strongest bands: see
[savings by segment](segments.md).

**Can FLUX break my app?**
The default levers are lossless: compacted schemas decode identically, removed
duplicates are exact, prefix repair reorders text without deleting it, and the
reducer never throws — any failure returns your request untouched. Lossy levers
(output caps, description trimming, tool-result capping) are off until a replay
gate proves on your own recorded requests that quality held.

**Why do you quote me a range and not one number?**
Because savings depend on your traffic's shape. The quote comes from your own
export and names your segment; a vendor quoting everyone one number is wrong
for most of them. Sometimes our verdict is literally `doNotPayUs`.

**Is 57.7% (async) real?**
It is a faithful measurement of a realistic simulation at providers' published
prices, net of assumed discount-tier fallback rates, with quality held at 38/40
clean tasks — and it is labelled simulator-measured everywhere it appears. Your
pilot replaces it with your own number before any fee exists.

**You're billing a counterfactual — how is that dispute-proof?**
The same way energy performance contracts have done it since 1995: a defined
baseline, provider-verbatim measurements, and an adjustment method agreed in
advance. Concretely: every request writes an append-only hash-chained event;
the invoice is a pure function over those events; you can re-run it and must
get our number. Savings you already had are itemised and excluded. Negative
savings (e.g. a cache-write premium that didn't pay off) reduce the bill —
they are never clamped to zero.

**Do I have to change my code?**
One line or none. SDK mode wraps your existing client (`withFlux(client)`).
Proxy mode needs no code at all: run the FLUX proxy locally and point your
client's `base_url` at it — your API key passes through verbatim (FLUX never
holds credentials), responses stream back untouched, and every request
appends the same hash-chained ledger event the SDK writes. A stream whose
usage cannot be read is recorded *unpriced*, never guessed.

**What do you do with my prompts?**
Analysis runs locally; prompts never leave your machine. The ledger records
usage numbers, lever names, hashes and verdict references — not prompt text.
One optional exception you control: the SDK can POST usage metadata (never
prompt text) to an endpoint **you configure yourself**; it is off unless you
set it. Full detail: [data handling](../pilot/data-handling.md).

**What if the provider changes prices?**
The price catalogue is dated and source-linked. A new rate is a new dated
entry; history is never silently repriced, and an uncovered date is "unpriced",
which excludes the row rather than guessing.

**What does it cost?**
1% of verified savings, monthly — nothing else. No subscription, no seats,
no minimum. A month that saved nothing bills nothing, and negative lever
months count against us.

**What's the catch?**
Three, published: busy interactive agents cap around 29% because the provider's
cache already does the heavy lifting; the 34.3% sparse figure awaits a
per-model cache-minimum correction and may come down for some models; Anthropic
batch pricing isn't catalogued yet, so the async figure is OpenAI-priced today.
When a number moves for honesty reasons, this site moves with it — the async
headline already went from 64.3% to 57.7% that way.
