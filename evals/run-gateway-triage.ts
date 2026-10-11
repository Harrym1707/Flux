import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  classifySegment,
  groupByStream,
  measureTraffic,
  parseHeliconeRequests,
  parseLangfuseGenerations,
  publishedModelPrices,
  quoteForSegment,
  reconcileGatewaySpend,
  signalsFromGateway,
  trafficFingerprint,
  type GatewayParseResult,
  type SegmentQuote,
} from "../packages/core/src/index.js";

/**
 * Helicone and Langfuse exports through the same triage engine as LiteLLM, and
 * the gates for what each connector must specifically get right: Helicone's
 * provider-cache columns driving the already-optimised verdict, its own cache
 * hits staying out of the baseline, Langfuse spans skipped not errored,
 * usage-only generations still classifiable, and a stale Langfuse model price
 * flagged by reconciliation.
 */

const AT = "2026-10-08";
const base = resolve(process.argv[2] ?? "sample-traffic");

async function readJsonl(name: string): Promise<unknown[]> {
  const text = await readFile(resolve(base, name), "utf8");
  return text.trim().split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

type StreamReport = { stream: string; requests: number; baselineUsd: number; quote: SegmentQuote };

function triage(parsed: GatewayParseResult): StreamReport[] {
  const cacheHitsByStream = groupByStream(parsed.cacheHits);
  const reports: StreamReport[] = [];
  for (const [stream, entries] of groupByStream(parsed.accepted)) {
    const measurement = measureTraffic(entries.map((entry) => entry.record), publishedModelPrices);
    const signals = signalsFromGateway(entries, cacheHitsByStream.get(stream) ?? [], measurement);
    reports.push({
      stream,
      requests: entries.length,
      baselineUsd: measurement.totalBaselineCostUsd,
      quote: quoteForSegment(classifySegment(signals), signals),
    });
  }
  return reports.sort((left, right) => right.baselineUsd - left.baselineUsd);
}

const heliconeRaw = await readJsonl("helicone-requests.jsonl");
const langfuseRaw = await readJsonl("langfuse-generations.jsonl");
const helicone = parseHeliconeRequests(heliconeRaw, AT);
const langfuse = parseLangfuseGenerations(langfuseRaw, AT);
const heliconeReports = triage(helicone);
const langfuseReports = triage(langfuse);
const heliconeReconciliation = reconcileGatewaySpend(helicone, publishedModelPrices);
const langfuseReconciliation = reconcileGatewaySpend(langfuse, publishedModelPrices);

for (const [name, parsed, reports, reconciliation] of [
  ["Helicone", helicone, heliconeReports, heliconeReconciliation],
  ["Langfuse", langfuse, langfuseReports, langfuseReconciliation],
] as const) {
  console.log(`=== ${name}: ${parsed.accepted.length} provider calls, ` +
    `${parsed.cacheHits.length} tool cache hits, ${parsed.issues.length} unreadable rows ===`);
  for (const report of reports) {
    const quote = report.quote;
    console.log(`  ${report.stream} - ${quote.segment}: ${quote.bandPercent[0]}-${quote.bandPercent[1]}% ` +
      `via ${quote.topLever} [${quote.confidence}]${quote.doNotCharge ? " - DO NOT CHARGE" : ""}`);
  }
  console.log(`  reconciliation: reported $${reconciliation.reportedSpendUsd.toFixed(2)} vs catalogue ` +
    `$${reconciliation.catalogueCostUsd.toFixed(2)} (drift ${reconciliation.driftPercent.toFixed(1)}%), ` +
    `${reconciliation.flagged.length} rows flagged, tool cache saves ` +
    `$${reconciliation.cacheHitSavedUsd.toFixed(2)}\n`);
}

type Gate = { name: string; pass: boolean; detail: string };
const gates: Gate[] = [];
const heliconeByStream = new Map(heliconeReports.map((report) => [report.stream, report]));
const supportBot = heliconeByStream.get("support-bot");
const mobileApp = heliconeByStream.get("mobile-app");
const agent = langfuseReports.find((report) => report.stream === "checkout-agent");

gates.push({
  name: "helicone parses cleanly",
  pass: helicone.issues.length === 0 && helicone.accepted.length === 180 && helicone.cacheHits.length === 15,
  detail: `${helicone.accepted.length} accepted, ${helicone.cacheHits.length} cache hits, ` +
    `${helicone.issues.length} issues`,
});
gates.push({
  name: "provider cache columns drive already-optimised",
  pass: supportBot?.quote.segment === "already-optimised" && supportBot.quote.doNotCharge === true,
  detail: `support-bot = ${supportBot?.quote.segment}`,
});
gates.push({
  name: "consumer shape recognised from Helicone users and sessions",
  pass: mobileApp?.quote.segment === "consumer-app",
  detail: `mobile-app = ${mobileApp?.quote.segment}`,
});
gates.push({
  name: "helicone cache hits excluded and valued",
  pass: (mobileApp?.requests ?? 0) === 120 && heliconeReconciliation.cacheHitRows === 15 &&
    heliconeReconciliation.cacheHitSavedUsd > 0,
  detail: `baseline ${mobileApp?.requests} rows, 15 hits worth ` +
    `$${heliconeReconciliation.cacheHitSavedUsd.toFixed(2)}`,
});
gates.push({
  name: "helicone spend reconciles at provider-cached rates",
  pass: Math.abs(heliconeReconciliation.driftPercent) < 2 && heliconeReconciliation.flagged.length === 0,
  detail: `drift ${heliconeReconciliation.driftPercent.toFixed(2)}%, ` +
    `${heliconeReconciliation.flagged.length} flagged`,
});
gates.push({
  name: "langfuse spans skipped, generations kept",
  pass: langfuse.issues.length === 0 && langfuse.accepted.length === 50,
  detail: `${langfuse.accepted.length} generations, ${langfuse.issues.length} issues from 60 rows`,
});
gates.push({
  name: "usage-only langfuse traffic still classifies as an agent",
  pass: agent?.quote.segment === "in-house-agent" && /output/i.test(agent.quote.topLever),
  detail: `checkout-agent = ${agent?.quote.segment} via ${agent?.quote.topLever}`,
});
gates.push({
  name: "stale langfuse model price flagged",
  pass: langfuseReconciliation.flagged.length === 8 &&
    langfuseReconciliation.flagged.every((row) => row.driftPercent < -35),
  detail: `${langfuseReconciliation.flagged.length} rows at ~-40% drift`,
});
gates.push({
  name: "deterministic",
  pass: trafficFingerprint(helicone.accepted.map((entry) => entry.record)) ===
    trafficFingerprint(parseHeliconeRequests(heliconeRaw, AT).accepted.map((entry) => entry.record)),
  detail: trafficFingerprint(helicone.accepted.map((entry) => entry.record)),
});

let failed = 0;
for (const gate of gates) {
  if (!gate.pass) failed += 1;
  console.log(`${gate.pass ? "PASS" : "FAIL"}  ${gate.name.padEnd(52)} ${gate.detail}`);
}
console.log(`\n${gates.length - failed}/${gates.length} gates passed.`);
if (failed > 0) process.exit(1);
