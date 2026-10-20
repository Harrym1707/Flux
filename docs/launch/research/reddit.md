# Reddit community research — venues, language, mechanics (2026-10-20)

(Threads harvested via search listings of real reddit URLs; verify each sub's
rules in-app immediately before posting — several changed rules mid-2026.)

## Ranked venues

| # | Subreddit | Size | Rules that matter | Verdict |
|---|---|---|---|---|
| 1 | r/ClaudeCode | ~449k, fastest-growing | Sharing your own build IS the main activity ("Built with Claude" flair = 41% of posts); removes empty showcases and "paid products disguised as workflow tips" | LAUNCH FIRST — text post, full measurement writeup |
| 2 | r/ClaudeAI | 1.2M | Rule 7: feed Showcase needs 50+ account karma, else the Showcase Megathread; mod-bot auto-redirects | Launch 2nd (needs karma) |
| 3 | r/LLMDevs | 176k | Stricter since mid-2026; disclosure required; "concrete results, tradeoffs, implementation notes get upvoted; vague marketing ignored" | Launch 3rd as engineering writeup |
| 4 | r/AI_Agents | ~250k | Promo tolerated inside discussion; founders answer cost threads with disclosure | Comment-first venue |
| 5 | r/mlops | 40k | "Vendors behave!" — explicit Self-Promotion flair; technical + disclosed OK | Post with flair; verification/attribution angle |
| 6 | r/ChatGPTCoding | 405k | Weekly Self Promotion Thread only | Weekly thread + comments |
| 7 | r/selfhosted | 858k | Projects <3 months old → New Project Megathread; tools Wednesdays only; closed source must be explained — expect "source?" as top comment | Only after the MIT-verifier decision |
| 8 | r/SideProject | 848k | Self-promo is the premise; "[Name] - [desc]" titles; no email gate | Low-priority bonus |
| 9 | r/OpenAI | 2.8M | Self-promo link posts banned; 1/10 ratio | COMMENTS ONLY |
| 10 | r/LocalLLaMA | 854k | Culture-enforced hostility to cloud-API tooling; accounts forensically audited; AI-written copy banned | DO NOT LAUNCH — disclosed comments in hybrid-stack threads only |
| — | r/MachineLearning, r/artificial | — | promo thread / modmail only | Skip |

## Language guides (real titles quoted)

- r/ClaudeCode / r/ClaudeAI — "humbled builder": "I built a token usage
  dashboard for Claude Code and the results were humbling" (100+ comments);
  "I built a zero-setup cost tracker... because I was tired of burning
  through limits blindly (open source)"; "...Cost me $44 in one day". Formula:
  pain → zero-setup → honesty payoff. npx one-liner in first three lines.
  Community jokes about cache TTL ("turned bathroom breaks into a financial
  decision") — reusable pain.
- r/LLMDevs — "prove it": "Cut our token spend 40% but trying to prove
  quality didn't drop" (their live anxiety = our exact product); "How much
  are AI routers actually cutting your token spend?" (skeptical register);
  receipts like "$377→$29 on 508 tools". Percentages + dollars + method +
  tradeoffs.
- r/mlops — "post-mortem with a dashboard": "Our LLM bill was not the tokens.
  It was the retries." (one surprising measured fact as the title); warning:
  a "pay us 50% of what you spend" pitch got dissected — pricing stated after
  verification mechanics, never before.
- r/selfhosted — "single binary, no telemetry": "LLM-Shield: Self-hosted
  privacy proxy for cloud LLMs" landed; "No phone-home, no telemetry" is the
  applause line. LiteLLM 1.82.7/1.82.8 COMPROMISE IS FRESH MEMORY — a proxy
  touching API keys gets security-audited in the first five comments;
  pre-empt what leaves the machine.
- r/OpenAI — "sticker shock": "GPT api is waaay to expensive" (200+ comments,
  typo included — polish is not the currency).

## Natural-thread playbook

Recurring complaint genres to answer (sort by new in r/AI_Agents, r/LLMDevs,
r/ClaudeCode, r/mlops): runaway spend ("can't figure out where the leak is",
"nothing paged"), caching confusion (cache_control placement, TTL choice),
API-vs-subscription shock ("burned through 1000$ equivalent in 3 days"),
router skepticism, verification anxiety ("prove quality didn't drop"), budget
guardrails ("a leaked key can't cost me more than $50").

The disclosure formula is load-bearing: answer the question FULLY first, then
one line — "Full disclosure, I built a local proxy (flux-proxy) that does
this automatically and logs the before/after per request so you can recompute
the savings yourself — but you can do it by hand with the above." The
do-it-by-hand escape hatch separates helpful from spam. Mentioning a
competitor or DIY alternative alongside increases survival.

## Mechanics

- Warm accounts 1–2 weeks with genuine link-free comments first (fresh
  account + launch post = classic removal; r/LocalLLaMA screenshots comment
  histories). r/ClaudeAI needs 50+ karma for feed Showcase.
- Text posts only; never a URL in the title; GitHub/npm link mid-body after
  the measurements (fluxtoken.dev is a young domain — spam filters).
- One sub per day, rewritten per sub; 9 helpful contributions per promo one.
- Timing: Tue–Thu 1400–1700 UTC for US-dev subs.
- Flairs: Built with Claude (r/ClaudeCode), Showcase (r/ClaudeAI),
  Self-Promotion (r/mlops), Release (r/selfhosted Wednesdays).
- Write posts BY HAND with at least one imperfection; AI-written copy is
  detected and punished (320+-comment meta-threads exist about it); no
  em-dash-heavy prose, no emoji, no "slash/supercharge/game-changer".
- Sequel etiquette: nothing about the same tool within ~30 days; the
  acceptable follow-up is a new MEASUREMENT.

## FLUX-specific pitfalls

1. LiteLLM compromise memory → security framing: nothing leaves the machine
   except the normal provider call; ledger is local; audit path for the npm
   package.
2. "npx -y from a stranger = RCE" → pair the one-liner with "or read the
   source first: [repo]".
3. %-of-savings pricing draws auditors → recomputable-ledger first, price
   after, losing cases in the post body.
4. Savings-claim inflation is the native sport to dunk on → publish the
   losing workload shapes in the launch post itself.
5. Closed source handicaps r/selfhosted + r/LLMDevs → the MIT-verifier split
   materially helps here too.

## Sequence

Warm accounts (2 wks) → r/ClaudeCode → r/ClaudeAI Showcase → r/LLMDevs
writeup → r/mlops (flair) → r/ChatGPTCoding weekly thread → r/selfhosted
Wednesday (only if verifier is MIT) → ongoing comments in r/AI_Agents +
r/OpenAI. Skip r/LocalLLaMA, r/MachineLearning, r/artificial.
