import {
  approximateTokenCount,
  dedupeRepeatedBlocks,
  minifyToolSchemas,
  type TokenCounter,
} from "../../core/dist/src/index.js";

/**
 * Reduce a request before it is sent.
 *
 * This is the part of FLUX that actually lowers a bill rather than measuring how
 * much it could be lowered. It runs on every request, independent of model
 * routing: the levers here spend fewer tokens on the model the caller already
 * chose, so coupling them to a model swap would be backwards.
 *
 * Every transform here is lossless by default. Tool definitions keep their
 * descriptions, only formatting and schema plumbing go, duplicate blocks are
 * exact duplicates, and prefix repair moves text rather than deleting it. The
 * lossy options exist but are opt-in and reported as such, because descriptions
 * are how a model chooses between tools.
 *
 * Nothing here may break a request. Any failure returns the original untouched.
 */

export type FluxReductionChange = {
  lever: string;
  lossless: boolean;
  estimatedTokensSaved: number;
  detail: string;
};

export type FluxReductionSummary = {
  /** Estimated input tokens before reduction, by FLUX's own counter. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  /** Of the above, the share from transforms that cannot change the answer. */
  estimatedLosslessTokensSaved: number;
  changes: FluxReductionChange[];
  /** True when reduction was attempted but the request was returned unchanged. */
  skipped: boolean;
  skippedReason?: string;
};

export type FluxTokenReductionConfig = {
  /**
   * Tool and MCP schema minification. `true` applies the lossless tier only.
   * Pass an object to opt into description trimming, which is a behaviour change.
   */
  toolSchemas?: boolean | {
    descriptions?: "keep" | "truncate" | "drop";
    maximumDescriptionTokens?: number;
  };
  /** Remove exact duplicate blocks from instructions and message text. */
  duplicateContext?: boolean;
  /**
   * Move per-request values (timestamps, request ids) out of the front of the
   * instructions so the stable remainder becomes a cacheable prefix. Providers
   * match an exact prefix, so one changing value at the top of an otherwise
   * identical system prompt costs the whole prompt's cache discount.
   */
  repairCachePrefix?: boolean;
  /** Set max_output_tokens when the caller has not. Output is the dearer half. */
  maxOutputTokens?: number;
  countTokens?: TokenCounter;
  onReduction?: (summary: FluxReductionSummary) => void;
};

type AnyObject = Record<string, unknown>;

/** Values that change per request and therefore end a cacheable prefix. */
const PREFIX_BREAKERS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
];

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move leading per-request values to the end of the instructions.
 *
 * The text is preserved in full and only reordered, so the model still sees
 * every instruction and every value. Only lines in the first part of the prompt
 * are considered: a timestamp buried in the middle is not what ends a prefix.
 */
function repairPrefix(instructions: string): { text: string; moved: string[] } {
  const lines = instructions.split("\n");
  const moved: string[] = [];
  const kept: string[] = [];
  // Only the opening lines can be what breaks the prefix for everything after.
  const window = Math.min(lines.length, 8);
  for (const [index, line] of lines.entries()) {
    const breaks = index < window && PREFIX_BREAKERS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    });
    if (breaks) moved.push(line);
    else kept.push(line);
  }
  if (moved.length === 0) return { text: instructions, moved };
  return { text: [...kept, ...moved].join("\n"), moved };
}

function reduceText(
  text: string,
  config: FluxTokenReductionConfig,
  countTokens: TokenCounter,
  changes: FluxReductionChange[],
  label: string,
): string {
  let current = text;
  if (config.duplicateContext !== false) {
    const before = countTokens(current);
    const reduced = dedupeRepeatedBlocks(24, countTokens).reduce(current);
    const saved = before - countTokens(reduced.text);
    if (saved > 0) {
      current = reduced.text;
      changes.push({
        lever: "duplicate-context-removal",
        lossless: true,
        estimatedTokensSaved: saved,
        detail: `Removed ${reduced.notes.length} duplicate block(s) from ${label}.`,
      });
    }
  }
  return current;
}

/** Collect the text of a Responses-style message, leaving structure untouched. */
function reduceMessageContent(
  content: unknown,
  config: FluxTokenReductionConfig,
  countTokens: TokenCounter,
  changes: FluxReductionChange[],
): unknown {
  if (typeof content === "string") return reduceText(content, config, countTokens, changes, "a message");
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!isPlainObject(part) || typeof part.text !== "string") return part;
      return { ...part, text: reduceText(part.text, config, countTokens, changes, "a message part") };
    });
  }
  return content;
}

/**
 * Apply reduction to one request.
 *
 * Returns the original request and a `skipped` summary if anything goes wrong,
 * because a cheaper request that fails is worth less than an expensive one that
 * works.
 */
