import { replayGate, toolSelectionGrader, type ReplayCandidate, type ReplayGrader } from "../packages/sdk-js/src/index.js";
import { approximateTokenCount, lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";

/**
 * What every shipped lever is worth together, with caching and output priced.
 *
 * The earlier gate demo understated the total twice over. Its stub reported no
 * cached tokens, so prefix caching contributed nothing even though the shipped
 * code repairs the prefix; and it returned a flat 40 output tokens, so output
 * budgeting had nothing to bite on even though output costs 8x input on gpt-5.
 *
 * This stub fixes both. It bills a stable prefix at the cached rate once it has
 * been seen, and it produces output whose length depends on the cap. Quality is
 * graded on tool choice AND on whether the answer was cut off mid-sentence, so
 * an over-tight cap is punished rather than rewarded.
 */

const AT = "2026-10-08";
const DOMAINS = ["refunds", "chargebacks", "payouts", "disputes", "settlements"] as const;

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

const requests = Array.from({ length: 60 }, (_, index) => {
  const domain = DOMAINS[index % DOMAINS.length]!;
  return {
    model: "gpt-5",
    // The clock sits at the top, which is what stops the preamble caching.
    instructions: `Current time: ${AT}T${String(8 + (index % 10)).padStart(2, "0")}:14:22Z\n${PREAMBLE}`,
    tools: tools(),
    input: [{ role: "user", content: `A customer is asking about ${domain} on account ${1000 + index}.` }],
    metadata: { domain, index },
  };
});

type AnyObject = Record<string, unknown>;

/** Prefixes the provider has already cached, keyed by their exact text. */
const cacheSeen = new Set<string>();
const CACHE_MINIMUM = 1_024;

/**
 * Longest leading run of the instructions that is stable across requests.
 * Stands in for a provider matching an exact prefix: everything up to the first
 * per-request value can cache, and nothing after it can.
 */
function cacheablePrefix(instructions: string): string {
  const clock = instructions.search(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  return clock === -1 ? instructions : instructions.slice(0, clock);
}

/**
 * Natural answer length, with a long tail.
 *
 * A constant length would make output capping look worthless, because a cap
 * either never binds or truncates everything. Real workloads are skewed: most
 * answers are short and a few run very long, and that tail is what a cap set at
 * a high percentile removes. Deterministic so the run is reproducible.
 */
function naturalOutput(index: number): number {
  if (index % 20 === 0) return 4_000;
  if (index % 7 === 0) return 1_800;
  return 320 + (index % 5) * 40;
}

async function call(request: unknown): Promise<unknown> {
  const row = request as AnyObject;
  const domain = String((row.metadata as AnyObject | undefined)?.domain ?? "");
  const catalogue = (row.tools ?? []) as AnyObject[];
  const matching = catalogue.find((tool) => {
    const fn = tool.function as AnyObject | undefined;
    return typeof fn?.description === "string" && fn.description.includes(`questions about ${domain}`);
  });
  const chosen = (matching ?? catalogue[0])?.function as AnyObject | undefined;

  const instructions = String(row.instructions ?? "");
  const totalInput = approximateTokenCount(JSON.stringify(request));
  const prefix = cacheablePrefix(instructions);
  const prefixTokens = approximateTokenCount(prefix);

  // Cached only when the prefix is long enough and has been seen before.
  let cachedTokens = 0;
  if (prefixTokens >= CACHE_MINIMUM) {
    if (cacheSeen.has(prefix)) cachedTokens = Math.min(prefixTokens, totalInput);
    else cacheSeen.add(prefix);
  }

  // The request carries its own index so the stub is deterministic per request.
  const index = Number((row.metadata as AnyObject | undefined)?.index ?? 0);
  const natural = naturalOutput(index);
  const cap = typeof row.max_output_tokens === "number" ? row.max_output_tokens : undefined;
  const outputTokens = cap === undefined ? natural : Math.min(cap, natural);
  const truncated = cap !== undefined && cap < natural;

  return {
    id: "resp",
    output: [{
      type: "function_call",
      name: chosen?.name ?? "unknown",
      arguments: JSON.stringify({ accountId: "1000" }),
    }],
    // Reported so the grader can punish a cap that cut the answer short.
    finish_reason: truncated ? "length" : "stop",
    usage: {
      input_tokens: totalInput,
      output_tokens: outputTokens,
      input_tokens_details: { cached_tokens: cachedTokens },
    },
  };
}

/**
 * Tool choice must match AND the answer must not be cut off. Grading on tool
 * choice alone would let an aggressive output cap through for free.
 */
const grader: ReplayGrader = (comparison) => {
  const tool = Number(toolSelectionGrader(comparison));
  const candidate = comparison.candidateResponse as AnyObject;
  const cutOff = candidate.finish_reason === "length";
  return cutOff ? 0 : tool;
};

const candidates: ReplayCandidate[] = [
  // Not a no-op: reduceRequest's lossless transforms are opt-out, so an empty
  // config still compacts schemas and removes duplicates. The gate's own
  // baseline (the unreduced request) is the true 0% reference.
  { label: "1. lossless defaults", config: {} },
  { label: "2. lossless schema only", config: { toolSchemas: true } },
  {
    label: "3. + prefix repair (caching)",
    config: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
  },
  {
    label: "4. + descriptions to 40",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
    },
  },
  {
    label: "5a. + output cap 4000 (above the tail)",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 4_000,
    },
  },
  {
    label: "5b. + output cap 2000",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 2_000,
    },
  },
  {
    label: "5c. + output cap 1000",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 1_000,
    },
  },
  {
    label: "6. + output cap 400 (too tight)",
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 400,
    },
  },
  {
    label: "7. + descriptions dropped",
    config: {
      toolSchemas: { descriptions: "drop" },
      duplicateContext: true,
      repairCachePrefix: true,
      maxOutputTokens: 1_000,
    },
  },
];

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

