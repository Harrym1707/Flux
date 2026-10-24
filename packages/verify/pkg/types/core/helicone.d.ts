import type { GatewayParseResult } from "./gateway.js";
/**
 * Parse Helicone request rows from /v1/request/query output or a CSV-to-JSON
 * export. Rows that cannot be read are reported, never dropped silently.
 */
export declare function parseHeliconeRequests(rows: unknown[], fallbackDate: string): GatewayParseResult;
