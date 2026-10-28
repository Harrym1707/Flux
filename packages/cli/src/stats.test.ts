import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chainLedgerRecord, recomputeInvoice, type LedgerRecord } from "../../core/src/index.js";
import { computeStats, lastDays, parseSpool, pctFloor, renderStats, shareLine, usdFloor } from "./stats.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "__fixtures__", "stats-spool.jsonl");
const NOW = new Date("2026-10-28T12:00:00.000Z");
const spool = () => parseSpool("stats-spool.jsonl", readFileSync(FIXTURE, "utf8"));

describe("flux stats over the fixture spool", () => {
  it("matches recomputeInvoice exactly: the stats are the invoice, not a second opinion", () => {
    const loaded = spool();
    const stats = computeStats([loaded], { phrase: "so far" });
    const invoice = recomputeInvoice(loaded.records.map((record) => record.event));
    expect(stats.netSavedUsd).toBeCloseTo(invoice.netVerifiedSavingsUsd, 12);
    expect(stats.requests).toBe(invoice.eventsConsidered);
    expect(stats.allChainsOk).toBe(true);
  });

  it("counts requests once (replays ignored) and keeps measured and estimated apart", () => {
    const stats = computeStats([spool()], { phrase: "so far" });
    expect(stats.requests).toBe(6);
    expect(stats.measuredSavedUsd).toBeCloseTo(0.0144 + 0.0162 + 0.01, 12);
    expect(stats.estimatedSavedUsd).toBeCloseTo(0.002, 12);
    expect(stats.failedOrExcluded).toBe(1);
    expect(stats.exactCacheHits).toBe(1);
    expect(stats.cacheReadTokensOnFluxPlacedCache).toBe(17_000);
    expect(stats.estimatedInputTokensRemoved).toBe(1_000);
    // The failed request's 0.5 USD lever is never counted.
    expect(stats.levers.find((lever) => lever.leverId === "cache-ttl-5m")?.savedUsd).toBeCloseTo(0.0306, 12);
    expect(stats.unbilled).toEqual([
      { leverId: "output-style-concise", events: 1, reason: "no per-request verified measurement" },
    ]);
  });

  it("filters to a window and states the percentage against what would have been paid", () => {
    const stats = computeStats([spool()], lastDays(7, NOW));
    expect(stats.requests).toBe(5);
    expect(stats.spendUsd).toBeCloseTo(0.0149 + 0.011 + 0.006 + 0 + 0.0025, 12);
    expect(stats.measuredSavedPercent).toBeCloseTo(0.0262 / (0.0344 + 0.0262), 12);
  });

  it("--share prints a one-line brag string from MEASURED savings only, rounded down", () => {
    const line = shareLine(computeStats([spool()], lastDays(7, NOW)));
    expect(line).toEqual({
      ok: true,
      line: "FLUX saved me $0.0262 (43.2%) on 5 requests this week. Verified by a ledger I can recompute: fluxtoken.dev",
    });
  });

  it("--share refuses on a broken chain, with no number in the output", () => {
    const loaded = spool();
    const tampered = structuredClone(loaded.records) as LedgerRecord[];
    tampered[1]!.event.levers[0]!.savedUsd = 99;
    const result = shareLine(computeStats([{ name: "t.jsonl", records: tampered }], { phrase: "so far" }));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/BROKEN/);
    expect(renderStats(computeStats([{ name: "t.jsonl", records: tampered }], { phrase: "so far" })))
      .toContain("LEDGER CHAIN BROKEN");
  });

  it("--share refuses when the only savings are estimates", () => {
    const record = chainLedgerRecord({
      schemaVersion: 1, requestId: "e1", applicationId: "a", invoicePeriod: "2026-10",
      timestamp: "2026-10-27T00:00:00.000Z", provider: "anthropic", model: "claude-sonnet-5-5",
      executionMode: "standard", pricingStatus: "priced", actualUsd: 1, status: "succeeded",
      levers: [{ leverId: "tool-schema-compaction", kind: "lossless", savedUsd: 0.5, basis: "estimated-baseline" }],
    });
    const result = shareLine(computeStats([{ name: "e.jsonl", records: [record] }], { phrase: "so far" }));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/estimated-baseline savings are never shared/);
  });

  it("renders a terminal summary with labelled lines", () => {
    const text = renderStats(computeStats([spool()], { phrase: "so far" }));
    expect(text).toContain("Saved        $0.0426");
    expect(text).toContain("measured   $0.0406");
    expect(text).toContain("estimated-baseline");
    expect(text).toContain("cache-ttl-5m");
    expect(text).toContain("chain VERIFIED");
  });

  it("rounds money and percentages down, never up", () => {
    expect(usdFloor(0.02629)).toBe("$0.0262");
    expect(usdFloor(12.349)).toBe("$12.34");
    expect(usdFloor(1234.5)).toBe("$1,234.50");
    expect(usdFloor(-0.5)).toBe("-$0.5000");
    expect(pctFloor(0.43299)).toBe("43.2%");
  });

  it("rejects malformed spool lines with the line number", () => {
    expect(() => parseSpool("bad.jsonl", '{"seq":0}\nnot json\n')).toThrow("bad.jsonl:2");
  });
});

describe("flux stats CLI", () => {
  const main = join(here, "main.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", main, "stats", ...args], {
    cwd: join(here, "..", "..", ".."),
    encoding: "utf8",
  });

  it("prints the summary and the share line from a spool path", () => {
    const summary = run("--ledger", FIXTURE);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain("FLUX stats");
    const shared = run("--ledger", FIXTURE, "--share");
    expect(shared.status).toBe(0);
    expect(shared.stdout.trim()).toBe(
      "FLUX saved me $0.0406 (46.3%) on 6 requests so far. Verified by a ledger I can recompute: fluxtoken.dev",
    );
  });

  it("fails clearly when the ledger is missing", () => {
    const missing = run("--ledger", join(here, "does-not-exist"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No ledger at");
  });
});
