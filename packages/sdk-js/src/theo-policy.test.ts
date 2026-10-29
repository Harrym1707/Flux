import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  policyToReductionConfig,
  withheldLevers,
  publishLever,
  type TheoPolicy,
  type TheoLever,
} from "./theo-policy.js";

const AT = "2026-10-29T00:00:00.000Z";

describe("Theo policy", () => {
  it("a new user's default policy is STRICT and lossless-only", () => {
    const p = defaultPolicy("u1", AT);
    expect(p.qualityCeilingPercent).toBe(2);
    expect(p.levers.every((l) => l.class === "lossless")).toBe(true);
    const config = policyToReductionConfig(p);
    expect(config.toolSchemas).toBe(true);
    expect(config.duplicateContext).toBe(true);
    expect(config.repairCachePrefix).toBe(true);
    expect(config.outputEffort).toBeUndefined();
  });

  it("applies lossless levers unconditionally", () => {
    const p: TheoPolicy = { ...defaultPolicy("u", AT), levers: [{ lever: "cache-prefix-repair", class: "lossless" }] };
    expect(policyToReductionConfig(p).repairCachePrefix).toBe(true);
  });

  it("WITHHOLDS a lossy lever that carries no gate proof", () => {
    const p: TheoPolicy = { ...defaultPolicy("u", AT), levers: [{ lever: "output-effort-low", class: "lossy" }] };
    expect(policyToReductionConfig(p).outputEffort).toBeUndefined();
    expect(withheldLevers(p)[0]?.reason).toContain("no gate proof");
  });

  it("WITHHOLDS a lossy lever whose measured quality drop exceeds the route ceiling", () => {
    const lever: TheoLever = {
      lever: "output-effort-low", class: "lossy",
      gate: { savingPercent: 12, qualityDeltaPercent: -5, grader: "task-completion", provenAt: AT },
    };
    const p: TheoPolicy = { ...defaultPolicy("u", AT), qualityCeilingPercent: 2, levers: [lever] };
    expect(policyToReductionConfig(p).outputEffort).toBeUndefined();
    expect(withheldLevers(p)[0]?.reason).toContain("exceeds the 2% ceiling");
  });

  it("APPLIES a lossy lever proven within the ceiling", () => {
    const lever: TheoLever = {
      lever: "output-effort-low", class: "lossy",
      gate: { savingPercent: 5, qualityDeltaPercent: -0.3, grader: "task-completion", provenAt: AT },
    };
    const p: TheoPolicy = { ...defaultPolicy("u", AT), qualityCeilingPercent: 2, levers: [lever] };
    expect(policyToReductionConfig(p).outputEffort).toBe("low");
    expect(withheldLevers(p)).toHaveLength(0);
  });

  it("maps params for parameterised levers", () => {
    const p: TheoPolicy = {
      ...defaultPolicy("u", AT),
      levers: [
        { lever: "cache-ttl-5m", class: "lossless" },
        { lever: "fresh-tool-result-cap", class: "lossy", params: { maximumTokens: 600 },
          gate: { savingPercent: 4, qualityDeltaPercent: -0.5, grader: "tests", provenAt: AT } },
      ],
    };
    const config = policyToReductionConfig(p);
    expect(config.cacheTtl).toBe("5m");
    expect(config.freshToolResultCap).toEqual({ maximumTokens: 600 });
  });

  it("publishLever bumps the version, refuses lossy without proof, and never mutates the input", () => {
    const p = defaultPolicy("u", AT);
    const next = publishLever(p, { lever: "cache-ttl-5m", class: "lossless" }, "2026-10-29T01:00:00.000Z");
    expect(next.version).toBe(p.version + 1);
    expect(p.levers.some((l) => l.lever === "cache-ttl-5m")).toBe(false); // input untouched
    expect(next.levers.some((l) => l.lever === "cache-ttl-5m")).toBe(true);
    expect(() => publishLever(p, { lever: "output-effort-low", class: "lossy" }, AT)).toThrow(/without a gate proof/);
  });
});
