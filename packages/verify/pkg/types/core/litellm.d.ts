import { reconcileGatewaySpend, signalsFromGateway, type GatewayParseResult, type GatewayRecord } from "./gateway.js";
export type LiteLLMRecord = GatewayRecord;
export type LiteLLMParseResult = GatewayParseResult;
/**
 * Parse LiteLLM spend-log rows, from /spend/logs output, a database export, or
 * a StandardLoggingPayload stream. Rows that cannot be read are reported, never
 * dropped silently.
 */
export declare function parseLiteLLMSpendLogs(rows: unknown[], fallbackDate: string): LiteLLMParseResult;
/**
 * Reconciliation and signal derivation are shared across every connector; see
 * gateway.ts. Re-exported under the LiteLLM names existing callers use.
 */
export declare const reconcileLiteLLMSpend: typeof reconcileGatewaySpend;
export declare const signalsFromLiteLLM: typeof signalsFromGateway;
