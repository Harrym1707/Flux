/**
 * The single shared provider-usage normaliser.
 *
 * Hoisted from the replay gate (packages/sdk-js/src/replay-gate.ts replayUsage)
 * so every FLUX component - the request-path SDK wrapper, the replay gate, and
 * the ledger - reads provider usage through ONE parser. The old arrangement had
 * three divergent parsers: the SDK wrapper's tokenUsage returned undefined on
 * both the Chat Completions shape (prompt_tokens) and the Anthropic shape
 * (cache reads/writes OUTSIDE input_tokens), which silently dropped usage - and
 * therefore billing evidence - on every non-Responses surface.
 *
 * The two provider conventions, both normalised to a TOTAL-INCLUSIVE figure:
 *
 *   OpenAI (Responses and Chat Completions) reports cached tokens INSIDE
 *   input_tokens/prompt_tokens. `prompt_tokens_details.cache_write_tokens` is
 *   informational: OpenAI publishes no cache-write rate, so writes are
 *   normalised to zero and never priced ($0, informational).
 *
 *   Anthropic reports cache reads and writes ALONGSIDE input_tokens:
 *   total input = input_tokens + cache_read_input_tokens + cache writes.
 *   Cache writes may carry a TTL split in `usage.cache_creation`
 *   ({ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}); when both the
 *   split and the flat cache_creation_input_tokens are present they must sum
 *   exactly, or the usage is INVALID rather than silently repaired - a billing
 *   record built on inconsistent provider usage is a dispute, not an estimate.
 *
 * Response-side execution-tier evidence is normalised here too: OpenAI reports
 * a top-level `service_tier` on the response; Anthropic reports
 * `usage.service_tier` ("standard" | "priority" | "batch"). Billing reads the
 * tier the provider ANSWERED with, never the one the request asked for.
 * "priority" maps to standard pricing (FLUX claims no saving on it) and
 * "batch" maps to the batch execution mode.
 */

type AnyObject = Record<string, unknown>;

