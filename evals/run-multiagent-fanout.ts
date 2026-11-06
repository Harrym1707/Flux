import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { planFanoutPrewarm } from "../packages/sdk-js/src/fanout-prewarm.js";
import {
  FANOUT,
  PREWARM_OUTPUT_TOKENS,
  ROUNDS,
  SUBAGENT_OUTPUT_TOKENS,
  buildPrewarmRequest,
  buildSubagentRequest,
  isWellFormed,
  type AnyObject,
} from "./multiagent-fanout-fixture.js";

/**
 * MULTI-AGENT FAN-OUT: an orchestrator dispatches a team of sub-agents in
 * parallel, every sibling sharing an identical prefix (project rules + the
 * round's briefing + tool schemas). Workload shape studied tonight per the
 * founder mandate (alternating nightly with hardening); see
 * docs/rnd/2026-11-06-NOTES.md for the research trail.
 *
 * Three arms, decomposed so the lever's contribution is never confused with
 * simply "caching is on":
 *
 *   A. no MESH, no cache_control at all — the uncached baseline.
 *   B. MESH's cache stamp placed on every request, siblings still dispatched
 *      CONCURRENTLY (the framework's own fan-out timing, unmodified). This
 *      is the honest, unflattering control: it shows a cache stamp with no
 *      sequencing fix is worse than doing nothing on this shape, because
 *      every sibling independently pays the write premium and nothing ever
 *      reads it back.
 *   C. B + planFanoutPrewarm's prewarm barrier (the shipped lever in
 *      packages/sdk-js/src/fanout-prewarm.ts): one pre-warm call per round,
 *      awaited before the real fan-out, so every sibling after it reads the
 *      now-warm cache instead of writing it.
 *
 * Dispatch timing and the provider's cache-commit latency are both real
 * mechanisms with no published numbers to cite, so both are explicit,
 * labelled ASSUMPTIONS, not measurements:
 *
 *   - DISPATCH_SPREAD_SECONDS: how far apart a Promise.all-style fan-out
 *     actually issues N calls from one process. Milliseconds in reality;
 *     0.01s steps here, which is already generous (slower than real dispatch
 *     would only strengthen the race, never weaken it).
 *   - COMMIT_LATENCY_SECONDS: how long after dispatch a cache WRITE becomes
 *     readable by another request. No provider publishes this; it is lower-
 *     bounded by the time to a completed response, and a short agent-team
 *     turn (SUBAGENT_OUTPUT_TOKENS ~= 380) is not instant. 2.5s is a mid-of-
 *     the-road guess, not a measurement — the qualitative result (every
 *     sibling misses when dispatch spread << commit latency) holds for any
 *     commit latency bigger than the dispatch spread, which covers almost
 *     every real value this could take.
 */

const AT = "2026-11-06";
const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed");

const DISPATCH_SPREAD_SECONDS = 0.01;
const COMMIT_LATENCY_SECONDS = 2.5;
const ROUND_SPACING_SECONDS = 60;

type ArmResult = {
  label: string;
  costUsd: number;
  /** Sub-agent calls only (excludes any prewarm calls, counted separately). */
  subagentCalls: number;
  wellFormed: number;
  hitRate: number;
  writtenInputTokens: number;
  cachedInputTokens: number;
  missReasons: Record<string, number>;
};

function price_(
  simulated: SimulatedRequest[],
  label: string,
  wellFormedCount: number,
  subagentCalls: number,
  commitLatency: number,
  policy = ANTHROPIC_CACHE_5M,
): ArmResult {
  const result = simulateCache(simulated, policy, price.price, {
    countTokens: approximateTokenCount,
    cacheCommitLatencySeconds: commitLatency,
  });
  return {
    label,
    costUsd: result.totalCostUsd,
    subagentCalls,
    wellFormed: wellFormedCount,
    hitRate: result.hitRate,
    writtenInputTokens: result.calls.reduce((sum, call) => sum + call.writtenInputTokens, 0),
    cachedInputTokens: result.cachedInputTokens,
    missReasons: result.missReasons,
  };
}

// --- Arm A: no MESH, no cache at all. ---------------------------------------

function runNoCache(): ArmResult {
  const simulated: SimulatedRequest[] = [];
  let wellFormed = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const roundStart = round * ROUND_SPACING_SECONDS;
    for (let agent = 0; agent < FANOUT; agent += 1) {
      const request = buildSubagentRequest(round, agent) as AnyObject;
      if (isWellFormed(request, round, agent)) wellFormed += 1;
      simulated.push({
        atSeconds: roundStart + agent * DISPATCH_SPREAD_SECONDS,
        prompt: wirePrompt(request),
        outputTokens: SUBAGENT_OUTPUT_TOKENS,
      });
    }
  }
  return price_(simulated, "A. no MESH (uncached)", wellFormed, simulated.length, 0, ANTHROPIC_NO_CACHE);
}

// --- Arm B: cache stamp on, siblings still dispatched concurrently. --------

function runStampedNaiveFanout(commitLatency: number): ArmResult {
  const simulated: SimulatedRequest[] = [];
  let wellFormed = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const roundStart = round * ROUND_SPACING_SECONDS;
    for (let agent = 0; agent < FANOUT; agent += 1) {
      const request = buildSubagentRequest(round, agent) as AnyObject;
      if (isWellFormed(request, round, agent)) wellFormed += 1;
      simulated.push({
        atSeconds: roundStart + agent * DISPATCH_SPREAD_SECONDS,
        prompt: wirePrompt(request),
        outputTokens: SUBAGENT_OUTPUT_TOKENS,
      });
    }
  }
  return price_(simulated, "B. MESH cache stamp, naive concurrent fan-out", wellFormed, simulated.length, commitLatency);
}

