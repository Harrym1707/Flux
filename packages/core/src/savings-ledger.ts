import { createHash } from "node:crypto";
import {
  canonicalJson,
  catalogueVersion,
  priceUsage,
  resolveModelId,
  type PriceCatalogue,
} from "./price-catalogue.js";

/**
 * The savings ledger: the append-only record FLUX bills from, and the pure
 * functions that turn it back into an invoice.
 *
 * FLUX charges a percentage of VERIFIED savings, so the ledger is designed to
 * be recomputed by the customer, not trusted:
 *
 * - Every event carries the provider-verbatim token usage and the content hash
 *   of the price catalogue it was priced against. Anyone holding the same
 *   catalogue can re-derive every USD figure with zero tolerance.
 * - Events are hash-chained (seq, prevHash, eventHash), so a perturbed or
 *   removed event is detectable, and the exact position is named.
 * - `recomputeInvoice` is deterministic and idempotent by requestId: replaying
 *   the same spool twice, late, or shuffled yields a byte-identical invoice.
 * - Only verified components bill: price-mode deltas on actual tokens, FLUX's
 *   own exact-cache avoidance at the originally measured cost, provider-cache
 *   economics on prefixes FLUX itself placed, and lossy levers whose replay
 *   gate verdict is "approved". Savings the customer already had (provider
 *   cache on appended history they placed or got by default, gateway caches)
 *   are recorded for transparency and never billed. Token-reduction levers may
 *   bill from an estimated baseline anchored to provider-verbatim usage, and
 *   every such figure is labelled "estimated-baseline" on the lever and the
 *   invoice line item — an estimate is never passed off as a measurement.
 * - Negative components are netted, never clamped: a 1h cache-write surcharge
 *   that never earned its reads shows up AGAINST FLUX on the invoice, and a
 *   net-non-positive period produces the "do_not_charge" verdict.
 */

export type LedgerExecutionMode = "standard" | "flex" | "batch";

export type LedgerLeverKind =
  /** Transform that cannot change the answer (schema compaction, dedupe). */
  | "lossless"
  /** Behaviour-changing lever; bills only with an approved replay-gate verdict. */
  | "lossy"
  /** Execution-tier price delta (flex/batch) on actual tokens. */
  | "tier"
  /** FLUX's own exact response cache: a request never sent. */
  | "exact_cache"
  /** Provider prompt-cache economics on cache_control FLUX itself placed. */
  | "provider_cache";

/** Reference to the replay-gate run that approved or rejected a lossy lever. */
export type LedgerGateVerdict = {
  ref: string;
  verdict: "approved" | "rejected";
};

export type LedgerLever = {
  leverId: string;
  kind: LedgerLeverKind;
  /**
   * Verified USD this lever saved on THIS request. MAY be negative (netted on
   * the invoice, never clamped). Omitted means the lever was applied but has no
   * per-request verified measurement; it is then recorded and never billed.
   */
  savedUsd?: number;
  /**
   * How savedUsd was derived. "measured" (the default when absent) means it
   * came entirely from provider-verbatim deltas. "estimated-baseline" means
   * the tokens this lever removed were counted BEFORE send by FLUX's own
   * counter, anchored to the provider-verbatim input total by ratio, and
   * valued at this event's realized blended input rate — a conservative
   * under-claim on cache-heavy traffic, labelled as an estimate everywhere
   * it appears, including the invoice line item.
   */
  basis?: "measured" | "estimated-baseline";
  gateVerdict?: LedgerGateVerdict;
  detail?: string;
};

