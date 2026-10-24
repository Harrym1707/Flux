import type { GatewayParseResult } from "./gateway.js";
/**
 * Parse Langfuse generation rows from the public API or an export. Rows that
 * are not generations (spans, events) are skipped silently; rows that are
 * generations but unreadable are reported.
 */
export declare function parseLangfuseGenerations(rows: unknown[], fallbackDate: string): GatewayParseResult;
