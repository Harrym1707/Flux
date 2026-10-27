import { describe, expect, it } from "vitest";
import { CacheTtlAdvisor } from "./cache-ttl-advisor.js";

/**
 * The advisor picks 5m vs 1h from a conversation's realized arrival gaps.
 * Threshold calibrated from Mooncake (docs/rnd/knowledge/2026-10-27-dataset-findings.md):
 * tool-agent gap p90=243s (stay 5m), conversation gap p90=519s (go 1h).
 * Time is injected so every test is deterministic.
 */

function convo(id: string): Record<string, unknown> {
  return { model: "claude-sonnet-5-5", messages: [{ role: "user", content: `conversation ${id}` }] };
}

/** Feed a conversation a sequence of inter-arrival gaps (seconds) and return the last recommendation. */
function playGaps(advisor: CacheTtlAdvisor, request: Record<string, unknown>, gaps: number[]) {
  let t = 1_000_000; // arbitrary fixed epoch-seconds
  let rec = advisor.recommend(request, t); // first observation, no gap yet
  for (const gap of gaps) {
    t += gap;
    rec = advisor.recommend(request, t);
  }
  return rec;
}

describe("CacheTtlAdvisor", () => {
  it("defaults to 5m until it has enough gaps to judge the cadence", () => {
    const advisor = new CacheTtlAdvisor({ minObservations: 3 });
    const first = advisor.recommend(convo("a"), 1000);
    expect(first.ttl).toBe("5m");
    expect(first.reason).toContain("defaulting to the cheaper 5m");
    // One gap is still below the 3-observation minimum.
    const second = advisor.recommend(convo("a"), 1100);
    expect(second.ttl).toBe("5m");
    expect(second.reason).toContain("need 3");
  });

  it("stays 5m for tight gaps (Mooncake tool-agent p90≈243s < 300s)", () => {
    const advisor = new CacheTtlAdvisor();
    // Gaps clustered well under 5 minutes, with a p90 around 243s.
    const rec = playGaps(advisor, convo("tool-agent"), [10, 30, 60, 120, 200, 243, 90, 150, 40, 243]);
    expect(rec.ttl).toBe("5m");
    expect(rec.reason).toContain("still warm");
  });

  it("upgrades to 1h for a conversational cadence (p90≈519s > 300s)", () => {
    const advisor = new CacheTtlAdvisor();
    // Gaps with a p90 past 5 minutes, tail toward ~50 min — the conversation shape.
    const rec = playGaps(advisor, convo("chat"), [114, 200, 333, 450, 519, 600, 519, 250, 519, 519]);
    expect(rec.ttl).toBe("1h");
    expect(rec.reason).toContain("re-paying full input");
  });

  it("tracks conversations independently (one tight, one slow, same advisor)", () => {
    const advisor = new CacheTtlAdvisor();
    const fast = playGaps(advisor, convo("fast"), [30, 60, 90, 120, 60]);
    const slow = playGaps(advisor, convo("slow"), [400, 500, 600, 700, 800]);
    expect(fast.ttl).toBe("5m");
    expect(slow.ttl).toBe("1h");
  });

  it("is hysteresis-free in the right direction: a cadence that slows down flips to 1h", () => {
    const advisor = new CacheTtlAdvisor({ windowGaps: 5, minObservations: 3 });
    const request = convo("slowing");
    playGaps(advisor, request, [30, 30, 30]); // fast start -> 5m
    // Now it slows; the rolling window of the last 5 gaps moves the p90 past 300s.
    const rec = playGaps(advisor, request, [600, 600, 600, 600, 600]);
    expect(rec.ttl).toBe("1h");
  });

  it("ignores out-of-order / negative gaps rather than corrupting the window", () => {
    const advisor = new CacheTtlAdvisor({ minObservations: 2 });
    const request = convo("skew");
    advisor.recommend(request, 1000);
    advisor.recommend(request, 900); // clock went backwards; gap -100 ignored
    const rec = advisor.recommend(request, 1000); // gap +100 from the 900 mark
    // Only one valid gap recorded; still below the 2-observation minimum -> 5m.
    expect(rec.ttl).toBe("5m");
  });

  it("defaults to 5m when there is no conversation to anchor on", () => {
    const advisor = new CacheTtlAdvisor();
    const rec = advisor.recommend({ model: "claude-sonnet-5-5" }, 1000); // no messages
    expect(rec.ttl).toBe("5m");
    expect(rec.reason).toContain("no conversation");
  });

  it("respects a custom upgrade threshold", () => {
    const strict = new CacheTtlAdvisor({ upgradeGapP90Seconds: 60 });
    const rec = playGaps(strict, convo("x"), [90, 90, 90, 90]);
    expect(rec.ttl).toBe("1h"); // p90 90s > 60s threshold
  });

  it("rejects invalid options", () => {
    expect(() => new CacheTtlAdvisor({ minObservations: 0 })).toThrow();
    expect(() => new CacheTtlAdvisor({ upgradeGapP90Seconds: 0 })).toThrow();
    expect(() => new CacheTtlAdvisor({ windowGaps: -1 })).toThrow();
  });

  it("evicts least-recently-used conversations past the cap", () => {
    const advisor = new CacheTtlAdvisor({ maxConversations: 2 });
    advisor.recommend(convo("a"), 1);
    advisor.recommend(convo("b"), 2);
    advisor.recommend(convo("c"), 3); // evicts "a"
    // "a" is forgotten: its next observation starts fresh (no gap) -> still 5m default,
    // which we assert indirectly by confirming no throw and a fresh-default reason.
    const rec = advisor.recommend(convo("a"), 4);
    expect(rec.ttl).toBe("5m");
    expect(rec.reason).toContain("defaulting to the cheaper 5m");
  });
});
