import { describe, expect, it } from "vitest";
import { normalizeProviderUsage, providerServerToolUsage, sumServerToolUsage } from "./provider-usage.js";
import {
  priceServerToolUsage,
  publishedServerToolFees,
  serverToolFeeCatalogueVersion,
  summarizeServerToolFees,
} from "./server-tool-fees.js";
import {
  auditServerToolFees,
  recomputeInvoice,
  type BillableEvent,
} from "./savings-ledger.js";

const responseWithSearches = {
  usage: {
    input_tokens: 105,
    output_tokens: 6_039,
    cache_read_input_tokens: 7_123,
    cache_creation_input_tokens: 7_345,
    server_tool_use: { web_search_requests: 4, web_fetch_requests: 1, code_execution_requests: 2 },
  },
};

describe("providerServerToolUsage", () => {
  it("reads the documented server_tool_use counters", () => {
    expect(providerServerToolUsage(responseWithSearches)).toEqual({
      webSearchRequests: 4,
      webFetchRequests: 1,
      codeExecutionRequests: 2,
    });
  });

  it("returns undefined when there is no server_tool_use, or every count is zero", () => {
    expect(providerServerToolUsage({ usage: { input_tokens: 1, output_tokens: 1 } })).toBeUndefined();
    expect(providerServerToolUsage({ usage: { server_tool_use: { web_search_requests: 0 } } })).toBeUndefined();
    expect(providerServerToolUsage(undefined)).toBeUndefined();
    expect(providerServerToolUsage({ usage: { server_tool_use: { web_search_requests: -3 } } })).toBeUndefined();
  });

  it("keeps an unrecognised server-tool counter verbatim instead of dropping it", () => {
    expect(providerServerToolUsage({ usage: { server_tool_use: { future_tool_requests: 2 } } })).toEqual({
      webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, other: { future_tool_requests: 2 },
    });
  });

  it("leaves normalizeProviderUsage byte-for-byte unchanged", () => {
    const { server_tool_use: _ignored, ...tokensOnly } = responseWithSearches.usage;
    expect(JSON.stringify(normalizeProviderUsage(responseWithSearches)))
      .toBe(JSON.stringify(normalizeProviderUsage({ usage: tokensOnly })));
  });

  it("sums attempts and treats all-absent as absent", () => {
    expect(sumServerToolUsage([undefined, undefined])).toBeUndefined();
    expect(sumServerToolUsage([
      { webSearchRequests: 1, webFetchRequests: 0, codeExecutionRequests: 0 },
      undefined,
      { webSearchRequests: 2, webFetchRequests: 3, codeExecutionRequests: 0, other: { x: 1 } },
    ])).toEqual({ webSearchRequests: 3, webFetchRequests: 3, codeExecutionRequests: 0, other: { x: 1 } });
  });
});

