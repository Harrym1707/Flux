/**
 * node --import tsx evals/run-fanout-serialization.ts
 *
 * Lever P5 in docs/rnd/lever-backlog.md: shared-prefix fan-out serialization.
 *
 * WHY THIS SHAPE: LangGraph's `Send` API (and the equivalent in CrewAI /
 * AutoGen / the Claude agent SDK's sub-agent dispatch) fans a routing
 * function's output out to N parallel graph nodes that the runtime executes
 * TOGETHER in the next super-step — wall-clock time tracks the SLOWEST
 * branch, not the sum of branches, because they are genuinely concurrent,
 * not queued (LangGraph docs / forum, checked 2026-10-27; see this file's
 * sibling NOTES for the search). When those N sub-agents share one
 * orchestrator-authored system prompt and tool catalogue — the normal case,
 * since they are usually the same role template fanned out over N work
 * items — every one of their first requests races the others for a
 * provider prompt-cache entry that does not exist until the FIRST
 * response's first byte arrives. `evals/run-workload-matrix.ts`'s own
 * multi-agent fixture never surfaces this: it staggers sub-agents 4 SECONDS
 * apart within a round specifically so each one already finds the previous
 * one's entry waiting — a convenient fiction the old cache simulator
 * encoded for free, because it made every written entry instantly visible
 * to any later request regardless of real timing. That bug/feature is now
 * `visibleAfterSeconds` on `SimulatedRequest` (packages/core/src/cache-simulator.ts):
 * an entry is invisible to a sibling until the write's own time-to-first-byte
 * has elapsed, matching the documented mechanism.
 *
 * This file restates the fan-out band under that corrected concurrency
 * model (DOWN from the old implicit assumption, per the backlog's own
 * instruction: "restate the multi-agent band under [corrected] semantics
 * first — it will come down"), then measures FLUX's fix: a proxy-side
 * latch (packages/sdk-js/src/fanout-latch.ts, wired into proxy.ts behind
 * `serializeFanOut`) that holds same-prefix siblings until the leader's
 * response has actually started, converting N-1 racing writes into N-1
 * orderly reads. Bytes are never touched — only send timing moves — so
 * this is LOSSLESS, same class as the cache stamp itself.
 *
 * Honesty labels, read before quoting anything from this file:
 * - The cache mechanics (minimum prefix, TTL, write/read multipliers) are
 *   the same documented-rules simulator every other published number in
 *   this repo uses: SIMULATOR-MEASURED.
 * - The write time-to-first-byte (`writeTtfbSeconds` below) is an ESTIMATE,
 *   not a measurement — no capture in this repo carries request timestamps
 *   (lever-backlog.md item 3 under "open questions"). It is deliberately
 *   conservative-small (sub-second for this fixture's prefix size) so the
 *   lever's credit is not inflated by an exaggerated race window.
 * - The fixture is a DESIGNED 100%-collision fan-out (every round, every
 *   agent dispatched at the identical instant) to isolate the race's cost
 *   in the cleanest possible case. The honest fleet-wide volume — what
 *   share of real multi-agent traffic actually collides this tightly — is
 *   UNMEASURED, exactly as lever-backlog.md's P5 section already says.
 *   Nothing here is a claim about aggregate savings across a customer
 *   fleet; it is a claim about what this one documented race costs, and
 *   that FLUX's fix removes it, when it happens.
 */

import {
  ANTHROPIC_CACHE_5M,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";

const AT = "2026-10-19"; // same pricing date as run-workload-matrix.ts, for comparability
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// --- The shared fan-out prefix: one orchestrator-authored role template ----

const SYSTEM_PROMPT =
  "You are a specialist agent fanned out by an orchestrator to work one item of a batch in parallel with your " +
  "siblings. Follow the runbook precisely: validate your assigned item against the schema, consult only the " +
  "tools listed below, never touch another agent's item, write a terse structured result, and surface any " +
  "ambiguity to the orchestrator rather than guessing. ".repeat(10);

const TOOLS = Array.from({ length: 8 }, (_, index) => ({
  name: `worker_tool_${index}`,
  description:
    `Worker tool ${index} reads and writes subsystem ${index} state for exactly one item at a time, validates ` +
    "its arguments against the schema below, retries once on a transient failure, and returns a compact JSON " +
    "result the agent must not re-summarize before reporting it upward.",
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { itemId: { type: "string" }, action: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["itemId", "action"],
  },
}));

const SHARED_PREFIX = JSON.stringify({ system: SYSTEM_PROMPT, tools: TOOLS });
const sharedPrefixTokens = approximateTokenCount(SHARED_PREFIX);

const AGENTS = ["worker-0", "worker-1", "worker-2", "worker-3"];
const ROUNDS = 6;
// Spaced PAST the 300s TTL on purpose: each round is a fresh orchestrator
// session (a new fan-out team spun up roughly every ~7 minutes), so every
// round pays its own cold-start race rather than riding a cache an earlier
// round already warmed. A gap inside the TTL would let round 0 alone absorb
// the whole race and understate the recurring cost; this is the harder,
// more representative case.
const ROUND_GAP_SECONDS = 400;

/**
 * Anthropic's documented time-to-first-byte for a cold prefix write scales
 * with prefix size (the provider has to actually process the tokens before
 * it can start the cache write and the response). No capture in this repo
 * carries timing, so this is a small, clearly-labelled ESTIMATE — not a
 * measurement — chosen to be conservative rather than favorable to the
 * lever: real writes of this size are very plausibly slower, which would
 * make the race worse and the fix worth more, not less.
 */
function writeTtfbSeconds(prefixTokens: number): number {
  return 0.4 + prefixTokens / 4_000;
}

const ttfb = writeTtfbSeconds(sharedPrefixTokens);

type Round = { atSeconds: number; agent: string; prompt: string };

function buildRounds(): Round[] {
  const rounds: Round[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const agent of AGENTS) {
      rounds.push({
        atSeconds: round * ROUND_GAP_SECONDS,
        agent,
        prompt: `${SHARED_PREFIX}\nAssigned item for ${agent}, round ${round}: process item ${round}-${agent} per the runbook.`,
      });
    }
  }
  return rounds;
}

