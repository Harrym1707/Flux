import { priceUsage, resolveModelId, type PriceCatalogue } from "./price-catalogue.js";
import type { IngestIssue, TrafficMeasurement, TrafficRecord } from "./traffic.js";
import type { StreamSignals } from "./triage.js";

/**
 * LiteLLM spend-log adapter.
 *
 * LiteLLM is the most widely deployed open-source LLM gateway, and it is a
 * complement rather than a competitor: it tracks spend, enforces budgets and
 * caches responses, but performs no token reduction and gives no view of what a
 * reduction would be worth. Its spend logs are exactly the input FLUX's
 * analyser eats, so any LiteLLM deployment can be triaged without new plumbing.
 *
 * Two honesty rules are enforced at the boundary:
 *
 *   Rows answered by LiteLLM's own response cache (cache_hit) never enter the
 *   baseline. No provider call happened, the spend is ~0, and counting the
 *   would-have-been cost as addressable would claim a saving the customer's own
 *   gateway already delivers. They are returned separately and valued as the
 *   customer's existing saving.
 *
 *   LiteLLM's own `spend` figure is kept and reconciled against catalogue
 *   rates rather than trusted or discarded. Its community pricing map can lag a
 *   provider's price change, and a drift between the two is itself a finding.
 */

type Row = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** LiteLLM stores cache_hit as the strings "True"/"False", booleans, or null. */
function isCacheHit(value: unknown): boolean {
  return value === true || value === "True" || value === "true";
}

function providerFor(model: string, explicit?: string): string {
  if (explicit) return explicit;
  if (/^(?:claude|opus|sonnet|haiku|fable)/i.test(model)) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt|text-)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return "unknown";
}

