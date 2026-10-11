import { reduceRequest, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import {
  ANTHROPIC_CACHE_5M,
  OPENAI_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/index.js";

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

const AT = "2026-10-08";
const DOMAINS = ["refunds", "chargebacks", "payouts", "disputes", "settlements"] as const;
const TASKS = 40;
const TURNS_PER_TASK = 5;

const PREAMBLE = [
  "You are a senior support agent for a payments company.",
  ...Array.from({ length: 60 }, (_, index) =>
    `Rule ${index}: confirm the account identifier before quoting a figure, never speculate about unapproved ` +
    "refunds, and escalate chargebacks or legal threats to a human with the reason recorded."),
].join("\n\n");

function tools(): unknown[] {
  return DOMAINS.map((domain, index) => ({
    type: "function",
    function: {
      name: `lookup_${domain}`,
      description:
        `Look up records for a customer account in subsystem ${index}. ` +
        `Use this tool for questions about ${domain}. ` +
        "Returns a paginated list ordered by creation time descending. Do not call this more than once per " +
        "turn; prefer narrowing the query with filters over paging through results. If the account is closed " +
        "the call returns an empty list rather than an error.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { accountId: { type: "string", title: "accountId", description: "Account identifier." } },
        required: ["accountId"],
      },
    },
  }));
}

const TOOL_RESULT =
  "Result: 3 records found. Latest shows a pending adjustment created two days ago, awaiting supervisor " +
  "approval, with no customer notification sent yet.";

type AnyObject = Record<string, unknown>;

/** One turn of one task, as the caller would build it. */
function buildRequest(taskIndex: number, turn: number, clockHour: number): AnyObject {
  const domain = DOMAINS[taskIndex % DOMAINS.length]!;
  const history: AnyObject[] = [];
  for (let past = 0; past < turn; past += 1) {
    history.push({ role: "user", content: `Step ${past} for account ${1000 + taskIndex}.` });
    history.push({ role: "assistant", content: TOOL_RESULT });
  }
  return {
    model: "gpt-5",
    // The clock at the top is what stops the preamble from caching.
    instructions: `Current time: ${AT}T${String(clockHour).padStart(2, "0")}:14:22Z\n${PREAMBLE}`,
    tools: tools(),
    input: [
      ...history,
      { role: "user", content: `A customer is asking about ${domain} on account ${1000 + taskIndex}.` },
    ],
    metadata: { domain, taskIndex, turn },
  };
}

/** The prompt text the provider sees, in wire order, for cache matching. */
function wirePrompt(request: AnyObject): string {
  return `${String(request.instructions ?? "")}\n${JSON.stringify(request.tools ?? [])}\n` +
    JSON.stringify(request.input ?? []);
}

/**
 * The simulated model. Picks the tool whose description still says it covers the
 * asked-about domain, and otherwise guesses, which is what a real model does
 * once the catalogue stops discriminating.
 */
function answer(request: AnyObject): {
  correct: boolean;
  outputTokens: number;
  /** How much of the answer the model would naturally have given survived. */
  completeness: number;
} {
  const domain = String((request.metadata as AnyObject).domain);
  const catalogue = (request.tools ?? []) as AnyObject[];
  const matching = catalogue.find((tool) => {
    const fn = tool.function as AnyObject | undefined;
    return typeof fn?.description === "string" && fn.description.includes(`questions about ${domain}`);
  });
  const chosen = matching ?? catalogue[0];
  const name = ((chosen?.function as AnyObject | undefined)?.name ?? "") as string;
  const turn = Number((request.metadata as AnyObject).turn);
  const taskIndex = Number((request.metadata as AnyObject).taskIndex);
  // A long tail, so an output cap has something real to trim.
  const natural = taskIndex % 20 === 0 ? 4_000 : taskIndex % 7 === 0 ? 1_800 : 320 + (turn % 5) * 40;
  const cap = typeof request.max_output_tokens === "number" ? request.max_output_tokens : undefined;
  const outputTokens = cap === undefined ? natural : Math.min(cap, natural);
  return {
    correct: name === `lookup_${domain}`,
    outputTokens,
    // An answer cut at 1,000 of 1,800 tokens kept 56% of what was coming. The
    // same curve the truncation-aware grader uses: below half it is useless,
    // above half it is worth its coverage less a small penalty for being cut.
    completeness: outputTokens >= natural
      ? 1
      : outputTokens / natural < 0.5 ? 0 : Math.max(0, outputTokens / natural - 0.05),
  };
}

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
];

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

function report(policy: CachePolicy, spacing: number): void {
  console.log(`\n=== ${policy.name}, tasks ${spacing}s apart, TTL ${policy.ttlSeconds}s ===`);
  const baseline = runArm(ARMS[0]!, policy, price.price, spacing);
  console.log(
    `${"arm".padEnd(26)} ${"cost".padStart(9)} ${"vs A".padStart(7)} ${"hits".padStart(7)} ` +
    `${"tool ok".padStart(8)} ${"complete".padStart(9)} ${"clean".padStart(7)} ${"$/clean task".padStart(13)}`,
  );
  console.log("-".repeat(92));
  for (const arm of ARMS) {
    const row = runArm(arm, policy, price.price, spacing);
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
  for (const arm of [ARMS[0]!, ARMS[2]!]) {
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
    const result = simulateCache(simulated, OPENAI_CACHE, price.price, { countTokens: approximateTokenCount });
    console.log(
      `${arm.label.padEnd(26)} cost $${result.totalCostUsd.toFixed(3)}, hit rate ` +
      `${(result.hitRate * 100).toFixed(0)}%, saving vs no-cache ${result.savingPercent.toFixed(1)}%`,
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