export type LedgerUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** TOTAL cache writes, inclusive of any TTL-split share below. */
  cacheWriteInputTokens: number;
  /**
   * Provider-reported TTL split of the cache writes, present as a PAIR only
   * when the provider reported one (Anthropic usage.cache_creation). The two
   * buckets must sum exactly to cacheWriteInputTokens or the event is unpriced.
   * Absent means the split is UNKNOWN: writes on a FLUX-placed cache_control
   * use the TTL stamped by FLUX when it is recorded (otherwise the 1h premium,
   * dispute-safe and counted against FLUX), never assumed to be 5m writes.
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
};

/** One append-only billable event, written once per completed request. */
export type BillableEvent = {
  schemaVersion: 1;
  /** End-to-end idempotency key; duplicates are ignored at invoice time. */
  requestId: string;
  applicationId: string;
  /** Correlation to a multi-turn task, so a failed task's turns can be excluded. */
  taskId?: string;
  turnIndex?: number;
  /** YYYY-MM, fixed from `timestamp` at write time so late replays land in the same period. */
  invoicePeriod: string;
  timestamp: string;
  provider: string;
  model: string;
  /** Taken from the provider RESPONSE (service_tier / batch), never the request. */
  executionMode: LedgerExecutionMode;
  pricingStatus: "priced" | "unpriced";
  pricingReason?: string;
  /** Content hash of the catalogue the USD figures were computed against. */
  catalogueVersion?: string;
  /** Provider-verbatim normalised token usage. */
  usage?: LedgerUsage;
  /** Catalogue-priced cost of this request at its actual execution mode. */
  actualUsd?: number;
  /** Measured counterfactual (standard tier, no levers), when a measurement path supplies one. */
  baselineUsd?: number;
  /** The caller's own pricing of the request, informational only. */
  reportedCostUsd?: number;
  levers: LedgerLever[];
  /**
   * Evidence behind any estimated-baseline lever on this event: FLUX's own
   * pre-send token counts. Informational — the invoice never reads it; it
   * exists so an auditor can re-derive every estimated savedUsd from the
   * event alone (removedFraction = removed / before, baseline input =
   * usage.inputTokens / (1 - removedFraction), valued at actual input cost
   * divided by actual input tokens).
   */
  estimatedReduction?: {
    estimatedInputTokensBefore: number;
    estimatedInputTokensRemoved: number;
  };
  /**
   * Output-side waste metering (never billed, never mutated): how much of
   * this completion was verbatim re-emission of lines already in the request
   * context, and whether this request byte-duplicated an earlier one. Pure
   * diagnostics for the statement's waste view; token counts only.
   */
  outputDiagnostics?: {
    inspectedOutputTokens: number;
    reEmittedOutputTokens: number;
    reEmittedCodeTokens: number;
  };
  /** This request was byte-identical to an earlier one from the same app. */
  duplicateOfRequestId?: string;
  /** Savings the customer already had. Recorded for transparency, NEVER billed. */
  excluded?: {
    providerCacheAlreadyOwnedUsd?: number;
    gatewayCacheUsd?: number;
  };
  /**
   * Anthropic server-side compaction spend on this request: the `compaction`
   * entries of usage.iterations, which the provider EXCLUDES from the top-level
   * usage that `usage`/`actualUsd` record. Present only when a compaction
   * iteration ran. Always attributed to the customer (they enabled compaction;
   * FLUX caused none of it), priced at the catalogued rates of the event's own
   * model and mode with every cache component treated as customer-owned, and
   * never read by any lever or savings figure: it is shown on the invoice so
   * the statement reconciles to the provider bill, and it bills nothing.
   */
  compaction?: {
    attribution: "customer";
    iterations: number;
    pricingStatus: "priced" | "unpriced";
    pricingReason?: string;
    usage?: LedgerUsage;
    usd?: number;
  };
  status: "succeeded" | "failed";
};

/** What the provider billed for this request: the main iterations plus any compaction. */
export function eventProviderCostUsd(event: BillableEvent): number | undefined {
  if (event.actualUsd === undefined) return undefined;
  if (event.compaction === undefined) return event.actualUsd;
  return event.compaction.usd === undefined ? undefined : event.actualUsd + event.compaction.usd;
}

// ---------------------------------------------------------------------------
// Hash chain
// ---------------------------------------------------------------------------

export const LEDGER_GENESIS_HASH = "0".repeat(64);

export type LedgerRecord = {
  seq: number;
  prevHash: string;
  eventHash: string;
  event: BillableEvent;
};