const result = await replayGate({
  requests,
  call,
  candidates,
  // Every run starts with a cold cache. Otherwise the baseline warms it and
  // each candidate inherits a saving it did not produce.
  beforeRun: () => { cacheSeen.clear(); },
  grade: grader,
  maximumQualityDrop: 0.02,
  groupOf: (request) => String(((request as AnyObject).metadata as AnyObject).domain),
  price: price.price,
});

console.log(`=== every shipped lever, ${requests.length} requests, caching and output priced ===`);
console.log(`gpt-5: input $${price.price.inputPerMillion}/M, cached $${price.price.cachedInputPerMillion}/M, ` +
  `output $${price.price.outputPerMillion}/M\n`);
console.log(
  `${"candidate".padEnd(32)} ${"cost saved".padStart(11)} ${"quality".padStart(9)} ${"bound".padStart(9)}  verdict`,
);
console.log("-".repeat(88));
for (const candidate of result.candidates) {
  console.log(
    `${candidate.label.padEnd(32)} ` +
    `${`${(candidate.costSavingPercent ?? 0).toFixed(1)}%`.padStart(11)} ` +
    `${`${(candidate.meanQualityDelta * 100).toFixed(1)}pp`.padStart(9)} ` +
    `${`${(candidate.lower95QualityDelta * 100).toFixed(1)}pp`.padStart(9)}  ` +
    `${candidate.approved ? "APPROVED" : "rejected"}`,
  );
}

if (result.approved) {
  const best = result.approved;
  console.log(`\nBest setting that held quality: ${best.label}`);
  console.log(`  cost          ${(best.costSavingPercent ?? 0).toFixed(1)}% lower`);
  console.log(`  input tokens  ${best.baselineUsage.inputTokens.toLocaleString()} -> ` +
    `${best.candidateUsage.inputTokens.toLocaleString()}`);
  console.log(`  output tokens ${best.baselineUsage.outputTokens.toLocaleString()} -> ` +
    `${best.candidateUsage.outputTokens.toLocaleString()}`);
  const monthly = 10_000;
  console.log(`\n  On $${monthly.toLocaleString()}/month of spend: ` +
    `$${Math.round(monthly * ((best.costSavingPercent ?? 0) / 100)).toLocaleString()} saved per month.`);
}
for (const note of result.notes) console.log(`note: ${note}`);
