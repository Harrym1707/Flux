/**
 * The five-minute design-partner experience: a pre-contract savings quote from
 * their OWN gateway export, including the honest "do not pay us" verdict.
 *
 *   node --import tsx scripts/flux-quote.ts <export-file> \
 *     [--format litellm|helicone|langfuse] [--at YYYY-MM-DD] [--out quote.json]
 *
 * The export file is JSONL or a JSON array (LiteLLM spend logs, Helicone
 * request exports, Langfuse generation exports). Output is a human-readable
 * quote on stdout; --out additionally writes the full report as canonical JSON
 * (byte-stable for the same input), which is the shareable artifact.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildQuoteReport,
  canonicalJson,
  publishedModelPrices,
  renderQuoteReport,
  type QuoteExportFormat,
} from "../packages/core/src/index.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0]!.startsWith("--")) {
  fail("Usage: node --import tsx scripts/flux-quote.ts <export-file> [--format litellm|helicone|langfuse] [--at YYYY-MM-DD] [--out quote.json]");
}
const file = args[0]!;
let format: QuoteExportFormat = "litellm";
let at = new Date().toISOString().slice(0, 10);
let out: string | undefined;
for (let index = 1; index < args.length; index += 2) {
  const flag = args[index]!;
  const value = args[index + 1];
  if (value === undefined) fail(`Missing value for ${flag}.`);
  if (flag === "--format") {
    if (value !== "litellm" && value !== "helicone" && value !== "langfuse") fail(`Unknown format ${value}.`);
    format = value;
  } else if (flag === "--at") at = value;
  else if (flag === "--out") out = value;
  else fail(`Unknown flag ${flag}.`);
}

const text = readFileSync(file, "utf8").trim();
const rows: unknown[] = text.startsWith("[")
  ? (JSON.parse(text) as unknown[])
  : text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

const report = buildQuoteReport(rows, { format, at, catalogue: publishedModelPrices });
console.log(renderQuoteReport(report));
if (out !== undefined) {
  writeFileSync(out, `${canonicalJson(report)}\n`, "utf8");
  console.error(`\nShareable report written to ${out}`);
}
