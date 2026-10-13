import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  leverUnbilledReason,
  selectBillableEvents,
  type BillableEvent,
  type InvoiceOptions,
} from "./savings-ledger.js";

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

export type StripeMeterProjectionOptions = Pick<
  InvoiceOptions,
  "period" | "gateVerdictOverrides" | "failedTaskIds"
> & {
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

const HOUR_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/** The hour window an event's timestamp falls in, or undefined if unreadable. */
function hourWindowOf(timestamp: string): string | undefined {
  const prefix = timestamp.slice(0, 13);
  return HOUR_PREFIX.test(prefix) ? `${prefix}:00:00Z` : undefined;
}

/** Deterministic row identifier: hash(applicationId + window start). */
export function stripeMeterIdentifier(applicationId: string, windowStart: string): string {
  return createHash("sha256").update(`${applicationId}\n${windowStart}`).digest("hex");
}

/**
 * Project ledger events onto hourly pre-aggregated Stripe meter rows. Pure:
 * same events and options in, byte-identical rows out, however many times the
 * spool was replayed or shuffled.
 */
export function projectLedgerEventsToStripeMeterRows(
  events: readonly BillableEvent[],
  options: StripeMeterProjectionOptions = {},
): StripeMeterProjection {
  const eventName = options.eventName ?? "flux_net_verified_savings_usd";
  if (eventName.trim() === "") throw new Error("The Stripe meter event name must be non-empty.");
  const customerIdOf = options.customerIdOf ?? ((applicationId: string) => applicationId);

  const { consideredEvents, billableEvents, duplicatesIgnored } = selectBillableEvents(events, options);

  type Window = { applicationId: string; windowStart: string; savedUsd: number; events: number };
  const windows = new Map<string, Window>();
  let eventsBilled = 0;
  let eventsSkippedBadTimestamp = 0;

  for (const event of billableEvents) {
    let billableUsd = 0;
    let billedAny = false;
    for (const lever of event.levers) {
      if (leverUnbilledReason(lever, options.gateVerdictOverrides) !== undefined) continue;
      billableUsd += lever.savedUsd!;
      billedAny = true;
    }
    if (!billedAny) continue;
    const windowStart = hourWindowOf(event.timestamp);
    if (windowStart === undefined) {
      eventsSkippedBadTimestamp += 1;
      continue;
    }
    eventsBilled += 1;
    const key = `${event.applicationId}\n${windowStart}`;
    const window = windows.get(key) ?? {
      applicationId: event.applicationId, windowStart, savedUsd: 0, events: 0,
    };
    window.savedUsd += billableUsd;
    window.events += 1;
    windows.set(key, window);
  }

  const rows: StripeMeterEventRow[] = [...windows.values()]
    .sort((left, right) =>
      left.windowStart !== right.windowStart
        ? (left.windowStart < right.windowStart ? -1 : 1)
        : (left.applicationId < right.applicationId ? -1 : left.applicationId > right.applicationId ? 1 : 0))
    .map((window) => ({
      event_name: eventName,
      identifier: stripeMeterIdentifier(window.applicationId, window.windowStart),
      timestamp: window.windowStart,
      payload: {
        stripe_customer_id: customerIdOf(window.applicationId),
        // Decimal string; negative windows stay NEGATIVE here. Stripe meters
        // do not accept negative usage, so a transmitting integration must
        // reconcile at the invoice (where negatives net) - this local file
        // never hides a window that counts against FLUX.
        value: window.savedUsd.toFixed(6),
      },
    }));

  const totalUsd = [...windows.values()].reduce((sum, window) => sum + window.savedUsd, 0);
  return {
    rows,
    eventsConsidered: consideredEvents.length,
    eventsBilled,
    duplicatesIgnored,
    eventsSkippedBadTimestamp,
    totalUsd,
    totalCents: Math.round(totalUsd * 100),
  };
}

/**
 * Write the projection to a local JSONL file, one meter row per line. A full
 * deterministic rewrite, never an append: re-projecting the same spool writes
 * the identical bytes, which is what makes a doubled spool emit zero duplicate
 * meter events. Local only - nothing here (or anywhere in this module) opens a
 * network connection or reads a key.
 */
export function writeStripeMeterSink(path: string, rows: readonly StripeMeterEventRow[]): void {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("The Stripe meter sink needs a local file path.");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
}
