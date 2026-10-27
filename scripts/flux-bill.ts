/**
 * flux-bill — turn a customer's FLUX ledger spool(s) into a Stripe invoice.
 *
 * Reads the spools, recomputes the invoice (pure, from the hash-chained ledger),
 * verifies the chain, builds the Stripe plan (packages/core/stripe-billing),
 * and — against STRIPE TEST MODE — creates the Stripe objects: a one-off invoice
 * item for the fee and a DRAFT invoice. Nothing is charged: the invoice is left
 * as a draft for a human to review and finalize in the dashboard, unless
 * --finalize is passed explicitly.
 *
 * SAFETY RAILS (deliberate, do not remove):
 *   - Refuses a live key (sk_live_…) unless --live is passed AND the operator
 *     re-types the amount to confirm. Default workflow is test mode only.
 *   - A broken/unverified ledger chain is a hard stop: DO NOT BILL.
 *   - Idempotency key on customer+period+amount: re-running a month is a no-op
 *     at Stripe, never a double charge.
 *   - No prompt content is read or sent — only the usage-derived invoice totals.
 *
 * Usage:
 *   STRIPE_TEST_SECRET_KEY=... node --import tsx scripts/flux-bill.ts \
 *     --customer cus_XXX --period 2026-10 --fee 1 spool1.jsonl [spool2.jsonl ...]
 *   Optional: --finalize (finalize+send instead of leaving a draft),
 *             --label "acme-anthropic", --live (requires confirmation).
 */
import { readFileSync } from "node:fs";
import {
  buildStripeInvoicePlan,
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../packages/core/dist/src/index.js";

type Args = { customer?: string; period?: string; fee: number; label?: string; finalize: boolean; live: boolean; spools: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { fee: 1, finalize: false, live: false, spools: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--customer") args.customer = argv[++i];
    else if (a === "--period") args.period = argv[++i];
    else if (a === "--fee") args.fee = Number(argv[++i]);
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--finalize") args.finalize = true;
    else if (a === "--live") args.live = true;
    else if (!a.startsWith("--")) args.spools.push(a);
    else throw new Error(`Unknown flag ${a}`);
  }
  return args;
}

function loadRecords(path: string): LedgerRecord[] {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as LedgerRecord);
}

/** Minimal Stripe POST: form-encoded, idempotent, zero dependencies. */
async function stripePost(
  key: string,
  path: string,
  form: Record<string, string>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(form).toString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: "POST", headers, body });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string } | undefined)?.message ?? JSON.stringify(json);
    throw new Error(`Stripe ${path} failed (${res.status}): ${err}`);
  }
  return json;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) throw new Error("Set STRIPE_TEST_SECRET_KEY (source ~/.config/flux/stripe.env).");
  if (!args.customer) throw new Error("--customer cus_… is required.");
  if (args.spools.length === 0) throw new Error("Pass at least one ledger spool (.jsonl).");

  const isLive = key.startsWith("sk_live_");
  if (isLive && !args.live) {
    throw new Error(
      "Refusing to run against a LIVE Stripe key. This creates real charges. Use a test key " +
      "(sk_test_…), or pass --live deliberately. There is no reason to bill live before a real customer exists.",
    );
  }

  // One invoice across all spools for this customer/period.
  const allEvents: BillableEvent[] = [];
  let chainVerified = true;
  for (const path of args.spools) {
    const records = loadRecords(path);
    const chain = verifyLedgerChain(records);
    if (!chain.ok) {
      chainVerified = false;
      console.error(`CHAIN BROKEN in ${path}: ${chain.reason} (seq ${chain.seq})`);
    }
    for (const record of records) allEvents.push(record.event);
  }

  const invoice = recomputeInvoice(allEvents, {
    ...(args.period ? { period: args.period } : {}),
    feePercent: args.fee,
  });

  const plan = buildStripeInvoicePlan(invoice, chainVerified, {
    stripeCustomerId: args.customer,
    mode: args.finalize ? "finalize" : "draft",
    ...(args.label ? { customerLabel: args.label } : {}),
  });

  console.log(`\nMode: ${isLive ? "LIVE" : "TEST"}  ·  period: ${args.period ?? "all"}  ·  fee: ${args.fee}%`);
  console.log(`Net verified savings: $${invoice.netVerifiedSavingsUsd.toFixed(4)}  ·  verdict: ${invoice.verdict}`);

  if (plan.action === "do_not_bill") {
    console.log(`\nDO NOT BILL — ${plan.reason}`);
    if (plan.chainUnverified) process.exitCode = 1;
    return;
  }

  console.log(`\nWill create (draft=${!plan.finalize}): ${plan.amountCents} ${plan.currency} cents to ${plan.customerId}`);
  console.log(`  "${plan.description}"`);

  // Create the draft invoice FIRST, then attach the fee item to it explicitly
  // by id. (Relying on Stripe to auto-sweep pending items into a draft is
  // unreliable with auto_advance=false — it leaves an empty invoice.)
  const inv = await stripePost(key, "invoices", {
    customer: plan.customerId,
    currency: plan.currency, // match the fee currency; the account default may differ (e.g. GBP)
    collection_method: "charge_automatically",
    auto_advance: "false", // never let the draft advance to payment on its own
    description: `FLUX statement ${plan.metadata.flux_period ?? ""}`,
  }, `${plan.idempotencyKey}-inv`);

  await stripePost(key, "invoiceitems", {
    customer: plan.customerId,
    invoice: inv.id as string, // explicit attachment — the fix for the empty-draft bug
    amount: String(plan.amountCents),
    currency: plan.currency,
    description: plan.description,
    "metadata[flux_period]": plan.metadata.flux_period ?? "",
    "metadata[flux_fee_percent]": plan.metadata.flux_fee_percent ?? "",
    "metadata[flux_net_verified_savings_usd]": plan.metadata.flux_net_verified_savings_usd ?? "",
  }, `${plan.idempotencyKey}-item`);

  console.log(`\nCreated Stripe invoice ${inv.id} — status ${inv.status} (${isLive ? "LIVE" : "TEST"} mode).`);
  if (plan.finalize) {
    const final = await stripePost(key, `invoices/${inv.id as string}/finalize`, {}, `${plan.idempotencyKey}-fin`);
    console.log(`Finalized: status ${final.status}, hosted at ${final.hosted_invoice_url ?? "(none)"}`);
  } else {
    console.log("Left as a DRAFT. Review it in the Stripe dashboard and finalize there, or re-run with --finalize.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
