import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// Import from specific core modules, not the index barrel, so the lean client
// runtime bundle (see mesh-runtime.ts) does not pull in analyse-only code.
import {
  estimateCompactionFromLedger,
  ledgerTurnsByTask,
  type LedgerCompactionEstimate,
} from "../../core/src/cache-simulator.js";
import { lookupPrice, resolveModelId } from "../../core/src/price-catalogue.js";
import { publishedModelPrices } from "../../core/src/model-prices.js";
import type { BillableEvent } from "../../core/src/savings-ledger.js";
import { MESH_HOME, readLedger } from "./start.js";

/**
 * mesh compaction: read the recorded ledger and show, per task, what context
 * compaction would save — and where it would cost more than it saves.
 *
 * It runs entirely on token counts the ledger already holds; no prompt text is
 * read, because none is stored. The numbers are ADVISORY: they are counterfactual
 * ("what if this task had been compacted at turn K"), not the recomputable,
 * identical-byte savings the invoice bills on. The report says so, and nothing
 * here touches the ledger or the invoice.
 *
 * The honest result it surfaces: on cache-warm traffic, where the ledger shows
 * the repeated prefix was already being served from cache, compaction usually
 * costs more than it saves. It pays on cache-cold traffic, where every turn
 * re-sent the whole transcript at full price.
 */

const USAGE = `Usage: mesh compaction [options]

Read your recorded ledger and estimate what context compaction would save,
per multi-turn task. Advisory only — counterfactual, never billed.

  --ledger <dir>         Ledger directory to read. Default ~/.mesh/ledger.
  --at-tokens <n>        Compact at the first turn whose input reaches n tokens.
                         Default 60000 (a typical harness trigger).
  --summary-tokens <n>   Size of the summary that replaces the history. Default 2000.
  --prefix-tokens <n>    Preserved system/tool prefix. Default: inferred per task
                         as its smallest recorded input (a conservative floor).
  --min-turns <n>        Ignore tasks shorter than this. Default 3.
  --date <YYYY-MM-DD>    Pricing date for the catalogue lookup. Default: today.
  --json <path>          Write the full per-task estimate as JSON.
  --help                 Show this message.`;

type Args = {
  ledgerDir: string;
  atTokens: number;
  summaryTokens: number;
  prefixTokens?: number;
  minTurns: number;
  date: string;
  json?: string;
};

