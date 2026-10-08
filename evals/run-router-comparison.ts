import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  attachRouterChoices,
  compareBenchmark,
  loadLLMRouterBenchPartition,
  partitionBenchmarkRowsThreeWay,
  type BenchmarkCase,
} from "./benchmark.js";
import {
  bestSingleChoice,
  choicesFor,
  eligibleChoices,
  learnContextualRouter,
  type ContextualRouterSelection,
} from "./contextual-router.js";
import { learnCarrotRouter, oracleCaptureRatio, oracleRouter, type CarrotSelection } from "./reference-routers.js";

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
      console.log("Usage: pnpm benchmark:routers -- --root path/to/bench-release --dataset mmlupro --split test_3000 [--models a,b] [--out reports/mmlupro-routers.json]");
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
    seed: values.seed ?? "flux-router-comparison-v1",
    out: resolve(values.out ?? `reports/routers-${values.dataset}.json`),
  };
}

function decisions(router: string, choiceByCaseId: Record<string, string>, rows: BenchmarkCase[]): unknown[] {
  return rows.map((row) => ({
    id: row.id,
    router,
    choice: choiceByCaseId[row.id],
    // Every router here decides from local prompt features and makes no model call.
    routingCostUsd: 0,
    routingInputTokens: 0,
    routingOutputTokens: 0,
  }));
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `${value.toFixed(2)}%`;
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

const routerOptions = {
  maximumQualityDrop: args.maximumQualityDrop,
  minimumValidationGroups: args.minimumValidationGroups,
  bootstrapSamples: args.bootstrapSamples,
  seed: args.seed,
};

const fluxSelections: ContextualRouterSelection[] = (["cost", "tokens", "cost_and_tokens"] as const)
  .map((objective) => learnContextualRouter(
    partition.train, partition.validation, partition.test, objective, routerOptions));

const carrot: CarrotSelection = learnCarrotRouter(
  partition.train, partition.validation, partition.test, routerOptions);

const baselineChoice = bestSingleChoice(
  partition.train,
  choicesFor(partition.train).filter((choice) =>
    [...partition.train, ...partition.test].every((row) =>
      eligibleChoices(row, choicesFor(partition.train), false).includes(choice))),
);
const oracles = (["best_quality", "cheapest_correct", "cheapest_within_budget"] as const)
  .map((kind) => oracleRouter(partition.test, kind, {
    maximumQualityDrop: args.maximumQualityDrop,
    baselineChoice,
  }));

const allDecisions = [
  ...fluxSelections.flatMap((selection) => decisions(selection.router, selection.choiceByCaseId, partition.test)),
  ...decisions(carrot.router, carrot.choiceByCaseId, partition.test),
  ...oracles.flatMap((oracle) => decisions(oracle.router, oracle.choiceByCaseId, partition.test)),
];

const scoredTest = attachRouterChoices(partition.test, allDecisions);
const comparison = compareBenchmark(partition.train, scoredTest, {
  maximumQualityDrop: args.maximumQualityDrop,
  bootstrapSamples: args.bootstrapSamples,
  seed: args.seed,
});

const baseline = comparison.results.find((result) => result.name === "best_single_model")!;
// The denominator is the cost floor a guardrailed router actually competes against:
// the cheapest model per query still within the allowed per-query quality drop.
const oracleFloor = comparison.results.find((result) => result.name === "external_router:oracle_cheapest_within_budget");
const baselineCost = baseline.totalCostUsd;
const oracleCost = oracleFloor?.totalCostUsd ?? null;

const capture = Object.fromEntries(comparison.results.map((result) => [
  result.name,
  baselineCost === null || oracleCost === null || result.totalCostUsd === null
    ? null
    : oracleCaptureRatio(baselineCost, result.totalCostUsd, oracleCost),
]));

const source = `LLMRouterBench ${args.dataset}/${args.split}; exact-prompt grouped ` +
  `${Math.round(args.trainFraction * 100)}/${Math.round(args.validationFraction * 100)}/` +
  `${Math.round((1 - args.trainFraction - args.validationFraction) * 100)} train/validation/test. ` +
  "All routers share these splits, the same hashed TF-IDF prompt features, and the same " +
  `${args.maximumQualityDrop * 100}-point quality guardrail enforced on validation only.`;

const notes = [
  "CARROT is reimplemented from arXiv:2502.03261 using its kNN estimator; it is not the authors' code and is not their reported result.",
  "GraphRouter (arXiv:2410.03834) is not included: it needs BERT embeddings and a graph attention network, and an approximation labelled with its name would be misleading.",
  "Oracle rows read the held-out scores they select on. They are bounds, not deployable routers.",
];

const report = {
  source,
  notes,
  partitions: {
    trainSamples: partition.train.length,
    validationSamples: partition.validation.length,
    testSamples: partition.test.length,
    trainGroups: new Set(partition.train.map((row) => row.groupId)).size,
    validationGroups: new Set(partition.validation.map((row) => row.groupId)).size,
    testGroups: new Set(partition.test.map((row) => row.groupId)).size,
  },
  selections: { flux: fluxSelections, carrot },
  oracleCapturePercent: capture,
  comparison,
};

const rows = comparison.results.map((result) =>
  `| ${result.name} | ${result.meanQuality.toFixed(4)} | ${usd(result.totalCostUsd)} | ` +
  `${percent(result.costSavingsVsBestSinglePercent)} | ${percent(result.tokenSavingsVsBestSinglePercent)} | ` +
  `${(result.qualityDeltaLower95 * 100).toFixed(2)} pp | ${percent(capture[result.name])} |`);

const markdown = [
  `# Router comparison: ${args.dataset}`,
  "",
  source,
  "",
  comparison.notice,
  "",
  "## Held-out test results",
  "",
  "| Strategy | Mean quality | Total model cost | Cost savings | Token savings | Quality delta lower 95% | Share of oracle saving |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows,
  "",
  "## Configuration selected on validation",
  "",
  ...fluxSelections.map((selection) => selection.fellBackToBestSingle
    ? `- \`${selection.router}\`: fell back to the best single model (${selection.fallbackReason}; ${selection.validationGroups}/${selection.minimumValidationGroups} validation groups)`
    : `- \`${selection.router}\`: k=${selection.selectedK}, local-weight=${selection.selectedLocalWeight}, validation quality lower 95% ${(selection.validationLower95QualityDelta * 100).toFixed(2)} pp`),
  carrot.fellBackToBestSingle
    ? `- \`carrot\`: fell back to the best single model (${carrot.fallbackReason}; ${carrot.validationGroups}/${carrot.minimumValidationGroups} validation groups)`
    : `- \`carrot\`: k=${carrot.selectedK}, lambda=${carrot.selectedLambda}, validation quality lower 95% ${(carrot.validationLower95QualityDelta * 100).toFixed(2)} pp`,
  "",
  ...(carrot.tradeOffCurve.length === 0 ? [] : [
    "## CARROT cost/quality trade-off on validation",
    "",
    carrot.fellBackToBestSingle
      ? `No configuration held quality within the ${args.maximumQualityDrop * 100}-point guardrail. The best quality bound any ` +
        `configuration reached was ${(carrot.bestAchievableLower95QualityDelta! * 100).toFixed(2)} pp, so CARROT is rejected here on ` +
        "quality, not on cost. This is what its curve looks like rather than an absence of result:"
      : "Every configuration evaluated on validation, cheapest first:",
    "",
    "| k | lambda | Validation cost savings | Mean quality delta | Quality delta lower 95% | Models used | Within guardrail |",
    "|---:|---:|---:|---:|---:|---:|:--:|",
    ...carrot.tradeOffCurve.slice(0, 12).map((point) =>
      `| ${point.k} | ${point.lambda} | ${point.validationCostSavingsPercent.toFixed(2)}% | ` +
      `${(point.meanQualityDelta * 100).toFixed(2)} pp | ${(point.lower95QualityDelta * 100).toFixed(2)} pp | ` +
      `${point.distinctModelsSelected} | ${point.passedGuardrail ? "yes" : "no"} |`),
    ...(carrot.tradeOffCurve.length > 12
      ? ["", `${carrot.tradeOffCurve.length - 12} further configurations omitted; all are in the JSON report.`]
      : []),
    "",
  ]),
  "## Reading this table",
  "",
  ...notes.map((note) => `- ${note}`),
  "",
  "Share of oracle saving is a router's cost reduction as a percentage of the reduction " +
  "`oracle_cheapest_within_budget` achieves, that is the cheapest allocation whose mean quality stays within " +
  `the ${args.maximumQualityDrop * 100}-point budget. It is the honest denominator: a headline ` +
  "saving means little without knowing how much was available. A strategy that breaches the " +
  "guardrail can exceed 100%, because it is buying its saving with quality the oracle refuses to spend.",
  "",
  "On a binary scorer `oracle_best_quality` and `oracle_cheapest_correct` are the same selection " +
  "by definition, since the best available score is exactly the correctness threshold. Identical " +
  "rows for those two are expected, not a defect.",
  "",
].join("\n");

const jsonPath = args.out.endsWith(".json") ? args.out : `${args.out}.json`;
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(jsonPath.replace(/\.json$/i, ".md"), markdown);

console.log(`${args.dataset}: ${partition.train.length} train / ${partition.validation.length} validation / ${partition.test.length} test`);
for (const result of comparison.results) {
  console.log(
    `${result.name}: quality ${result.meanQuality.toFixed(4)}, cost ${usd(result.totalCostUsd)}, ` +
    `savings ${percent(result.costSavingsVsBestSinglePercent)}, ` +
    `quality lower 95% ${(result.qualityDeltaLower95 * 100).toFixed(2)} pp, ` +
    `oracle capture ${percent(capture[result.name])}`,
  );
}
console.log(carrot.fellBackToBestSingle
  ? `carrot: fallback (${carrot.fallbackReason})`
  : `carrot: k=${carrot.selectedK}, lambda=${carrot.selectedLambda}`);
console.log(`Reports saved to ${jsonPath} and ${jsonPath.replace(/\.json$/i, ".md")}`);
