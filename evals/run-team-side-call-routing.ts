import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  OPENAI_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
  type TokenPrice,
} from "../packages/core/src/index.js";
import { chooseSideCallRoute, detectSideCall, type FluxSideCallRoutingConfig } from "../packages/sdk-js/src/index.js";
import { buildSession, LMSYS_LIKE, LONG_THREADS, WILDCHAT_LIKE, type FixtureCall, type ShapeParams } from "./side-call-fixture.js";

/**
 * R&D round 1, lever "side-call-routing" (LOSSY candidate, off by default).
 *
 *   node --import tsx evals/run-team-side-call-routing.ts
 *
 * Open WebUI on defaults sends its title, tags and follow-up side-calls to
 * the chat model itself (see evals/side-call-fixture.ts for the source
 * citations). This eval prices one personal-assistant day through the
 * existing cache simulator at catalogued rates:
 *
 *   baseline  every call on the chat model
 *   lever     main conversation unchanged; calls that chooseSideCallRoute()
 *             selects go to the cheap model — decided by the REAL detector on
 *             the real rendered request bodies, not by fixture labels.
 *
 * Each arm runs under two cache counterfactuals, because the share depends on
 * what the main conversation already costs:
 *   - uncached: Open WebUI places no cache_control, Anthropic caching is opt-in
 *   - cached:   FLUX's own 5m stamp is already on (the lossless stack), so the
 *               main conversation is cheaper and side-calls are a LARGER share
 * Side-calls and main turns are simulated as separate streams (different
 * models never share a provider cache; side-call prompts begin with the task
 * template, so they share no prefix with main turns on the same model either).
 *
 * Figures are SIMULATOR-measured on a fixture whose shape is literature-claim
 * (WildChat / LMSYS) and whose side-call output lengths are reasoned. Saving
 * is model-visible (a different model answers): candidate only, needs the
 * replay gate before it could ever bill.
 */

const AT = "2026-10-28";

function priceOf(provider: "anthropic" | "openai", model: string): TokenPrice {
  const lookup = lookupPrice(publishedModelPrices, { provider, model, at: AT });
  if (lookup.status !== "priced") throw new Error(`price lookup failed for ${provider}/${model}: ${lookup.reason}`);
  return lookup.price;
}

type Pair = {
  label: string;
  provider: "anthropic" | "openai";
  chatModelId: string;
  chatPrice: TokenPrice;
  cheapModelId: string;
  cheapPrice: TokenPrice;
  policies: { name: string; chat: CachePolicy; cheap: CachePolicy }[];
};

// Haiku-class minimum cacheable prefix is 2,048 tokens (model-prices.ts note).
const ANTHROPIC_CACHE_5M_HAIKU: CachePolicy = { ...ANTHROPIC_CACHE_5M, name: "anthropic-ephemeral-5m-haiku", minimumCacheableTokens: 2_048 };

const PAIRS: Pair[] = [
  {
    label: "Anthropic: Sonnet 5.5 -> Haiku 5.5",
    provider: "anthropic",
    chatModelId: "claude-sonnet-5-5",
    chatPrice: priceOf("anthropic", "Sonnet 5.5"),
    cheapModelId: "claude-haiku-5-5",
    cheapPrice: priceOf("anthropic", "Haiku 5.5"),
    policies: [
      { name: "uncached (Open WebUI default)", chat: ANTHROPIC_NO_CACHE, cheap: ANTHROPIC_NO_CACHE },
      { name: "FLUX 5m stamp already on", chat: ANTHROPIC_CACHE_5M, cheap: ANTHROPIC_CACHE_5M_HAIKU },
    ],
  },
  {
    label: "OpenAI: gpt-5.5 -> gpt-4o-mini",
    provider: "openai",
    chatModelId: "gpt-5.5",
    chatPrice: priceOf("openai", "gpt-5.5"),
    cheapModelId: "gpt-4o-mini",
    cheapPrice: priceOf("openai", "gpt-4o-mini"),
    policies: [
      { name: "automatic caching (provider default)", chat: OPENAI_CACHE, cheap: OPENAI_CACHE },
    ],
  },
];

