import { describe, expect, it } from "vitest";
import { planFanoutPrewarm } from "./fanout-prewarm.js";

const BIG_PREFIX = "Follow house review rules carefully and cite every file and line you reference. ".repeat(80);

function teamRequest(role: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    system: BIG_PREFIX,
    tools: [{ type: "function", function: { name: "read_file" } }],
    messages: [{ role: "user", content: `You are the ${role} reviewer.` }],
    ...overrides,
  };
}

describe("planFanoutPrewarm", () => {
  it("returns no prewarm and the batch unchanged for a single request", () => {
    const requests = [teamRequest("security")];
    const plan = planFanoutPrewarm(requests);
    expect(plan.prewarm).toBeNull();
    expect(plan.dispatch).toBe(requests);
    expect(plan.reason).toMatch(/too small/);
  });

  it("plans a prewarm for a fan-out that shares an identical system+tools prefix", () => {
    const requests = [teamRequest("security"), teamRequest("performance"), teamRequest("correctness")];
    const plan = planFanoutPrewarm(requests);
    expect(plan.prewarm).not.toBeNull();
    expect(plan.dispatch).toBe(requests);
    expect(plan.prewarm!.system).toBe(BIG_PREFIX);
    expect(plan.prewarm!.tools).toEqual(requests[0]!.tools);
    // The prewarm's own instruction is trivial and capped, never the real task.
    expect(plan.prewarm!.messages).toEqual([{ role: "user", content: "Acknowledge receipt of context." }]);
    expect(plan.prewarm!.max_output_tokens).toBeLessThanOrEqual(10);
  });

  it("never mutates a single byte of the original requests", () => {
    const requests = [teamRequest("security"), teamRequest("performance")];
    const before = JSON.stringify(requests);
    planFanoutPrewarm(requests);
    expect(JSON.stringify(requests)).toBe(before);
  });

  it("declines to prewarm when the batch does not share one prefix", () => {
    const requests = [teamRequest("security", { system: "different rules entirely" }), teamRequest("performance")];
    const plan = planFanoutPrewarm(requests);
    expect(plan.prewarm).toBeNull();
    expect(plan.reason).toMatch(/do not share/);
    expect(plan.dispatch).toBe(requests);
  });

  it("declines to prewarm a shared prefix too small for either provider to cache", () => {
    const requests = [
      teamRequest("security", { system: "short shared prefix" }),
      teamRequest("performance", { system: "short shared prefix" }),
    ];
    const plan = planFanoutPrewarm(requests);
    expect(plan.prewarm).toBeNull();
    expect(plan.reason).toMatch(/below the .* minimum/);
  });

  it("respects an explicit minimumSharedPrefixTokens override", () => {
    const requests = [teamRequest("security"), teamRequest("performance")];
    const plan = planFanoutPrewarm(requests, { minimumSharedPrefixTokens: 1_000_000 });
    expect(plan.prewarm).toBeNull();
    expect(plan.reason).toMatch(/below the 1000000-token minimum/);
  });

  it("mirrors the OpenAI `input` shape instead of Anthropic `messages` when that is what the batch uses", () => {
    const requests = [
      { model: "gpt-5", instructions: BIG_PREFIX, tools: [], input: [{ role: "user", content: "security" }] },
      { model: "gpt-5", instructions: BIG_PREFIX, tools: [], input: [{ role: "user", content: "performance" }] },
    ];
    const plan = planFanoutPrewarm(requests);
    expect(plan.prewarm).not.toBeNull();
    expect(plan.prewarm!.input).toEqual([{ role: "user", content: "Acknowledge receipt of context." }]);
    expect(plan.prewarm!.messages).toBeUndefined();
  });

  it("respects a custom minimumBatchSize", () => {
    const requests = [teamRequest("security"), teamRequest("performance")];
    const plan = planFanoutPrewarm(requests, { minimumBatchSize: 3 });
    expect(plan.prewarm).toBeNull();
    expect(plan.reason).toMatch(/too small/);
  });
});
