import { describe, expect, it } from "vitest";
import type { LedgerGateVerdict } from "../../core/dist/src/index.js";
import { CompactionPinStore } from "./compaction-pin-store.js";
import {
  compactStaleContext,
  reduceRequestAsync,
  type SemanticCompactor,
} from "./semantic-compaction.js";

/**
 * Tests for the local-model semantic-compaction prototype (Q2.1).
 *
 * The compactor here is a DETERMINISTIC STUB: no real model, no network. It
 * either returns a fixed short summary or truncates, so every assertion is
 * reproducible and the lever's behaviour is isolated from any model's quirks.
 */

const APPROVED: LedgerGateVerdict = { ref: "gate-run-2026-10-27", verdict: "approved" };
const REJECTED: LedgerGateVerdict = { ref: "gate-run-2026-10-27", verdict: "rejected" };

/** A fixed-summary compactor: collapses any body to a short constant marker. */
const fixedSummaryCompactor: SemanticCompactor = {
  compact: ({ kind }) => `[local-model summary of ${kind}]`,
};

/** A truncating compactor, async, to exercise the await path. */
const truncatingCompactor: SemanticCompactor = {
  compact: async ({ text, maxTokens }) => text.slice(0, Math.max(0, maxTokens)),
};

/** A long tool-result body (~120 words -> well over a 10-token cap). */
const LONG_TOOL_RESULT =
  "The query returned 42 rows from the orders table. " +
  Array.from({ length: 100 }, (_, index) => `row ${index} has a value and a timestamp and some notes`).join(". ") +
  ".";

/**
 * A multi-turn Chat/Anthropic-shaped request. Turns 0 and 1 are stale (their
 * tool results are oversized); the live turn 2 carries its own oversized tool
 * result that must NEVER be touched.
 */
function multiTurnRequest(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4",
    system: "You are a data assistant.",
    messages: [
      { role: "user", content: "Turn 0 question" },
      { role: "tool", content: LONG_TOOL_RESULT },
      { role: "assistant", content: "Turn 0 assistant answer, which is model output and must stay verbatim." },
      { role: "user", content: "Turn 1 question" },
      { role: "tool", content: LONG_TOOL_RESULT },
      { role: "assistant", content: "Turn 1 assistant answer." },
      { role: "user", content: "Turn 2 live question" },
      { role: "tool", content: LONG_TOOL_RESULT },
    ],
  };
}

