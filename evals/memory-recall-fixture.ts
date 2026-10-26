import { approximateTokenCount } from "../packages/core/src/index.js";

/**
 * Shared fixture for the `crossTurnMemoryDedup` replay-gate pass.
 *
 * `evals/run-memory-agent-dedup.ts` (2026-10-23) measured this lever's TOKEN
 * effect honestly - 58.0% vs the lossless stack - and named it a candidate,
 * not a qualified win, because the duplicate it removes sits many turns
 * upstream of the current one rather than next to its twin. Every NOTES file
 * since has carried "replay-gate-prove `crossTurnMemoryDedup`" forward as
 * owed. This fixture is that proof's missing half: a QUALITY signal, not
 * just a byte count.
 *
 * There is no live customer traffic or API budget in this environment (see
 * 2026-10-23's own note on this), so this cannot be a real LLM-judge pass.
 * What it is instead, stated plainly so nobody downstream mistakes it for
 * measured production quality:
 *
 *   A SYNTHETIC degradation model, standing in for a real grader, whose
 *   shape is chosen to be QUALITATIVELY consistent with the published
 *   long-context finding that a model's ability to use information placed
 *   away from the most recent turns falls off as the intervening context
 *   grows (Liu et al. 2023, "Lost in the Middle: How Language Models Use
 *   Long Contexts") - not a number measured from any real model, and not
 *   calibrated to any specific Anthropic model's actual behaviour. The curve
 *   is a deliberately adversarial STRESS TEST: it assumes recall gets worse
 *   the further back the only surviving copy of a fact sits, which is
 *   exactly the risk the lever's own LOSSY classification already names.
 *
 * The question this fixture lets the replay gate answer is methodological,
 * not a production certification: "if a memory fact's recall quality really
 * did decay with distance in roughly this shape, would FLUX's own gate
 * machinery (packages/sdk-js/src/replay-gate.ts, at its default 2% quality
 * budget) catch it and refuse to approve the lever?" A real customer still
 * needs their own replay-gate run, with their own model and their own
 * grader, before `crossTurnMemoryDedup` may ever be billed - this fixture
 * cannot stand in for that. What it buys is confidence the GATE ITSELF has
 * teeth against this exact failure mode, before any customer ever runs it.
 */

export type AnyObject = Record<string, unknown>;

/** One memory fact, as a (key, clause, probe question) triple. */
export type MemoryFact = { key: string; clause: string; question: string };

/**
 * Eight independent facts, each its own clause, so a probe can test recall of
 * ONE fact without any other fact's text overlapping it (no shared words
 * beyond stopwords) - otherwise a wrong-recollection response could score an
 * undeserved partial credit on word overlap alone.
 */
export const FACTS: MemoryFact[] = [
  { key: "units", clause: "the user prefers metric units for every measurement", question: "Which unit system does the user prefer?" },
  { key: "deploy-window", clause: "the deploy window is 14:00 to 16:00 UTC", question: "What is the deploy window?" },
  { key: "staging-friday", clause: "the staging database is read-only on Fridays", question: "When is the staging database read-only?" },
  { key: "incident-4312", clause: "incident 4312's root cause was a stale feature flag", question: "What was the root cause of incident 4312?" },
  { key: "checklist-size", clause: "the review checklist has exactly nine items", question: "How many items are on the review checklist?" },
  { key: "page-oncall", clause: "the on-call must be paged before any schema change", question: "Who must be paged before a schema change?" },
  { key: "escalation", clause: "the escalation contact is the on-call rotation rather than one named person", question: "Who is the escalation contact?" },
  { key: "rollback-plan", clause: "every schema change needs a written rollback plan before it ships", question: "What does a schema change need before it ships?" },
];

export const MEMORY_BLOCK = `AGENT MEMORY (persistent): ${FACTS.map((fact) => fact.clause).join("; ")}.`;

export const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse.";

export const TURNS = 40;
export const PROBE_INTERVAL = 5;

/** Turn indices that probe recall - one per fact, in rotation, 8 probes over 40 turns. */
export function isProbeTurn(turn: number): boolean {
  return turn % PROBE_INTERVAL === PROBE_INTERVAL - 1;
}

export function factForTurn(turn: number): MemoryFact {
  const probeNumber = Math.floor(turn / PROBE_INTERVAL);
  return FACTS[probeNumber % FACTS.length]!;
}

/** Metadata FLUX's reducer never looks at, carried alongside the request so the simulated provider can grade it. */
export type TurnMetadata = {
  conversationIndex: number;
  turn: number;
  isProbe: boolean;
  factKey?: string;
  correctAnswer?: string;
};

/**
 * One independent 40-turn conversation, each entry the request as it stands
 * after that turn's user message. `conversationIndex` seeds the simulated
 * provider's draws (see answerProbe) so several conversations are genuinely
 * independent replicates, not the same draws repeated - the replay gate's
 * bootstrap needs real inter-group independence, and grouping by
 * conversation (every turn of one conversation shares a fate, exactly as
 * evals/run-replay-gate-freshcap.ts groups by task) is the correct unit.
 */
