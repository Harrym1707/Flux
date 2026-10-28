import { describe, expect, it } from "vitest";
import {
  approximateTokenCount,
  catalogueVersion,
  publishedModelPrices,
  recomputeInvoice,
} from "../../core/dist/src/index.js";
import {
  OUTPUT_STYLE_INSTRUCTIONS,
  appendBeforeVolatileTail,
  outputStyleSkipReason,
  type FluxOutputStyle,
} from "./output-style.js";
import { reduceRequest, type FluxReductionChange } from "./reduce-request.js";
import { replayGate, responseText } from "./replay-gate.js";
import { billableEventFromRequest } from "./savings-ledger.js";
import type { FluxRequestEvent } from "./types.js";

type AnyObject = Record<string, any>;

// Long enough to clear the Sonnet-class cacheable minimum with FLUX's 1.30x margin.
const STABLE_SYSTEM = "You are a support agent. Follow the escalation policy exactly. ".repeat(90);
const CONCISE = OUTPUT_STYLE_INSTRUCTIONS.concise;

function anthropicTurn(turns: number, system: unknown = STABLE_SYSTEM): AnyObject {
  const messages: AnyObject[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "user", content: `Question ${index}: why was refund ${index} delayed?` });
    if (index < turns - 1) messages.push({ role: "assistant", content: `Answer ${index}.` });
  }
  return { model: "claude-sonnet-5-5", max_tokens: 1024, system, messages };
}

const MODES: Array<Exclude<FluxOutputStyle, "off">> = ["concise", "terse", "ultra"];

describe("output style instructions", () => {
  it("are short: every mode is under 56 tokens by FLUX's (over-counting) estimator, vs a 1,160-token rule set", () => {
    for (const mode of MODES) {
      expect(approximateTokenCount(OUTPUT_STYLE_INSTRUCTIONS[mode])).toBeLessThan(56);
    }
    // Shortest first: each step up in aggression adds only a few words.
    const lengths = MODES.map((mode) => OUTPUT_STYLE_INSTRUCTIONS[mode].length);
    expect(lengths[0]).toBeLessThan(lengths[1]!);
  });

  it("carry the exactness and safety carve-outs in every mode", () => {
    for (const mode of MODES) {
      const text = OUTPUT_STYLE_INSTRUCTIONS[mode];
      expect(text).toContain("code, commands, file paths, error messages and data exact");
      expect(text).toContain("full sentences for security warnings and irreversible actions");
    }
  });
});

