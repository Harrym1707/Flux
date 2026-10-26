import { pathToFileURL } from "node:url";
import { lookupPrice, publishedModelPrices, type TokenPrice } from "../packages/core/src/index.js";
import {
  replayGate,
  textSimilarityGrader,
  type ReplayCandidate,
  type ReplayGateResult,
} from "../packages/sdk-js/src/index.js";
import {
  answerProbe,
  approximateTokenCount,
  memoryRecallStream,
  recallProbability,
  recallProbabilityMild,
  wireMemoryRequest,
  type AnyObject,
  type DecayModel,
  type TurnMetadata,
} from "./memory-recall-fixture.js";

/**
 * New-lever research, 2026-10-26: the replay-gate pass `crossTurnMemoryDedup`
 * has been owed since 2026-10-23 (see docs/rnd/2026-10-23-NOTES.md through
 * 2026-10-25-NOTES.md, each carrying it forward as "still owed"). That lever
 * is measured at 58.0% vs the lossless stack on pure token count, but is
 * classified LOSSY and explicitly gated behind a replay-gate pass before any
 * part of it may be billed - this script is that pass.
 *
 *   node --import tsx evals/run-replay-gate-memory-dedup.ts
 *
 * Read evals/memory-recall-fixture.ts's header before this file's output:
 * the quality signal here is a SYNTHETIC, adversarially-shaped degradation
 * model (recall probability falling with distance from the only surviving
 * copy of a fact), not a real LLM-judge grade and not a measurement from any
 * production model. It exists to answer one honest, narrower question than
 * "is this lever safe to bill": does FLUX's OWN replay-gate machinery, at its
 * default 2% quality budget, actually catch a degradation of roughly this
 * shape and refuse to approve it - or would the gate wave it through on
 * nothing more than "the bytes are identical"? A customer must still run
 * their own replay-gate pass, with a real grader on their own traffic,
 * before this lever may ever be billed on their requests.
 */

const AT = "2026-10-19";
const priced = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (priced.status !== "priced") throw new Error(priced.reason);
const PRICE: TokenPrice = priced.price;

const CONVERSATIONS = 8;

const LOSSLESS_CONFIG = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" as const };

export const LOSSLESS_ONLY: ReplayCandidate = {
  label: "B. lossless stack (no dedup)",
  config: LOSSLESS_CONFIG,
};

export const WITH_CROSS_TURN_DEDUP: ReplayCandidate = {
  label: "C. B + crossTurnMemoryDedup",
  config: { ...LOSSLESS_CONFIG, crossTurnMemoryDedup: true },
};

/** All CONVERSATIONS x TURNS fixture requests, flattened, each carrying its own metadata. */
export function buildFixtureRequests(): AnyObject[] {
  const requests: AnyObject[] = [];
  for (let conversationIndex = 0; conversationIndex < CONVERSATIONS; conversationIndex += 1) {
    for (const { request } of memoryRecallStream(conversationIndex)) requests.push(request);
  }
  return requests;
}

/**
 * A simulated provider around the shared fixture. Every quality decision for
 * a probe turn is delegated to answerProbe(), which reads the ACTUAL wired
 * request content (never which arm is running) to decide whether the needed
 * fact is still adjacent or only reachable via a dedup marker - so the same
 * function is correct whether called on the unreduced baseline or a reduced
 * candidate.
 */
export function createSimulatedProvider(decayModel: DecayModel = recallProbability): {
  call: (request: unknown) => Promise<unknown>;
  beforeRun: (label: string) => void;
} {
  let arm = "baseline";

  const call = async (request: unknown): Promise<unknown> => {
    const row = request as AnyObject;
    const metadata = row.metadata as TurnMetadata;
    const wired = wireMemoryRequest(row);
    const inputTokens = approximateTokenCount(wired);

    const text = metadata.isProbe
      ? answerProbe(row, metadata, arm, decayModel).text
      : `Noted. Turn ${metadata.turn} handled.`;
    const outputTokens = approximateTokenCount(text);

    return {
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        input_tokens_details: { cached_tokens: 0 },
      },
    };
  };

  const beforeRun = (label: string): void => {
    arm = label;
  };

  return { call, beforeRun };
}