function wire(call: FixtureCall): string {
  return call.request.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function price(calls: FixtureCall[], policy: CachePolicy, p: TokenPrice): number {
  if (calls.length === 0) return 0;
  const sim: SimulatedRequest[] = calls.map((c) => ({ atSeconds: c.atSeconds, prompt: wire(c), outputTokens: c.outputTokens }));
  return simulateCache(sim, policy, p, { countTokens: approximateTokenCount }).totalCostUsd;
}

type Row = { shape: string; pair: string; policy: string; baselineUsd: number; leverUsd: number; savingPct: number };
const rows: Row[] = [];

function detectorScore(calls: FixtureCall[]): { tp: number; fp: number; fn: number; tn: number; fpExamples: string[] } {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  const fpExamples: string[] = [];
  for (const call of calls) {
    const match = detectSideCall(call.request);
    const isSide = call.truth !== "main";
    if (match && isSide && match.kind === call.truth) tp += 1;
    else if (match && !isSide) { fp += 1; fpExamples.push(call.request.messages.at(-1)!.content.slice(0, 80)); }
    else if (match && isSide) fp += 1; // wrong kind counts against precision
    else if (!match && isSide) fn += 1;
    else tn += 1;
  }
  return { tp, fp, fn, tn, fpExamples };
}

function runShape(shape: ShapeParams, primary: boolean, kinds?: FluxSideCallRoutingConfig["kinds"], suffix = ""): void {
  for (const pair of PAIRS) {
    const session = buildSession(shape, pair.chatModelId);
    const config: FluxSideCallRoutingConfig = {
      enabled: true,
      targetModel: { [pair.provider]: pair.cheapModelId },
      ...(kinds === undefined ? {} : { kinds }),
    };
    const routed = session.filter((c) => chooseSideCallRoute(config, c.request, pair.provider) !== undefined);
    const kept = session.filter((c) => chooseSideCallRoute(config, c.request, pair.provider) === undefined);
    const mains = session.filter((c) => c.truth === "main");
    const sides = session.filter((c) => c.truth !== "main");
    if (primary && pair === PAIRS[0]) {
      const score = detectorScore(session);
      const precision = score.tp + score.fp === 0 ? 1 : score.tp / (score.tp + score.fp);
      const recall = score.tp + score.fn === 0 ? 1 : score.tp / (score.tp + score.fn);
      const adversarial = session.filter((c) => c.truth === "main" && c.request.messages.length <= 2 &&
        /### Task:|follow_ups|concise title/.test(c.request.messages.at(-1)!.content));
      console.log(`fixture "${shape.name}": ${session.length} calls = ${mains.length} main turns + ${sides.length} side-calls ` +
        `(${sides.filter((c) => c.truth === "title").length} title, ${sides.filter((c) => c.truth === "tags").length} tags, ` +
        `${sides.filter((c) => c.truth === "follow_ups").length} follow-ups); ${adversarial.length} adversarial look-alike user turns`);
      console.log(`detector on fixture: TP ${score.tp}  FP ${score.fp}  FN ${score.fn}  TN ${score.tn}  ` +
        `precision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%`);
      if (score.fpExamples.length) console.log(`  false positives: ${score.fpExamples.join(" | ")}`);
      const sideTokens = sides.reduce((s, c) => s + approximateTokenCount(wire(c)), 0);
      const mainTokens = mains.reduce((s, c) => s + approximateTokenCount(wire(c)), 0);
      console.log(`input tokens: main ${mainTokens}, side-calls ${sideTokens} (${((sideTokens / (sideTokens + mainTokens)) * 100).toFixed(1)}% of input)\n`);
    }
    for (const policy of pair.policies) {
      // Main stream and side stream priced separately in BOTH arms, so the
      // only difference between arms is which model answers the routed calls.
      const keptUsd = price(kept, policy.chat, pair.chatPrice);
      const baselineUsd = keptUsd + price(routed, policy.chat, pair.chatPrice);
      const leverUsd = keptUsd + price(routed, policy.cheap, pair.cheapPrice);
      const savingPct = ((baselineUsd - leverUsd) / baselineUsd) * 100;
      rows.push({ shape: shape.name + suffix, pair: pair.label, policy: policy.name, baselineUsd, leverUsd, savingPct });
    }
  }
}

console.log("FLUX R&D round 1 — side-call routing (LOSSY candidate) — catalogued prices at " + AT + "\n");
runShape(WILDCHAT_LIKE, true);
runShape(LMSYS_LIKE, false);
runShape(LONG_THREADS, false);
// Sensitivity: only the once-per-chat title call routed (what a title-only
// front-end such as LibreChat would offer; follow-ups stay on the chat model).
runShape(WILDCHAT_LIKE, false, ["title"], " [title only]");

console.log("=== session bill, baseline vs lever (simulator-measured, fixture shape) ===");
for (const row of rows) {
  console.log(
    `${row.shape.padEnd(44)} ${row.pair.padEnd(36)} ${row.policy.padEnd(38)} ` +
      `baseline $${row.baselineUsd.toFixed(5)}  lever $${row.leverUsd.toFixed(5)}  saving ${row.savingPct.toFixed(1)}%`,
  );
}

console.log(
  "\ncaveats: (1) LOSSY — a different model writes the title/tags/suggestions; needs replayGate on the customer's own " +
    "traffic before any of it could bill (FLUX's ledger has no routing lever, so today nothing bills). (2) Saving is " +
    "zero for any deployment that already set TASK_MODEL / TASK_MODEL_EXTERNAL or disabled these tasks — the " +
    "counterfactual here is Open WebUI DEFAULTS. (3) Shape is literature-claim, side-call output lengths reasoned; " +
    "no live Open WebUI capture was taken.",
);
