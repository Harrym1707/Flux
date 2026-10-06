import { createHash } from "node:crypto";
import type { FluxRequestContext, FluxRoutingConfig, FluxRoutingPolicy } from "./types.js";

export type FluxRoute = {
  model: string;
  requestedModel: string;
  policyId?: string;
  reason: "no_matching_policy" | "missing_stable_key" | "baseline" | "candidate_quality_and_cost_gates_passed";
  estimatedCostSavingsPercent?: number;
  maxOutputTokens?: number;
  contextProfileId?: string;
};

function bucket(key: string): number {
  const firstWord = createHash("sha256").update(key).digest().readUInt32BE(0);
  return firstWord / 0x1_0000_0000;
}

function validPolicy(policy: FluxRoutingPolicy): boolean {
  if (!policy.id || !policy.taskClass || !policy.baselineModel) return false;
  if (policy.workflow !== undefined && typeof policy.workflow !== "string") return false;
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples < 1) return false;
  if (!Number.isFinite(policy.minimumCandidateAccuracyLower95) || policy.minimumCandidateAccuracyLower95 < 0 || policy.minimumCandidateAccuracyLower95 > 1) return false;
  if (!Number.isFinite(policy.maximumAccuracyDrop) || policy.maximumAccuracyDrop < 0 || policy.maximumAccuracyDrop > 1) return false;
  if (policy.difficulty !== undefined && !["low", "medium", "high"].includes(policy.difficulty)) return false;
  if (policy.riskLevel !== undefined && !["low", "medium", "high"].includes(policy.riskLevel)) return false;
  if (!Array.isArray(policy.candidates) || policy.candidates.some((candidate) =>
    typeof candidate !== "object" || candidate === null
  )) return false;
  const shares = policy.candidates.reduce((total, candidate) => total + candidate.trafficShare, 0);
  if (shares > 1 || policy.candidates.some((candidate) =>
    !candidate.model ||
    (candidate.model === policy.baselineModel && candidate.maxOutputTokens === undefined && !candidate.contextProfileId) ||
    !Number.isFinite(candidate.trafficShare) || candidate.trafficShare < 0 || candidate.trafficShare > 1 ||
    (candidate.maxOutputTokens !== undefined &&
      (!Number.isInteger(candidate.maxOutputTokens) || candidate.maxOutputTokens < 1)) ||
    (candidate.contextProfileId !== undefined && (typeof candidate.contextProfileId !== "string" || candidate.contextProfileId.trim() === ""))
  )) return false;
  return true;
}

export function chooseRoute(
  config: FluxRoutingConfig | undefined,
  request: Record<PropertyKey, any>,
  taskClass: string | undefined,
  context: FluxRequestContext = {},
): FluxRoute {
  const requestedModel = typeof request.model === "string" ? request.model : "unknown";
  const policy = Array.isArray(config?.policies)
    ? config.policies.find((candidate) => candidate &&
      candidate.taskClass === taskClass && candidate.baselineModel === requestedModel &&
      (candidate.workflow === undefined || candidate.workflow === context.workflow) &&
      (candidate.difficulty === undefined || candidate.difficulty === context.difficulty) &&
      (candidate.riskLevel === undefined || candidate.riskLevel === context.riskLevel))
    : undefined;
  const baseline = (reason: FluxRoute["reason"], policyId?: string): FluxRoute => ({
    model: requestedModel,
    requestedModel,
    policyId,
    reason,
  });
  if (!policy || !validPolicy(policy)) return baseline("no_matching_policy");

  let requestKey: string | undefined;
  try {
    requestKey = config?.getRequestKey(request);
  } catch {
    requestKey = undefined;
  }
  if (typeof requestKey !== "string" || requestKey.trim() === "") return baseline("missing_stable_key", policy.id);

  const position = bucket(`${policy.id}:${requestKey}`);
  // Spend priority comes from measured replay cost, not array order. Assign the
  // cheapest eligible candidate to the first stable cohort interval.
  const candidatesByCost = [...policy.candidates].sort((left, right) => {
    const leftCost = (left.evidence?.candidateCostUsd ?? Number.POSITIVE_INFINITY) /
      Math.max(left.evidence?.sampleSize ?? 1, 1);
    const rightCost = (right.evidence?.candidateCostUsd ?? Number.POSITIVE_INFINITY) /
      Math.max(right.evidence?.sampleSize ?? 1, 1);
    return leftCost - rightCost;
  });
  let intervalStart = 0;
  for (const candidate of candidatesByCost) {
    const intervalEnd = intervalStart + candidate.trafficShare;
    const selected = position >= intervalStart && position < intervalEnd;
    intervalStart = intervalEnd;
    if (!selected) continue;

    const evidence = candidate.evidence;
    const evidenceMatches = evidence?.baselineModel === policy.baselineModel &&
      evidence.candidateModel === candidate.model &&
      evidence.eligibleForReview === true &&
      Number.isInteger(evidence.sampleSize) && evidence.sampleSize >= policy.minimumSamples &&
      Number.isFinite(evidence.candidateAccuracyLower95) && evidence.candidateAccuracyLower95 >= policy.minimumCandidateAccuracyLower95 &&
      Number.isFinite(evidence.accuracyDrop) && evidence.accuracyDrop <= policy.maximumAccuracyDrop &&
      Number.isFinite(evidence.baselineCostUsd) && evidence.baselineCostUsd > 0 &&
      Number.isFinite(evidence.candidateCostUsd) && evidence.candidateCostUsd >= 0 &&
      evidence.candidateCostUsd < evidence.baselineCostUsd;
    if (candidate.approved !== true || !evidenceMatches) return baseline("baseline", policy.id);

    return {
      model: candidate.model,
      requestedModel,
      policyId: policy.id,
      reason: "candidate_quality_and_cost_gates_passed",
      estimatedCostSavingsPercent: (1 - evidence.candidateCostUsd / evidence.baselineCostUsd) * 100,
      maxOutputTokens: candidate.maxOutputTokens,
      contextProfileId: candidate.contextProfileId,
    };
  }
  return baseline("baseline", policy.id);
}
