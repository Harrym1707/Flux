import { reduceRequest, serviceTierOf, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import {
  ANTHROPIC_CACHE_1H,
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  OPENAI_CACHE,
  approximateTokenCount,
  executionModeFromServiceTier,
  lookupPrice,
  providerUsage,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import {
  AT,
  DOMAINS,
  PREAMBLE,
  SEED_OFFSET,
  TASKS,
  TURNS_PER_TASK,
  answer,
  buildAnthropicRequest,
  buildRequest,
  tools,
  wirePrompt,
  type AnyObject,
} from "./agent-fixture.js";

/**
 * A/B test of the whole product on a simulated multi-turn agent.
 *
 * Identical task set, identical simulated model, identical arrival times. The
 * only difference between arms is whether the request passed through FLUX.
 * Caching is priced by the provider-rule simulator rather than assumed, so a
 * saving has to survive the minimum prefix length, exact-prefix matching, hit
 * granularity and TTL expiry.
 *
 * Task success is measured, not assumed: the simulated model picks its tool by
 * finding the discriminating sentence in a description, so a reduction that
 * trims too far makes it pick the wrong tool and the task fails. Cost per
 * SUCCESSFUL task is therefore the number that matters, since a cheaper agent
 * that fails more often has not saved anything.
 */

// The task set, tools, simulated model and quality bar live in
// evals/agent-fixture.ts, shared verbatim with the replay-gate script so the
// gate approves exactly the behaviour this harness measures. FLUX_AB_TASKS and
// FLUX_AB_SEED are read there; with both unset the fixture is byte-identical
// to the original inline version.

type Arm = {
  label: string;
  config?: FluxTokenReductionConfig;
};

type ArmResult = {
  label: string;
  /** What this arm would cost if the provider had no cache at all. */
  uncachedCostUsd: number;
  calls: number;
  successfulTasks: number;
  /** Mean answer completeness across calls, so truncation is not free. */
  meanCompleteness: number;
  /** Tasks where the tool choice was right AND no answer was badly truncated. */
  fullyGoodTasks: number;
  costUsd: number;
  costPerSuccessfulTask: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Tokens written into the provider cache, billed at the policy's write multiplier. */
  writtenInputTokens: number;
  hitRate: number;
  missReasons: Record<string, number>;
};

/**
 * Run one arm.
 *
 * `secondsBetweenTasks` is the lever that decides whether caching pays at all.
 * Turns inside a task follow each other quickly; tasks are spaced out, and once
 * that spacing exceeds the policy TTL the cache is cold every time.
 */
function runArm(arm: Arm, policy: CachePolicy, price: Parameters<typeof simulateCache>[2], secondsBetweenTasks: number): ArmResult {
  const simulated: SimulatedRequest[] = [];
  const completeness: number[] = [];
  let successfulTasks = 0;
  let fullyGoodTasks = 0;

  for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
    const startedAt = taskIndex * secondsBetweenTasks;
    const clockHour = 8 + (taskIndex % 10);
    let taskSucceeded = true;
    let taskFullyGood = true;
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const original = buildRequest(taskIndex, turn, clockHour);
      const sent = arm.config === undefined
        ? original
        : (reduceRequest(original, arm.config).request as AnyObject);
      const outcome = answer(sent);
      if (!outcome.correct) taskSucceeded = false;
      completeness.push(outcome.completeness);
      if (!outcome.correct || outcome.completeness < 0.95) taskFullyGood = false;
      simulated.push({
        // Turns within a task are seconds apart.
        atSeconds: startedAt + turn * 3,
        prompt: wirePrompt(sent),
        outputTokens: outcome.outputTokens,
      });
    }
    if (taskSucceeded) successfulTasks += 1;
    if (taskFullyGood) fullyGoodTasks += 1;
  }

  const result = simulateCache(simulated, policy, price, { countTokens: approximateTokenCount });
  return {
    uncachedCostUsd: result.uncachedCostUsd,
    label: arm.label,
    calls: result.calls.length,
    successfulTasks,
    meanCompleteness: completeness.reduce((sum, value) => sum + value, 0) / completeness.length,
    fullyGoodTasks,
    costUsd: result.totalCostUsd,
    costPerSuccessfulTask: successfulTasks === 0 ? Number.POSITIVE_INFINITY : result.totalCostUsd / successfulTasks,
    inputTokens: result.totalInputTokens,
    cachedInputTokens: result.cachedInputTokens,
    writtenInputTokens: result.calls.reduce((sum, call) => sum + call.writtenInputTokens, 0),
    hitRate: result.hitRate,
    missReasons: result.missReasons,
  };
}

const ARMS: Arm[] = [
  { label: "A. no FLUX" },
  { label: "B. lossless only", config: { toolSchemas: true, duplicateContext: true } },
  {
    label: "C. + prefix repair",
    config: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
  },
  {
    label: "D. + descriptions to 40",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
    },
  },
  {
    label: "E. + output cap 1000",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 1_000,
    },
  },
  {
    label: "F. descriptions dropped",
    config: { toolSchemas: { descriptions: "drop" }, duplicateContext: true, repairCachePrefix: true },
  },
  {
    // The round-1 lever: arm C plus epoch-frozen stale-history compaction. No
    // output cap (that arm already fails the quality bar) and no description
    // trimming, so any cost delta against C is the compaction alone.
    label: "G. C + history compaction",
    config: {
      toolSchemas: true,
      duplicateContext: true,
      repairCachePrefix: true,
      historyCompaction: true,
    },
  },
  {
    // The full interactive stack. The 2,000 cap is chosen from the fixture's
    // own output distribution: it touches only the two 4,000-token tasks,
    // leaving them half-length answers (completeness 0.45), so clean tasks are
    // 38/40 - above the 36/40 bar the goal line demands, unlike arm E's 33/40.
    label: "H. full stack (cap 2000)",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      historyCompaction: true,
      maxOutputTokens: 2_000,
    },
  },
  {
    // H plus the execution tier, legitimate ONLY on traffic the caller flags
    // latency-tolerant; the async segment below prices it, interactive never.
    label: "I. H + flex tier (async)",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      historyCompaction: true,
      maxOutputTokens: 2_000,
      executionTier: "flex",
    },
  },
  {
    // J: the full interactive stack plus fresh tool-result capping. Unlike
    // every lever above it, the cap removes tokens billed at the FULL input
    // rate (the first injection of an oversized tool result) rather than
    // 0.1x cached rebills, which is what lets it pass the ~15% interactive
    // ceiling. The headline sentence - including the "latest reference R-x-y"
    // the model needs - plus error lines and file paths survive verbatim, so
    // answer() polices the cap directly: lose the latest reference, fail the
    // task.
    label: "J. H + fresh result cap",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      freshToolResultCap: true,
      historyCompaction: true,
      maxOutputTokens: 2_000,
    },
  },
];

