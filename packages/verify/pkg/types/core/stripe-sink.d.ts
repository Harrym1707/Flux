import { type BillableEvent, type InvoiceOptions } from "./savings-ledger.js";
/**
 * The LOCAL Stripe meter sink: a pure projection from ledger events to Stripe
 * Billing Meters event rows, written to a local JSONL file. No network calls,
 * no API keys, no Stripe account - this is the file a billing integration
 * would transmit, produced where the customer can read it first.
 *
 * Honesty properties, inherited rather than re-promised:
 * - The projection selects and bills events through the SAME shared pipeline
 *   as recomputeInvoice (selectBillableEvents + leverUnbilledReason): deduped
 *   by requestId, failed tasks voided in full, unmeasured levers never
 *   counted, lossy levers only with approved gate verdicts, negatives netted.
 * - Idempotent by construction: a doubled spool deduplicates to the same
 *   events, the same hourly windows, the same identifiers and the same values,
 *   so re-projection emits ZERO duplicate meter events - the output file is
 *   byte-identical. The identifier doubles as the Stripe-side idempotency key.
 * - The canonical billing artifact remains the invoice. The projection's total
 *   equals the invoice's net verified savings over the same options (same
 *   floats, grouped hourly instead of by lever), and `totalCents` is exposed
 *   so the reconciliation is a one-line check.
 */
export type StripeMeterEventRow = {
    /** Stripe Billing Meter event name; one meter per deployment. */
    event_name: string;
    /**
     * Deterministic idempotency identifier: sha256 of applicationId + window
     * start. Stripe rejects duplicate identifiers within the dedupe horizon,
     * which is exactly the re-transmission guard a replayed spool needs.
     */
    identifier: string;
    /** Hour-window start, ISO UTC. */
    timestamp: string;
    payload: {
        /**
         * Customer mapping for the Stripe meter. Defaults to the applicationId
         * verbatim; a real integration passes customerIdOf to map onto cus_ ids.
         */
        stripe_customer_id: string;
        /** Net verified savings for the window, USD as a decimal string (6 dp). */
        value: string;
    };
};
export type StripeMeterProjectionOptions = Pick<InvoiceOptions, "period" | "gateVerdictOverrides" | "failedTaskIds"> & {
    /** Meter event name. Default "flux_net_verified_savings_usd". */
    eventName?: string;
    /** Map an applicationId to the Stripe customer id. Default: identity. */
    customerIdOf?: (applicationId: string) => string;
};
export type StripeMeterProjection = {
    rows: StripeMeterEventRow[];
    /** Deduplicated events considered (inside the period, if one was given). */
    eventsConsidered: number;
    /** Events that contributed at least one billable lever to a row. */
    eventsBilled: number;
    duplicatesIgnored: number;
    /** Events whose timestamp could not be bucketed into an hour window. */
    eventsSkippedBadTimestamp: number;
    /** Sum across rows, for reconciliation against the invoice. */
    totalUsd: number;
    totalCents: number;
};
/** Deterministic row identifier: hash(applicationId + window start). */
export declare function stripeMeterIdentifier(applicationId: string, windowStart: string): string;
/**
 * Project ledger events onto hourly pre-aggregated Stripe meter rows. Pure:
 * same events and options in, byte-identical rows out, however many times the
 * spool was replayed or shuffled.
 */
export declare function projectLedgerEventsToStripeMeterRows(events: readonly BillableEvent[], options?: StripeMeterProjectionOptions): StripeMeterProjection;
/**
 * Write the projection to a local JSONL file, one meter row per line. A full
 * deterministic rewrite, never an append: re-projecting the same spool writes
 * the identical bytes, which is what makes a doubled spool emit zero duplicate
 * meter events. Local only - nothing here (or anywhere in this module) opens a
 * network connection or reads a key.
 */
export declare function writeStripeMeterSink(path: string, rows: readonly StripeMeterEventRow[]): void;
