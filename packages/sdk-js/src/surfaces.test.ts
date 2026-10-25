import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyLedgerChain, type LedgerRecord } from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";
import type { FluxRequestEvent } from "./types.js";

/**
 * The Chat Completions and Anthropic Messages surfaces, mirroring the
 * responses.create tests: the wrapper must preserve the provider's response
 * shape, parse the surface's own usage convention through the shared
 * normaliser, and emit one hash-chained billable event per request.
 */

type AnyObject = Record<string, any>;

function readRecords(path: string): LedgerRecord[] {
  return readFileSync(path, "utf8")
    .split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LedgerRecord);
}

describe("chat.completions.create surface", () => {
  const chatResponse = {
    choices: [{ message: { role: "assistant", content: "ok" } }],
    service_tier: "batch",
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };

  function chatClient(seen: AnyObject[]) {
    return {
      chat: {
        completions: {
          create: async (request: AnyObject) => {
            seen.push(request);
            return structuredClone(chatResponse);
          },
        },
      },
    };
  }

  it("preserves the provider response and emits one chained event priced from the RESPONSE tier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-chat-"));
    const path = join(dir, "ledger.jsonl");
    const seen: AnyObject[] = [];
    const events: FluxRequestEvent[] = [];
    const client = withFlux(chatClient(seen), {
      applicationId: "chat-surface-test",
      ledger: { path, provider: "openai" },
      onEvent: (event) => events.push(event),
    });
    const response = await client.chat.completions.create({
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.choices[0].message.content).toBe("ok");

    const records = readRecords(path);
    expect(records).toHaveLength(1);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 1 });
    const billed = records[0]!.event;
    // Chat usage (prompt_tokens/completion_tokens) parses through the shared
    // normaliser; the old Responses-only parser dropped it entirely.
    expect(billed.usage).toEqual({
      inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    });
    expect(billed.executionMode).toBe("batch");
    expect(billed.pricingStatus).toBe("priced");
    expect(billed.actualUsd).toBe(5);
    expect(billed.levers).toEqual([{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }]);
  });

  it("counts cached chat tokens INSIDE prompt_tokens, never on top of them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-chat-"));
    const path = join(dir, "ledger.jsonl");
    const cachedResponse = {
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    };
    const client = withFlux({
      chat: { completions: { create: async (_request: AnyObject) => structuredClone(cachedResponse) } },
    }, { applicationId: "chat-surface-test", ledger: { path, provider: "openai" } });
    await client.chat.completions.create({ model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] });
    const billed = readRecords(path)[0]!.event;
    expect(billed.usage).toEqual({
      inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 800, cacheWriteInputTokens: 0,
    });
  });

  it("applies a routing candidate's output cap through max_completion_tokens, never max_output_tokens", async () => {
    const seen: AnyObject[] = [];
    const client = withFlux(chatClient(seen), {
      applicationId: "chat-surface-test",
      classify: () => "triage",
      routing: {
        getRequestKey: () => "key-1",
        policies: [{
          id: "p1",
          taskClass: "triage",
          baselineModel: "gpt-6-astra",
          minimumSamples: 1,
          minimumCandidateAccuracyLower95: 0,
          maximumAccuracyDrop: 1,
          candidates: [{
            model: "gpt-6-luna",
            trafficShare: 1,
            approved: true,
            maxOutputTokens: 400,
            evidence: {
              baselineModel: "gpt-6-astra", candidateModel: "gpt-6-luna", eligibleForReview: true,
              sampleSize: 100, candidateAccuracyLower95: 1, accuracyDrop: 0,
              baselineCostUsd: 1, candidateCostUsd: 0.1,
            },
          }],
        }],
      },
    });
    await client.chat.completions.create({ model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] });
    expect(seen[0]!.model).toBe("gpt-6-luna");
    expect(seen[0]!.max_completion_tokens).toBe(400);
    expect(seen[0]!.max_output_tokens).toBeUndefined();
  });
});

