import { describe, expect, it } from "vitest";
import { observe, sampleCodingWorkload } from "./theo-loop.js";
import { reduceRequest } from "../packages/sdk-js/src/index.js";

describe("Theo loop", () => {
  it("learns a coding-agent profile from blind features only (no content)", () => {
    const { profile, learned } = observe(sampleCodingWorkload());
    expect(profile.requests).toBe(8);
    expect(profile.segments.toolSchemas).toBeGreaterThan(0);
    expect(profile.segments.history).toBeGreaterThan(0);
    // The stable tools+system prefix is detected as cacheable from the keyed prefix hash.
    expect(profile.stableSegments).toContain("toolSchemas");
    expect(profile.stableSegments).toContain("systemPrompt");
    expect(learned.some((l) => l.includes("IRREVERSIBLE"))).toBe(true);
  });

  it("reports a MODEST, honest lossless number — never an inflated stacked projection", () => {
    // The guard that keeps Theo from becoming Caveman: the "active now" number is the real
    // lossless lever measured on the user's own traffic, which on coding traffic is single
    // digits — not the ~80% a multiplicatively-stacked model projection would show.
    const samples = sampleCodingWorkload();
    let before = 0;
    let lossless = 0;
    for (const s of samples) {
      const r = reduceRequest(s.request, { toolSchemas: true, duplicateContext: true, repairCachePrefix: true });
      before += r.summary.estimatedTokensBefore;
      lossless += r.summary.estimatedLosslessTokensSaved;
    }
    const pct = (lossless / before) * 100;
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(30);
  });
});
