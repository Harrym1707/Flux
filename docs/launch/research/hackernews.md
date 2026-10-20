# Show HN research — rules, precedents, attack map (2026-10-20)

## Venue verdicts
- **Hacker News: the launch venue.** FLUX qualifies ("things people can run"):
  the npx one-liner is the qualifying artifact. 2026 context: Show HN is being
  actively restricted against AI-generated one-offs — post from an account
  with real participation history; visible engineering depth is a survival
  requirement.
- **lobste.rs: do NOT launch there.** Invite-only; no self-promo for a user's
  first 70 days; commercial-promo is flaggable. Long-term indirect path only
  (a technical article about the hash-chain, months after joining).

## What won and what flopped (real threads)
- WINNERS (100–340 pts): mechanism-led titles — "Show HN: liteLLM Proxy
  Server: 50+ LLM Models…" (140), "Langfuse – Open-source observability…"
  (143), "Helicone.ai – Open-source logging for OpenAI" (166), "GoModel – an
  open-source AI gateway in Go" (217), "A MitM proxy to see what your LLM
  tools are sending" (218), "Price Per Token" (339), "Frugon – Find which LLM
  calls a cheaper model could handle (local, MIT)" (67).
- FLOPS (1–7 pts): benefit-number titles — "Headroom (OSS): Cuts LLM costs by
  85%" (3 pts; top comment: "Not a single example of what it does or how it
  works"), every "cut LLM costs 10x" variant.
- THE LESSON: verifiable mechanism + modest checkable numbers = 100–340 pts;
  savings-percentage benefit claim = 1–5 pts. FLUX's honesty ledger IS the
  winning framing; the 1% billing is the losing framing — keep it out of the
  title, third in the first comment, pre-caveated.

## Title candidates (proven template: Name – plain mechanism, differentiator)
1. Show HN: Flux – local proxy that cuts Claude/OpenAI costs, with a verifiable ledger
2. Show HN: Flux – LLM cost proxy whose savings ledger you can recompute yourself
3. Show HN: A local LLM proxy that tells you when NOT to use it (risky-clever)
Never in a title: "open source" (we are BUSL — using it invites a flamewar;
omit rather than approximate), emoji, "!", "AI-powered", benefit percentages.

## First-comment structure (what worked for Langfuse/GoModel/Frugon)
1. First-person origin story.
2. Mechanism in plain words + the exact npx command.
3. Modest, checkable numbers WITH the band and the losers ("near 0% on stacks
   already caching well").
4. Volunteer the weaknesses before the thread finds them: where FLUX loses,
   BUSL and why, the added hop, the do-not-pay-us verdict.
5. End with a real question ("What would make you trust a savings number you
   didn't compute?").

## Attack map with precedents (prepare answers, never improvise)
A. "Billing % of counterfactual savings is unverifiable/perverse" — precedent:
   Skope YC S25 shredded on exactly this. Answer: deterministic counterfactual,
   hash-chained customer-recomputable ledger, billing stops when savings stop,
   the do-not-pay-us verdict exists because the objection is valid at the
   margin. Expect "offer a flat fee" within the hour.
B. "BUSL is not open source" — precedent: HashiCorp thread, Helicone's launch.
   The ONLY survivable posture: "Correct — BUSL is source-available, not open
   source, converts to Apache-2.0 on [date]." One sentence, never argued.
   BIGGEST PRE-LAUNCH MOVE AVAILABLE: make the VERIFIER (recompute/verify
   tooling) genuinely MIT — "an honesty claim you can't independently verify
   is worthless" (founder decision).
C. "Just use the provider's prompt caching yourself" — answer: agree + demo
   the do-not-pay-us verdict on a well-cached stack. Only credible counter.
D. "A proxy sees my keys/prompts; latency; reliability" — FLUX is LOCAL;
   pre-answer explicitly: keys never leave the machine, no hosted hop,
   nothing phones home, fail-open on crash, measured ~22ms added p50.
E. "Vibe-coded/insecure" — precedent: Sherlock's ssl_insecure=true found in
   hours. Pre-audit TLS handling and the dependency chain; expect "you're
   asking people to pipe Anthropic keys through an unaudited npx package."
F. "Your numbers are juiced" — publish loss cases IN the post; the internal
   honesty rules belong in the post, not just the docs.

## Mechanics
- Post Tuesday–Thursday, 14:00–15:00 UTC. First 30–60 min of organic velocity
  decide the front page; founder free for 3+ hours after.
- Link the GITHUB REPO, not the marketing site (a site with pricing above the
  fold reads as a disallowed "sign-up page"). Demo link goes in the first
  comment.
- Never ask anyone to upvote ("Please don't ask friends to upvote or comment.
  That's not ok on HN" — verbatim guideline); ring detection buries posts
  permanently. Total silence until live.
- If it dies under ~10 points: one retry on another day is tolerated; serial
  reposting is not.
- Conduct: first comment within a minute; answer everything; concede fast and
  specifically ("you're right about X, fixed in commit Y"); licence question
  gets one sentence; hostile-and-right gets thanked; hostile-and-wrong gets
  one data-backed correction then disengagement.
