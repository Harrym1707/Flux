import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { estimateLedger, runCompaction } from "./compaction.js";

/** A recorded event for a 12-turn Sonnet task; input grows ~2000 tokens a turn. */
function event(taskId: string, turnIndex: number, input: number, cached: boolean): BillableEvent {
  return {
    schemaVersion: 1,
    requestId: `${taskId}-${turnIndex}`,
    applicationId: "app",
    taskId,
    turnIndex,
    invoicePeriod: "2026-11",
    timestamp: new Date(1_700_000_000_000 + turnIndex * 20_000).toISOString(),
    provider: "anthropic",
    model: "claude-sonnet-5-5-latest",
    executionMode: "standard",
    pricingStatus: "priced",
    usage: {
      inputTokens: input,
      outputTokens: 400,
      cachedInputTokens: cached ? Math.max(0, input - 2_000) : 0,
      cacheWriteInputTokens: 0,
    },
    levers: [],
    status: "succeeded",
  };
}

function task(taskId: string, cached: boolean, turns = 12): BillableEvent[] {
  return Array.from({ length: turns }, (_, index) =>
    event(taskId, index + 1, 2_000 + (index + 1) * 4_000, cached));
}

const ARGS = { atTokens: 20_000, summaryTokens: 2_000, minTurns: 3, date: "2026-11-03", ledgerDir: "" };

describe("estimateLedger", () => {
  it("ranks tasks by net saving and reads the warm/cold split from the ledger", () => {
    const events = [...task("cold-task", false), ...task("warm-task", true)];
    const { estimates } = estimateLedger(events, ARGS);
    expect(estimates).toHaveLength(2);
    // Cold traffic paid full rate for the discarded context, so it ranks first.
    expect(estimates[0]!.taskId).toBe("cold-task");
    expect(estimates[0]!.worthwhile).toBe(true);
    const warm = estimates.find((e) => e.taskId === "warm-task")!;
    expect(warm.netSavingUsd).toBeLessThan(estimates[0]!.netSavingUsd);
  });

  it("counts why tasks were skipped instead of dropping them silently", () => {
    const events = [
      ...task("short", false, 2), // below --min-turns
      ...task("tiny", false, 5).map((e) => ({ ...e, usage: { ...e.usage!, inputTokens: 500 } })), // never hits trigger
    ];
    const { estimates, skipped } = estimateLedger(events, ARGS);
    expect(estimates).toHaveLength(0);
    expect(skipped.tooShort).toBe(1);
    expect(skipped.noTrigger).toBe(1);
  });

  it("skips tasks whose model is not in the price catalogue", () => {
    const events = task("mystery", false).map((e) => ({ ...e, model: "some-unlisted-model" }));
    const { estimates, skipped } = estimateLedger(events, ARGS);
    expect(estimates).toHaveLength(0);
    expect(skipped.unpriced).toBe(1);
  });
});

describe("runCompaction (reads a real chained spool)", () => {
  let dir: string;
  let ledger: string;
  const logs: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flux-compaction-"));
    ledger = join(dir, "ledger");
    mkdirSync(ledger, { recursive: true });
    logs.length = 0;
    spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.join(" ")); });
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpool(name: string, events: BillableEvent[]): void {
    let previous: LedgerRecord | undefined;
    const lines: string[] = [];
    for (const e of events) {
      previous = chainLedgerRecord(e, previous);
      lines.push(JSON.stringify(previous));
    }
    writeFileSync(join(ledger, name), `${lines.join("\n")}\n`);
  }

  it("reports a per-task table and the advisory caveat", async () => {
    writeSpool("cold-anthropic.jsonl", task("cold", false));
    writeSpool("warm-anthropic.jsonl", task("warm", true));
    await runCompaction(["--ledger", ledger, "--at-tokens", "20000", "--summary-tokens", "2000", "--date", "2026-11-03"]);
    const out = logs.join("\n");
    expect(out).toMatch(/flux compaction/);
    expect(out).toContain("cold");
    expect(out).toMatch(/net loss|leave uncompacted/); // the warm task
    expect(out).toMatch(/Advisory only/);
    expect(out).toMatch(/nothing here changes your ledger/);
  });

  it("says so plainly when the ledger is empty", async () => {
    await runCompaction(["--ledger", ledger]);
    expect(logs.join("\n")).toMatch(/No ledger events found/);
  });
});
