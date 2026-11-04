import { describe, expect, it } from "vitest";
import {
  answerProbe,
  factForTurn,
  isProbeTurn,
  memoryRecallStream,
  recallProbability,
  recallProbabilityMild,
  type AnyObject,
} from "./memory-recall-fixture.js";
import {
  LOSSLESS_ONLY,
  WITH_CROSS_TURN_DEDUP,
  buildFixtureRequests,
  runMemoryDedupGate,
} from "./run-replay-gate-memory-dedup.js";
import { reduceRequest } from "../packages/sdk-js/src/index.js";

/**
 * Pins the properties that make this gate pass meaningful, same spirit as
 * run-replay-gate-freshcap.test.ts: if the fixture's distance model, the
 * provider's correctness-from-content reading, or the gate's verdicts drift,
 * these fail loudly rather than the eval script's assertions silently
 * rotting.
 */

describe("memory-recall fixture", () => {
  it("probes exactly one fact every 5th turn, covering all 8 facts over 40 turns", () => {
    const probeTurns = Array.from({ length: 40 }, (_, turn) => turn).filter(isProbeTurn);
    expect(probeTurns).toEqual([4, 9, 14, 19, 24, 29, 34, 39]);
    const keys = new Set(probeTurns.map((turn) => factForTurn(turn).key));
    expect(keys.size).toBe(8);
  });

  it("recallProbability is exactly 1 at distance 0 (the baseline must never be self-penalised)", () => {
    expect(recallProbability(0)).toBe(1);
    expect(recallProbabilityMild(0)).toBe(1);
  });

  it("recallProbability strictly decreases with distance and respects its floor", () => {
    expect(recallProbability(4)).toBeGreaterThan(recallProbability(39));
    expect(recallProbability(1_000_000)).toBeCloseTo(0.35, 5);
  });

  it("answerProbe reads correctness from the request's actual wired content, not a flag", () => {
    const [, , , , probeEntry] = memoryRecallStream(0);
    const metadata = probeEntry!.metadata;
    expect(metadata.isProbe).toBe(true);

    // Unreduced: the fact is adjacent (distance 0) regardless of decay model.
    const baseline = answerProbe(probeEntry!.request, metadata, "baseline", recallProbability);
    expect(baseline.distance).toBe(0);
    expect(baseline.correct).toBe(true);

    // Simulate what crossTurnMemoryDedup does: strip the memory block's
    // clauses from the current turn's text, leaving only a marker - the
    // function must then see the fact as NOT adjacent and use turn distance.
    const stripped = JSON.parse(JSON.stringify(probeEntry!.request)) as AnyObject;
    const messages = stripped.messages as AnyObject[];
    const last = messages[messages.length - 1] as AnyObject;
    last.content = "[flux: memory block omitted, identical to turn 1]\n" + (last.content as string).split("\n").slice(-1)[0];
    const candidate = answerProbe(stripped, metadata, "baseline", recallProbability);
    expect(candidate.distance).toBe(metadata.turn);
  });
});

describe("crossTurnMemoryDedup lever, as actually wired", () => {
  it("replaces the leading memory block from turn 2 onward, and the provider sees it as non-adjacent", () => {
    const stream = memoryRecallStream(0);
    const unreduced = stream.map((entry) => entry.request);
    const reduced = unreduced.map((request) =>
      reduceRequest(request, { crossTurnMemoryDedup: true }).request as AnyObject);

    // Turn 1 (index 0) keeps its full block; later turns get the marker.
    const firstTurnMessages = (reduced[0]!.messages as AnyObject[]);
    expect(firstTurnMessages[firstTurnMessages.length - 1]!.content).toContain("AGENT MEMORY");

    const laterTurnMessages = (reduced[10]!.messages as AnyObject[]);
    const laterLast = laterTurnMessages[laterTurnMessages.length - 1]!.content as string;
    expect(laterLast).not.toContain("AGENT MEMORY");
    expect(laterLast).toContain("flux:");

    // The probe at turn 9 (index 9 in the array) must now see the fact as
    // non-adjacent: answerProbe must measure its real distance (9), not 0.
    const probeMetadata = stream[9]!.metadata;
    expect(probeMetadata.isProbe).toBe(true);
    const outcome = answerProbe(reduced[9]!, probeMetadata, "candidate", recallProbability);
    expect(outcome.distance).toBe(9);
  });
});

describe("replay gate over crossTurnMemoryDedup", () => {
  it("holds the lossless-only candidate at exactly zero quality delta", async () => {
    const requests = buildFixtureRequests();
    const result = await runMemoryDedupGate(requests, [LOSSLESS_ONLY], recallProbability);
    const verdict = result.candidates[0]!;
    expect(verdict.failed).toBe(0);
    expect(verdict.meanQualityDelta).toBe(0);
    expect(verdict.lower95QualityDelta).toBeCloseTo(0, 9);
  });

  it("rejects crossTurnMemoryDedup under the adversarial decay curve", async () => {
    const requests = buildFixtureRequests();
    const result = await runMemoryDedupGate(requests, [WITH_CROSS_TURN_DEDUP], recallProbability);
    const verdict = result.candidates[0]!;
    expect(verdict.failed).toBe(0);
    expect(verdict.meanQualityDelta).toBeLessThan(0);
    expect(verdict.lower95QualityDelta).toBeLessThan(-0.02);
    expect(verdict.approved).toBe(false);
    expect(verdict.inputTokensSaved).toBeGreaterThan(0);
  });

  it("approves crossTurnMemoryDedup under the mild decay curve, at nonzero token savings", async () => {
    const requests = buildFixtureRequests();
    const result = await runMemoryDedupGate(requests, [WITH_CROSS_TURN_DEDUP], recallProbabilityMild);
    const verdict = result.candidates[0]!;
    expect(verdict.failed).toBe(0);
    expect(verdict.lower95QualityDelta).toBeGreaterThanOrEqual(-0.02);
    expect(verdict.approved).toBe(true);
    expect(verdict.inputTokensSaved).toBeGreaterThan(0);
  });
});