// Arm I's successor for the async-eligible segment: J plus the flex execution
// tier. Kept OUT of the interactive ARMS table because flex pricing is only
// legitimate on traffic the caller flags latency-tolerant.
const ARM_J_FLEX: Arm = {
  label: "K. J + flex tier (async)",
  config: { ...ARMS[ARMS.length - 1]!.config!, executionTier: "flex" },
};

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

/**
 * Batch/flex pricing: 50% off every rate. OpenAI documents flex at batch rates
 * with prompt-caching discounts stacking on top; Anthropic documents batches at
 * 50% off with prompt caching stacking. Applying the multiplier to all four
 * rates is exactly that stacking. Priced ONLY for the async-eligible segment.
 */
function tierPrice(base: typeof price.price, multiplier: number): typeof price.price {
  return {
    inputPerMillion: base.inputPerMillion * multiplier,
    outputPerMillion: base.outputPerMillion * multiplier,
    ...(base.cachedInputPerMillion === undefined
      ? {}
      : { cachedInputPerMillion: base.cachedInputPerMillion * multiplier }),
    ...(base.cacheWriteInputPerMillion === undefined
      ? {}
      : { cacheWriteInputPerMillion: base.cacheWriteInputPerMillion * multiplier }),
  };
}

function report(policy: CachePolicy, spacing: number): void {
  const arms = ARMS;
  const effectivePrice = price.price;
  console.log(`\n=== ${policy.name}, tasks ${spacing}s apart, TTL ${policy.ttlSeconds}s ===`);
  // The baseline is ALWAYS standard-tier arm A: a saving is measured against
  // what the customer pays today, which is standard pricing.
  const baseline = runArm(ARMS[0]!, policy, price.price, spacing);
  console.log(
    `${"arm".padEnd(26)} ${"cost".padStart(9)} ${"vs A".padStart(7)} ${"hits".padStart(7)} ` +
    `${"tool ok".padStart(8)} ${"complete".padStart(9)} ${"clean".padStart(7)} ${"$/clean task".padStart(13)}`,
  );
  console.log("-".repeat(92));
  for (const arm of arms) {
    const row = runArm(arm, policy, effectivePrice, spacing);
    const delta = baseline.costUsd === 0 ? 0 : ((baseline.costUsd - row.costUsd) / baseline.costUsd) * 100;
    const perClean = row.fullyGoodTasks === 0 ? "n/a" : `$${(row.costUsd / row.fullyGoodTasks).toFixed(4)}`;
    console.log(
      `${row.label.padEnd(26)} ${`$${row.costUsd.toFixed(3)}`.padStart(9)} ${`${delta.toFixed(1)}%`.padStart(7)} ` +
      `${`${(row.hitRate * 100).toFixed(0)}%`.padStart(7)} ${`${row.successfulTasks}/${TASKS}`.padStart(8)} ` +
      `${`${(row.meanCompleteness * 100).toFixed(0)}%`.padStart(9)} ${`${row.fullyGoodTasks}/${TASKS}`.padStart(7)} ` +
      `${perClean.padStart(13)}`,
    );
  }
}

// Turns inside a task are 3s apart, so the cache is warm within a task.
report(OPENAI_CACHE, 30);

// ---------------------------------------------------------------------------
// The async-eligible segment, SERVED-tier honest (replaces the earlier table
// that priced arm K at tierPrice(0.5) unconditionally).
//
// OpenAI does not guarantee flex: a flex request can be answered at the
// default tier (response.service_tier: "default", billed standard) or rejected
// outright with 429 resource_unavailable (nothing executed, nothing billed).
// Billing must read the tier the provider ANSWERED with, so this block
// synthesizes the response-side evidence per call and routes it through the
// SAME serviceTierOf detection the SDK's ledger event uses (exported from
// packages/sdk-js/src/openai.ts), then prices each event at its served tier:
//
//   - served "flex"    -> flex rates (0.5x on all four rates, caching stacks)
//   - served "default" -> STANDARD rates, zero tier saving claimed that event
//   - 429 resource_unavailable -> ZERO billable event for the attempt; the
//     caller's realistic recovery (retry at standard tier) is billed standard
//
// The fallback/429 rates are ASSUMED, not provider-published: no public
// telemetry exists for flex fallback frequency. The ceiling row (0% fallback)
// is the harness-measured number; the net row is that ceiling degraded by the
// assumed rates, and is the figure to quote for the async band until real
// flex-traffic telemetry lands. The simulated model and quality signal are
// untouched: fallback changes PRICING evidence only, never the answer.
// ---------------------------------------------------------------------------

/** ASSUMED share of flex requests the provider serves at the default tier. */
const FLEX_DEFAULT_FALLBACK_RATE = 0.10;
/** ASSUMED share of flex requests rejected 429 resource_unavailable. */
const FLEX_RESOURCE_UNAVAILABLE_RATE = 0.05;

type FlexServedOutcome = "flex" | "default" | "resource_unavailable_429";

