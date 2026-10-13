import { describe, expect, it } from "vitest";
import { catalogueVersion, validatePriceCatalogue, type PriceCatalogue } from "./price-catalogue.js";
import { publishedModelPrices } from "./model-prices.js";
import {
  auditEventPricing,
  chainLedgerRecord,
  priceLedgerUsage,
  recomputeInvoice,
  recomputeInvoiceWithAudit,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "./savings-ledger.js";

function event(overrides: Partial<BillableEvent> & { requestId: string }): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-13T10:00:00.000Z",
    provider: "openai",
    model: "gpt-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

describe("recomputeInvoice", () => {
  it("is deterministic: same events, shuffled or replayed twice, yield a byte-identical invoice", () => {
    const events = [
      event({ requestId: "b", levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1.25 }] }),
      event({ requestId: "a", levers: [{ leverId: "exact-response-cache", kind: "exact_cache", savedUsd: 0.4 }] }),
      event({ requestId: "c", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -0.1 }] }),
    ];
    const first = JSON.stringify(recomputeInvoice(events));
    const shuffled = JSON.stringify(recomputeInvoice([events[2]!, events[0]!, events[1]!]));
    const replayedTwice = JSON.stringify(recomputeInvoice([...events, ...events]));
    expect(shuffled).toBe(first);
    expect(replayedTwice).toBe(first);
    // Replay metadata lives in the audit object, never in the canonical
    // invoice: a doubled spool must be byte-identical billing, and the audit
    // trail still shows the replays were seen and dropped.
    expect(recomputeInvoiceWithAudit([...events, ...events]).audit.duplicatesIgnored).toBe(3);
    expect(recomputeInvoiceWithAudit(events).audit.duplicatesIgnored).toBe(0);
    // A spool replayed 25 hours late carries the same per-event invoicePeriod
    // stamps, so the period query result cannot drift either.
    const late = JSON.stringify(recomputeInvoice([...events, ...events], { period: "2026-10" }));
    const onTime = JSON.stringify(recomputeInvoice(events, { period: "2026-10" }));
    expect(late).toBe(onTime);
  });

  it("nets negative savings instead of clamping, and returns do_not_charge when nothing is owed", () => {
    const events = [
      event({ requestId: "r1", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -0.5 }] }),
      event({ requestId: "r2", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: 0.2 }] }),
    ];
    const invoice = recomputeInvoice(events, { feePercent: 25 });
    expect(invoice.netVerifiedSavingsUsd).toBeCloseTo(-0.3, 10);
    expect(invoice.lineItems[0]!.savedUsd).toBeCloseTo(-0.3, 10);
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueUsd).toBe(0);
  });

  it("never bills the customer's existing savings (provider cache on history, gateway cache)", () => {
    const events = [
      event({
        requestId: "r1",
        levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1 }],
        excluded: { providerCacheAlreadyOwnedUsd: 3.7, gatewayCacheUsd: 2.2 },
      }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(1);
    expect(invoice.excludedAlreadyOwned.providerCacheOnAppendedHistoryUsd).toBe(3.7);
    expect(invoice.excludedAlreadyOwned.gatewayCacheUsd).toBe(2.2);
  });

  it("bills a lossy lever only with an approved gate verdict, and an override flips it off without event mutation", () => {
    const events = [
      event({
        requestId: "r1",
        levers: [{
          leverId: "fresh-tool-result-cap",
          kind: "lossy",
          savedUsd: 2,
          gateVerdict: { ref: "replay-gate/freshcap@cbbffb9", verdict: "approved" },
        }],
      }),
      event({
        requestId: "r2",
        levers: [{ leverId: "output-cap", kind: "lossy", savedUsd: 5 }],
      }),
    ];
    const serialized = JSON.stringify(events);
    const approved = recomputeInvoice(events);
    expect(approved.netVerifiedSavingsUsd).toBe(2);
    expect(approved.lineItems[0]!.gateVerdictRefs).toEqual(["replay-gate/freshcap@cbbffb9"]);
    expect(approved.recordedUnbilled).toEqual([
      { leverId: "output-cap", kind: "lossy", events: 1, reason: "no approved replay gate verdict" },
    ]);
    const flipped = recomputeInvoice(events, {
      gateVerdictOverrides: { "fresh-tool-result-cap": "rejected" },
    });
    expect(flipped.netVerifiedSavingsUsd).toBe(0);
    expect(flipped.verdict).toBe("do_not_charge");
    expect(JSON.stringify(events)).toBe(serialized);
  });

  it("records levers without a verified per-request measurement but never bills them", () => {
    const events = [
      event({ requestId: "r1", levers: [{ leverId: "tool-schema-compaction", kind: "lossless" }] }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0);
    expect(invoice.recordedUnbilled[0]!.reason).toBe("no per-request verified measurement");
  });

  it("excludes every turn of a task that failed, including turns that appeared to save", () => {
    const events = [
      event({ requestId: "t1", taskId: "task-9", turnIndex: 1, levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1 }] }),
      event({ requestId: "t2", taskId: "task-9", turnIndex: 4, status: "failed", levers: [] }),
      event({ requestId: "ok", taskId: "task-10", levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 0.5 }] }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0.5);
    expect(invoice.failedTaskIds).toEqual(["task-9"]);
    expect(invoice.eventsExcludedForFailedTasks).toBe(2);
    // Out-of-band quality failure (graded after the fact) excludes the same way.
    const graded = recomputeInvoice(events, { failedTaskIds: ["task-10"] });
    expect(graded.netVerifiedSavingsUsd).toBe(0);
  });

  it("filters by the period stamped on each event at write time", () => {
    const events = [
      event({ requestId: "r1", invoicePeriod: "2026-09", levers: [{ leverId: "x", kind: "tier", savedUsd: 1 }] }),
      event({ requestId: "r2", invoicePeriod: "2026-10", levers: [{ leverId: "x", kind: "tier", savedUsd: 2 }] }),
    ];
    expect(recomputeInvoice(events, { period: "2026-09" }).netVerifiedSavingsUsd).toBe(1);
    expect(recomputeInvoice(events, { period: "2026-10" }).netVerifiedSavingsUsd).toBe(2);
  });
});

