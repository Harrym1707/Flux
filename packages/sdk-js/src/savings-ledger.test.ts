import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogueVersion,
  publishedModelPrices,
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";
import { billableEventFromRequest, createSavingsLedger } from "./savings-ledger.js";
import type { FluxRequestEvent } from "./types.js";

type AnyObject = Record<string, any>;

function stubClient(response: AnyObject) {
  return {
    responses: {
      create: async (_request: AnyObject) => structuredClone(response),
    },
  };
}

const flexResponse = {
  output_text: "ok",
  service_tier: "batch",
  usage: {
    input_tokens: 1_000_000,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  },
};

function requestEvent(overrides: Partial<FluxRequestEvent>): FluxRequestEvent {
  return {
    requestId: "req-1",
    applicationId: "app",
    provider: "openai-compatible",
    model: "gpt-6-astra",
    latencyMs: 1,
    status: "succeeded",
    timestamp: "2026-10-13T10:00:00.000Z",
    inputTokens: 1_000_000,
    outputTokens: 0,
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    ...overrides,
  };
}

describe("createSavingsLedger wired into withFlux", () => {
  it("appends one hash-chained billable event per request, priced from the RESPONSE tier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-ledger-"));
    const path = join(dir, "ledger.jsonl");
    const client = withFlux(stubClient(flexResponse), {
      applicationId: "meter-test",
      ledger: { path, provider: "openai" },
    });
    const response = await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    expect(response.output_text).toBe("ok");

    const records: LedgerRecord[] = readFileSync(path, "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(1);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 1 });
    const billed = records[0]!.event;
    expect(billed.executionMode).toBe("batch");
    expect(billed.pricingStatus).toBe("priced");
    expect(billed.actualUsd).toBe(5);
    expect(billed.catalogueVersion).toBe(catalogueVersion(publishedModelPrices));
    expect(billed.levers).toEqual([{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }]);

    // The spool replayed twice recomputes to the same invoice (idempotent by requestId).
    const invoice = recomputeInvoice([billed, billed]);
    expect(invoice.duplicatesIgnored).toBe(1);
    expect(invoice.netVerifiedSavingsUsd).toBe(5);
  });

  it("resumes the chain across ledger instances instead of restarting at genesis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-ledger-"));
    const path = join(dir, "ledger.jsonl");
    for (let run = 0; run < 2; run += 1) {
      const client = withFlux(stubClient(flexResponse), {
        applicationId: "meter-test",
        ledger: { path, provider: "openai" },
      });
      await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    }
    const records: LedgerRecord[] = readFileSync(path, "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(2);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 2 });
  });

  it("never throws into the request path: an unwritable spool leaves the response untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-ledger-"));
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "occupied", "utf8");
    const client = withFlux(stubClient(flexResponse), {
      applicationId: "meter-test",
      // Parent "directory" is a regular file, so every append fails.
      ledger: { path: join(blocker, "ledger.jsonl") },
    });
    const response = await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    expect(response.output_text).toBe("ok");
  });

  it("goes quiet rather than extending a corrupt chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-ledger-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "{not json\n", "utf8");
    const ledger = createSavingsLedger({ path });
    ledger.emit(requestEvent({}));
    expect(readFileSync(path, "utf8")).toBe("{not json\n");
  });
});

describe("billableEventFromRequest", () => {
  const version = catalogueVersion(publishedModelPrices);

  it("bills zero tier savings when a flex request fell back: the response tier is standard", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        responseServiceTier: "default",
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "execution-tier-flex", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    expect(billed.executionMode).toBe("standard");
    expect(billed.levers.filter((lever) => lever.kind === "tier")).toHaveLength(0);
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("records the exact-cache avoidance at the originally measured cost", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        cacheHit: true,
        costAvoidedUsd: 0.42,
        inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      }),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    expect(billed.actualUsd).toBe(0);
    expect(billed.levers).toContainEqual({ leverId: "exact-response-cache", kind: "exact_cache", savedUsd: 0.42 });
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0.42);
  });

  it("nets the 1h cache stamp's write surcharge as negative savings when no reads earn it back", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "cache-ttl-1h", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    expect(billed.levers).toContainEqual({ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -0.5 });
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBeCloseTo(-0.5, 10);
  });

  it("excludes cache discounts the customer already had instead of billing them", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0,
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    expect(billed.excluded?.providerCacheAlreadyOwnedUsd).toBeCloseTo(1.9, 10);
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("bills the measured counterfactual delta only when every applied lossy lever is gate-approved", () => {
    const base = requestEvent({
      reduction: {
        estimatedTokensBefore: 2_000_000, estimatedTokensAfter: 1_000_000, estimatedTokensSaved: 1_000_000,
        estimatedLosslessTokensSaved: 0, skipped: false,
        changes: [{ lever: "fresh-tool-result-cap", lossless: false, estimatedTokensSaved: 1_000_000, detail: "" }],
      },
    });
    const approved = billableEventFromRequest(
      base,
      {
        path: "unused",
        getBaselineUsd: () => 20,
        gateVerdicts: { "fresh-tool-result-cap": { ref: "replay-gate/freshcap@cbbffb9", verdict: "approved" } },
      },
      publishedModelPrices,
      version,
    );
    // baseline 20 USD minus actual 10 USD (1M input at gpt-6-astra standard).
    expect(recomputeInvoice([approved]).netVerifiedSavingsUsd).toBe(10);

    const unapproved = billableEventFromRequest(
      base,
      { path: "unused", getBaselineUsd: () => 20 },
      publishedModelPrices,
      version,
    );
    expect(recomputeInvoice([unapproved]).netVerifiedSavingsUsd).toBe(0);
  });

  it("stores the correlation so a failed task's turns can be excluded", () => {
    const turn = (requestId: string, turnIndex: number, status: "succeeded" | "failed") =>
      billableEventFromRequest(
        requestEvent({ requestId, status, responseServiceTier: "batch" }),
        { path: "unused", getCorrelation: () => ({ taskId: "task-1", turnIndex }) },
        publishedModelPrices,
        version,
      );
    const events = [turn("r1", 1, "succeeded"), turn("r2", 2, "succeeded"), turn("r3", 4, "failed")];
    expect(events[0]!.taskId).toBe("task-1");
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0);
    expect(invoice.eventsExcludedForFailedTasks).toBe(3);
  });
});
