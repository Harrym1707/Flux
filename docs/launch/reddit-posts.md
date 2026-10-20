# Reddit posts — one per community, in that community's register

Rules of engagement (from research/reddit.md): text posts, no URL in the
title, GitHub link mid-body after the numbers, one sub per day, warm the
account with link-free helpful comments for 1–2 weeks first. Retype rather
than paste — these drafts are skeletons for YOUR voice, and communities
detect and punish copy that reads machine-written. Every number is published
on the evidence page; add nothing that isn't.

---

## 1. r/ClaudeCode — flair: Built with Claude (fire first)

**Title:** I built a local proxy to cut my Claude API bill, and its own ledger caught one of my levers losing money

**Body (skeleton):**

The thing that started this: Anthropic's prompt cache is opt-in, and when I
actually metered five typical agent workloads, a five-turn coding agent was
re-paying full input rate for its entire history every single turn. Zero
cache traffic. The cache just… wasn't on, because nobody turns it on.

So I built flux — a local proxy. One command, no signup:

    npx -y -p @flux-ai/sdk flux-proxy

(or read the source first: github.com/Harrym1707/Flux — it's your API key
going through it, you should.)

Point your client's baseURL at it and it compacts tool schemas (decodes
identically), removes exact duplicate context, moves the per-request
timestamp that silently breaks the provider cache, and places cache_control
on the actually-stable prefix. Responses come back byte-identical. Your key
passes through and is never stored; nothing leaves your machine except the
normal call to Anthropic.

The part I'm most proud of is also the embarrassing part. Every request
writes one line to a hash-chained ledger on your disk, and the invoice is
recomputed from that file — by you, with the same package. On our first live
run that ledger caught one of our OWN levers losing money: a cache breakpoint
placed over a volatile prefix cost −$0.0063 across 8 turns, writes every
turn, zero reads. It counted against us, we published it, and the fix is in
the repo with a test that prices both placements.

Honest numbers: 37.6% from correct cache placement alone (simulator, same
prompts both arms, labelled as such). 18.0% of real spend on a 30-request
live run, receipt on the site line by line. If your stack already caches
well, the quote output literally says "do not pay us" — that's a real
verdict it produces.

Happy to answer anything about cache_control placement — I've now stared at
more cache-miss traces than I'd like to admit.

---

## 2. r/ClaudeAI — flair: Showcase (needs 50+ account karma; else the Megathread)

**Title:** How Claude's prompt cache actually bills (and the proxy I built after metering agents that never turn it on)

**Body (skeleton):** Lead with 150 words of genuinely useful teaching: the
cache is OPT-IN; breakpoints define exact-byte prefixes; writes bill 1.25×
(5m) / 2× (1h), reads 0.1×; one timestamp at the top of your system prompt
breaks everything after it; TTL counts from request START so a long
generation can expire its own cache ("bathroom breaks become a financial
decision" — their joke, reuse the sentiment, not the phrasing). THEN the
tool: npx one-liner, what it automates, the recomputable ledger, the
published loss story, the do-not-pay-us verdict. Same honesty block as the
r/ClaudeCode post, compressed.

---

## 3. r/LLMDevs — engineering writeup (no flair needed; disclosure required)

**Title:** Cut token spend 18% on live traffic — and here's the hash-chained ledger so you can check the math, including where it lost

**Body (skeleton):** This community's live anxiety is *proving* savings
claims, so structure as method-first:

1. The measurement problem: every router/optimizer claims a percentage;
   none let you recompute it. Baselines are counterfactuals, so the only
   honest move is provider-verbatim usage + a deterministic pricing function
   + an append-only ledger the customer holds.
2. The mechanism: hash-chained JSONL per app; invoice = pure function over
   events; verifyLedgerChain + recomputeInvoice in the published package;
   if your recompute disagrees with ours, yours wins.
3. The numbers with tradeoffs: 37.6% cache-only (simulator, both arms clean
   38/40); the 57.1% full-stack figure FAILS our own quality gate (−5pp) and
   is published as a non-win; live run 18.0%; already-lean stacks 0–5% and a
   do-not-pay-us verdict.
4. The loss: our own stamp lever lost $0.0063 live; root cause (volatile
   prefix inside the breakpoint span); fix; the economics test.
5. Disclosure: I built it; BUSL source-available (not open source — free to
   evaluate and use non-commercially, Apache-2.0 in 2030); production is 1%
   of verified savings and a month that saves nothing bills nothing.

---

## 4. r/mlops — flair: Self-Promotion

**Title:** Our own cost lever was losing money on live traffic. The ledger caught it.

**Body (skeleton):** The post-mortem register — one measured fact, then the
anatomy: what the lever did (Anthropic cache stamping), why it lost (volatile
prefix inside the breakpoint span = write premium every turn, zero reads),
how the billing design surfaced it (negatives are never clamped; losses
count against the vendor), the fix, and the attribution angle this community
cares about: per-request, per-lever, per-app cost attribution from provider-
verbatim usage, recomputable from a file you hold. Disclosure + link mid-body.

---

## 5. r/ChatGPTCoding — the weekly Self Promotion Thread only

Three sentences: what it does (OpenAI + Claude, one baseURL change), the npx
one-liner, the recomputable ledger + do-not-pay-us verdict. No more.

## 6. r/AI_Agents + r/OpenAI — comments only

Use the playbook in research/reddit.md §Natural-thread: answer the runaway-
spend / caching / budget-cap question fully and by hand, then the disclosure
line with the do-it-by-hand escape hatch. Never twice in one thread genre in
one week.

## Do not post

r/LocalLLaMA (cloud-API tooling is read as working for the enemy; disclosed
comments in hybrid-stack threads only), r/MachineLearning, r/artificial.
r/selfhosted only after the MIT-verifier decision, on a Wednesday, with the
"what leaves the machine: nothing new" security framing up top.
