# Product Hunt draft: 2026-10-28 (NOT POSTED)

**Name:** FLUX

**Tagline (60 chars max):** Stop paying twice for the same tokens

**Topics:** Developer Tools, Artificial Intelligence, Open Source

**Description (260 chars max):**
A local proxy that cuts your Claude and OpenAI bill at the request level. One URL, a Claude Code
plugin (/flux), no telemetry. Up to 72.8% simulated, 18.2% live. You pay 1% of savings you can
verify from your own ledger.

**Gallery, slide by slide**

1. Hero: "Stop paying twice for the same tokens." Dam the beaver holding the receipt (see
   2026-10-28-brand.md; the art isn't commissioned yet).
2. The three numbers with their labels: up to 72.8% (simulator, one-shot templated traffic that can
   wait) · 38.1% (live, a coding agent) · 18.2% (live, net, 30 requests).
3. Install: `npx -y -p @flux-ai/sdk flux-proxy` · `npm install @flux-ai/sdk` ·
   `claude plugin marketplace add Harrym1707/Flux && claude plugin install flux@flux`.
4. The receipt: the 2026-10-26 live export, rows summing to the total (screenshot of the landing
   page's slip).
5. "Caveman makes your agent say less. FLUX makes each request cost less. Use both." with the
   comparison table.

**Maker's first comment**

Hi PH. FLUX started from an annoying discovery. Most agents never opt into the prompt cache, so they
re-buy their own conversation history at full price on every turn.

FLUX is a proxy on your machine. Point `base_url` at it, or type `/flux` in Claude Code, and it
stamps the cache where it will actually pay off, compacts tool schemas losslessly, removes exact
duplicates and keeps per-request clocks out of the cacheable prefix. Responses come back
byte-identical.

The pricing is the unusual part. It's 1% of verified savings, nothing else. Every request writes a
hash-chained event to a ledger *you* hold. The invoice is recomputable from it, and if FLUX saved
nothing it reads `do_not_charge`. Our numbers come with labels: 18.2% net on our latest live export,
38.1% on its coding agent, up to 72.8% in simulation on one-shot traffic that can wait, and 0–5%
(with "do not pay us") on stacks that are already lean. All of them are in docs/NUMBERS.md with the
command that reproduces them.

If you use Caveman, keep it. It shortens what the agent says, and FLUX cuts what each request costs.
They stack.