/** Deterministic 32-bit hash so the fallback schedule is reproducible. */
function hash32(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function drawServedOutcome(callIndex: number, fallbackRate: number, unavailableRate: number): FlexServedOutcome {
  const draw = hash32(callIndex) / 2 ** 32;
  if (draw < unavailableRate) return "resource_unavailable_429";
  if (draw < unavailableRate + fallbackRate) return "default";
  return "flex";
}

type AsyncFlexRun = {
  costUsd: number;
  successfulTasks: number;
  fullyGoodTasks: number;
  hitRate: number;
  billableEvents: number;
  flexServedEvents: number;
  /** Flex requests answered at the default tier: billed standard, zero tier saving. */
  defaultServedEvents: number;
  /** 429 resource_unavailable attempts: zero billable events. */
  rejected429Attempts: number;
  /** Standard-tier retries that recovered the 429s (one each, billed standard). */
  standardRetryEvents: number;
  stampedRequests: number;
  totalRequests: number;
};

/**
 * Run arm K with served-tier pricing. Every reduced request must carry the
 * request-path stamp (service_tier: "flex" plus the execution-tier-flex change
 * record) or the run aborts: the lever only counts implemented in the real
 * request path and exercised here.
 */
function runAsyncFlexArm(arm: Arm, fallbackRate: number, unavailableRate: number, spacing: number): AsyncFlexRun {
  if (arm.config?.executionTier !== "flex") {
    throw new Error("runAsyncFlexArm is only for arms whose config requests the flex execution tier.");
  }
  const simulated: SimulatedRequest[] = [];
  /** Served tier per simulated call, index-aligned with `simulated`. */
  const servedTiers: ("flex" | "default")[] = [];
  const expectedAtSeconds: number[] = [];
  let successfulTasks = 0;
  let fullyGoodTasks = 0;
  let stampedRequests = 0;
  let totalRequests = 0;
  let rejected429Attempts = 0;
  let standardRetryEvents = 0;

  for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
    const startedAt = taskIndex * spacing;
    const clockHour = 8 + (taskIndex % 10);
    let taskSucceeded = true;
    let taskFullyGood = true;
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const original = buildRequest(taskIndex, turn, clockHour);
      const reduced = reduceRequest(original, arm.config!);
      const sent = reduced.request as AnyObject;
      totalRequests += 1;

      // Request-path audit: the flex stamp must be real, not assumed.
      const changeRecorded = reduced.summary.changes.some((change) => change.lever === "execution-tier-flex");
      if (!changeRecorded || sent.service_tier !== "flex") {
        throw new Error(
          `Arm '${arm.label}' request at task ${taskIndex} turn ${turn} lacks the request-path flex stamp ` +
          `(change record ${changeRecorded}, service_tier ${String(sent.service_tier)}).`,
        );
      }
      stampedRequests += 1;

      // Quality is measured on the request the model would see, identically to
      // every other arm. The served tier NEVER feeds back into the answer.
      const outcome = answer(sent);
      if (!outcome.correct) taskSucceeded = false;
      if (!outcome.correct || outcome.completeness < 0.95) taskFullyGood = false;

      const callIndex = taskIndex * TURNS_PER_TASK + turn;
      const served = (fallbackRate === 0 && unavailableRate === 0)
        ? "flex"
        : drawServedOutcome(callIndex, fallbackRate, unavailableRate);
      const atSeconds = startedAt + turn * 3;

      if (served === "resource_unavailable_429") {
        // The provider rejected the flex attempt: nothing executed, nothing
        // billed. Prove the zero-billable-event claim through the shared
        // normaliser rather than asserting it.
        const errorBody: AnyObject = {
          status: 429,
          error: { type: "requests", code: "resource_unavailable", message: "The flex tier is at capacity." },
        };
        if (providerUsage(errorBody) !== undefined) {
          throw new Error("A 429 resource_unavailable body produced provider usage; it must yield no billable event.");
        }
        if (serviceTierOf(errorBody) !== undefined) {
          throw new Error("A 429 resource_unavailable body produced service-tier evidence; it must not.");
        }
        rejected429Attempts += 1;
        // Realistic recovery: the caller retries the SAME request at the
        // standard tier two seconds later. That retry is a normal billable
        // event served (and priced) at the default tier.
        simulated.push({ atSeconds: atSeconds + 2, prompt: wirePrompt(sent), outputTokens: outcome.outputTokens });
        servedTiers.push("default");
        expectedAtSeconds.push(atSeconds + 2);
        standardRetryEvents += 1;
      } else {
        simulated.push({ atSeconds, prompt: wirePrompt(sent), outputTokens: outcome.outputTokens });
        servedTiers.push(served);
        expectedAtSeconds.push(atSeconds);
      }
    }
    if (taskSucceeded) successfulTasks += 1;
    if (taskFullyGood) fullyGoodTasks += 1;
  }

  // Simulate the cache ONCE at standard rates, then price each event at its
  // served tier. Flex multiplies all four rates by 0.5, and per-call cost is
  // linear in the rates, so cost(tierPrice(p, m)) === m * cost(p) exactly.
  const result = simulateCache(simulated, OPENAI_CACHE, price.price, { countTokens: approximateTokenCount });
  if (result.calls.length !== servedTiers.length) {
    throw new Error(`Simulator returned ${result.calls.length} calls for ${servedTiers.length} billable events.`);
  }
  let costUsd = 0;
  let flexServedEvents = 0;
  let defaultServedEvents = 0;
  for (let index = 0; index < result.calls.length; index += 1) {
    const call = result.calls[index]!;
    if (call.atSeconds !== expectedAtSeconds[index]) {
      throw new Error(`Simulated call order diverged at index ${index}: the served-tier alignment would be wrong.`);
    }
    // Synthesize the response-side evidence the provider would have returned
    // and read it through the SAME detection the SDK ledger event uses.
    const syntheticResponse: AnyObject = {
      service_tier: servedTiers[index],
      usage: {
        input_tokens: call.totalInputTokens,
        input_tokens_details: { cached_tokens: call.cachedInputTokens },
        output_tokens: call.outputTokens,
      },
    };
    const mode = executionModeFromServiceTier(serviceTierOf(syntheticResponse));
    const multiplier = mode === "flex" || mode === "batch" ? 0.5 : 1;
    const servedCostUsd = call.costUsd * multiplier;
    if (mode === "standard") {
      defaultServedEvents += 1;
      if (servedCostUsd !== call.costUsd) {
        throw new Error("A default-served event was priced below standard; tier savings may only follow served flex.");
      }
    } else {
      flexServedEvents += 1;
    }
    costUsd += servedCostUsd;
  }

  return {
    costUsd,
    successfulTasks,
    fullyGoodTasks,
    hitRate: result.hitRate,
    billableEvents: result.calls.length,
    flexServedEvents,
    defaultServedEvents,
    rejected429Attempts,
    standardRetryEvents,
    stampedRequests,
    totalRequests,
  };
}

