import { pathToFileURL } from "node:url";
import {
  OPENAI_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import {
  agentGrader,
  reduceRequest,
  replayGate,
  type ReplayCandidate,
  type ReplayGateResult,
} from "../packages/sdk-js/src/index.js";
import {
  AT,
  TASKS,
  TURNS_PER_TASK,
  answer,
  buildRequest,
  wirePrompt,
  type AnyObject,
} from "./agent-fixture.js";

/**
 * The replay gate run against the fresh tool-result cap, on the SAME fixture
 * the A/B harness measures.
 *
 * The A/B harness (evals/run-agent-ab.ts) says arm J saves 26-29% on
 * interactive traffic. This script answers the independent question: would the
 * production approval machinery - packages/sdk-js/src/replay-gate.ts with the
 * agent grader - have let that lever through? The gate knows nothing about the
 * harness's success counters; it replays every request both ways, grades the
 * responses, and bounds the quality delta with a seeded grouped bootstrap.
 *
 * Honesty properties:
 *
 *   The simulated model is IMPORTED from the shared fixture, never
 *   re-implemented here. answer() decides the tool choice and whether the
 *   latest reference survived; this script only translates its verdict into a
 *   provider-response shape. A response's tool call also embeds the
 *   "latest reference R-x-y" string actually found in the request, so a
 *   reducer that destroys the reference produces a mismatched tool call and
 *   the gate hard-fails exactly the requests answer() fails.
 *
 *   Usage comes from a run-local cache-simulator accumulator, reset by
 *   beforeRun between the baseline and every candidate, so the baseline run
 *   cannot warm the cache a candidate is then measured against.
 *
 *   The full arm J stack is gated too, at the DEFAULT 2% quality budget. Its
 *   2,000-token output cap halves the two 4,000-token answers, which costs
 *   about -2.75% mean quality on this fixture, so the gate is expected to
 *   REJECT it. That rejection is reported, not hidden: it is the gate having
 *   teeth. Enabling full J in production means either accepting a wider,
 *   explicitly agreed budget for the output cap or shipping J-minus-the-cap;
 *   raising the default here to make J pass would be gate-softening.
 */

const priced = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (priced.status !== "priced") throw new Error(priced.reason);
const GPT5_PRICE = priced.price;

/** All TASKS x TURNS_PER_TASK fixture requests, in task order. */
export function buildFixtureRequests(): AnyObject[] {
  const requests: AnyObject[] = [];
  for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
    const clockHour = 8 + (taskIndex % 10);
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      requests.push(buildRequest(taskIndex, turn, clockHour));
    }
  }
  return requests;
}

/**
 * A simulated provider around the shared fixture.
 *
 * call() delegates every quality decision to the fixture's answer() and prices
 * usage with the provider-rule cache simulator. The accumulator `seen` is the
 * provider's cache state for ONE run; beforeRun must clear it so runs are
 * independent, exactly as the gate's documentation demands.
 */