describe("ledger hash chain", () => {
  it("verifies an intact chain and names the exact record that was perturbed", () => {
    const records: LedgerRecord[] = [];
    for (const id of ["a", "b", "c"]) {
      records.push(chainLedgerRecord(
        event({ requestId: id, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 } }),
        records[records.length - 1],
      ));
    }
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 3 });
    const perturbed = structuredClone(records);
    perturbed[1]!.event.usage!.inputTokens = 11;
    const verdict = verifyLedgerChain(perturbed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.seq).toBe(1);
    const reordered = [records[0]!, records[2]!, records[1]!];
    expect(verifyLedgerChain(reordered).ok).toBe(false);
  });
});

describe("priceLedgerUsage", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };

  it("prices the execution-tier delta from catalogued rates on actual tokens", () => {
    const priced = priceLedgerUsage(publishedModelPrices, {
      provider: "openai",
      model: "gpt-6-astra",
      at: "2026-10-13",
      executionMode: "batch",
      usage,
      fluxPlacedCacheControl: false,
    });
    expect(priced).toEqual({ pricingStatus: "priced", actualUsd: 5, tierSavedUsd: 5 });
  });

  it("returns unpriced, never zero, when the actual mode has no catalogued rate", () => {
    const priced = priceLedgerUsage(publishedModelPrices, {
      provider: "openai",
      // gpt-4o has no flex rate catalogued (gpt-5 does), so flex must be unpriced.
      model: "gpt-4o",
      at: "2026-10-13",
      executionMode: "flex",
      usage,
      fluxPlacedCacheControl: false,
    });
    expect(priced.pricingStatus).toBe("unpriced");
  });

  it("attributes cache economics to FLUX only when FLUX placed the cache_control, writes netted negative", () => {
    const writeHeavy = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000 };
    const fluxPlaced = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: writeHeavy,
      fluxPlacedCacheControl: true,
    });
    // FLUX stamped the 1h TTL and the provider reported no TTL split, so EVERY
    // write prices at the 1h premium (Sonnet 5.5: 4 vs input 2 per million) -
    // the dispute-safe reading. All writes, no reads => the surcharge shows as
    // NEGATIVE attributed savings, not clamped.
    expect(fluxPlaced).toEqual({ pricingStatus: "priced", actualUsd: 4, cacheAttributedUsd: -2 });

    // A reported split prices each bucket at its own rate: 5m at 1.25x, 1h at 2x.
    const splitReported = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: {
        inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        cacheWrite5mInputTokens: 600_000, cacheWrite1hInputTokens: 400_000,
      },
      fluxPlacedCacheControl: true,
    });
    // 0.6M at 2.5 + 0.4M at 4 = 1.5 + 1.6 = 3.1 USD.
    expect(splitReported).toEqual({ pricingStatus: "priced", actualUsd: 3.1, cacheAttributedUsd: -1.1 });

    // A split that does not sum to the total is a provider-usage inconsistency:
    // the event is unpriced, never silently repaired.
    const mismatch = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: {
        inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        cacheWrite5mInputTokens: 600_000, cacheWrite1hInputTokens: 100_000,
      },
      fluxPlacedCacheControl: true,
    });
    expect(mismatch.pricingStatus).toBe("unpriced");

    const customerOwned = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0 },
      fluxPlacedCacheControl: false,
    });
    expect(customerOwned).toEqual({
      pricingStatus: "priced",
      actualUsd: 0.1,
      providerCacheAlreadyOwnedUsd: 1.9,
    });
  });
});

describe("catalogue pinning", () => {
  it("hashes catalogue content, so a rate change changes the version", () => {
    const bumped: PriceCatalogue = validatePriceCatalogue(structuredClone(publishedModelPrices));
    bumped.entries[0]!.tiers[0]!.inputPerMillion += 1;
    expect(catalogueVersion(bumped)).not.toBe(catalogueVersion(publishedModelPrices));
    expect(catalogueVersion(publishedModelPrices)).toBe(catalogueVersion(structuredClone(publishedModelPrices)));
  });

  it("leaves historical invoices unchanged when the catalogue is bumped, and the audit names the version mismatch", () => {
    const version = catalogueVersion(publishedModelPrices);
    const events = [event({
      requestId: "r1",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      catalogueVersion: version,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 5,
      levers: [{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }],
    })];
    const before = JSON.stringify(recomputeInvoice(events));
    expect(auditEventPricing(events[0]!, publishedModelPrices)).toEqual({ status: "verified" });

    const bumped: PriceCatalogue = validatePriceCatalogue(structuredClone(publishedModelPrices));
    bumped.entries[0]!.tiers[0]!.inputPerMillion += 1;
    // The invoice reads only stored, version-pinned figures: byte-identical after the bump.
    expect(JSON.stringify(recomputeInvoice(events))).toBe(before);
    const audit = auditEventPricing(events[0]!, bumped);
    expect(audit.status).toBe("catalogue_version_mismatch");
  });

  it("flags a stored cost that the pinned catalogue cannot reproduce, with zero tolerance", () => {
    const tampered = event({
      requestId: "r1",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      catalogueVersion: catalogueVersion(publishedModelPrices),
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 4.999999,
      levers: [],
    });
    const audit = auditEventPricing(tampered, publishedModelPrices);
    expect(audit.status).toBe("mismatch");
  });
});
