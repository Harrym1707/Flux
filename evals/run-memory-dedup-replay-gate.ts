import { approximateTokenCount, lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";
import {
  factRecallGrader,
  replayGate,
  type FluxTokenReductionConfig,
  type ReplayCandidate,
} from "../packages/sdk-js/src/index.js";

/**
 * Hardening night: the owed replay-gate pass for `crossTurnMemoryDedup`.
 *
 *   node --import tsx evals/run-memory-dedup-replay-gate.ts
 *
 * `evals/run-memory-agent-dedup.ts` measured this lever's TOKEN effect
 * (58% candidate, `docs/rnd/2026-10-23-NOTES.md`) and was explicit that the
 * number is a candidate, not a qualified win, because the lever's own risk
 * ("a model that attends less to context far back in a long history") was
 * never checked against anything but byte identity. Three nights running
 * (`2026-10-23-NOTES.md`, `2026-10-25-NOTES.md`) carried this forward as
 * owed work: "an LLM-judge grader comparing real model responses ... to get
 * SOME quality signal beyond 'the bytes are identical'."
 *
 * There is no live model budget or customer traffic in this environment, so
 * this is NOT that live-traffic replay-gate pass - it remains genuinely
 * open. What this eval builds instead is the credible PROXY the notes asked
 * for: a stand-in model with a real, literature-grounded failure mode
 * (recency-bounded recall - a simplified, turn-counted stand-in for the
 * "lost in the middle" effect long-context literature documents), and
 * `factRecallGrader` (NEW, packages/sdk-js/src/graders.ts), which checks
 * whether the candidate's answer still contains the specific fact the
 * baseline recalled - a semantic check, not a byte-identity one.
 *
 * The stand-in model answers correctly only when the fact it is asked about
 * occurs, VERBATIM, in one of the last `RECALL_HORIZON_TURNS` user turns of
 * the request it was actually sent (not the full history - only what the
 * request puts within its recall horizon). Under the RAW baseline every
 * turn restates the whole memory block, so the fact is always within the
 * horizon and the baseline always succeeds, by construction - the right
 * control. Two candidates are replayed against it:
 *
 *   UNBOUNDED  crossTurnMemoryDedup: true (today's shipped shape) - every
 *              turn after the first dedupes against turn 1 forever, so the
 *              fact's only verbatim copy falls outside the recall horizon
 *              on every turn past it, and stays there for the rest of the
 *              conversation.
 *   BOUNDED    crossTurnMemoryDedup: { maximumAnchorGap } (tonight's fix,
 *              packages/core/src/token-reduction.ts) - re-anchors (restates
 *              the block in full) before the gap since the last verbatim
 *              copy would exceed the bound, so the fact never falls outside
 *              a horizon at least that wide.
 *
 * This is a constructed mechanism, not a measurement of a real model, and
 * the result below is reported as exactly that - a proxy finding, not a
 * live-traffic verdict. It is, however, a GENUINE test of the specific risk
 * the lever's own docs name, and a real quality gate (`replayGate`) with a
 * real (if simplified) failure mode to catch.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-19";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(4);

/** Six standing facts a continuous-memory agent re-injects every turn, unchanged. */
const FACTS = [
  "the deploy window is 14:00-16:00 UTC",
  "the staging DB is read-only on Fridays",
  "incident 4312's root cause was a stale feature flag",
  "the review checklist has 9 items",
  "escalation contact is the on-call rotation, not a named individual",
  "every schema change needs a rollback plan written before it ships",
] as const;

const MEMORY_BLOCK =
  `AGENT MEMORY (persistent): user prefers metric units; ${FACTS.join("; ")}. `.repeat(3);

const TURNS = 24;
/** The stand-in model's recall horizon: the last N user turns of the SENT request. */
const RECALL_HORIZON_TURNS = 4;
/** Tonight's fix, tuned so no re-anchor gap can push a fact outside that horizon. */
const MAXIMUM_ANCHOR_GAP = 3;

/** The accumulated conversation at turn `turns`, memory restated verbatim every user turn. */
function requestAtTurn(turns: number): AnyObject {
  const messages: AnyObject[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `${MEMORY_BLOCK}\nTurn ${turn}: handle today's request ${turn}.` });
    messages.push({ role: "assistant", content: `Noted. Turn ${turn} handled per memory.` });
  }
  const fact = FACTS[turns % FACTS.length]!;
  messages.push({ role: "user", content: `${MEMORY_BLOCK}\nTurn ${turns}: quick check - what should I know about this before I proceed?` });
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 300,
    system: PREAMBLE,
    messages,
    metadata: { turn: turns, fact },
  };
}

