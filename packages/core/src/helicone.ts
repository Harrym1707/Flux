import type { GatewayParseResult, GatewayRecord } from "./gateway.js";
import type { IngestIssue } from "./traffic.js";

/**
 * Helicone request-log adapter.
 *
 * Helicone proxies requests and logs them; /v1/request/query returns rows with
 * request_id, request_created_at, model, prompt_tokens, completion_tokens,
 * cost, request_user_id, a properties map carrying Helicone-Session-Id and
 * custom tags, and - when includeInputs is set - the full request_body.
 *
 * Two things make Helicone logs unusually good input:
 *
 *   It records PROVIDER cache usage per row (prompt_cache_read_tokens and
 *   prompt_cache_write_tokens), so the already-optimised verdict rests on the
 *   provider's own numbers rather than inference.
 *
 *   Its own response cache marks served rows (cache_hit, or the
 *   Helicone-Cache property set to HIT). Those rows never enter the baseline:
 *   no provider call happened, and that saving is the customer's already.
 */

type Row = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerFor(model: string, explicit?: string): string {
  if (explicit) return explicit.toLowerCase();
  if (/^(?:claude|opus|sonnet|haiku|fable)/i.test(model)) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt|text-)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return "unknown";
}

/** Case-insensitive lookup in Helicone's properties map. */
function property(properties: Row, name: string): string | undefined {
  for (const [key, value] of Object.entries(properties)) {
    if (key.toLowerCase() === name.toLowerCase()) return asString(value);
  }
  return undefined;
}

function flattenMessages(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts: string[] = [];
  for (const message of value) {
    if (!isPlainObject(message)) continue;
    const content = message.content;
    if (typeof content === "string" && content.trim() !== "") parts.push(content);
    else if (Array.isArray(content)) {
      for (const piece of content) {
        if (isPlainObject(piece) && typeof piece.text === "string") parts.push(piece.text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * Parse Helicone request rows from /v1/request/query output or a CSV-to-JSON
 * export. Rows that cannot be read are reported, never dropped silently.
 */
export function parseHeliconeRequests(rows: unknown[], fallbackDate: string): GatewayParseResult {
  const accepted: GatewayRecord[] = [];
  const cacheHits: GatewayRecord[] = [];
  const issues: IngestIssue[] = [];

  rows.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push({ line: index + 1, reason: "Row is not a JSON object." });
      return;
    }
    const properties = isPlainObject(raw.request_properties)
      ? raw.request_properties
      : isPlainObject(raw.properties) ? raw.properties : {};
    const model = asString(raw.model) ?? asString(raw.request_model) ?? asString(raw.response_model);
    if (model === undefined) {
      issues.push({ line: index + 1, reason: "No model field." });
      return;
    }
    const inputTokens = asNumber(raw.prompt_tokens);
    const outputTokens = asNumber(raw.completion_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
      issues.push({ line: index + 1, reason: "Missing prompt_tokens or completion_tokens." });
      return;
    }
    const created = asString(raw.request_created_at) ?? asString(raw.response_created_at) ??
      asString(raw.created_at);
    const at = created !== undefined && /^\d{4}-\d{2}-\d{2}/.test(created)
      ? created.slice(0, 10)
      : fallbackDate;

    // Provider cache usage, which Helicone logs per row. Reads and writes sit
    // alongside prompt_tokens, so total input is their sum - the same
    // convention as Anthropic's own usage block.
    const cacheRead = asNumber(raw.prompt_cache_read_tokens) ?? 0;
    const cacheWrite = asNumber(raw.prompt_cache_write_tokens) ?? 0;

    const requestBody = isPlainObject(raw.request_body) ? raw.request_body : undefined;
    const promptText = requestBody === undefined
      ? undefined
      : flattenMessages(requestBody.messages) ?? asString(requestBody.prompt);
    const toolSchemaText = requestBody !== undefined && Array.isArray(requestBody.tools) &&
      requestBody.tools.length > 0
      ? JSON.stringify(requestBody.tools)
      : undefined;

    const sessionId = property(properties, "Helicone-Session-Id") ??
      asString(raw.session_id) ?? asString(raw.trace_id);
    const workload = property(properties, "Helicone-Session-Path")?.split("/").filter(Boolean)[0] ??
      property(properties, "Helicone-Property-Workload") ??
      property(properties, "workload") ?? property(properties, "app") ??
      asString(raw.request_path) ?? model;

    const spend = asNumber(raw.cost) ?? asNumber(raw.costUSD) ?? asNumber(raw.provider_total_cost);
    const endUser = asString(raw.request_user_id) ?? property(properties, "Helicone-User-Id");

    const entry: GatewayRecord = {
      record: {
        id: asString(raw.request_id) ?? asString(raw.response_id) ?? `helicone-${index}`,
        model,
        provider: providerFor(model, asString(raw.provider)),
        at,
        inputTokens: inputTokens + cacheRead + cacheWrite,
        outputTokens,
        ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {}),
        ...(promptText === undefined ? {} : { promptText }),
        ...(toolSchemaText === undefined ? {} : { toolSchemaText }),
        workload,
        ...(sessionId === undefined ? {} : { episodeId: sessionId }),
      },
      ...(spend === undefined ? {} : { reportedSpendUsd: spend }),
      ...(endUser === undefined ? {} : { endUser }),
    };

    const servedFromHeliconeCache = raw.cache_hit === true || raw.cached === true ||
      property(properties, "Helicone-Cache")?.toUpperCase() === "HIT";
    if (servedFromHeliconeCache) cacheHits.push(entry);
    else accepted.push(entry);
  });

  return { accepted, cacheHits, issues };
}
