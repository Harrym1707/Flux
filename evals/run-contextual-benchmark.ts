import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  attachRouterChoices,
  compareBenchmark,
  loadLLMRouterBenchPartition,
  partitionBenchmarkRowsThreeWay,
  type BenchmarkCase,
} from "./benchmark.js";
import { learnContextualRouter, type ContextualRouterSelection } from "./contextual-router.js";

type Args = {
  root: string;
  dataset: string;
  split: string;
  models?: string[];
  trainFraction: number;
  validationFraction: number;
  maximumQualityDrop: number;
  minimumValidationGroups: number;
  bootstrapSamples: number;
  seed: string;
  out: string;
};

function parse(argv: string[]): Args {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "root", "dataset", "split", "models", "train-fraction", "validation-fraction",
    "maximum-quality-drop", "minimum-validation-groups", "bootstrap-samples", "seed", "out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm benchmark:contextual -- --root path/to/bench-release --dataset livecodebench --split test [--models model-a,model-b] [--minimum-validation-groups 100] [--out reports/livecodebench-contextual.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${key}`);
    if (values[name] !== undefined) throw new Error(`Option ${key} was provided more than once.`);
    values[name] = argv[++index]!;
  }
  if (!values.root || !values.dataset) throw new Error("--root and --dataset are required.");
  const numberOption = (name: string, fallback: number): number => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
    return value;
  };
  return {
    root: resolve(values.root),
    dataset: values.dataset,
    split: values.split ?? "test",
    models: values.models?.split(",").map((model) => model.trim()).filter(Boolean),
    trainFraction: numberOption("train-fraction", 0.6),
    validationFraction: numberOption("validation-fraction", 0.2),
    maximumQualityDrop: numberOption("maximum-quality-drop", 0.02),
    minimumValidationGroups: numberOption("minimum-validation-groups", 100),
    bootstrapSamples: numberOption("bootstrap-samples", 2_000),
    seed: values.seed ?? "flux-contextual-benchmark-v1",
    out: resolve(values.out ?? `reports/contextual-${values.dataset}.json`),
  };
}

function buildDecisions(selection: ContextualRouterSelection, rows: Parameters<typeof attachRouterChoices>[0]): unknown[] {
  return rows.map((row) => ({
    id: row.id,
    router: selection.router,
    choice: selection.choiceByCaseId[row.id],
    // This router uses local prompt features only; it makes no model call.
    routingCostUsd: 0,
    routingInputTokens: 0,
    routingOutputTokens: 0,
  }));
}

function sourceMetricGaps(rows: BenchmarkCase[]): Record<string, Record<string, number>> {
  const models = [...new Set(rows.flatMap((row) => Object.keys(row.predictions)))].sort();
  return Object.fromEntries(models.flatMap((model) => {
    const gaps = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    for (const row of rows) {
      const prediction = row.predictions[model];
      if (!Number.isFinite(prediction?.costUsd)) gaps.costUsd += 1;
      if (!Number.isFinite(prediction?.inputTokens)) gaps.inputTokens += 1;
      if (!Number.isFinite(prediction?.outputTokens)) gaps.outputTokens += 1;
    }
    return Object.values(gaps).some((count) => count > 0) ? [[model, gaps]] : [];
  }));
}

function markdown(
  report: ReturnType<typeof compareBenchmark>,
  source: string,
  selections: ContextualRouterSelection[],
  metricGaps: Record<string, Record<string, number>>,
): string {
  const rows = report.results.map((result) =>
    `| ${result.name} | ${result.meanQuality.toFixed(4)} | ${result.totalCostUsd === null ? "n/a" : `$${result.totalCostUsd.toFixed(6)}`} | ${result.costSavingsVsBestSinglePercent === null ? "n/a" : `${result.costSavingsVsBestSinglePercent.toFixed(2)}%`} | ${result.totalTokens ?? "n/a"} | ${result.tokenSavingsVsBestSinglePercent === null ? "n/a" : `${result.tokenSavingsVsBestSinglePercent.toFixed(2)}%`} | ${(result.qualityDeltaLower95 * 100).toFixed(2)} pp | ${Object.entries(result.selectedModels).map(([model, count]) => `\`${model}\`: ${count}`).join(", ")} |`,
  );
  const selectionLines = selections.map((selection) =>
    `- \`${selection.router}\`: ${selection.fellBackToBestSingle
      ? `best-single fallback (${selection.fallbackReason}; ${selection.validationGroups}/${selection.minimumValidationGroups} required validation groups)`
      : `selected k=${selection.selectedK}, local-weight=${selection.selectedLocalWeight}`}; validation quality delta ${selection.validationMeanQualityDelta.toFixed(4)} (cluster-bootstrap lower 95% ${selection.validationLower95QualityDelta.toFixed(4)}), validation cost/request ${selection.validationMeanCostUsd === null ? "n/a" : `$${selection.validationMeanCostUsd.toFixed(8)}`}, validation tokens/request ${selection.validationMeanTokens?.toFixed(1) ?? "n/a"}`,
  );
  return [
    `# FLUX contextual routing benchmark: ${report.dataset}`,
    "",
    `Source: ${source}. Method: ${report.method}. Train: ${report.trainSamples}; test: ${report.testSamples}.`,
    "",
    report.notice,
    "",
    "## Held-out test results",
    "",
    "| Strategy | Mean quality | Total model cost | Savings vs best single | Total tokens | Token savings vs best single | Quality delta lower 95% | Choices selected |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "## Validation-only policy selection",
    "",
    ...selectionLines,
    "",
    "## Source usage-data gaps",
    "",
    ...(Object.keys(metricGaps).length === 0
      ? ["No missing or invalid cost/token usage fields in the selected model pool."]
      : Object.entries(metricGaps).map(([model, gaps]) =>
        `- \`${model}\`: missing/invalid cost ${gaps.costUsd}, input tokens ${gaps.inputTokens}, output tokens ${gaps.outputTokens}`)),
    ...(report.unpricedModels.length === 0
      ? []
      : [
        "",
        "Excluded as unpriced (recorded at $0 on every record despite non-zero token usage; unpriced, not free):",
        ...report.unpricedModels.map((model) => `- \`${model}\``),
      ]),
    "",
    "Cost and quality results apply to this dataset, scorer, source price fields, and grouped split. Local router CPU time is not included in token/provider cost.",
    "",
  ].join("\n");
}

