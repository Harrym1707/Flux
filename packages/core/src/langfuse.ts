import type { GatewayParseResult, GatewayRecord } from "./gateway.js";
import type { IngestIssue } from "./traffic.js";

/**
 * Langfuse generations adapter.
 *
 * Langfuse is a tracer, not a proxy: it observes what an application already
 * did, so there is no gateway response cache and cacheHits is always empty
 * here. What it records per generation is rich: traceId and sessionId (the
 * episode), userId (the downstream customer), usage in either the legacy
 * promptTokens/completionTokens spelling or the newer usage/usageDetails
 * objects, its own calculated cost, and the full input when capture is on.
 *
 * Cost fields are read but reconciled, not trusted: Langfuse prices from its
 * own model table, which can lag a provider change exactly like LiteLLM's.
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

function providerFor(model: string): string {
  if (/^(?:claude|opus|sonnet|haiku|fable)/i.test(model)) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt|text-)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return "unknown";
}

/**
 * Token usage across Langfuse's three generations of field naming: legacy
 * promptTokens/completionTokens, the usage object with input/output, and the
 * v2 usageDetails map whose keys follow each provider's own spelling.
 */
function usageOf(raw: Row): {
  input?: number;
  output?: number;
  cachedInput: number;
  cacheWriteInput: number;
} {
  const details = isPlainObject(raw.usageDetails) ? raw.usageDetails : undefined;
  const usage = isPlainObject(raw.usage) ? raw.usage : undefined;

  const cachedInput = asNumber(details?.cache_read_input_tokens) ??
    asNumber(details?.input_cached_tokens) ?? asNumber(details?.cached_tokens) ?? 0;
  const cacheWriteInput = asNumber(details?.cache_creation_input_tokens) ?? 0;

  const input = asNumber(details?.input) ?? asNumber(usage?.input) ??
    asNumber(usage?.promptTokens) ?? asNumber(raw.promptTokens) ?? asNumber(raw.inputUsage);
  const output = asNumber(details?.output) ?? asNumber(usage?.output) ??
    asNumber(usage?.completionTokens) ?? asNumber(raw.completionTokens) ?? asNumber(raw.outputUsage);

  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    cachedInput,
    cacheWriteInput,
  };
}

function flattenInput(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) {
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
  if (isPlainObject(value)) {
    return flattenInput(value.messages) ?? flattenInput(value.input) ?? asString(value.prompt);
  }
  return undefined;
}

/**
 * Parse Langfuse generation rows from the public API or an export. Rows that
 * are not generations (spans, events) are skipped silently; rows that are
 * generations but unreadable are reported.
 */
export function parseLangfuseGenerations(rows: unknown[], fallbackDate: string): GatewayParseResult {
  const accepted: GatewayRecord[] = [];
  const issues: IngestIssue[] = [];

  rows.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push({ line: index + 1, reason: "Row is not a JSON object." });
      return;
    }
    // Traces exported alongside generations carry no usage; only generations
    // are billable events.
    const type = asString(raw.type);
    if (type !== undefined && type.toUpperCase() !== "GENERATION") return;

    const model = asString(raw.model) ?? asString(raw.modelId) ?? asString(raw.internalModelId);
    if (model === undefined) {
      issues.push({ line: index + 1, reason: "Generation has no model field." });
      return;
    }
    const usage = usageOf(raw);
    if (usage.input === undefined || usage.output === undefined) {
      issues.push({ line: index + 1, reason: "Generation has no readable token usage." });
      return;
    }
    const started = asString(raw.startTime) ?? asString(raw.timestamp);
    const at = started !== undefined && /^\d{4}-\d{2}-\d{2}/.test(started)
      ? started.slice(0, 10)
      : fallbackDate;

    const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const workload = asString(raw.traceName) ?? asString(raw.name) ?? tags[0] ??
      asString(metadata.workload) ?? asString(raw.environment) ?? model;

    const spend = asNumber(raw.calculatedTotalCost) ?? asNumber(raw.totalCost) ??
      asNumber(raw.totalPrice) ??
      (isPlainObject(raw.costDetails) ? asNumber((raw.costDetails as Row).total) : undefined);

    const promptText = flattenInput(raw.input);
    const episodeId = asString(raw.sessionId) ?? asString(raw.traceId);
    const endUser = asString(raw.userId) ?? asString(metadata.userId);

    accepted.push({
      record: {
        id: asString(raw.id) ?? `langfuse-${index}`,
        model,
        provider: providerFor(model),
        at,
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.cachedInput > 0 ? { cachedInputTokens: usage.cachedInput } : {}),
        ...(usage.cacheWriteInput > 0 ? { cacheWriteInputTokens: usage.cacheWriteInput } : {}),
        ...(promptText === undefined ? {} : { promptText }),
        workload,
        ...(episodeId === undefined ? {} : { episodeId }),
      },
      ...(spend === undefined ? {} : { reportedSpendUsd: spend }),
      ...(endUser === undefined ? {} : { endUser }),
    });
  });

  // A tracer has no response cache of its own to credit.
  return { accepted, cacheHits: [], issues };
}
