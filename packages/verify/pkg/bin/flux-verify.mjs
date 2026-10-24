#!/usr/bin/env node
// Verify a FLUX ledger spool and recompute its invoice — independently.
// Usage: flux-verify <spool.jsonl>
// Exit 0: chain intact, invoice printed. Exit 1: broken chain or unreadable spool.
import { readFileSync } from "node:fs";
import { recomputeInvoice, verifyLedgerChain } from "../index.js";

const spoolPath = process.argv[2];
if (!spoolPath) {
  console.error("Usage: flux-verify <spool.jsonl>   (a FLUX ledger file, e.g. flux-ledger/proxy-anthropic.jsonl)");
  process.exit(1);
}
let records;
try {
  records = readFileSync(spoolPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (cause) {
  console.error(`Could not read ${spoolPath}: ${cause.message}`);
  process.exit(1);
}
const chain = verifyLedgerChain(records);
if (!chain.ok) {
  console.error(`CHAIN BROKEN at seq ${chain.seq}: ${chain.reason}`);
  console.error("This spool has been altered or corrupted since it was written. Do not pay an invoice computed from it.");
  process.exit(1);
}
console.log(`chain verified: ${chain.length} record(s), every hash links`);
const invoice = recomputeInvoice(records.map((record) => record.event));
console.log(JSON.stringify(invoice, null, 2));
console.log(`\nverdict: ${invoice.verdict} — net verified savings $${invoice.netVerifiedSavingsUsd.toFixed(4)}`);
console.log("If FLUX quoted you a different number from this same file, FLUX is wrong: this recomputation is the contract.");