function parse(argv: string[]): Args {
  const args: Args = {
    ledgerDir: join(MESH_HOME, "ledger"),
    atTokens: 60_000,
    summaryTokens: 2_000,
    minTurns: 3,
    date: new Date().toISOString().slice(0, 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    index += 1;
    switch (key) {
      case "--ledger": args.ledgerDir = resolve(value); break;
      case "--at-tokens": args.atTokens = Number(value); break;
      case "--summary-tokens": args.summaryTokens = Number(value); break;
      case "--prefix-tokens": args.prefixTokens = Number(value); break;
      case "--min-turns": args.minTurns = Number(value); break;
      case "--date": args.date = value; break;
      case "--json": args.json = resolve(value); break;
      default: throw new Error(`Unknown option: ${key}`);
    }
  }
  for (const [name, value] of [
    ["--at-tokens", args.atTokens], ["--summary-tokens", args.summaryTokens],
    ["--min-turns", args.minTurns], ...(args.prefixTokens === undefined ? [] : [["--prefix-tokens", args.prefixTokens] as const]),
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must be YYYY-MM-DD.");
  return args;
}

type TaskEstimate = LedgerCompactionEstimate & { model: string };

/** Per task: the model and the turn at which input first reaches the trigger. */
function modelByTask(events: readonly BillableEvent[]): Map<string, { provider: string; model: string }> {
  const map = new Map<string, { provider: string; model: string }>();
  for (const event of events) {
    if (event.taskId === undefined || map.has(event.taskId)) continue;
    map.set(event.taskId, { provider: event.provider, model: event.model });
  }
  return map;
}

export function estimateLedger(events: readonly BillableEvent[], args: Args): {
  estimates: TaskEstimate[];
  skipped: { unpriced: number; noTrigger: number; tooShort: number };
} {
  const byTask = ledgerTurnsByTask(events);
  const models = modelByTask(events);
  const estimates: TaskEstimate[] = [];
  const skipped = { unpriced: 0, noTrigger: 0, tooShort: 0 };

  for (const [key, turns] of byTask) {
    if (turns.length < args.minTurns) { skipped.tooShort += 1; continue; }
    // First turn whose recorded input reaches the trigger is where a harness
    // would compact; it must be past turn 1 to have history to discard.
    const triggerIndex = turns.findIndex((turn) => turn.inputTokens >= args.atTokens);
    const atTurn = triggerIndex < 1 ? (triggerIndex === 0 ? 2 : -1) : triggerIndex + 1;
    if (atTurn < 2) { skipped.noTrigger += 1; continue; }

    const meta = models.get(key);
    // Resolve the recorded model id to a catalogue key (as `mesh analyse` does),
    // then price against it; an unresolved or uncatalogued model is skipped.
    const resolved = meta
      ? resolveModelId(publishedModelPrices, meta.provider, meta.model)
      : ({ status: "unresolved" } as const);
    const lookup = resolved.status === "resolved"
      ? lookupPrice(publishedModelPrices, { provider: meta!.provider, model: resolved.model, at: args.date })
      : ({ status: "unpriced" } as const);
    if (lookup.status === "unpriced") { skipped.unpriced += 1; continue; }

    const estimate = estimateCompactionFromLedger(
      turns,
      {
        atTurn,
        summaryTokens: args.summaryTokens,
        ...(args.prefixTokens === undefined ? {} : { preservedPrefixTokens: args.prefixTokens }),
      },
      lookup.price,
    );
    estimates.push({ ...estimate, model: resolved.status === "resolved" ? resolved.model : meta!.model });
  }

  estimates.sort((left, right) => right.netSavingUsd - left.netSavingUsd);
  return { estimates, skipped };
}

function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(4)}`;
}

export async function runCompaction(argv: string[]): Promise<void> {
  const args = parse(argv);
  const { records, chainOk, brokenAt } = readLedger(args.ledgerDir);

  if (records.length === 0) {
    console.log(`No ledger events found in ${args.ledgerDir}.`);
    console.log(`Run some traffic through "mesh start" first, then try again.`);
    return;
  }
  if (!chainOk) {
    console.log(`⚠ Ledger hash-chain check failed at ${brokenAt}. Run "mesh verify" before trusting these numbers.`);
  }

  const { estimates, skipped } = estimateLedger(records.map((record) => record.event), args);

  if (args.json !== undefined) {
    writeFileSync(args.json, `${JSON.stringify(estimates, null, 2)}\n`);
  }

  if (estimates.length === 0) {
    console.log(`No multi-turn task reached ${args.atTokens.toLocaleString()} input tokens, so nothing would have been compacted.`);
    console.log(`Lower --at-tokens to explore smaller tasks. (${records.length} events read.)`);
    return;
  }

  const totalRecorded = estimates.reduce((sum, e) => sum + e.recordedCostUsd, 0);
  const totalNet = estimates.reduce((sum, e) => sum + e.netSavingUsd, 0);
  const wins = estimates.filter((e) => e.worthwhile).length;

  console.log(`mesh compaction — advisory estimate on ${estimates.length} task(s), ${records.length} recorded events.`);
  console.log(`Trigger: compact at the first turn ≥ ${args.atTokens.toLocaleString()} tokens; summary ${args.summaryTokens.toLocaleString()} tokens.\n`);
  console.log(`  ${"task".padEnd(20)} ${"turns".padStart(5)} ${"at".padStart(3)} ${"recorded".padStart(10)} ${"net".padStart(10)}  verdict`);
  for (const e of estimates) {
    const label = (e.taskId ?? "—").slice(0, 20).padEnd(20);
    const verdict = e.worthwhile
      ? `save ${e.savingPercent.toFixed(0)}% (break-even +${e.breakEvenTurns ?? "?"})`
      : `net loss ${e.savingPercent.toFixed(0)}% — leave uncompacted`;
    console.log(`  ${label} ${String(e.turns).padStart(5)} ${String(e.compactionTurn).padStart(3)} ${money(e.recordedCostUsd).padStart(10)} ${money(e.netSavingUsd).padStart(10)}  ${verdict}`);
  }
  console.log(`\n  ${wins}/${estimates.length} task(s) worth compacting.`);
  console.log(`  Recorded cost on these tasks: ${money(totalRecorded)}. Net if all compacted: ${money(totalNet)}.`);
  if (skipped.noTrigger + skipped.tooShort + skipped.unpriced > 0) {
    console.log(`  Skipped: ${skipped.noTrigger} below the trigger, ${skipped.tooShort} too short, ${skipped.unpriced} unpriced.`);
  }
  console.log(`\n  Advisory only: counterfactual savings, valued at the rate the ledger shows you paid.`);
  console.log(`  Not the identical-byte savings the invoice bills on — nothing here changes your ledger.`);
}
