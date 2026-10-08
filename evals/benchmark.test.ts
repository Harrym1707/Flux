import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachRouterChoices, compareBenchmark, loadLLMRouterBenchPartition, normalizeFluxCaptures, partitionBenchmarkRows, partitionBenchmarkRowsThreeWay } from "./benchmark.js";
import { learnContextualRouter } from "./contextual-router.js";
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
  it("loads mixed bench-release layouts and validates embedded dataset metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "flux-bench-release-"));
    try {
      for (const model of ["strong", "cheap"]) {
        const modelDir = join(root, "fixture", model);
        await mkdir(modelDir, { recursive: true });
        await writeFile(join(modelDir, "result.json"), JSON.stringify({
          dataset_name: "fixture",
          split: "test",
          records: [{
            index: 1,
            origin_query: "fixture prompt",
            ground_truth: "answer",
            score: model === "strong" ? 1 : 0.9,
            prediction: "answer",
            cost: model === "strong" ? 0.01 : 0.001,
            prompt_tokens: 10,
            completion_tokens: 2,
          }],
        }));
      }
      const nestedModelDir = join(root, "fixture", "test", "nested-extra");
      await mkdir(nestedModelDir, { recursive: true });
      await writeFile(join(nestedModelDir, "result.json"), JSON.stringify({
        dataset_name: "fixture",
        split: "test",
        records: [{
          index: 1,
          origin_query: "fixture prompt",
          ground_truth: "answer",
          score: 0.8,
          prediction: "answer",
          cost: 0.0005,
          prompt_tokens: 10,
          completion_tokens: 2,
        }],
      }));
      const rows = await loadLLMRouterBenchPartition(root, "fixture", "test");
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!.predictions).sort()).toEqual(["cheap", "nested-extra", "strong"]);
      await expect(loadLLMRouterBenchPartition(root, "fixture", "validation")).rejects.toThrow(/declares split test, expected validation/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps valid score/cost data while marking invalid source token usage missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "flux-bench-usage-"));
    try {
      for (const model of ["good", "bad-usage"]) {
        const modelDir = join(root, "fixture", "test", model);
        await mkdir(modelDir, { recursive: true });
        await writeFile(join(modelDir, "result.json"), JSON.stringify({
          dataset_name: "fixture",
          split: "test",
          records: [{
            index: 1,
            prompt: "fixture prompt",
            score: 0.9,
            cost: 0.001,
            prompt_tokens: 10,
            completion_tokens: model === "bad-usage" ? -52 : 2,
          }],
        }));
      }
      const rows = await loadLLMRouterBenchPartition(root, "fixture", "test");
      expect(rows[0]!.predictions["bad-usage"]!.score).toBe(0.9);
      expect(rows[0]!.predictions["bad-usage"]!.costUsd).toBe(0.001);
      expect(rows[0]!.predictions["bad-usage"]!.outputTokens).toBeUndefined();
      expect(rows[0]!.predictions["bad-usage"]!.missingMetrics).toEqual(["outputTokens"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("excludes a model recorded at $0 with real token usage as unpriced, not free", () => {
    const withUnpriced = (count: number, split: string): BenchmarkCase[] =>
      cases(count, split).map((row) => ({
        ...row,
        predictions: {
          ...row.predictions,
          unpriced: { score: 0.6, costUsd: 0, inputTokens: 90, outputTokens: 15 },
        },
      }));
    const report = compareBenchmark(withUnpriced(80, "train"), withUnpriced(20, "test"), {
      maximumQualityDrop: 0.02,
      minimumWorkflowSamples: 20,
      bootstrapSamples: 300,
    });
    expect(report.unpricedModels).toEqual(["unpriced"]);
    expect(report.models).not.toContain("unpriced");
    expect(report.excludedModels.unpriced).toMatch(/unpriced, not free|does not price/i);
    // The cheapest priced model wins the cost comparison, so no 100% saving is reported.
    expect(report.learned.cheapestStaticModel).toBe("cheap");
    const cheapest = report.results.find((result) => result.name === "cheapest_static")!;
    expect(cheapest.costSavingsVsBestSinglePercent).toBeLessThan(100);
    expect(cheapest.totalCostUsd).toBeGreaterThan(0);
  });

  it("keeps a $0 model that genuinely consumed no tokens", () => {
    const withFree = (count: number, split: string): BenchmarkCase[] =>
      cases(count, split).map((row) => ({
        ...row,
        predictions: {
          ...row.predictions,
          nooutput: { score: 0.5, costUsd: 0, inputTokens: 0, outputTokens: 0 },
        },
      }));
    const report = compareBenchmark(withFree(80, "train"), withFree(20, "test"), {
      maximumQualityDrop: 0.02,
      minimumWorkflowSamples: 20,
      bootstrapSamples: 300,
    });
    expect(report.unpricedModels).toEqual([]);
    expect(report.models).toContain("nooutput");
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

  it("keeps duplicate prompt groups together across three partitions", () => {
    const rows = cases(180, "source-test");
    rows[1]!.groupId = rows[0]!.groupId;
    const first = partitionBenchmarkRowsThreeWay(rows, 0.6, 0.2, "three-way-seed");
    const second = partitionBenchmarkRowsThreeWay(rows, 0.6, 0.2, "three-way-seed");
    expect(first.train.map(({ id }) => id)).toEqual(second.train.map(({ id }) => id));
    expect(first.validation.map(({ id }) => id)).toEqual(second.validation.map(({ id }) => id));
    expect(first.test.map(({ id }) => id)).toEqual(second.test.map(({ id }) => id));
    const group = rows[0]!.groupId;
    const groupSides = [first.train, first.validation, first.test].filter((partition) => partition.some((row) => row.groupId === group));
    expect(groupSides).toHaveLength(1);
  });

  it("learns a prompt-context route using train and validation only", () => {
    const make = (count: number, split: string): BenchmarkCase[] => Array.from({ length: count }, (_, index) => {
      const easy = index % 2 === 0;
      return {
        dataset: "context-knn-fixture",
        split,
        id: `${split}-${index}`,
        groupId: `${split}-group-${index}`,
        input: `${easy ? "simple" : "complex"} support request ${index}`,
        predictions: {
          strong: { score: 0.95, costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
          cheap: { score: easy ? 0.94 : 0.8, costUsd: 0.001, inputTokens: 80, outputTokens: 12 },
        },
      };
    });
    const selection = learnContextualRouter(make(80, "train"), make(40, "validation"), make(20, "test"), "cost", {
      maximumQualityDrop: 0.02,
      minimumValidationGroups: 20,
      bootstrapSamples: 300,
    });
    expect(selection.fellBackToBestSingle).toBe(false);
    expect(Object.values(selection.choiceByCaseId).filter((choice) => choice === "cheap").length).toBeGreaterThan(0);
    expect(selection.validationLower95QualityDelta).toBeGreaterThanOrEqual(-0.02);
    const joint = learnContextualRouter(make(80, "train"), make(40, "joint-validation"), make(20, "joint-test"), "cost_and_tokens", {
      minimumValidationGroups: 20,
      bootstrapSamples: 300,
    });
    expect(joint.fellBackToBestSingle).toBe(false);
    expect(Object.values(joint.choiceByCaseId).filter((choice) => choice === "cheap").length).toBeGreaterThan(0);
    const conservative = learnContextualRouter(make(80, "train"), make(10, "small-validation"), make(20, "test"), "cost", {
      bootstrapSamples: 300,
    });
    expect(conservative.fellBackToBestSingle).toBe(true);
    expect(conservative.fallbackReason).toBe("insufficient_validation_groups");
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
