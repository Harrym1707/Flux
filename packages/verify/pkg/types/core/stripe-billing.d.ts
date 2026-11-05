import type { Invoice } from "./savings-ledger.js";
/**
 * Turning a recomputed MESH invoice into a Stripe charge — the honest way.
 *
 * This module is PURE: it converts an `Invoice` (the output of
 * `recomputeInvoice`, itself a pure function over the customer's own
 * hash-chained ledger) into a `StripeInvoicePlan` — the exact set of Stripe API
 * calls that would bill it. No network here; the executor (mesh-bill script)
 * runs the plan. Keeping it pure means the billing arithmetic is unit-tested
 * without touching Stripe, and the plan can be shown to a human before anything
 * is created.
 *
 * The invariants that matter for a verified-savings vendor:
 *   - A broken/unverified ledger NEVER bills. verdict carries DO_NOT_BILL.
 *   - A non-positive net period bills nothing (do_not_charge), and a carried
 *     deficit is surfaced, never hidden.
 *   - The amount is 1% (or the contracted feePercent) of NET verified savings,
 *     taken straight from the invoice — this module does not recompute savings,
 *     it only formats the already-verified number for Stripe.
 *   - The line-item description traces to the recomputable statement, so the
 *     customer can check the charge against their own ledger.
 *   - Every create call carries an idempotency key keyed on customer+period, so
 *     re-running a month cannot double-bill.
 */
export type StripeBillingOptions = {
    /** Stripe customer id (cus_…) the fee is billed to. */
    stripeCustomerId: string;
    /** Currency for the invoice. MESH fees are USD-denominated. */
    currency?: string;
    /**
     * Whether to finalize+send the invoice or leave it as a reviewable DRAFT.
     * Default "draft": nothing is ever charged without a human finalizing it.
     */
    mode?: "draft" | "finalize";
    /** Label for the customer's statement, e.g. the spool set or app id. */
    customerLabel?: string;
};
export type StripeInvoicePlan = {
    action: "bill";
    /** cus_… the invoice item + invoice attach to. */
    customerId: string;
    /** Integer minor units (cents) — Stripe never takes floats. */
    amountCents: number;
    currency: string;
    /** Human-readable, traces to the recomputable statement. */
    description: string;
    /** Keyed on customer+period so a re-run cannot double-bill. */
    idempotencyKey: string;
    finalize: boolean;
    /** Carried into the explanatory metadata on the Stripe objects. */
    metadata: Record<string, string>;
} | {
    action: "do_not_bill";
    /** Why nothing is billed: do_not_charge, deficit carried, or chain broken. */
    reason: string;
    /** True only when the ledger failed verification — the hard stop. */
    chainUnverified: boolean;
};
/**
 * Build the Stripe plan for one recomputed invoice.
 *
 * `chainVerified` is passed in (not read from the invoice) because chain
 * verification is the ledger layer's job: the caller verifies the spool and
 * tells us. An unverified chain is a hard DO_NOT_BILL — a statement over an
 * unverifiable ledger is not an invoice.
 */
export declare function buildStripeInvoicePlan(invoice: Invoice, chainVerified: boolean, options: StripeBillingOptions): StripeInvoicePlan;
