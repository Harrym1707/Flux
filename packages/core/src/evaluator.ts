import type {
  EvaluationInput,
  Evaluator,
  QualityPolicy,
  QualityResult,
} from "./types.js";

export function applyQualityPolicy(
  result: QualityResult,
  policy: QualityPolicy,
): QualityResult {
  const required = policy.requiredChecks ?? [];

  const requiredChecksPassed = required.every(
    (check) => result.checks[check] === true,
  );

  const scorePassed =
    policy.minimumScore === undefined ||
    (result.score !== undefined && result.score >= policy.minimumScore);

  return {
    ...result,
    passed: result.passed && requiredChecksPassed && scorePassed,
    reason: result.passed && requiredChecksPassed && scorePassed
      ? result.reason
      : "quality_policy_failed",
  };
}

export class ExactMatchEvaluator implements Evaluator {
  name = "exact_match";

  async evaluate(input: EvaluationInput): Promise<QualityResult> {
    const passed =
      JSON.stringify(input.baseline) === JSON.stringify(input.candidate);

    return {
      passed,
      score: passed ? 1 : 0,
      checks: { exact_match: passed },
      reason: passed ? "exact_match" : "candidate_differs",
    };
  }
}