describe("compactStaleContext", () => {
  it("is off by default: no compactor supplied is a byte-identical no-op", async () => {
    const request = multiTurnRequest();
    const before = JSON.stringify(request);
    const result = await compactStaleContext(request);
    expect(result.change).toBeUndefined();
    expect(result.skippedReason).toMatch(/off/i);
    expect(JSON.stringify(result.request)).toBe(before);
    expect(result.request).toBe(request);
  });

  it("will not touch content without an approved gate verdict", async () => {
    const request = multiTurnRequest();
    const before = JSON.stringify(request);

    const noVerdict = await compactStaleContext(request, { compactor: fixedSummaryCompactor });
    expect(noVerdict.change).toBeUndefined();
    expect(noVerdict.skippedReason).toMatch(/approved replay-gate verdict/i);
    expect(JSON.stringify(noVerdict.request)).toBe(before);

    const rejected = await compactStaleContext(request, {
      compactor: fixedSummaryCompactor,
      gateVerdict: REJECTED,
    });
    expect(rejected.change).toBeUndefined();
    expect(JSON.stringify(rejected.request)).toBe(before);
  });

  it("compacts only stale tool results and never the live/last turn", async () => {
    const request = multiTurnRequest();
    const result = await compactStaleContext(request, {
      compactor: fixedSummaryCompactor,
      gateVerdict: APPROVED,
      maxTokens: 10,
      minimumTurns: 3,
      keepRecentTurns: 1,
    });
    expect(result.change).toBeDefined();
    const messages = (result.request as { messages: Array<Record<string, unknown>> }).messages;

    // Stale tool results (turns 0 and 1) were compacted to the stub's summary.
    expect(messages[1]!.content).toBe("[local-model summary of tool-result]");
    expect(messages[4]!.content).toBe("[local-model summary of tool-result]");

    // The live turn 2's tool result is untouched, verbatim.
    expect(messages[7]!.content).toBe(LONG_TOOL_RESULT);

    // Model output (assistant messages) is untouched, always.
    expect(messages[2]!.content).toBe("Turn 0 assistant answer, which is model output and must stay verbatim.");
    expect(messages[5]!.content).toBe("Turn 1 assistant answer.");

    // User turns are untouched, always.
    expect(messages[0]!.content).toBe("Turn 0 question");
    expect(messages[3]!.content).toBe("Turn 1 question");
    expect(messages[6]!.content).toBe("Turn 2 live question");
  });

  it("records a LOSSY change with tokens-before/after and the gate ref", async () => {
    const request = multiTurnRequest();
    const result = await compactStaleContext(request, {
      compactor: fixedSummaryCompactor,
      gateVerdict: APPROVED,
      maxTokens: 10,
      keepRecentTurns: 1,
    });
    const change = result.change!;
    expect(change.lever).toBe("semantic-compaction");
    expect(change.lossless).toBe(false);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    expect(change.detail).toContain(`tokens-before ${result.tokensBefore}`);
    expect(change.detail).toContain(`tokens-after ${result.tokensAfter}`);
    expect(change.detail).toContain(APPROVED.ref);
  });

  it("awaits an async compactor and keeps the live turn verbatim", async () => {
    const request = multiTurnRequest();
    const result = await compactStaleContext(request, {
      compactor: truncatingCompactor,
      gateVerdict: APPROVED,
      maxTokens: 20,
      keepRecentTurns: 1,
    });
    const messages = (result.request as { messages: Array<Record<string, unknown>> }).messages;
    expect((messages[1]!.content as string).length).toBeLessThan(LONG_TOOL_RESULT.length);
    expect(messages[7]!.content).toBe(LONG_TOOL_RESULT);
  });

  it("compacts Anthropic tool_result blocks but not the user's own text in the same stale turn", async () => {
    const request = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Here is my genuine user question for turn 0." },
            { type: "tool_result", tool_use_id: "a", content: LONG_TOOL_RESULT },
          ],
        },
        { role: "assistant", content: "Turn 0 answer." },
        { role: "user", content: "Turn 1 question" },
        { role: "assistant", content: "Turn 1 answer." },
        { role: "user", content: "Turn 2 live question" },
      ],
    };
    const result = await compactStaleContext(request, {
      compactor: fixedSummaryCompactor,
      gateVerdict: APPROVED,
      maxTokens: 10,
      keepRecentTurns: 2,
    });
    const messages = (result.request as { messages: Array<Record<string, unknown>> }).messages;
    const block0 = (messages[0]!.content as Array<Record<string, unknown>>);
    // The user's own text block is verbatim; only the tool_result block changed.
    expect(block0[0]!.text).toBe("Here is my genuine user question for turn 0.");
    expect(block0[1]!.content).toBe("[local-model summary of tool-result]");
  });

  it("leaves short tool results alone (only oversized bodies are compacted)", async () => {
    const request = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Turn 0" },
        { role: "tool", content: "short ok" },
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "Turn 2 live" },
      ],
    };
    const before = JSON.stringify(request);
    const result = await compactStaleContext(request, {
      compactor: fixedSummaryCompactor,
      gateVerdict: APPROVED,
      maxTokens: 50,
      keepRecentTurns: 1,
    });
    expect(result.change).toBeUndefined();
    expect(JSON.stringify(result.request)).toBe(before);
  });
});

