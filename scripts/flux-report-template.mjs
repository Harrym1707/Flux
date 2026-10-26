#!/usr/bin/env node
// Render a FLUX statement (self-contained HTML) from ledger spools.
// Usage: flux-report <spool.jsonl...> [--period YYYY-MM] [--fee 1] [--carry-forward 0] [--out flux-statement.html]
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { renderLedgerReport } from "../index.js";

const args = process.argv.slice(2);
const files = [];
let period;
let feePercent = 1;
let carryForwardDeficitUsd = 0;
let out = "flux-statement.html";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--period") period = args[++index];
  else if (arg === "--fee") feePercent = Number(args[++index]);
  else if (arg === "--carry-forward") carryForwardDeficitUsd = Number(args[++index]);
  else if (arg === "--out") out = args[++index];
  else files.push(arg);
}
if (files.length === 0) {
  console.error("Usage: flux-report <spool.jsonl...> [--period YYYY-MM] [--fee 1] [--carry-forward 0] [--out flux-statement.html]");
  process.exit(1);
}
if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
  console.error(`--fee must be a percentage between 0 and 100, got ${JSON.stringify(feePercent)}.`);
  process.exit(1);
}
if (period !== undefined && !/^\d{4}-\d{2}$/.test(period)) {
  console.error(`--period must be YYYY-MM, got ${JSON.stringify(period)}.`);
  process.exit(1);
}
const spools = files.map((file) => ({
  name: basename(file),
  records: readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)),
}));
if (!Number.isFinite(carryForwardDeficitUsd) || carryForwardDeficitUsd < 0) {
  console.error("--carry-forward must be a non-negative USD amount.");
  process.exit(1);
}
const html = renderLedgerReport(spools, { period, feePercent, carryForwardDeficitUsd });
writeFileSync(out, html, "utf8");
const verdict = html.includes("DO NOT PAY") ? "DO NOT PAY (chain broken)"
  : html.includes("do_not_charge") ? "do_not_charge" : "charge";
console.log(`statement written: ${out} (${spools.length} spool(s), verdict: ${verdict})`);
console.log("Verify independently: npx -y -p @flux-ai/verify flux-verify <spool.jsonl>");
