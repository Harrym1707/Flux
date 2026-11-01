import { createHash } from "node:crypto";
import { canonicalJson, type PriceProvenance } from "./price-catalogue.js";
import type { ServerToolUsage } from "./provider-usage.js";

/**
 * Per-request fees for provider-run (server) tools: the part of a customer's
 * bill that is NOT a token cost and that a token-only ledger silently omits.
 *
 * Kept in its OWN catalogue, with its own content hash, rather than folded
 * into the model-price catalogue: adding a field there would change
 * catalogueVersion(publishedModelPrices) and with it every pinned ledger
 * event's audit. A fee is catalogued only when it was read from the
 * provider's own primary page; anything else prices as an explicit
 * "unpriced component", never a guess.
 *
 * These fees are the CUSTOMER's spend. FLUX bills nothing on them: they are
 * recorded on the billable event for statement completeness, and the invoice
 * never reads them (see BillableEvent.serverToolUsage).
 */

export type ServerToolName = "web_search" | "web_fetch" | "code_execution";

export type ServerToolFeeEntry = {
  provider: string;
  tool: ServerToolName;
  /** Inclusive ISO date this fee was observed; earlier dates are unpriced. */
  effectiveFrom: string;
  effectiveTo?: string;
  /** USD per server-tool request as counted in usage.server_tool_use. */
  usdPerRequest: number;
  provenance: PriceProvenance;
};

export type ServerToolFeeCatalogue = {
  entries: ServerToolFeeEntry[];
};

const OBSERVED_ON = "2026-10-28";

export const publishedServerToolFees: ServerToolFeeCatalogue = {
  entries: [
    {
      provider: "anthropic",
      tool: "web_search",
      effectiveFrom: OBSERVED_ON,
      usdPerRequest: 10 / 1_000,
      provenance: {
        source: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool",
        capturedOn: OBSERVED_ON,
        note: "\"Web search is available on the Claude API for $10 USD per 1,000 searches, plus standard " +
          "token costs for search-generated content.\" \"If an error occurs during web search, the web " +
          "search will not be billed.\" Batch: \"priced the same as those in regular Messages API requests\".",
      },
    },
    {
      provider: "anthropic",
      tool: "web_fetch",
      effectiveFrom: OBSERVED_ON,
      usdPerRequest: 0,
      provenance: {
        source: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool",
        capturedOn: OBSERVED_ON,
        note: "\"Web fetch usage has no additional charges beyond standard token costs\".",
      },
    },
    // code_execution is deliberately NOT catalogued: it bills by container
    // execution time (5-minute minimum, 1,550 free hours per organization per
    // month, then $0.05 per hour per container), and is free alongside
    // web_search/web_fetch 20260209+ (code-execution-tool page, 2026-10-28).
    // A response reports only code_execution_requests, so no per-request fee
    // is derivable from it; the ledger flags it as an unpriced component.
  ],
};

export function serverToolFeeCatalogueVersion(catalogue: ServerToolFeeCatalogue): string {
  return createHash("sha256").update(canonicalJson(catalogue)).digest("hex");
}

export type ServerToolFeeComponent = {
  tool: ServerToolName | string;
  requests: number;
  /**
   * "priced": a catalogued non-zero fee applied. "no_fee": the catalogue
   * records the provider's published zero fee. "unpriced component": no
   * catalogued fee for this tool/date, so the spend is real but unquantified.
   */
  status: "priced" | "no_fee" | "unpriced component";
  feeUsd?: number;
  reason?: string;
};

/** The ledger's record of one request's server-tool usage. Customer-attributed; never billed. */
export type LedgerServerToolUsage = {
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  other?: Record<string, number>;
  /** Whose spend this is. Always the customer's: FLUX claims no saving on it. */
  attributedTo: "customer";
  /** Sum of priced components only; absent when nothing priced. */
  feeUsd?: number;
  /** True when any non-zero count had no catalogued fee. */
  hasUnpricedComponent: boolean;
  feeCatalogueVersion: string;
  components: ServerToolFeeComponent[];
};