const argv = process.argv.slice(2);
const args = parse(argv[0] === "--" ? argv.slice(1) : argv);
const sourceRows = await loadLLMRouterBenchPartition(args.root, args.dataset, args.split, args.models);
const partition = partitionBenchmarkRowsThreeWay(
  sourceRows,
  args.trainFraction,
  args.validationFraction,
  args.seed,
);
const selections = (["cost", "tokens", "cost_and_tokens"] as const).map((objective) => learnContextualRouter(
  partition.train,
  partition.validation,
  partition.test,
  objective,
  {
    maximumQualityDrop: args.maximumQualityDrop,
    minimumValidationGroups: args.minimumValidationGroups,
    bootstrapSamples: args.bootstrapSamples,
    seed: args.seed,
  },
));
const decisions = selections.flatMap((selection) => buildDecisions(selection, partition.test));
const scoredTest = attachRouterChoices(partition.test, decisions);
const comparison = compareBenchmark(partition.train, scoredTest, {
  maximumQualityDrop: args.maximumQualityDrop,
  bootstrapSamples: args.bootstrapSamples,
  seed: args.seed,
});
const metricGaps = sourceMetricGaps(sourceRows);
const source = `LLMRouterBench ${args.dataset}/${args.split}; exact-prompt grouped ${Math.round(args.trainFraction * 100)}/${Math.round(args.validationFraction * 100)}/${Math.round((1 - args.trainFraction - args.validationFraction) * 100)} train/validation/test; contextual features fit on train, configurations selected on validation with at least ${args.minimumValidationGroups} independent prompt groups`;
const report = {
  source,
  partitions: {
    trainSamples: partition.train.length,
    validationSamples: partition.validation.length,
    testSamples: partition.test.length,
    trainGroups: new Set(partition.train.map((row) => row.groupId)).size,
    validationGroups: new Set(partition.validation.map((row) => row.groupId)).size,
    testGroups: new Set(partition.test.map((row) => row.groupId)).size,
  },
  policySelection: selections,
  sourceMetricGaps: metricGaps,
  comparison,
};
const jsonPath = args.out.endsWith(".json") ? args.out : `${args.out}.json`;
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const markdownPath = jsonPath.replace(/\.json$/i, ".md");
await writeFile(markdownPath, markdown(comparison, source, selections, metricGaps));

console.log(`${args.dataset}: ${partition.train.length} train / ${partition.validation.length} validation / ${partition.test.length} held-out test records`);
console.log(`Train-selected best single model: ${comparison.learned.bestSingleModel}`);
for (const result of comparison.results) {
  console.log(`${result.name}: quality ${result.meanQuality.toFixed(4)}, cost ${result.totalCostUsd === null ? "n/a" : `$${result.totalCostUsd.toFixed(6)}`}, savings ${result.costSavingsVsBestSinglePercent === null ? "n/a" : `${result.costSavingsVsBestSinglePercent.toFixed(2)}%`}, total tokens ${result.totalTokens ?? "n/a"}, token savings ${result.tokenSavingsVsBestSinglePercent === null ? "n/a" : `${result.tokenSavingsVsBestSinglePercent.toFixed(2)}%`}, quality delta lower 95% ${(result.qualityDeltaLower95 * 100).toFixed(2)} pp`);
}
for (const selection of selections) {
  console.log(`${selection.router}: ${selection.fellBackToBestSingle ? `best-single fallback (${selection.fallbackReason}; ${selection.validationGroups}/${selection.minimumValidationGroups} groups)` : `k=${selection.selectedK}, localWeight=${selection.selectedLocalWeight}`}, validation lower 95% ${(selection.validationLower95QualityDelta * 100).toFixed(2)} pp`);
}
console.log(`Reports saved to ${jsonPath} and ${markdownPath}`);
