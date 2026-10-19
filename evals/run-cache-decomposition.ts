import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  approximateTokenCount,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { reduceRequest, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import { answer, buildAnthropicRequest, wirePrompt, TASKS, TURNS_PER_TASK } from "./agent-fixture.js";

/**
 * The cache lever DECOMPOSED, so no one can confuse a rate change with a
 * quality trade:
 *
 *   row 1 — cache contribution, clean: the SAME J prompt stack, stamped 5m
 *            vs unstamped-on-no-cache. Identical prompts, identical answers,
 *            identical clean counts by construction: the delta is purely the
 *            provider's cache pricing that FLUX switched on.
 *   row 2 — full stack vs raw uncached baseline (what arm M reports):
 *            includes J's token levers AND their quality cost (J runs 38/40
 *            vs the raw baseline's 40/40), so it is a different claim and is
 *            labelled with its quality delta.
 *
 * Busy multi-turn spacing: tasks 30s apart, turns 3s apart.
 */

const J_CONFIG: FluxTokenReductionConfig = {
  toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
  duplicateContext: true,
  repairCachePrefix: true,
  freshToolResultCap: true,
  historyCompaction: true,
  maxOutputTokens: 2_000,
};

const AT = "2026-10-13";
const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed");

type AnyObject = Record<string, unknown>;

function runArm(config: FluxTokenReductionConfig | undefined, spacing: number): {
  costUsd: number; clean: number; hitRate: number; stamped: number; total: number;
} {
  const simulated: SimulatedRequest[] = [];
  let clean = 0;
  let stamped = 0;
  for (let task = 0; task < TASKS; task += 1) {
    const clockHour = 8 + (task % 10);
    let fullyGood = true;
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const original = buildAnthropicRequest(task, turn, clockHour);
      let sent = original as AnyObject;
      if (config !== undefined) {
        const reduced = reduceRequest(original, config);
        sent = reduced.request as AnyObject;
        if (reduced.summary.changes.some((c) => c.lever.startsWith("cache-ttl-"))) stamped += 1;
      }
      const outcome = answer(sent);
      if (!outcome.correct || outcome.completeness < 0.95) fullyGood = false;
      simulated.push({ atSeconds: task * spacing + turn * 3, prompt: wirePrompt(sent), outputTokens: outcome.outputTokens });
    }
    if (fullyGood) clean += 1;
  }
  const policy = stamped === simulated.length && stamped > 0 ? ANTHROPIC_CACHE_5M : ANTHROPIC_NO_CACHE;
  const result = simulateCache(simulated, policy, price.price, { countTokens: approximateTokenCount });
  return { costUsd: result.totalCostUsd, clean, hitRate: result.hitRate, stamped, total: simulated.length };
}

const spacing = 30;
const rawUncached = runArm(undefined, spacing);
const jUncached = runArm(J_CONFIG, spacing);
const jCached = runArm({ ...J_CONFIG, cacheTtl: "5m" }, spacing);

const pct = (a: number, b: number) => (((a - b) / a) * 100).toFixed(1);

console.log(`tasks ${TASKS} x ${TURNS_PER_TASK} turns, ${spacing}s apart (busy multi-turn)\n`);
console.log(`raw baseline, uncached        $${rawUncached.costUsd.toFixed(3)}  clean ${rawUncached.clean}/${TASKS}`);
console.log(`J stack, uncached             $${jUncached.costUsd.toFixed(3)}  clean ${jUncached.clean}/${TASKS}`);
console.log(`J stack + 5m stamp (cached)   $${jCached.costUsd.toFixed(3)}  clean ${jCached.clean}/${TASKS}  hits ${(jCached.hitRate * 100).toFixed(0)}%  stamped ${jCached.stamped}/${jCached.total}`);
console.log("");
console.log(`CACHE CONTRIBUTION, clean (same stack, cache on vs off): ${pct(jUncached.costUsd, jCached.costUsd)}%  — identical prompts, clean ${jUncached.clean}/${TASKS} both arms`);
console.log(`FULL STACK vs raw uncached baseline: ${pct(rawUncached.costUsd, jCached.costUsd)}%  — quality ${jCached.clean}/${TASKS} vs baseline ${rawUncached.clean}/${TASKS}`);
console.log(`TOKEN LEVERS alone, uncached (J vs raw): ${pct(rawUncached.costUsd, jUncached.costUsd)}%  — quality ${jUncached.clean}/${TASKS} vs ${rawUncached.clean}/${TASKS}`);
if (jUncached.clean !== jCached.clean) {
  console.log("WARNING: cache stamp changed clean count — it must be metadata-only; investigate.");
  process.exit(1);
}
