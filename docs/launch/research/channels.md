# Growth channel map — research report (2026-10-20)

Compiled from live web research by the growth research agent. "Founder-fired"
= requires a public action under the founder's identity; drafts come from the
agents.

## 1. Channel map (effort × impact × who fires)

| Channel | Effort | Expected impact | Who fires | Mechanism to site |
|---|---|---|---|---|
| tensorchord/Awesome-LLMOps PR (6.0k stars) | 1–2 hrs | Medium, compounding (LLMs scrape it; devs browse Cost Management + Gateway sections) | Founder (public PR) | Link in README → repo → site |
| Other awesome lists (InftyAI/Awesome-LLMOps, KennethanCeyer/awesome-llm + awesome-llmops, awesome-claude-code variants) | ~30 min each | Low each, medium aggregate; high GEO value (GitHub is heavily LLM-cited) | Founder | Same |
| LiteLLM "Projects built on LiteLLM" (docs.litellm.ai/docs/project) | Low if FLUX genuinely integrates | Medium (huge dev audience) | Founder (docs PR) | Docs page → site |
| Langfuse integrations docs (community PRs accepted) | Medium — needs a real integration first | Medium | Founder (PR after integration built) | Integration page → site |
| AlternativeTo.net | 1 hr (account must be 7 days old + verified; review takes days; position as alternative to Helicone/LiteLLM/OpenRouter) | Low direct, HIGH GEO (review/alternative sites are top Perplexity citations) | Founder | Alternative pages → site |
| DevHunt (devhunt.org) | Low; free (~6-month queue) or $49 to pick week; GitHub-login voting | Medium — converts better per visitor than PH for dev tools | Founder | Listing → site |
| Product Hunt | High (full launch prep) | Medium traffic, partly vanity; only ~10% get Featured now | Founder | See §2 |
| Paid AI directories (TAAFT $199, Futurepedia $247–497) | Money | Low-medium | Founder | Skip until revenue justifies |
| console.dev (weekly devtool review) | Low — FLUX fits their published criteria almost perfectly | Medium-high, well targeted | Founder (pitch email) | Review → site |
| TLDR AI (1.1M readers) | Editor-curated; they link primary sources (repos, engineering posts) | High if organically picked | Founder publishes the linkable post; agent drafts | Linked story → site |
| Latent Space / Last Week in AI | High bar; story-driven — pitch the incentive-design mechanism, not the product | High if landed | Founder | Pod/newsletter |
| X build-in-public | Ongoing | Medium-high (swyx/Simon Willison-adjacent discovery; a Willison mention is a top-3 outcome) | Founder posts; agent drafts | Thread → repo/site |
| LinkedIn | Low priority | Low for devs; repost X content, spend nothing | Founder | — |
| MLOps Community Slack #be-shameless | 30 min; explicit promo channel; vendors must disclose affiliation in profile | Low-medium, very targeted | Founder | Post → site |
| Anthropic Discord (project-share/Featured Projects) | Low; read #rules first | Low-medium; perfectly targeted Claude devs | Founder | Showcase → repo |
| LiteLLM Discord | Support presence only — no documented promo lane | — | Founder | — |
| GEO substrate (llms.txt, listings LLMs scrape) | Mostly done | Compounding — PostHog saw 41× AI-platform traffic growth in 12 months from this substrate | Agent + founder listings | Answer engines → site |

Key GEO fact: Reddit overtook Wikipedia as ChatGPT's most-cited domain
(16.7% by mid-2026); Perplexity's commercial answers lean on G2, review
aggregators, and structured comparison sources. Directories LLMs scrape
matter more than directories humans browse.

## 2. Product Hunt — 2026 norms

- One launch in a sequence, not the strategy. Featured rate fell to ~10%;
  algorithm weights genuine engagement + maker replies over raw upvotes.
- Listing mechanics: tagline <60 chars; 240×240 thumbnail (GIF <3MB);
  1270×760 gallery; 60–90s demo video; maker's first comment tells the story
  (for FLUX: the verified-savings ledger + "recompute it yourself").
- Timing: Tuesday or Wednesday, 12:01 AM Pacific; avoid holiday weeks and
  keynote days. Reply to every comment within ~15 min, 9 AM–9 PM PT.
- Self-hunt fine if the account is ≥1 month active.

