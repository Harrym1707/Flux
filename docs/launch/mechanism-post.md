# How we verify LLM API savings with a ledger our customers can recompute

*(The newsletter/blog asset: the mechanism story TLDR-class newsletters and
Latent Space link to. Founder reviews, personalises the first-person voice,
and publishes — on the site as a page, or as the body of a pitch. Every number
is on the evidence page; add nothing that isn't.)*

---

Every LLM cost tool publishes a savings percentage. Almost none of them lets
you check it. That asymmetry is the whole problem: a savings claim is a
counterfactual — money you *would have* spent — and counterfactuals are where
marketing goes to lie. Independent replays keep finding the gap: trimmers
claiming 60–90% delivered a combined 3.7% on a 614M-token corpus of real
coding sessions; a modelled 77% schema saving measured 13% in production.

We build FLUX, a local proxy that cuts Claude/OpenAI request costs, and we
bill 1% of verified savings. Billing on a counterfactual forced us to solve
the verification problem for real, and the solution turned out to be the
interesting part of the product. Here is the whole mechanism.

## 1. The baseline must be deterministic, not estimated

FLUX reduces each request before the provider sees it: tool schemas compacted
so they decode identically, exact duplicate context removed, the per-request
timestamp that silently breaks the provider's prompt cache relocated out of
the cacheable prefix, and `cache_control` placed on the stable text only.
Because every transform is deterministic, the baseline is too: the same
request priced with and without the transform, at the provider's published
rates, from the provider's own reported usage. No regression models, no
"estimated based on similar workloads". Where a baseline genuinely is an
estimate, the ledger says `estimated-baseline` on the line item — labels are
load-bearing here.

## 2. Every request writes one hash-chained event — on the customer's disk

The unit of record is an append-only JSONL file the customer holds. One line
per request: provider-verbatim usage numbers, lever names, a few hashes, the
catalogue version used for pricing — never prompt content, never credentials.
Each line commits to the previous line's hash, so the file is tamper-evident
in both directions: we cannot inflate it later, and a corrupted spool fails
verification loudly instead of billing quietly.

## 3. The invoice is a pure function — and the verifier is MIT

`invoice = recompute(ledger file)`. That is the entire billing pipeline.
The functions that verify the chain and recompute the invoice ship as a
separate MIT package with zero dependencies and no network access, precisely
because the product itself is commercial (source-available BUSL): an honesty
claim you cannot independently check is worthless, so checking us requires
accepting no terms at all. If your recomputation disagrees with our number,
yours wins. That sentence is the contract.

## 4. Quality is part of the number

Savings are measured per completed task, never per request — a cheaper
request that fails its task is worth less than an expensive one that works,
and several "obvious" levers fail exactly this way. Lossless transforms
(byte-exact dedup, schemas that decode identically) apply by default. Anything
that changes what the model reads is off until a replay gate re-runs the
customer's own recorded requests and shows quality held. One of our stack's
strongest arms — 57.3% versus an uncached baseline — is published as a
**non-win** because it costs 5 points of task quality, over our own limit.

## 5. Losses bill against us, and that's not hypothetical

Negative savings are never clamped to zero. On our first live run, the ledger
caught one of our own levers losing money: a cache breakpoint placed over a
volatile prefix cost −$0.0063 across 8 turns — a cache write premium every
turn and never a single read. It counted against us on the invoice, we
published the loss and root cause, and the fix shipped with a test that
prices both placements under the provider's documented rules. A billing
design that can't surface its own mistakes would have hidden that forever.

## 6. Sometimes the verdict is "do not pay us"

The quote tool runs on exports from LiteLLM, Helicone, or Langfuse without
routing any traffic, and for already-optimised stacks its output literally
reads `do_not_charge`. Roughly a third of the workload shapes we measure are
ones where our honest answer is that the provider's cache or your own
discipline already did the work. Publishing the losing rows costs us leads
and buys the only thing a counterfactual biller can sell: being checkable.

## The numbers, with their labels

- Correct Claude cache placement alone, same prompts both arms: **37.9%**
  (simulator at published prices, labelled as such)
- Latest live run (30 real requests, five agent shapes): **18.2% of actual
  spend**, receipt published line by line
- Already-optimised stacks: **0–5%**, verdict `do_not_charge`
- The proxy's own cost: **~22ms p50** added per request, measurement script in
  the repo

Try the whole loop without an API key (`npx -y -p @flux-ai/sdk flux-demo`
runs proxy → ledger → independent recompute against a local stub in ten
seconds), or the real thing with your own key and one baseURL change.
Everything above traces to a runnable command: https://www.fluxtoken.dev/evidence.html
