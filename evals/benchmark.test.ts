import { describe, expect, it } from "vitest";
import { attachRouterChoices, compareBenchmark, normalizeFluxCaptures, partitionBenchmarkRows } from "./benchmark.js";
import type { BenchmarkCase } from "./benchmark.js";

function cases(count: number, split: string): BenchmarkCase[] {
  return Array.from({ length: count }, (_, index) => {
    const workflow = index % 2 === 0 ? "simple" : "complex";
    return {
      dataset: "support-fixture",
      split,
      id: `${split}-${index}`,
      groupId: `${split}-group-${index}`,
      taskClass: workflow,
      workflow,
      input: `ticket ${index}`,
      expected: "accepted",
      predictions: {
        strong: {
          score: 0.95,
          costUsd: 0.01,
          inputTokens: 100,
          outputTokens: 20,
        },
        cheap: {
          score: workflow === "simple" ? 0.94 : 0.8,
          costUsd: 0.001,
          inputTokens: 80,
          outputTokens: 12,
        },
      },
    };
  });
}

describe("offline routing benchmark", () => {
  it("learns only the safe cheap workflow and reports holdout cost and quality", () => {
    const report = compareBenchmark(cases(80, "train"), cases(20, "test"), {
      maximumQualityDrop: 0.02,
      minimumWorkflowSamples: 20,
      bootstrapSamples: 300,
    });
    expect(report.learned.bestSingleModel).toBe("strong");
    expect(report.learned.cheapestStaticModel).toBe("cheap");
    expect(report.learned.fluxModelByWorkflow).toEqual({ complex: "strong", simple: "cheap" });
    expect(report.learned.policies[0]!.candidates[0]!.approved).toBe(false);
    const flux = report.results.find((result) => result.name === "flux_quality_gated")!;
    expect(flux.selectedModels).toEqual({ cheap: 10, strong: 10 });
    expect(flux.totalCostUsd).toBeCloseTo(0.11);
    expect(flux.meanQuality).toBeCloseTo(0.945);
    expect(flux.costSavingsVsBestSinglePercent).toBeCloseTo(45);
  });

  it("rejects train/test cases that share a prompt group", () => {
    const train = cases(10, "train");
    const test = cases(10, "test");
    test[0]!.groupId = train[0]!.groupId;
    expect(() => compareBenchmark(train, test, { minimumWorkflowSamples: 2 })).toThrow(/leakage/i);
  });

  it("keeps duplicate prompt groups in one deterministic partition", () => {
    const rows = cases(120, "public-test");
    rows[1]!.groupId = rows[0]!.groupId;
    const first = partitionBenchmarkRows(rows, 0.7, "fixed-seed");
    const second = partitionBenchmarkRows(rows, 0.7, "fixed-seed");
    expect(first.train.map(({ id }) => id)).toEqual(second.train.map(({ id }) => id));
    const trainIds = new Set(first.train.map(({ groupId }) => groupId));
    expect(first.test.some(({ groupId }) => trainIds.has(groupId))).toBe(false);
  });

  it("pairs redacted local capture records using stable case IDs", () => {
    const records = ["strong", "cheap"].map((model) => ({
      schemaVersion: 1,
      caseId: "ticket-1",
      groupId: "sha256-prompt-hash",
      request: { input: "redacted" },
      expected: "accepted",
      taskClass: "support",
      workflow: "support.reply",
      attempts: [{ model, response: { output_text: "accepted" }, score: 1, inputTokens: 10, outputTokens: 3, costUsd: 0.0001 }],
    }));
    const normalized = normalizeFluxCaptures(records, "support", "test");
    expect(Object.keys(normalized[0]!.predictions).sort()).toEqual(["cheap", "strong"]);
    expect(normalized[0]!.groupId).toBe("sha256-prompt-hash");
  });

  it("evaluates a context-reduced route without changing the provider model", () => {
    const make = (count: number, split: string): BenchmarkCase[] => Array.from({ length: count }, (_, index) => ({
      dataset: "context-fixture",
      split,
      id: `${split}-${index}`,
      groupId: `${split}-group-${index}`,
      workflow: "support.reply",
      predictions: {
        "gpt-model": { targetModel: "gpt-model", score: 0.95, costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
        "gpt-model::context:compact-v1": {
          targetModel: "gpt-model",
          contextProfileId: "compact-v1",
          score: 0.94,
          costUsd: 0.005,
          inputTokens: 50,
          outputTokens: 20,
        },
      },
    }));
    const report = compareBenchmark(make(40, "train"), make(10, "test"), {
      maximumQualityDrop: 0.02,
      minimumWorkflowSamples: 20,
      bootstrapSamples: 300,
    });
    expect(report.learned.bestSingleModel).toBe("gpt-model");
    expect(report.learned.fluxModelByWorkflow["support.reply"]).toBe("gpt-model");
    expect(report.learned.fluxChoiceByWorkflow["support.reply"]).toBe("gpt-model::context:compact-v1");
    expect(report.learned.policies[0]!.candidates[0]!.contextProfileId).toBe("compact-v1");
    expect(report.results[2]!.costSavingsVsBestSinglePercent).toBeCloseTo(50);
  });

  it("scores imported competitor decisions on the same holdout and includes router spend", () => {
    const train = cases(80, "train");
    const test = cases(20, "test");
    const decisions = test.map((row) => ({
      id: row.id,
      router: "external-router-fixture",
      choice: row.workflow === "simple" ? "cheap" : "strong",
      routingCostUsd: 0.001,
      routingInputTokens: 5,
      routingOutputTokens: 2,
    }));
    const pairedTest = attachRouterChoices(test, decisions);
    const report = compareBenchmark(train, pairedTest, { minimumWorkflowSamples: 20, bootstrapSamples: 300 });
    const result = report.results.find((item) => item.name === "external_router:external-router-fixture")!;
    expect(result.meanQuality).toBeCloseTo(0.945);
    expect(result.totalCostUsd).toBeCloseTo(0.13);
    expect(result.routingCostUsd).toBeCloseTo(0.02);
    expect(result.costSavingsVsBestSinglePercent).toBeCloseTo(35);
    expect(result.routingInputTokens).toBe(100);
  });
});