/** Run the gate over the fixture. Exported so the tests drive the same path. */
export async function runMemoryDedupGate(
  requests: AnyObject[],
  candidates: ReplayCandidate[],
  decayModel: DecayModel = recallProbability,
): Promise<ReplayGateResult> {
  const provider = createSimulatedProvider(decayModel);
  return replayGate({
    requests,
    call: provider.call,
    beforeRun: provider.beforeRun,
    candidates,
    grade: textSimilarityGrader,
    // Every turn of one conversation shares a fate (the same simulated
    // model, the same growing history): grouping by conversation, not by
    // individual turn, is what makes the eight conversations genuine
    // independent replicates for the bootstrap.
    groupOf: (request) => `conversation-${((request as AnyObject).metadata as TurnMetadata).conversationIndex}`,
    seed: "flux-replay-gate-memory-dedup-v1",
    price: PRICE,
  });
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function reportCandidates(result: ReplayGateResult): void {
  for (const candidate of result.candidates) {
    console.log(`\n--- ${candidate.label} ---`);
    console.log(`  graded ${candidate.graded}, failed ${candidate.failed}`);
    console.log(
      `  mean quality delta ${(candidate.meanQualityDelta * 100).toFixed(2)} pp, ` +
      `lower95 ${(candidate.lower95QualityDelta * 100).toFixed(2)} pp`,
    );
    console.log(
      `  input tokens: baseline ${candidate.baselineUsage.inputTokens.toLocaleString("en-US")} -> candidate ` +
      `${candidate.candidateUsage.inputTokens.toLocaleString("en-US")}; saved ` +
      `${candidate.inputTokensSaved.toLocaleString("en-US")} input + ` +
      `${candidate.outputTokensSaved.toLocaleString("en-US")} output (${candidate.tokenSavingPercent.toFixed(1)}%)`,
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
}

async function main(): Promise<void> {
  const requests = buildFixtureRequests();
  console.log(
    `replay gate over ${requests.length} fixture requests (${CONVERSATIONS} conversations x 40 turns, ` +
    "8 recall probes each), seed flux-replay-gate-memory-dedup-v1, default 2% quality budget",
  );
  console.log(
    "quality signal: a SYNTHETIC distance-decay recall model (see memory-recall-fixture.ts header), not a " +
    "real LLM-judge grade - this measures whether the gate's OWN machinery has teeth against a degradation " +
    "of this shape, not whether the lever is safe to bill on real traffic.\n",
  );

  console.log("=== pass 1: ADVERSARIAL decay curve (stress test - up to 65pp recall drop by the last probe) ===");
  const adversarial = await runMemoryDedupGate(requests, [LOSSLESS_ONLY, WITH_CROSS_TURN_DEDUP], recallProbability);
  reportCandidates(adversarial);
  console.log(
    `\ngate verdict: ${adversarial.approved ? `approved '${adversarial.approved.label}'` : "nothing approved"} ` +
    `at the default ${(adversarial.maximumQualityDrop * 100).toFixed(0)}% budget.`,
  );

  console.log("\n\n=== pass 2: MILD decay curve (small, plausible - up to 6pp recall drop by the last probe) ===");
  const mild = await runMemoryDedupGate(requests, [WITH_CROSS_TURN_DEDUP], recallProbabilityMild);
  reportCandidates(mild);
  console.log(
    `\ngate verdict: ${mild.approved ? `approved '${mild.approved.label}'` : "nothing approved"} ` +
    `at the default ${(mild.maximumQualityDrop * 100).toFixed(0)}% budget.`,
  );

  const lossless = adversarial.candidates.find((candidate) => candidate.label === LOSSLESS_ONLY.label)!;
  if (lossless.meanQualityDelta !== 0 || !(Math.abs(lossless.lower95QualityDelta) < 1e-9)) {
    throw new Error("Expected the lossless-only candidate to hold quality at exactly zero delta (it never touches the memory block).");
  }
  const dedupAdversarial = adversarial.candidates.find((candidate) => candidate.label === WITH_CROSS_TURN_DEDUP.label)!;
  if (dedupAdversarial.approved) {
    throw new Error(
      "Expected crossTurnMemoryDedup to be REJECTED by the gate under the ADVERSARIAL distance-decay model " +
      "at the default 2% budget - if this now passes, either the model's degradation shrank or the gate " +
      "softened; check both before treating this as good news.",
    );
  }
  const dedupMild = mild.candidates.find((candidate) => candidate.label === WITH_CROSS_TURN_DEDUP.label)!;
  if (!dedupMild.approved) {
    throw new Error(
      "Expected crossTurnMemoryDedup to be APPROVED by the gate under the MILD distance-decay model - if " +
      "this now fails, the gate tightened or the mild curve's parameters drifted; check both before treating " +
      "this as the gate simply being stricter than expected.",
    );
  }

  console.log(
    "\n=== honest summary ===\n" +
    "the gate rejects crossTurnMemoryDedup under the adversarial curve (good: it has teeth against a " +
    "'lost in the middle'-shaped risk) and APPROVES it under the mild curve " +
    `(mean delta ${(dedupMild.meanQualityDelta * 100).toFixed(2)} pp, lower95 ` +
    `${(dedupMild.lower95QualityDelta * 100).toFixed(2)} pp, within the default ${(mild.maximumQualityDrop * 100).toFixed(0)}% budget). ` +
    "Neither pass is a verdict on the lever's real-world safety - both decay curves are synthetic, chosen " +
    "for shape and not fit to any dataset. What this demonstrates is that the gate's verdict genuinely tracks " +
    "the SIZE of the assumed degradation rather than rubber-stamping or blanket-rejecting every lossy lever: " +
    "it is capable of approving a small quality cost and capable of catching a large one, which is the " +
    "property that matters before any customer is asked to trust it with their own replay-gate run on " +
    "crossTurnMemoryDedup.",
  );
}

const isDirectRun = typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
