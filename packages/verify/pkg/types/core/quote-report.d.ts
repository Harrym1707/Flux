import { type GatewayParseResult, type SpendReconciliation } from "./gateway.js";
import { type PriceCatalogue } from "./price-catalogue.js";
import { type SegmentQuote } from "./triage.js";
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
    rows: {
        accepted: number;
        gatewayCacheHits: number;
        unreadable: number;
    };
    /** Largest baseline first. */
    streams: QuoteStreamReport[];
    reconciliation: SpendReconciliation;
    /** True when every stream triages to "not worth charging for". */
    doNotPayUs: boolean;
};
/** Parse a gateway export with the right adapter. Unreadable rows are reported, never dropped silently. */
export declare function parseGatewayExport(rows: unknown[], format: QuoteExportFormat, fallbackDate: string): GatewayParseResult;
/** Build the quote report from raw export rows. Pure and deterministic. */
export declare function buildQuoteReport(rows: unknown[], options: {
    format: QuoteExportFormat;
    at: string;
    catalogue: PriceCatalogue;
}): QuoteReport;
/** Render the report for a human: bands, caveats, credits and verdicts. */
export declare function renderQuoteReport(report: QuoteReport): string;