// --- Arm C: cache stamp + planFanoutPrewarm's barrier. ----------------------

function runStampedWithPrewarm(commitLatency: number): ArmResult {
  const simulated: SimulatedRequest[] = [];
  let wellFormed = 0;
  let prewarmsIssued = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const roundStart = round * ROUND_SPACING_SECONDS;
    const subagentRequests = Array.from({ length: FANOUT }, (_, agent) => buildSubagentRequest(round, agent) as AnyObject);

    // The real lever call: plan a prewarm for this round's batch.
    const plan = planFanoutPrewarm(subagentRequests);
    if (plan.prewarm !== null) {
      prewarmsIssued += 1;
      simulated.push({
        atSeconds: roundStart,
        prompt: wirePrompt(plan.prewarm),
        outputTokens: PREWARM_OUTPUT_TOKENS,
      });
    }
    // The fan-out itself only dispatches once the prewarm's write has
    // committed — that is the entire lever. Without a prewarm this round
    // (should not happen on this fixture; see the `prewarmsIssued` check
    // below), fall back to dispatching immediately, same as arm B.
    const fanoutStart = plan.prewarm !== null ? roundStart + commitLatency : roundStart;
    for (let agent = 0; agent < plan.dispatch.length; agent += 1) {
      const request = plan.dispatch[agent]!;
      if (isWellFormed(request, round, agent)) wellFormed += 1;
      simulated.push({
        atSeconds: fanoutStart + agent * DISPATCH_SPREAD_SECONDS,
        prompt: wirePrompt(request),
        outputTokens: SUBAGENT_OUTPUT_TOKENS,
      });
    }
  }
  if (prewarmsIssued !== ROUNDS) {
    throw new Error(`expected a prewarm every round on this fixture; got ${prewarmsIssued}/${ROUNDS}`);
  }
  return price_(
    simulated,
    "C. MESH cache stamp + fan-out prewarm (the lever)",
    wellFormed,
    ROUNDS * FANOUT,
    commitLatency,
  );
}

/** Wire-order prompt text, matching evals/agent-fixture.ts's convention. */
function wirePrompt(request: AnyObject): string {
  const system = request.system ?? request.instructions ?? "";
  const systemText = typeof system === "string" ? system : JSON.stringify(system);
  return `${systemText}\n${JSON.stringify(request.tools ?? [])}\n` + JSON.stringify(request.messages ?? request.input ?? []);
}

const a = runNoCache();
const b = runStampedNaiveFanout(COMMIT_LATENCY_SECONDS);
const c = runStampedWithPrewarm(COMMIT_LATENCY_SECONDS);

const pct = (from: number, to: number) => (((from - to) / from) * 100).toFixed(1);

console.log(`${ROUNDS} fan-out rounds x ${FANOUT} sub-agents, dispatched ${DISPATCH_SPREAD_SECONDS}s apart, ` +
  `commit latency ${COMMIT_LATENCY_SECONDS}s (ASSUMED — see header)\n`);

for (const arm of [a, b, c]) {
  console.log(
    `${arm.label.padEnd(48)} $${arm.costUsd.toFixed(3)}  hit rate ${(arm.hitRate * 100).toFixed(1)}%  ` +
    `well-formed ${arm.wellFormed}/${arm.subagentCalls}  ` +
    `written ${arm.writtenInputTokens}  reasons ${JSON.stringify(arm.missReasons)}`,
  );
}

console.log();
console.log(`B vs A (cache stamp ALONE, no sequencing fix): ${pct(a.costUsd, b.costUsd)}%` +
  (b.costUsd > a.costUsd ? "  -- NEGATIVE: stamping without the prewarm barrier loses money on this shape" : ""));
console.log(`C vs B (adding the prewarm barrier):            ${pct(b.costUsd, c.costUsd)}%`);
console.log(`C vs A (the full lever vs no caching at all):   ${pct(a.costUsd, c.costUsd)}%`);

if (a.wellFormed !== a.subagentCalls || b.wellFormed !== b.subagentCalls || c.wellFormed !== c.subagentCalls) {
  throw new Error("a sub-agent request lost its own round/role identity — the lever is not lossless on this run");
}
if (b.costUsd <= a.costUsd) {
  throw new Error("expected arm B (naive stamping) to be a measured LOSS vs no caching; re-check the fixture/assumption before reporting");
}
console.log("\nquality check: every sub-agent request in every arm carried its own round id and role instruction intact (lossless by construction, verified above).");

// --- Sensitivity: the headline number rests on one guessed commit latency.
// Nobody publishes this, so show the result is not a knife-edge: it holds as
// long as sibling dispatch (DISPATCH_SPREAD_SECONDS, real milliseconds) stays
// far below the commit latency, which is true across this whole plausible
// range (a completed sub-agent turn is never sub-second).
console.log(`\nsensitivity to the ASSUMED commit latency (dispatch spread stays ${DISPATCH_SPREAD_SECONDS}s):`);
for (const latency of [0.5, 1, 2.5, 5, 10]) {
  const bAt = runStampedNaiveFanout(latency);
  const cAt = runStampedWithPrewarm(latency);
  console.log(
    `  commit latency ${latency.toString().padStart(4)}s:  B vs A ${pct(a.costUsd, bAt.costUsd).padStart(6)}%   ` +
    `C vs A ${pct(a.costUsd, cAt.costUsd).padStart(6)}%`,
  );
}