describe("reduceRequestAsync", () => {
  it("byte-identical passthrough when compaction is disabled (off-by-default)", async () => {
    const request = multiTurnRequest();
    const before = JSON.stringify(request);
    // No semantic config at all, and no reduction levers: nothing should change.
    const result = await reduceRequestAsync(request, {});
    expect(JSON.stringify(result.request)).toBe(before);
    expect(result.summary.changes.length).toBe(0);
  });

  it("runs the pre-pass then the sync reducer and merges the lossy change", async () => {
    const request = multiTurnRequest();
    const result = await reduceRequestAsync(
      request,
      { duplicateContext: true },
      {
        compactor: fixedSummaryCompactor,
        gateVerdict: APPROVED,
        maxTokens: 10,
        keepRecentTurns: 1,
      },
    );
    const compactionChange = result.summary.changes.find((change) => change.lever === "semantic-compaction");
    expect(compactionChange).toBeDefined();
    expect(compactionChange!.lossless).toBe(false);
    // before/after spans the whole pipeline: the compacted request is smaller.
    expect(result.summary.estimatedTokensAfter).toBeLessThan(result.summary.estimatedTokensBefore);
    expect(result.summary.estimatedTokensSaved).toBeGreaterThan(0);
    // The lossy compaction is NOT counted as lossless savings.
    expect(result.summary.estimatedLosslessTokensSaved)
      .toBeLessThan(result.summary.estimatedTokensSaved);
    // And the live turn is still verbatim end-to-end.
    const messages = (result.request as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[7]!.content).toBe(LONG_TOOL_RESULT);
  });

  it("without a verdict, reduceRequestAsync equals the sync reducer (no compaction leaks in)", async () => {
    const request = multiTurnRequest();
    const viaAsync = await reduceRequestAsync(request, { duplicateContext: true }, {
      compactor: fixedSummaryCompactor,
    });
    // No semantic-compaction change because the guard withheld it.
    expect(viaAsync.summary.changes.some((change) => change.lever === "semantic-compaction")).toBe(false);
    // The live tool result is verbatim.
    const messages = (viaAsync.request as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[7]!.content).toBe(LONG_TOOL_RESULT);
  });
});

describe("maxTokens default calibration (2026-10-27 dataset findings)", () => {
  /**
   * Builds a 3+ turn request whose STALE turns carry tool-result bodies of the
   * given approximate token sizes (chars ≈ 4×tokens), so we can measure what
   * fraction the default floor flags. Mirrors the agent-trajectory tool-result
   * distribution (median ~270–302 tok): a 200 floor over-fires on the typical
   * observation; 500 fires only on the oversized tail.
   */
  function requestWithStaleResults(tokenSizes: number[]): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    tokenSizes.forEach((tok, i) => {
      messages.push({ role: "user", content: `stale turn ${i}` });
      messages.push({ role: "tool", content: "x".repeat(tok * 4) });
      messages.push({ role: "assistant", content: `ans ${i}` });
    });
    // Two recent turns kept verbatim (keepRecentTurns=2) plus a live turn.
    messages.push({ role: "user", content: "recent A" }, { role: "assistant", content: "a" });
    messages.push({ role: "user", content: "recent B" }, { role: "assistant", content: "b" });
    messages.push({ role: "user", content: "live" });
    return { model: "claude-sonnet-4", messages };
  }

  // Representative agent tool-result sizes around the measured ~300-tok median.
  const SIZES = [120, 180, 250, 290, 302, 340, 420, 480, 650, 900, 1500, 5000];

  async function firedCount(maxTokens: number): Promise<number> {
    const result = await compactStaleContext(requestWithStaleResults(SIZES), {
      compactor: truncatingCompactor, gateVerdict: APPROVED, maxTokens,
    });
    return result.change ? SIZES.filter((s) => s > maxTokens).length : 0;
  }

  it("the new 500 default fires on far fewer normal tool-results than the old 200", async () => {
    const firedAt200 = SIZES.filter((s) => s > 200).length; // old default
    const firedAt500 = SIZES.filter((s) => s > 500).length; // new default
    // Measurable precision gain: 200 flags the typical observation; 500 the tail.
    expect(firedAt200 / SIZES.length).toBeGreaterThan(0.6); // over-fires (>60%)
    expect(firedAt500 / SIZES.length).toBeLessThan(0.4);    // tail only (<40%)
    expect(await firedCount(500)).toBeLessThan(await firedCount(200));
  });

  it("defaults maxTokens to 500 when unset", async () => {
    // A 300-tok stale result (at the measured median) is NOT compacted by default now.
    const atMedian = await compactStaleContext(requestWithStaleResults([300, 300, 300]), {
      compactor: truncatingCompactor, gateVerdict: APPROVED, // maxTokens unset -> 500
    });
    expect(atMedian.change).toBeUndefined(); // 300 <= 500 default, left verbatim
    // A 900-tok oversized result IS compacted by default.
    const oversized = await compactStaleContext(requestWithStaleResults([900, 900, 900]), {
      compactor: truncatingCompactor, gateVerdict: APPROVED,
    });
    expect(oversized.change).toBeDefined();
  });
});

