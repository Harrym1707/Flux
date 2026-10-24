/**
 * @flux-ai/verify — the verification half of FLUX, under MIT.
 *
 * An honesty claim you cannot independently check is worthless, so the tools
 * that CHECK FLUX's numbers are deliberately licensed apart from the product:
 * verify the hash chain of a ledger spool and recompute the invoice from it,
 * with no FLUX account, no network access, and no BUSL terms attached.
 * If your recompute disagrees with FLUX's number, yours wins.
 */
export {
  LEDGER_GENESIS_HASH,
  auditEventPricing,
  chainLedgerRecord,
  ledgerEventHash,
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerChainVerification,
  type LedgerRecord,
} from "../../core/src/savings-ledger.js";
export { canonicalJson } from "../../core/src/price-catalogue.js";