function reportAsyncServedTier(): void {
  const spacing = 30;
  console.log(
    `\n=== ASYNC-ELIGIBLE segment, SERVED-tier pricing: ${OPENAI_CACHE.name}, tasks ${spacing}s apart ===`,
  );
  // The baseline is what the customer pays today: standard tier, no FLUX.
  const baseline = runArm(ARMS[0]!, OPENAI_CACHE, price.price, spacing);
  const ceiling = runAsyncFlexArm(ARM_J_FLEX, 0, 0, spacing);
  const net = runAsyncFlexArm(ARM_J_FLEX, FLEX_DEFAULT_FALLBACK_RATE, FLEX_RESOURCE_UNAVAILABLE_RATE, spacing);

  // The fallback schedule may only change pricing, never the measured quality.
  if (ceiling.successfulTasks !== net.successfulTasks || ceiling.fullyGoodTasks !== net.fullyGoodTasks) {
    throw new Error("Fallback pricing changed the quality cells; it must touch pricing evidence only.");
  }
  console.log(
    `request audit: ${net.stampedRequests}/${net.totalRequests} reduced requests carry service_tier=flex with ` +
    "the 'execution-tier-flex' change record; served tier read via the SDK's serviceTierOf on synthesized " +
    "response evidence.",
  );
  const versus = (cost: number) => `${(((baseline.costUsd - cost) / baseline.costUsd) * 100).toFixed(1)}%`;
  console.log(
    `baseline  A standard tier, no FLUX             $${baseline.costUsd.toFixed(3)}   ` +
    `clean ${baseline.fullyGoodTasks}/${TASKS}`,
  );
  console.log(
    `ceiling   K all events served flex (0% fallback) $${ceiling.costUsd.toFixed(3)}   vs A ${versus(ceiling.costUsd)}   ` +
    `tool ok ${ceiling.successfulTasks}/${TASKS}   clean ${ceiling.fullyGoodTasks}/${TASKS}   ` +
    `hits ${(ceiling.hitRate * 100).toFixed(0)}%`,
  );
  console.log(
    `net       K at ASSUMED fallback rates            $${net.costUsd.toFixed(3)}   vs A ${versus(net.costUsd)}   ` +
    `tool ok ${net.successfulTasks}/${TASKS}   clean ${net.fullyGoodTasks}/${TASKS}   ` +
    `hits ${(net.hitRate * 100).toFixed(0)}%`,
  );
  console.log(
    `fallback schedule (ASSUMED ${(FLEX_DEFAULT_FALLBACK_RATE * 100).toFixed(0)}% default-served + ` +
    `${(FLEX_RESOURCE_UNAVAILABLE_RATE * 100).toFixed(0)}% 429, deterministic): of ${net.totalRequests} flex ` +
    `attempts, ${net.flexServedEvents} served flex, ` +
    `${net.defaultServedEvents - net.standardRetryEvents} served default (priced STANDARD, zero tier saving), ` +
    `${net.rejected429Attempts} rejected 429 (ZERO billable events) each recovered by one standard-tier retry ` +
    `(${net.standardRetryEvents} retries billed standard); ${net.billableEvents} billable events total.`,
  );
  console.log(
    "caveat: the ceiling row is harness-measured; the fallback/429 rates are ASSUMED (no provider publishes " +
    "flex fallback telemetry), so the net row is the ceiling degraded by that assumption and is the figure to " +
    "quote for the async band until real flex-traffic telemetry lands. Flex applies ONLY to traffic the " +
    "customer flags latency-tolerant; interactive arms keep their own table above.",
  );
}
reportAsyncServedTier();

/**
 * How much the provider's cache is worth at all, separately from how much FLUX
 * adds to it. These are different questions and conflating them is how the
 * earlier 29% claim happened.
 */
function reportCacheValue(): void {
  console.log("\n=== what the cache itself is worth, before FLUX touches anything ===");
  for (const spacing of [30, 600]) {
    const row = runArm(ARMS[0]!, OPENAI_CACHE, price.price, spacing);
    const share = ((row.uncachedCostUsd - row.costUsd) / row.uncachedCostUsd) * 100;
    console.log(
      `tasks ${String(spacing).padStart(3)}s apart: no cache $${row.uncachedCostUsd.toFixed(3)}, ` +
      `with cache $${row.costUsd.toFixed(3)} -> the cache alone saves ${share.toFixed(1)}% ` +
      `(hit rate ${(row.hitRate * 100).toFixed(0)}%)`,
    );
  }
}
reportCacheValue();

/**
 * The workload where prefix repair DOES matter: independent one-shot requests,
 * each sharing the same big preamble, each stamped with a per-request clock at
 * the top. Nothing appends, so the only cacheable content is the preamble, and
 * the clock kills it. This is the fixture the earlier 29% claim came from, run
 * through the same simulator as the agent so both numbers are comparable.
 */
