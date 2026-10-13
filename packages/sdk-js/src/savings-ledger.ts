import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  catalogueVersion,
  chainLedgerRecord,
  priceLedgerUsage,
  publishedModelPrices,
  type BillableEvent,
  type LedgerExecutionMode,
  type LedgerLever,
  type LedgerRecord,
  type LedgerUsage,
  type PriceCatalogue,
} from "../../core/dist/src/index.js";
import type { FluxRequestEvent, FluxSavingsLedgerConfig } from "./types.js";

/**
 * The opt-in savings meter: turns each FluxRequestEvent into one append-only
 * BillableEvent and writes it as a hash-chained JSONL record.
 *
 * Honesty properties, enforced here rather than promised:
 * - Every USD figure on an event is recomputable from the provider-verbatim
 *   usage it carries plus the pinned catalogue version. Estimated token counts
 *   are never priced.
 * - executionMode comes from the RESPONSE service_tier, never the requested
 *   one, so a flex request that fell back to standard earns zero tier savings.
 * - Provider-cache economics bill only on cache_control FLUX itself placed
 *   (the cache-ttl lever applies only when the caller had none); a customer's
 *   own cache discounts land in `excluded`, visible and never billed. The
 *   attributed figure MAY be negative: a 1h write surcharge with no reads to
 *   earn it counts against FLUX on the invoice.
 * - Token-reduction levers are recorded per request but bill only through the
 *   measured counterfactual (`getBaselineUsd`), and only when every applied
 *   lossy lever carries an approved replay-gate verdict.
 * - Writes are synchronous (the record exists before the caller sees the
 *   response) and totally silent on failure: a bad path, full disk, or corrupt
 *   tail disables the meter rather than ever throwing into the request path.
 */

const EXECUTION_TIER_LEVERS = new Set(["execution-tier-flex"]);
const CACHE_TTL_LEVER = "cache-ttl-1h";
const MEASURED_COMPOSITE_LEVER = "token-reduction-measured";
const EXACT_CACHE_LEVER = "exact-response-cache";

function executionModeOf(responseServiceTier: string | undefined): LedgerExecutionMode {
  if (responseServiceTier === "flex") return "flex";
  if (responseServiceTier === "batch") return "batch";
  return "standard";
}

function usageOf(event: FluxRequestEvent): LedgerUsage | undefined {
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = event;
  if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens]
    .some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
    return undefined;
  }
  // The TTL split is recorded verbatim when the provider reported one; pricing
  // sum-checks it (a mismatched event is unpriced) and an ABSENT split on a
  // FLUX-placed cache_control prices every write at the 1h premium.
  const validCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isFinite(count) && count >= 0;
  const splitReported = event.cacheWrite5mInputTokens !== undefined || event.cacheWrite1hInputTokens !== undefined;
  const splitValid = splitReported &&
    validCount(event.cacheWrite5mInputTokens ?? 0) && validCount(event.cacheWrite1hInputTokens ?? 0);
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    cachedInputTokens: cachedInputTokens!,
    cacheWriteInputTokens: cacheWriteInputTokens!,
    ...(splitValid
      ? {
          cacheWrite5mInputTokens: event.cacheWrite5mInputTokens ?? 0,
          cacheWrite1hInputTokens: event.cacheWrite1hInputTokens ?? 0,
        }
      : {}),
  };
}

