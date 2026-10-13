# The data-handling answer

The question every pilot conversation reaches within ten minutes: *"what do you
see, and where does it go?"* This is the answer, and every sentence is sourced
to the code path that enforces it.

## Short version

FLUX runs entirely on your machines. The quote tool reads one export file
locally and writes one JSON report locally. The SDK wrapper runs in your
process, and the billing ledger it appends contains **token counts, model IDs,
timestamps, and hashes — never prompt or completion content**. There are no
network calls to FLUX: no telemetry endpoint, no hosted service, and the
Stripe metering sink is a local file projection. The package has never been
published to a public registry; pilots install from a tarball we hand you.

## The quote path (pre-contract, read-only)

- `flux-quote <export> --format litellm|helicone|langfuse` is a packaged Node
  bin that parses your gateway export, prices it against a bundled catalogue,
  and writes `quote.json`. It is pure and deterministic
  (`packages/core/src/quote-report.ts`); it makes no network requests.
- What it reads from the export: request IDs, model names, timestamps, token
  counts, and the gateway's own reported cost (informational only). If your
  proxy stores prompt bodies in its spend logs, the parser can read them
  **locally** for segment signals (`packages/core/src/litellm.ts`) — they never
  leave the file on your disk, and the quote works without them. If you prefer,
  strip message bodies from the export before running the tool; token counts
  are what the quote is built from.
- Unreadable rows are counted and reported, never silently dropped; models the
  catalogue cannot price are reported `unpriced`, never zeroed.
- The quote is reproducible: it embeds a content hash of the price catalogue
  and a deterministic fingerprint of the accepted rows.

## The SDK path (in-pilot)

- `withFlux` wraps your existing provider client in-process. Your requests go
  to the provider exactly as before (reduced, when a lever applies); FLUX is
  not a proxy and your API key is never shared with us.
- Each completed request appends one `BillableEvent` to a local, append-only,
  hash-chained ledger (`packages/core/src/savings-ledger.ts`). The event schema
  contains: request/task IDs, timestamps, provider, model, execution mode,
  provider-verbatim token usage (including the cache-write TTL split when the
  provider reports one), catalogue hash, USD figures, and lever records.
  **There is no field for prompt or completion content.**
- The ledger is opt-in and try/caught: a ledger failure cannot throw into your
  request path.
- The metering sink is a pure projection of ledger events into Stripe Billing
  Meters *rows in a local file* (`packages/core/src/stripe-sink.ts`); nothing
  is transmitted. If a production pilot later wants rows pushed to Stripe,
  that is your call, from your machine, with your key.

## The replay gate (optional, quality verification)

Replaying a sample of your traffic to verify a lossy lever does send those
sampled requests to **your own provider** under your key — the same place they
already went. FLUX never sees them; the gate verdict (approved/rejected) is
what lands in the ledger.

## What FLUX retains after a pilot

Nothing, structurally: all artifacts (export, quote, ledger, invoice) live on
your side. The invoice is a pure function — `recomputeInvoice(events,
catalogue)` — so the dispute path is "run it yourself," not "trust our
database."

## Honest limitations

- These guarantees are enforced by code you can read, not by a SOC 2 report:
  FLUX has no compliance certifications yet (pre-revenue, zero customers).
- The package is installed from a tarball; `npm publish` has never been run,
  which you can verify against the public registry.
- If you need a DPA or security questionnaire, the honest answer today is that
  the architecture makes most questions moot (no data ingress), and we will
  sign reasonable paper for a design partnership.