function reportOneShot(): void {
  console.log("\n=== one-shot workload: same preamble, per-request clock, nothing appends ===");
  // Pinned to A, C, H and I: the one-shot fixture has no tool results, so the
  // fresh cap is a no-op there and a J row would just duplicate H.
  for (const arm of [ARMS[0]!, ARMS[2]!, ARMS[7]!, ARMS[8]!]) {
    const flexTier = arm.config?.executionTier === "flex";
    const simulated: SimulatedRequest[] = [];
    for (let index = 0; index < 60; index += 1) {
      const original: AnyObject = {
        model: "gpt-5",
        instructions: `Current time: ${AT}T09:${String(index % 60).padStart(2, "0")}:22Z\n${PREAMBLE}`,
        tools: tools(),
        input: [{ role: "user", content: `Question ${index} about account ${1000 + index}.` }],
        metadata: { domain: DOMAINS[index % DOMAINS.length]!, taskIndex: index, turn: 0 },
      };
      const sent = arm.config === undefined
        ? original
        : (reduceRequest(original, arm.config).request as AnyObject);
      simulated.push({ atSeconds: index * 30, prompt: wirePrompt(sent), outputTokens: 400 });
    }
    const oneShotPrice = flexTier ? tierPrice(price.price, 0.5) : price.price;
    const result = simulateCache(simulated, OPENAI_CACHE, oneShotPrice, { countTokens: approximateTokenCount });
    const standardBaseline = simulateCache(
      simulated.map((row) => ({ ...row })), OPENAI_CACHE, price.price, { countTokens: approximateTokenCount });
    void standardBaseline;
    console.log(
      `${arm.label.padEnd(26)} cost $${result.totalCostUsd.toFixed(3)}, hit rate ` +
      `${(result.hitRate * 100).toFixed(0)}%${flexTier ? " (flex pricing, async-eligible only)" : ""}`,
    );
  }
}
reportOneShot();
// Tasks spread past the TTL: the cache goes cold between them.
report(OPENAI_CACHE, 600);
// A write premium changes where the break-even sits.
report(ANTHROPIC_CACHE_5M, 30);

console.log(
  "\ncost/ok task is the figure that matters: an arm that is cheaper per call but fails more tasks\n" +
  "has not saved anything. Arm F is the control for that, and the 600s run is the control for\n" +
  "claiming a caching saving on traffic too sparse to keep a cache warm.",
);

// ---------------------------------------------------------------------------
// Appended 1h-TTL sections (round 2). Everything above prints byte-identically
// to the c7b03d4 run; the sections below only ADD rows.
// ---------------------------------------------------------------------------

// The sparse block on Anthropic pricing, both TTLs. 5m at 600s spacing is the
// COLD CONTROL: every task outlives the TTL, so caching barely pays and FLUX's
// history levers have nothing cached to nibble. 1h at the same spacing is the
// LEVER: the cache survives between tasks at the cost of a 2x write premium
// (vs 1.25x for 5m). Both tables keep the same-policy arm-A baseline, so each
// "vs A" column is FLUX's contribution under that policy, not the TTL's.
report(ANTHROPIC_CACHE_5M, 600);
report(ANTHROPIC_CACHE_1H, 600);

/**
 * TTL as a FLUX lever, measured.
 *
 * The claim this block prices: a customer running the no-FLUX agent on the
 * default 5m cache at 600s task spacing (arm A @5m, what they pay today)
 * switches on FLUX, which both applies arm J's reduction stack AND stamps the
 * 1h cache TTL on their requests. The comparison is J@1h vs A@5m, with the
 * decomposition printed so the TTL's share and the reduction stack's share are
 * visible separately, and the 2x write premium shown explicitly rather than
 * buried in the total.
 *
 * MEASURED here means measured on this simulated harness via the provider-rule
 * cache simulator. The request-path side (the cacheTtl knob in reduceRequest,
 * which stamps cache_control {ttl: '1h'} on Anthropic-shaped requests) exists
 * and is unit-tested, but this fixture is OpenAI-shaped, so no production
 * saving is claimed until the stamped path is gated on real Anthropic traffic.
 */
function reportTtlLever(): void {
  const spacing = 600;
  const armA = ARMS[0]!;
  const armJ = ARMS[9]!;
  const a5m = runArm(armA, ANTHROPIC_CACHE_5M, price.price, spacing);
  const a1h = runArm(armA, ANTHROPIC_CACHE_1H, price.price, spacing);
  const j5m = runArm(armJ, ANTHROPIC_CACHE_5M, price.price, spacing);
  const j1h = runArm(armJ, ANTHROPIC_CACHE_1H, price.price, spacing);
  const versus = (row: ArmResult) => `${(((a5m.costUsd - row.costUsd) / a5m.costUsd) * 100).toFixed(1)}%`;

  console.log(`\n=== TTL as a FLUX lever: J@1h vs A@5m, tasks ${spacing}s apart, Anthropic write premiums ===`);
  console.log(`baseline  A @5m TTL (customer today)   $${a5m.costUsd.toFixed(3)}   vs A@5m ${versus(a5m).padStart(6)}   clean ${a5m.fullyGoodTasks}/${TASKS}`);
  console.log(`decompose A @1h TTL (TTL alone)        $${a1h.costUsd.toFixed(3)}   vs A@5m ${versus(a1h).padStart(6)}   clean ${a1h.fullyGoodTasks}/${TASKS}`);
  console.log(`decompose J @5m TTL (stack alone)      $${j5m.costUsd.toFixed(3)}   vs A@5m ${versus(j5m).padStart(6)}   clean ${j5m.fullyGoodTasks}/${TASKS}`);
  console.log(`lever     J @1h TTL (stack + TTL)      $${j1h.costUsd.toFixed(3)}   vs A@5m ${versus(j1h).padStart(6)}   clean ${j1h.fullyGoodTasks}/${TASKS}`);

  // The write premium, explicit. Writes are billed at writeMultiplier x the
  // base input rate: 1.25x on the 5m cache, 2x on the 1h cache. The premium
  // PAID is part of the J@1h total above; this line shows how much of that
  // total is premium, so the lever's cost is not hidden inside its saving.
  const writeCostUsd = (written: number, multiplier: number) =>
    (written / 1_000_000) * price.price.inputPerMillion * multiplier;
  const j1hWrites = writeCostUsd(j1h.writtenInputTokens, ANTHROPIC_CACHE_1H.writeMultiplier);
  const j1hWritesAt5mRate = writeCostUsd(j1h.writtenInputTokens, ANTHROPIC_CACHE_5M.writeMultiplier);
  const j5mWrites = writeCostUsd(j5m.writtenInputTokens, ANTHROPIC_CACHE_5M.writeMultiplier);
  console.log(
    `write premium: J@1h wrote ${j1h.writtenInputTokens.toLocaleString("en-US")} tokens at ` +
    `${ANTHROPIC_CACHE_1H.writeMultiplier}x base input = $${j1hWrites.toFixed(3)} ` +
    `(the same tokens at the 5m ${ANTHROPIC_CACHE_5M.writeMultiplier}x rate: $${j1hWritesAt5mRate.toFixed(3)}; ` +
    `J@5m actually wrote ${j5m.writtenInputTokens.toLocaleString("en-US")} tokens = $${j5mWrites.toFixed(3)}, ` +
    "because its cache keeps expiring and rewriting).",
  );
  console.log(
    "caveat: TTL figures are MEASURED on this harness via the provider-rule cache simulator. The\n" +
    "cacheTtl knob is exercised end-to-end on Anthropic-shaped requests in the stamped arm L block\n" +
    "below (the stamp observed on every reduced request before the 1h policy is selected);\n" +
    "real-traffic validation on a production Anthropic workload is still open.",
  );
}
reportTtlLever();