describe("priceServerToolUsage", () => {
  it("prices searches at the catalogued $10/1,000, fetch at its published zero, and flags code execution unpriced", () => {
    const priced = priceServerToolUsage(publishedServerToolFees, {
      provider: "anthropic",
      at: "2026-10-28",
      usage: providerServerToolUsage(responseWithSearches)!,
    });
    expect(priced.attributedTo).toBe("customer");
    expect(priced.feeUsd).toBeCloseTo(0.04, 12);
    expect(priced.hasUnpricedComponent).toBe(true);
    expect(priced.components).toEqual([
      { tool: "web_search", requests: 4, status: "priced", feeUsd: 0.04 },
      { tool: "web_fetch", requests: 1, status: "no_fee", feeUsd: 0 },
      expect.objectContaining({ tool: "code_execution", requests: 2, status: "unpriced component" }),
    ]);
    expect(priced.feeCatalogueVersion).toBe(serverToolFeeCatalogueVersion(publishedServerToolFees));
  });

  it("refuses to back-date the observed fee: an earlier billing date is an unpriced component", () => {
    const priced = priceServerToolUsage(publishedServerToolFees, {
      provider: "anthropic-compatible",
      at: "2026-10-01",
      usage: { webSearchRequests: 5, webFetchRequests: 0, codeExecutionRequests: 0 },
    });
    expect(priced.feeUsd).toBeUndefined();
    expect(priced.hasUnpricedComponent).toBe(true);
    expect(priced.components[0]).toMatchObject({ tool: "web_search", status: "unpriced component" });
  });

  it("has no OpenAI fee catalogued, so an OpenAI count stays unpriced rather than guessed", () => {
    const priced = priceServerToolUsage(publishedServerToolFees, {
      provider: "openai",
      at: "2026-10-28",
      usage: { webSearchRequests: 1, webFetchRequests: 0, codeExecutionRequests: 0 },
    });
    expect(priced.components[0]!.status).toBe("unpriced component");
  });

  it("every catalogued fee carries a primary-page provenance", () => {
    for (const entry of publishedServerToolFees.entries) {
      expect(entry.provenance.source).toMatch(/^https:\/\/platform\.claude\.com\//);
      expect(entry.provenance.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

function event(overrides: Partial<BillableEvent> & { requestId: string }): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-28T10:00:00.000Z",
    provider: "anthropic",
    model: "Sonnet 5.5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

describe("server-tool fees never become FLUX savings", () => {
  const usage = priceServerToolUsage(publishedServerToolFees, {
    provider: "anthropic",
    at: "2026-10-28",
    usage: { webSearchRequests: 250, webFetchRequests: 40, codeExecutionRequests: 3 },
  });
  const levers: BillableEvent["levers"] = [
    { leverId: "cache-ttl-5m", kind: "provider_cache", savedUsd: 0.31 },
    { leverId: "dedupe-repeated-blocks", kind: "lossless", savedUsd: 0.02, basis: "estimated-baseline" },
  ];
  const without = [event({ requestId: "a", levers }), event({ requestId: "b", levers })];
  const withField = without.map((item) => ({ ...item, serverToolUsage: usage }));

  it("billed savings, fee and verdict are identical with and without the field", () => {
    const plain = recomputeInvoice(without, { feePercent: 1 });
    const carried = recomputeInvoice(withField, { feePercent: 1 });
    expect(JSON.stringify(carried)).toBe(JSON.stringify(plain));
    expect(carried.netVerifiedSavingsUsd).toBeCloseTo(0.66, 12);
  });

  it("a fee-only period still bills nothing", () => {
    const invoice = recomputeInvoice([event({ requestId: "c", serverToolUsage: usage })], { feePercent: 1 });
    expect(invoice.netVerifiedSavingsUsd).toBe(0);
    expect(invoice.verdict).toBe("do_not_charge");
  });

  it("the statement view totals the customer's fees and counts unpriced components", () => {
    expect(summarizeServerToolFees(withField)).toEqual({
      eventsWithServerTools: 2,
      webSearchRequests: 500,
      webFetchRequests: 80,
      codeExecutionRequests: 6,
      pricedFeeUsd: 5,
      eventsWithUnpricedComponent: 2,
    });
  });
});

describe("auditServerToolFees", () => {
  const usage = priceServerToolUsage(publishedServerToolFees, {
    provider: "anthropic",
    at: "2026-10-28",
    usage: { webSearchRequests: 7, webFetchRequests: 0, codeExecutionRequests: 0 },
  });

  it("verifies a stored fee by recomputing it from the event's own counts", () => {
    expect(auditServerToolFees(event({ requestId: "a", serverToolUsage: usage }), publishedServerToolFees))
      .toEqual({ status: "verified" });
    expect(auditServerToolFees(event({ requestId: "b" }), publishedServerToolFees)).toEqual({ status: "verified" });
  });

  it("catches a perturbed fee or count with zero tolerance", () => {
    const tampered = { ...usage, feeUsd: 0.06 };
    expect(auditServerToolFees(event({ requestId: "a", serverToolUsage: tampered }), publishedServerToolFees))
      .toMatchObject({ status: "mismatch", storedFeeUsd: 0.06 });
    const recounted = { ...usage, webSearchRequests: 8 };
    expect(auditServerToolFees(event({ requestId: "a", serverToolUsage: recounted }), publishedServerToolFees).status)
      .toBe("mismatch");
  });

  it("reports a fee-catalogue version mismatch instead of a false pricing error", () => {
    const bumped = structuredClone(publishedServerToolFees);
    bumped.entries[0]!.usdPerRequest = 0.02;
    expect(auditServerToolFees(event({ requestId: "a", serverToolUsage: usage }), bumped).status)
      .toBe("fee_catalogue_version_mismatch");
  });
});
