import {
  ANTHROPIC_CACHE_5M,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import {
  compactStaleContext,
  CompactionPinStore,
  type SemanticCompactor,
} from "../packages/sdk-js/src/index.js";

/**
 * Hardening night (2026-11-03): measures the cross-turn stability fix for the
 * semantic-compaction prototype (packages/sdk-js/src/compaction-pin-store.ts),
 * which closes the "hard blocker" flagged in
 * docs/rnd/semantic-compaction-design.md's 2026-10-27 review — semantic
 * compaction, run unpinned alongside caching, can make a long-lived agent
 * MORE expensive than doing nothing at all, because a non-deterministic local
 * compactor re-paraphrases the same stale body differently on every turn and
 * busts the provider's exact-prefix cache every single request.
 *
 * Three arms on the SAME growing agent conversation (10 turns, 30s apart,
 * Anthropic 5m cache policy, so a stable prefix would stay warm throughout):
 *
 *   A. no semantic compaction at all      — the honest "do nothing" baseline.
 *   B. semantic compaction, UNPINNED      — a fresh CompactionPinStore-less
 *      call every turn, so every oversized stale tool-result is re-sent to
 *      the (simulated) local model and comes back different every time.
 *   C. semantic compaction, PINNED        — ONE CompactionPinStore shared
 *      across every turn, so a given stale body is compacted once and then
 *      re-emitted byte-identical forever after.
 *
 * The local compactor itself has zero token/dollar cost (it runs on the
 * customer's own machine) — what is priced here is its DOWNSTREAM effect on
 * the provider's prompt cache, which is where the real money is. The
 * compactor is a STUB (a numbered marker, not a real model) so the test is
 * reproducible; it is deliberately unstable (different output every call) to
 * model the realistic case a temperature>0 local model would produce. This is
 * simulator-measured, not provider-measured — same caveat as every other
 * cache simulation in evals/.
 */

type AnyObject = Record<string, unknown>;

const NUM_TURNS = 24;
const SPACING_SECONDS = 30; // busy multi-turn: well inside the 300s Anthropic 5m TTL
// A realistic agent system preamble (~1,300 tok), so the static system+tools
// block alone clears Anthropic's 1,024-token cacheable minimum on turn 1 -
// mirroring agent-fixture.ts's PREAMBLE, not a toy-sized string that would
// never cache regardless of what this eval is measuring.
const SYSTEM = [
  "You are a senior data assistant investigating account history across many turns.",
  ...Array.from({ length: 70 }, (_, index) =>
    `Rule ${index}: confirm the account identifier before quoting a figure, cite the record reference, and ` +
    "never speculate about a pending adjustment that has not been approved by a supervisor."),
].join("\n\n");
const APPROVED = { ref: "gate-run-2026-11-03-pin-stability-eval", verdict: "approved" as const };

/** An oversized (~700-token) tool-result body, deterministic per turn. */
function toolBody(turn: number): string {
  const rows = Array.from(
    { length: 40 },
    (_, row) =>
      `Record ${row} for turn ${turn} shows a settlement entry of ${(row * 137 + turn) % 9000} pence, ` +
      "reconciliation nominal, no customer notification sent, retention window standard.",
  );
  return `Lookup complete for turn ${turn}: ${rows.join(" ")}`;
}

/** The growing conversation through turn `uptoTurn` (inclusive), chat-tool shaped. */
function buildHistory(uptoTurn: number): AnyObject {
  const messages: AnyObject[] = [];
  for (let turn = 0; turn <= uptoTurn; turn += 1) {
    messages.push({ role: "user", content: `Turn ${turn}: what is the account status now?` });
    messages.push({ role: "tool", content: toolBody(turn) });
    messages.push({ role: "assistant", content: `Turn ${turn} assistant answer, summarising the lookup.` });
  }
  return { model: "claude-sonnet-4-5", system: SYSTEM, tools: [], messages };
}

/** The provider-visible wire prompt, in order, for cache prefix matching. */
function wirePrompt(request: AnyObject): string {
  return `${String(request.system)}\n${JSON.stringify(request.tools ?? [])}\n${JSON.stringify(request.messages)}`;
}

/** An unstable local-model stub: a different numbered summary every call, with a call counter. */
function unstableCompactor(): SemanticCompactor & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    compact: ({ kind }) => {
      calls += 1;
      return `[local summary #${calls} of ${kind}]`;
    },
  };
}

const OUTPUT_TOKENS = 120; // held constant across arms: only the INPUT side is under test

