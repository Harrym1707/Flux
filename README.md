# FLUX: stop paying twice for the same tokens

**Most agents never switch on the prompt cache, so they re-send the whole conversation every turn and pay full price for it again.**
FLUX sits on one URL between your app and the API, makes each request cheaper before it bills, and
writes every saving to a ledger you hold. You pay 1% of what it verifiably saved. Saved nothing? The
invoice says `do_not_charge`.

| **up to 72.8%** | **38.1%** | **18.2%** |
|:---:|:---:|:---:|
| off one-shot templated traffic that can wait<br><sub>simulator, arm I</sub> | off a coding agent's bill, live API traffic<br><sub>LIVE, 2026-10-26</sub> | net, 30 real requests, real money<br><sub>LIVE, 2026-10-26</sub> |

<sub>Every figure, its basis (LIVE or SIMULATOR) and the command that reproduces it:
[docs/NUMBERS.md](docs/NUMBERS.md). Already-optimised stacks get 0–5% and a "do not pay us" verdict.</sub>

## Install in 30 seconds

```bash
# 1. Proxy: any language, any agent, zero code changes. Then set base_url to http://127.0.0.1:8787
npx -y -p @flux-ai/sdk flux-proxy

# 2. SDK: one line in Node
npm install @flux-ai/sdk        # then: withFlux(new Anthropic(), { ... })

# 3. Claude Code plugin: /flux on, /flux-stats, /flux-off
claude plugin marketplace add Harrym1707/Flux && claude plugin install flux@flux
```

Inside Claude Code 2.1.275 or later, one step does it: `/plugin install flux --marketplace Harrym1707/Flux`.
Then type `/flux`. It starts the proxy, points `ANTHROPIC_BASE_URL` at it once it answers, and
`/flux-off` puts everything back. Claude Code already places its own cache breakpoints, and FLUX
defers to them, so expect the lossless levers there, not the cache number. `/flux-stats` shows
your real figure. Plugin details: [plugins/flux/](plugins/flux/README.md).

## Before and after (real output, not a mock-up)

One real request shape (a support agent with 40 rules, 40 tools, a duplicated KB article and a clock
at the top) through the real SDK wrapper:

```text
$ node --import tsx examples/reduce-drop-in.ts
=== request payload, before and after ===
input tokens (estimated)   12,972 -> 10,872
...
tools serialised           30,541 -> 26,181 chars
...
clock moved off the front  yes
clock still present        yes
stable prefix now          2,457 tokens
```

The same harness over a whole one-shot workload. Same preamble, a per-request clock, priced by the
provider-rule cache simulator:

```text
$ node --import tsx evals/run-agent-ab.ts
=== one-shot workload: same preamble, per-request clock, nothing appends ===
A. no FLUX                 cost $0.569, hit rate 0%
C. + prefix repair         cost $0.335, hit rate 78%
H. full stack (cap 2000)   cost $0.310, hit rate 84%
I. H + flex tier (async)   cost $0.155, hit rate 84% (flex pricing, async-eligible only)
```

$0.569 to $0.310 is the **45.5%** band, and $0.155 is the **72.8%** one for traffic that can wait.
Both are SIMULATOR figures. The LIVE ones are above.

## FLUX vs Caveman: use both