/** Hash of one chained event; covers its position, its predecessor and its content. */
export function ledgerEventHash(seq: number, prevHash: string, event: BillableEvent): string {
  return createHash("sha256").update(`${seq}\n${prevHash}\n${canonicalJson(event)}`).digest("hex");
}

/** Chain one event onto the previous record (or onto genesis). */
export function chainLedgerRecord(event: BillableEvent, previous?: LedgerRecord): LedgerRecord {
  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous ? previous.eventHash : LEDGER_GENESIS_HASH;
  return { seq, prevHash, eventHash: ledgerEventHash(seq, prevHash, event), event };
}

export type LedgerChainVerification =
  | { ok: true; length: number }
  | { ok: false; seq: number; reason: string };

/**
 * Verify a spool end to end. A perturbed usage field, a reordered record, or a
 * missing record is reported with the exact sequence number where the chain breaks.
 */
export function verifyLedgerChain(records: readonly LedgerRecord[]): LedgerChainVerification {
  let prevHash = LEDGER_GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.seq !== index) {
      return { ok: false, seq: record.seq, reason: `Expected seq ${index}, found ${record.seq}.` };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, seq: record.seq, reason: "prevHash does not match the preceding record." };
    }
    const expected = ledgerEventHash(record.seq, record.prevHash, record.event);
    if (record.eventHash !== expected) {
      return { ok: false, seq: record.seq, reason: "eventHash does not match the event content." };
    }
    prevHash = record.eventHash;
  }
  return { ok: true, length: records.length };
}

// ---------------------------------------------------------------------------
// Pricing one event's usage against the catalogue
// ---------------------------------------------------------------------------

export type LedgerPricingInput = {
  provider: string;
  /** Raw API model identifier, resolved against the catalogue. */
  model: string;
  /** ISO calendar date the request was billed on. */
  at: string;
  executionMode: LedgerExecutionMode;
  usage: LedgerUsage;
  /**
   * True when FLUX itself placed the cache_control (the cache-ttl lever applies
   * only when the caller had none), so the request's cache economics -- reads
   * at the cached rate MINUS the write surcharge -- attribute to FLUX. False
   * means the customer already owned those economics; they are then excluded.
   */
  fluxPlacedCacheControl: boolean;
  /**
   * The TTL FLUX stamped, when fluxPlacedCacheControl is true. Decides how an
   * ABSENT provider TTL split prices the writes: a "5m" stamp can only have
   * produced 5m writes (1.25x), while "1h" or unspecified prices every write
   * at the 1h premium (2x) — the dispute-safe reading for an hour-long stamp.
   */
  fluxPlacedTtl?: "5m" | "1h";
};

export type LedgerPricing =
  | {
      pricingStatus: "priced";
      actualUsd: number;
      /** Input-side share of actualUsd (actual mode, cache usage included, output excluded). */
      inputUsd: number;
      /** Standard-mode minus actual-mode cost on the same tokens; set only when the mode differs. */
      tierSavedUsd?: number;
      /** Cache economics attributable to FLUX; MAY be negative (write surcharge unearned by reads). */
      cacheAttributedUsd?: number;
      /** Cache economics the customer already had; informational, never billed. */
      providerCacheAlreadyOwnedUsd?: number;
    }
  | { pricingStatus: "unpriced"; reason: string };

/**
 * Decompose one request's catalogue cost into auditable parts:
 *
 *   actualUsd = fullRateStandardUsd - cacheDeltaUsd - tierSavedUsd
 *
 * where fullRateStandardUsd prices every input token at the standard full rate,
 * cacheDeltaUsd is what the prompt cache changed (negative when writes outweigh
 * reads), and tierSavedUsd is the flex/batch price delta on the actual tokens.
 * Unpriced is returned rather than zero whenever a needed rate is missing.
 */
