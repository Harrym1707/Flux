import type { EvaluationInput, Evaluator, QualityPolicy, QualityResult } from "./types.js";
export declare function applyQualityPolicy(result: QualityResult, policy: QualityPolicy): QualityResult;
export declare class ExactMatchEvaluator implements Evaluator {
    name: string;
    evaluate(input: EvaluationInput): Promise<QualityResult>;
}
