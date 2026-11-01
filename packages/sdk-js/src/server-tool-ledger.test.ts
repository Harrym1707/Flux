import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";

type AnyObject = Record<string, any>;

/**
 * Ledger honesty for Anthropic server tools (round 3).
 *
 * A response that ran web searches carries usage.server_tool_use
 * .web_search_requests. Anthropic bills $10 per 1,000 searches ON TOP of token
 * costs (platform.claude.com web-search-tool page, fetched 2026-10-28). Before
 * this fix the FLUX ledger read only token usage, so every search fee vanished
 * from the customer-recomputable record without a trace. The fee is the
 * CUSTOMER's spend, never a FLUX saving: it must be recorded, priced from the
 * catalogue, and never reach netVerifiedSavingsUsd.
 */

function readRecords(path: string): LedgerRecord[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
}

const searchingResponse = {
  content: [{ type: "text", text: "ok" }],
  usage: {
    input_tokens: 6_039,
    output_tokens: 931,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
  },
};

function anthropicClient(response: AnyObject) {
  return { messages: { create: async (_request: AnyObject) => structuredClone(response) } };
}

describe("server-tool usage on the ledger", () => {
  it("records web_search_requests on the billable event and prices the per-search fee from the catalogue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-server-tools-"));
    const path = join(dir, "ledger.jsonl");
    const client = withFlux(anthropicClient(searchingResponse), {
      applicationId: "server-tool-test",
      ledger: { path, provider: "anthropic" },
    });
    await client.messages.create({
      model: "claude-sonnet-5-5-20260514",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "What changed this week?" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    const records = readRecords(path);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 1 });
    const event = records[0]!.event;
    expect(event.serverToolUsage).toBeDefined();
    expect(event.serverToolUsage!.attributedTo).toBe("customer");
    expect(event.serverToolUsage!.webSearchRequests).toBe(3);
    expect(event.serverToolUsage!.webFetchRequests).toBe(2);
    // 3 searches x $10 / 1,000 = $0.03; web fetch has no fee beyond tokens.
    expect(event.serverToolUsage!.feeUsd).toBeCloseTo(0.03, 12);
    const search = event.serverToolUsage!.components.find((c) => c.tool === "web_search")!;
    expect(search.status).toBe("priced");
    const fetch = event.serverToolUsage!.components.find((c) => c.tool === "web_fetch")!;
    expect(fetch.status).toBe("no_fee");
    // Token pricing is untouched: actualUsd is still the token cost alone.
    expect(event.actualUsd).toBeCloseTo((6_039 * 2 + 931 * 10) / 1_000_000, 12);
    // The fee never becomes a FLUX saving.
    expect(recomputeInvoice([event]).netVerifiedSavingsUsd).toBe(0);
  });
});
