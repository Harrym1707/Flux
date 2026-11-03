# Morning brief — 2026-10-29

Overnight work on branch `levers-shim-blind-gateway` (pushed). Nothing deployed, nothing on
`main`, full test suite green (**469/469**). Here's what to review and the decisions waiting.

## Overnight update (after your four answers)

You answered before sleeping, so I kept building:
- **Built: the per-user policy module** (`packages/sdk-js/src/theo-policy.ts` + 7 tests) — the concrete
  Theo→FLUX control mechanism. `policyToReductionConfig` enforces the safety rule *in code*: a lossy
  lever applies only if it carries a gate proof within the route's quality ceiling, else it's silently
  withheld. Default policy is strict + lossless-only. It's `node:`-free, so it loads in RN/edge too.
- **Decisions you made (now the roadmap):** coding lever = **routing primary + context secondary**;
  subscription = **free loss-leader for now** (only bill where there's a token bill); RN/edge =
  **near-term, do the node:fs decouple together** (not unsupervised); next-after-policy was the policy
  module (done).
- **Your call-outs for when you're up:** the node:fs decouple (with me), and the Claude Code Max/Team
  OAuth reachability test (needs your login).

## Review in this order

1. **The Theo loop running** — `node --import tsx evals/theo-loop.ts` (30 seconds, no spend). It's
   the clearest thing: tonight's design, alive on a sample coding workload.
2. **Reachability matrix** — `docs/strategy/coding-tool-reachability.md` + the one open question below.
3. **Theo design doc** — `docs/rnd/theo-token-engineer-agent.md` (the full sketch we worked out).

## What got built (tested, committed, not deployed)

| Thing | File | What it is |
|---|---|---|
| **Theo loop prototype** | `evals/theo-loop.ts` (+ test) | observe (blind features) → hypothesise (rank priors) → measure real lossless → queue lossy for the gate → policy → report. Runs end-to-end, no API spend. |
| **Theo design** | `docs/rnd/theo-token-engineer-agent.md` | the whole per-user agent design from tonight. |
| **Coding reachability** | `docs/strategy/coding-tool-reachability.md` | sourced matrix of which coding tools FLUX can intercept. |
| **wrapFlux real-SDK proof** | `evals/fundamentals/value/wrapflux-real-sdk.test.ts` | verified the shim works on the REAL `@anthropic-ai/sdk` (the earlier Proxy bug does not exist). |

## Theo loop — what it shows, and the catch I fixed

It demonstrates the design is **mostly wiring over pieces that already exist**: `extractBlindFeatures`
(his senses), `projectSavings` (his hypothesis engine), the real `reduceRequest` (his hands), the
replay gate (his conscience). On the sample coding session it correctly learned the workload *from
features only* (never the code), measured the real lossless saving, and queued the lossy levers for
the gate.

**The catch worth knowing:** my first version printed *"I can save you ~80.6%"* — a stacked model
projection, exactly the Caveman number we've spent the whole build avoiding. I caught it and rewrote
Theo to be **honest by construction**: he leads with the *measured* lossless number (~6% here),
treats projections as **unproven priors for test-ordering only — never quoted to the user**, and
promises no number until the live gate proves it. A test pins the lossless figure under 30% so Theo
*cannot* regress into quoting an inflated number. This is the single most important property of the
prototype.

## Reachability — the matrix, and the ONE thing to settle

- **Reachable (FLUX can intercept 100% of model traffic):** Claude Code, Cline, Aider, Continue.dev, Zed.
- **Partial:** Cursor (base-URL override only on Chat/Composer, still transits their backend; Tab locked);
  GitHub Copilot (only the CLI/SDK, not the IDE extension).
- **Not reachable:** Windsurf (endpoint hard-coded + signed; "BYOK" still routes through their proxy).
- **Key finding:** BYOK ≠ reachable — several tools take your key but still backend-route.

**The open question that gates the coding play:** Claude Code is cleanly reachable on the **API-key**
path, but the **Max/Team subscription (OAuth)** path — which is *exactly* where "running through Claude
licenses" bites — is **undocumented**. I marked it UNKNOWN, not promised. **Settling this empirically
(does Claude Code on a Max login honour a custom base URL?) is the highest-leverage next verification**
for coding. If yes, the licenses play is real; if no, coding is API-key users only.

## Honest numbers recap (nothing went up tonight — on purpose)

- **18.2% live** remains the only real number, on our own authored basket.
- **A5 proven live: 5.3% output, 0 quality regression** (floor; verbose chat pays more).
- **A2 honesty fix:** de-claimed phantom whitespace — the provider-independent `count_tokens` check
  caught us over-claiming 48 tokens (100%) on a real catalogue; now 0 = 0.

## Decisions waiting for you

1. **The Claude Code OAuth reachability test** — settle the licenses question (I can run it with you).
2. **The coding angle** — confirm: lead with *model routing* (cheaper model per step, gated on tests)
   on the reachable set, Claude Code first.
3. **Subscription pricing** — how FLUX charges when the "saving" is a stretched flat fee, not £ off a bill.
4. **Theo next step** — the grader stack (behavioural-drift) is the deepest real build; want that next?

## What I deliberately did NOT do

**The `node:fs` decouple (RN/edge support).** It's a 3-layer refactor touching the billing core
(core barrel Stripe sink + the ledger + wrap.ts), and I said all night a billing bug is the one thing
we can't ship — so I would not do it unsupervised overnight. It's scoped and ready for a focused,
test-gated pass with you awake. Node/serverless-with-fs backends work today regardless.
