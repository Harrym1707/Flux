import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FluxRoutingPolicy } from "../packages/sdk-js/src/types.js";

type ReplayArtifact = {
  baseline?: { model?: string };
  candidate?: { model?: string; maxOutputTokens?: number; contextProfileId?: string };
  policy?: {
    minimumSamples?: number;
    minimumCandidateAccuracy?: number;
    maximumAccuracyDrop?: number;
  };
  report?: {
    eligibleForReview?: boolean;
    sampleSize?: number;
    candidateAccuracyLower95?: number;
    accuracyDrop?: number;
    baselineCostUsd?: number | null;
    candidateCostUsd?: number | null;
  };
};

function parse(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: corepack pnpm route:policy -- --report replay-report.json --task-class classification [--workflow name] [--difficulty low|medium|high] [--risk-level low|medium|high] [--traffic-share 0.05] [--out routing-policy.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
      if (!["report", "task-class", "traffic-share", "workflow", "difficulty", "risk-level", "out"].includes(name)) throw new Error(`Unknown option: ${key}`);
    options[name] = argv[++index];
  }
  if (!options.report || !options["task-class"]) throw new Error("Both --report and --task-class are required.");
  return options;
}

const args = process.argv.slice(2);
const options = parse(args[0] === "--" ? args.slice(1) : args);
const reportPath = resolve(options.report);
const artifact = JSON.parse(await readFile(reportPath, "utf8")) as ReplayArtifact;
const sampleSize = artifact.report?.sampleSize;
const baselineCostUsd = artifact.report?.baselineCostUsd;
const candidateCostUsd = artifact.report?.candidateCostUsd;
if (!artifact.baseline?.model || !artifact.candidate?.model || !artifact.policy || !artifact.report) {
  throw new Error("Report must come from `replay:run --out`; it needs model targets, policy, and evaluation report.");
}
if (!Number.isInteger(sampleSize) || sampleSize! < 1 ||
    !Number.isFinite(baselineCostUsd) || baselineCostUsd! <= 0 ||
    !Number.isFinite(candidateCostUsd) || candidateCostUsd! < 0 ||
    !Number.isFinite(artifact.report.candidateAccuracyLower95) ||
    !Number.isFinite(artifact.report.accuracyDrop)) {
  throw new Error("Replay report lacks a valid sample, quality bound, or complete cost comparison.");
}

const trafficShare = options["traffic-share"] === undefined ? 0.05 : Number(options["traffic-share"]);
  if (!Number.isFinite(trafficShare) || trafficShare < 0 || trafficShare > 1) {
    throw new Error("--traffic-share must be between 0 and 1.");
  }
for (const name of ["difficulty", "risk-level"] as const) {
  const value = options[name];
  if (value !== undefined && !["low", "medium", "high"].includes(value)) {
    throw new Error(`--${name} must be low, medium, or high.`);
  }
}

const policy: FluxRoutingPolicy = {
  id: `${options["task-class"]}-${Date.now()}`,
  taskClass: options["task-class"],
  workflow: options.workflow,
  difficulty: options.difficulty as FluxRoutingPolicy["difficulty"],
  riskLevel: options["risk-level"] as FluxRoutingPolicy["riskLevel"],
  baselineModel: artifact.baseline.model,
  minimumSamples: artifact.policy.minimumSamples ?? 1,
  minimumCandidateAccuracyLower95: artifact.policy.minimumCandidateAccuracy ?? 1,
  maximumAccuracyDrop: artifact.policy.maximumAccuracyDrop ?? 0,
  candidates: [{
    model: artifact.candidate.model,
    trafficShare,
    approved: false,
    maxOutputTokens: artifact.candidate.maxOutputTokens,
    contextProfileId: artifact.candidate.contextProfileId,
    evidence: {
      baselineModel: artifact.baseline.model,
      candidateModel: artifact.candidate.model,
      eligibleForReview: artifact.report.eligibleForReview === true,
      sampleSize: sampleSize!,
      candidateAccuracyLower95: artifact.report.candidateAccuracyLower95!,
      accuracyDrop: artifact.report.accuracyDrop!,
      baselineCostUsd: baselineCostUsd!,
      candidateCostUsd: candidateCostUsd!,
    },
  }],
};

const outputPath = resolve(options.out ?? "flux-routing-policy.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(policy, null, 2)}\n`);
console.log(`Routing policy written to ${outputPath}`);
console.log(`Replay gates ${policy.candidates[0].evidence.eligibleForReview ? "passed" : "failed"}; candidate remains unapproved until you review the report.`);