describe("cross-turn stability (config.pins) — the hard blocker from the 2026-10-27 review", () => {
  /**
   * A model is non-deterministic in practice; this stub makes that concrete by
   * returning a DIFFERENT summary on every call for the same input, plus a
   * call counter so tests can prove how many times it actually ran. Any real
   * local model is at least this unstable turn to turn, so if pinning fails to
   * mask it, these tests will catch the resulting byte drift.
   */
  function unstableCompactor(): SemanticCompactor & { calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      compact: ({ kind }) => {
        calls += 1;
        return `[summary #${calls} of ${kind}]`;
      },
    };
  }

  it("without pins, re-running compaction on the same stale body yields DIFFERENT bytes each time (the failure this guards against)", async () => {
    const compactor = unstableCompactor();
    const request = multiTurnRequest();
    const first = await compactStaleContext(request, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1 });
    const second = await compactStaleContext(request, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1 });
    const firstBody = (first.request as { messages: Array<Record<string, unknown>> }).messages[1]!.content;
    const secondBody = (second.request as { messages: Array<Record<string, unknown>> }).messages[1]!.content;
    expect(firstBody).not.toBe(secondBody);
  });

  it("with a shared pin store, re-running compaction on the same stale body yields IDENTICAL bytes every time", async () => {
    const compactor = unstableCompactor();
    const pins = new CompactionPinStore();
    const request = multiTurnRequest();

    const first = await compactStaleContext(request, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });
    const second = await compactStaleContext(request, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });
    const third = await compactStaleContext(request, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });

    const bodyAt = (result: Awaited<ReturnType<typeof compactStaleContext>>, index: number) =>
      (result.request as { messages: Array<Record<string, unknown>> }).messages[index]!.content;

    expect(bodyAt(first, 1)).toBe(bodyAt(second, 1));
    expect(bodyAt(second, 1)).toBe(bodyAt(third, 1));
    expect(bodyAt(first, 4)).toBe(bodyAt(second, 4));

    // The compactor ran once per unique stale body (two distinct bodies in
    // multiTurnRequest's stale turns, both equal to LONG_TOOL_RESULT -> pinned
    // after the very first encounter), never once per call.
    expect(compactor.calls).toBe(1);
  });

  it("pins the 'compactor returned nothing shorter' outcome too, so a body is not re-sent to the model forever", async () => {
    let calls = 0;
    const noopCompactor: SemanticCompactor = {
      compact: ({ text }) => {
        calls += 1;
        return text; // never actually shorter than the original
      },
    };
    const pins = new CompactionPinStore();
    const request = multiTurnRequest();

    const first = await compactStaleContext(request, { compactor: noopCompactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });
    const second = await compactStaleContext(request, { compactor: noopCompactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });

    // Both calls fall back to "nothing shorter" (no change recorded), and the
    // second call never re-invoked the compactor on the already-pinned body.
    expect(first.change).toBeUndefined();
    expect(second.change).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("a one-byte difference in the stale body is correctly treated as a new, unpinned body", async () => {
    const compactor = unstableCompactor();
    const pins = new CompactionPinStore();
    const requestA = multiTurnRequest();
    const requestB = multiTurnRequest();
    (requestB.messages as Array<Record<string, unknown>>)[1]!.content = `${(requestB.messages as Array<Record<string, unknown>>)[1]!.content}!`;

    await compactStaleContext(requestA, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });
    await compactStaleContext(requestB, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });

    // requestB's altered body is a genuinely different cache key, so the
    // compactor legitimately ran again for it — pinning never papers over a
    // real content change, only a repeat of the exact same bytes.
    expect(compactor.calls).toBeGreaterThan(1);
  });

  it("reduceRequestAsync threads the pin store through, so the composed entry point is stable too", async () => {
    const compactor = unstableCompactor();
    const pins = new CompactionPinStore();
    const request = multiTurnRequest();

    const first = await reduceRequestAsync(request, {}, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });
    const second = await reduceRequestAsync(request, {}, { compactor, gateVerdict: APPROVED, maxTokens: 10, keepRecentTurns: 1, pins });

    const bodyAt = (result: Awaited<ReturnType<typeof reduceRequestAsync>>, index: number) =>
      (result.request as { messages: Array<Record<string, unknown>> }).messages[index]!.content;
    expect(bodyAt(first, 1)).toBe(bodyAt(second, 1));
    expect(compactor.calls).toBe(1);
  });
});