function flattenMessages(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts: string[] = [];
  for (const message of value) {
    if (!isPlainObject(message)) continue;
    const content = message.content;
    if (typeof content === "string" && content.trim() !== "") parts.push(content);
    else if (Array.isArray(content)) {
      for (const piece of content) {
        if (isPlainObject(piece) && typeof piece.text === "string") parts.push(piece.text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

export type LiteLLMRecord = {
  record: TrafficRecord;
  /** LiteLLM's own cost figure for the row, as logged. */
  reportedSpendUsd?: number;
  /** The customer the request was made for (LiteLLM's end_user). */
  endUser?: string;
  teamId?: string;
};

export type LiteLLMParseResult = {
  /** Rows that reached a provider; the analysable baseline. */
  accepted: LiteLLMRecord[];
  /** Rows LiteLLM's response cache answered. Not baseline: no provider call happened. */
  cacheHits: LiteLLMRecord[];
  issues: IngestIssue[];
};

/**
 * Parse LiteLLM spend-log rows, from /spend/logs output, a database export, or
 * a StandardLoggingPayload stream. Rows that cannot be read are reported, never
 * dropped silently.
 */
export function parseLiteLLMSpendLogs(rows: unknown[], fallbackDate: string): LiteLLMParseResult {
  const accepted: LiteLLMRecord[] = [];
  const cacheHits: LiteLLMRecord[] = [];
  const issues: IngestIssue[] = [];

  rows.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push({ line: index + 1, reason: "Row is not a JSON object." });
      return;
    }
    const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
    const model = asString(raw.model) ?? asString(raw.model_group);
    if (model === undefined) {
      issues.push({ line: index + 1, reason: "No model or model_group field." });
      return;
    }
    const inputTokens = asNumber(raw.prompt_tokens);
    const outputTokens = asNumber(raw.completion_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
      issues.push({ line: index + 1, reason: "Missing prompt_tokens or completion_tokens." });
      return;
    }
    const started = asString(raw.startTime) ?? asString(raw.start_time) ?? asString(raw.endTime);
    const at = started !== undefined && /^\d{4}-\d{2}-\d{2}/.test(started)
      ? started.slice(0, 10)
      : fallbackDate;

    const episodeId = asString(raw.session_id) ?? asString(raw.litellm_session_id) ??
      asString(metadata.session_id) ?? asString(metadata.litellm_session_id) ??
      asString(raw.trace_id) ?? asString(metadata.trace_id);

    const tags = Array.isArray(raw.request_tags)
      ? raw.request_tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const workload = tags[0] ?? asString(raw.team_id) ?? asString(raw.model_group) ?? model;

    // Present only when the proxy stores prompts in its spend logs, which is
    // off by default; everything else must work without it.
    const promptText = flattenMessages(raw.messages) ??
      flattenMessages(isPlainObject(raw.proxy_server_request)
        ? (raw.proxy_server_request as Row).messages ??
          (isPlainObject((raw.proxy_server_request as Row).body)
            ? ((raw.proxy_server_request as Row).body as Row).messages
            : undefined)
        : undefined);

    const entry: LiteLLMRecord = {
      record: {
        id: asString(raw.request_id) ?? asString(raw.id) ?? `litellm-${index}`,
        model,
        provider: providerFor(model, asString(raw.custom_llm_provider)),
        at,
        inputTokens,
        outputTokens,
        ...(promptText === undefined ? {} : { promptText }),
        workload,
        ...(episodeId === undefined ? {} : { episodeId }),
      },
      ...(asNumber(raw.spend) ?? asNumber(raw.response_cost)) === undefined
        ? {}
        : { reportedSpendUsd: asNumber(raw.spend) ?? asNumber(raw.response_cost)! },
      ...(asString(raw.end_user) ?? asString(metadata.user_api_key_end_user_id)) === undefined
        ? {}
        : { endUser: (asString(raw.end_user) ?? asString(metadata.user_api_key_end_user_id))! },
      ...(asString(raw.team_id) === undefined ? {} : { teamId: asString(raw.team_id)! }),
    };

    if (isCacheHit(raw.cache_hit) || isCacheHit(metadata.cache_hit)) cacheHits.push(entry);
    else accepted.push(entry);
  });

  return { accepted, cacheHits, issues };
}

export type SpendReconciliation = {
  /** Rows where both a reported spend and a catalogue price existed. */
  comparedRows: number;
  reportedSpendUsd: number;
  catalogueCostUsd: number;
  /** Positive when LiteLLM reports more spend than published rates support. */
  driftPercent: number;
  /** Rows whose reported spend deviates more than the tolerance. */
  flagged: Array<{ id: string; model: string; reportedUsd: number; catalogueUsd: number; driftPercent: number }>;
  /** Rows whose model the catalogue cannot price; excluded, never zeroed. */
  unpricedRows: number;
  /** What LiteLLM's own response cache already saves the customer, at catalogue rates. */
  cacheHitRows: number;
  cacheHitSavedUsd: number;
};

/**
 * Reconcile LiteLLM's reported spend against the dated price catalogue.
 *
 * A persistent drift means one of the two price sources is stale, and either
 * way the customer's dashboards are wrong by that much. Cache-hit rows are
 * valued at catalogue rates as the saving the customer already has, so FLUX's
 * own quote can exclude it explicitly.
 */
export function reconcileLiteLLMSpend(
  parsed: LiteLLMParseResult,
  catalogue: PriceCatalogue,
  options: { tolerancePercent?: number } = {},
): SpendReconciliation {
  const tolerance = options.tolerancePercent ?? 10;
  let comparedRows = 0;
  let reportedSpendUsd = 0;
  let catalogueCostUsd = 0;
  let unpricedRows = 0;
  const flagged: SpendReconciliation["flagged"] = [];

  const priceRow = (entry: LiteLLMRecord): number | undefined => {
    const resolved = resolveModelId(catalogue, entry.record.provider, entry.record.model);
    if (resolved.status !== "resolved") return undefined;
    const priced = priceUsage(
      catalogue,
      { provider: entry.record.provider, model: resolved.model, at: entry.record.at },
      { inputTokens: entry.record.inputTokens, outputTokens: entry.record.outputTokens },
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
 * The measurement supplies what usage alone can show; the LiteLLM extras add
 * the dimensions a gateway uniquely knows: who each request was for (end_user)
 * and how often its own response cache already answers.
 */
export function signalsFromLiteLLM(
  stream: LiteLLMRecord[],
  cacheHits: LiteLLMRecord[],
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
