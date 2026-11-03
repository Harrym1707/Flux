import { describe, expect, it } from "vitest";
import { publishedModelPrices } from "./model-prices.js";
import {
  cloudCostAvoidedUsd,
  decideRoute,
  defaultLocalTierPolicy,
  type LocalTierRequest,
} from "./local-tier.js";

const AT = "2026-11-03";
const policy = defaultLocalTierPolicy({
  enabled: true,
  baselineModels: ["claude-sonnet-5-5", "gpt-5"],
  maxInputTokens: 4000,
  localModel: "bonsai",
});

const req = (over: Partial<LocalTierRequest> = {}): LocalTierRequest => ({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  inputTokens: 800,
  hasTools: false,
  ...over,
});

describe("decideRoute (local-tier triage)", () => {
  it("routes a small, tool-free request on an eligible baseline to the local model", () => {
    const d = decideRoute(req(), policy);
    expect(d.route).toBe("local");
    if (d.route === "local") {
      expect(d.model).toBe("bonsai");
      expect(d.baseline).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    }
  });

  it("never routes when the policy is disabled", () => {
    expect(decideRoute(req(), { ...policy, enabled: false }).route).toBe("cloud");
  });

  it("keeps tool-use requests on the cloud model by default", () => {
    expect(decideRoute(req({ hasTools: true }), policy).route).toBe("cloud");
    expect(decideRoute(req({ hasTools: true }), { ...policy, allowTools: true }).route).toBe("local");
  });

  it("keeps large-context requests on the cloud model", () => {
    expect(decideRoute(req({ inputTokens: 40_000 }), policy).route).toBe("cloud");
  });

  it("only stands in for eligible baseline models", () => {
    expect(decideRoute(req({ model: "claude-haiku-5-5" }), policy).route).toBe("cloud");
  });
});

describe("cloudCostAvoidedUsd (the saving from running locally)", () => {
  it("values the avoided cost at the baseline cloud model's catalogue price", () => {
    // Sonnet 5.5: $2/Mtok in, $10/Mtok out. 1000 in + 500 out = 0.002 + 0.005 = $0.007.
    const saved = cloudCostAvoidedUsd(
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { inputTokens: 1000, outputTokens: 500 },
      publishedModelPrices,
      AT,
    );
    expect(saved).toBeCloseTo(0.007, 6);
  });

  it("values a DeepSeek baseline too (newly priced)", () => {
    // deepseek-v4-pro off-peak: $0.66/Mtok in, $1.98/Mtok out. 1000 in + 1000 out.
    const saved = cloudCostAvoidedUsd(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { inputTokens: 1000, outputTokens: 1000 },
      publishedModelPrices,
      AT,
    );
    expect(saved).toBeCloseTo(0.00066 + 0.00198, 6);
  });

  it("returns null for an unpriced baseline rather than guessing", () => {
    const saved = cloudCostAvoidedUsd(
      { provider: "xai", model: "grok-4" },
      { inputTokens: 1000, outputTokens: 1000 },
      publishedModelPrices,
      AT,
    );
    expect(saved).toBeNull();
  });
});
