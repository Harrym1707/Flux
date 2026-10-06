import type {
  ReplayGate,
  ReplayPolicy,
  ReplayRecord,
  ReplayReport,
} from "./types.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function matches(expected: unknown, actual: unknown, evaluator: ReplayPolicy["evaluator"]): boolean {
  if (evaluator === "classification" && typeof expected === "string" && typeof actual === "string") {
    return expected.trim().toLocaleLowerCase() === actual.trim().toLocaleLowerCase();
  }
  return canonical(expected) === canonical(actual);
}

function wilsonLowerBound(successes: number, sampleSize: number): number {
  // One-sided 95% Wilson lower bound (z = 1.645).
  const z = 1.645;
  const proportion = successes / sampleSize;
  const zSquared = z * z;
  const denominator = 1 + zSquared / sampleSize;
  const center = proportion + zSquared / (2 * sampleSize);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion)) / sampleSize + zSquared / (4 * sampleSize * sampleSize),
  );
  return Math.max(0, (center - margin) / denominator);
}

function sumIfComplete(records: ReplayRecord[], field: "baselineCostUsd" | "candidateCostUsd"): number | null {
  if (!records.every((record) => typeof record[field] === "number")) return null;
  return records.reduce((total, record) => total + record[field]!, 0);
}

export function evaluateReplay(records: ReplayRecord[], policy: ReplayPolicy): ReplayReport {
  if (records.length === 0) throw new Error("Replay needs at least one record.");
  if (policy.evaluator !== "exact_match" && policy.evaluator !== "classification") {
    throw new Error('evaluator must be "exact_match" or "classification".');
  }
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples < 1) {
    throw new Error("minimumSamples must be a positive integer.");
  }
  if (!Number.isFinite(policy.minimumCandidateAccuracy) || policy.minimumCandidateAccuracy < 0 || policy.minimumCandidateAccuracy > 1) {
    throw new Error("minimumCandidateAccuracy must be between 0 and 1.");
  }
  if (policy.maximumCandidateErrorRate !== undefined &&
      (!Number.isFinite(policy.maximumCandidateErrorRate) || policy.maximumCandidateErrorRate < 0 || policy.maximumCandidateErrorRate > 1)) {
    throw new Error("maximumCandidateErrorRate must be between 0 and 1.");
  }
  if (policy.maximumAccuracyDrop !== undefined &&
      (!Number.isFinite(policy.maximumAccuracyDrop) || policy.maximumAccuracyDrop < 0 || policy.maximumAccuracyDrop > 1)) {
    throw new Error("maximumAccuracyDrop must be between 0 and 1.");
  }
  if (policy.minimumCostSavingsPercent !== undefined &&
      (!Number.isFinite(policy.minimumCostSavingsPercent) || policy.minimumCostSavingsPercent < 0)) {
    throw new Error("minimumCostSavingsPercent must be a non-negative number.");
  }

  const baselineCorrect = records.filter((record) =>
    !record.baselineError && matches(record.expected, record.baseline, policy.evaluator),
  ).length;
  const candidateCorrect = records.filter((record) =>
    !record.candidateError && matches(record.expected, record.candidate, policy.evaluator),
  ).length;
  const candidateErrors = records.filter((record) => record.candidateError).length;
  const baselineCostUsd = sumIfComplete(records, "baselineCostUsd");
  const candidateCostUsd = sumIfComplete(records, "candidateCostUsd");
  const costSavingsPercent = baselineCostUsd !== null && candidateCostUsd !== null && baselineCostUsd > 0
    ? ((baselineCostUsd - candidateCostUsd) / baselineCostUsd) * 100
    : null;
  const candidateErrorRate = candidateErrors / records.length;
  const candidateAccuracyLower95 = wilsonLowerBound(candidateCorrect, records.length);
  const baselineAccuracy = baselineCorrect / records.length;
  const candidateAccuracy = candidateCorrect / records.length;
  const accuracyDrop = baselineAccuracy - candidateAccuracy;
  const baselineIsCorrect = (record: ReplayRecord) =>
    !record.baselineError && matches(record.expected, record.baseline, policy.evaluator);
  const candidateIsCorrect = (record: ReplayRecord) =>
    !record.candidateError && matches(record.expected, record.candidate, policy.evaluator);
  const candidateFailureIds = records.filter((record) => !candidateIsCorrect(record)).map(({ id }) => id);
  const regressionIds = records
    .filter((record) => baselineIsCorrect(record) && !candidateIsCorrect(record))
    .map(({ id }) => id);
  const improvementIds = records
    .filter((record) => !baselineIsCorrect(record) && candidateIsCorrect(record))
    .map(({ id }) => id);

  const gates: ReplayGate[] = [
    {
      name: "minimum_samples",
      passed: records.length >= policy.minimumSamples,
      observed: records.length,
      required: policy.minimumSamples,
    },
    {
      name: "candidate_accuracy_lower_95",
      passed: candidateAccuracyLower95 >= policy.minimumCandidateAccuracy,
      observed: candidateAccuracyLower95,
      required: policy.minimumCandidateAccuracy,
    },
  ];

  if (policy.maximumAccuracyDrop !== undefined) {
    gates.push({
      name: "maximum_accuracy_drop",
      passed: accuracyDrop <= policy.maximumAccuracyDrop,
      observed: accuracyDrop,
      required: policy.maximumAccuracyDrop,
    });
  }

  if (policy.maximumCandidateErrorRate !== undefined) {
    gates.push({
      name: "maximum_candidate_error_rate",
      passed: candidateErrorRate <= policy.maximumCandidateErrorRate,
      observed: candidateErrorRate,
      required: policy.maximumCandidateErrorRate,
    });
  }

  if (policy.minimumCostSavingsPercent !== undefined) {
    gates.push({
      name: "minimum_cost_savings_percent",
      passed: costSavingsPercent !== null && costSavingsPercent >= policy.minimumCostSavingsPercent,
      observed: costSavingsPercent,
      required: policy.minimumCostSavingsPercent,
    });
  }

  return {
    sampleSize: records.length,
    baselineAccuracy,
    candidateAccuracy,
    accuracyDrop,
    candidateAccuracyLower95,
    candidateErrorRate,
    baselineCostUsd,
    candidateCostUsd,
    costSavingsPercent,
    candidateFailureIds,
    regressionIds,
    improvementIds,
    gates,
    eligibleForReview: gates.every((gate) => gate.passed),
  };
}
