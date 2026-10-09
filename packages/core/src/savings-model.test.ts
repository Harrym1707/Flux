import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import {
  PUBLISHED_LEVERS,
  WORKLOAD_ARCHETYPES,
  leversFor,
  projectSavings,
  type Lever,
  type WorkloadProfile,
} from "./savings-model.js";

const plainPrice: TokenPrice = { inputPerMillion: 1, outputPerMillion: 10 };
const cachingPrice: TokenPrice = { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 10 };
const writePremiumPrice: TokenPrice = {
  inputPerMillion: 1,
  cachedInputPerMillion: 0.1,
  cacheWriteInputPerMillion: 1.25,
  outputPerMillion: 10,
};

function profile(overrides: Partial<WorkloadProfile> = {}): WorkloadProfile {
  return {
    name: "fixture",
    requests: 2,
    segments: {
      toolSchemas: 1_000_000,
      systemPrompt: 0,
      retrievedContext: 0,
      history: 0,
      userTurn: 0,
      output: 0,
    },
    stableSegments: [],
    ...overrides,
  };
}

const halveTools: Lever = {
  id: "halve-tools",
  description: "test lever",
  risk: "deterministic",
  targets: ["toolSchemas"],
  reduction: 0.5,
  evidence: { source: "test", claim: "test" },
};

describe("projectSavings", () => {
  it("prices the baseline from segment tokens and request count", () => {
    const result = projectSavings(profile(), [], plainPrice);
    // 2 requests x 1M input tokens at $1/M.
    expect(result.baselineCostUsd).toBeCloseTo(2, 10);
    expect(result.savingPercent).toBe(0);
  });

  it("applies a lever only to the segments it targets", () => {
    const result = projectSavings(
      profile({ segments: { ...profile().segments, systemPrompt: 1_000_000 } }),
      [halveTools],
      plainPrice,
    );
    // Only the tool segment halves, so 2M becomes 1.5M per request pair.
    expect(result.inputTokensAfter).toBeCloseTo(3_000_000, 6);
    expect(result.savingPercent).toBeCloseTo(25, 6);
  });

  it("charges the cache rate on what remains after reduction, not the original size", () => {
    const withCaching = profile({ stableSegments: ["toolSchemas"] });
    const reducedThenCached = projectSavings(withCaching, [halveTools], cachingPrice);
    const cachedOnly = projectSavings(withCaching, [], cachingPrice);
    expect(reducedThenCached.cachedInputTokens).toBeCloseTo(1_000_000, 6);
    expect(cachedOnly.cachedInputTokens).toBeCloseTo(2_000_000, 6);
    expect(reducedThenCached.projectedCostUsd).toBeLessThan(cachedOnly.projectedCostUsd);
  });

  it("bills one cache write and the rest as reads", () => {
    const result = projectSavings(profile({ stableSegments: ["toolSchemas"] }), [], cachingPrice);
    // First request pays $1.00 at full rate, the second $0.10 cached.
    expect(result.projectedCostUsd).toBeCloseTo(1.1, 10);
    expect(result.savingPercent).toBeCloseTo(45, 6);
  });

  it("applies a provider's cache-write premium where one exists", () => {
    const plain = projectSavings(profile({ stableSegments: ["toolSchemas"] }), [], cachingPrice);
    const premium = projectSavings(profile({ stableSegments: ["toolSchemas"] }), [], writePremiumPrice);
    // 1.25 write + 0.10 read against 1.00 write + 0.10 read.
    expect(premium.projectedCostUsd).toBeCloseTo(1.35, 10);
    expect(premium.projectedCostUsd).toBeGreaterThan(plain.projectedCostUsd);
  });

  it("projects no caching saving for a single request", () => {
    const result = projectSavings(
      profile({ requests: 1, stableSegments: ["toolSchemas"] }),
      [],
      cachingPrice,
    );
    expect(result.cachedInputTokens).toBe(0);
    expect(result.warnings.some((warning) => /single request/.test(warning))).toBe(true);
  });

  it("projects no caching saving below the provider's cacheable minimum", () => {
    const result = projectSavings(
      profile({
        segments: { ...profile().segments, toolSchemas: 500 },
        stableSegments: ["toolSchemas"],
      }),
      [],
      cachingPrice,
    );
    expect(result.cachedInputTokens).toBe(0);
    expect(result.warnings.some((warning) => /cacheable minimum/.test(warning))).toBe(true);
  });

  it("projects no caching saving when the price has no cached rate", () => {
    const result = projectSavings(profile({ stableSegments: ["toolSchemas"] }), [], plainPrice);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.warnings.some((warning) => /no cached-input rate/.test(warning))).toBe(true);
  });

  it("ignores output listed as a stable segment and says so", () => {
    const result = projectSavings(
      profile({ stableSegments: ["toolSchemas", "output"] }),
      [],
      cachingPrice,
    );
    expect(result.warnings.some((warning) => /cannot be part of a cached prefix/.test(warning))).toBe(true);
  });

  it("splits the saving into what is free and what needs verifying", () => {
    const risky: Lever = { ...halveTools, id: "risky", risk: "needs-verification" };
    const result = projectSavings(
      profile({ segments: { ...profile().segments, output: 1_000_000 } }),
      [halveTools, { ...risky, targets: ["output"] }],
      plainPrice,
    );
    expect(result.deterministicSavingPercent).toBeGreaterThan(0);
    expect(result.needsVerificationSavingPercent).toBeGreaterThan(0);
    expect(result.deterministicSavingPercent + result.needsVerificationSavingPercent)
      .toBeCloseTo(result.savingPercent, 6);
  });

  it("attributes every contribution to published evidence", () => {
    const agent = WORKLOAD_ARCHETYPES.toolHeavyAgent!;
    const result = projectSavings(agent, leversFor(agent), cachingPrice);
    expect(result.contributions.length).toBeGreaterThan(0);
    for (const contribution of result.contributions) {
      expect(contribution.evidence.source.length).toBeGreaterThan(0);
      expect(contribution.evidence.claim.length).toBeGreaterThan(0);
    }
  });

  it("rejects an invalid profile or lever", () => {
    expect(() => projectSavings(profile({ requests: 0 }), [], plainPrice)).toThrow(/at least one request/);
    expect(() => projectSavings(
      profile({ segments: { ...profile().segments, history: -1 } }),
      [],
      plainPrice,
    )).toThrow(/non-negative token count/);
    expect(() => projectSavings(profile(), [{ ...halveTools, reduction: 1.5 }], plainPrice))
      .toThrow(/between 0 and 1/);
  });
});