export function priceLedgerUsage(catalogue: PriceCatalogue, input: LedgerPricingInput): LedgerPricing {
  const resolution = resolveModelId(catalogue, input.provider, input.model);
  if (resolution.status === "unresolved") {
    return { pricingStatus: "unpriced", reason: resolution.reason };
  }

  // The cache-write TTL split decides which write rate bills. The cases:
  // a reported split must sum exactly (a mismatched event is unpriced, never
  // repaired); an absent split on a FLUX-placed 1h stamp prices EVERY write
  // at the 1h premium, because FLUX stamped the 1h TTL and the benefit of the
  // doubt belongs to the customer (dispute-safe); an absent split on a
  // FLUX-placed 5m stamp prices writes at the default 5m rate, because a 5m
  // stamp can only have produced 5m writes; an absent split on
  // customer-placed caching keeps the default write rate, exactly as before.
  const split5m = input.usage.cacheWrite5mInputTokens;
  const split1h = input.usage.cacheWrite1hInputTokens;
  const splitReported = split5m !== undefined || split1h !== undefined;
  if (splitReported && (split5m ?? 0) + (split1h ?? 0) !== input.usage.cacheWriteInputTokens) {
    return {
      pricingStatus: "unpriced",
      reason: `Cache-write TTL split (5m ${split5m ?? 0} + 1h ${split1h ?? 0}) does not sum to ` +
        `cacheWriteInputTokens ${input.usage.cacheWriteInputTokens}.`,
    };
  }
  const write1hForPricing = splitReported
    ? (split1h ?? 0)
    : input.fluxPlacedCacheControl && input.fluxPlacedTtl !== "5m"
      ? input.usage.cacheWriteInputTokens
      : 0;
  const pricingUsage = {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: write1hForPricing,
  };

  const query = { provider: input.provider, model: resolution.model, at: input.at };
  const actual = priceUsage(catalogue, { ...query, mode: input.executionMode }, pricingUsage);
  if (actual.status === "unpriced") return { pricingStatus: "unpriced", reason: actual.reason };
  const actualInputOnly = priceUsage(catalogue, { ...query, mode: input.executionMode }, {
    ...pricingUsage,
    outputTokens: 0,
  });
  if (actualInputOnly.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: actualInputOnly.reason };
  }

  const standardWithCache = input.executionMode === "standard"
    ? actual
    : priceUsage(catalogue, { ...query, mode: "standard" }, pricingUsage);
  if (standardWithCache.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: standardWithCache.reason };
  }

  const fullRateStandard = priceUsage(catalogue, { ...query, mode: "standard" }, {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
  });
  if (fullRateStandard.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: fullRateStandard.reason };
  }

  const cacheDeltaUsd = fullRateStandard.costUsd - standardWithCache.costUsd;
  const hasCacheTraffic = input.usage.cachedInputTokens > 0 || input.usage.cacheWriteInputTokens > 0;
  return {
    pricingStatus: "priced",
    actualUsd: actual.costUsd,
    inputUsd: actualInputOnly.costUsd,
    ...(input.executionMode === "standard"
      ? {}
      : { tierSavedUsd: standardWithCache.costUsd - actual.costUsd }),
    ...(hasCacheTraffic
      ? input.fluxPlacedCacheControl
        ? { cacheAttributedUsd: cacheDeltaUsd }
        : { providerCacheAlreadyOwnedUsd: cacheDeltaUsd }
      : {}),
  };
}

/**
 * Price the compaction iterations of one request at catalogued rates. The
 * cache economics inside a compaction iteration are never FLUX's: the
 * summarizer is a call the customer asked the provider to make.
 */
export function priceCompactionUsage(
  catalogue: PriceCatalogue,
  input: Omit<LedgerPricingInput, "fluxPlacedCacheControl" | "fluxPlacedTtl">,
): { pricingStatus: "priced"; usd: number } | { pricingStatus: "unpriced"; reason: string } {
  const priced = priceLedgerUsage(catalogue, { ...input, fluxPlacedCacheControl: false });
  return priced.pricingStatus === "priced"
    ? { pricingStatus: "priced", usd: priced.actualUsd }
    : { pricingStatus: "unpriced", reason: priced.reason };
}

export type LedgerPricingAudit =
  | { status: "verified" }
  | { status: "catalogue_version_mismatch"; eventVersion?: string; catalogueVersion: string }
  | { status: "unpriced"; reason: string }
  | { status: "mismatch"; field: "actualUsd" | "compaction.usd"; storedUsd?: number; recomputedUsd: number };