describe("anthropic messages.create surface", () => {
  const anthropicResponse = {
    content: [{ type: "text", text: "ok" }],
    usage: {
      input_tokens: 400_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 600_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600_000 },
      output_tokens: 0,
      service_tier: "standard",
    },
  };

  function anthropicClient(seen: AnyObject[], response: AnyObject = anthropicResponse) {
    return {
      messages: {
        create: async (request: AnyObject) => {
          seen.push(request);
          return structuredClone(response);
        },
      },
    };
  }

  it("preserves the response, reads reads/writes OUTSIDE input_tokens, and bills the 1h split it stamped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-anthropic-"));
    const path = join(dir, "ledger.jsonl");
    const seen: AnyObject[] = [];
    const events: FluxRequestEvent[] = [];
    const client = withFlux(anthropicClient(seen), {
      applicationId: "anthropic-surface-test",
      tokenReduction: { cacheTtl: "1h" },
      ledger: { path, provider: "anthropic" },
      onEvent: (event) => events.push(event),
    });
    const response = await client.messages.create({
      model: "claude-sonnet-5-5-20260514",
      max_tokens: 1_024,
      // Long enough to clear Anthropic's 1,024-token cacheable minimum (see
      // `anthropicCacheableMinimumTokens`); the mocked response's own `usage`
      // numbers below drive the billing assertions, not this text's length.
      system: "You are terse. Answer in one short sentence, never more. ".repeat(70),
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.content[0].text).toBe("ok");
    // The cacheTtl lever stamped the STABLE prefix of the request FLUX sent:
    // the system prompt, never the varying one-shot message.
    expect(JSON.stringify(seen[0]!.system)).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}');
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("cache_control");

    const records = readRecords(path);
    expect(records).toHaveLength(1);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 1 });
    const billed = records[0]!.event;
    // Anthropic convention: total input = fresh + reads + writes, split kept.
    expect(billed.usage).toEqual({
      inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 600_000,
      cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 600_000,
    });
    expect(billed.executionMode).toBe("standard");
    expect(billed.pricingStatus).toBe("priced");
    // 400K fresh at 2/M + 600K 1h writes at 4/M.
    expect(billed.actualUsd).toBeCloseTo(3.2, 10);
    // Cache economics attribute to FLUX (it placed the stamp) and are negative
    // here: a write surcharge with no reads to earn it counts against FLUX.
    const cacheLever = billed.levers.find((lever) => lever.leverId === "cache-ttl-1h")!;
    expect(cacheLever.kind).toBe("provider_cache");
    expect(cacheLever.savedUsd).toBeCloseTo(-1.2, 10);
    expect(events[0]!.provider).toBe("anthropic-compatible");
  });

  it("records batch tier evidence from usage.service_tier even when the mode is unpriced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-anthropic-"));
    const path = join(dir, "ledger.jsonl");
    const batchResponse = structuredClone(anthropicResponse) as AnyObject;
    batchResponse.usage.service_tier = "batch";
    const client = withFlux(anthropicClient([], batchResponse), {
      applicationId: "anthropic-surface-test",
      ledger: { path, provider: "anthropic" },
    });
    await client.messages.create({
      model: "claude-sonnet-5-5-20260514",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hi" }],
    });
    const billed = readRecords(path)[0]!.event;
    expect(billed.executionMode).toBe("batch");
    // No anthropic batch rate is catalogued, so the event is UNPRICED - never
    // silently priced at standard, never zeroed.
    expect(billed.pricingStatus).toBe("unpriced");
  });

  it("maps Anthropic priority tier to standard pricing: no tier lever is ever claimed on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-anthropic-"));
    const path = join(dir, "ledger.jsonl");
    const priorityResponse = structuredClone(anthropicResponse) as AnyObject;
    priorityResponse.usage.service_tier = "priority";
    const client = withFlux(anthropicClient([], priorityResponse), {
      applicationId: "anthropic-surface-test",
      ledger: { path, provider: "anthropic" },
    });
    await client.messages.create({
      model: "claude-sonnet-5-5-20260514",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hi" }],
    });
    const billed = readRecords(path)[0]!.event;
    expect(billed.executionMode).toBe("standard");
    expect(billed.levers.filter((lever) => lever.kind === "tier")).toHaveLength(0);
  });

  it("shares ONE ledger chain across surfaces on a client exposing several", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-multi-"));
    const path = join(dir, "ledger.jsonl");
    const client = withFlux({
      responses: { create: async (_request: AnyObject) => ({ output_text: "ok", usage: { input_tokens: 10, output_tokens: 1 } }) },
      messages: { create: async (_request: AnyObject) => structuredClone(anthropicResponse) },
    }, { applicationId: "multi-surface-test", ledger: { path } });
    await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    await client.messages.create({
      model: "claude-sonnet-5-5-20260514", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
    });
    const records = readRecords(path);
    expect(records).toHaveLength(2);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 2 });
  });
});

describe("withFlux surface detection", () => {
  it("rejects a client with no supported surface", () => {
    expect(() => withFlux({} as AnyObject, { applicationId: "x" })).toThrow(/responses\.create\(\)/);
  });

  it("leaves unrelated client properties untouched", async () => {
    const client = withFlux({
      apiKey: "k",
      chat: { completions: { create: async () => ({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
    }, { applicationId: "x" });
    expect(client.apiKey).toBe("k");
  });
});