/** Build the append-only billable record for one completed request. Pure. */
export function billableEventFromRequest(
  event: FluxRequestEvent,
  config: FluxSavingsLedgerConfig,
  catalogue: PriceCatalogue,
  pinnedCatalogueVersion: string,
): BillableEvent {
  const provider = config.provider ?? "openai";
  const changes = event.reduction && !event.reduction.skipped ? event.reduction.changes : [];
  const fluxPlacedCacheControl = changes.some((change) => change.lever === CACHE_TTL_LEVER);
  const executionMode = executionModeOf(event.responseServiceTier);
  const usage = usageOf(event);

  const pricing = usage === undefined
    ? { pricingStatus: "unpriced" as const, reason: "The event carries no provider-verbatim usage." }
    : priceLedgerUsage(catalogue, {
        provider,
        model: event.model,
        at: event.timestamp.slice(0, 10),
        executionMode,
        usage,
        fluxPlacedCacheControl,
      });
  const priced = pricing.pricingStatus === "priced" ? pricing : undefined;

  const levers: LedgerLever[] = [];
  const excluded: NonNullable<BillableEvent["excluded"]> = {};

  // FLUX's own exact response cache: the measured cost of the request never sent.
  if (event.cacheHit) {
    levers.push({
      leverId: EXACT_CACHE_LEVER,
      kind: "exact_cache",
      ...(event.costAvoidedUsd === undefined ? {} : { savedUsd: event.costAvoidedUsd }),
    });
  }

  // Execution-tier price delta on actual tokens, from the RESPONSE mode.
  if (priced?.tierSavedUsd !== undefined) {
    levers.push({
      leverId: `execution-tier-${executionMode}`,
      kind: "tier",
      savedUsd: priced.tierSavedUsd,
    });
  }

  // Provider-cache economics on cache_control FLUX itself placed; may be negative.
  if (priced?.cacheAttributedUsd !== undefined) {
    levers.push({
      leverId: CACHE_TTL_LEVER,
      kind: "provider_cache",
      savedUsd: priced.cacheAttributedUsd,
    });
  }
  if (priced?.providerCacheAlreadyOwnedUsd !== undefined) {
    excluded.providerCacheAlreadyOwnedUsd = priced.providerCacheAlreadyOwnedUsd;
  }

  // Token-reduction changes are recorded per request. They never bill from
  // estimated token counts; their billable path is the measured composite below.
  const tokenChanges = changes.filter((change) =>
    !EXECUTION_TIER_LEVERS.has(change.lever) &&
    !(change.lever === CACHE_TTL_LEVER && priced?.cacheAttributedUsd !== undefined));
  for (const change of tokenChanges) {
    levers.push({
      leverId: change.lever,
      kind: change.lossless ? "lossless" : "lossy",
      ...(config.gateVerdicts?.[change.lever] === undefined
        ? {}
        : { gateVerdict: config.gateVerdicts[change.lever] }),
    });
  }
  // A flex stamp the response did not honour is recorded, unbilled, so the
  // 429-fallback case is visible on the spool rather than silently absent.
  for (const change of changes) {
    if (EXECUTION_TIER_LEVERS.has(change.lever) && priced?.tierSavedUsd === undefined) {
      levers.push({ leverId: change.lever, kind: "lossless" });
    }
  }

  let baselineUsd: number | undefined;
  try {
    const supplied = config.getBaselineUsd?.(event);
    if (typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0) baselineUsd = supplied;
  } catch {
    baselineUsd = undefined;
  }
  // Rate levers (tier, cache TTL) bill through their own priced components
  // above; the measured composite covers only the token-removing changes.
  const measuredTokenChanges = changes.filter((change) =>
    !EXECUTION_TIER_LEVERS.has(change.lever) && change.lever !== CACHE_TTL_LEVER);
  if (baselineUsd !== undefined && priced !== undefined && measuredTokenChanges.length > 0) {
    const lossy = measuredTokenChanges.filter((change) => !change.lossless);
    const verdicts = lossy.map((change) => config.gateVerdicts?.[change.lever]);
    const allApproved = verdicts.every((verdict) => verdict?.verdict === "approved");
    const savedUsd = baselineUsd - priced.actualUsd - (priced.tierSavedUsd ?? 0) - (priced.cacheAttributedUsd ?? 0);
    levers.push({
      leverId: MEASURED_COMPOSITE_LEVER,
      kind: lossy.length > 0 ? "lossy" : "lossless",
      savedUsd,
      ...(lossy.length > 0 && allApproved
        ? {
            gateVerdict: {
              ref: verdicts.map((verdict) => verdict!.ref).sort().join("+"),
              verdict: "approved" as const,
            },
          }
        : {}),
      detail: "baselineUsd minus actual catalogue cost, net of tier and cache components",
    });
  }

  let correlation: { taskId?: string; turnIndex?: number } | undefined;
  try {
    correlation = config.getCorrelation?.(event);
  } catch {
    correlation = undefined;
  }

  return {
    schemaVersion: 1,
    requestId: event.requestId,
    applicationId: event.applicationId,
    ...(correlation?.taskId === undefined ? {} : { taskId: correlation.taskId }),
    ...(correlation?.turnIndex === undefined ? {} : { turnIndex: correlation.turnIndex }),
    invoicePeriod: event.timestamp.slice(0, 7),
    timestamp: event.timestamp,
    provider,
    model: event.model,
    executionMode,
    pricingStatus: pricing.pricingStatus,
    ...(pricing.pricingStatus === "unpriced" ? { pricingReason: pricing.reason } : {}),
    catalogueVersion: pinnedCatalogueVersion,
    ...(usage === undefined ? {} : { usage }),
    ...(priced === undefined ? {} : { actualUsd: priced.actualUsd }),
    ...(baselineUsd === undefined ? {} : { baselineUsd }),
    ...(event.costUsd === undefined ? {} : { reportedCostUsd: event.costUsd }),
    levers,
    ...(Object.keys(excluded).length === 0 ? {} : { excluded }),
    status: event.status,
  };
}

export type SavingsLedger = {
  /** Synchronously appends one chained record. Never throws. */
  emit: (event: FluxRequestEvent) => void;
  readonly path: string;
};

function resumeChainTail(path: string): { previous?: LedgerRecord; disabled: boolean } {
  try {
    if (!existsSync(path)) return { disabled: false };
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) return { disabled: false };
    const tail = JSON.parse(lines[lines.length - 1]!) as LedgerRecord;
    if (typeof tail.seq !== "number" || typeof tail.eventHash !== "string") return { disabled: true };
    return { previous: tail, disabled: false };
  } catch {
    // A spool whose tail cannot be read must not be extended with a broken
    // chain; the meter goes quiet instead of corrupting the billing record.
    return { disabled: true };
  }
}

/** Create the opt-in JSONL savings meter. Construction never throws on I/O. */
export function createSavingsLedger(config: FluxSavingsLedgerConfig): SavingsLedger {
  if (typeof config.path !== "string" || config.path.trim() === "") {
    throw new Error("The savings ledger needs a file path for its append-only JSONL spool.");
  }
  const catalogue = config.catalogue ?? publishedModelPrices;
  const pinnedCatalogueVersion = catalogueVersion(catalogue);
  const tail = resumeChainTail(config.path);
  let previous = tail.previous;
  let disabled = tail.disabled;

  return {
    path: config.path,
    emit(event: FluxRequestEvent): void {
      if (disabled) return;
      try {
        const billable = billableEventFromRequest(event, config, catalogue, pinnedCatalogueVersion);
        const record = chainLedgerRecord(billable, previous);
        mkdirSync(dirname(config.path), { recursive: true });
        appendFileSync(config.path, `${JSON.stringify(record)}\n`, "utf8");
        previous = record;
      } catch {
        // The meter must never throw into the request path; a failed append
        // disables it so the on-disk chain stays internally consistent.
        disabled = true;
      }
    },
  };
}