describe("workload archetypes", () => {
  it("gives a tool-heavy agent the most headroom, most of it risk-free", () => {
    const agent = WORKLOAD_ARCHETYPES.toolHeavyAgent!;
    const result = projectSavings(agent, leversFor(agent), cachingPrice);
    expect(result.savingPercent).toBeGreaterThan(70);
    // The free half alone must clear what routing vendors claim in total.
    expect(result.deterministicSavingPercent).toBeGreaterThan(40);
  });

  it("offers a one-shot varied workload nothing for free", () => {
    const oneShot = WORKLOAD_ARCHETYPES.oneShotVaried!;
    const result = projectSavings(oneShot, leversFor(oneShot), cachingPrice);
    // Nothing is shared, so no prefix caches and no tool catalogue is resent.
    expect(result.deterministicSavingPercent).toBe(0);
    expect(result.savingPercent).toBeLessThan(result.needsVerificationSavingPercent + 1);
  });

  it("puts a reasoning workload's headroom in the output budget", () => {
    const reasoning = WORKLOAD_ARCHETYPES.reasoningHeavy!;
    const result = projectSavings(reasoning, leversFor(reasoning), cachingPrice);
    const outputLever = result.contributions.find((contribution) => contribution.lever === "output-budget")!;
    const biggest = [...result.contributions].sort((left, right) => right.sharePercent - left.sharePercent)[0]!;
    expect(biggest.lever).toBe(outputLever.lever);
  });

  it("selects only levers that can reach a profile's non-empty segments", () => {
    const rag = WORKLOAD_ARCHETYPES.ragDocumentQa!;
    const ids = leversFor(rag).map((lever) => lever.id);
    // No tools in a pure RAG prompt, so no tool levers.
    expect(ids).not.toContain(PUBLISHED_LEVERS.toolSchemaMinification!.id);
    expect(ids).toContain(PUBLISHED_LEVERS.retrievedContextPruning!.id);
  });
});
