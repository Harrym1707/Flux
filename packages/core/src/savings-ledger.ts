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
 *   are recorded for transparency and never billed. Estimated token counts
 *   never bill anything.
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
  gateVerdict?: LedgerGateVerdict;
  detail?: string;
};

export type LedgerUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
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
  /** Savings the customer already had. Recorded for transparency, NEVER billed. */
  excluded?: {
    providerCacheAlreadyOwnedUsd?: number;
    gatewayCacheUsd?: number;
  };
  status: "succeeded" | "failed";
};

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
};

export type LedgerPricing =
  | {
      pricingStatus: "priced";
      actualUsd: number;
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
  const query = { provider: input.provider, model: resolution.model, at: input.at };
  const actual = priceUsage(catalogue, { ...query, mode: input.executionMode }, input.usage);
  if (actual.status === "unpriced") return { pricingStatus: "unpriced", reason: actual.reason };

  const standardWithCache = input.executionMode === "standard"
    ? actual
    : priceUsage(catalogue, { ...query, mode: "standard" }, input.usage);
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

export type LedgerPricingAudit =
  | { status: "verified" }
  | { status: "catalogue_version_mismatch"; eventVersion?: string; catalogueVersion: string }
  | { status: "unpriced"; reason: string }
  | { status: "mismatch"; field: "actualUsd"; storedUsd?: number; recomputedUsd: number };

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
  const fluxPlacedCacheControl = event.levers.some((lever) => lever.kind === "provider_cache");
  const priced = priceLedgerUsage(catalogue, {
    provider: event.provider,
    model: event.model,
    at: event.timestamp.slice(0, 10),
    executionMode: event.executionMode,
    usage: event.usage,
    fluxPlacedCacheControl,
  });
  if (priced.pricingStatus === "unpriced") {
    return event.pricingStatus === "unpriced"
      ? { status: "verified" }
      : { status: "unpriced", reason: priced.reason };
  }
  if (priced.actualUsd !== event.actualUsd) {
    return { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: priced.actualUsd };
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
};

export type InvoiceLineItem = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  savedUsd: number;
  savedCents: number;
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
  /** Sum of billable components; negatives are netted, never clamped. */
  netVerifiedSavingsUsd: number;
  netVerifiedSavingsCents: number;
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
  for (const event of events) {
    if (event.schemaVersion !== 1) {
      throw new Error(`Unsupported billable event schemaVersion ${JSON.stringify((event as { schemaVersion: unknown }).schemaVersion)}.`);
    }
    if (typeof event.requestId !== "string" || event.requestId === "") {
      throw new Error("Billable events need a non-empty requestId idempotency key.");
    }
  }
  if (options.feePercent !== undefined &&
      (!Number.isFinite(options.feePercent) || options.feePercent < 0 || options.feePercent > 100)) {
    throw new Error("feePercent must be between 0 and 100.");
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

  const inPeriod = options.period === undefined
    ? deduped
    : deduped.filter((event) => event.invoicePeriod === options.period);

  // Savings bill per COMPLETED task: one failed turn poisons the whole task,
  // including savings its earlier turns appeared to earn.
  const failedTaskIds = new Set<string>(options.failedTaskIds ?? []);
  for (const event of inPeriod) {
    if (event.status === "failed" && event.taskId !== undefined) failedTaskIds.add(event.taskId);
  }
  let eventsExcludedForFailedTasks = 0;
  const billableEvents: BillableEvent[] = [];
  for (const event of inPeriod) {
    const taskFailed = event.taskId !== undefined && failedTaskIds.has(event.taskId);
    if (taskFailed || event.status === "failed") {
      eventsExcludedForFailedTasks += 1;
      continue;
    }
    billableEvents.push(event);
  }

  const lineMap = new Map<string, { leverId: string; kind: LedgerLeverKind; events: number; savedUsd: number; refs: Set<string> }>();
  const unbilledMap = new Map<string, InvoiceUnbilledItem>();
  const catalogueVersions = new Set<string>();
  let unpricedEvents = 0;
  let providerCacheOnAppendedHistoryUsd = 0;
  let gatewayCacheUsd = 0;
  let eventsBilled = 0;

  for (const event of billableEvents) {
    if (event.catalogueVersion !== undefined) catalogueVersions.add(event.catalogueVersion);
    if (event.pricingStatus === "unpriced") unpricedEvents += 1;
    providerCacheOnAppendedHistoryUsd += event.excluded?.providerCacheAlreadyOwnedUsd ?? 0;
    gatewayCacheUsd += event.excluded?.gatewayCacheUsd ?? 0;
    let billedAny = false;
    for (const lever of event.levers) {
      const verdict = options.gateVerdictOverrides?.[lever.leverId] ?? lever.gateVerdict?.verdict;
      const unbilledReason = lever.savedUsd === undefined || !Number.isFinite(lever.savedUsd)
        ? "no per-request verified measurement"
        : lever.kind === "lossy" && verdict !== "approved"
          ? (verdict === "rejected" ? "replay gate verdict rejected" : "no approved replay gate verdict")
          : undefined;
      if (unbilledReason !== undefined) {
        const key = `${lever.kind}\n${lever.leverId}\n${unbilledReason}`;
        const existing = unbilledMap.get(key);
        if (existing) existing.events += 1;
        else unbilledMap.set(key, { leverId: lever.leverId, kind: lever.kind, events: 1, reason: unbilledReason });
        continue;
      }
      const key = `${lever.kind}\n${lever.leverId}`;
      const line = lineMap.get(key) ?? { leverId: lever.leverId, kind: lever.kind, events: 0, savedUsd: 0, refs: new Set<string>() };
      line.events += 1;
      line.savedUsd += lever.savedUsd!;
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
      gateVerdictRefs: [...line.refs].sort(),
    }));
  const recordedUnbilled = [...unbilledMap.values()]
    .sort((left, right) => (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0));

  const netVerifiedSavingsUsd = lineItems.reduce((sum, line) => sum + line.savedUsd, 0);
  const netVerifiedSavingsCents = Math.round(netVerifiedSavingsUsd * 100);
  const verdict: Invoice["verdict"] = netVerifiedSavingsCents > 0 ? "charge" : "do_not_charge";
  const amountDueUsd = options.feePercent === undefined
    ? undefined
    : verdict === "charge"
      ? (netVerifiedSavingsUsd * options.feePercent) / 100
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
    netVerifiedSavingsUsd,
    netVerifiedSavingsCents,
    verdict,
    ...(options.feePercent === undefined ? {} : {
      feePercent: options.feePercent,
      amountDueUsd,
      amountDueCents: Math.round((amountDueUsd ?? 0) * 100),
    }),
  };
  return { invoice, audit: { duplicatesIgnored } };
}
