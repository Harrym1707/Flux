import type { Invoice } from "./savings-ledger.js";

/**
 * Turning a recomputed FLUX invoice into a Stripe charge — the honest way.
 *
 * This module is PURE: it converts an `Invoice` (the output of
 * `recomputeInvoice`, itself a pure function over the customer's own
 * hash-chained ledger) into a `StripeInvoicePlan` — the exact set of Stripe API
 * calls that would bill it. No network here; the executor (flux-bill script)
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
  /** Currency for the invoice. FLUX fees are USD-denominated. */
  currency?: string;
  /**
   * Whether to finalize+send the invoice or leave it as a reviewable DRAFT.
   * Default "draft": nothing is ever charged without a human finalizing it.
   */
  mode?: "draft" | "finalize";
  /** Label for the customer's statement, e.g. the spool set or app id. */
  customerLabel?: string;
};

export type StripeInvoicePlan =
  | {
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
    }
  | {
      action: "do_not_bill";
      /** Why nothing is billed: do_not_charge, deficit carried, or chain broken. */
      reason: string;
      /** True only when the ledger failed verification — the hard stop. */
      chainUnverified: boolean;
    };

const DEFAULT_CURRENCY = "usd";

/**
 * Build the Stripe plan for one recomputed invoice.
 *
 * `chainVerified` is passed in (not read from the invoice) because chain
 * verification is the ledger layer's job: the caller verifies the spool and
 * tells us. An unverified chain is a hard DO_NOT_BILL — a statement over an
 * unverifiable ledger is not an invoice.
 */
export function buildStripeInvoicePlan(
  invoice: Invoice,
  chainVerified: boolean,
  options: StripeBillingOptions,
): StripeInvoicePlan {
  if (!chainVerified) {
    return {
      action: "do_not_bill",
      reason: "Ledger chain failed verification — a statement over an unverifiable ledger is not an invoice.",
      chainUnverified: true,
    };
  }
  if (!options.stripeCustomerId || !options.stripeCustomerId.startsWith("cus_")) {
    throw new Error("A Stripe customer id (cus_…) is required to build a billing plan.");
  }
  if (invoice.feePercent === undefined || invoice.amountDueCents === undefined) {
    throw new Error("Invoice was not recomputed with a feePercent; cannot build a billing plan.");
  }

  if (invoice.verdict !== "charge" || invoice.amountDueCents <= 0) {
    const carried = invoice.carryForwardDeficitOutUsd ?? 0;
    const reason = carried > 0
      ? `do_not_charge: $${carried.toFixed(4)} verified-savings deficit carries forward; fees resume only after it is recovered.`
      : "do_not_charge: the period's net verified savings were not positive, so nothing is billed.";
    return { action: "do_not_bill", reason, chainUnverified: false };
  }

  const currency = (options.currency ?? DEFAULT_CURRENCY).toLowerCase();
  const period = invoice.period ?? "all-recorded-periods";
  const net = invoice.netVerifiedSavingsUsd;
  const carryIn = invoice.carryForwardDeficitInUsd ?? 0;
  const label = options.customerLabel ?? options.stripeCustomerId;

  const description =
    `FLUX fee — ${invoice.feePercent}% of $${(net - carryIn).toFixed(2)} net verified savings` +
    `${carryIn > 0 ? ` (after $${carryIn.toFixed(2)} deficit carried in)` : ""}, period ${period}. ` +
    `Recompute: npx -y -p @flux-ai/verify flux-verify <your spool>. If your recomputation disagrees, yours wins.`;

  return {
    action: "bill",
    customerId: options.stripeCustomerId,
    amountCents: invoice.amountDueCents,
    currency,
    description,
    idempotencyKey: `flux-${options.stripeCustomerId}-${period}-${invoice.amountDueCents}`,
    finalize: options.mode === "finalize",
    metadata: {
      flux_period: period,
      flux_fee_percent: String(invoice.feePercent),
      flux_net_verified_savings_usd: net.toFixed(4),
      flux_events_billed: String(invoice.eventsBilled),
      flux_customer_label: label,
    },
  };
}