function feeFor(
  catalogue: ServerToolFeeCatalogue,
  provider: string,
  tool: string,
  at: string,
): ServerToolFeeEntry | undefined {
  const matches = catalogue.entries.filter((entry) =>
    entry.provider === provider && entry.tool === tool &&
    entry.effectiveFrom <= at && (entry.effectiveTo === undefined || at < entry.effectiveTo));
  // Overlapping entries are ambiguous; ambiguity prices unpriced, never picks one.
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Price one request's server-tool counts against the fee catalogue. Pure and
 * recomputable: the same counts, provider, date and catalogue always yield
 * the same record, so an auditor can re-derive feeUsd from the event alone.
 */
export function priceServerToolUsage(
  catalogue: ServerToolFeeCatalogue,
  input: { provider: string; at: string; usage: ServerToolUsage },
): LedgerServerToolUsage {
  const provider = input.provider.replace(/-compatible$/, "");
  const counts: Array<[string, number]> = [
    ["web_search", input.usage.webSearchRequests],
    ["web_fetch", input.usage.webFetchRequests],
    ["code_execution", input.usage.codeExecutionRequests],
    ...Object.entries(input.usage.other ?? {}),
  ];
  const components: ServerToolFeeComponent[] = [];
  for (const [tool, requests] of counts) {
    if (requests <= 0) continue;
    const entry = feeFor(catalogue, provider, tool, input.at);
    if (entry === undefined) {
      components.push({
        tool,
        requests,
        status: "unpriced component",
        reason: tool === "code_execution"
          ? "code execution bills by container execution time, which the response does not report"
          : `no catalogued ${provider} ${tool} fee on ${input.at}`,
      });
      continue;
    }
    const feeUsd = requests * entry.usdPerRequest;
    components.push({ tool, requests, status: entry.usdPerRequest === 0 ? "no_fee" : "priced", feeUsd });
  }
  const priced = components.filter((component) => component.status !== "unpriced component");
  return {
    webSearchRequests: input.usage.webSearchRequests,
    webFetchRequests: input.usage.webFetchRequests,
    codeExecutionRequests: input.usage.codeExecutionRequests,
    ...(input.usage.other === undefined ? {} : { other: input.usage.other }),
    attributedTo: "customer",
    ...(priced.length === 0 ? {} : { feeUsd: priced.reduce((sum, component) => sum + (component.feeUsd ?? 0), 0) }),
    hasUnpricedComponent: components.some((component) => component.status === "unpriced component"),
    feeCatalogueVersion: serverToolFeeCatalogueVersion(catalogue),
    components,
  };
}

/**
 * Customer-side statement view: total server-tool fees across events, and how
 * many events carried spend FLUX could not price. Informational; the invoice
 * (recomputeInvoice) never reads serverToolUsage.
 */
export function summarizeServerToolFees(events: ReadonlyArray<{ serverToolUsage?: LedgerServerToolUsage }>): {
  eventsWithServerTools: number;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  pricedFeeUsd: number;
  eventsWithUnpricedComponent: number;
} {
  let eventsWithServerTools = 0;
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  let codeExecutionRequests = 0;
  let pricedFeeUsd = 0;
  let eventsWithUnpricedComponent = 0;
  for (const event of events) {
    const usage = event.serverToolUsage;
    if (usage === undefined) continue;
    eventsWithServerTools += 1;
    webSearchRequests += usage.webSearchRequests;
    webFetchRequests += usage.webFetchRequests;
    codeExecutionRequests += usage.codeExecutionRequests;
    pricedFeeUsd += usage.feeUsd ?? 0;
    if (usage.hasUnpricedComponent) eventsWithUnpricedComponent += 1;
  }
  return { eventsWithServerTools, webSearchRequests, webFetchRequests, codeExecutionRequests, pricedFeeUsd, eventsWithUnpricedComponent };
}
