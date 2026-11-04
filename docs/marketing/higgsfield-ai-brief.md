# MESH × Higgsfield AI — short-form & image marketing brief

**Product:** MESH — a local proxy that cuts your LLM API bill and charges a
percentage of *verified* savings you can recompute yourself
([github.com/Harrym1707/Flux](https://github.com/Harrym1707/Flux)).
**Production tool:** Higgsfield AI (short-form video + image generation).
**Governs:** a launch batch of short-form video (9:16, 15–30s) and still image
ads for paid social and organic.
**Owner:** Harry · **Date:** 2026-11-03 · **Status:** draft for production.

> **Lens.** This brief is written through the [marketingskills](https://github.com/coreyhaines31/marketingskills)
> frameworks: `product-marketing` (positioning foundation), `social` (pillars,
> hooks, no-AI-tells), `ad-creative` (angles, awareness stages, format tiers,
> grounding), `video` and `image` (production). Section 1 is the
> `product-marketing` context every other section builds on; it can be lifted
> into `.agents/product-marketing.md` so future marketing work reuses it.

---

## 1. Positioning context (the `product-marketing` foundation)

**One-liner.** MESH cuts your LLM API bill and only charges a cut of the savings
it can prove — on a ledger you recompute yourself.

**Category.** LLM cost optimisation / FinOps for AI, in a market where tools
routinely claim 70–90% and independent tests find low single digits. The
credibility gap *is* the positioning.

**ICP (priority order).**
1. Founders / eng leads at AI-native startups spending $5k–$500k/mo on Claude or
   OpenAI. Feel the bill monthly; can try a proxy today.
2. Senior AI/platform engineers running long-lived agents. Technically
   skeptical, allergic to marketing claims, will screenshot a bad number.
3. Indie devs / agent builders whose side-project bill got scary. High
   virality, small deal size, top-of-funnel fuel.

**Differentiators (the only claims we lead with).**
- Billed on *verified* savings; already-optimised stacks get `do_not_charge`.
- Per completed task, not per request. A changed answer is a failed task and
  voids its savings.
- Hash-chained ledger; the invoice is a pure function you recompute to the cent.
- One URL to integrate. No SDK, no key handling, any language.
- We publish where we lose (~29% ceiling on busy agents; 0–5% on optimised
  stacks).

**Brand voice.** Dry, specific, confident, zero hype. Real numbers only. If a
line could run on a competitor's ad, cut it. Proof is the aesthetic.

**What we've learned (seed log).** The market's distrust is earned (trimmers
claiming 60–90% measured 3.7% combined; the top-funded router ranked last on
RouterArena). Our wedge is being the one brand that shows its work. Honesty is
not a tone here, it is the product.

## 2. Objective & KPIs

Primary objective: get qualified developers and founders to run the one-command
pilot (`npx -y -p @mesh-ai/sdk mesh-proxy`) and quote themselves from their own
logs.

North-star metric: **pilot starts** (proxy run or export submitted), tracked per
creative. Supporting, in the `social` skill's order of value:

| Tier | Metric | First-30-day target |
|---|---|---|
| Hook | 3s view-rate | ≥ 30% |
| Hold | avg watch time on 20s cuts | ≥ 60% |
| Engagement | comments + saves (weighted above likes) | rising week over week |
| Action | link CTR to repo / start page | ≥ 2.5% |
| **Outcome** | **pilot starts per creative** | the number we optimise |

Likes and raw reach are reporting-only. We sell "measure it yourself," so we
optimise to the measured action.

## 3. Audience by awareness stage (`ad-creative` lens)

Map every creative to where the viewer is, because the hook changes:

| Stage | Who | What the creative does |
|---|---|---|
| Problem-aware | founder watching the bill climb | name the hidden cost (the "memory tax") |
| Solution-aware | eng who tried a trimmer | show why per-request trimming lies; per-task is the fix |
| Product-aware | compared cost tools | the `do_not_charge` / recompute-it-yourself differentiators |
| Most-aware | read the repo | the one-line integration, as the push to run it |

Most paid cold traffic is problem- or solution-aware. The `do_not_charge` and
recompute angles are the product-aware closers, not the cold hook.

## 4. Message spine & angles

Spine: **you are paying your LLM bill twice, and MESH only charges you for the
half it gives back.**

Angles (from the `ad-creative` angle taxonomy), ranked by how well they travel:

| Angle | Line (on-screen copy, no-AI-tells compliant) |
|---|---|
| Pain point | "Your agent re-buys its whole memory every turn." |
| Contrarian | "They claim 90%. Independently measured: 3.7%." |
| Identity | "An AI cost tool that tells you not to pay it." |
| Comparison | "Trimmers count tokens. MESH counts finished tasks." |
| Outcome | "18.2% off live spend, on a ledger you recheck yourself." |

Hard rule: every number on screen traces to `docs/site/evidence.md`, with the
same simulator-vs-live label the site uses.

## 5. Creative platform: "The Honest AI Ad"

One repeatable device that turns the brand/tool tension into the hook. Open on a
gorgeous, over-produced Higgsfield shot plus a hype claim, then break the
illusion and replace it with a receipt. The glossy AI look becomes the setup for
the punchline, so Higgsfield's native style is an asset, not a liability.

Reality check from the `ad-creative` format tier list: founder-fronted and
creator/UGC formats are the reliable **cold-traffic scalers**; faceless
cinematic is usually **mid-funnel supporting cast**. So we lead cold acquisition
with founder and UGC cuts (§6 C1/C2) and use the cinematic concepts as
high-ceiling brand swings and retargeting, not as the whole top of funnel.

## 6. Short-form video concepts

9:16, 15–30s, captions burned in, repo URL on the end card. Ordered by funnel
role, not by gloss.

### C1 — Founder piece (S-tier cold scaler) — Harry to camera
- **Angle / stage:** identity + contrarian / problem-aware.
- **Hook (0–3s):** "I built an AI cost tool, and the first thing it does is tell
  some people not to pay me."
- **Body:** 20s, plain, one proof point: most agents never turn on the provider
  cache, so they re-pay for their whole history every turn; MESH fixes that and
  only bills the saving. End on "run it on your own logs."
- **Higgsfield role:** light B-roll / stylised cutaways only. The founder is
  real footage (or a HeyGen digital twin of Harry if volume is needed), not a
  generic AI avatar. Authentic beats polished here.

### C2 — UGC / creator series (volume cold scaler)
- Short, deliberately low-gloss presenter delivering **one angle from §4** in
  15s, straight to camera. Produce 4–5, one angle each, rotate as paid creative.
- **Higgsfield role:** talking-avatar/Speak for cheap per-angle variants, or a
  real creator. Keep it looking native, not cinematic.

### C3 — "Claim vs Receipt" (cinematic brand hero / retargeting)
- **Stage:** product-aware.
- **Hook (0–2s):** lush neon-city billboard reading "SAVE 90% ON AI," cinematic
  crash-zoom.
- **Turn (2–6s):** record-scratch, the shot glitches and shatters to black.
- **Payoff (6–20s):** real terminal/motion-graphic overlay types
  `independently measured: 3.7%` → `MESH, live traffic, verified: 18.2%` →
  `invoice: recompute it yourself`.
- **Higgsfield role:** Soul + a camera-motion preset for the billboard hero. The
  terminal is a real screen recording or precise overlay, never AI-generated
  (models garble text, and devs spot fake dev UI instantly).

### C4 — "do_not_charge" (brand / shareable)
- **Stage:** product-aware. **Angle:** identity.
- A salesperson-coded cinematic character says "let me show you our invoice,"
  reveals a total line reading `do_not_charge — your stack is already
  optimised`, beat of silence, "yeah, we tell people not to pay us."
- Most on-brand idea in the set. Lead organic with it.

### C5 — "Your agent has amnesia" (metaphor)
- **Stage:** problem-aware. A consistent character wakes in the same room,
  confused, on a loop — the agent re-reading its whole history every turn.
  Caption: "every turn it forgets, re-reads everything, and re-pays for all of
  it." Payoff: MESH keeps that history on the cached rate and refuses placements
  that would cost more.
- **Higgsfield role:** image-to-video with character consistency (its strength).

### C6 — "One line" (integration)
- **Stage:** most-aware, closer. Split screen: migration chaos vs calm, then one
  line appears: `new Anthropic({ baseURL: "http://127.0.0.1:8787" })`. "That is
  the whole integration. Your key never leaves your machine."

**Sequencing.** Cold: C1 + C2 carry acquisition. Organic/share: C4 first, C3
second. Retargeting / brand: C3, C5. Closer: C6. Hold C5/C6 for wave two once a
winning hook is known.

## 7. Image concepts

Stills for feed (1:1, 4:5) and stories (9:16). Generated scenes via Higgsfield
Soul; all numbers, code and claims live in a controlled overlay layer, never
inside the generated frame (text rendering is unreliable and this is where
credibility leaks).

- **I1 — Stat Callout: the memory tax.** Moody desk scene, one overlay: "each
  output token gets re-read ~27 more times. you pay for every read."
- **I2 — `do_not_charge` card.** Pure typographic, protest-poster energy, the
  invoice line as hero type. No scene.
- **I3 — The honest band chart.** Our per-segment table (37.9% cache-only,
  57.7% async, 0–5% do-not-pay-us) as a clean editorial graphic. The spread is
  the message.
- **I4 — FAQ Card: the objection.** Take a real skeptic objection ("you're
  billing a counterfactual, how is that not made up?") as the headline, answer
  it in two lines (defined baseline, provider-verbatim usage, recompute it).
  This is the `ad-creative` grounding move: objections become FAQ-card ads.
- **I5 — Carousel "we published where we lose."** Slide 1: "an AI cost tool
  that prints its own ceiling." Then ~29% busy-agent ceiling, why, then the repo
  link. LinkedIn/segment-1 gold. Use the Problem-Proof carousel structure.

## 8. Higgsfield production notes (`video` + `image` lens)

- **Where Higgsfield wins:** stylised cinematic hero shots and camera motion
  (C3/C4), image-to-video with character consistency (C5), fast UGC/avatar
  variants (C2), and Soul stills (§7).
- **Where to reach for something else:** if a founder talking-head needs
  volume, a HeyGen digital twin of Harry beats a generic AI avatar (avoids
  uncanny valley). If a hero cut needs synced spoken audio at top quality,
  consider Veo 3 for that single shot. Pick the tool after the concept, never
  before.
- **Never AI-generate the technical surfaces.** Terminals, code, invoices,
  ledger JSON, dashboards = real screen recordings or precise motion graphics
  with real values. Fabricated dev UI is the fastest way to lose ICPs 1 and 2.
- **Keep text out of generated frames.** All numbers/code/claims go in the
  overlay layer where we control them exactly.

## 9. Vertical-video production spec (applies to every 9:16 cut)

- **Text-safe zone:** keep all captions and key graphics inside the central
  720×1200 band; platform UI crops the edges differently. Most-missed rule.
- **Captions always** (≈85% of social video is watched sound-off): white fill +
  black stroke, no pill, auto-sized to stay inside the safe zone.
- **Aspect ratios:** 9:16 social, 1:1 feed stills, 16:9 only for YouTube/site.
- **Music:** prefer the platform's organic library for reach on TikTok/Reels;
  baked-in licensed music can suppress distribution.
- **Authentic over polished** on TikTok; save the gloss for the deliberate C3/C4
  setups.

## 10. Organic content pillars (for the always-on feed)

| Pillar | Share | For MESH |
|---|---|---|
| Industry insight | 30% | honest LLM-cost benchmarks, the claim-vs-measured gap |
| Behind-the-scenes | 25% | building MESH, including a lever that lost money and how the ledger caught it |
| Educational | 25% | how LLM billing and prompt caching actually work |
| Contrarian / hot take | 15% | "most AI cost tools are measuring the wrong unit" |
| Promotional | 5% | pilot, product updates |

## 11. House style for all copy (`social`/`copywriting` no-AI-tells)

The brand and the skill agree here, so this is non-negotiable in every script,
caption and post:
- No "it's not X, it's Y" / "not because X, because Y" contrast reveals. State
  the point directly with the reason.
- No negation lists, no trailing restating clauses, no self-answered questions
  or colon reveals as a device.
- No stock phrases ("unlock," "say goodbye to," "take it to the next level,"
  "here's the thing").
- **No em dashes in copy.** Use a period or a line break.
- No broetry (one sentence per line throughout), no engagement bait ("thoughts?
  agree?"), no manufactured vulnerability, no emoji-as-bullets.
- One list-of-three or fragment per post, maximum. Fill every hook shape with a
  real number or fact, never a generic claim.

## 12. Grounding & measurement

- **Grounding (`ad-creative`).** Pull copy from real developer language, not
  invention: the repo's own FAQ and comparison pages, and real objections from
  HN / Reddit / X threads about AI cost tools. Once ads run, mine ad comments
  and replies. Objections become FAQ-card creatives (I4).
- **Falsifiable test, stated up front.** *Among cold engineering traffic (ICP
  1–2), founder/UGC cuts (C1/C2) will produce a lower cost-per-pilot-start than
  the cinematic cut (C3) over the first 5,000 impressions each.* Metric:
  cost per pilot start. Comparison: C1/C2 vs C3. Expected direction: founder/UGC
  lower. Resolve this before scaling spend.
- **Cadence.** Launch: C1, C4, I2, I5. Always-on: 3–5 C2 variants/week, kill a
  hook under 20% 3s-view after ~5k impressions. Wave two: C3, C5, C6 once the
  winning hook is known. Refresh all stats monthly with the latest *live*
  export so claims stay current and true.
- **UTMs** map every creative to pilot starts, not just clicks.

## 13. Compliance (because it is the brand)

Every public number traces to `docs/site/evidence.md` and carries its
simulator-vs-live label exactly as the site states it. When a figure is a
simulated band, say so or use the live figure instead. We are the company that
publishes its losses; one inflated ad number burns the only thing we sell.
