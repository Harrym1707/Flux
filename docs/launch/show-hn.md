# Show HN — the post (founder fires)

Built from docs/launch/research/hackernews.md. Every number below is published
on the evidence page; do not add any that isn't.

## Title (pick one — mechanism-led, never the billing, never "open source")

> Show HN: Flux – local proxy that cuts Claude/OpenAI costs, with a verifiable ledger

Alternative:
> Show HN: Flux – LLM cost proxy whose savings ledger you can recompute yourself

## URL

`https://github.com/Harrym1707/Flux` — the repo, NOT fluxtoken.dev (HN rules
treat a marketing page as a disqualifying "sign-up page"; the site link goes
in the first comment).

## First comment (post within ONE MINUTE of submitting)

---

Hi HN — I built Flux after measuring something that surprised me: Anthropic's
prompt cache is opt-in, and most agents never opt in. The first time I ran
five typical agent workloads through a meter, a five-turn coding agent was
re-paying full input rate for its entire conversation history on every single
turn — zero cache traffic. Multiply that by every agent loop running today
and it's a lot of money nobody meant to spend.

Flux is a local proxy. One command, no signup, no account:

    npx -y -p @flux-ai/sdk flux-proxy

Point your client's baseURL at it (`http://127.0.0.1:8787`) and keep your own
API key — it passes through verbatim and is never stored. Requests are
reduced before they reach the provider (compacted tool schemas that decode
identically, exact-duplicate removal, relocating the per-request timestamp
that silently breaks the provider's cache, and correct cache_control
placement). Responses come back byte-identical, streaming included. Nothing
leaves your machine; the proxy adds ~22ms p50 on 31KB agent requests
(measurement script in the repo).

The part I actually care about: every request appends one event to an
append-only, hash-chained ledger on YOUR disk — usage numbers from the
provider's own response, lever names, hashes, never prompt content. The
invoice is a pure function over that file. You can recompute it yourself with
the same published package and you must get our number. If our maths and
yours disagree, yours wins.

Honest numbers, because that's the whole point of the thing:

- Switching Claude's cache on correctly, measured both ways on identical
  multi-turn prompts: 37.9% (simulator at published prices, labelled as such)
- Our latest small live run (30 real requests, five agent shapes): 18.0% of
  actual spend, receipt published line by line on the site
- A stack that's already well-optimised: 0–5%, and the quote output literally
  says "do not pay us"
- One of our own levers initially LOST $0.0063 on live traffic (a cache
  breakpoint over a volatile prefix). The ledger caught it, it counted
  against us, and the fix + the measurement are in the repo. That's the
  system working as designed.

Where it loses, stated up front: busy interactive agents cap around 29%
because the provider's cache already does the heavy lifting; if you already
place cache_control correctly and dedupe your context, Flux will mostly tell
you to keep your money.

Licence and pricing, plainly: the code is source-available under BUSL 1.1 —
not open source — free to use non-commercially and to evaluate, converting
to Apache-2.0 in 2030. Production use is a commercial agreement: 1% of
verified savings, monthly, nothing else; a month that saved nothing bills
nothing, and negative lever months count against us. I know %-of-savings
billing invites scepticism — that scepticism is exactly why the ledger is
recomputable by you and why the do-not-pay-us verdict exists.

Genuine question for this crowd: what would it take for you to trust a
savings number you didn't compute yourself? That question shaped most of the
design, and I'd rather hear where it still falls short.

---

## Prepared answers

Use docs/launch/checklist.md § "Hard questions" — concede fast, one-sentence
licence answers, demo the do-not-pay-us verdict instead of arguing. Fix any
real bug live and say so in-thread with the commit hash.

## Timing

Tuesday–Thursday, 14:00–15:00 UTC (3–4pm UK). Be free for the next 3+ hours.
Never ask anyone to upvote. If it dies under ~10 points, one quiet retry
another day is acceptable; no serial reposting.