/**
 * Recompute one event's stored cost from its provider-verbatim usage and the
 * given catalogue, with zero tolerance. The catalogue must be the exact version
 * the event was priced against; auditing against a bumped catalogue is reported
 * as a version mismatch rather than a false pricing error.
 */
export function auditEventPricing(event: BillableEvent, catalogue: PriceCatalogue): LedgerPricingAudit {
  const version = catalogueVersion(catalogue);
  if (event.catalogueVersion !== undefined && event.catalogueVersion !== version) {
    return { status: "catalogue_version_mismatch", eventVersion: event.catalogueVersion, catalogueVersion: version };
  }
  if (!event.usage) {
    return event.actualUsd === undefined
      ? { status: "verified" }
      : { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: Number.NaN };
  }
  const cacheLever = event.levers.find((lever) => lever.kind === "provider_cache");
  const fluxPlacedCacheControl = cacheLever !== undefined;
  const fluxPlacedTtl = cacheLever?.leverId === "cache-ttl-5m"
    ? "5m"
    : cacheLever?.leverId === "cache-ttl-1h"
      ? "1h"
      : undefined;
  const priced = priceLedgerUsage(catalogue, {
    provider: event.provider,
    model: event.model,
    at: event.timestamp.slice(0, 10),
    executionMode: event.executionMode,
    usage: event.usage,
    fluxPlacedCacheControl,
    ...(fluxPlacedTtl === undefined ? {} : { fluxPlacedTtl }),
  });
  if (priced.pricingStatus === "unpriced") {
    return event.pricingStatus === "unpriced"
      ? { status: "verified" }
      : { status: "unpriced", reason: priced.reason };
  }
  if (priced.actualUsd !== event.actualUsd) {
    return { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: priced.actualUsd };
  }
  if (event.compaction?.usage !== undefined) {
    const compaction = priceCompactionUsage(catalogue, {
      provider: event.provider,
      model: event.model,
      at: event.timestamp.slice(0, 10),
      executionMode: event.executionMode,
      usage: event.compaction.usage,
    });
    const recomputed = compaction.pricingStatus === "priced" ? compaction.usd : undefined;
    if (recomputed !== event.compaction.usd) {
      return {
        status: "mismatch",
        field: "compaction.usd",
        ...(event.compaction.usd === undefined ? {} : { storedUsd: event.compaction.usd }),
        recomputedUsd: recomputed ?? Number.NaN,
      };
    }
  }
  return { status: "verified" };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export type InvoiceOptions = {
  /** Restrict to one invoice period (YYYY-MM), matched against each event's own stamp. */
  period?: string;
  /**
   * Override gate verdicts by lever id WITHOUT mutating any event: flipping a
   * lever to "rejected" drops its savings from the invoice on the next recompute.
   */
  gateVerdictOverrides?: Record<string, "approved" | "rejected">;
  /** Tasks known to have failed quality out-of-band; all their turns' savings are excluded. */
  failedTaskIds?: readonly string[];
  /** FLUX's contracted share of net verified savings, 0-100. Omitted: no fee line. */
  feePercent?: number;
  /**
   * Verified-savings deficit carried in from prior periods (the ESPC G.5
   * mechanic): a period that lost money does not just bill zero — its
   * deficit offsets future fees, so aggregate fees can never exceed
   * aggregate verified savings. Non-negative USD.
   */
  carryForwardDeficitUsd?: number;
};

export type InvoiceLineItem = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  savedUsd: number;
  savedCents: number;
  /** Present when ANY contributing lever's savedUsd was estimated-baseline rather than fully measured. */
  basis?: "estimated-baseline";
  gateVerdictRefs: string[];
};

export type InvoiceUnbilledItem = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  reason: string;
};

