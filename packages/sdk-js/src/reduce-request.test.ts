import { describe, expect, it } from "vitest";
import { approximateTokenCount } from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";
import {
  capToolResultBody,
  digestStaleBody,
  reduceRequest,
  type FluxReductionSummary,
} from "./reduce-request.js";

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

describe("fresh tool-result capping", () => {
  /** An oversized tool result shaped like the eval fixture: a headline carrying
   * the reference later turns depend on, verbose record sentences, one error
   * sentence and one file path, all of which must survive the cap. */
  function oversizedResult(task = 3, turn = 2): string {
    const lines = [
      `Lookup complete for account ${1000 + task}: 3 records found; latest reference R-${task}-${turn} ` +
      "with a pending adjustment awaiting supervisor approval.",
    ];
    for (let row = 0; row < 18; row += 1) {
      lines.push(
        `Record ${row} shows a settlement entry of ${row * 137 + task} pence captured on day ${(row % 28) + 1}, ` +
        "routed through the refunds subsystem, with reconciliation state nominal, no customer notification " +
        "sent, and two internal annotations noting routine supervisor review cadence for this category.",
      );
    }
    lines.push("One earlier retry failed with a transient timeout before the record was captured cleanly.");
    lines.push("The reconciliation ledger lives at ops/settlements/ledger.csv for later checks.");
    return lines.join(" ");
  }

  const MARKER = /\[flux: \d+ chars of fresh tool-result detail capped\]/;

  it("keeps the headline with its latest reference, errors and file paths verbatim", () => {
    const capped = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(capped).not.toBe(oversizedResult());
    expect(capped.length).toBeLessThan(oversizedResult().length);
    expect(capped).toContain("latest reference R-3-2");
    expect(capped).toContain("One earlier retry failed with a transient timeout");
    expect(capped).toContain("ops/settlements/ledger.csv");
    expect(capped).toMatch(MARKER);
  });

  it("is the identity at or under the threshold", () => {
    const small = "Lookup complete: latest reference R-1-1 with a pending adjustment.";
    expect(capToolResultBody(small, 600, approximateTokenCount)).toBe(small);
    const body = oversizedResult();
    expect(capToolResultBody(body, approximateTokenCount(body), approximateTokenCount)).toBe(body);
  });

  it("is idempotent: cap(cap(x)) === cap(x)", () => {
    const once = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(capToolResultBody(once, 600, approximateTokenCount)).toBe(once);
  });

  it("is deterministic across calls", () => {
    expect(capToolResultBody(oversizedResult(), 600, approximateTokenCount))
      .toBe(capToolResultBody(oversizedResult(), 600, approximateTokenCount));
  });

  it("is byte-stable under stale compaction: digestStaleBody(cap(x)) === cap(x)", () => {
    const capped = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(digestStaleBody(capped)).toBe(capped);
  });

  it("throws on a threshold under 64 or not an integer", () => {
    expect(() => capToolResultBody(oversizedResult(), 10, approximateTokenCount)).toThrow(/at least 64/);
    expect(() => capToolResultBody(oversizedResult(), 600.5, approximateTokenCount)).toThrow(/at least 64/);
  });

  function capRequest(input: unknown[], messages?: unknown[]): Record<string, unknown> {
    return {
      model: "gpt-5",
      instructions: "You are a support agent.",
      input,
      ...(messages === undefined ? {} : { messages }),
    };
  }

  it("caps oversized assistant bodies and reports a lossy, measured change record", () => {
    const { request: reduced, summary } = reduceRequest(
      capRequest([
        { role: "user", content: "Step 0." },
        { role: "assistant", content: oversizedResult() },
      ]),
      { freshToolResultCap: true },
    );
    const change = summary.changes.find((entry) => entry.lever === "fresh-tool-result-cap")!;
    expect(change.lossless).toBe(false);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    const wire = JSON.stringify(reduced);
    expect(wire).toContain("latest reference R-3-2");
    expect(wire).toContain("fresh tool-result detail capped");
  });

  it("returns the original request with NO change record when every body is under the threshold", () => {
    const original = capRequest([
      { role: "user", content: "Step 0." },
      { role: "assistant", content: "Done: latest reference R-1-1 recorded." },
    ]);
    const { request: reduced, summary } = reduceRequest(original, { freshToolResultCap: true });
    expect(reduced).toBe(original);
    expect(summary.changes).toHaveLength(0);
  });

  it("caps function_call_output, {text} parts and nested {content} shapes, in input and messages", () => {
    const { request: reduced } = reduceRequest(
      capRequest(
        [
          { role: "user", content: "Step 0." },
          { type: "function_call_output", call_id: "c1", output: oversizedResult(1, 1) },
          { role: "tool", content: [{ type: "output_text", text: oversizedResult(2, 1) }] },
          { role: "assistant", content: [{ content: oversizedResult(4, 1) }] },
        ],
        [{ role: "tool", content: oversizedResult(5, 1) }],
      ),
      { freshToolResultCap: true },
    );
    const next = reduced as Record<string, unknown>;
    const inputWire = JSON.stringify(next.input);
    const messagesWire = JSON.stringify(next.messages);
    expect(inputWire.match(/fresh tool-result detail capped/g)).toHaveLength(3);
    expect(messagesWire).toContain("fresh tool-result detail capped");
    for (const [task, wire] of [[1, inputWire], [2, inputWire], [4, inputWire], [5, messagesWire]] as const) {
      expect(wire).toContain(`latest reference R-${task}-1`);
    }
  });

  it("never touches user, system or developer messages, however oversized", () => {
    const body = oversizedResult(6, 1);
    const { request: reduced, summary } = reduceRequest(
      capRequest([
        { role: "system", content: body },
        { role: "developer", content: body },
        { role: "user", content: body },
      ]),
      { freshToolResultCap: true },
    );
    expect(summary.changes).toHaveLength(0);
    const wire = JSON.stringify(reduced);
    expect(wire.match(/fresh tool-result detail capped/g)).toBeNull();
    expect(wire).toContain("Record 17 shows a settlement entry");
  });

  it("skips the whole reduction, request untouched, on an invalid threshold", () => {
    const original = capRequest([{ role: "assistant", content: oversizedResult() }]);
    for (const maximumTokens of [10, 63, 600.5]) {
      const { request: reduced, summary } = reduceRequest(original, {
        freshToolResultCap: { maximumTokens },
      });
      expect(reduced).toBe(original);
      expect(summary.skipped).toBe(true);
      expect(summary.skippedReason).toMatch(/at least 64/);
    }
  });

  it("leaves capped bodies byte-identical through history compaction", () => {
    const input: unknown[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      input.push({ role: "user", content: `Step ${turn}.` });
      input.push({ role: "assistant", content: oversizedResult(7, turn) });
    }
    const capOnly = reduceRequest(capRequest([...input]), { freshToolResultCap: true });
    const both = reduceRequest(capRequest([...input]), {
      freshToolResultCap: true,
      historyCompaction: true,
    });
    expect(JSON.stringify((both.request as Record<string, unknown>).input))
      .toBe(JSON.stringify((capOnly.request as Record<string, unknown>).input));
    expect(both.summary.changes.some((entry) => entry.lever === "stale-history-compaction")).toBe(false);
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

describe("cacheTtl 1h stamping", () => {
  const anthropicRequest = (content: unknown = "Summarise the account history."): Record<string, unknown> => ({
    model: "claude-sonnet-4-5",
    system: "You are a support agent.",
    messages: [
      { role: "user", content: "Earlier turn." },
      { role: "user", content },
    ],
  });

  it("stamps cache_control {ttl: '1h'} on the last block of the last message", () => {
    const { request: reduced, summary } = reduceRequest(anthropicRequest(), { cacheTtl: "1h" });
    const messages = (reduced as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1]!;
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // A string body is lifted into the equivalent single text block, verbatim.
    expect(blocks[blocks.length - 1]!.text).toBe("Summarise the account history.");
    expect(summary.changes.map((change) => change.lever)).toContain("cache-ttl-1h");
    // A rate change, not a prompt change: nothing was removed.
    expect(summary.changes.find((change) => change.lever === "cache-ttl-1h")!.estimatedTokensSaved).toBe(0);
  });

  it("stamps an existing block array without disturbing the other blocks", () => {
    const { request: reduced } = reduceRequest(
      anthropicRequest([{ type: "text", text: "First." }, { type: "text", text: "Second." }]),
      { cacheTtl: "1h" },
    );
    const messages = (reduced as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const blocks = messages[messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "First." });
    expect(blocks[1]).toEqual({ type: "text", text: "Second.", cache_control: { type: "ephemeral", ttl: "1h" } });
  });

  it("leaves non-Anthropic requests untouched", () => {
    const request = { model: "gpt-5", messages: [{ role: "user", content: "Hello." }] };
    const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
    expect(reduced).toBe(request);
    expect(summary.changes).toHaveLength(0);
  });

  it("defers to a caller who already placed their own cache_control", () => {
    const request = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "Pinned.", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "Next question." },
      ],
    };
    const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
    expect(reduced).toBe(request);
    expect(summary.changes).toHaveLength(0);
  });

  it("does not mutate the caller's original messages", () => {
    const original = anthropicRequest();
    const snapshot = JSON.stringify(original);
    reduceRequest(original, { cacheTtl: "1h" });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
