import { type PriceCatalogue } from "./price-catalogue.js";
import type { IngestIssue, TrafficMeasurement, TrafficRecord } from "./traffic.js";
import type { StreamSignals } from "./triage.js";
/**
 * The shared gateway layer every adapter feeds.
 *
 * LiteLLM, Helicone and Langfuse log different schemas, but the triage engine
 * needs one shape: a traffic record plus the three things only a gateway or
 * tracer knows (what it thinks the row cost, who the request was for, and
 * whether its own cache answered). Each adapter is ~150 lines of field
 * mapping; everything downstream - reconciliation, signals, classification,
 * quoting - is written once here and in triage.ts, so a finding fixed for one
 * connector is fixed for all of them.
 */
export type GatewayRecord = {
    record: TrafficRecord;
    /** The tool's own cost figure for the row, as logged. */
    reportedSpendUsd?: number;
    /** The downstream customer the request was made for. */
    endUser?: string;
    teamId?: string;
};
export type GatewayParseResult = {
    /** Rows that reached a provider; the analysable baseline. */
    accepted: GatewayRecord[];
    /**
     * Rows the tool's own response cache answered. Not baseline: no provider
     * call happened, and counting the would-have-been cost would claim a saving
     * the customer's own stack already delivers.
     */
    cacheHits: GatewayRecord[];
    issues: IngestIssue[];
};
export type SpendReconciliation = {
    /** Rows where both a reported spend and a catalogue price existed. */
    comparedRows: number;
    reportedSpendUsd: number;
    catalogueCostUsd: number;
    /** Positive when the tool reports more spend than published rates support. */
    driftPercent: number;
    /** Rows whose reported spend deviates more than the tolerance. */
    flagged: Array<{
        id: string;
        model: string;
        reportedUsd: number;
        catalogueUsd: number;
        driftPercent: number;
    }>;
    /** Rows whose model the catalogue cannot price; excluded, never zeroed. */
    unpricedRows: number;
    /** What the tool's own response cache already saves, at catalogue rates. */
    cacheHitRows: number;
    cacheHitSavedUsd: number;
};
/**
 * Reconcile a tool's reported spend against the dated price catalogue.
 *
 * A persistent drift means one of the two price sources is stale, and either
 * way the customer's dashboards are wrong by that much. Rows already arriving
 * provider-cached are priced at the cached rate, so a correct gateway figure
 * is not flagged merely because caching made the true cost lower.
 */
export declare function reconcileGatewaySpend(parsed: GatewayParseResult, catalogue: PriceCatalogue, options?: {
    tolerancePercent?: number;
}): SpendReconciliation;
/**
 * Derive segment-classification signals for one traffic stream.
 *
 * The measurement supplies what usage alone can show; the gateway extras add
 * the dimensions only it knows: who each request was for, and how often its
 * own response cache already answers.
 */
export declare function signalsFromGateway(stream: GatewayRecord[], cacheHits: GatewayRecord[], measurement: TrafficMeasurement): StreamSignals;
/** Group parsed gateway rows into streams by the workload the tool tagged. */
export declare function groupByStream(entries: GatewayRecord[]): Map<string, GatewayRecord[]>;
