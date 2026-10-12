/**
 * The shared agent fixture: tasks, tools, simulated model and quality bar.
 *
 * Extracted VERBATIM from evals/run-agent-ab.ts so the A/B harness and the
 * replay gate drive the exact same simulated agent. Any script that measures a
 * saving and any gate that approves a lever must agree on what the model does,
 * or the gate verdict would not be about the thing that was measured.
 *
 * The only additions on top of the verbatim move are the two env knobs:
 *
 *   FLUX_AB_TASKS  - task count (default 40, the original constant).
 *   FLUX_AB_SEED   - rotates the task->domain ASSIGNMENT only (default 0).
 *
 * With both unset, every byte of every request is identical to the original
 * inline fixture. The seed must never touch the natural-output-length formula
 * in answer() or the natural lengths in toolResult(): those are the fixture's
 * immutable quality bar, and tuning them would be fixture-juicing.
 */

export const AT = "2026-10-08";
export const DOMAINS = ["refunds", "chargebacks", "payouts", "disputes", "settlements"] as const;

function envInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

/** Task count. Defaults to the original 40; FLUX_AB_TASKS overrides. */
export const TASKS = envInteger("FLUX_AB_TASKS", 40, 1, 2_000);
export const TURNS_PER_TASK = 5;

/**
 * Domain-rotation seed. FLUX_AB_SEED shifts which domain each task asks about,
 * so a run at SEED=3 is the same workload with the task->domain table rotated.
 * It deliberately cannot change anything else: not the tool results, not the
 * output-length formula, not the quality logic.
 */
export const SEED_OFFSET = envInteger("FLUX_AB_SEED", 0, 0, 1_000);

/** The task->domain assignment, the ONLY thing FLUX_AB_SEED may rotate. */
export function domainOf(taskIndex: number): (typeof DOMAINS)[number] {
  return DOMAINS[(taskIndex + SEED_OFFSET) % DOMAINS.length]!;
}

export const PREAMBLE = [
  "You are a senior support agent for a payments company.",
  ...Array.from({ length: 60 }, (_, index) =>
    `Rule ${index}: confirm the account identifier before quoting a figure, never speculate about unapproved ` +
    "refunds, and escalate chargebacks or legal threats to a human with the reason recorded."),
].join("\n\n");

export function tools(): unknown[] {
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

/**
 * A realistically sized tool result (~2.5KB), deterministic per task and turn.
 *
 * Day 1 measured compaction at 0.7-2.9% and diagnosed why: the old 140-char
 * constant gave it nothing to compact, while real agent tool results run to
 * kilobytes. The shape mirrors reality against the digest rules honestly: a
 * headline carrying the reference later turns depend on, a mostly-verbose body
 * that a digest may collapse, and an occasional error line that must survive.
 * This makes the fixture HARDER, not softer: answer() now fails any task whose
 * latest result lost its reference.
 */
export function toolResult(taskIndex: number, turn: number): string {
  const ref = `R-${taskIndex}-${turn}`;
  const lines = [
    `Lookup complete for account ${1000 + taskIndex}: 3 records found; latest reference ${ref} ` +
    "with a pending adjustment awaiting supervisor approval.",
  ];
  for (let row = 0; row < 18; row += 1) {
    lines.push(
      `Record ${row} shows a settlement entry of ${(row * 137 + taskIndex) % 9000} pence captured on day ` +
      `${(row + turn) % 28 + 1}, routed through the ${DOMAINS[(row + taskIndex) % DOMAINS.length]} subsystem, ` +
      "with reconciliation state nominal, no customer notification sent, retention window standard, and " +
      "two internal annotations noting routine supervisor review cadence for entries of this category.",
    );
  }
  if (turn % 3 === 2) {
    lines.push(`One earlier retry failed with a transient timeout before record ${turn} was captured cleanly.`);
  }
  return lines.join(" ");
}

export type AnyObject = Record<string, unknown>;

/** One turn of one task, as the caller would build it. */
export function buildRequest(taskIndex: number, turn: number, clockHour: number): AnyObject {
  // domainOf() replaces the original inline `DOMAINS[taskIndex % DOMAINS.length]`
  // so FLUX_AB_SEED can rotate the assignment; at the default seed of 0 it is
  // the same expression and every request byte is unchanged.
  const domain = domainOf(taskIndex);
  const history: AnyObject[] = [];
  for (let past = 0; past < turn; past += 1) {
    history.push({ role: "user", content: `Step ${past} for account ${1000 + taskIndex}.` });
    history.push({ role: "assistant", content: toolResult(taskIndex, past) });
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
export function wirePrompt(request: AnyObject): string {
  return `${String(request.instructions ?? "")}\n${JSON.stringify(request.tools ?? [])}\n` +
    JSON.stringify(request.input ?? []);
}

/**
 * The simulated model. Picks the tool whose description still says it covers the
 * asked-about domain, and otherwise guesses, which is what a real model does
 * once the catalogue stops discriminating.
 */
export function answer(request: AnyObject): {
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
  // Recency dependency: the model needs the LATEST tool result's reference to
  // act correctly, exactly as a real model needs its most recent observation.
  // A reducer that trims or digests the most recent turn now FAILS the task,
  // so this tightens the quality bar on every reduction lever.
  const latestReferenceIntact = turn === 0 ||
    JSON.stringify(request.input ?? []).includes(`latest reference R-${taskIndex}-${turn - 1}`);
  // A long tail, so an output cap has something real to trim.
  const natural = taskIndex % 20 === 0 ? 4_000 : taskIndex % 7 === 0 ? 1_800 : 320 + (turn % 5) * 40;
  const cap = typeof request.max_output_tokens === "number" ? request.max_output_tokens : undefined;
  const outputTokens = cap === undefined ? natural : Math.min(cap, natural);
  return {
    correct: name === `lookup_${domain}` && latestReferenceIntact,
    outputTokens,
    // An answer cut at 1,000 of 1,800 tokens kept 56% of what was coming. The
    // same curve the truncation-aware grader uses: below half it is useless,
    // above half it is worth its coverage less a small penalty for being cut.
    completeness: outputTokens >= natural
      ? 1
      : outputTokens / natural < 0.5 ? 0 : Math.max(0, outputTokens / natural - 0.05),
  };
}