function runArm(buildSent: (uptoTurn: number) => AnyObject): SimulatedRequest[] {
  const requests: SimulatedRequest[] = [];
  for (let turn = 0; turn < NUM_TURNS; turn += 1) {
    const sent = buildSent(turn);
    requests.push({ atSeconds: turn * SPACING_SECONDS, prompt: wirePrompt(sent), outputTokens: OUTPUT_TOKENS });
  }
  return requests;
}

async function main(): Promise<void> {
  const AT = "2026-10-13";
  const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
  if (price.status !== "priced") throw new Error("price lookup failed");

  // Arm A: no compaction at all. History only ever grows and is never
  // rewritten, so this is the "caching just works" control.
  const armA = runArm((uptoTurn) => buildHistory(uptoTurn));

  // Arm B: semantic compaction, UNPINNED. Every call gets its own fresh
  // compactor invocation with no pin store, so every stale body already
  // compacted on an earlier turn gets RE-compacted (differently) this turn.
  const compactorB = unstableCompactor();
  const requestsB: AnyObject[] = [];
  for (let turn = 0; turn < NUM_TURNS; turn += 1) {
    const result = await compactStaleContext(buildHistory(turn), {
      compactor: compactorB, gateVerdict: APPROVED, maxTokens: 500, minimumTurns: 3, keepRecentTurns: 2,
    });
    requestsB.push(result.request as AnyObject);
  }
  const armB = requestsB.map((sent, turn) => ({
    atSeconds: turn * SPACING_SECONDS, prompt: wirePrompt(sent), outputTokens: OUTPUT_TOKENS,
  }));

  // Arm C: semantic compaction, PINNED. ONE CompactionPinStore shared across
  // every turn of this conversation, as the design requires.
  const compactorC = unstableCompactor();
  const pins = new CompactionPinStore();
  const requestsC: AnyObject[] = [];
  for (let turn = 0; turn < NUM_TURNS; turn += 1) {
    const result = await compactStaleContext(buildHistory(turn), {
      compactor: compactorC, gateVerdict: APPROVED, maxTokens: 500, minimumTurns: 3, keepRecentTurns: 2, pins,
    });
    requestsC.push(result.request as AnyObject);
  }
  const armC = requestsC.map((sent, turn) => ({
    atSeconds: turn * SPACING_SECONDS, prompt: wirePrompt(sent), outputTokens: OUTPUT_TOKENS,
  }));

  const resultA = simulateCache(armA, ANTHROPIC_CACHE_5M, price.price);
  const resultB = simulateCache(armB, ANTHROPIC_CACHE_5M, price.price);
  const resultC = simulateCache(armC, ANTHROPIC_CACHE_5M, price.price);

  const pct = (a: number, b: number) => (((a - b) / a) * 100).toFixed(1);

  console.log(`${NUM_TURNS} turns, ${SPACING_SECONDS}s apart, Anthropic 5m cache policy (simulator-measured)\n`);
  console.log(`A. no compaction                cost $${resultA.totalCostUsd.toFixed(4)}  hit rate ${(resultA.hitRate * 100).toFixed(1)}%`);
  console.log(`B. compaction, UNPINNED          cost $${resultB.totalCostUsd.toFixed(4)}  hit rate ${(resultB.hitRate * 100).toFixed(1)}%  compactor calls ${compactorB.calls}`);
  console.log(`C. compaction, PINNED            cost $${resultC.totalCostUsd.toFixed(4)}  hit rate ${(resultC.hitRate * 100).toFixed(1)}%  compactor calls ${compactorC.calls}`);
  console.log("");
  console.log(`B vs A (unpinned compaction vs doing nothing): ${pct(resultA.totalCostUsd, resultB.totalCostUsd)}%` +
    (resultB.totalCostUsd > resultA.totalCostUsd ? "  <- NEGATIVE: unpinned compaction is MORE expensive than doing nothing" : ""));
  console.log(`C vs A (pinned compaction vs doing nothing):   ${pct(resultA.totalCostUsd, resultC.totalCostUsd)}%`);
  console.log(`C vs B (pinning fixes the unpinned regression): ${pct(resultB.totalCostUsd, resultC.totalCostUsd)}%`);
  console.log(`compactor invocations avoided by pinning: ${compactorB.calls - compactorC.calls} of ${compactorB.calls} (local compute, not billed tokens, but real latency/cost on the customer's own machine)`);

  if (resultB.totalCostUsd <= resultA.totalCostUsd) {
    console.log("\nNOTE: this fixture did not reproduce the unpinned regression (B was not worse than A). " +
      "The regression depends on the compacted bodies being a large-enough share of a prefix that would " +
      "otherwise stay cached; widen NUM_TURNS or the tool-result size if this fixture needs updating.");
  }
}

main();
