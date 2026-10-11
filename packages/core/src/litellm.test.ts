import { describe, expect, it } from "vitest";
import { publishedModelPrices } from "./model-prices.js";
import { parseLiteLLMSpendLogs, reconcileLiteLLMSpend, signalsFromLiteLLM } from "./litellm.js";
import { measureTraffic } from "./traffic.js";
import { classifySegment, quoteForSegment } from "./triage.js";

const AT = "2026-10-08";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "r1",
    model: "gpt-5",
    custom_llm_provider: "openai",
    startTime: `${AT}T09:00:00Z`,
    prompt_tokens: 4_000,
    completion_tokens: 300,
    spend: (4_000 / 1e6) * 1.25 + (300 / 1e6) * 10,
    cache_hit: "False",
    request_tags: ["stream-a"],
    ...overrides,
  };
}

describe("parseLiteLLMSpendLogs", () => {
  it("maps the spend-log schema onto a traffic record", () => {
    const parsed = parseLiteLLMSpendLogs([row({ end_user: "eu-1", team_id: "t-1" })], AT);
    expect(parsed.issues).toHaveLength(0);
    const entry = parsed.accepted[0]!;
    expect(entry.record).toMatchObject({
      id: "r1", model: "gpt-5", provider: "openai", at: AT,
      inputTokens: 4_000, outputTokens: 300, workload: "stream-a",
    });
    expect(entry.endUser).toBe("eu-1");
    expect(entry.teamId).toBe("t-1");
    expect(entry.reportedSpendUsd).toBeCloseTo(0.008, 6);
  });

  it("keeps gateway cache hits out of the baseline, including the string form", () => {
    const parsed = parseLiteLLMSpendLogs([
      row(),
      row({ request_id: "r2", cache_hit: "True", spend: 0 }),
      row({ request_id: "r3", cache_hit: true, spend: 0 }),
    ], AT);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.cacheHits).toHaveLength(2);
  });

  it("finds the session id wherever LiteLLM puts it", () => {
    for (const shape of [
      { litellm_session_id: "s-1" },
      { session_id: "s-1" },
      { metadata: { litellm_session_id: "s-1" } },
      { trace_id: "s-1" },
    ]) {
      const parsed = parseLiteLLMSpendLogs([row(shape)], AT);
      expect(parsed.accepted[0]!.record.episodeId).toBe("s-1");
    }
  });

  it("reads stored prompts when the proxy logs them, and survives their absence", () => {
    const withText = parseLiteLLMSpendLogs([row({
      messages: [{ role: "system", content: "template" }, { role: "user", content: "question" }],
    })], AT);
    expect(withText.accepted[0]!.record.promptText).toContain("template");
    const without = parseLiteLLMSpendLogs([row()], AT);
    expect(without.accepted[0]!.record.promptText).toBeUndefined();
  });

  it("accepts response_cost as the StandardLoggingPayload spelling of spend", () => {
    const parsed = parseLiteLLMSpendLogs([row({ spend: undefined, response_cost: 0.01 })], AT);
    expect(parsed.accepted[0]!.reportedSpendUsd).toBe(0.01);
  });

  it("reports unreadable rows instead of dropping them", () => {
    const parsed = parseLiteLLMSpendLogs(["nope", row({ model: undefined, model_group: undefined })], AT);
    expect(parsed.accepted).toHaveLength(0);
    expect(parsed.issues).toHaveLength(2);
  });
});

describe("reconcileLiteLLMSpend", () => {
  it("flags spend that drifts from published rates and passes spend that matches", () => {
    const catalogueCost = (4_000 / 1e6) * 1.25 + (300 / 1e6) * 10;
    const parsed = parseLiteLLMSpendLogs([
      row(),
      row({ request_id: "drift", spend: catalogueCost * 1.5 }),
    ], AT);
    const result = reconcileLiteLLMSpend(parsed, publishedModelPrices);
    expect(result.comparedRows).toBe(2);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]!.id).toBe("drift");
    expect(result.flagged[0]!.driftPercent).toBeCloseTo(50, 0);
  });

  it("values gateway cache hits as the customer's existing saving", () => {
    const parsed = parseLiteLLMSpendLogs([row({ cache_hit: "True", spend: 0 })], AT);
    const result = reconcileLiteLLMSpend(parsed, publishedModelPrices);
    expect(result.cacheHitRows).toBe(1);
    expect(result.cacheHitSavedUsd).toBeGreaterThan(0);
  });

  it("excludes unpriced models from the comparison rather than zeroing them", () => {
    const parsed = parseLiteLLMSpendLogs([row({ model: "mystery-finetune" })], AT);
    const result = reconcileLiteLLMSpend(parsed, publishedModelPrices);
    expect(result.comparedRows).toBe(0);
    expect(result.unpricedRows).toBe(1);
  });
});

describe("triage end to end", () => {
  it("classifies a wide shallow end-user fan-out as a consumer app", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row({ request_id: `c-${index}`, end_user: `eu-${index % 30}`, litellm_session_id: `s-${index % 30}` }));
    const parsed = parseLiteLLMSpendLogs(rows, AT);
    const measurement = measureTraffic(parsed.accepted.map((entry) => entry.record), publishedModelPrices);
    const signals = signalsFromLiteLLM(parsed.accepted, [], measurement);
    expect(classifySegment(signals).segment).toBe("consumer-app");
  });

  it("classifies session-heavy internal traffic as an in-house agent and refuses to bill caching", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row({ request_id: `a-${index}`, litellm_session_id: `task-${Math.floor(index / 5)}` }));
    const parsed = parseLiteLLMSpendLogs(rows, AT);
    const measurement = measureTraffic(parsed.accepted.map((entry) => entry.record), publishedModelPrices);
    const signals = signalsFromLiteLLM(parsed.accepted, [], measurement);
    const classification = classifySegment(signals);
    expect(classification.segment).toBe("in-house-agent");
    const quote = quoteForSegment(classification, signals);
    expect(quote.topLever).toMatch(/output/i);
    expect(quote.reasoning.some((reason) => /not ours to bill/i.test(reason))).toBe(true);
  });

  it("tells an already-optimised stream not to pay", () => {
    const rows = Array.from({ length: 10 }, (_, index) => row({ request_id: `h-${index}` }));
    const hits = Array.from({ length: 10 }, (_, index) =>
      row({ request_id: `hit-${index}`, cache_hit: "True", spend: 0 }));
    const parsed = parseLiteLLMSpendLogs([...rows, ...hits], AT);
    const measurement = measureTraffic(parsed.accepted.map((entry) => entry.record), publishedModelPrices);
    const signals = signalsFromLiteLLM(parsed.accepted, parsed.cacheHits, measurement);
    const classification = classifySegment(signals);
    expect(classification.segment).toBe("already-optimised");
    expect(quoteForSegment(classification, signals).doNotCharge).toBe(true);
  });

  it("widens the band and says what is missing when prompts are not stored", () => {
    const rows = Array.from({ length: 30 }, (_, index) => row({ request_id: `s-${index}` }));
    const parsed = parseLiteLLMSpendLogs(rows, AT);
    const measurement = measureTraffic(parsed.accepted.map((entry) => entry.record), publishedModelPrices);
    const signals = signalsFromLiteLLM(parsed.accepted, [], measurement);
    const quote = quoteForSegment(classifySegment(signals), signals);
    expect(quote.confidence).toBe("needs-prompt-text");
    expect(quote.firmUpBy).toMatch(/prompts/);
    expect(quote.bandPercent[1] - quote.bandPercent[0]).toBeGreaterThanOrEqual(30);
  });
});
