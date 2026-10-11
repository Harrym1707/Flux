import { describe, expect, it } from "vitest";
import { parseHeliconeRequests } from "./helicone.js";
import { parseLangfuseGenerations } from "./langfuse.js";

const AT = "2026-10-08";

describe("parseHeliconeRequests", () => {
  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      request_id: "h1",
      request_created_at: `${AT}T09:00:00Z`,
      model: "gpt-5",
      provider: "OPENAI",
      prompt_tokens: 1_000,
      completion_tokens: 100,
      cost: 0.00225,
      ...overrides,
    };
  }

  it("maps provider cache columns onto the record, summing to total input", () => {
    const parsed = parseHeliconeRequests([row({
      prompt_tokens: 1_500,
      prompt_cache_read_tokens: 4_500,
      prompt_cache_write_tokens: 500,
    })], AT);
    const record = parsed.accepted[0]!.record;
    // Helicone logs fresh tokens in prompt_tokens, like Anthropic's usage block.
    expect(record.inputTokens).toBe(6_500);
    expect(record.cachedInputTokens).toBe(4_500);
    expect(record.cacheWriteInputTokens).toBe(500);
  });

  it("keeps rows served by Helicone's own cache out of the baseline", () => {
    const parsed = parseHeliconeRequests([
      row(),
      row({ request_id: "h2", properties: { "helicone-cache": "HIT" } }),
      row({ request_id: "h3", cache_hit: true }),
    ], AT);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.cacheHits).toHaveLength(2);
  });

  it("reads session, user and workload from the properties map, case-insensitively", () => {
    const parsed = parseHeliconeRequests([row({
      request_user_id: "user-9",
      properties: { "HELICONE-SESSION-ID": "sess-9", Workload: "mobile-app" },
    })], AT);
    const entry = parsed.accepted[0]!;
    expect(entry.record.episodeId).toBe("sess-9");
    expect(entry.record.workload).toBe("mobile-app");
    expect(entry.endUser).toBe("user-9");
  });

  it("extracts prompt text and tool schemas from an included request body", () => {
    const parsed = parseHeliconeRequests([row({
      request_body: {
        messages: [{ role: "system", content: "template" }, { role: "user", content: "question" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    })], AT);
    const record = parsed.accepted[0]!.record;
    expect(record.promptText).toContain("template");
    expect(record.toolSchemaText).toContain("lookup");
  });

  it("reports unreadable rows", () => {
    const parsed = parseHeliconeRequests([42, row({ prompt_tokens: undefined })], AT);
    expect(parsed.accepted).toHaveLength(0);
    expect(parsed.issues).toHaveLength(2);
  });
});

describe("parseLangfuseGenerations", () => {
  function generation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "g1",
      type: "GENERATION",
      traceId: "trace-1",
      startTime: `${AT}T09:00:00Z`,
      model: "gpt-5",
      usageDetails: { input: 2_000, output: 150 },
      calculatedTotalCost: 0.004,
      ...overrides,
    };
  }

  it("maps a generation onto a record with session, user and workload", () => {
    const parsed = parseLangfuseGenerations([generation({
      sessionId: "session-3",
      userId: "customer-7",
      traceName: "checkout-agent",
    })], AT);
    const entry = parsed.accepted[0]!;
    expect(entry.record).toMatchObject({
      inputTokens: 2_000, outputTokens: 150, episodeId: "session-3", workload: "checkout-agent",
    });
    expect(entry.endUser).toBe("customer-7");
    expect(entry.reportedSpendUsd).toBe(0.004);
  });

  it("skips spans and events silently rather than reporting them as errors", () => {
    const parsed = parseLangfuseGenerations([
      { id: "s1", type: "SPAN", traceId: "t" },
      { id: "e1", type: "EVENT" },
      generation(),
    ], AT);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.issues).toHaveLength(0);
  });

  it("reads every generation of Langfuse's usage field naming", () => {
    for (const shape of [
      { usageDetails: { input: 900, output: 80 } },
      { usage: { input: 900, output: 80 }, usageDetails: undefined },
      { usage: { promptTokens: 900, completionTokens: 80 }, usageDetails: undefined },
      { promptTokens: 900, completionTokens: 80, usageDetails: undefined },
    ]) {
      const parsed = parseLangfuseGenerations([generation(shape)], AT);
      expect(parsed.accepted[0]!.record.inputTokens).toBe(900);
      expect(parsed.accepted[0]!.record.outputTokens).toBe(80);
    }
  });

  it("picks up provider cache usage from usageDetails", () => {
    const parsed = parseLangfuseGenerations([generation({
      usageDetails: { input: 5_000, output: 200, cache_read_input_tokens: 3_000 },
    })], AT);
    expect(parsed.accepted[0]!.record.cachedInputTokens).toBe(3_000);
  });

  it("falls back from sessionId to traceId for the episode", () => {
    const parsed = parseLangfuseGenerations([generation()], AT);
    expect(parsed.accepted[0]!.record.episodeId).toBe("trace-1");
  });

  it("never returns tool cache hits, because a tracer has no cache", () => {
    const parsed = parseLangfuseGenerations([generation()], AT);
    expect(parsed.cacheHits).toHaveLength(0);
  });

  it("reports a generation with no readable usage", () => {
    const parsed = parseLangfuseGenerations([generation({ usageDetails: {} })], AT);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]!.reason).toMatch(/token usage/);
  });
});
