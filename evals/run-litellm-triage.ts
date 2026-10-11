import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  classifySegment,
  measureTraffic,
  parseLiteLLMSpendLogs,
  publishedModelPrices,
  quoteForSegment,
  reconcileLiteLLMSpend,
  signalsFromLiteLLM,
  trafficFingerprint,
  type LiteLLMRecord,
  type SegmentQuote,
} from "../packages/core/src/index.js";

/**
 * End-to-end LiteLLM triage, and the scorecard for the horizontal play.
 *
 * One spend-log export in, one quote per traffic stream out: which customer
 * shape each stream is (consumer app, application layer, in-house agent,
 * already optimised), what FLUX is honestly worth on it, and what the
 * customer's own gateway already saves them.
 *
 * The gates assert the horizontal claims specifically: each of the three
 * target segments classifies correctly from a single mixed export, gateway
 * cache hits never enter the baseline, stale gateway pricing is flagged, and
 * no quote claims a saving the measurement attributes to someone else.
 */

const AT = "2026-10-08";
const base = resolve(process.argv[2] ?? "sample-traffic");

const text = await readFile(resolve(base, "litellm-spend.jsonl"), "utf8");
const raw = text.trim().split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

const parsed = parseLiteLLMSpendLogs(raw, AT);
const reconciliation = reconcileLiteLLMSpend(parsed, publishedModelPrices);

// One triage per stream, streams being what the gateway already tags.
const streams = new Map<string, LiteLLMRecord[]>();
for (const entry of parsed.accepted) {
  const list = streams.get(entry.record.workload) ?? [];
  list.push(entry);
  streams.set(entry.record.workload, list);
}
const cacheHitsByStream = new Map<string, LiteLLMRecord[]>();
for (const entry of parsed.cacheHits) {
  const list = cacheHitsByStream.get(entry.record.workload) ?? [];
  list.push(entry);
  cacheHitsByStream.set(entry.record.workload, list);
}

type StreamReport = {
  stream: string;
  requests: number;
  baselineUsd: number;
  quote: SegmentQuote;
};

const reports: StreamReport[] = [];
for (const [stream, entries] of streams) {
  const measurement = measureTraffic(entries.map((entry) => entry.record), publishedModelPrices);
  const signals = signalsFromLiteLLM(entries, cacheHitsByStream.get(stream) ?? [], measurement);
  const classification = classifySegment(signals);
  reports.push({
    stream,
    requests: entries.length,
    baselineUsd: measurement.totalBaselineCostUsd,
    quote: quoteForSegment(classification, signals),
  });
}
reports.sort((left, right) => right.baselineUsd - left.baselineUsd);

console.log(`=== LiteLLM triage: ${parsed.accepted.length} provider calls, ` +
  `${parsed.cacheHits.length} gateway cache hits, ${parsed.issues.length} unreadable rows ===\n`);
for (const report of reports) {
  const quote = report.quote;
  console.log(`${report.stream} - ${quote.segment}`);
  console.log(`  requests ${report.requests}, baseline $${report.baselineUsd.toFixed(2)}`);
  console.log(`  quote: ${quote.bandPercent[0]}-${quote.bandPercent[1]}% via ${quote.topLever} ` +
    `[${quote.confidence}]${quote.doNotCharge ? " - DO NOT CHARGE" : ""}`);
  if (quote.firmUpBy) console.log(`  firm up by: ${quote.firmUpBy}`);
  for (const reason of quote.reasoning) console.log(`    - ${reason}`);
  console.log("");
}
console.log("=== spend reconciliation against published rates ===");
console.log(`compared ${reconciliation.comparedRows} rows: gateway reports ` +
  `$${reconciliation.reportedSpendUsd.toFixed(2)}, catalogue says ` +
  `$${reconciliation.catalogueCostUsd.toFixed(2)} (drift ${reconciliation.driftPercent.toFixed(1)}%)`);
console.log(`${reconciliation.flagged.length} rows flagged beyond tolerance; ` +
  `${reconciliation.unpricedRows} unpriced rows excluded, never zeroed`);
console.log(`gateway cache already saves the customer $${reconciliation.cacheHitSavedUsd.toFixed(2)} ` +
  `across ${reconciliation.cacheHitRows} hits - excluded from every quote above`);

// ---- gates ----
type Gate = { name: string; pass: boolean; detail: string };
const gates: Gate[] = [];
const byStream = new Map(reports.map((report) => [report.stream, report]));
const consumer = byStream.get("consumer-chat");
const saas = byStream.get("saas-docqa");
const agent = byStream.get("internal-agent");

gates.push({
  name: "all rows parsed",
  pass: parsed.issues.length === 0 && parsed.accepted.length === 310 && parsed.cacheHits.length === 20,
  detail: `${parsed.accepted.length} accepted, ${parsed.cacheHits.length} cache hits, ${parsed.issues.length} issues`,
});
gates.push({
  name: "three segments classified from one export",
  pass: consumer?.quote.segment === "consumer-app" &&
    saas?.quote.segment === "application-layer" &&
    agent?.quote.segment === "in-house-agent",
  detail: `consumer=${consumer?.quote.segment}, saas=${saas?.quote.segment}, agent=${agent?.quote.segment}`,
});
gates.push({
  name: "gateway cache hits never enter the baseline",
  pass: (saas?.requests ?? 0) === 100 && reconciliation.cacheHitRows === 20 &&
    reconciliation.cacheHitSavedUsd > 0,
  detail: `saas baseline ${saas?.requests} rows; ${reconciliation.cacheHitRows} hits valued at ` +
    `$${reconciliation.cacheHitSavedUsd.toFixed(2)} as the customer's existing saving`,
});
gates.push({
  name: "stale gateway pricing flagged",
  pass: reconciliation.flagged.length === 10 &&
    reconciliation.flagged.every((row) => row.driftPercent > 45 && row.driftPercent < 55),
  detail: `${reconciliation.flagged.length} rows flagged at ~+50% drift`,
});
gates.push({
  name: "agent quote bills output, not the provider's own caching",
  pass: agent !== undefined && /output/i.test(agent.quote.topLever) &&
    agent.quote.reasoning.some((reason) => /not ours to bill|provider's gift/i.test(reason)),
  detail: `top lever: ${agent?.quote.topLever}`,
});
gates.push({
  name: "saas quote finds the planted cache breaker",
  pass: saas !== undefined && /prefix repair/i.test(saas.quote.topLever) &&
    saas.quote.bandPercent[0] >= 35 && saas.quote.confidence === "measured-analogue",
  detail: `top lever: ${saas?.quote.topLever}, band ${saas?.quote.bandPercent.join("-")}%`,
});
gates.push({
  name: "consumer quote warns about TTL decay on sparse per-user traffic",
  pass: consumer !== undefined &&
    consumer.quote.reasoning.some((reason) => /expire|decay|600s/i.test(reason)),
  detail: consumer === undefined ? "stream missing" : "TTL caveat present",
});
gates.push({
  name: "deterministic",
  pass: trafficFingerprint(parsed.accepted.map((entry) => entry.record)) ===
    trafficFingerprint(parseLiteLLMSpendLogs(raw, AT).accepted.map((entry) => entry.record)),
  detail: trafficFingerprint(parsed.accepted.map((entry) => entry.record)),
});

console.log("");
let failed = 0;
for (const gate of gates) {
  if (!gate.pass) failed += 1;
  console.log(`${gate.pass ? "PASS" : "FAIL"}  ${gate.name.padEnd(48)} ${gate.detail}`);
}
console.log(`\n${gates.length - failed}/${gates.length} gates passed.`);
if (failed > 0) process.exit(1);
