import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withFlux } from "./openai.js";
import type { FluxTokenReductionConfig } from "./reduce-request.js";

/**
 * wrapFlux — the one-line drop-in for an existing provider client.
 *
 *   import OpenAI from "openai";
 *   import { wrapFlux } from "@flux-ai/sdk";
 *   const openai = wrapFlux(new OpenAI());   // <- the only change
 *   // ...use `openai` exactly as before...
 *   console.log(openai.flux.savings());      // { requests, savedUsd, ... }
 *
 * This is `withFlux` with sane, zero-config defaults for someone who just wants
 * their AI app to spend less without learning the proxy, the ledger, or any
 * options object. The client's response shapes are preserved, its own key is
 * used, prompts never leave the machine, and reduction is LOSSLESS-ONLY by
 * default — so there is no quality risk to switching one import.
 *
 * The savings number is the real measured one: every request appends a
 * hash-chained ledger event priced from provider-reported usage, and
 * `flux.savings()` recomputes the invoice from that spool — the same audit a
 * customer runs. It is never FLUX's own token estimate.
 */

export type WrapFluxOptions = {
  /** Names this app on the ledger + invoice. Default "app". */
  app?: string;
  /** Where the hash-chained savings ledger is written. Default ./.flux/<app>.jsonl */
  ledgerPath?: string;
  /** Catalogue provider key for pricing. Auto-detected from the client; override if needed. */
  provider?: string;
  /** Override reduction. Default: lossless-only (safe, no quality gate needed). */
  tokenReduction?: FluxTokenReductionConfig;
  /** Opt into the Anthropic prompt-cache stamp on multi-turn traffic ("5m" | "1h"). */
  cacheTtl?: "5m" | "1h";
};

export type FluxSavingsSummary = {
  /** Requests metered through FLUX for this app. */
  requests: number;
  /** Net verified savings in USD (never FLUX's token estimate; from provider usage). */
  savedUsd: number;
  /** FLUX's fee at 1% of verified savings. */
  feeUsd: number;
  verdict: "charge" | "do_not_charge";
  ledgerPath: string;
};

export type FluxHandle = {
  /** Recompute the measured savings from the ledger spool. */
  savings(): FluxSavingsSummary;
  /** The ledger spool path, for `recomputeInvoice` / `flux-report`. */
  ledgerPath: string;
};

const LOSSLESS_DEFAULT: FluxTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

function looksAnthropic(client: unknown): boolean {
  const c = client as Record<string, any> | null;
  const hasMessages = typeof c?.messages?.create === "function";
  const hasChat = typeof c?.chat?.completions?.create === "function";
  const hasResponses = typeof c?.responses?.create === "function";
  return hasMessages && !hasChat && !hasResponses;
}

export function wrapFlux<T extends object>(client: T, options: WrapFluxOptions = {}): T & { flux: FluxHandle } {
  const app = options.app ?? "app";
  const ledgerPath = options.ledgerPath ?? join(process.cwd(), ".flux", `${app}.jsonl`);
  const provider = options.provider ?? (looksAnthropic(client) ? "anthropic" : "openai");
  const tokenReduction: FluxTokenReductionConfig = {
    ...(options.tokenReduction ?? LOSSLESS_DEFAULT),
    ...(options.cacheTtl ? { cacheTtl: options.cacheTtl } : {}),
  };

  const wrapped = withFlux(client as never, {
    applicationId: app,
    tokenReduction,
    ledger: { path: ledgerPath, provider },
  }) as T;

  const flux: FluxHandle = {
    ledgerPath,
    savings(): FluxSavingsSummary {
      const empty: FluxSavingsSummary = {
        requests: 0, savedUsd: 0, feeUsd: 0, verdict: "do_not_charge", ledgerPath,
      };
      let records: LedgerRecord[];
      try {
        const lines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) return empty;
        records = lines.map((line) => JSON.parse(line) as LedgerRecord);
      } catch {
        return empty;
      }
      // A broken chain means the spool was tampered or truncated: report nothing
      // rather than a number that cannot be trusted.
      if (!verifyLedgerChain(records).ok) return empty;
      const invoice = recomputeInvoice(records.map((r) => r.event), { feePercent: 1 });
      return {
        requests: invoice.eventsConsidered,
        savedUsd: invoice.netVerifiedSavingsUsd,
        feeUsd: invoice.amountDueUsd ?? 0,
        verdict: invoice.verdict,
        ledgerPath,
      };
    },
  };

  // One more proxy layer over withFlux's: everything passes through to the
  // wrapped client, and the synthetic `flux` handle surfaces the savings.
  return new Proxy(wrapped as T & { flux: FluxHandle }, {
    get(target, property, receiver) {
      if (property === "flux") return flux;
      return Reflect.get(target, property, receiver);
    },
  });
}
