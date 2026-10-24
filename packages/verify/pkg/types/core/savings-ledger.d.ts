import { type PriceCatalogue } from "./price-catalogue.js";
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
"lossless"
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
    /** Savings the customer already had. Recorded for transparency, NEVER billed. */
    excluded?: {
        providerCacheAlreadyOwnedUsd?: number;
        gatewayCacheUsd?: number;
    };
    status: "succeeded" | "failed";
};
export declare const LEDGER_GENESIS_HASH: string;
export type LedgerRecord = {
    seq: number;
    prevHash: string;
    eventHash: string;
    event: BillableEvent;
};
/** Hash of one chained event; covers its position, its predecessor and its content. */
export declare function ledgerEventHash(seq: number, prevHash: string, event: BillableEvent): string;
/** Chain one event onto the previous record (or onto genesis). */
export declare function chainLedgerRecord(event: BillableEvent, previous?: LedgerRecord): LedgerRecord;
export type LedgerChainVerification = {
    ok: true;
    length: number;
} | {
    ok: false;
    seq: number;
    reason: string;
};
/**
 * Verify a spool end to end. A perturbed usage field, a reordered record, or a
 * missing record is reported with the exact sequence number where the chain breaks.
 */
export declare function verifyLedgerChain(records: readonly LedgerRecord[]): LedgerChainVerification;
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
export type LedgerPricing = {
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
} | {
    pricingStatus: "unpriced";
    reason: string;
};
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
export declare function priceLedgerUsage(catalogue: PriceCatalogue, input: LedgerPricingInput): LedgerPricing;
export type LedgerPricingAudit = {
    status: "verified";
} | {
    status: "catalogue_version_mismatch";
    eventVersion?: string;
    catalogueVersion: string;
} | {
    status: "unpriced";
    reason: string;
} | {
    status: "mismatch";
    field: "actualUsd";
    storedUsd?: number;
    recomputedUsd: number;
};
/**
 * Recompute one event's stored cost from its provider-verbatim usage and the
 * given catalogue, with zero tolerance. The catalogue must be the exact version
 * the event was priced against; auditing against a bumped catalogue is reported
 * as a version mismatch rather than a false pricing error.
 */
export declare function auditEventPricing(event: BillableEvent, catalogue: PriceCatalogue): LedgerPricingAudit;
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
    /** Sum of billable components; negatives are netted, never clamped. */
    netVerifiedSavingsUsd: number;
    netVerifiedSavingsCents: number;
    verdict: "charge" | "do_not_charge";
    feePercent?: number;
    amountDueUsd?: number;
    amountDueCents?: number;
};
/**
 * Why one lever's savings may NOT bill, or undefined when they may. The single
 * rule the invoice and every projection of it (for example the Stripe meter
 * sink) share, so no downstream artifact can ever bill a lever the invoice
 * would refuse: unmeasured levers never bill, and lossy levers bill only with
 * an approved replay-gate verdict.
 */
export declare function leverUnbilledReason(lever: LedgerLever, gateVerdictOverrides?: Record<string, "approved" | "rejected">): string | undefined;
/**
 * The shared selection pipeline: validate, sort, dedupe by requestId, filter
 * to one period, and void every turn of a failed task. Extracted so the
 * invoice and its projections apply IDENTICAL filters; recomputeInvoice's
 * output bytes are unchanged by the extraction.
 */
export declare function selectBillableEvents(events: readonly BillableEvent[], options?: Pick<InvoiceOptions, "period" | "failedTaskIds">): {
    /** Deduplicated events inside the period, before task-failure exclusion. */
    consideredEvents: BillableEvent[];
    /** Events whose levers may bill: succeeded, on no failed task. */
    billableEvents: BillableEvent[];
    failedTaskIds: Set<string>;
    eventsExcludedForFailedTasks: number;
    duplicatesIgnored: number;
};
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
export declare function recomputeInvoice(events: readonly BillableEvent[], options?: InvoiceOptions): Invoice;
export declare function recomputeInvoiceWithAudit(events: readonly BillableEvent[], options?: InvoiceOptions): {
    invoice: Invoice;
    audit: LedgerAudit;
};