describe("outputStyle in reduceRequest", () => {
  it("is off by default: no option or 'off' leaves the request byte-identical", () => {
    const request = anthropicTurn(1);
    expect(reduceRequest(request, { toolSchemas: false }).request).toBe(request);
    expect(reduceRequest(request, { outputStyle: "off" }).request).toBe(request);
  });

  it("appends to the END of an Anthropic string system prompt and reports a lossy change", () => {
    const { request, summary } = reduceRequest(anthropicTurn(1), { outputStyle: "concise" });
    const system = (request as AnyObject).system as string;
    expect(system.startsWith(STABLE_SYSTEM)).toBe(true);
    expect(system.endsWith(`\n\n${CONCISE}`)).toBe(true);
    const change = summary.changes.find((entry) => entry.lever === "output-style-concise");
    expect(change?.lossless).toBe(false);
    expect(change?.estimatedTokensSaved).toBe(0);
    expect(change?.estimatedTokensAdded).toBeGreaterThan(0);
  });

  it("is byte-stable across turns: the system bytes are identical on turn 1, 2 and 7", () => {
    for (const mode of MODES) {
      const systems = [1, 2, 7].map((turns) =>
        JSON.stringify((reduceRequest(anthropicTurn(turns), { outputStyle: mode }).request as AnyObject).system));
      expect(new Set(systems).size).toBe(1);
    }
  });

  it("sits INSIDE the FLUX cache stamp's breakpoint, identical bytes every turn", () => {
    const stampedSystems = [2, 3, 6].map((turns) => {
      const { request, summary } = reduceRequest(anthropicTurn(turns), { outputStyle: "terse", cacheTtl: "5m" });
      expect(summary.changes.some((change) => change.lever === "cache-ttl-5m")).toBe(true);
      const system = (request as AnyObject).system as AnyObject[];
      expect(system).toHaveLength(1);
      expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
      expect(system[0]!.text.endsWith(OUTPUT_STYLE_INSTRUCTIONS.terse)).toBe(true);
      return JSON.stringify(system);
    });
    expect(new Set(stampedSystems).size).toBe(1);
  });

  it("does not move the message breakpoint: it still lands on the last message", () => {
    const { request } = reduceRequest(anthropicTurn(3), { outputStyle: "concise", cacheTtl: "5m" });
    const messages = (request as AnyObject).messages as AnyObject[];
    const last = messages[messages.length - 1]!;
    expect(last.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(JSON.stringify(messages.slice(0, -1))).not.toContain("cache_control");
  });

  it("goes before a repaired volatile tail, so the stamped block never covers the clock", () => {
    const stableBlocks = ["2026-10-28T09:00:00Z", "2026-10-28T09:05:13Z"].map((clock) => {
      const system = `Current time: ${clock}\n${STABLE_SYSTEM}`;
      const { request } = reduceRequest(anthropicTurn(2, system), {
        repairCachePrefix: true,
        outputStyle: "concise",
        cacheTtl: "5m",
      });
      const blocks = (request as AnyObject).system as AnyObject[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.cache_control).toBeDefined();
      expect(blocks[0]!.text).toContain(CONCISE);
      expect(blocks[0]!.text).not.toContain(clock);
      expect(blocks[1]!.text).toBe(`Current time: ${clock}`);
      expect(blocks[1]!.cache_control).toBeUndefined();
      return JSON.stringify(blocks[0]);
    });
    expect(stableBlocks[0]).toBe(stableBlocks[1]);
  });

  it("never shifts a caller-placed breakpoint: it appends one block AFTER the caller's blocks", () => {
    const callerSystem = [
      { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
    ];
    const { request, summary } = reduceRequest(anthropicTurn(2, callerSystem), {
      outputStyle: "concise",
      cacheTtl: "5m",
    });
    const system = (request as AnyObject).system as AnyObject[];
    expect(system[0]).toEqual(callerSystem[0]);
    expect(system[1]).toEqual({ type: "text", text: CONCISE });
    // The caller chose their caching; FLUX's stamp defers exactly as before.
    expect(summary.changes.some((change) => change.lever === "cache-ttl-5m")).toBe(false);
  });

  it("creates the system prompt when an Anthropic request has none", () => {
    const request = anthropicTurn(1);
    delete request.system;
    const reduced = reduceRequest(request, { outputStyle: "ultra" }).request as AnyObject;
    expect(reduced.system).toBe(OUTPUT_STYLE_INSTRUCTIONS.ultra);
  });

  it("appends to the leading Chat Completions system message, or adds one", () => {
    const withSystem = {
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
        { role: "system", content: "Volatile mid-conversation note" },
      ],
    };
    const reduced = reduceRequest(withSystem, { outputStyle: "concise" }).request as AnyObject;
    expect(reduced.messages[0].content).toBe(`You are helpful.\n\n${CONCISE}`);
    expect(reduced.messages[2].content).toBe("Volatile mid-conversation note");

    const bare = { model: "gpt-5", messages: [{ role: "user", content: "Hi" }] };
    const added = reduceRequest(bare, { outputStyle: "concise" }).request as AnyObject;
    expect(added.messages[0]).toEqual({ role: "system", content: CONCISE });
    expect(added.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("appends to Responses instructions before a repaired volatile tail", () => {
    const request = {
      model: "gpt-5",
      instructions: "Request id 123e4567-e89b-12d3-a456-426614174000\nYou are a support agent.",
      input: [{ role: "user", content: "Hi" }],
    };
    const reduced = reduceRequest(request, { outputStyle: "concise", repairCachePrefix: true }).request as AnyObject;
    expect(reduced.instructions).toBe(
      `You are a support agent.\n\n${CONCISE}\nRequest id 123e4567-e89b-12d3-a456-426614174000`,
    );
  });

  it("is idempotent: re-reducing a styled request never adds the instruction twice", () => {
    const once = reduceRequest(anthropicTurn(2), { outputStyle: "concise" }).request;
    const twice = reduceRequest(once, { outputStyle: "concise" });
    expect((twice.request as AnyObject).system).toBe((once as AnyObject).system);
    expect(twice.summary.changes.some((change) => change.lever.startsWith("output-style"))).toBe(false);
  });

  it("skips forced tool choice and structured output, leaving the request untouched", () => {
    const cases: AnyObject[] = [
      { ...anthropicTurn(1), tool_choice: { type: "tool", name: "lookup" } },
      { ...anthropicTurn(1), tool_choice: { type: "any" } },
      { ...anthropicTurn(1), output_format: { type: "json_schema", schema: {} } },
      { model: "gpt-5", messages: [{ role: "user", content: "x" }], tool_choice: "required" },
      { model: "gpt-5", messages: [{ role: "user", content: "x" }], tool_choice: { type: "function", function: { name: "f" } } },
      { model: "gpt-5", messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: {} } },
      { model: "gpt-5", input: "x", text: { format: { type: "json_schema", schema: {} } } },
    ];
    for (const request of cases) {
      expect(outputStyleSkipReason(request)).toBeDefined();
      const { request: reduced, summary } = reduceRequest(request, { outputStyle: "ultra", toolSchemas: false });
      expect(reduced).toBe(request);
      expect(summary.notes?.[0]).toMatch(/^output-style-ultra not applied/);
    }
    // Auto tool choice is not forced: the style applies.
    expect(outputStyleSkipReason({ tool_choice: "auto" })).toBeUndefined();
    expect(outputStyleSkipReason({ tool_choice: { type: "auto" } })).toBeUndefined();
  });

  it("rejects an unknown mode by returning the original request", () => {
    const request = anthropicTurn(1);
    const result = reduceRequest(request, { outputStyle: "shouty" as FluxOutputStyle });
    expect(result.request).toBe(request);
    expect(result.summary.skipped).toBe(true);
  });

  it("appendBeforeVolatileTail handles an all-volatile body and a plain body", () => {
    expect(appendBeforeVolatileTail("t=1", "S", ["t=1"])).toBe("S\nt=1");
    expect(appendBeforeVolatileTail("A", "S", [])).toBe("A\n\nS");
    expect(appendBeforeVolatileTail("", "S", [])).toBe("S");
  });
});

describe("output style billing", () => {
  const version = catalogueVersion(publishedModelPrices);
  const event = (changes: AnyObject[], before: number, inputTokens: number): FluxRequestEvent => ({
    requestId: "req-style",
    applicationId: "app",
    provider: "openai-compatible",
    model: "gpt-6-astra",
    latencyMs: 1,
    status: "succeeded",
    timestamp: "2026-10-13T10:00:00.000Z",
    inputTokens,
    outputTokens: 0,
    uncachedInputTokens: inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reduction: {
      estimatedTokensBefore: before,
      estimatedTokensAfter: before,
      estimatedTokensSaved: 0,
      estimatedLosslessTokensSaved: 0,
      skipped: false,
      changes: changes as FluxReductionChange[],
    },
  });

  it("is recorded as a lossy lever and never billed without a measured, gate-approved saving", () => {
    const billed = billableEventFromRequest(
      event([{ lever: "output-style-concise", lossless: false, estimatedTokensSaved: 0, estimatedTokensAdded: 25, detail: "" }], 1_000, 1_025),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    const lever = billed.levers.find((entry) => entry.leverId === "output-style-concise");
    expect(lever?.kind).toBe("lossy");
    expect(lever?.savedUsd).toBeUndefined();
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("with a measured counterfactual, still needs an approved gate verdict to bill", () => {
    const changes = [{ lever: "output-style-concise", lossless: false, estimatedTokensSaved: 0, estimatedTokensAdded: 25, detail: "" }];
    const unapproved = billableEventFromRequest(event(changes, 1_000, 1_025), { path: "unused", getBaselineUsd: () => 1 }, publishedModelPrices, version);
    expect(recomputeInvoice([unapproved]).netVerifiedSavingsUsd).toBe(0);
    const approved = billableEventFromRequest(
      event(changes, 1_000, 1_025),
      { path: "unused", getBaselineUsd: () => 1, gateVerdicts: { "output-style-concise": { ref: "replay-gate/style@test", verdict: "approved" } } },
      publishedModelPrices,
      version,
    );
    expect(recomputeInvoice([approved]).netVerifiedSavingsUsd).toBeGreaterThan(0);
  });

  it("subtracts the added instruction tokens before estimating another lever's baseline", () => {
    // 1M before, 200k removed (f = 0.2). Provider input 800k + 40k instruction.
    // Anchored input 800k -> baseline 1M -> 200k saved at the realized rate.
    const billed = billableEventFromRequest(
      event([
        { lever: "tool-schemas", lossless: true, estimatedTokensSaved: 200_000, detail: "" },
        { lever: "output-style-concise", lossless: false, estimatedTokensSaved: 0, estimatedTokensAdded: 40_000, detail: "" },
      ], 1_000_000, 840_000),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    const schemas = billed.levers.find((entry) => entry.leverId === "tool-schemas");
    // 200k tokens at the realized blended rate (10 USD/M on gpt-6-astra).
    expect(schemas?.savedUsd).toBeCloseTo(2, 10);
    expect(billed.estimatedReduction?.estimatedInputTokensAdded).toBe(40_000);
  });
});

describe("output style through the replay gate", () => {
  it("is approved only on measured output reduction with quality held", async () => {
    const requests = Array.from({ length: 12 }, (_, index) => ({
      model: "gpt-5",
      instructions: "You are a support agent.",
      input: [{ role: "user", content: `Question ${index}` }],
    }));
    // Stub provider: the styled request answers the same, in fewer output tokens.
    const call = async (request: unknown) => {
      const styled = JSON.stringify(request).includes(CONCISE);
      return {
        output_text: "Refund is delayed by the issuer.",
        usage: { input_tokens: styled ? 40 : 20, output_tokens: styled ? 60 : 200 },
      };
    };
    const result = await replayGate({
      requests,
      call,
      candidates: [{ label: "concise", config: { outputStyle: "concise" } }],
      grade: ({ baselineResponse, candidateResponse }) =>
        responseText(baselineResponse) === responseText(candidateResponse) ? 1 : 0,
    });
    expect(result.approved?.label).toBe("concise");
    expect(result.approved?.outputTokensSaved).toBe(12 * 140);
    expect(result.approved?.inputTokensSaved).toBe(-12 * 20);
  });
});