export function reduceRequest(
  request: unknown,
  config: FluxTokenReductionConfig = {},
): { request: unknown; summary: FluxReductionSummary } {
  const countTokens = config.countTokens ?? approximateTokenCount;
  const changes: FluxReductionChange[] = [];

  const unchanged = (reason: string): { request: unknown; summary: FluxReductionSummary } => ({
    request,
    summary: {
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      estimatedTokensSaved: 0,
      estimatedLosslessTokensSaved: 0,
      changes: [],
      skipped: true,
      skippedReason: reason,
    },
  });

  if (!isPlainObject(request)) return unchanged("Request is not an object.");

  try {
    const next: AnyObject = { ...request };
    const measure = (value: unknown): number => {
      try {
        return typeof value === "string" ? countTokens(value) : countTokens(JSON.stringify(value) ?? "");
      } catch {
        return 0;
      }
    };
    const before = measure(next.instructions) + measure(next.input) + measure(next.messages) +
      measure(next.tools);

    // Tool catalogue. Lossless unless the caller opts into description trimming.
    if (Array.isArray(next.tools) && next.tools.length > 0 && config.toolSchemas !== false) {
      const toolOptions = isPlainObject(config.toolSchemas) ? config.toolSchemas : {};
      const minified = minifyToolSchemas(next.tools, {
        countTokens,
        descriptions: (toolOptions.descriptions as "keep" | "truncate" | "drop" | undefined) ?? "keep",
        ...(typeof toolOptions.maximumDescriptionTokens === "number"
          ? { maximumDescriptionTokens: toolOptions.maximumDescriptionTokens }
          : {}),
      });
      const saved = minified.tokensBefore - minified.tokensAfter;
      if (saved > 0) {
        next.tools = minified.tools;
        if (minified.losslessTokensSaved > 0) {
          changes.push({
            lever: "tool-schema-compaction",
            lossless: true,
            estimatedTokensSaved: minified.losslessTokensSaved,
            detail: `Compacted ${minified.tools.length} tool definition(s); the decoded schema is unchanged.`,
          });
        }
        if (minified.lossyTokensSaved > 0) {
          changes.push({
            lever: "tool-schema-description-trim",
            lossless: false,
            estimatedTokensSaved: minified.lossyTokensSaved,
            detail: "Trimmed tool descriptions, which is how the model chooses between tools.",
          });
        }
      }
    }

    // Instructions: dedupe, then move prefix breakers to the end.
    if (typeof next.instructions === "string") {
      let instructions = reduceText(next.instructions, config, countTokens, changes, "instructions");
      if (config.repairCachePrefix) {
        const repaired = repairPrefix(instructions);
        if (repaired.moved.length > 0) {
          instructions = repaired.text;
          changes.push({
            lever: "cache-prefix-repair",
            lossless: true,
            // The saving is a cache-rate change, not tokens removed.
            estimatedTokensSaved: 0,
            detail: `Moved ${repaired.moved.length} per-request value(s) out of the prompt prefix, making the ` +
              "stable remainder cacheable. The text is reordered, not removed.",
          });
        }
      }
      next.instructions = instructions;
    }

    if (Array.isArray(next.input)) {
      next.input = next.input.map((message) => {
        if (!isPlainObject(message)) return message;
        if (!("content" in message)) return message;
        return { ...message, content: reduceMessageContent(message.content, config, countTokens, changes) };
      });
    } else if (typeof next.input === "string") {
      next.input = reduceText(next.input as string, config, countTokens, changes, "input");
    }

    // Output budget, only where the caller has not set one themselves.
    if (config.maxOutputTokens !== undefined && next.max_output_tokens === undefined) {
      if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) {
        throw new Error("maxOutputTokens must be a positive integer.");
      }
      next.max_output_tokens = config.maxOutputTokens;
      changes.push({
        lever: "output-cap",
        lossless: false,
        estimatedTokensSaved: 0,
        detail: `Set max_output_tokens to ${config.maxOutputTokens}. Responses that would have run longer are ` +
          "truncated, so this needs checking against real output lengths.",
      });
    }

    const after = measure(next.instructions) + measure(next.input) + measure(next.messages) +
      measure(next.tools);

    const summary: FluxReductionSummary = {
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      estimatedTokensSaved: Math.max(0, before - after),
      estimatedLosslessTokensSaved: changes
        .filter((change) => change.lossless)
        .reduce((sum, change) => sum + change.estimatedTokensSaved, 0),
      changes,
      skipped: false,
    };
    config.onReduction?.(summary);
    return { request: changes.length === 0 ? request : next, summary };
  } catch (cause) {
    return unchanged(cause instanceof Error ? cause.message : String(cause));
  }
}
