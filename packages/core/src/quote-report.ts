import { groupByStream, reconcileGatewaySpend, signalsFromGateway, type GatewayParseResult, type GatewayRecord, type SpendReconciliation } from "./gateway.js";
import { parseHeliconeRequests } from "./helicone.js";
import { parseLangfuseGenerations } from "./langfuse.js";
import { parseLiteLLMSpendLogs } from "./litellm.js";
import { catalogueVersion, type PriceCatalogue } from "./price-catalogue.js";
import { measureTraffic, trafficFingerprint } from "./traffic.js";
import { classifySegment, quoteForSegment, type SegmentQuote } from "./triage.js";

/**
 * The pre-contract quote, built from a design partner's OWN gateway export.
 *
 * One file of their real traffic in; one shareable report out: which customer
 * shape each stream is, what FLUX is honestly worth on it, what their own
 * gateway already saves them (credited, never billed), and -- when nothing is
 * worth charging for -- the explicit "do not pay us" answer. Every band in the
 * report cites the measurement it is an analogue of; nothing here invents a
 * number the triage pipeline did not already defend.
 *
 * This module only composes the existing adapters and triage; the quoting
 * logic itself lives in triage.ts and is exercised by the gate suites.
 */

export type QuoteExportFormat = "litellm" | "helicone" | "langfuse";

export type QuoteStreamReport = {
  stream: string;
  requests: number;
  /** Catalogue-priced baseline for the stream's provider calls. */
  baselineUsd: number;
  quote: SegmentQuote;
};

export type QuoteReport = {
  schemaVersion: 1;
  format: QuoteExportFormat;
  /** Billing date the rates were resolved on. */
  at: string;
  /** Content hash of the price catalogue used, so the quote is reproducible. */
  catalogueVersion: string;
  /** Deterministic fingerprint of the accepted rows the quote was built from. */
  trafficFingerprint: string;
  rows: { accepted: number; gatewayCacheHits: number; unreadable: number };
  /** Largest baseline first. */
  streams: QuoteStreamReport[];
  reconciliation: SpendReconciliation;
  /** True when every stream triages to "not worth charging for". */
  doNotPayUs: boolean;
};

/** Parse a gateway export with the right adapter. Unreadable rows are reported, never dropped silently. */
export function parseGatewayExport(
  rows: unknown[],
  format: QuoteExportFormat,
  fallbackDate: string,
): GatewayParseResult {
  switch (format) {
    case "litellm": return parseLiteLLMSpendLogs(rows, fallbackDate);
    case "helicone": return parseHeliconeRequests(rows, fallbackDate);
    case "langfuse": return parseLangfuseGenerations(rows, fallbackDate);
  }
}

/** Build the quote report from raw export rows. Pure and deterministic. */
export function buildQuoteReport(
  rows: unknown[],
  options: { format: QuoteExportFormat; at: string; catalogue: PriceCatalogue },
): QuoteReport {
  const parsed = parseGatewayExport(rows, options.format, options.at);
  const reconciliation = reconcileGatewaySpend(parsed, options.catalogue);

  const streams = groupByStream(parsed.accepted);
  const cacheHitsByStream = groupByStream(parsed.cacheHits);
  const reports: QuoteStreamReport[] = [];
  for (const [stream, entries] of streams) {
    const measurement = measureTraffic(entries.map((entry) => entry.record), options.catalogue);
    const signals = signalsFromGateway(entries, cacheHitsByStream.get(stream) ?? [], measurement);
    const classification = classifySegment(signals);
    reports.push({
      stream,
      requests: entries.length,
      baselineUsd: measurement.totalBaselineCostUsd,
      quote: quoteForSegment(classification, signals),
    });
  }
  reports.sort((left, right) =>
    right.baselineUsd - left.baselineUsd ||
    (left.stream < right.stream ? -1 : left.stream > right.stream ? 1 : 0));

  return {
    schemaVersion: 1,
    format: options.format,
    at: options.at,
    catalogueVersion: catalogueVersion(options.catalogue),
    trafficFingerprint: trafficFingerprint(parsed.accepted.map((entry: GatewayRecord) => entry.record)),
    rows: {
      accepted: parsed.accepted.length,
      gatewayCacheHits: parsed.cacheHits.length,
      unreadable: parsed.issues.length,
    },
    streams: reports,
    reconciliation,
    doNotPayUs: reports.length === 0 || reports.every((report) => report.quote.doNotCharge === true),
  };
}

/** Render the report for a human: bands, caveats, credits and verdicts. */
export function renderQuoteReport(report: QuoteReport): string {
  const lines: string[] = [];
  lines.push(`=== FLUX quote from your ${report.format} export ===`);
  lines.push(`${report.rows.accepted} provider calls, ${report.rows.gatewayCacheHits} gateway cache hits, ` +
    `${report.rows.unreadable} unreadable rows (reported, never dropped silently)`);
  lines.push(`rates: catalogue ${report.catalogueVersion} on ${report.at}; ` +
    `traffic fingerprint ${report.trafficFingerprint}`);
  lines.push("");
  for (const stream of report.streams) {
    const quote = stream.quote;
    lines.push(`${stream.stream} - ${quote.segment}`);
    lines.push(`  requests ${stream.requests}, baseline $${stream.baselineUsd.toFixed(2)}`);
    lines.push(`  quote: ${quote.bandPercent[0]}-${quote.bandPercent[1]}% via ${quote.topLever} ` +
      `[${quote.confidence}]${quote.doNotCharge ? " - DO NOT CHARGE" : ""}`);
    if (quote.firmUpBy) lines.push(`  firm up by: ${quote.firmUpBy}`);
    for (const reason of quote.reasoning) lines.push(`    - ${reason}`);
    lines.push("");
  }
  const rec = report.reconciliation;
  lines.push("=== spend reconciliation against published rates ===");
  lines.push(`compared ${rec.comparedRows} rows: your tool reports $${rec.reportedSpendUsd.toFixed(2)}, ` +
    `catalogue says $${rec.catalogueCostUsd.toFixed(2)} (drift ${rec.driftPercent.toFixed(1)}%)`);
  lines.push(`${rec.flagged.length} rows flagged beyond tolerance; ` +
    `${rec.unpricedRows} unpriced rows excluded, never zeroed`);
  lines.push(`your gateway's cache already saves you $${rec.cacheHitSavedUsd.toFixed(2)} across ` +
    `${rec.cacheHitRows} hits - credited to you, excluded from every quote above`);
  if (report.doNotPayUs) {
    lines.push("");
    lines.push("VERDICT: DO NOT PAY US. Nothing in this traffic is worth charging for; " +
      "a percent-of-savings fee on savings you already have would be a refund waiting to happen.");
  }
  return lines.join("\n");
}