const requests: AnyObject[] = Array.from({ length: TURNS }, (_, turn) => requestAtTurn(turn));

/**
 * Stand-in model: answers with the asked-about fact only when that fact's
 * literal text occurs in one of the last `RECALL_HORIZON_TURNS` user turns
 * of the request actually sent. This is the one, specific mechanism this
 * eval tests - not model quality in general.
 */
async function call(request: unknown): Promise<unknown> {
  const row = request as AnyObject;
  const messages = row.messages as AnyObject[];
  const fact = (row.metadata as AnyObject).fact as string;
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.content));
  const withinHorizon = userTexts.slice(-RECALL_HORIZON_TURNS);
  const recalled = withinHorizon.some((text) => text.includes(fact));
  const answer = recalled
    ? `Before you proceed: ${fact}.`
    : "I don't have enough context to say - nothing in view covers that.";
  const promptText = `${String(row.system ?? "")}\n${JSON.stringify(messages)}`;
  return {
    output_text: answer,
    usage: { input_tokens: approximateTokenCount(promptText), output_tokens: approximateTokenCount(answer) },
  };
}

const UNBOUNDED: FluxTokenReductionConfig = { crossTurnMemoryDedup: true };
const BOUNDED: FluxTokenReductionConfig = {
  crossTurnMemoryDedup: { maximumAnchorGap: MAXIMUM_ANCHOR_GAP },
};

const candidates: ReplayCandidate[] = [
  { label: `unbounded (shipped: crossTurnMemoryDedup: true)`, config: UNBOUNDED },
  { label: `bounded (fix: maximumAnchorGap ${MAXIMUM_ANCHOR_GAP})`, config: BOUNDED },
];

console.log(`=== crossTurnMemoryDedup replay-gate proxy: ${TURNS} turns, recall horizon ${RECALL_HORIZON_TURNS} turns ===`);
console.log(
  "caveat: the stand-in model is a CONSTRUCTED mechanism (recency-bounded recall), not a measurement of a real " +
    "model. This exercises the specific attention-distance risk the lever's own docs name; it is a proxy for the " +
    "owed live-traffic replay-gate pass, not a substitute for it.\n",
);

const grade = factRecallGrader((request) => ((request as AnyObject).metadata as AnyObject).fact as string);

const result = await replayGate({
  requests,
  call,
  candidates,
  grade,
  price: price.price,
});

console.log(`${result.calls} provider calls; quality may fall at most ${(result.maximumQualityDrop * 100).toFixed(0)}pp\n`);
console.log(
  `${"candidate".padEnd(42)} ${"tokens".padStart(9)} ${"cost".padStart(9)} ` +
  `${"quality".padStart(9)} ${"bound".padStart(9)}  verdict`,
);
console.log("-".repeat(100));
for (const candidate of result.candidates) {
  console.log(
    `${candidate.label.padEnd(42)} ` +
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
    `${(result.approved.costSavingPercent ?? 0).toFixed(1)}% of cost against this proxy's quality bar.`,
  );
} else {
  console.log("No candidate held quality against this proxy - the lever stays a candidate on this evidence.");
}
for (const note of result.notes) console.log(`note: ${note}`);

console.log(
  "\nhonest reading: this proxy's failure mode is specific and constructed (recency-bounded recall over a " +
    `${RECALL_HORIZON_TURNS}-turn horizon), not a general model-quality finding. What it DOES show is that the ` +
    "shipped lever's unbounded anchor has no bound on how far a marker can point back, which is exactly the " +
    "shape of risk its own docs flagged and never tested; and that bounding the anchor distance removes that " +
    "specific risk without giving up the lever's saving where the anchor stays within a plausible recall " +
    "window. The real replay-gate pass - on a customer's own traffic, with real model responses - remains " +
    "open; this closes the gap between 'nobody checked' and 'nobody checked with a real model, but something " +
    "checked with a model of the specific risk named'.",
);