export type NormalizedProviderUsage = {
  /** Total input billed, inclusive of cache reads and cache writes. */
  inputTokens: number;
  /** Input billed at the full rate: total minus cached minus written. */
  uncachedInputTokens: number;
  /** Input served from the provider's cache, billed at the cached rate. */
  cachedInputTokens: number;
  /** Total input written into the provider's cache (Anthropic bills a premium). */
  cacheWriteInputTokens: number;
  /**
   * TTL split of the cache writes, present ONLY when the provider reported it
   * (Anthropic usage.cache_creation). Absent means the split is unknown, which
   * downstream pricing must treat conservatively, never as "all 5m".
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens: number;
};

export type ProviderUsageResult =
  /** Usage read and internally consistent. */
  | { status: "ok"; usage: NormalizedProviderUsage }
  /** Usage present but unreadable or inconsistent; the reason is auditable. */
  | { status: "invalid"; reason: string }
  /** The response carries no usage object at all. */
  | { status: "missing" };

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Normalise one provider response's usage, or say exactly why it cannot be. */
export function normalizeProviderUsage(response: unknown): ProviderUsageResult {
  if (!isPlainObject(response)) return { status: "missing" };
  const usage = isPlainObject(response.usage) ? response.usage : undefined;
  if (!usage) return { status: "missing" };

  const output = asCount(usage.output_tokens) ?? asCount(usage.completion_tokens);
  if (output === undefined) {
    return { status: "invalid", reason: "Usage carries no readable output_tokens/completion_tokens." };
  }

  const anthropicRead = asCount(usage.cache_read_input_tokens);
  const anthropicWriteFlat = asCount(usage.cache_creation_input_tokens);
  const creation = isPlainObject(usage.cache_creation) ? usage.cache_creation : undefined;

  if (anthropicRead !== undefined || anthropicWriteFlat !== undefined || creation !== undefined) {
    // Anthropic convention: reads and writes OUTSIDE input_tokens.
    const fresh = asCount(usage.input_tokens) ?? 0;
    const cached = anthropicRead ?? 0;
    let written = anthropicWriteFlat ?? 0;
    let write5m: number | undefined;
    let write1h: number | undefined;
    if (creation !== undefined) {
      write5m = asCount(creation.ephemeral_5m_input_tokens) ?? 0;
      write1h = asCount(creation.ephemeral_1h_input_tokens) ?? 0;
      const splitTotal = write5m + write1h;
      if (anthropicWriteFlat !== undefined && splitTotal !== anthropicWriteFlat) {
        return {
          status: "invalid",
          reason: `cache_creation split (5m ${write5m} + 1h ${write1h} = ${splitTotal}) does not sum to ` +
            `cache_creation_input_tokens ${anthropicWriteFlat}.`,
        };
      }
      written = anthropicWriteFlat ?? splitTotal;
    }
    return {
      status: "ok",
      usage: {
        inputTokens: fresh + cached + written,
        uncachedInputTokens: fresh,
        cachedInputTokens: cached,
        cacheWriteInputTokens: written,
        ...(write5m === undefined ? {} : { cacheWrite5mInputTokens: write5m }),
        ...(write1h === undefined ? {} : { cacheWrite1hInputTokens: write1h }),
        outputTokens: output,
      },
    };
  }

  // OpenAI convention (Responses input_tokens / Chat Completions prompt_tokens):
  // cached tokens are INSIDE the total. cache_write_tokens, where present, is
  // informational - OpenAI publishes no cache-write rate - so writes are zero.
  const input = asCount(usage.input_tokens) ?? asCount(usage.prompt_tokens);
  if (input === undefined) {
    return { status: "invalid", reason: "Usage carries no readable input_tokens/prompt_tokens." };
  }
  const details = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const promptDetails = isPlainObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached = asCount(details?.cached_tokens) ?? asCount(promptDetails?.cached_tokens) ?? 0;
  const boundedCached = Math.min(cached, input);
  return {
    status: "ok",
    usage: {
      inputTokens: input,
      uncachedInputTokens: input - boundedCached,
      cachedInputTokens: boundedCached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
    },
  };
}

/** Convenience view of normalizeProviderUsage: the usage, or undefined. */
export function providerUsage(response: unknown): NormalizedProviderUsage | undefined {
  const result = normalizeProviderUsage(response);
  return result.status === "ok" ? result.usage : undefined;
}

/**
 * Anthropic server-tool request counts, read from `usage.server_tool_use`.
 *
 * Deliberately a SEPARATE reader from normalizeProviderUsage, which stays
 * byte-for-byte unchanged: server tools carry fees that are not token costs
 * (web search bills per search on top of tokens), so they must never leak
 * into the token figures the cache and tier economics are priced from.
 * Field names as documented on platform.claude.com (fetched 2026-10-28):
 * web_search_requests (web-search-tool page), web_fetch_requests (web-fetch-
 * tool page), code_execution_requests (code-execution-tool page). Any other
 * non-negative numeric counter in the object is kept verbatim in `other`, so
 * a new server tool is visible on the ledger rather than silently dropped.
 */
export type ServerToolUsage = {
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  /** Unrecognised server_tool_use counters, by provider field name. */
  other?: Record<string, number>;
};

const KNOWN_SERVER_TOOL_FIELDS = new Set(["web_search_requests", "web_fetch_requests", "code_execution_requests"]);

/** Server-tool counts on one response, or undefined when it reports none (all zero counts as none). */
export function providerServerToolUsage(response: unknown): ServerToolUsage | undefined {
  if (!isPlainObject(response)) return undefined;
  const usage = isPlainObject(response.usage) ? response.usage : undefined;
  const serverToolUse = usage !== undefined && isPlainObject(usage.server_tool_use) ? usage.server_tool_use : undefined;
  if (serverToolUse === undefined) return undefined;
  const other: Record<string, number> = {};
  for (const [field, value] of Object.entries(serverToolUse)) {
    if (KNOWN_SERVER_TOOL_FIELDS.has(field)) continue;
    const count = asCount(value);
    if (count !== undefined && count > 0) other[field] = count;
  }
  const result: ServerToolUsage = {
    webSearchRequests: asCount(serverToolUse.web_search_requests) ?? 0,
    webFetchRequests: asCount(serverToolUse.web_fetch_requests) ?? 0,
    codeExecutionRequests: asCount(serverToolUse.code_execution_requests) ?? 0,
    ...(Object.keys(other).length === 0 ? {} : { other }),
  };
  const any = result.webSearchRequests + result.webFetchRequests + result.codeExecutionRequests > 0 ||
    result.other !== undefined;
  return any ? result : undefined;
}

/** Sum server-tool counts across attempts (e.g. a fallback retry); undefined when none reported any. */
export function sumServerToolUsage(usages: ReadonlyArray<ServerToolUsage | undefined>): ServerToolUsage | undefined {
  const present = usages.filter((usage): usage is ServerToolUsage => usage !== undefined);
  if (present.length === 0) return undefined;
  const other: Record<string, number> = {};
  for (const usage of present) {
    for (const [field, count] of Object.entries(usage.other ?? {})) other[field] = (other[field] ?? 0) + count;
  }
  return {
    webSearchRequests: present.reduce((sum, usage) => sum + usage.webSearchRequests, 0),
    webFetchRequests: present.reduce((sum, usage) => sum + usage.webFetchRequests, 0),
    codeExecutionRequests: present.reduce((sum, usage) => sum + usage.codeExecutionRequests, 0),
    ...(Object.keys(other).length === 0 ? {} : { other }),
  };
}

export type ResponseExecutionMode = "standard" | "flex" | "batch";

/**
 * The service tier the provider ANSWERED with: OpenAI's top-level
 * response.service_tier, else Anthropic's usage.service_tier. Returns the
 * provider's own string untouched; map it with executionModeFromServiceTier.
 */
export function responseServiceTier(response: unknown): string | undefined {
  if (!isPlainObject(response)) return undefined;
  if (typeof response.service_tier === "string") return response.service_tier;
  const usage = isPlainObject(response.usage) ? response.usage : undefined;
  return typeof usage?.service_tier === "string" ? usage.service_tier : undefined;
}

/**
 * Map response-side tier evidence onto a billing execution mode. "flex" and
 * "batch" are the only modes with their own catalogue rates; Anthropic's
 * "priority" (and every unknown value) maps to STANDARD pricing, so FLUX never
 * claims a tier saving it cannot price.
 */
export function executionModeFromServiceTier(serviceTier: string | undefined): ResponseExecutionMode {
  if (serviceTier === "flex") return "flex";
  if (serviceTier === "batch") return "batch";
  return "standard";
}