if (SEED_OFFSET !== 0 || TASKS !== 40) {
  console.log(
    `\nvariant run: FLUX_AB_TASKS=${TASKS} FLUX_AB_SEED=${SEED_OFFSET} ` +
    "(domain assignment rotated by the seed; natural-output-length formula immutable).",
  );
}

// ---------------------------------------------------------------------------
// Appended arm L (round 3): the 1h TTL driven through the SHIPPED cacheTtl
// knob, end-to-end on Anthropic-shaped requests.
//
// Rounds 1-2 measured the 1h TTL by applying the simulator's 1h policy to
// OpenAI-shaped traffic directly, leaving the printed caveat that the
// production knob (reduceRequest's cacheTtl, which stamps cache_control
// {type:'ephemeral', ttl:'1h'} on the last content block) was unit-tested but
// never the thing measured. This block closes that gap inside the simulator:
//
//   - the fixture is rebuilt byte-verbatim in Anthropic Messages shape
//     (buildAnthropicRequest: instructions->system, input->messages);
//   - arm L is EXACTLY arm J's config plus cacheTtl:'1h', J pinned by label;
//   - the simulator's 1h policy is selected ONLY for a run in which every
//     reduced request is OBSERVED to carry the stamp (change record AND the
//     cache_control bytes); the unstamped baseline stays on the 5m policy;
//   - the stamp must be suffix-only: the wire prompt of the stamped reduction
//     must be byte-identical to the unstamped reduction up to the final
//     content block, or the stamp itself would break the cached prefix.
//
// Remaining caveat: knob exercised end-to-end on Anthropic-shaped requests,
// real-traffic validation still open.
// ---------------------------------------------------------------------------

const ARM_J_LABEL = "J. H + fresh result cap";
const ARM_J_BY_LABEL = ARMS.find((arm) => arm.label === ARM_J_LABEL);
if (ARM_J_BY_LABEL?.config === undefined) {
  throw new Error(`Arm '${ARM_J_LABEL}' not found by label; arm L must stack on exactly J's config.`);
}
const ARM_L: Arm = {
  label: "L. J + cacheTtl 1h (stamped)",
  config: { ...ARM_J_BY_LABEL.config, cacheTtl: "1h" },
};

const ARM_M: Arm = {
  label: "M. J + cacheTtl 5m (stamped, multi-turn)",
  config: { ...ARM_J_BY_LABEL.config, cacheTtl: "5m" },
};

// Matches either TTL's stamp bytes; the lever id pins the exact TTL.
const STAMP_BYTES = '"cache_control":{"type":"ephemeral","ttl":"';

type AnthropicShapedRun = {
  label: string;
  stampedCalls: number;
  totalCalls: number;
  policyName: string;
  costUsd: number;
  hitRate: number;
  successfulTasks: number;
  fullyGoodTasks: number;
  writtenInputTokens: number;
};

/**
 * Run one arm on the Anthropic-shaped fixture.
 *
 * Identical task loop, spacing and quality accounting to runArm; the only
 * differences are the request shape and that the cache policy is DERIVED from
 * the observed stamps rather than passed in.
 */
/**
 * The request with every cache_control stripped and the documented
 * string<->single-text-block equivalence flattened, serialised for comparison.
 * Two requests that agree here put identical content in front of the model.
 */
function withoutStampArtifacts(request: AnyObject): string {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === "cache_control") continue;
        out[key] = strip(value);
      }
      return out;
    }
    return node;
  };
  const flattenSingleTextBlock = (content: unknown): unknown => {
    if (Array.isArray(content) && content.length === 1) {
      const only = content[0] as AnyObject | undefined;
      if (only !== undefined && only.type === "text" && typeof only.text === "string" &&
          Object.keys(only).length === 2) {
        return only.text;
      }
    }
    return content;
  };
  const clean = strip(request) as AnyObject;
  clean.system = flattenSingleTextBlock(clean.system);
  if (Array.isArray(clean.messages)) {
    clean.messages = clean.messages.map((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
      const row = message as AnyObject;
      return { ...row, content: flattenSingleTextBlock(row.content) };
    });
  }
  return JSON.stringify(clean);
}