const OUTPUT_TOKENS = 180;

/** Today, with no latch: every agent in a round sends at the SAME instant. */
function naiveConcurrentArm(rounds: Round[]): SimulatedRequest[] {
  return rounds.map((r) => ({
    atSeconds: r.atSeconds,
    prompt: r.prompt,
    outputTokens: OUTPUT_TOKENS,
    visibleAfterSeconds: ttfb,
  }));
}

/**
 * With the proxy latch: the first agent per round (arbitrary — the latch
 * does not care which) sends immediately and is the leader; every sibling
 * is held until the leader's response has started, then sent in order.
 * This is exactly what `fanout-latch.ts` does — modelled here as a tiny
 * send-time delay on the followers, not a byte changed anywhere.
 */
function latchedArm(rounds: Round[]): SimulatedRequest[] {
  const byRound = new Map<number, Round[]>();
  for (const r of rounds) {
    const list = byRound.get(r.atSeconds) ?? [];
    list.push(r);
    byRound.set(r.atSeconds, list);
  }
  const out: SimulatedRequest[] = [];
  for (const group of byRound.values()) {
    const [leader, ...followers] = group;
    out.push({ atSeconds: leader!.atSeconds, prompt: leader!.prompt, outputTokens: OUTPUT_TOKENS, visibleAfterSeconds: ttfb });
    followers.forEach((follower, index) => {
      // Followers are sent in order, each strictly after the leader's
      // response has started -- the latch's entire mechanism. The small
      // per-follower stagger (1ms) only breaks ties in the simulator's own
      // timestamp ordering; it has no bearing on the provider's real TTL.
      out.push({
        atSeconds: leader!.atSeconds + ttfb + (index + 1) * 0.001,
        prompt: follower.prompt,
        outputTokens: OUTPUT_TOKENS,
        visibleAfterSeconds: ttfb,
      });
    });
  }
  return out;
}

const rounds = buildRounds();
const naive = simulateCache(naiveConcurrentArm(rounds), ANTHROPIC_CACHE_5M, price.price, { countTokens: approximateTokenCount });
const latched = simulateCache(latchedArm(rounds), ANTHROPIC_CACHE_5M, price.price, { countTokens: approximateTokenCount });

const savingUsd = naive.totalCostUsd - latched.totalCostUsd;
const savingPercent = naive.totalCostUsd === 0 ? 0 : (savingUsd / naive.totalCostUsd) * 100;

console.log("FLUX fan-out serialization (lever P5) -- shared-prefix multi-agent race, corrected simulator");
console.log(`shared prefix: ${sharedPrefixTokens} tokens (clears the ${ANTHROPIC_CACHE_5M.minimumCacheableTokens}-token minimum); ` +
  `estimated write TTFB ${ttfb.toFixed(2)}s (ESTIMATE, not measured -- see header)`);
console.log(`${ROUNDS} rounds x ${AGENTS.length} agents fanned out at the identical instant per round, ${ROUND_GAP_SECONDS}s apart\n`);

console.log(`naive concurrent (today, no latch)   $${naive.totalCostUsd.toFixed(4)}  hits ${(naive.hitRate * 100).toFixed(0)}%  ` +
  `miss reasons: ${JSON.stringify(naive.missReasons)}`);
console.log(`FLUX latch (serializeFanOut: true)   $${latched.totalCostUsd.toFixed(4)}  hits ${(latched.hitRate * 100).toFixed(0)}%  ` +
  `miss reasons: ${JSON.stringify(latched.missReasons)}`);
console.log(`\nlatch-alone saving vs naive concurrent: ${savingPercent.toFixed(1)}% ($${savingUsd.toFixed(4)}) -- ` +
  `timing-only, same bytes, same stamp, same TTL policy on both arms.`);

const raceLosses = naive.missReasons["not-yet-visible"] ?? 0;
const totalRequests = rounds.length;
console.log(`\n"not-yet-visible" (a real race loss, not an absent prefix) hit ${raceLosses}/${totalRequests} requests in the ` +
  `naive arm and ${latched.missReasons["not-yet-visible"] ?? 0}/${totalRequests} with the latch.`);

if (savingPercent <= 0) {
  console.log("\nWARNING: the latch did not save anything on this fixture -- a finding, not a failure; investigate before publishing.");
  process.exitCode = 1;
}

console.log("\nScope and what remains before this could ever bill anything (lever-backlog.md P5 adversarial conditions, unaddressed here):");
console.log("- Real collision frequency/volume across a customer fleet is UNMEASURED; this fixture is a designed 100% collision.");
console.log("- The proxy's prefix key (fanout-latch.ts: provider+model+system+tools) is a coarse approximation of FLUX's own");
console.log("  stamped breakpoint bytes, not yet byte-matched against the provider's real cache key.");
console.log("- No production latency/timeout/429 telemetry exists yet for the held-request path (serializeFanOut defaults OFF).");
console.log("- This measures the mechanism's ceiling on a clean race, not a billable number -- record-only until those land.");
