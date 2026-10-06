import type {
  RoutingDecision,
  RoutingPolicy,
} from "./types.js";

export type RouterContext = {
  taskClass?: string;
  requestHash?: string;
  random?: () => number;
};

export class SafeRouter {
  decide(policy: RoutingPolicy | undefined, ctx: RouterContext): RoutingDecision {
    if (!policy || !policy.enabled) {
      return {
        target: { provider: "baseline", model: "baseline" },
        reason: "no_active_policy",
        isBaseline: true,
      };
    }

    if (ctx.taskClass !== policy.taskClass) {
      return {
        target: policy.baseline,
        reason: "task_class_mismatch",
        policyId: policy.id,
        policyVersion: policy.version,
        isBaseline: true,
      };
    }

    const random = ctx.random ?? Math.random;
    const candidate = policy.candidates.find((c) => {
      if (c.rolloutPercentage <= 0) return false;
      return random() < c.rolloutPercentage;
    });

    if (!candidate) {
      return {
        target: policy.baseline,
        reason: "rollout_not_selected",
        policyId: policy.id,
        policyVersion: policy.version,
        isBaseline: true,
      };
    }

    return {
      target: candidate.target,
      reason: "proven_candidate_policy",
      policyId: policy.id,
      policyVersion: policy.version,
      isBaseline: false,
    };
  }
}
