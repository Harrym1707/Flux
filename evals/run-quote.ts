import { readFileSync, writeFileSync } from "node:fs";
import { buildQuoteReport, canonicalJson, publishedModelPrices, renderQuoteReport } from "../packages/core/src/index.js";

/** The pre-contract quote from a gateway export (LiteLLM/Helicone/Langfuse).
 *    node --import tsx evals/run-quote.ts <export-file> [--format litellm|helicone|langfuse] [--at YYYY-MM-DD] [--out quote.json] */
const args = process.argv.slice(2);
if (args.length === 0 || args[0]!.startsWith("--")) {
  console.error("usage: node --import tsx evals/run-quote.ts <export-file> [--format litellm|helicone|langfuse] [--at YYYY-MM-DD] [--out quote.json]");
  process.exit(1);
}
const file = args[0]!;
let format: "litellm" | "helicone" | "langfuse" = "litellm";
let at = new Date().toISOString().slice(0, 10);
let out: string | undefined;
for (let i = 1; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (value === undefined) { console.error(`missing value for ${flag}`); process.exit(1); }
  if (flag === "--format") format = value as typeof format;
  else if (flag === "--at") at = value;
  else if (flag === "--out") out = value;
  else { console.error(`unknown flag ${flag}`); process.exit(1); }
}
const text = readFileSync(file, "utf8").trim();
const rows = text.startsWith("[")
  ? JSON.parse(text)
  : text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
const report = buildQuoteReport(rows, { format, at, catalogue: publishedModelPrices });
console.log(renderQuoteReport(report));
if (out !== undefined) writeFileSync(out, `${canonicalJson(report)}\n`, "utf8");
