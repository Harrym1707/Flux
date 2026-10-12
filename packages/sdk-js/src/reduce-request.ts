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

export type FluxHistoryCompactionConfig = {
  /**
   * Compaction starts once the conversation has at least this many user turns.
   * Short conversations are left alone: there is nothing stale to compact.
   */
  minimumTurns?: number;
  /** The most recent turns whose content is always left verbatim. */
  keepRecentTurns?: number;
  /**
   * The compaction boundary only advances in steps of this many turns, so the
   * set of compacted messages is identical across several consecutive requests
   * and the provider's exact-prefix cache can keep matching through them.
   */
  epochTurns?: number;
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
  /**
   * Replace stale tool-result and assistant bodies in old turns with short
   * deterministic digests. Error messages, file paths and the headline sentence
   * survive verbatim; the rest is summarised by a byte count. The boundary only
   * moves in frozen epochs, so consecutive requests re-emit the compacted
   * history byte-identically and the provider cache re-writes once per epoch,
   * never once per turn. `true` uses the defaults; pass an object to tune.
   */
  historyCompaction?: boolean | FluxHistoryCompactionConfig;
  /** Set max_output_tokens when the caller has not. Output is the dearer half. */
  maxOutputTokens?: number;
  /**
   * Execution tier for requests the caller has flagged latency-tolerant.
   * "flex" sets OpenAI's service_tier on the request (batch-level pricing, 50%
   * off input and output, on a synchronous API with a possible 429 fallback to
   * standard). The answer is unchanged - same model, same tokens - so this is
   * deterministic for cost; only latency changes, which is why it must be the
   * CALLER's flag per workload and is never set by default. Applied only when
   * the request does not already carry a service_tier.
   */
  executionTier?: "flex";
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

/** Segments of a stale body that must survive compaction verbatim. */
const STALE_BODY_MUST_KEEP =
  /\b(error|errors|errored|fail|fails|failed|failure|exception|traceback|stack trace|denied|timeout|timed out|warning|fatal|panic|refused|rejected|not found|invalid)\b/i;

/** File paths survive verbatim: they are how later turns refer back. */
const STALE_BODY_FILE_PATH =
  /(?:^|[\s"'`(=[])((?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)[\w.\\/-]+|[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|jsonl|md|yml|yaml|toml|txt|csv|tsv|html|css|go|rs|java|rb|sh|sql|log|xml|lock))\b/;

/**
 * Digest one stale body. Pure function of the text, so every later request in
 * the same epoch re-emits exactly the same bytes, which is what lets the
 * provider's exact-prefix cache match across the compacted region.
 *
 * Kept verbatim: the headline (first sentence), any sentence that mentions an
 * error, and any sentence containing a file path. Everything else collapses to
 * a byte count. If that would not actually shorten the text, the original is
 * returned untouched.
 */
function digestStaleBody(text: string): string {
  const segments = text.split(/(?<=[.!?])\s+|\n+/).filter((segment) => segment.length > 0);
  if (segments.length <= 1) return text;
  const kept: string[] = [];
  let droppedChars = 0;
  for (const [index, segment] of segments.entries()) {
    const keep = index === 0 ||
      STALE_BODY_MUST_KEEP.test(segment) ||
      STALE_BODY_FILE_PATH.test(segment);
    if (keep) kept.push(segment);
    else droppedChars += segment.length;
  }
  if (droppedChars === 0) return text;
  const digest = `${kept.join(" ")} [flux: ${droppedChars} chars of stale detail compacted]`;
  return digest.length < text.length ? digest : text;
}

/** Digest a message body of unknown shape; count how many bodies changed. */
function digestBodyValue(value: unknown, state: { bodies: number }): unknown {
  if (typeof value === "string") {
    const digested = digestStaleBody(value);
    if (digested !== value) state.bodies += 1;
    return digested;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (!isPlainObject(part)) return part;
      if (typeof part.text === "string") {
        const digested = digestStaleBody(part.text);
        if (digested !== part.text) state.bodies += 1;
        return digested === part.text ? part : { ...part, text: digested };
      }
      if ("content" in part) {
        const digested = digestBodyValue(part.content, state);
        return digested === part.content ? part : { ...part, content: digested };
      }
      return part;
    });
  }
  return value;
}

/**
 * Compact stale turns in a message array.
 *
 * A turn starts at each user message. The most recent `keepRecentTurns` turns
 * are always verbatim, and the compaction boundary advances only in steps of
 * `epochTurns`, so several consecutive requests compact exactly the same set of
 * messages into exactly the same bytes: the provider cache pays one re-write
 * per epoch instead of one per turn. User, system and developer messages are
 * never touched; only tool results and assistant bodies in stale turns are.
 */
function compactStaleHistory(
  input: unknown[],
  options: FluxHistoryCompactionConfig,
  countTokens: TokenCounter,
  changes: FluxReductionChange[],
): unknown[] {
  const minimumTurns = options.minimumTurns ?? 3;
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const epochTurns = options.epochTurns ?? 2;
  if (minimumTurns < 1 || keepRecentTurns < 1 || epochTurns < 1) {
    throw new Error("History compaction turn counts must be positive integers.");
  }
  const totalTurns = input.filter((message) => isPlainObject(message) && message.role === "user").length;
  if (totalTurns < minimumTurns) return input;
  const compactedTurns = Math.floor((totalTurns - keepRecentTurns) / epochTurns) * epochTurns;
  if (compactedTurns <= 0) return input;

  const state = { bodies: 0 };
  let savedTokens = 0;
  let turn = -1;
  const next = input.map((message) => {
    if (isPlainObject(message) && message.role === "user") turn += 1;
    if (turn < 0 || turn >= compactedTurns) return message;
    if (!isPlainObject(message)) return message;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role === "user" || role === "system" || role === "developer") return message;

    // Responses-style tool output item: { type: "function_call_output", output }.
    if (message.type === "function_call_output" && typeof message.output === "string") {
      const before = countTokens(message.output);
      const digested = digestBodyValue(message.output, state);
      if (digested === message.output) return message;
      savedTokens += Math.max(0, before - countTokens(digested as string));
      return { ...message, output: digested };
    }

    // Chat-style tool results and stale assistant bodies.
    if ((role === "tool" || role === "assistant") && "content" in message) {
      const before = countTokens(
        typeof message.content === "string" ? message.content : JSON.stringify(message.content) ?? "",
      );
      const digested = digestBodyValue(message.content, state);
      if (digested === message.content) return message;
      savedTokens += Math.max(0, before - countTokens(
        typeof digested === "string" ? digested : JSON.stringify(digested) ?? "",
      ));
      return { ...message, content: digested };
    }
    return message;
  });

  if (state.bodies === 0) return input;
  changes.push({
    lever: "stale-history-compaction",
    lossless: false,
    estimatedTokensSaved: savedTokens,
    detail: `Compacted ${state.bodies} stale tool/assistant body(ies) from the first ${compactedTurns} of ` +
      `${totalTurns} turns into deterministic digests (errors, file paths and headlines kept verbatim). ` +
      `The boundary is frozen to ${epochTurns}-turn epochs so the compacted prefix stays byte-identical ` +
      "across consecutive requests.",
  });
  return next;
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

    // Stale-history compaction, before per-message dedupe so digests are what
    // the later passes (and the wire) see.
    if (config.historyCompaction) {
      const options = isPlainObject(config.historyCompaction) ? config.historyCompaction : {};
      if (Array.isArray(next.input)) {
        next.input = compactStaleHistory(next.input, options, countTokens, changes);
      }
      if (Array.isArray(next.messages)) {
        next.messages = compactStaleHistory(next.messages, options, countTokens, changes);
      }
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

    // Execution tier, only where the caller has not chosen one themselves.
    if (config.executionTier === "flex" && next.service_tier === undefined) {
      next.service_tier = "flex";
      changes.push({
        lever: "execution-tier-flex",
        lossless: true,
        // The saving is a rate change on the whole request, not tokens removed.
        estimatedTokensSaved: 0,
        detail: "Set service_tier to flex: batch-level pricing (50% off) on a synchronous API. Same model, " +
          "same answer; latency may rise and 429s fall back to standard, so this applies only to workloads " +
          "the caller flagged latency-tolerant.",
      });
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