export type Invoice = {
  schemaVersion: 1;
  period: string | null;
  catalogueVersions: string[];
  eventsConsidered: number;
  eventsBilled: number;
  failedTaskIds: string[];
  eventsExcludedForFailedTasks: number;
  unpricedEvents: number;
  lineItems: InvoiceLineItem[];
  /** Levers that were applied but carry no billable per-request measurement. */
  recordedUnbilled: InvoiceUnbilledItem[];
  /** Savings the customer already had; shown so the exclusion is checkable, never billed. */
  excludedAlreadyOwned: {
    providerCacheOnAppendedHistoryUsd: number;
    gatewayCacheUsd: number;
  };
  /**
   * Customer-paid Anthropic compaction spend in the period (usage.iterations
   * entries the top-level usage excludes). Present only when any event carries
   * one. Informational: it reconciles the statement to the provider bill and
   * never enters netVerifiedSavingsUsd.
   */
  customerCompaction?: {
    events: number;
    iterations: number;
    usd: number;
    unpricedEvents: number;
  };
  /** Sum of billable components; negatives are netted, never clamped. */
  netVerifiedSavingsUsd: number;
  netVerifiedSavingsCents: number;
  /** Deficit applied from prior periods, when the option was supplied. */
  carryForwardDeficitInUsd?: number;
  /** Deficit to carry into the NEXT period (this period's shortfall after netting). */
  carryForwardDeficitOutUsd?: number;
  verdict: "charge" | "do_not_charge";
  feePercent?: number;
  amountDueUsd?: number;
  amountDueCents?: number;
};

function compareEvents(left: BillableEvent, right: BillableEvent): number {
  if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
  if (left.requestId !== right.requestId) return left.requestId < right.requestId ? -1 : 1;
  return 0;
}

/**
 * Why one lever's savings may NOT bill, or undefined when they may. The single
 * rule the invoice and every projection of it (for example the Stripe meter
 * sink) share, so no downstream artifact can ever bill a lever the invoice
 * would refuse: unmeasured levers never bill, and lossy levers bill only with
 * an approved replay-gate verdict.
 */
export function leverUnbilledReason(
  lever: LedgerLever,
  gateVerdictOverrides?: Record<string, "approved" | "rejected">,
): string | undefined {
  const verdict = gateVerdictOverrides?.[lever.leverId] ?? lever.gateVerdict?.verdict;
  if (lever.savedUsd === undefined || !Number.isFinite(lever.savedUsd)) {
    return "no per-request verified measurement";
  }
  if (lever.kind === "lossy" && verdict !== "approved") {
    return verdict === "rejected" ? "replay gate verdict rejected" : "no approved replay gate verdict";
  }
  return undefined;
}

/**
 * The shared selection pipeline: validate, sort, dedupe by requestId, filter
 * to one period, and void every turn of a failed task. Extracted so the
 * invoice and its projections apply IDENTICAL filters; recomputeInvoice's
 * output bytes are unchanged by the extraction.
 */
export function selectBillableEvents(
  events: readonly BillableEvent[],
  options: Pick<InvoiceOptions, "period" | "failedTaskIds"> = {},
): {
  /** Deduplicated events inside the period, before task-failure exclusion. */
  consideredEvents: BillableEvent[];
  /** Events whose levers may bill: succeeded, on no failed task. */
  billableEvents: BillableEvent[];
  failedTaskIds: Set<string>;
  eventsExcludedForFailedTasks: number;
  duplicatesIgnored: number;
} {
  for (const event of events) {
    if (event.schemaVersion !== 1) {
      throw new Error(`Unsupported billable event schemaVersion ${JSON.stringify((event as { schemaVersion: unknown }).schemaVersion)}.`);
    }
    if (typeof event.requestId !== "string" || event.requestId === "") {
      throw new Error("Billable events need a non-empty requestId idempotency key.");
    }
  }

  const sorted = [...events].sort(compareEvents);
  const seen = new Set<string>();
  let duplicatesIgnored = 0;
  const deduped: BillableEvent[] = [];
  for (const event of sorted) {
    if (seen.has(event.requestId)) {
      duplicatesIgnored += 1;
      continue;
    }
    seen.add(event.requestId);
    deduped.push(event);
  }

  const consideredEvents = options.period === undefined
    ? deduped
    : deduped.filter((event) => event.invoicePeriod === options.period);

  // Savings bill per COMPLETED task: one failed turn poisons the whole task,
  // including savings its earlier turns appeared to earn.
  const failedTaskIds = new Set<string>(options.failedTaskIds ?? []);
  for (const event of consideredEvents) {
    if (event.status === "failed" && event.taskId !== undefined) failedTaskIds.add(event.taskId);
  }
  let eventsExcludedForFailedTasks = 0;
  const billableEvents: BillableEvent[] = [];
  for (const event of consideredEvents) {
    const taskFailed = event.taskId !== undefined && failedTaskIds.has(event.taskId);
    if (taskFailed || event.status === "failed") {
      eventsExcludedForFailedTasks += 1;
      continue;
    }
    billableEvents.push(event);
  }
  return { consideredEvents, billableEvents, failedTaskIds, eventsExcludedForFailedTasks, duplicatesIgnored };
}

