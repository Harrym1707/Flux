import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditEventPricing,
  normalizeProviderUsage,
  publishedModelPrices,
  recomputeInvoice,
  type BillableEvent,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";
import { usageFromSse } from "./proxy.js";

/**
 * Ledger correctness under Anthropic server-side compaction.
 *
 * Docs (platform.claude.com, compaction-threshold "Understanding usage"):
 *   "The top-level `input_tokens` and `output_tokens` do not include
 *    compaction iteration usage. They reflect the sum of all non-compaction
 *    iterations. To calculate total tokens consumed and billed for a request,
 *    sum across all entries in the `usage.iterations` array."
 * Docs (compaction-on-demand "Count compaction usage"):
 *   "The top-level `input_tokens` and `output_tokens` are zero because no
 *    reply was generated."
 *
 * These tests were written FAILING-FIRST against the pre-fix ledger, which
 * read only the top-level fields: the on-demand summarization call priced at
 * $0 and the threshold call omitted the whole compaction iteration.
 */

type AnyObject = Record<string, any>;

const OPUS = "claude-opus-5-5";

/** The threshold-compaction response from the docs, at doc-example scale. */
const thresholdResponse = {
  content: [
    { type: "compaction", content: "Summary of the conversation: ..." },
    { type: "text", text: "Based on our conversation so far..." },
  ],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 23_000,
    output_tokens: 1_000,
    iterations: [
      { type: "compaction", input_tokens: 180_000, output_tokens: 3_500 },
      { type: "message", input_tokens: 23_000, output_tokens: 1_000 },
    ],
  },
};

/** The on-demand summarize response: top-level zero, cost only in iterations. */
const onDemandResponse = {
  content: [{ type: "compaction", content: "Summary...", signature: "EuYB..." }],
  stop_reason: "compaction",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    iterations: [{
      type: "compaction",
      input_tokens: 20_000,
      cache_read_input_tokens: 130_000,
      cache_creation_input_tokens: 0,
      output_tokens: 4_000,
    }],
  },
};

function client(response: AnyObject) {
  return { messages: { create: async (_request: AnyObject) => structuredClone(response) } };
}

async function billOne(response: AnyObject): Promise<BillableEvent> {
  const dir = mkdtempSync(join(tmpdir(), "flux-compaction-"));
  const path = join(dir, "ledger.jsonl");
  const wrapped = withFlux(client(response), {
    applicationId: "compaction-ledger-test",
    ledger: { path, provider: "anthropic" },
  });
  await wrapped.messages.create({ model: OPUS, max_tokens: 4_096, messages: [{ role: "user", content: "hi" }] });
  const records = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LedgerRecord);
  expect(records).toHaveLength(1);
  return records[0]!.event;
}

function withoutIterations(response: AnyObject): AnyObject {
  const copy = structuredClone(response);
  delete copy.usage.iterations;
  return copy;
}

describe("compaction iterations in the savings ledger", () => {
  it("normalizeProviderUsage keeps reading the top-level (non-compaction) usage unchanged", () => {
    const result = normalizeProviderUsage(thresholdResponse);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.usage.inputTokens).toBe(23_000);
    expect(result.usage.outputTokens).toBe(1_000);
  });

  it("prices the threshold compaction iteration at catalogued Opus 5.5 rates, attributed to the customer", async () => {
    const billed = await billOne(thresholdResponse);
    // Message iteration: 23K x $4/M + 1K x $20/M = $0.112 (unchanged semantics).
    expect(billed.actualUsd).toBeCloseTo(0.112, 10);
    // Compaction iteration: 180K x $4/M + 3.5K x $20/M = $0.79. Before the fix
    // this figure did not exist anywhere on the event: a $0.79 under-statement.
    expect(billed.compaction).toBeDefined();
    expect(billed.compaction!.attribution).toBe("customer");
    expect(billed.compaction!.iterations).toBe(1);
    expect(billed.compaction!.pricingStatus).toBe("priced");
    expect(billed.compaction!.usd).toBeCloseTo(0.79, 10);
    expect(billed.compaction!.usage).toEqual({
      inputTokens: 180_000, outputTokens: 3_500, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    });
  });

  it("prices an on-demand summarize call that the top-level usage reports as zero", async () => {
    const billed = await billOne(onDemandResponse);
    expect(billed.actualUsd).toBe(0);
    // 20K fresh x $4/M + 130K cache reads x $0.20/M + 4K out x $20/M = $0.186.
    expect(billed.compaction?.usd).toBeCloseTo(0.186, 10);
    expect(billed.compaction?.usage?.cachedInputTokens).toBe(130_000);
    // The summarizer's cache reads are the customer's, never FLUX's.
    expect(billed.levers.some((lever) => lever.kind === "provider_cache")).toBe(false);
  });

  it("never inflates or deflates billed savings: levers and invoice net equal the no-iterations event", async () => {
    for (const response of [thresholdResponse, onDemandResponse]) {
      const withIt = await billOne(response);
      const without = await billOne(withoutIterations(response));
      expect(withIt.levers).toEqual(without.levers);
      expect(withIt.actualUsd).toEqual(without.actualUsd);
      const left = recomputeInvoice([withIt]);
      const right = recomputeInvoice([without]);
      expect(left.netVerifiedSavingsUsd).toBe(right.netVerifiedSavingsUsd);
      expect(left.lineItems).toEqual(right.lineItems);
      expect(left.verdict).toBe(right.verdict);
      // The customer-paid compaction spend is visible on the invoice, unbilled.
      expect(left.customerCompaction?.usd).toBeCloseTo(withIt.compaction!.usd!, 10);
      expect(right.customerCompaction).toBeUndefined();
    }
  });

  it("audits the compaction figure with zero tolerance", async () => {
    const billed = await billOne(thresholdResponse);
    expect(auditEventPricing(billed, publishedModelPrices)).toEqual({ status: "verified" });
    const tampered = structuredClone(billed);
    tampered.compaction!.usd = 0;
    const audit = auditEventPricing(tampered, publishedModelPrices);
    expect(audit.status).toBe("mismatch");
  });

  it("an iterations array with no compaction entry adds nothing to the event", async () => {
    const plain = structuredClone(thresholdResponse) as AnyObject;
    plain.usage.iterations = [{ type: "message", input_tokens: 23_000, output_tokens: 1_000 }];
    const billed = await billOne(plain);
    expect(billed.compaction).toBeUndefined();
  });

  it("an unreadable compaction iteration leaves the compaction unpriced, never zero", async () => {
    const bad = structuredClone(thresholdResponse) as AnyObject;
    bad.usage.iterations[0].input_tokens = -5;
    const billed = await billOne(bad);
    expect(billed.compaction?.pricingStatus).toBe("unpriced");
    expect(billed.compaction?.usd).toBeUndefined();
    // The main event still prices normally.
    expect(billed.actualUsd).toBeCloseTo(0.112, 10);
  });

  it("the proxy's SSE merge carries message_delta usage.iterations through", () => {
    const sse = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 23_000, output_tokens: 1 } } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1_000, iterations: thresholdResponse.usage.iterations } })}`,
      "",
    ].join("\n");
    const shaped = usageFromSse("anthropic", sse) as AnyObject;
    expect(shaped.usage.iterations).toEqual(thresholdResponse.usage.iterations);
    expect(shaped.usage.output_tokens).toBe(1_000);
  });
});
