# FLUX — verified LLM cost reduction, billed only on savings you can recompute

FLUX is a drop-in wrapper for your OpenAI or Anthropic client that reduces what
you spend per completed task — and proves it. You pay a percentage of verified
savings. If your traffic is already optimised, FLUX tells you not to pay us.

## What FLUX saves, by traffic type

Every figure below is measured per completed task with quality held (at least
36 of 40 tasks fully correct and complete), on a simulated harness using each
provider's published prices and cache rules. No real-traffic claims are made
until your own pilot measures them. [How these numbers are made →](methodology.md)

| Your traffic looks like | Measured saving | Label |
|---|---:|---|
| Background / batch / latency-tolerant jobs | **57.7%** (net of assumed tier fallbacks; 64.3% ceiling) | simulator-measured |
| One-shot API calls on a shared template | **45.5%** — up to **72.8%** where latency-tolerant | simulator-measured |
| Interactive agents, sparse traffic | **34.0%** | simulator-measured, caveats apply |
| Interactive agents, busy traffic | **25.9–29.4%** | simulator-measured |
| Already-optimised stacks | **0–5% — do not pay us** | measured on fixtures |

The spread is the honest part: savings are a property of your workload's shape,
not of FLUX. The first thing FLUX does is tell you which row you are — from
your own logs, in about five minutes, before any contract exists.
[Get a quote from your own export →](../pilot/runbook.md)

## How it works, in one paragraph

Your bill is `tokens × price-per-token × execution tier`. FLUX attacks all
three at once: it removes tokens that carry no information (oversized tool
results capped at injection, exact duplicates, schema bloat) without ever
breaking your provider's prefix cache; it repairs prompts so cached pricing
(10× cheaper input) actually applies; and it routes traffic you flag as
latency-tolerant to the provider's own discounted tiers (50% off, same model,
same answer). Risky changes are enabled only after a replay gate proves, on
your own recorded requests, that quality held.

## Why you can trust the number on your invoice

- Savings are computed from your **provider's own reported usage**, never our estimates.
- Every request writes a **hash-chained ledger event**; your invoice is a pure
  function over those events that **you can recompute yourself**, to the cent.
- Savings you already had — your provider's cache, your gateway's cache — are
  itemised and **never billed**.
- A changed answer is a failed task, and **failed tasks void their savings**.

[Methodology](methodology.md) · [Per-segment detail](segments.md) ·
[Honest comparison with alternatives](comparison.md) · [FAQ](faq.md) ·
[Every number's provenance](evidence.md)
