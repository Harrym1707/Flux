# Get started in five minutes

FLUX sits between your app and your AI provider, removes the tokens you were
about to pay for twice, and writes every request into a tamper-evident ledger
you can audit yourself. No signup, no account, no key handover: your API key
passes through to the provider and is never stored. Works with Claude
(Anthropic), OpenAI, and any OpenAI-compatible endpoint.

## Step 1 — run the proxy

One command, nothing to clone:

```bash
npx -y -p @flux-ai/sdk flux-proxy
```

You'll see:

```text
FLUX proxy listening on http://127.0.0.1:8787
Ledger spools: ./flux-ledger
```

To switch on the Claude prompt-cache lever too (our single biggest measured
saver, 37.6% on multi-turn traffic), start it as
`FLUX_PROXY_CACHE_TTL=5m npx -y -p @flux-ai/sdk flux-proxy`.

## Step 2 — point your app at it

Change one line. Keep your own API key — FLUX passes it through verbatim.

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });

// OpenAI SDK — also any OpenAI-compatible endpoint
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

Any language works — it's just a base URL. Python, Go, curl, LangChain,
whatever you run today.

## Step 3 — run your traffic as normal

Responses come back byte-identical, streaming included. Reduction is
**lossless-only by default**: compacted tool schemas decode identically,
removed duplicates are exact, and if anything fails your request goes through
untouched. Each request appends one hash-chained event to
`./flux-ledger/<your-app>-<provider>.jsonl` — usage numbers, lever names and
hashes. Never your prompts.

## Step 4 — check our maths yourself

This is the part no other cost tool offers: the invoice is a pure function of
a ledger file **you** hold. Verify the chain and recompute it with the same
published package:

```bash
node -e '
const { readFileSync } = require("node:fs");
const { verifyLedgerChain, recomputeInvoice } = require("@flux-ai/sdk");
const records = readFileSync(process.argv[1], "utf8").trim().split(/\n/).map(JSON.parse);
const chain = verifyLedgerChain(records);
if (!chain.ok) throw new Error("chain broken at seq " + chain.seq);
console.log("chain verified:", chain.length, "records");
console.log(JSON.stringify(recomputeInvoice(records.map(r => r.event)), null, 2));
' flux-ledger/proxy-anthropic.jsonl
```

If FLUX saved you nothing, the verdict line literally reads
`"verdict": "do_not_charge"` — that is the honest outcome on traffic that is
already lean, and we publish it as such.

## Already measuring with LiteLLM, Helicone or Langfuse?

You don't need to route any traffic to get a quote. Export your existing logs
and run them through the quote tool — the verdict can be "do not pay us":

```bash
npx -y -p @flux-ai/sdk flux-quote your-export.jsonl --format litellm
```

## What it costs

**1% of verified savings, monthly — nothing else.** No subscription, no
seats, no minimum. Savings are measured per completed task from the
provider's own reported usage; a month that saved nothing bills nothing. The
measurement rules are published in full in the [methodology](methodology.md),
and every number we quote traces to a command and a commit on the
[evidence](evidence.md) page.

## What FLUX never does

- Never sends your prompts anywhere — analysis runs entirely on your machine.
- Never stores or forwards your API key beyond the provider you chose.
- Never claims savings you already had: your own cache hits are itemised and excluded.
- Never hides a loss: a lever that cost you money counts against us on the invoice.

## Want a guided pilot?

Open a [pilot request](../pilot/runbook.md) — bring an export from your
existing gateway and leave with a per-segment quote from your own traffic,
including the honest band for your workload shape.
