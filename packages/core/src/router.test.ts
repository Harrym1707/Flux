import { describe, expect, it } from "vitest";
import { SafeRouter } from "./router.js";
import type { RoutingPolicy } from "./types.js";

describe("SafeRouter", () => {
  const policy: RoutingPolicy = {
    id: "pol_123",
    version: 1,
    taskClass: "classification",
    baseline: { provider: "openai", model: "baseline" },
    enabled: true,
    candidates: [{
      target: { provider: "openai", model: "cheap" },
      estimatedCostMultiplier: 0.2,
      rolloutPercentage: 1,
      qualityPolicy: { minimumScore: 0.99 },
    }],
  };

  it("routes to a proven candidate when rollout selects it", () => {
    const result = new SafeRouter().decide(policy, {
      taskClass: "classification",
      random: () => 0.1,
    });

    expect(result.isBaseline).toBe(false);
    expect(result.target.model).toBe("cheap");
  });

  it("falls back to baseline when rollout does not select it", () => {
    const belowFullRolloutPolicy: RoutingPolicy = {
      ...policy,
      candidates: policy.candidates.map((candidate) => ({ ...candidate, rolloutPercentage: 0.5 })),
    };
    const result = new SafeRouter().decide(belowFullRolloutPolicy, {
      taskClass: "classification",
      random: () => 0.99,
    });

    expect(result.isBaseline).toBe(true);
    expect(result.target.model).toBe("baseline");
  });
});
