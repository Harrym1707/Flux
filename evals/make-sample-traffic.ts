import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Generate sample traffic in the shapes real logs arrive in, so the analyser can
 * be exercised without anyone's production data.
 *
 * Deliberately includes the failure modes worth catching: a timestamp in an
 * otherwise-identical system prompt, a tool catalogue resent every turn, a
 * duplicated retrieval block, a workload already partly cached, and a model the
 * price catalogue does not know.
 */

const out = resolve(process.argv[2] ?? "sample-traffic");

const INSTRUCTION_BLOCK = (index: number) =>
  `Rule ${index}: when the customer asks about billing, confirm the account identifier before quoting any figure, ` +
  "and never speculate about refunds that have not been approved by a supervisor. Escalate anything involving " +
  "chargebacks, fraud, or legal threats to a human immediately and record the reason for the escalation.";

const SYSTEM_PROMPT = [
  "You are a senior support agent for a payments company.",
  ...Array.from({ length: 40 }, (_, index) => INSTRUCTION_BLOCK(index)),
].join("\n\n");

function toolDefinitions(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "function",
    function: {
      name: `lookup_record_${index}`,
      description:
        `Look up record set ${index} for a customer account. Use this when the customer asks about historical ` +
        "activity in this subsystem. Returns a paginated list ordered by creation time descending. Do not call " +
        "this more than once per turn; prefer narrowing the query with filters over paging through results. " +
        "If the account is closed the call returns an empty list rather than an error.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "The customer account identifier, as shown in the admin console." },
          since: { type: "string", description: "ISO 8601 timestamp. Only records created at or after this time." },
          limit: { type: "integer", description: "Maximum records to return, between 1 and 100 inclusive." },
          includeArchived: { type: "boolean", description: "Whether to include archived records in the response." },
        },
        required: ["accountId"],
      },
    },
  }));
}

const RETRIEVED_BLOCK =
  "Knowledge base article 4471: Refunds issued to a closed card are returned to the original payment method " +
  "where the issuer supports it. Where the issuer does not, the balance is credited to the customer wallet and " +
  "the customer is notified by email within one business day.";

// 1. Tool-heavy agent, OpenAI Responses shape. The clock breaks the prefix.
const agent = Array.from({ length: 30 }, (_, index) => {
  const history = Array.from({ length: 4 }, (_, turn) =>
    ({ role: turn % 2 === 0 ? "user" : "assistant", content: `Turn ${turn} of conversation ${index}. ${RETRIEVED_BLOCK}` }));
  return {
    id: `agent-${index}`,
    workload: "coding-agent",
    at: "2026-10-08",
    request: {
      model: "gpt-5",
      // A per-request timestamp at the very top of an otherwise identical prompt.
      instructions: `Current time: 2026-10-08T${String(8 + (index % 10)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z\n${SYSTEM_PROMPT}`,
      tools: toolDefinitions(40),
      input: [
        ...history,
        { role: "user", content: `Please investigate account ${1000 + index} and summarise what happened.` },
      ],
    },
    response: {
      usage: {
        input_tokens: 17_500 + index * 20,
        output_tokens: index % 7 === 0 ? 2_400 : 800,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
});

// 2. Support assistant, Anthropic Messages shape, already partly cached.
const support = Array.from({ length: 40 }, (_, index) => ({
  id: `support-${index}`,
  workload: "support-assistant",
  at: "2026-10-08",
  request: {
    model: "Sonnet 5.5",
    system: SYSTEM_PROMPT,
    messages: [
      // The same knowledge base block arrives twice from overlapping chunks.
      { role: "user", content: `${RETRIEVED_BLOCK}\n\n${RETRIEVED_BLOCK}\n\nWhy was my refund delayed?` },
    ],
  },
  response: {
    usage: {
      input_tokens: 900,
      cache_read_input_tokens: index === 0 ? 0 : 3_400,
      cache_creation_input_tokens: index === 0 ? 3_400 : 0,
      output_tokens: 300 + (index % 5) * 40,
    },
  },
}));

// 3. Usage-only billing export, including a model the catalogue cannot price.
const billing = Array.from({ length: 50 }, (_, index) => ({
  id: `billing-${index}`,
  workload: index % 5 === 0 ? "batch-classifier" : "chat",
  model: index % 5 === 0 ? "some-finetune-v3" : "gpt-5",
  at: "2026-10-08",
  input_tokens: 4_000 + index * 11,
  output_tokens: 250 + (index % 9) * 30,
}));

const files: Array<[string, unknown[]]> = [
  ["agent.jsonl", agent],
  ["support.jsonl", support],
  ["billing.jsonl", billing],
];

for (const [name, rows] of files) {
  const path = resolve(out, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(`${path}: ${rows.length} rows`);
}
