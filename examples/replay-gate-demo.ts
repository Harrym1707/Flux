import {
  replayGate,
  toolSelectionGrader,
  type ReplayCandidate,
} from "../packages/sdk-js/src/index.js";
import { approximateTokenCount, lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";

/**
 * The replay gate deciding which lossy reductions may be switched on.
 *
 * The stand-in model here is not a rubber stamp. It picks a tool by looking for
 * a discriminating phrase in that tool's description, and every description puts
 * that phrase in its second sentence. So a gentle trim keeps the phrase and the
 * model keeps choosing correctly, while an aggressive trim removes it and the
 * model starts picking the wrong tool. That is the real failure mode of this
 * lever, so the gate has something genuine to catch.
 *
 * Usage is computed from the size of whatever request was actually sent, so the
 * token savings the gate reports are measured rather than estimated.
 */

const AT = "2026-10-08";
const DOMAINS = ["refunds", "chargebacks", "payouts", "disputes", "settlements"] as const;

function tools(): unknown[] {
  return DOMAINS.map((domain, index) => ({
    type: "function",
    function: {
      name: `lookup_${domain}`,
      description:
        `Look up records for a customer account in subsystem ${index}. ` +
        // The discriminating sentence, deliberately second.
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

/** 50 questions, each about one domain. */
const requests = Array.from({ length: 50 }, (_, index) => {
  const domain = DOMAINS[index % DOMAINS.length]!;
  return {
    model: "gpt-5",
    instructions: "You are a senior support agent. Choose exactly one tool.",
    tools: tools(),
    input: [{ role: "user", content: `A customer is asking about ${domain} on account ${1000 + index}.` }],
    metadata: { domain },
  };
});

type AnyObject = Record<string, unknown>;

/**
 * Picks the tool whose description still says it handles the asked-about domain.
 * Falls back to the first tool when no description does, which is what a real
 * model does when the catalogue stops being discriminating: it guesses.
 */
async function call(request: unknown): Promise<unknown> {
  const row = request as AnyObject;
  const domain = String((row.metadata as AnyObject | undefined)?.domain ?? "");
  const catalogue = (row.tools ?? []) as AnyObject[];
  const matching = catalogue.find((tool) => {
    const fn = tool.function as AnyObject | undefined;
    return typeof fn?.description === "string" && fn.description.includes(`questions about ${domain}`);
  });
  const chosen = (matching ?? catalogue[0])?.function as AnyObject | undefined;
  const inputTokens = approximateTokenCount(JSON.stringify(request));
  return {
    id: "resp",
    output: [{
      type: "function_call",
      name: chosen?.name ?? "unknown",
      arguments: JSON.stringify({ accountId: "1000" }),
    }],
    usage: { input_tokens: inputTokens, output_tokens: 40 },
  };
}

const candidates: ReplayCandidate[] = [
  { label: "lossless only", config: { toolSchemas: true } },
  {
    label: "descriptions to 40 tokens",
    config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 } },
  },
  {
    label: "descriptions to 24 tokens",
    config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 24 } },
  },
  {
    label: "descriptions to 8 tokens",
    config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 8 } },
  },
  { label: "descriptions dropped", config: { toolSchemas: { descriptions: "drop" } } },
];

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

const result = await replayGate({
  requests,
  call,
  candidates,
  grade: toolSelectionGrader,
  maximumQualityDrop: 0.02,
  // Requests about one domain are correlated, so they resample together.
  groupOf: (request) => String(((request as AnyObject).metadata as AnyObject).domain),
  price: price.price,
});

console.log(`=== replay gate: ${requests.length} requests, ${result.calls} provider calls ===`);
console.log(`guardrail: mean quality may fall at most ${(result.maximumQualityDrop * 100).toFixed(0)} pp\n`);
console.log(
  `${"candidate".padEnd(28)} ${"tokens".padStart(9)} ${"cost".padStart(9)} ` +
  `${"quality".padStart(9)} ${"bound".padStart(9)}  verdict`,
);
console.log("-".repeat(90));
for (const candidate of result.candidates) {
  console.log(
    `${candidate.label.padEnd(28)} ` +
    `${`${candidate.tokenSavingPercent.toFixed(1)}%`.padStart(9)} ` +
    `${`${(candidate.costSavingPercent ?? 0).toFixed(1)}%`.padStart(9)} ` +
    `${`${(candidate.meanQualityDelta * 100).toFixed(1)}pp`.padStart(9)} ` +
    `${`${(candidate.lower95QualityDelta * 100).toFixed(1)}pp`.padStart(9)}  ` +
    `${candidate.approved ? "APPROVED" : `rejected: ${candidate.rejectionReason}`}`,
  );
}

console.log("");
if (result.approved) {
  console.log(
    `Most aggressive setting that held quality: ${result.approved.label}, saving ` +
    `${result.approved.tokenSavingPercent.toFixed(1)}% of tokens and ` +
    `${(result.approved.costSavingPercent ?? 0).toFixed(1)}% of cost, with a quality lower bound of ` +
    `${(result.approved.lower95QualityDelta * 100).toFixed(2)} pp.`,
  );
  console.log(
    `Measured from provider-reported usage: ${result.approved.baselineUsage.inputTokens.toLocaleString()} -> ` +
    `${result.approved.candidateUsage.inputTokens.toLocaleString()} input tokens.`,
  );
} else {
  console.log("No candidate held quality.");
}
for (const note of result.notes) console.log(`note: ${note}`);
