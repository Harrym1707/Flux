import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateReplay } from "../packages/core/src/replay.js";
import type { ReplayPolicy, ReplayRecord } from "../packages/core/src/types.js";

type Dataset = {
  name?: string;
  notice?: string;
  requests: ReplayRecord[];
};

function parseOptions(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm eval:replay -- [--dataset file] [--policy file] [--out report.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    options[key.slice(2)] = argv[++index];
  }
  return options;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function validateDataset(dataset: Dataset): void {
  if (!Array.isArray(dataset.requests) || dataset.requests.length === 0) {
    throw new Error("Dataset must contain a non-empty requests array.");
  }
  const ids = new Set<string>();
  for (const [index, request] of dataset.requests.entries()) {
    if (!request || typeof request.id !== "string" || request.id.trim() === "") {
      throw new Error(`Request at index ${index} must have a non-empty id.`);
    }
    if (ids.has(request.id)) throw new Error(`Duplicate request id: ${request.id}`);
    ids.add(request.id);
    for (const field of ["expected", "baseline", "candidate"] as const) {
      if (!(field in request)) throw new Error(`Request ${request.id} is missing ${field}.`);
    }
    for (const field of ["baselineCostUsd", "candidateCostUsd"] as const) {
      const value = request[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`Request ${request.id} has an invalid ${field}.`);
      }
    }
  }
}

function validatePolicy(policy: ReplayPolicy): void {
  if (policy.evaluator !== "exact_match" && policy.evaluator !== "classification") {
    throw new Error('Policy evaluator must be "exact_match" or "classification".');
  }
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples < 1) {
    throw new Error("Policy minimumSamples must be a positive integer.");
  }
  for (const [name, value] of Object.entries({
    minimumCandidateAccuracy: policy.minimumCandidateAccuracy,
    maximumAccuracyDrop: policy.maximumAccuracyDrop,
    maximumCandidateErrorRate: policy.maximumCandidateErrorRate,
  })) {
    if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
      throw new Error(`Policy ${name} must be between 0 and 1.`);
    }
  }
  if (policy.minimumCostSavingsPercent !== undefined &&
      (!Number.isFinite(policy.minimumCostSavingsPercent) || policy.minimumCostSavingsPercent < 0)) {
    throw new Error("Policy minimumCostSavingsPercent must be a non-negative number.");
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const argv = process.argv.slice(2);
const options = parseOptions(argv[0] === "--" ? argv.slice(1) : argv);
const datasetPath = resolve(options.dataset ?? "evals/replay-demo.json");
const policyPath = resolve(options.policy ?? "evals/replay-policy.example.json");
const dataset = await readJson<Dataset>(datasetPath);
const policy = await readJson<ReplayPolicy>(policyPath);
validateDataset(dataset);
validatePolicy(policy);

const report = evaluateReplay(dataset.requests, policy);
const output = {
  dataset: dataset.name ?? datasetPath,
  notice: dataset.notice,
  policy,
  ...report,
};

console.log(output.dataset);
if (output.notice) console.log(output.notice);
console.log(`Samples: ${report.sampleSize} (minimum ${policy.minimumSamples})`);
console.log(`Baseline accuracy: ${percent(report.baselineAccuracy)}`);
console.log(`Candidate accuracy: ${percent(report.candidateAccuracy)}`);
console.log(`Candidate one-sided 95% Wilson lower bound: ${percent(report.candidateAccuracyLower95)}`);
if (report.candidateFailureIds.length > 0) {
  console.log(`Candidate failures: ${report.candidateFailureIds.join(", ")}`);
}
if (report.regressionIds.length > 0) {
  console.log(`Baseline-to-candidate regressions: ${report.regressionIds.join(", ")}`);
}
if (report.costSavingsPercent !== null) {
  console.log(`Cost: $${report.baselineCostUsd!.toFixed(3)} -> $${report.candidateCostUsd!.toFixed(3)} (${report.costSavingsPercent.toFixed(1)}% savings)`);
} else {
  console.log("Cost: unavailable (complete cost data not provided)");
}
for (const gate of report.gates) {
  const observed = gate.observed === null
    ? "unavailable"
    : gate.name.includes("accuracy") || gate.name.includes("error_rate")
      ? percent(gate.observed)
      : gate.name.includes("savings")
        ? `${gate.observed.toFixed(1)}%`
        : String(gate.observed);
  const required = gate.name.includes("accuracy") || gate.name.includes("error_rate")
    ? percent(gate.required)
    : gate.name.includes("savings")
      ? `${gate.required.toFixed(1)}%`
      : String(gate.required);
  console.log(`${gate.passed ? "PASS" : "FAIL"} ${gate.name}: ${observed} (required ${required})`);
}
console.log(`Activation: ${report.eligibleForReview ? "ELIGIBLE FOR REVIEW" : "BLOCKED"}`);

if (options.out) {
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Report written to ${outputPath}`);
}
if (!report.eligibleForReview) process.exitCode = 2;