export function createSimulatedProvider(): {
  call: (request: unknown) => Promise<unknown>;
  beforeRun: (label: string) => void;
} {
  let seen: SimulatedRequest[] = [];
  // approximateTokenCount over a growing request list is rerun per call;
  // memoising by exact prompt string keeps that honest AND fast.
  const tokenCounts = new Map<string, number>();
  const countTokens = (text: string): number => {
    const cached = tokenCounts.get(text);
    if (cached !== undefined) return cached;
    const counted = approximateTokenCount(text);
    tokenCounts.set(text, counted);
    return counted;
  };

  const call = async (request: unknown): Promise<unknown> => {
    const row = request as AnyObject;
    const metadata = row.metadata as AnyObject;
    const taskIndex = Number(metadata.taskIndex);
    const turn = Number(metadata.turn);
    const domain = String(metadata.domain);

    // The shared fixture decides everything about quality: tool choice,
    // whether the latest reference survived, and the natural output length.
    const outcome = answer(row);

    // The latest reference string as it actually survived in THIS request's
    // input. Baseline requests always carry it; a candidate whose reducer
    // destroyed it embeds a different (or missing) string, the tool-call
    // arguments stop matching, and the agent grader hard-fails the request -
    // the same requests answer() fails.
    const references = JSON.stringify(row.input ?? []).match(/latest reference R-\d+-\d+/g);
    const latestReference = turn === 0 ? "first-turn" : references?.at(-1) ?? "REFERENCE-LOST";

    // Tool choice delegated to answer(): a correct outcome reproduces the
    // canonical call, an incorrect one visibly diverges from it.
    const toolName = outcome.correct ? `lookup_${domain}` : `misrouted_lookup_${domain}`;
    const argumentsJson = JSON.stringify({
      accountId: String(1_000 + taskIndex),
      latestReference,
    });

    // Answer text sized one word per output token, so the truncation-aware
    // grader sees the same coverage ratio the fixture's completeness curve
    // uses. Truncation is flagged exactly when the fixture says the natural
    // answer was cut (completeness < 1).
    const truncated = outcome.completeness < 1;
    const text = Array.from({ length: outcome.outputTokens }, (_, index) => `t${index % 9}`).join(" ");

    // Usage from the run-local provider-rule cache accumulator. Arrival times
    // match the harness's interactive block: tasks 30s apart, turns 3s apart.
    seen.push({
      atSeconds: taskIndex * 30 + turn * 3,
      prompt: wirePrompt(row),
      outputTokens: outcome.outputTokens,
    });
    const priced = simulateCache(seen, OPENAI_CACHE, GPT5_PRICE, { countTokens });
    const lastCall = priced.calls[priced.calls.length - 1]!;

    return {
      output: [
        { type: "function_call", name: toolName, arguments: argumentsJson },
        { type: "message", content: [{ type: "output_text", text }] },
      ],
      ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      usage: {
        input_tokens: lastCall.totalInputTokens,
        output_tokens: outcome.outputTokens,
        input_tokens_details: { cached_tokens: lastCall.cachedInputTokens },
      },
    };
  };

  const beforeRun = (_label: string): void => {
    // A fresh provider cache per run: the baseline must not warm the cache the
    // candidate is then priced against, and vice versa.
    seen = [];
  };

  return { call, beforeRun };
}

/**
 * The PRIMARY candidate: the fresh tool-result cap in ISOLATION on top of the
 * already-approved lossless tier (arm C). Expected verdict: approved, with a
 * quality delta of exactly 0 - the capper keeps every headline, so answer()
 * never changes its mind - and inputTokensSaved > 0.
 */
export const FRESH_CAP_ISOLATION: ReplayCandidate = {
  label: "C + fresh tool-result cap (isolation)",
  config: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, freshToolResultCap: true },
};

/**
 * The full arm J stack, included so its rejection is ON the record. The
 * 2,000-token output cap costs ~2.75% mean quality on this fixture, which
 * breaches the DEFAULT 2% budget; the gate is expected to reject it, and that
 * expected rejection is reported below rather than papered over with a wider
 * budget.
 */
export const FULL_ARM_J: ReplayCandidate = {
  label: "J. full interactive stack (cap 2000)",
  config: {
    toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
    duplicateContext: true,
    repairCachePrefix: true,
    freshToolResultCap: true,
    historyCompaction: true,
    maxOutputTokens: 2_000,
  },
};