function runAnthropicShapedArm(
  arm: Arm,
  spacing: number,
  unstampedPolicy: CachePolicy = ANTHROPIC_CACHE_5M,
): AnthropicShapedRun {
  const simulated: SimulatedRequest[] = [];
  let stampedCalls = 0;
  let suffixOnlyChecks = 0;
  let successfulTasks = 0;
  let fullyGoodTasks = 0;

  // The same config minus the TTL, for the suffix-only byte control below.
  let configWithoutTtl: FluxTokenReductionConfig | undefined;
  if (arm.config !== undefined) {
    const { cacheTtl: _ignored, ...rest } = arm.config;
    configWithoutTtl = rest;
  }

  for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
    const startedAt = taskIndex * spacing;
    const clockHour = 8 + (taskIndex % 10);
    let taskSucceeded = true;
    let taskFullyGood = true;
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const original = buildAnthropicRequest(taskIndex, turn, clockHour);
      let sent = original;
      let stamped = false;
      if (arm.config !== undefined) {
        const reduced = reduceRequest(original, arm.config);
        sent = reduced.request as AnyObject;
        const changeRecorded = reduced.summary.changes.some((change) => change.lever.startsWith("cache-ttl-"));
        const bytesStamped = JSON.stringify({ system: sent.system ?? null, messages: sent.messages ?? [] })
          .includes(STAMP_BYTES);
        if (changeRecorded !== bytesStamped) {
          throw new Error(
            `cache-ttl bookkeeping mismatch at task ${taskIndex} turn ${turn}: ` +
            `change record ${changeRecorded}, stamp bytes ${bytesStamped}.`,
          );
        }
        stamped = changeRecorded && bytesStamped;
      } else if (JSON.stringify(sent).includes('"cache_control"')) {
        throw new Error(`Unreduced baseline request carries cache_control at task ${taskIndex} turn ${turn}.`);
      }

      if (stamped) {
        stampedCalls += 1;
        // Metadata-only control: stripping every cache_control and flattening
        // the documented string<->single-text-block equivalence must leave the
        // stamped request byte-identical to the unstamped one. The stamp may
        // mark where caching applies; it may never change what the model reads.
        const unstamped = reduceRequest(
          buildAnthropicRequest(taskIndex, turn, clockHour), configWithoutTtl ?? {},
        ).request as AnyObject;
        if (withoutStampArtifacts(sent) !== withoutStampArtifacts(unstamped)) {
          throw new Error(
            `TTL stamp changed model-visible content at task ${taskIndex} turn ${turn}; ` +
            "the stamp must be metadata-only.",
          );
        }
        suffixOnlyChecks += 1;
      }

      const outcome = answer(sent);
      if (!outcome.correct) taskSucceeded = false;
      if (!outcome.correct || outcome.completeness < 0.95) taskFullyGood = false;
      simulated.push({
        atSeconds: startedAt + turn * 3,
        prompt: wirePrompt(sent),
        outputTokens: outcome.outputTokens,
      });
    }
    if (taskSucceeded) successfulTasks += 1;
    if (taskFullyGood) fullyGoodTasks += 1;
  }

  if (stampedCalls > 0 && suffixOnlyChecks !== stampedCalls) {
    throw new Error(`Metadata-only control ran ${suffixOnlyChecks} times for ${stampedCalls} stamped requests.`);
  }

  // The stamped-TTL policy is selected ONLY when every request in the run was
  // observed to carry the stamp, and the TTL comes from the arm's own config.
  // No stamps price under the caller-supplied unstamped policy; a mixed run is a bug.
  const totalCalls = simulated.length;
  let policy: CachePolicy;
  if (stampedCalls === totalCalls && totalCalls > 0) {
    policy = arm.config?.cacheTtl === "5m" ? ANTHROPIC_CACHE_5M : ANTHROPIC_CACHE_1H;
  } else if (stampedCalls === 0) policy = unstampedPolicy;
  else throw new Error(`Mixed stamping (${stampedCalls}/${totalCalls}): refusing to pick a single cache policy.`);

  const result = simulateCache(simulated, policy, price.price, { countTokens: approximateTokenCount });
  return {
    label: arm.label,
    stampedCalls,
    totalCalls,
    policyName: policy.name,
    costUsd: result.totalCostUsd,
    hitRate: result.hitRate,
    successfulTasks,
    fullyGoodTasks,
    writtenInputTokens: result.calls.reduce((sum, call) => sum + call.writtenInputTokens, 0),
  };
}

