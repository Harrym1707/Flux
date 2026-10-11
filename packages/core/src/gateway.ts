import { priceUsage, resolveModelId, type PriceCatalogue } from "./price-catalogue.js";
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
  flagged: Array<{ id: string; model: string; reportedUsd: number; catalogueUsd: number; driftPercent: number }>;
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
export function reconcileGatewaySpend(
  parsed: GatewayParseResult,
  catalogue: PriceCatalogue,
  options: { tolerancePercent?: number } = {},
): SpendReconciliation {
  const tolerance = options.tolerancePercent ?? 10;
  let comparedRows = 0;
  let reportedSpendUsd = 0;
  let catalogueCostUsd = 0;
  let unpricedRows = 0;
  const flagged: SpendReconciliation["flagged"] = [];

  const priceRow = (entry: GatewayRecord): number | undefined => {
    const resolved = resolveModelId(catalogue, entry.record.provider, entry.record.model);
    if (resolved.status !== "resolved") return undefined;
    const priced = priceUsage(
      catalogue,
      { provider: entry.record.provider, model: resolved.model, at: entry.record.at },
      {
        inputTokens: entry.record.inputTokens,
        outputTokens: entry.record.outputTokens,
        cachedInputTokens: entry.record.cachedInputTokens,
        cacheWriteInputTokens: entry.record.cacheWriteInputTokens,
      },
    );
    return priced.status === "priced" ? priced.costUsd : undefined;
  };

  for (const entry of parsed.accepted) {
    const catalogued = priceRow(entry);
    if (catalogued === undefined) {
      unpricedRows += 1;
      continue;
    }
    if (entry.reportedSpendUsd === undefined) continue;
    comparedRows += 1;
    reportedSpendUsd += entry.reportedSpendUsd;
    catalogueCostUsd += catalogued;
    const drift = catalogued === 0 ? 0 : ((entry.reportedSpendUsd - catalogued) / catalogued) * 100;
    if (Math.abs(drift) > tolerance && Math.abs(entry.reportedSpendUsd - catalogued) > 0.000_1) {
      flagged.push({
        id: entry.record.id,
        model: entry.record.model,
        reportedUsd: entry.reportedSpendUsd,
        catalogueUsd: catalogued,
        driftPercent: drift,
      });
    }
  }

  let cacheHitSavedUsd = 0;
  for (const entry of parsed.cacheHits) {
    cacheHitSavedUsd += priceRow(entry) ?? 0;
  }

  return {
    comparedRows,
    reportedSpendUsd,
    catalogueCostUsd,
    driftPercent: catalogueCostUsd === 0
      ? 0
      : ((reportedSpendUsd - catalogueCostUsd) / catalogueCostUsd) * 100,
    flagged,
    unpricedRows,
    cacheHitRows: parsed.cacheHits.length,
    cacheHitSavedUsd,
  };
}

/**
 * Derive segment-classification signals for one traffic stream.
 *
 * The measurement supplies what usage alone can show; the gateway extras add
 * the dimensions only it knows: who each request was for, and how often its
 * own response cache already answers.
 */
export function signalsFromGateway(
  stream: GatewayRecord[],
  cacheHits: GatewayRecord[],
  measurement: TrafficMeasurement,
): StreamSignals {
  const endUsers = new Set(stream.map((entry) => entry.endUser).filter((user): user is string => !!user));
  const withEndUser = stream.filter((entry) => entry.endUser !== undefined).length;

  let weightedRoundTrips = 0;
  let identifiedRequests = 0;
  let inputTokens = 0;
  let toolTokens = 0;
  let breakers = false;
  for (const workload of measurement.workloads) {
    if (workload.episodes.identified) {
      weightedRoundTrips += workload.episodes.meanRoundTrips * workload.requests;
      identifiedRequests += workload.requests;
    }
    inputTokens += workload.inputTokens;
    toolTokens += workload.meanToolSchemaTokens * workload.requests;
    if ((workload.caching?.prefixBreakers.length ?? 0) > 0) breakers = true;
  }

  return {
    requests: stream.length,
    distinctEndUsers: endUsers.size,
    requestsPerEndUser: endUsers.size === 0 ? stream.length : withEndUser / endUsers.size,
    episodesIdentified: measurement.episodesIdentified,
    meanRoundTrips: identifiedRequests === 0 ? 1 : weightedRoundTrips / identifiedRequests,
    toolSchemaShare: inputTokens === 0 ? 0 : toolTokens / inputTokens,
    alreadyCachedShare: measurement.alreadyCachedShare,
    gatewayCacheHitShare: stream.length + cacheHits.length === 0
      ? 0
      : cacheHits.length / (stream.length + cacheHits.length),
    promptTextAvailable: measurement.promptTextAvailable,
    prefixBreakersFound: breakers,
    meanInputTokens: stream.length === 0 ? 0 : inputTokens / stream.length,
  };
}

/** Group parsed gateway rows into streams by the workload the tool tagged. */
export function groupByStream(entries: GatewayRecord[]): Map<string, GatewayRecord[]> {
  const streams = new Map<string, GatewayRecord[]>();
  for (const entry of entries) {
    const list = streams.get(entry.record.workload) ?? [];
    list.push(entry);
    streams.set(entry.record.workload, list);
  }
  return streams;
}