/**
 * Recompute the invoice from raw events. Pure and deterministic: events are
 * sorted and deduplicated by requestId before anything is summed, so the same
 * spool replayed twice, a day late, or shuffled produces byte-identical output.
 */
export type LedgerAudit = {
  /** Events dropped as requestId replays before anything was summed. */
  duplicatesIgnored: number;
};

/**
 * The canonical, customer-recomputable invoice. Deliberately does NOT include
 * replay metadata: whether a spool was transmitted once or three times must not
 * change a single byte of the billing artifact, or "recompute it yourself"
 * stops being a guarantee and becomes a dispute. Replay counts are audit
 * telemetry and come back separately from recomputeInvoiceWithAudit.
 */
export function recomputeInvoice(events: readonly BillableEvent[], options: InvoiceOptions = {}): Invoice {
  return recomputeInvoiceWithAudit(events, options).invoice;
}

export function recomputeInvoiceWithAudit(
  events: readonly BillableEvent[],
  options: InvoiceOptions = {},
): { invoice: Invoice; audit: LedgerAudit } {
  if (options.feePercent !== undefined &&
      (!Number.isFinite(options.feePercent) || options.feePercent < 0 || options.feePercent > 100)) {
    throw new Error("feePercent must be between 0 and 100.");
  }

  const {
    consideredEvents: inPeriod,
    billableEvents,
    failedTaskIds,
    eventsExcludedForFailedTasks,
    duplicatesIgnored,
  } = selectBillableEvents(events, options);

  const lineMap = new Map<string, { leverId: string; kind: LedgerLeverKind; events: number; savedUsd: number; estimated: boolean; refs: Set<string> }>();
  const unbilledMap = new Map<string, InvoiceUnbilledItem>();
  const catalogueVersions = new Set<string>();
  let unpricedEvents = 0;
  let providerCacheOnAppendedHistoryUsd = 0;
  let gatewayCacheUsd = 0;
  let eventsBilled = 0;
  // Compaction spend is paid whether or not the task succeeded, so it is
  // summed over every considered event; it never touches the savings below.
  let compactionEvents = 0;
  let compactionIterations = 0;
  let compactionUsd = 0;
  let compactionUnpriced = 0;
  for (const event of inPeriod) {
    if (event.compaction === undefined) continue;
    compactionEvents += 1;
    compactionIterations += event.compaction.iterations;
    if (event.compaction.usd === undefined) compactionUnpriced += 1;
    else compactionUsd += event.compaction.usd;
  }

  for (const event of billableEvents) {
    if (event.catalogueVersion !== undefined) catalogueVersions.add(event.catalogueVersion);
    if (event.pricingStatus === "unpriced") unpricedEvents += 1;
    providerCacheOnAppendedHistoryUsd += event.excluded?.providerCacheAlreadyOwnedUsd ?? 0;
    gatewayCacheUsd += event.excluded?.gatewayCacheUsd ?? 0;
    let billedAny = false;
    for (const lever of event.levers) {
      const unbilledReason = leverUnbilledReason(lever, options.gateVerdictOverrides);
      if (unbilledReason !== undefined) {
        const key = `${lever.kind}\n${lever.leverId}\n${unbilledReason}`;
        const existing = unbilledMap.get(key);
        if (existing) existing.events += 1;
        else unbilledMap.set(key, { leverId: lever.leverId, kind: lever.kind, events: 1, reason: unbilledReason });
        continue;
      }
      const key = `${lever.kind}\n${lever.leverId}`;
      const line = lineMap.get(key) ?? { leverId: lever.leverId, kind: lever.kind, events: 0, savedUsd: 0, estimated: false, refs: new Set<string>() };
      line.events += 1;
      line.savedUsd += lever.savedUsd!;
      if (lever.basis === "estimated-baseline") line.estimated = true;
      if (lever.gateVerdict?.ref) line.refs.add(lever.gateVerdict.ref);
      lineMap.set(key, line);
      billedAny = true;
    }
    if (billedAny) eventsBilled += 1;
  }

  const lineItems: InvoiceLineItem[] = [...lineMap.values()]
    .sort((left, right) => (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0))
    .map((line) => ({
      leverId: line.leverId,
      kind: line.kind,
      events: line.events,
      savedUsd: line.savedUsd,
      savedCents: Math.round(line.savedUsd * 100),
      ...(line.estimated ? { basis: "estimated-baseline" as const } : {}),
      gateVerdictRefs: [...line.refs].sort(),
    }));
  const recordedUnbilled = [...unbilledMap.values()]
    .sort((left, right) => (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0));

  const netVerifiedSavingsUsd = lineItems.reduce((sum, line) => sum + line.savedUsd, 0);
  const netVerifiedSavingsCents = Math.round(netVerifiedSavingsUsd * 100);
  // Carry-forward netting (G.5 mechanic): the fee applies to this period's
  // net MINUS any deficit carried from prior periods, and a shortfall rolls
  // forward — aggregate fees can never exceed aggregate verified savings.
  const carryIn = options.carryForwardDeficitUsd ?? 0;
  if (carryIn < 0 || !Number.isFinite(carryIn)) {
    throw new Error("carryForwardDeficitUsd must be a non-negative, finite USD amount.");
  }
  const netAfterCarryUsd = netVerifiedSavingsUsd - carryIn;
  const carryOutUsd = Math.max(0, -netAfterCarryUsd);
  const billableCents = Math.round(netAfterCarryUsd * 100);
  const verdict: Invoice["verdict"] = billableCents > 0 ? "charge" : "do_not_charge";
  const amountDueUsd = options.feePercent === undefined
    ? undefined
    : verdict === "charge"
      ? (netAfterCarryUsd * options.feePercent) / 100
      : 0;

  const invoice: Invoice = {
    schemaVersion: 1,
    period: options.period ?? null,
    catalogueVersions: [...catalogueVersions].sort(),
    eventsConsidered: inPeriod.length,
    eventsBilled,
    failedTaskIds: [...failedTaskIds].sort(),
    eventsExcludedForFailedTasks,
    unpricedEvents,
    lineItems,
    recordedUnbilled,
    excludedAlreadyOwned: {
      providerCacheOnAppendedHistoryUsd,
      gatewayCacheUsd,
    },
    ...(compactionEvents === 0 ? {} : {
      customerCompaction: {
        events: compactionEvents,
        iterations: compactionIterations,
        usd: compactionUsd,
        unpricedEvents: compactionUnpriced,
      },
    }),
    netVerifiedSavingsUsd,
    netVerifiedSavingsCents,
    ...(options.carryForwardDeficitUsd === undefined ? {} : { carryForwardDeficitInUsd: carryIn }),
    ...(carryOutUsd > 0 ? { carryForwardDeficitOutUsd: carryOutUsd } : {}),
    verdict,
    ...(options.feePercent === undefined ? {} : {
      feePercent: options.feePercent,
      amountDueUsd,
      amountDueCents: Math.round((amountDueUsd ?? 0) * 100),
    }),
  };
  return { invoice, audit: { duplicatesIgnored } };
}
