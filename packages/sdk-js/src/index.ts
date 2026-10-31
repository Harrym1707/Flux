export { serviceTierOf, withFlux } from "./openai.js";
export * from "./types.js";
export { chooseRoute } from "./routing.js";
export { ExactResponseCache } from "./exact-cache.js";
export { createLocalJsonlCapture } from "./evaluation-capture.js";
export { billableEventFromRequest, createSavingsLedger } from "./savings-ledger.js";
export type { SavingsLedger } from "./savings-ledger.js";
export { startFluxProxy, usageFromSse } from "./proxy.js";
export type { FluxProxy, FluxProxyOptions } from "./proxy.js";
// The customer-side audit surface: everything needed to verify a ledger spool
// and recompute the invoice locally, without the FLUX workspace.
// The pre-contract quote pipeline, so the packaged flux-quote CLI (and any
// design partner) can triage a gateway export without the FLUX workspace.
export { buildQuoteReport, parseGatewayExport, renderQuoteReport } from "../../core/dist/src/index.js";
export type { QuoteExportFormat, QuoteReport, QuoteStreamReport } from "../../core/dist/src/index.js";
export {
  auditEventPricing,
  canonicalJson,
  catalogueVersion,
  chainLedgerRecord,
  ledgerEventHash,
  LEDGER_GENESIS_HASH,
  priceLedgerUsage,
  publishedModelPrices,
  recomputeInvoice,
  verifyLedgerChain,
} from "../../core/dist/src/index.js";
export type {
  BillableEvent,
  Invoice,
  InvoiceLineItem,
  InvoiceOptions,
  InvoiceUnbilledItem,
  LedgerChainVerification,
  LedgerExecutionMode,
  LedgerGateVerdict,
  LedgerLever,
  LedgerLeverKind,
  LedgerPricing,
  LedgerPricingAudit,
  LedgerPricingInput,
  LedgerRecord,
  LedgerUsage,
  PriceCatalogue,
} from "../../core/dist/src/index.js";
export { capToolResultBody, digestStaleBody, reduceRequest } from "./reduce-request.js";
export { compactStaleContext, reduceRequestAsync } from "./semantic-compaction.js";
export type {
  SemanticCompactionConfig,
  SemanticCompactionResult,
  SemanticCompactor,
} from "./semantic-compaction.js";
export { CachePrefixVolatilityGuard, type CacheStampDecision } from "./cache-volatility-guard.js";
export { renderLedgerReport, type LedgerReportOptions, type LedgerReportSpool } from "./report.js";
export type {
  FluxHistoryCompactionConfig,
  FluxReductionChange,
  FluxReductionSummary,
  FluxTokenReductionConfig,
} from "./reduce-request.js";
export {
  exactTextGrader,
  replayGate,
  replayUsage,
  responseText,
  responseToolCalls,
  toolNameGrader,
  toolSelectionGrader,
} from "./replay-gate.js";
export type {
  ReplayCandidate,
  ReplayCandidateResult,
  ReplayComparison,
  ReplayGateOptions,
  ReplayGateResult,
  ReplayGrader,
  ReplayUsage,
  ToolCall,
} from "./replay-gate.js";
export {
  agentGrader,
  compositeGrader,
  factRecallGrader,
  textSimilarityGrader,
  truncationAwareGrader,
} from "./graders.js";
export type { TruncationOptions, WeightedGrader } from "./graders.js";
