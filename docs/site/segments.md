# What FLUX saves, segment by segment

Savings are a property of your workload's shape. One global percentage would be
a lie to someone; these are the four shapes, each with its mechanism, its
measured band, and what would change the number. All figures simulator-measured
per [methodology](methodology.md); traceability in [evidence](evidence.md).

## Background / batch / latency-tolerant work — 57.7% net (64.3% ceiling)

**Mechanism:** your provider sells the same model at 50% off for work that can
wait (OpenAI's flex service tier on a synchronous API; Anthropic's batches,
which stack with prompt caching). FLUX applies the tier only to traffic you
flag latency-tolerant, stacks it with every token lever below, and bills from
the tier the provider *actually served* — bounced requests bill at full rate.
**The number to use is 57.7%** (net of assumed 10% default-fallback + 5% retry
rates); 64.3% is the zero-fallback ceiling. Quality: identical model, identical
answers; 38/40 clean on the harness.
**What changes it:** your real fallback rate (telemetry replaces the
assumption), and Anthropic-side pricing once its batch rate is catalogued.

## One-shot API traffic on a shared template — 45.5%, up to 72.8%

**Mechanism:** the most common silent waste we model: a per-request value (a
timestamp, a request id) at the top of an otherwise identical prompt, which
disables provider caching entirely. FLUX relocates it, the prefix caches at
one-tenth price, and schema/duplicate levers stack on top. Add the tier for
latency-tolerant one-shots and the band reaches 72.8%.
**What changes it:** how big your shared template is and whether a breaker is
actually present — the five-minute quote measures both from your export.

## Interactive agents — 25.9–29.4% busy, 34.0% sparse

**Mechanism:** busy agent traffic is already heavily subsidised by the
provider's cache (35–40% on its own, which we never claim), so FLUX's honest
headroom is the *fresh* tokens: oversized tool results are capped at injection
(headlines, errors and file paths preserved verbatim; the replay gate approved
this lever at exactly zero quality delta), stale history is compacted
byte-stably, schemas are slimmed. Sparse traffic adds the 1-hour cache TTL
(2× write premium billed honestly, netted when negative) for 34.0%.
**What changes it:** how oversized your tool results actually are (our fixture's
are highly compressible; your yield scales with yours), and the pending
per-model cache-minimum fix, which may lower the sparse figure on some models.
**On Claude the ceiling is different — and higher.** Anthropic's prompt
cache is opt-in, and agents that never place `cache_control` re-pay full
rate for their whole conversation history every turn (our first live export
measured exactly that: a five-turn agent with zero cache traffic). FLUX
stamps the stable prefix with a 5-minute-TTL breakpoint and the measured
band is **57.1%** against that uncached baseline (simulator-measured,
96% cache hits, quality unchanged — the stamp is metadata-only). If you
already place your own breakpoints, FLUX defers and never claims this.
**This is also where we tell you our ceiling:** if someone promises an
interactive agent 70%, ask for their per-task evidence.

## Already-optimised stacks — 0–5%: do not pay us

**Mechanism:** none, and that is the point. If your input already arrives
largely cached, or your gateway's response cache already answers a big share of
requests, FLUX's triage says so and the quote's verdict is `doNotPayUs`. On our
fixture of such a stack the addressable saving was 2.4%. A percentage-of-savings
vendor that charges you for savings you already had is buying a dispute; we
decline up front.
