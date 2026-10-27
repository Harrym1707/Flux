# Methodology — how every FLUX number is made

The LLM cost-saving market has a measurement problem, documented by independent
work rather than by us: three popular open-source token trimmers claiming
60–90% savings delivered **3.7%** when independently replayed over 614M tokens
of real traffic; a prompt-slimming technique modelled at ~77% measured **~13%**
in production. The gap comes from measuring per *request* instead of per
*completed task*, and from ignoring provider cache economics. FLUX's method
exists to be immune to both.

## The rules every published number passes

1. **Per completed task, not per request.** A technique that shrinks each
   prompt but multiplies round trips has saved nothing. Our harness runs
   multi-turn tasks end to end and prices the whole task.
2. **Quality held, measured.** A claimed arm must keep at least 36 of 40 tasks
   fully correct and complete. A changed tool call is a hard failure; a
   shortened answer is scored by degree. The simulated model's quality signal
   punishes trimming recent context — the fixture is built to catch our own
   levers failing.
3. **Provider cache rules simulated faithfully**: minimum cacheable prefix,
   longest-exact-prefix matching, hit granularity, time-to-live expiry, and
   write premiums. Our simulator can and does show caching as a **net loss**
   on unfavourable traffic — that case has a unit test.
4. **The provider's existing contribution is never claimed.** On busy agent
   traffic, the provider's cache alone saves 35–40% before FLUX does anything.
   That figure is printed separately and excluded from every FLUX claim.
5. **Tier savings are billed at the tier actually served.** Discounted-tier
   requests can be bounced back to full price under load; the published async
   figure (57.7%) is net of assumed fallback rates, and per-request billing
   reads the service tier from the provider's response, not from our request.
6. **Lossy levers pass a replay gate first.** Changes that could affect answers
   (description trimming, output caps, tool-result capping) are enabled only
   after replaying your recorded requests both ways, with statistics corrected
   for having searched multiple configurations. The gate has rejected our own
   levers — those rejections are documented, not tuned away.
7. **Unpriced means excluded, never zero.** A model or billing date the price
   catalogue cannot price is excluded from baselines and invoices, with the
   reason stated. Our catalogue is dated and source-linked; a price change
   never silently reprices history.
8. **The invoice is recomputable.** Every request emits an append-only,
   hash-chained event carrying provider-verbatim usage, the catalogue version,
   levers applied, and gate verdict references. `recomputeInvoice(events)` is a
   pure function: run it yourself and you must get our number.

## What "simulator-measured" means — and what it does not

All current figures come from a 40-task × 5-turn agent harness (plus one-shot
variants) with realistic multi-kilobyte tool results, verified by an
independent checker agent reproducing every number from command output, under
341 unit tests and 27 regression gates. They are honest measurements **of the
simulation**. They are not yet measurements of your traffic — the pilot exists
to produce that number, on your machine, from your logs, before you pay
anything.

Known open items we publish rather than hide: per-model cacheable minimums are
not yet in the simulator (the sparse-traffic 34.3% may overstate on some
models). Anthropic batch rates ARE now catalogued (2026-10-27, from the page's
definitive "Save 50% with batch processing"), so async-eligible Claude traffic
prices natively at half standard and FLUX picks batch-routing or caching per
shape, whichever is cheaper; tracked in [evidence](evidence.md).