export function memoryRecallStream(conversationIndex: number): Array<{ request: AnyObject; metadata: TurnMetadata }> {
  const stream: Array<{ request: AnyObject; metadata: TurnMetadata }> = [];
  const history: AnyObject[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const probe = isProbeTurn(turn);
    const fact = probe ? factForTurn(turn) : undefined;
    const userText = probe
      ? `${MEMORY_BLOCK}\nTurn ${turn}: ${fact!.question}`
      : `${MEMORY_BLOCK}\nTurn ${turn}: handle today's request ${turn}.`;
    history.push({ role: "user", content: userText });
    const metadata: TurnMetadata = {
      conversationIndex,
      turn,
      isProbe: probe,
      ...(probe ? { factKey: fact!.key, correctAnswer: fact!.clause } : {}),
    };
    stream.push({
      request: {
        model: "claude-sonnet-5-5",
        max_tokens: 500,
        system: PREAMBLE,
        messages: [...history],
        metadata,
      },
      metadata,
    });
    history.push({ role: "assistant", content: `Noted. Turn ${turn} handled.` });
  }
  return stream;
}

/**
 * Mulberry32: a tiny deterministic PRNG, seeded per-request so the same
 * (turn, factKey, arm label) always draws the same outcome. Math.random()
 * would make the gate's bootstrap unreproducible run to run.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The adversarial, synthetic recall-probability curve. See the file header:
 * this is a stress-test shape, not a measurement. `distance` is the number of
 * turns since the only surviving full copy of the needed fact.
 *
 * distance 0 (fact adjacent, as every baseline turn has it) -> exactly 1:
 * the baseline must never itself be penalised by this model, since it is the
 * reference the candidate is measured against.
 *
 * DECAY_RATE and FLOOR are chosen only to produce a visibly graded curve
 * across this fixture's 0-39 turn range (roughly 0.68 at the first probe down
 * to the 0.35 floor by the last one) - round numbers picked for legibility,
 * not fit to any dataset.
 */
const DECAY_RATE = 0.2;
const FLOOR = 0.35;

export type DecayModel = (distance: number) => number;

export const recallProbability: DecayModel = (distance) => {
  if (distance <= 0) return 1;
  return Math.max(FLOOR, 1 - DECAY_RATE * Math.log1p(distance));
};

/**
 * A second, deliberately GENTLE curve: at most a 6pp recall drop by the last
 * (furthest) probe, rather than the adversarial curve's 65pp drop. Included
 * so the gate's verdict under `recallProbability` cannot be read as "the
 * gate always rejects this lever": run against a small, plausible
 * degradation instead of a stress-test one, the same gate approves (verified
 * empirically against this fixture before being pinned here - 0.03/0.85 and
 * 0.008/0.95 were also tried; this is the midpoint that still clears the
 * default budget's lower bound with room, not a value hunted down to the
 * edge of passing). Still synthetic; still not a measurement.
 */
export const recallProbabilityMild: DecayModel = (distance) => {
  if (distance <= 0) return 1;
  return Math.max(0.9, 1 - 0.015 * Math.log1p(distance));
};

/** Does this turn's wired user text carry the fact's clause directly (adjacent), or only via a dedup marker? */
function factIsAdjacent(wiredUserText: string, fact: MemoryFact): boolean {
  return wiredUserText.includes(fact.clause);
}

export type AnswerOutcome = { correct: boolean; distance: number; probability: number; text: string };

/**
 * Decide the simulated model's answer to a probe turn, from the ACTUAL wired
 * request content - never from which arm is running. Mirrors
 * evals/agent-fixture.ts's own convention (answer() reads the request, not a
 * label) so the same provider function is correct for baseline and candidate
 * alike: present the fact unreduced and it answers from distance 0; dedupe it
 * away and the function sees only the reference marker, computes the real
 * distance, and degrades accordingly.
 */
export function answerProbe(
  request: AnyObject,
  metadata: TurnMetadata,
  arm: string,
  decayModel: DecayModel = recallProbability,
): AnswerOutcome {
  const fact = FACTS.find((candidate) => candidate.key === metadata.factKey)!;
  const messages = request.messages as AnyObject[];
  const lastUser = [...messages].reverse().find((message) => message.role === "user")!;
  const text = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
  const adjacent = factIsAdjacent(text, fact);
  const distance = adjacent ? 0 : metadata.turn;
  const probability = decayModel(distance);
  const draw = mulberry32(hashSeed(`${arm}|${metadata.conversationIndex}|${metadata.turn}|${fact.key}`))();
  const correct = draw < probability;
  return {
    correct,
    distance,
    probability,
    text: correct ? fact.clause : "I don't have that specific detail recorded here - you may need to re-share it.",
  };
}

/** Wire a request to the text a provider would actually hash, for token counting. */
export function wireMemoryRequest(request: AnyObject): string {
  const system = typeof request.system === "string" ? request.system : "";
  const messages = (request.messages as AnyObject[])
    .map((message) => `${message.role}:${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`)
    .join("\n");
  return `${system}\n${messages}`;
}

export { approximateTokenCount };