[Caveman](https://github.com/JuliusBrussee/caveman) makes your agent *say less*. FLUX makes each
*request cost less*. They work on different layers, so they stack.

| | Caveman | FLUX |
|---|---|---|
| What it changes | How the agent writes (terse replies), plus compressing logs and JSON the agent reads | The API request itself: cache-prefix stamping and repair, schema compaction, exact-duplicate removal, execution tier |
| How you add it | A skill or plugin inside each agent (30+ supported), with an optional CLI | One local URL (`base_url`), or one line of SDK |
| Works with | The coding agents it supports | Any client in any language that can set an Anthropic or OpenAI base URL, coding agent or not |
| Your prompts | The skill runs locally. Optional Cloud and Auto modes send prompts to Caveman Cloud. The CLI sends usage telemetry unless you turn it off | Never leave your machine except to your own provider. The proxy sends no telemetry |
| How savings are counted | Its own token benchmarks | Per completed task, at provider prices, into a hash-chained ledger on your machine |
| Price | Free, open source | 1% of verified savings, nothing else. BUSL-1.1, free for non-commercial use |
| Can you audit the bill? | Nothing to bill | Yes: `recomputeInvoice` on your own spool must reproduce our invoice |

<sub>Caveman facts from its README, checked 2026-10-28. If something has changed, open an issue and we'll fix it.</sub>

## What FLUX is

FLUX reduces what each LLM request costs — on Claude (Anthropic), OpenAI, and
any OpenAI-compatible API — and meters the savings into an append-only,
hash-chained ledger **you can recompute yourself**. The fee is a percentage of
verified savings: if FLUX saves nothing, the invoice says `do_not_charge`.

Three things no other cost tool says on its front page:

1. **Integration is one URL.** Run the FLUX proxy and point your client's
   `base_url` at it. No SDK adoption, any language. Your API key passes
   through verbatim — FLUX never holds credentials.
2. **The published numbers include where FLUX loses.** Already-optimised
   stacks get a `doNotPayUs` verdict, and our busy-interactive ceiling (~29%
   before cache enablement) is printed next to the wins.
3. **The invoice is a pure function of a ledger you hold.** Every request
   writes one hash-chained event with provider-verbatim usage; run
   `recomputeInvoice` on your own spool and you must get our number.

## How much does it save? The full evidence table

| Workload | Band | Status |
|---|---|---|
| Multi-turn Claude, cache TTL only | **37.9%** | simulator-measured vs the same J prompt stack with cache disabled; both arms clean 38/40 |
| Full J + 5m cache stack vs raw uncached baseline | **57.3% lower cost, but −5 pp clean-task quality** | diagnostic only; fails the agreed −2 pp quality limit and is not a qualified win |
| Background / batch / latency-tolerant (OpenAI flex tier) | **57.7% net** (64.3% ceiling) | simulator-measured, billed from the SERVED tier |
| One-shot templated API traffic | **45.5%**, up to 72.8% | simulator-measured |
| Interactive agents (busy / sparse) | **25.9% / 34.3%** | simulator-measured |
| Latest live export (30 requests, claude-sonnet-5-5, 2026-10-26) | **18.2% net** (agents 0–38.1%) | measured on live API traffic; hash-chained spools in `evals/live-exports-2026-10-26/` — recompute it yourself |
| Already-optimised stacks | **0–5%** | we tell you not to pay us |

Every number traces to a command and a commit: see
[docs/site/evidence.md](docs/site/evidence.md). Savings are measured **per
completed task**, never per request, and quality is gated by replaying your
own recorded requests — a failed task voids its savings.

## Quick start: proxy mode (no code changes)

```bash
npx -y -p @flux-ai/sdk flux-proxy
```

(Prefer building from source? `git clone https://github.com/Harrym1707/Flux && cd Flux`,
then `corepack enable && pnpm install && pnpm build` and `node --import tsx evals/run-proxy.ts`.)

Then change one line in your app:

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
// OpenAI SDK
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

Requests are reduced before they reach the provider, responses (including SSE
streams) come back byte-identical, and a hash-chained ledger spool appears
under `./flux-ledger/`. Reduction is **lossless-only by default**: compacted
tool schemas decode identically, removed duplicates are exact, prefix repair
reorders text without deleting it. Lossy levers stay off until a replay gate
proves on your own traffic that quality held.

## Quick start: SDK mode (one line)

```js
import { withFlux } from "@flux-ai/sdk"; // npm install @flux-ai/sdk

const client = withFlux(new Anthropic(), {
  applicationId: "my-app",
  tokenReduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
  ledger: { path: "./flux-ledger.jsonl", provider: "anthropic" },
});
```

Works with Anthropic `messages.create`, OpenAI `responses.create`, and
`chat.completions.create` on one shared hash chain.

## Where the savings come from

- **Anthropic's prompt cache is opt-in, and most agents never opt in.** An
  unstamped Claude agent re-pays full rate for its entire conversation history
  every turn (our live export measured exactly that: zero cache traffic on a
  five-turn agent). FLUX stamps the stable prefix — writes 1.25×, reads 0.1× —
  and defers whenever you placed your own `cache_control`. Volatile values
  (a per-turn clock, a request id) are kept outside the breakpoint, and a
  conversation whose prefix churns between turns is never stamped at all: a
  breakpoint that can never be read back only buys write premiums, so FLUX
  refuses to place one.
- **Fresh tool results are capped at injection**, before they bill once at the
  full input rate (headlines, errors and file paths survive verbatim; the
  replay gate approved this lever at zero quality delta).
- **Prefix repair**: one timestamp at the top of a shared template disables
  provider caching entirely; FLUX relocates it.
- **Schema compaction and exact-duplicate removal**: lossless, on every request.
- **Execution tiers**: OpenAI flex is the same model at 50% off for work that
  can wait; FLUX bills from the tier the provider actually served.

## What FLUX never does

- Never sends your prompts anywhere: analysis runs in-process, and the ledger
  records usage numbers, lever names and hashes — not content.
- Never claims savings you already had: your own cache hits and gateway-cache
  discounts are itemised in `excluded` and never billed.
- Never clamps a negative: a cache-write premium that didn't pay off counts
  against FLUX on the invoice.
- Never bills a lossy lever without an approved replay-gate verdict from your
  own recorded traffic.

## Already running LiteLLM, Helicone or Langfuse?

You are one file export away from a quote, including the honest
"do not pay us" verdict:

```bash
npx -y -p @flux-ai/sdk flux-quote your-export.jsonl --format litellm
```

## Reproduce every number

```bash
./node_modules/.bin/vitest run          # the full test suite
node --import tsx evals/run-agent-ab.ts # the measurement harness, all arms
node --import tsx evals/run-live-agents.ts  # five agents end-to-end (set ANTHROPIC_API_KEY for real traffic)
```

Method: [docs/site/methodology.md](docs/site/methodology.md) · segment bands:
[docs/site/segments.md](docs/site/segments.md) · honest comparison, including
independent measurements of competing tools:
[docs/site/comparison.md](docs/site/comparison.md) · FAQ:
[docs/site/faq.md](docs/site/faq.md)

## License

The fee is **1% of verified savings, monthly — nothing else**. A month that
saved nothing bills nothing.

[Business Source License 1.1](LICENSE): free to read, evaluate, develop
against, and use non-commercially. Production or commercial use requires a
commercial agreement — which is the point: FLUX charges a percentage of
verified savings, nothing else. Each version converts to Apache 2.0 on its
Change Date.