function reportStampedTtlArm(): void {
  const spacing = 600;
  const expectedCalls = TASKS * TURNS_PER_TASK;
  console.log(`\n=== arm L: J + cacheTtl '1h' STAMPED end-to-end, Anthropic-shaped, tasks ${spacing}s apart ===`);

  const baseline = runAnthropicShapedArm(ARMS[0]!, spacing);
  const armL = runAnthropicShapedArm(ARM_L, spacing);

  // Hard assertion 1: every reduced request carries the stamp + change record.
  if (armL.stampedCalls !== expectedCalls || armL.totalCalls !== expectedCalls) {
    throw new Error(`Expected ${expectedCalls}/${expectedCalls} stamped arm L requests, got ` +
      `${armL.stampedCalls}/${armL.totalCalls}.`);
  }
  // Hard assertion 2: zero stamps on the unreduced baseline.
  if (baseline.stampedCalls !== 0) {
    throw new Error(`Expected 0 stamped baseline requests, got ${baseline.stampedCalls}.`);
  }
  console.log(
    `stamp audit: arm L ${armL.stampedCalls}/${armL.totalCalls} requests carry cache_control with the ` +
    `'cache-ttl-1h' change record (policy ${armL.policyName}); baseline A ${baseline.stampedCalls}/` +
    `${baseline.totalCalls} (policy ${baseline.policyName}); stamp verified metadata-only on every stamped request.`,
  );

  // Hard assertion 4: quality cells exactly J's. Quality is cache-independent,
  // so J's cells come from the OpenAI-shaped reference run of the same config.
  const jReference = runArm(ARM_J_BY_LABEL!, ANTHROPIC_CACHE_5M, price.price, spacing);
  if (armL.successfulTasks !== jReference.successfulTasks || armL.fullyGoodTasks !== jReference.fullyGoodTasks) {
    throw new Error(
      `Arm L quality cells (tool ok ${armL.successfulTasks}/${TASKS}, clean ${armL.fullyGoodTasks}/${TASKS}) ` +
      `differ from arm J's (${jReference.successfulTasks}/${TASKS}, ${jReference.fullyGoodTasks}/${TASKS}): ` +
      "the TTL stamp must not touch quality.",
    );
  }
  if (TASKS === 40 && SEED_OFFSET === 0 && (armL.successfulTasks !== 40 || armL.fullyGoodTasks !== 38)) {
    throw new Error(
      `Default-fixture quality cells must be exactly J's 40/40 tool ok and 38/40 clean; got ` +
      `${armL.successfulTasks}/40 and ${armL.fullyGoodTasks}/40.`,
    );
  }

  const saving = ((baseline.costUsd - armL.costUsd) / baseline.costUsd) * 100;
  console.log(`baseline  A @5m (Anthropic-shaped, unstamped)  $${baseline.costUsd.toFixed(3)}   clean ${baseline.fullyGoodTasks}/${TASKS}`);
  console.log(
    `lever     L = J + cacheTtl '1h' (stamped)      $${armL.costUsd.toFixed(3)}   vs A@5m ${saving.toFixed(1)}%   ` +
    `tool ok ${armL.successfulTasks}/${TASKS}   clean ${armL.fullyGoodTasks}/${TASKS}   hits ${(armL.hitRate * 100).toFixed(0)}%`,
  );

  if (TASKS === 40 && SEED_OFFSET === 0) {
    const drift = Math.abs(saving - 34.5);
    if (drift > 0.5) {
      console.log(
        `RESULT: FAILURE of the stamped TTL lever - measured ${saving.toFixed(1)}% vs the 34.5% +/-0.5pt ` +
        "policy-applied row. The drift is reported, not tuned away; diagnose before any claim.",
      );
    } else {
      console.log(
        `RESULT: stamped row ${saving.toFixed(1)}% matches the policy-applied 34.5% row within 0.5pt: ` +
        "the production stamp reproduces the measured saving end-to-end in the simulator.",
      );
    }
  } else {
    console.log(`variant stamped row: ${saving.toFixed(1)}% vs this variant's own Anthropic-shaped A@5m baseline.`);
  }
  console.log(
    "caveat: knob exercised end-to-end on Anthropic-shaped requests (simulator-measured); " +
    "real-traffic validation still open.",
  );
}
/**
 * Arm M: the multi-turn Anthropic cache lever. The honest baseline here is NO
 * cache at all — Anthropic's cache is opt-in, and the first live export
 * measured an unstamped five-turn agent with zero cache reads and zero
 * writes, so an unstamped customer's history re-bills at full rate every
 * turn. FLUX's 5m stamp (writes 1.25x, reads 0.1x) is what switches the cache
 * on, and the stamp defers whenever the caller placed any cache_control of
 * their own — so this saving is never claimed from a customer who already had
 * caching.
 */
function reportMultiTurnCacheArm(): void {
  const spacing = 30; // busy traffic: tasks half a minute apart, turns seconds apart
  const expectedCalls = TASKS * TURNS_PER_TASK;
  console.log(`\n=== arm M: J + cacheTtl '5m' STAMPED, multi-turn vs UNCACHED baseline, tasks ${spacing}s apart ===`);

  const baseline = runAnthropicShapedArm(ARMS[0]!, spacing, ANTHROPIC_NO_CACHE);
  const armM = runAnthropicShapedArm(ARM_M, spacing, ANTHROPIC_NO_CACHE);

  if (armM.stampedCalls !== expectedCalls || armM.totalCalls !== expectedCalls) {
    throw new Error(`Expected ${expectedCalls}/${expectedCalls} stamped arm M requests, got ` +
      `${armM.stampedCalls}/${armM.totalCalls}.`);
  }
  if (baseline.stampedCalls !== 0) {
    throw new Error(`Expected 0 stamped baseline requests, got ${baseline.stampedCalls}.`);
  }
  if (armM.policyName !== ANTHROPIC_CACHE_5M.name || baseline.policyName !== ANTHROPIC_NO_CACHE.name) {
    throw new Error(`Arm M policies wrong: stamped ${armM.policyName}, baseline ${baseline.policyName}.`);
  }
  console.log(
    `stamp audit: arm M ${armM.stampedCalls}/${armM.totalCalls} requests carry the 5m stamp (policy ` +
    `${armM.policyName}); baseline ${baseline.stampedCalls}/${baseline.totalCalls} unstamped (policy ` +
    `${baseline.policyName}); stamp verified metadata-only on every stamped request.`,
  );

  const saving = ((baseline.costUsd - armM.costUsd) / baseline.costUsd) * 100;
  console.log(`baseline  A uncached (no cache_control placed)  $${baseline.costUsd.toFixed(3)}   clean ${baseline.fullyGoodTasks}/${TASKS}`);
  console.log(
    `lever     M = J + cacheTtl '5m' (stamped)       $${armM.costUsd.toFixed(3)}   vs uncached ${saving.toFixed(1)}%   ` +
    `tool ok ${armM.successfulTasks}/${TASKS}   clean ${armM.fullyGoodTasks}/${TASKS}   hits ${(armM.hitRate * 100).toFixed(0)}%`,
  );
  console.log(
    "caveat: simulator-measured against the uncached baseline the first live export confirmed for " +
    "unstamped Claude traffic; the stamp defers to any caller-placed cache_control, so a customer " +
    "who already caches is never billed for this. Real-traffic validation: re-run the live agents.",
  );
}

reportStampedTtlArm();
reportMultiTurnCacheArm();
