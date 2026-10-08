import { describe, expect, it } from "vitest";
import type { BenchmarkCase } from "./benchmark.js";
import { learnCarrotRouter, oracleCaptureRatio, oracleRouter } from "./reference-routers.js";

/**
 * Cheap is as good as strong on simple prompts and much worse on complex ones, so
 * a working cost-aware router should split traffic by prompt content rather than
 * picking one model for everything.
 */
function cases(count: number, split: string): BenchmarkCase[] {
  return Array.from({ length: count }, (_, index) => {
    const simple = index % 2 === 0;
    return {
      dataset: "router-fixture",
      split,
      id: `${split}-${index}`,
      groupId: `${split}-group-${index}`,
      taskClass: simple ? "simple" : "complex",
      workflow: simple ? "simple" : "complex",
      input: simple
        ? `please summarise this short support ticket number ${index}`
        : `prove the following theorem and derive the integral for case ${index}`,
      expected: "accepted",
      predictions: {
        strong: { score: 0.95, costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
        cheap: { score: simple ? 0.95 : 0.4, costUsd: 0.001, inputTokens: 80, outputTokens: 12 },
      },
    };
  });
}

/**
 * As above, but cheap is now strictly worse than strong even on simple prompts.
 * Selecting on predicted quality alone would therefore take strong everywhere;
 * only a non-zero cost weight can discover the cheap/strong split.
 */
function narrowCases(count: number, split: string): BenchmarkCase[] {
  return cases(count, split).map((row) => ({
    ...row,
    predictions: {
      strong: row.predictions.strong!,
      cheap: {
        ...row.predictions.cheap!,
        score: row.taskClass === "simple" ? 0.94 : 0.4,
      },
    },
  }));
}

const options = { minimumValidationGroups: 4, bootstrapSamples: 300, maximumQualityDrop: 0.02 };

describe("CARROT reference router", () => {
  it("routes simple prompts to the cheap model and keeps hard prompts on the strong one", () => {
    const selection = learnCarrotRouter(cases(120, "train"), cases(60, "validation"), cases(40, "test"), options);
    expect(selection.fellBackToBestSingle).toBe(false);
    expect(selection.selectedLambda).not.toBeNull();
    const test = cases(40, "test");
    const simple = test.filter((row) => row.taskClass === "simple");
    const complex = test.filter((row) => row.taskClass === "complex");
    expect(simple.every((row) => selection.choiceByCaseId[row.id] === "cheap")).toBe(true);
    expect(complex.every((row) => selection.choiceByCaseId[row.id] === "strong")).toBe(true);
  });

  it("needs a non-zero cost weight to find a split the quality signal alone would miss", () => {
    const selection = learnCarrotRouter(
      narrowCases(120, "train"),
      narrowCases(60, "validation"),
      narrowCases(40, "test"),
      options,
    );
    expect(selection.fellBackToBestSingle).toBe(false);
    // Quality alone prefers strong everywhere here, so lambda must be positive.
    expect(selection.selectedLambda).toBeGreaterThan(0);
    const test = narrowCases(40, "test");
    expect(test.filter((row) => row.taskClass === "simple")
      .every((row) => selection.choiceByCaseId[row.id] === "cheap")).toBe(true);
    expect(test.filter((row) => row.taskClass === "complex")
      .every((row) => selection.choiceByCaseId[row.id] === "strong")).toBe(true);
    // Trading 1 quality point on half the traffic stays inside the guardrail.
    expect(selection.validationLower95QualityDelta).toBeGreaterThan(-0.02);
  });

  it("rejects a cost weight that would breach the quality guardrail", () => {
    const selection = learnCarrotRouter(
      narrowCases(120, "train"),
      narrowCases(60, "validation"),
      narrowCases(40, "test"),
      options,
    );
    // Large lambdas route hard prompts to cheap and lose ~27 points; none may win.
    expect(selection.selectedLambda!).toBeLessThan(1);
  });

  it("falls back to the best single model when validation is too thin to support a policy", () => {
    const selection = learnCarrotRouter(cases(40, "train"), cases(6, "validation"), cases(10, "test"), {
      ...options,
      minimumValidationGroups: 100,
    });
    expect(selection.fellBackToBestSingle).toBe(true);
    expect(selection.fallbackReason).toBe("insufficient_validation_groups");
    expect(selection.selectedLambda).toBeNull();
    expect(new Set(Object.values(selection.choiceByCaseId))).toEqual(new Set(["strong"]));
  });

  it("selects on validation only, so test records never influence the configuration", () => {
    const train = cases(120, "train");
    const validation = cases(60, "validation");
    const first = learnCarrotRouter(train, validation, cases(40, "test"), options);
    // A different held-out set must not change the chosen hyperparameters.
    const second = learnCarrotRouter(train, validation, cases(80, "other-test"), options);
    expect(second.selectedK).toBe(first.selectedK);
    expect(second.selectedLambda).toBe(first.selectedLambda);
  });

  it("refuses a pool without at least two fully priced choices", () => {
    const single = cases(40, "train").map((row) => ({
      ...row,
      predictions: { strong: row.predictions.strong! },
    }));
    expect(() => learnCarrotRouter(single, single, single, options))
      .toThrow(/at least two choices/);
  });

  it("requires non-empty partitions", () => {
    expect(() => learnCarrotRouter([], cases(4, "validation"), cases(4, "test"), options))
      .toThrow(/non-empty train, validation, and test/);
  });
});

describe("oracle bounds", () => {
  it("cheapest_within_budget spends a mean-quality budget across queries, not per query", () => {
    const rows = cases(100, "test");
    const oracle = oracleRouter(rows, "cheapest_within_budget", {
      baselineChoice: "strong",
      maximumQualityDrop: 0.02,
    });
    const chosen = rows.map((row) => oracle.choiceByCaseId[row.id]!);
    const delta = rows.reduce((sum, row, index) =>
      sum + row.predictions[chosen[index]!]!.score - row.predictions.strong!.score, 0) / rows.length;
    // Simple prompts are free to downgrade; complex ones cost 0.55 each, so the
    // 0.02 mean budget buys a handful of them at most.
    expect(delta).toBeGreaterThanOrEqual(-0.02 - 1e-9);
    expect(rows.filter((row) => row.taskClass === "simple")
      .every((row) => oracle.choiceByCaseId[row.id] === "cheap")).toBe(true);
    const complexCheap = rows.filter((row) => row.taskClass === "complex" && oracle.choiceByCaseId[row.id] === "cheap");
    expect(complexCheap.length).toBeLessThanOrEqual(4);
  });

  it("cheapest_within_budget needs a baseline to measure its budget against", () => {
    expect(() => oracleRouter(cases(20, "test"), "cheapest_within_budget", {}))
      .toThrow(/baselineChoice/);
  });

  it("cheapest_correct takes the cheapest model that still attains the best score", () => {
    const oracle = oracleRouter(cases(20, "test"), "cheapest_correct");
    const rows = cases(20, "test");
    // Cheap ties strong on simple prompts, so the cheaper one wins there.
    expect(rows.filter((row) => row.taskClass === "simple")
      .every((row) => oracle.choiceByCaseId[row.id] === "cheap")).toBe(true);
    expect(rows.filter((row) => row.taskClass === "complex")
      .every((row) => oracle.choiceByCaseId[row.id] === "strong")).toBe(true);
  });

  it("best_quality breaks score ties towards the cheaper model", () => {
    const oracle = oracleRouter(cases(20, "test"), "best_quality");
    const simple = cases(20, "test").filter((row) => row.taskClass === "simple");
    expect(simple.every((row) => oracle.choiceByCaseId[row.id] === "cheap")).toBe(true);
  });

  it("covers every record it is given", () => {
    const rows = cases(20, "test");
    const oracle = oracleRouter(rows, "cheapest_correct");
    expect(Object.keys(oracle.choiceByCaseId).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it("rejects an empty record set", () => {
    expect(() => oracleRouter([], "cheapest_correct")).toThrow(/at least one record/);
  });
});

describe("oracle capture ratio", () => {
  it("expresses a saving as a share of what was achievable", () => {
    expect(oracleCaptureRatio(100, 80, 60)).toBeCloseTo(50);
    expect(oracleCaptureRatio(100, 60, 60)).toBeCloseTo(100);
  });

  it("reports nothing when the oracle saves nothing", () => {
    expect(oracleCaptureRatio(100, 90, 100)).toBeNull();
    expect(oracleCaptureRatio(100, 90, 120)).toBeNull();
  });

  it("can report a negative share when a router spends more than the baseline", () => {
    expect(oracleCaptureRatio(100, 110, 60)).toBeCloseTo(-25);
  });
});
