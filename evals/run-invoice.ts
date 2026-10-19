import { readFileSync } from "node:fs";
import { recomputeInvoice, verifyLedgerChain, type LedgerRecord } from "../packages/core/src/index.js";

/** Recompute the invoice from a ledger spool: the customer's audit command.
 *    node --import tsx evals/run-invoice.ts <spool.jsonl>                  */
const path = process.argv[2];
if (!path) { console.error("usage: node --import tsx evals/run-invoice.ts <spool.jsonl>"); process.exit(1); }
const records = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line) as LedgerRecord);
const chain = verifyLedgerChain(records);
if (!chain.ok) { console.error(`CHAIN BROKEN at seq ${chain.seq}: ${chain.reason}`); process.exit(1); }
console.log(`chain verified: ${chain.length} records`);
const invoice = recomputeInvoice(records.map((r) => r.event));
console.log(JSON.stringify(invoice, null, 2));
