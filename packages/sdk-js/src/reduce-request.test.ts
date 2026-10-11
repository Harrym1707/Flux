import { describe, expect, it } from "vitest";
import { withFlux } from "./openai.js";
import { reduceRequest, type FluxReductionSummary } from "./reduce-request.js";

const LONG_DESCRIPTION =
  "Look up a record set for a customer account. Use this when the customer asks about historical activity in " +
  "this subsystem. Returns a paginated list ordered by creation time descending.";

const BLOCK =
  "Knowledge base article 4471: Refunds issued to a closed card are returned to the original payment method " +
  "where the issuer supports it, and otherwise credited to the customer wallet within one business day.";

function toolCatalogue(count = 2): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "function",
    function: {
      name: `lookup_${index}`,
      description: LONG_DESCRIPTION,
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { accountId: { type: "string", title: "accountId", description: "Account identifier." } },
        required: ["accountId"],
      },
    },
  }));
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5",
    instructions: "You are a support agent.",
    tools: toolCatalogue(),
    input: [{ role: "user", content: "Why was my refund delayed?" }],
    ...overrides,
  };
}

describe("reduceRequest", () => {
  it("keeps tool descriptions by default, so the default path cannot change tool choice", () => {
    const { request: reduced, summary } = reduceRequest(request(), { toolSchemas: true });
    expect(JSON.stringify(reduced)).toContain("paginated list");
    expect(summary.changes.every((change) => change.lossless)).toBe(true);
    expect(summary.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("removes schema plumbing the model never reads", () => {
    const { request: reduced } = reduceRequest(request(), { toolSchemas: true });
    expect(JSON.stringify(reduced)).not.toContain("$schema");
  });

  it("trims descriptions only when explicitly asked, and reports it as lossy", () => {
    const { summary } = reduceRequest(request(), {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 8 },
    });
    const trim = summary.changes.find((change) => change.lever === "tool-schema-description-trim")!;
    expect(trim.lossless).toBe(false);
  });

  it("removes an exactly duplicated context block", () => {
    const withDuplicate = request({
      input: [{ role: "user", content: `${BLOCK}\n\n${BLOCK}\n\nWhy was my refund delayed?` }],
    });
    const { request: reduced } = reduceRequest(withDuplicate, { duplicateContext: true });
    const occurrences = JSON.stringify(reduced).split("article 4471").length - 1;
    expect(occurrences).toBe(1);
  });

  it("moves a leading clock out of the prefix without deleting it", () => {
    const withClock = request({ instructions: "Current time: 2026-10-08T09:14:22Z\nYou are a support agent." });
    const { request: reduced, summary } = reduceRequest(withClock, { repairCachePrefix: true });
    const instructions = String((reduced as Record<string, unknown>).instructions);
    expect(instructions.startsWith("You are a support agent.")).toBe(true);
    // Reordered, not removed: the model still sees the time.
    expect(instructions).toContain("Current time: 2026-10-08T09:14:22Z");
    const repair = summary.changes.find((change) => change.lever === "cache-prefix-repair")!;
    expect(repair.lossless).toBe(true);
    expect(repair.estimatedTokensSaved).toBe(0);
  });

  it("moves a leading request id out of the prefix too", () => {
    const withId = request({
      instructions: "Request: 7f3b9c2a-1d4e-4a8b-9c3d-2e5f6a7b8c9d\nYou are a support agent.",
    });
    const { request: reduced } = reduceRequest(withId, { repairCachePrefix: true });
    expect(String((reduced as Record<string, unknown>).instructions)
      .startsWith("You are a support agent.")).toBe(true);
  });

  it("leaves a timestamp deep in the prompt alone, since it is not what ends the prefix", () => {
    const body = Array.from({ length: 20 }, (_, index) => `Rule ${index}.`).join("\n");
    const deep = request({ instructions: `You are a support agent.\n${body}\nAs at 2026-10-08T09:14:22Z.` });
    const { request: reduced } = reduceRequest(deep, { repairCachePrefix: true });
    expect(String((reduced as Record<string, unknown>).instructions).trimEnd())
      .toMatch(/As at 2026-10-08T09:14:22Z\.$/);
  });

  it("sets an output cap only when the caller has not", () => {
    const capped = reduceRequest(request(), { maxOutputTokens: 500 });
    expect((capped.request as Record<string, unknown>).max_output_tokens).toBe(500);

    const alreadySet = reduceRequest(request({ max_output_tokens: 2_000 }), { maxOutputTokens: 500 });
    expect((alreadySet.request as Record<string, unknown>).max_output_tokens).toBe(2_000);
  });

  it("reports an output cap as lossy, because it truncates", () => {
    const { summary } = reduceRequest(request(), { maxOutputTokens: 500 });
    expect(summary.changes.find((change) => change.lever === "output-cap")!.lossless).toBe(false);
  });

  it("returns the original object untouched when there is nothing to do", () => {
    const original = { model: "gpt-5", input: "hello" };
    const { request: reduced, summary } = reduceRequest(original, { toolSchemas: true });
    expect(reduced).toBe(original);
    expect(summary.changes).toHaveLength(0);
  });

  it("never mutates the caller's request", () => {
    const original = request();
    const snapshot = JSON.stringify(original);
    reduceRequest(original, { toolSchemas: true, duplicateContext: true, repairCachePrefix: true });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("returns the request unchanged rather than throwing on a shape it cannot read", () => {
    for (const bad of ["a string", 42, null, undefined, [1, 2]]) {
      const { request: reduced, summary } = reduceRequest(bad, { toolSchemas: true });
      expect(reduced).toBe(bad);
      expect(summary.skipped).toBe(true);
    }
  });

  it("skips rather than throws on an invalid output cap", () => {
    const { request: reduced, summary } = reduceRequest(request(), { maxOutputTokens: 0 });
    expect(summary.skipped).toBe(true);
    expect(summary.skippedReason).toMatch(/positive integer/);
    expect(reduced).toEqual(request());
  });

  it("hands the summary to onReduction", () => {
    const seen: FluxReductionSummary[] = [];
    reduceRequest(request(), { toolSchemas: true, onReduction: (summary) => seen.push(summary) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.estimatedTokensSaved).toBeGreaterThan(0);
  });
});

describe("withFlux reduction", () => {
  function stub(): { client: { responses: { create: (r: Record<string, unknown>) => Promise<unknown> } }; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      client: {
        responses: {
          create: async (payload: Record<string, unknown>) => {
            sent.push(payload);
            return { id: "r1", usage: { input_tokens: 100, output_tokens: 10 } };
          },
        },
      },
    };
  }

  it("reduces every request with no routing configured at all", async () => {
    // The point of the change: reduction used to fire only when a model swap
    // was selected, which made it unreachable for anyone not routing.
    const { client, sent } = stub();
    const wrapped = withFlux(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true, repairCachePrefix: true },
    }) as unknown as { responses: { create: (r: unknown) => Promise<unknown> } };

    await wrapped.responses.create(request({
      instructions: "Current time: 2026-10-08T09:14:22Z\nYou are a support agent.",
    }));

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain("$schema");
    expect(String(sent[0]!.instructions).startsWith("You are a support agent.")).toBe(true);
  });

  it("sends the request untouched when reduction is not configured", async () => {
    const { client, sent } = stub();
    const wrapped = withFlux(client as never, { applicationId: "test" }) as unknown as
      { responses: { create: (r: unknown) => Promise<unknown> } };
    await wrapped.responses.create(request());
    expect(JSON.stringify(sent[0])).toContain("$schema");
  });

  it("reports what it removed on the request event", async () => {
    const { client } = stub();
    const events: Array<{ reduction?: FluxReductionSummary }> = [];
    const wrapped = withFlux(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true },
      onEvent: (event) => events.push(event as { reduction?: FluxReductionSummary }),
    }) as unknown as { responses: { create: (r: unknown) => Promise<unknown> } };

    await wrapped.responses.create(request());
    expect(events).toHaveLength(1);
    expect(events[0]!.reduction?.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("still returns the provider's response unchanged", async () => {
    const { client } = stub();
    const wrapped = withFlux(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true },
    }) as unknown as { responses: { create: (r: unknown) => Promise<{ id: string }> } };
    const response = await wrapped.responses.create(request());
    expect(response.id).toBe("r1");
  });
});