/** Run the gate over the fixture. Exported so the tests drive the same path. */
export async function runFreshCapGate(requests: AnyObject[], candidates: ReplayCandidate[]): Promise<ReplayGateResult> {
  const provider = createSimulatedProvider();
  return replayGate({
    requests,
    call: provider.call,
    beforeRun: provider.beforeRun,
    candidates,
    grade: agentGrader(),
    // Turns of one task share a prompt and a fate: group them so the bootstrap
    // does not treat five correlated comparisons as five independent ones.
    groupOf: (request) => `task-${((request as AnyObject).metadata as AnyObject).taskIndex}`,
    seed: "flux-replay-gate-v1",
    price: GPT5_PRICE,
  });
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(3)}`;
}

async function main(): Promise<void> {
  const requests = buildFixtureRequests();
  console.log(
    `replay gate over ${requests.length} fixture requests ` +
    `(${TASKS} tasks x ${TURNS_PER_TASK} turns), seed flux-replay-gate-v1, default 2% quality budget`,
  );

  // The change record for the lever under gate, from the reducer itself, so
  // the lever name in the verdict is traceable to the code that ran.
  const sample = reduceRequest(requests[requests.length - 1]!, FRESH_CAP_ISOLATION.config);
  const capChange = sample.summary.changes.find((change) => change.lever === "fresh-tool-result-cap");
  if (!capChange) throw new Error("fresh-tool-result-cap produced no change record on the sample request.");
  console.log(`\nchange record under gate: lever '${capChange.lever}' (lossless: ${capChange.lossless})`);
  console.log(`  ${capChange.detail}`);

  const result = await runFreshCapGate(requests, [FRESH_CAP_ISOLATION, FULL_ARM_J]);

  console.log(`\nprovider calls paid for: ${result.calls} (baseline + one run per candidate)`);
  for (const candidate of result.candidates) {
    console.log(`\n--- ${candidate.label} ---`);
    console.log(`  graded ${candidate.graded}, failed ${candidate.failed}`);
    console.log(
      `  mean quality delta ${(candidate.meanQualityDelta * 100).toFixed(2)} pp, ` +
      `lower95 ${(candidate.lower95QualityDelta * 100).toFixed(2)} pp`,
    );
    console.log(
      `  input tokens: baseline ${candidate.baselineUsage.inputTokens.toLocaleString("en-US")} ` +
      `(${candidate.baselineUsage.cachedInputTokens.toLocaleString("en-US")} cached) -> candidate ` +
      `${candidate.candidateUsage.inputTokens.toLocaleString("en-US")} ` +
      `(${candidate.candidateUsage.cachedInputTokens.toLocaleString("en-US")} cached); ` +
      `saved ${candidate.inputTokensSaved.toLocaleString("en-US")} input + ` +
      `${candidate.outputTokensSaved.toLocaleString("en-US")} output ` +
      `(${candidate.tokenSavingPercent.toFixed(1)}% of tokens)`,
    );
    console.log(
      `  cost: saved ${formatUsd(candidate.costSavedUsd)}` +
      (candidate.costSavingPercent === undefined ? "" : ` (${candidate.costSavingPercent.toFixed(1)}%)`),
    );
    console.log(
      `  verdict: ${candidate.approved ? "APPROVED" : "REJECTED"}` +
      (candidate.rejectionReason ? ` - ${candidate.rejectionReason}` : ""),
    );
  }

  for (const note of result.notes) console.log(`note: ${note}`);

  console.log(
    `\ngate verdict: ${result.approved ? `approved '${result.approved.label}'` : "nothing approved"} ` +
    `at the default ${(result.maximumQualityDrop * 100).toFixed(0)}% budget.`,
  );
  console.log(
    "Arm J's rejection here is the gate having teeth: its 2,000-token output cap halves the two\n" +
    "4,000-token answers, which the agent grader prices at about -2.75% mean quality - over the\n" +
    "default 2% budget. Shipping full J therefore requires the customer to EXPLICITLY accept a\n" +
    "wider budget for the output cap; the fresh cap itself rides through at exactly zero.",
  );

  // Hard expectations, so a regression in the gate or the lever fails loudly.
  const freshCap = result.candidates.find((candidate) => candidate.label === FRESH_CAP_ISOLATION.label)!;
  if (!freshCap.approved) throw new Error("Expected the isolated fresh cap to be approved.");
  if (freshCap.meanQualityDelta !== 0 || freshCap.lower95QualityDelta !== 0) {
    throw new Error("Expected the isolated fresh cap to hold quality at exactly zero delta.");
  }
  if (freshCap.inputTokensSaved <= 0) throw new Error("Expected the isolated fresh cap to save input tokens.");
  const fullJ = result.candidates.find((candidate) => candidate.label === FULL_ARM_J.label)!;
  if (fullJ.approved) {
    throw new Error("Expected full arm J to be rejected at the default 2% budget; it was approved - " +
      "check that the budget or grader was not loosened.");
  }
  console.log("\nexpectations held: fresh cap approved at zero delta with tokens saved; full J rejected at 2%.");
}

const isDirectRun = typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