## 3. Newsletters — honest pitch routes

- console.dev: best fit — published criteria (dev primary user, self-service,
  no sales call, good docs). Pitch = short email with repo + 2-min quickstart.
- TLDR AI: editorially curated; publish a strong technical post and make it
  linkable; paid routes are ads, not coverage — keep separate.
- Latent Space: pitch the mechanism as an incentive-design story ("billing
  only on verified, customer-recomputable savings"), never an announcement.
- Last Week in AI: email the curator one factual paragraph.
- Rule: these channels link PRIMARY TECHNICAL CONTENT, not landing pages.
  The pitchable asset is a measurement post that passes our honesty rules.

## 4. X / LinkedIn

- The cost conversation runs on INCIDENTS: the $47k/11-day agent loop, the
  $592 past a $30 "hard limit", the $1.3M dashboard screenshot. Attach to
  incidents, not abstractions.
- Formats (2025–26 data): first-person story hooks avg 241 likes vs 53 for
  listicles; myth-busting 197 vs MRR-milestones 29; "Day X" logs worst;
  no-hashtag posts outperform #BuildInPublic 4.6×; specific numbers ≈2×.
- FLUX shape: "Our ledger caught our own lever losing $0.0063 — here's the
  receipt" as a story, no hashtags.
- LinkedIn: buyers not users; repost only; spend nothing.

## 5. Discord/Slack

- MLOps Community Slack: #be-shameless allows promo; elsewhere answer
  natively with affiliation disclosed; no unsolicited DMs; no bare links.
- Anthropic Discord: showcase channels only; read #rules first.
- LiteLLM Discord: support presence, not acquisition.

## 6. Conversion — the five load-bearing lessons (PostHog/Plausible playbooks)

1. Time-to-first-value is the conversion event (>10 min loses ~60%; Sentry
   90s, Vercel 30s). FLUX's zero-signup npx IS the funnel; the site's only
   job is getting the command copied.
2. The README is the landing page — devs decide from the repo first; repo and
   site must carry the same quickstart, numbers, honesty.
3. Word-of-mouth dwarfs launches (PostHog ~97% early growth was dev-to-dev
   WOM; HN hit rate ~1 in 10 even for them). The recomputable ledger a
   customer can show their boss is itself the WOM engine.
4. Transparency converts skeptics — published methodology + open verification
   is the single biggest trust lever for a tool that touches API traffic.
5. Attribution lies: add "where did you hear about us?" to the pilot intake;
   build an owned email list rather than renting reach.

## 7. The language of cost pain (verbatim-ish, sourced from HN/dev.to/hackernoon)

- "I kept getting surprise API bills from my agents"
- "a runaway AI agent" / "got a $32 surprise bill"
- "$47,000 burned while everyone slept — two agents talking non-stop for eleven days"
- "My $30 budget cap just cost me $592 — the hard limit was breached but the kill switch hadn't tripped"
- "The cost, the cost, the cost!"
- "Claude is too damn expensive — it makes syntax errors, it fixes them, and it charges us for both"
- "usage-based billing is a total gamble — you don't know how much you'll pay until it's too late"
- "they charge you like you're leasing a Ferrari by the hour"
- "highway robbery in a cashmere suit" / "stupidly expensive"
- "opaque tiers" and "hidden caps" — "feel scammed, with good reason"
- "the math lies by a factor of 5 to 20" — intermediate reasoning racking up 20k–80k tokens
- "burned through my credits"
- "60% of our calls were wasting money on the wrong model"
- "output tokens cost 4–8× more — for agents the output rate dominates your bill"
- "I wanted to stop the agent when it hit a dollar limit… nothing existed"

Copy implication: users speak in SURPRISE / RUNAWAY / BURN / GAMBLE / HIDDEN /
KILL SWITCH — incident language. "Your bill shouldn't be a surprise" mirrors
them; "reduce LLM TCO" does not. Half the pain is DISTRUST of the meter —
which is exactly what a recomputable ledger answers.

## Priority sequence (effort-ranked)

1. Awesome-LLMOps PR + AlternativeTo + console.dev pitch (days; founder one-offs)
2. DevHunt launch, then the technical post TLDR-class newsletters could link
3. X cadence with real ledger numbers (ongoing; founder voice, agent drafts)
4. Product Hunt as a sequenced launch once there's social proof
