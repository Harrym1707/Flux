# Launch checklist

Everything here must be true BEFORE the first post goes up. A launch spike
lasts hours; a broken first impression lasts.

## Product readiness (verify the morning of)

- [ ] `npx -y -p @flux-ai/sdk flux-proxy` works from a clean machine (no repo,
      no login) — this is the first thing every visitor will run
- [ ] www.fluxtoken.dev loads fast; /start.html renders; GEO audit green
      (`FLUX_SITE_ORIGIN=https://www.fluxtoken.dev node --import tsx evals/run-geo-audit.ts`)
- [ ] CI green on main; nightly-evals has a passing run
- [ ] README front section reads correctly on the GitHub mobile app (most HN
      readers open the repo on a phone first)

## Repo as a landing page

- [ ] Issues enabled, pilot-quote template visible under "New issue"
- [ ] The latest live-export receipt is current on README + site
- [ ] LICENSE question pre-answered: the README's BUSL section says plainly
      "free to use and evaluate; production use needs a commercial agreement;
      converts to Apache-2.0 on the Change Date" — commenters WILL raise this
- [ ] No TODOs, placeholder text, or broken links in any file a visitor
      reaches within two clicks of the README

## Hard questions we must answer honestly in comments (prepare, don't improvise)

1. **"You're billing a counterfactual."** Answer: yes — the same way energy
   performance contracts have since the 1990s: agreed baseline, provider-
   verbatim measurements, and an invoice that is a pure function of a ledger
   the customer holds and can recompute. If our number and yours disagree,
   yours wins.
2. **"Why not just set cache_control myself?"** Answer: you absolutely can,
   and if your stack is already optimised our quote literally says "do not
   pay us." FLUX is for the teams that haven't — our live export measured a
   five-turn agent paying full rate for its entire history every turn — plus
   the verification layer that proves what changed.
3. **"BUSL isn't open source."** Answer: correct, and we don't claim it is.
   Source-available, free to use non-commercially and evaluate, Apache-2.0 on
   the Change Date. We charge 1% of verified savings in production; that's
   the whole business.
4. **"The savings numbers are simulated."** Answer: the bands are
   simulator-measured and labelled so everywhere they appear; the 18.0% is
   live API traffic, receipt published line by line, and your pilot replaces
   every number with your own traffic before any fee exists.
5. **"What about my data?"** Answer: the proxy runs on your machine; prompts
   never leave it; the ledger stores usage numbers and hashes, not content;
   your API key passes through and is never stored.

## Mechanics

- [ ] Founder available for the first 3 hours after posting to answer
      comments personally (this decides whether a post lives or dies)
- [ ] Never ask anyone to upvote, and never upvote from a second account —
      vote-ring detection buries the post permanently
- [ ] One community per day, not a blast — each post tailored (see
      communities.md), each answered properly
- [ ] Watch the traffic archiver + npm downloads afterward; the ops agent's
      Friday report captures the week

## Who fires what

| Action | Owner |
|---|---|
| Posting anywhere (HN, Reddit, PH, X, Discord) | Founder, always |
| Drafts, timing advice, comment-reply drafts | Claude |
| Answering GitHub issues that arrive | Founder sends; Claude drafts |
| Measuring the spike (traffic, downloads, mentions) | Ops agent (Fridays) + traffic archiver |
