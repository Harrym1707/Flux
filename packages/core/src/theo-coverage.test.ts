import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import { WORKLOAD_ARCHETYPES, leversFor } from "./savings-model.js";
import { coverageForProfile } from "./theo-coverage.js";

const cachingPrice: TokenPrice = { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 10 };

describe("coverageForProfile", () => {
  it("reports the structural gap on a tool-heavy workload: the two architecture levers Theo cannot apply", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);

    // The catalogue has 10 levers; on a tool-heavy workload the two the proxy
    // cannot apply are the agent re-architectures, and only those.
    const gapIds = report.gaps.map((g) => g.leverId).sort();
    expect(gapIds).toEqual(["code-mode", "progressive-disclosure"]);

    for (const gap of report.gaps) {
      expect(gap.applicable).toBe(true);
      expect(gap.applied).toBe(false);
      expect(gap.reason).toMatch(/[Aa]rchitecture change/);
      // Headroom is shown, but as a projection — it must be a finite number.
      expect(Number.isFinite(gap.projectedSavingUsd)).toBe(true);
    }
  });

  it("coverage counts applied over applicable, and every applied lever is a real leversFor lever", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);
    const appliedByTheo = new Set(leversFor(WORKLOAD_ARCHETYPES.toolHeavyAgent!).map((l) => l.id));

    const appliedInReport = report.levers.filter((l) => l.applied).map((l) => l.leverId);
    for (const id of appliedInReport) expect(appliedByTheo.has(id)).toBe(true);

    expect(report.appliedLevers).toBe(appliedInReport.length);
    expect(report.leverCoveragePercent).toBeCloseTo(
      (report.appliedLevers / report.applicableLevers) * 100,
      6,
    );
    expect(report.appliedLevers).toBeLessThan(report.applicableLevers); // the two architecture gaps
  });

  it("splits the realized saving into live-now (deterministic) and held-for-replay", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.toolHeavyAgent!, cachingPrice);
    expect(report.realizedDeterministicPercent).toBeGreaterThan(0);
    expect(report.realizedNeedsVerificationPercent).toBeGreaterThan(0);
    // The two parts cannot exceed the whole realized saving.
    expect(report.realizedDeterministicPercent + report.realizedNeedsVerificationPercent)
      .toBeLessThanOrEqual(report.realizedSavingPercent + 1e-6);
  });

  it("a RAG workload with no tools marks the tool-schema levers not applicable, not as gaps", () => {
    const report = coverageForProfile(WORKLOAD_ARCHETYPES.ragDocumentQa!, cachingPrice);
    const toolLever = report.levers.find((l) => l.leverId === "tool-schema-compaction")!;
    expect(toolLever.applicable).toBe(false);
    // Architecture levers only target tool schemas, so with no tools they are not gaps here.
    expect(report.gaps.map((g) => g.leverId)).not.toContain("code-mode");
    expect(report.gaps.map((g) => g.leverId)).not.toContain("progressive-disclosure");
  });

  it("is deterministic: the same inputs produce an identical report", () => {
    const a = coverageForProfile(WORKLOAD_ARCHETYPES.supportAssistant!, cachingPrice);
    const b = coverageForProfile(WORKLOAD_ARCHETYPES.supportAssistant!, cachingPrice);
    expect(a).toEqual(b);
  });
});
