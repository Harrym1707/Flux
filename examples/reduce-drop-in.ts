import { withFlux } from "../packages/sdk-js/src/index.js";
import { approximateTokenCount, lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";

/**
 * Before and after on a real request shape, through the real SDK wrapper.
 *
 * No network: a stub client records exactly what FLUX would have sent and
 * returns a plausible usage block, so the comparison is of request payloads
 * rather than of two different model runs.
 *
 * This is the first point at which FLUX reduces tokens rather than measuring
 * how much it could reduce them.
 */

const AT = "2026-10-08";

const INSTRUCTION = (index: number) =>
  `Rule ${index}: confirm the account identifier before quoting any figure, and never speculate about refunds ` +
  "that have not been approved by a supervisor. Escalate chargebacks, fraud, or legal threats to a human.";

const SYSTEM_PROMPT = [
  "You are a senior support agent for a payments company.",
  ...Array.from({ length: 40 }, (_, index) => INSTRUCTION(index)),
].join("\n\n");

const KB_ARTICLE =
  "Knowledge base article 4471: Refunds issued to a closed card are returned to the original payment method " +
  "where the issuer supports it. Where the issuer does not, the balance is credited to the customer wallet.";

function tools(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "function",
    function: {
      name: `lookup_record_${index}`,
      description:
        `Look up record set ${index} for a customer account. Use this when the customer asks about historical ` +
        "activity in this subsystem. Returns a paginated list ordered by creation time descending. Do not call " +
        "this more than once per turn; prefer narrowing the query with filters over paging through results.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          accountId: { type: "string", title: "accountId", description: "The customer account identifier." },
          since: { type: "string", title: "since", description: "ISO 8601 timestamp." },
          limit: { type: "integer", title: "limit", description: "Between 1 and 100 inclusive." },
        },
        required: ["accountId"],
      },
    },
  }));
}

/** A request shaped like a real agent turn, with the usual waste in it. */
function buildRequest(): Record<string, unknown> {
  return {
    model: "gpt-5",
    // A per-request clock at the very top, which ends the cacheable prefix.
    instructions: `Current time: ${AT}T09:14:22Z\n${SYSTEM_PROMPT}`,
    tools: tools(40),
    input: [
      // The same article arrives twice from overlapping retrieval chunks.
      { role: "user", content: `${KB_ARTICLE}\n\n${KB_ARTICLE}\n\nWhy was my refund delayed?` },
    ],
  };
}

let sent: Record<string, unknown> | undefined;
const stubClient = {
  responses: {
    create: async (request: Record<string, unknown>) => {
      sent = request;
      return {
        id: "resp_1",
        usage: { input_tokens: 17_500, output_tokens: 800, input_tokens_details: { cached_tokens: 0 } },
      };
    },
  },
};

const measure = (request: Record<string, unknown>): number =>
  approximateTokenCount(String(request.instructions ?? "")) +
  approximateTokenCount(JSON.stringify(request.input ?? "")) +
  approximateTokenCount(JSON.stringify(request.tools ?? ""));

const original = buildRequest();
const before = measure(original);

const client = withFlux(stubClient as never, {
  applicationId: "reduce-demo",
  tokenReduction: {
    // Lossless only: descriptions are kept, duplicates must be exact, and
    // prefix repair reorders text without removing any of it.
    toolSchemas: true,
    duplicateContext: true,
    repairCachePrefix: true,
  },
});

await (client as unknown as { responses: { create: (r: unknown) => Promise<unknown> } })
  .responses.create(buildRequest());

if (sent === undefined) throw new Error("The stub client was never called.");
const after = measure(sent);

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

const perRequestSaving = ((before - after) / 1_000_000) * price.price.inputPerMillion;

console.log("=== request payload, before and after ===");
console.log(`input tokens (estimated)   ${before.toLocaleString()} -> ${after.toLocaleString()}`);
console.log(`reduction                  ${(((before - after) / before) * 100).toFixed(1)}%`);
console.log(`tools serialised           ${JSON.stringify(original.tools).length.toLocaleString()} -> ` +
  `${JSON.stringify(sent.tools).length.toLocaleString()} chars`);
console.log(`cost at gpt-5 input rate   $${perRequestSaving.toFixed(6)} saved per request`);
console.log(`                           $${(perRequestSaving * 1_000_000).toFixed(0)} per million requests`);

console.log("\n=== what changed ===");
console.log(`descriptions kept          ${JSON.stringify(sent.tools).includes("paginated list") ? "yes" : "NO"}`);
console.log(`$schema removed            ${JSON.stringify(sent.tools).includes("$schema") ? "NO" : "yes"}`);
console.log(`duplicate article removed  ${
  (JSON.stringify(sent.input).split("article 4471").length - 1) === 1 ? "yes" : "NO"}`);
const instructions = String(sent.instructions);
console.log(`clock moved off the front  ${instructions.startsWith("You are a senior") ? "yes" : "NO"}`);
console.log(`clock still present        ${instructions.includes("Current time") ? "yes" : "NO"}`);
const stablePrefix = approximateTokenCount(instructions.split("Current time")[0] ?? "");
console.log(`stable prefix now          ${stablePrefix.toLocaleString()} tokens`);

// Prefix repair does not remove tokens, so it is absent from the figure above.
// Its value is a rate change: those tokens now bill at the cached rate on every
// request after the first.
const cachedRate = price.price.cachedInputPerMillion ?? price.price.inputPerMillion;
const cacheSaving = (stablePrefix / 1_000_000) * (price.price.inputPerMillion - cachedRate);
console.log("\n=== prefix repair, which removes no tokens ===");
console.log(`${stablePrefix.toLocaleString()} tokens move from $${price.price.inputPerMillion}/M to ` +
  `$${cachedRate}/M once cached`);
console.log(`cache saving               $${cacheSaving.toFixed(6)} per request after the first`);
console.log(`combined                   $${(perRequestSaving + cacheSaving).toFixed(6)} per request, ` +
  `$${((perRequestSaving + cacheSaving) * 1_000_000).toFixed(0)} per million`);
console.log(`combined reduction         ${
  (((before - after) / before + (cacheSaving / ((before / 1_000_000) * price.price.inputPerMillion))) * 100)
    .toFixed(1)}% of input spend`);
