# Launch posts — other channels (founder fires each one)

Sequencing (from research/channels.md): listings first (compounding GEO),
then HN, then DevHunt, X cadence throughout, Product Hunt later with social
proof. One community per day, never a blast.

---

## 1. console.dev pitch (email — their published criteria fit FLUX exactly)

Subject: Flux — local LLM cost proxy with a customer-recomputable savings ledger

> Hi — Flux might fit Console's selection criteria: it's dev-first,
> entirely self-service (one command, no signup, no sales call), and the docs
> lead with runnable commands.
>
> `npx -y -p @flux-ai/sdk flux-proxy` starts a local proxy; point your
> Anthropic/OpenAI client's baseURL at it and it reduces each request before
> the provider sees it (lossless-only by default), then writes a hash-chained
> ledger of provider-verbatim usage to your disk. The differentiator is
> verification rather than claimed savings: the invoice is a pure function of
> a file the customer holds, recomputable with the same published package,
> and the quote output for already-optimised stacks literally says "do not
> pay us". Published numbers include where it loses.
>
> Repo: https://github.com/Harrym1707/Flux · Site: https://www.fluxtoken.dev
> · Five-minute start: https://www.fluxtoken.dev/start.html
>
> Happy to answer anything. — Harry

## 2. DevHunt listing

- Tagline: "Local proxy that cuts Claude/OpenAI API costs — with a savings
  ledger you can recompute yourself"
- Demo: the start page (five-minute walkthrough) + the evidence page
- Link GitHub repo as primary; note zero-signup npx install in the first line.

## 3. X thread (no hashtags; story form; real numbers only)

1/ Anthropic's prompt cache is opt-in. Most agents never opt in. We metered a
five-turn coding agent re-paying full input rate for its ENTIRE history every
turn — zero cache traffic. That's the default state of most agent loops
running right now.

2/ So we built Flux: a local proxy. `npx -y -p @flux-ai/sdk flux-proxy`,
point baseURL at it, keep your own key. Requests get reduced losslessly
before the provider sees them; responses come back byte-identical.

3/ The twist: every request writes one event to a hash-chained ledger on YOUR
disk. The invoice is a pure function over that file. Recompute it yourself
with the same npm package — if our number and yours disagree, yours wins.

4/ Honesty test: one of our own levers lost $0.0063 on live traffic (cache
breakpoint over a volatile prefix). The ledger caught it and counted it
against us. We published the loss, the root cause, and the fix.

5/ Measured bands, labelled: 37.9% from correct cache placement alone
(simulator, identical prompts both arms). 18.2% of real spend on our latest
live run — receipt published line by line. Already-optimised stack? The
quote says "do not pay us."

6/ Free to try, nothing leaves your machine, ~22ms added p50. Production
pricing is 1% of verified savings — a month that saves nothing bills
nothing. fluxtoken.dev

## 4. Product Hunt (later — after HN + some social proof)

- Tagline (<60 chars): "Cut LLM API costs. Verify every cent yourself."
- Maker's first comment: the ledger story (compress the Show HN first comment
  to 150 words); invite scepticism explicitly.
- Launch Tue/Wed 12:01 AM Pacific; reply to every comment within 15 min.
- Assets needed before listing: 240×240 animated thumbnail, 1270×760 gallery
  shots (hero waves, reducer demo, the receipt), 60–90s screen demo.

## 5. Listings (fire once each, order by GEO value)

1. AlternativeTo — create account NOW (must age 7 days before listing); list
   as alternative to Helicone / LiteLLM / OpenRouter, category LLM cost.
2. tensorchord/Awesome-LLMOps PR — "Cost Management" section, one line:
   "FLUX — local proxy that reduces Claude/OpenAI request cost and meters
   verified savings into a customer-recomputable hash-chained ledger."
3. The smaller awesome lists (awesome-llm, awesome-llmops, awesome-claude
   variants) — same line, one PR each, spread over days not minutes.
4. MLOps Community Slack #be-shameless — short factual post, affiliation in
   profile first.
5. Anthropic Discord project-share channel — read #rules, then showcase post.

## 6. The newsletter asset (needed before TLDR/Latent Space have anything to link)

They link primary technical content, not landing pages. The asset to write
(Growth agent drafts, founder reviews): "How we verify LLM API savings with a
hash-chained ledger our customers can recompute" — the mechanism post, with
the live-export receipt and the published-loss story. Pitch Latent Space on
the incentive-design angle (billing only on verifiable savings), not the tool.
