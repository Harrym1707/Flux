import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compareBenchmark, normalizeFluxCaptures, partitionBenchmarkRows } from "./benchmark.js";

function parse(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "capture", "train-capture", "test-capture", "dataset", "train-fraction", "seed",
    "maximum-quality-drop", "minimum-workflow-samples", "bootstrap-samples", "out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm benchmark:captures -- (--capture all.jsonl | --train-capture train.jsonl --test-capture test.jsonl) --dataset app-name [--out reports/app.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${key}`);
    if (values[name] !== undefined) throw new Error(`Option ${key} was provided more than once.`);
    values[name] = argv[++index]!;
  }
  if (!values.dataset) throw new Error("--dataset is required.");
  const single = values.capture !== undefined;
  if (single === (values["train-capture"] !== undefined || values["test-capture"] !== undefined)) {
    throw new Error("Provide either --capture or both --train-capture and --test-capture.");
  }
  if (!single && (!values["train-capture"] || !values["test-capture"])) {
    throw new Error("Provide both --train-capture and --test-capture.");
  }
  return values;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(resolve(path), "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${path}:${index + 1} is not valid JSON.`);
    }
  });
}

function numberOption(options: Record<string, string>, name: string, fallback: number): number {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
  return value;
}

const argv = process.argv.slice(2);
const options = parse(argv[0] === "--" ? argv.slice(1) : argv);
const single = options.capture !== undefined;
let train;
let test;
let source: string;
const seed = options.seed ?? "flux-capture-v1";
if (single) {
  const captures = normalizeFluxCaptures(await readJsonl(options.capture!), options.dataset, "captured");
  const partition = partitionBenchmarkRows(captures, numberOption(options, "train-fraction", 0.7), seed);
  train = partition.train;
  test = partition.test;
  source = "opt-in local FLUX SDK capture, deterministically partitioned by prompt group";
} else {
  train = normalizeFluxCaptures(await readJsonl(options["train-capture"]!), options.dataset, "train");
  test = normalizeFluxCaptures(await readJsonl(options["test-capture"]!), options.dataset, "test");
  source = "opt-in local FLUX SDK captures in separate train and test files";
}
const report = compareBenchmark(train, test, {
  maximumQualityDrop: numberOption(options, "maximum-quality-drop", 0.02),
  minimumWorkflowSamples: numberOption(options, "minimum-workflow-samples", 20),
  bootstrapSamples: numberOption(options, "bootstrap-samples", 2_000),
  seed,
});
const out = resolve(options.out ?? `reports/capture-benchmark-${options.dataset}.json`);
const jsonPath = out.endsWith(".json") ? out : `${out}.json`;
const markdownPath = jsonPath.replace(/\.json$/i, ".md");
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({ source, ...report }, null, 2)}\n`);
const table = report.results.map((result) =>
  `| ${result.name} | ${result.meanQuality.toFixed(4)} | ${result.totalCostUsd === null ? "n/a" : `$${result.totalCostUsd.toFixed(6)}`} | ${result.costSavingsVsBestSinglePercent === null ? "n/a" : `${result.costSavingsVsBestSinglePercent.toFixed(2)}%`} | ${result.totalTokens ?? "n/a"} | ${result.qualityDeltaLower95.toFixed(4)} |`,
);
const markdown = [
  `# FLUX workload benchmark: ${report.dataset}`,
  "",
  `${source}. ${report.trainSamples} train / ${report.testSamples} test cases. The route was learned on train cases and scored on the holdout only.`,
  "",
  report.notice,
  "",
  "| Strategy | Mean quality | Test cost | Savings vs best single | Tokens | Quality delta lower 95% |",
  "|---|---:|---:|---:|---:|---:|",
  ...table,
  "",
  `Best single model: \`${report.learned.bestSingleModel}\`; cheapest static model: \`${report.learned.cheapestStaticModel}\`.`,
  "",
  "## FLUX model by workflow",
  "",
  ...Object.entries(report.learned.fluxChoiceByWorkflow).map(([workflow, choice]) => {
    const target = report.learned.targetByChoice[choice]!;
    const transform = target.contextProfileId ? ` with context profile \`${target.contextProfileId}\`` : "";
    const cap = target.maxOutputTokens === undefined ? "" : ` with output cap ${target.maxOutputTokens}`;
    return `- \`${workflow}\` → choice \`${choice}\` on model \`${target.model}\`${transform}${cap}`;
  }),
  "",
  "This report contains aggregate metrics only. Keep the source capture files private and delete them when no longer needed.",
  "",
].join("\n");
await writeFile(markdownPath, markdown);
console.log(`${report.dataset}: ${report.trainSamples} train / ${report.testSamples} test captures`);
for (const result of report.results) {
  console.log(`${result.name}: quality ${result.meanQuality.toFixed(4)}, test cost ${result.totalCostUsd === null ? "n/a" : `$${result.totalCostUsd.toFixed(6)}`}, savings ${result.costSavingsVsBestSinglePercent === null ? "n/a" : `${result.costSavingsVsBestSinglePercent.toFixed(2)}%`}`);
}
console.log(`Reports saved to ${jsonPath} and ${markdownPath}`);
