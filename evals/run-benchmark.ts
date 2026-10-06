import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { attachRouterChoices, compareBenchmark, loadLLMRouterBenchPartition, partitionBenchmarkRows } from "./benchmark.js";

type Args = {
  root: string;
  dataset: string;
  split?: string;
  trainSplit?: string;
  testSplit?: string;
  models?: string[];
  routes?: string;
  trainFraction: number;
  seed: string;
  maximumQualityDrop: number;
  minimumWorkflowSamples: number;
  bootstrapSamples: number;
  out: string;
};

function parse(argv: string[]): Args {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "root", "dataset", "split", "train-split", "test-split", "models", "routes", "train-fraction",
    "seed", "maximum-quality-drop", "minimum-workflow-samples", "bootstrap-samples", "out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm benchmark:run -- --root path/to/results/bench --dataset mmlu_pro [--split test | --train-split validation --test-split test] [--models model-a,model-b] [--routes competitor-decisions.jsonl] [--out reports/mmlu_pro.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${key}`);
    if (values[name] !== undefined) throw new Error(`Option ${key} was provided more than once.`);
    values[name] = argv[++index]!;
  }
  if (!values.root || !values.dataset) throw new Error("--root and --dataset are required.");
  const separateSplits = values["train-split"] !== undefined || values["test-split"] !== undefined;
  if (separateSplits && (!values["train-split"] || !values["test-split"] || values.split)) {
    throw new Error("Provide both --train-split and --test-split, without --split.");
  }
  const numberOption = (name: string, fallback: number): number => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
    return value;
  };
  return {
    root: resolve(values.root),
    dataset: values.dataset,
    split: values.split ?? (separateSplits ? undefined : "test"),
    trainSplit: values["train-split"],
    testSplit: values["test-split"],
    models: values.models?.split(",").map((model) => model.trim()).filter(Boolean),
    routes: values.routes ? resolve(values.routes) : undefined,
    trainFraction: numberOption("train-fraction", 0.7),
    seed: values.seed ?? "flux-benchmark-v1",
    maximumQualityDrop: numberOption("maximum-quality-drop", 0.02),
    minimumWorkflowSamples: numberOption("minimum-workflow-samples", 20),
    bootstrapSamples: numberOption("bootstrap-samples", 2_000),
    out: resolve(values.out ?? `reports/benchmark-${values.dataset}.json`),
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

function qualityDelta(value: number): string {
  return `${(value * 100).toFixed(2)} pp`;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${path}:${index + 1} is not valid JSON.`);
    }
  });
}

function renderMarkdown(report: ReturnType<typeof compareBenchmark>, source: string): string {
  const strategyRows = report.results.map((result) =>
    `| ${result.name} | ${result.meanQuality.toFixed(4)} | ${usd(result.meanCostUsd)} | ${usd(result.routingCostUsd)} | ${usd(result.totalCostUsd)} | ${percent(result.costSavingsVsBestSinglePercent)} | ${result.totalTokens ?? "n/a"} | ${qualityDelta(result.qualityDeltaLower95)} | ${Object.entries(result.selectedModels).map(([choice, count]) => `\`${choice}\`: ${count}`).join(", ")} |`,
  );
  const routeLines = Object.entries(report.learned.fluxChoiceByWorkflow).map(([workflow, choice]) => {
    const target = report.learned.targetByChoice[choice]!;
    const transform = target.contextProfileId ? `, context profile ${target.contextProfileId}` : "";
    const cap = target.maxOutputTokens === undefined ? "" : `, max output ${target.maxOutputTokens}`;
    return `- \`${workflow}\` → choice \`${choice}\` (model \`${target.model}\`${transform}${cap}; train paired quality-delta lower 95% bound: ${report.learned.trainingQualityDeltaLower95ByWorkflow[workflow]!.toFixed(4)})`;
  });
  return [
    `# FLUX routing benchmark: ${report.dataset}`,
    "",
    `Source: ${source}. Method: ${report.method}. Train: ${report.trainSamples} records (${report.trainSplit}); test: ${report.testSamples} records (${report.testSplit}).`,
    "",
    report.notice,
    "",
    "## Test results",
    "",
    "| Strategy | Mean quality | Mean cost/request | Router cost | Total cost | Savings vs best single | Total tokens | Quality delta lower 95% | Choices selected |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...strategyRows,
    "",
    "## Learned choices",
    "",
    `- Best single model (selected on train): \`${report.learned.bestSingleModel}\``,
    `- Cheapest static model (selected on train): \`${report.learned.cheapestStaticModel}\``,
    ...routeLines,
    "",
    "## Reproduction settings",
    "",
    `- Maximum allowed quality drop: ${report.settings.maximumQualityDrop}`,
    `- Minimum train records per workflow: ${report.settings.minimumWorkflowSamples}`,
    `- Bootstrap samples: ${report.settings.bootstrapSamples}`,
    `- Seed: \`${report.settings.seed}\``,
    `- Models included: ${report.models.map((model) => `\`${model}\``).join(", ")}`,
    ...(Object.keys(report.excludedModels).length > 0
      ? ["", "Excluded models:", ...Object.entries(report.excludedModels).map(([model, reason]) => `- \`${model}\`: ${reason}`)]
      : []),
    "",
    "Quality and cost results apply to this benchmark, its scorer, its recorded prices, and this split. They are not a guarantee of application-specific production outcomes.",
    "",
  ].join("\n");
}

const argv = process.argv.slice(2);
const args = parse(argv[0] === "--" ? argv.slice(1) : argv);
let train;
let test;
let source: string;
if (args.trainSplit && args.testSplit) {
  train = await loadLLMRouterBenchPartition(args.root, args.dataset, args.trainSplit, args.models);
  test = await loadLLMRouterBenchPartition(args.root, args.dataset, args.testSplit, args.models);
  source = `LLMRouterBench extracted results for ${args.dataset}, official ${args.trainSplit}/${args.testSplit} splits`;
} else {
  const rows = await loadLLMRouterBenchPartition(args.root, args.dataset, args.split!, args.models);
  const partition = partitionBenchmarkRows(rows, args.trainFraction, args.seed);
  train = partition.train;
  test = partition.test;
  source = `LLMRouterBench extracted ${args.split} results for ${args.dataset}, deterministically partitioned ${Math.round(args.trainFraction * 100)}/${Math.round((1 - args.trainFraction) * 100)} by exact prompt group`;
}
if (args.routes) {
  test = attachRouterChoices(test, await readJsonl(args.routes));
  source += "; includes imported per-case router decisions with explicit router overhead accounting";
}
const report = compareBenchmark(train, test, {
  maximumQualityDrop: args.maximumQualityDrop,
  minimumWorkflowSamples: args.minimumWorkflowSamples,
  bootstrapSamples: args.bootstrapSamples,
  seed: args.seed,
});
const reportPath = args.out.endsWith(".json") ? args.out : `${args.out}.json`;
const markdownPath = reportPath.replace(/\.json$/i, ".md");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify({ source, ...report }, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(report, source));

console.log(`${report.dataset}: ${report.trainSamples} train / ${report.testSamples} test records`);
console.log(`Train-selected best single model: ${report.learned.bestSingleModel}`);
for (const result of report.results) {
  console.log(`${result.name}: quality ${result.meanQuality.toFixed(4)}, cost ${usd(result.totalCostUsd)}, router cost ${usd(result.routingCostUsd)}, savings ${percent(result.costSavingsVsBestSinglePercent)}, test quality delta lower 95% ${qualityDelta(result.qualityDeltaLower95)}`);
}
console.log(`Reports saved to ${reportPath} and ${markdownPath}`);
