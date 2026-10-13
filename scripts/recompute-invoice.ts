/**
 * Recompute a FLUX invoice from a raw savings-ledger spool. This is the
 * customer-facing audit recipe: run it on your own JSONL file and the result
 * must reproduce FLUX's invoice to the cent, or FLUX does not get paid.
 *
 *   node --import tsx scripts/recompute-invoice.ts <ledger.jsonl> \
 *     [--period YYYY-MM] [--fee <percent>] [--fail-task <taskId>]... \
 *     [--reject-lever <leverId>]...
 *
 * Steps, all local and deterministic:
 *   1. Verify the hash chain; a perturbed, reordered or missing record is
 *      reported with its exact sequence number and the run fails.
 *   2. Recompute the invoice with `recomputeInvoice` (idempotent by requestId,
 *      so a spool replayed twice or late changes nothing).
 * The invoice is printed as canonical JSON: byte-identical inputs and options
 * produce byte-identical output.
 */
import { readFileSync } from "node:fs";
import {
  canonicalJson,
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../packages/core/src/index.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0]!.startsWith("--")) {
  fail("Usage: node --import tsx scripts/recompute-invoice.ts <ledger.jsonl> [--period YYYY-MM] [--fee <percent>] [--fail-task <taskId>]... [--reject-lever <leverId>]...");
}
const spoolPath = args[0]!;
let period: string | undefined;
let feePercent: number | undefined;
const failedTaskIds: string[] = [];
const gateVerdictOverrides: Record<string, "approved" | "rejected"> = {};
for (let index = 1; index < args.length; index += 2) {
  const flag = args[index]!;
  const value = args[index + 1];
  if (value === undefined) fail(`Missing value for ${flag}.`);
  if (flag === "--period") period = value;
  else if (flag === "--fee") feePercent = Number(value);
  else if (flag === "--fail-task") failedTaskIds.push(value);
  else if (flag === "--reject-lever") gateVerdictOverrides[value] = "rejected";
  else fail(`Unknown flag ${flag}.`);
}

const lines = readFileSync(spoolPath, "utf8").split("\n").filter((line) => line.trim() !== "");
const records: LedgerRecord[] = lines.map((line, index) => {
  try {
    return JSON.parse(line) as LedgerRecord;
  } catch {
    return fail(`Line ${index + 1} of ${spoolPath} is not valid JSON.`);
  }
});

const verification = verifyLedgerChain(records);
if (!verification.ok) {
  fail(`TAMPER DETECTED at seq ${verification.seq}: ${verification.reason}`);
}
console.error(`Hash chain verified: ${verification.length} record(s).`);

const events: BillableEvent[] = records.map((record) => record.event);
const invoice = recomputeInvoice(events, {
  ...(period === undefined ? {} : { period }),
  ...(feePercent === undefined ? {} : { feePercent }),
  ...(failedTaskIds.length === 0 ? {} : { failedTaskIds }),
  ...(Object.keys(gateVerdictOverrides).length === 0 ? {} : { gateVerdictOverrides }),
});
console.log(canonicalJson(invoice));
