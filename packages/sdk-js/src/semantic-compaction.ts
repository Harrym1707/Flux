import { approximateTokenCount, type TokenCounter } from "../../core/dist/src/index.js";
import {
  reduceRequest,
  type FluxReductionChange,
  type FluxReductionSummary,
  type FluxTokenReductionConfig,
} from "./reduce-request.js";
import type { LedgerGateVerdict } from "../../core/dist/src/index.js";

/**
 * PROTOTYPE: local-model semantic compaction of stale input context (Q2.1).
 *
 * This is the one FLUX lever that calls a MODEL rather than a deterministic
 * string transform. It compresses stale tool-result bodies in old turns by
 * handing their text to a compactor the CUSTOMER supplies. FLUX bundles no
 * model, downloads nothing, and opens no socket: the inviolable honesty rule is
 * that prompts never leave the customer's machine, so the only compactor FLUX
 * will ever call is a LOCAL / on-machine one the customer wired in themselves.
 * FLUX's own code here adds zero network egress — it awaits whatever function
 * the customer passed and does nothing else.
 *
 * What it will and will NOT touch:
 *   - ONLY tool-result bodies (environment output), and ONLY in STALE turns.
 *   - NEVER model output (assistant messages are left verbatim, always).
 *   - NEVER user text (the human turns are left verbatim, always).
 *   - NEVER the live / last user turn or anything in the recent-turn window.
 *   - NEVER system or developer instructions.
 *
 * It is LOSSY (a model paraphrase is not the original bytes), so it is OFF by
 * default and double-gated: the ledger will not BILL it without an approved
 * replay-gate verdict (same mechanism as freshToolResultCap / output-cap), and
 * — stricter than those deterministic levers — this pre-pass will not even
 * TOUCH content without an approved verdict in its own config. A deterministic
 * truncation is predictable enough to inspect by eye; a model paraphrase is
 * not, so it may not run on the customer's traffic until a gate has proven, on
 * that customer's own recorded requests, that quality held.
 */

/* --------------------------------------------------------------------------
 * SYNC vs ASYNC — the design decision this prototype had to resolve.
 *
 * reduceRequest (reduce-request.ts) is a PURE, SYNCHRONOUS, hot-path function.
 * The proxy, withFlux, the savings ledger, and — most importantly — the replay
 * gate's tight per-request loop all call it synchronously, and its purity
 * (same request in, same bytes out) is what lets consecutive requests re-emit
 * byte-identical history so a provider's exact-prefix cache keeps matching.
 * Local model inference is async and I/O-bound.
 *
 * Two ways to bridge that were considered:
 *
 *   (A) Make reduceRequest async (reduceRequestAsync replacing it, or an await
 *       inside it). Rejected: it would force every call site above — including
 *       the gate's hot loop and the cache-byte-stability reasoning — to become
 *       async, turning a pure deterministic core into a promise-returning one
 *       for the sake of a single optional, non-deterministic lever. The blast
 *       radius is the whole SDK.
 *
 *   (B) A PRE-PASS: an async stage that runs BEFORE the sync reducer, produces
 *       an already-compacted request, and hands that to reduceRequest
 *       unchanged. CHOSEN. It isolates the one model-driven, I/O-bound,
 *       non-deterministic step into its own awaitable function and leaves the
 *       deterministic core exactly as it is — still pure, still synchronous,
 *       still the thing the gate and the cache logic depend on. reduceRequest
 *       never learns that a model was involved; it just sees a request whose
 *       stale tool results are shorter.
 *
 * `reduceRequestAsync` below is the thin composition of the two: await the
 * pre-pass, then call the untouched synchronous reduceRequest, and merge the
 * compaction change into the summary so before/after spans the whole pipeline.
 * -------------------------------------------------------------------------- */

type AnyObject = Record<string, unknown>;

/**
 * The pluggable adapter. The customer supplies a LOCAL model behind this
 * interface; FLUX bundles none. `compact` may be sync or async — a pre-pass can
 * await either. It is called ONLY to compress stale context, never model output
 * and never the live user turn (this module enforces that; the compactor itself
 * only ever sees the text FLUX decided was eligible).
 */
export type SemanticCompactor = {
  compact(input: {
    /** The stale body text to compress. */
    text: string;
    /** Target ceiling for the compressed result, in FLUX's approximate tokens. */
    maxTokens: number;
    /** What kind of body this is, so a compactor can prompt itself accordingly. */
    kind: "tool-result";
  }): Promise<string> | string;
};

export type SemanticCompactionConfig = {
  /** The customer's LOCAL compactor. Absent => the lever is off (no-op). */
  compactor?: SemanticCompactor;
  /**
   * Replay-gate verdict for the `semantic-compaction` lever. REQUIRED and must
   * be "approved" for the pre-pass to touch ANY content. Absent or "rejected"
   * => the pre-pass is a byte-identical no-op and records why. This is the
   * reducer-level half of the double gate; the ledger still independently
   * refuses to bill the lever without an approved verdict.
   */
  gateVerdict?: LedgerGateVerdict;
  /** Target ceiling for a compacted body, approximate tokens. Default 200. */
  maxTokens?: number;
  /** Only compact once the conversation has at least this many user turns. Default 3. */
  minimumTurns?: number;
  /** The most recent user turns whose content is always left verbatim. Default 2. */
  keepRecentTurns?: number;
  /** FLUX's token counter; defaults to the shared approximate counter. */
  countTokens?: TokenCounter;
};

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A user message that is nothing but tool_result blocks is Anthropic's
 * transport for tool output, not a human turn. Turn counting skips it, exactly
 * as reduce-request.ts does, so the stale boundary lands on the same message in
 * both shapes.
 */
function isToolResultCarrier(message: unknown): boolean {
  return isPlainObject(message) && message.role === "user" && Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => isPlainObject(block) && block.type === "tool_result");
}

function isRealUserTurn(message: unknown): boolean {
  return isPlainObject(message) && message.role === "user" && !isToolResultCarrier(message);
}

/** A target body found in the message array, with everything needed to splice its result back. */
type Target =
  | { kind: "chat-tool"; messageIndex: number; text: string }
  | { kind: "responses-output"; messageIndex: number; text: string }
  | { kind: "anthropic-block"; messageIndex: number; blockIndex: number; text: string };

/**
 * Collect the stale tool-result bodies eligible for compaction.
 *
 * Eligibility is deliberately narrow so the guarantees are crisp:
 *   - the message's turn index is strictly below the stale boundary, so the
 *     recent-turn window and the live/last turn are never in scope;
 *   - the body is a TOOL RESULT (chat `tool` role, Responses
 *     function_call_output, or an Anthropic tool_result block inside a user
 *     message) — never an assistant body (model output) and never user text;
 *   - the body is OVERSIZED (> maxTokens), so small results are left alone.
 */
function collectStaleToolResults(
  messages: unknown[],
  staleBoundary: number,
  maxTokens: number,
  countTokens: TokenCounter,
): Target[] {
  const targets: Target[] = [];
  let turn = -1;
  const oversized = (text: string): boolean => countTokens(text) > maxTokens;

  messages.forEach((message, messageIndex) => {
    if (isRealUserTurn(message)) turn += 1;
    // Only strictly-stale turns. turn === -1 (content before the first user
    // turn, e.g. a seeded system turn) is never compacted either.
    if (turn < 0 || turn >= staleBoundary) return;
    if (!isPlainObject(message)) return;
    const role = typeof message.role === "string" ? message.role : undefined;

    // Chat Completions tool result: { role: "tool", content: string }.
    if (role === "tool" && typeof message.content === "string") {
      if (oversized(message.content)) {
        targets.push({ kind: "chat-tool", messageIndex, text: message.content });
      }
      return;
    }

    // Responses tool output item: { type: "function_call_output", output }.
    if (message.type === "function_call_output" && typeof message.output === "string") {
      if (oversized(message.output)) {
        targets.push({ kind: "responses-output", messageIndex, text: message.output });
      }
      return;
    }

    // Anthropic tool_result blocks travel inside a user-role message. Only the
    // tool_result blocks are eligible; the user's own text (if any) is not.
    if (role === "user" && Array.isArray(message.content)) {
      message.content.forEach((block, blockIndex) => {
        if (!isPlainObject(block) || block.type !== "tool_result") return;
        if (typeof block.content !== "string") return;
        if (oversized(block.content)) {
          targets.push({ kind: "anthropic-block", messageIndex, blockIndex, text: block.content });
        }
      });
    }
    // Assistant messages (model output), system and developer messages are
    // intentionally not reached: they are never eligible.
  });

  return targets;
}

/** Splice one compacted body back into a fresh copy of the message array. */
function applyCompaction(messages: unknown[], target: Target, compacted: string): unknown[] {
  const next = [...messages];
  if (target.kind === "chat-tool") {
    next[target.messageIndex] = { ...(next[target.messageIndex] as AnyObject), content: compacted };
    return next;
  }
  if (target.kind === "responses-output") {
    next[target.messageIndex] = { ...(next[target.messageIndex] as AnyObject), output: compacted };
    return next;
  }
  const message = next[target.messageIndex] as AnyObject;
  const content = [...(message.content as unknown[])];
  content[target.blockIndex] = { ...(content[target.blockIndex] as AnyObject), content: compacted };
  next[target.messageIndex] = { ...message, content };
  return next;
}

export type SemanticCompactionResult = {
  request: unknown;
  /** The lossy change record when compaction ran; absent when nothing changed. */
  change?: FluxReductionChange;
  /** FLUX's approximate input-token count of the targeted fields, before and after. */
  tokensBefore: number;
  tokensAfter: number;
  /** Set when the pre-pass was a no-op, saying why (off, no verdict, nothing stale). */
  skippedReason?: string;
};

/**
 * The async PRE-PASS. Compacts stale tool-result bodies with the customer's
 * local compactor and returns a new request, leaving the original untouched.
 *
 * Hard guard: without an APPROVED gate verdict in the config, this returns the
 * request byte-identical and records why — it refuses to call the compactor at
 * all. A compacted body that is not actually shorter is discarded (the original
 * bytes are kept), so compaction can never make a request larger.
 */
export async function compactStaleContext(
  request: unknown,
  config: SemanticCompactionConfig = {},
): Promise<SemanticCompactionResult> {
  const countTokens = config.countTokens ?? approximateTokenCount;
  const noop = (reason: string): SemanticCompactionResult =>
    ({ request, tokensBefore: 0, tokensAfter: 0, skippedReason: reason });

  if (!isPlainObject(request)) return noop("Request is not an object.");
  if (!config.compactor) return noop("Semantic compaction is off: no compactor supplied.");

  // THE GUARD. A model paraphrase is non-deterministic and unauditable by eye,
  // so unlike the deterministic levers this one will not touch a single byte
  // without a replay-gate verdict that APPROVED it on the customer's own
  // traffic. Absent or rejected => byte-identical no-op.
  if (config.gateVerdict?.verdict !== "approved") {
    return noop(
      "Semantic compaction withheld: no approved replay-gate verdict for the 'semantic-compaction' lever. " +
      "This lossy, model-driven lever may not touch content until a gate has proven quality held on the " +
      "customer's own recorded requests.",
    );
  }

  const maxTokens = config.maxTokens ?? 200;
  const minimumTurns = config.minimumTurns ?? 3;
  const keepRecentTurns = config.keepRecentTurns ?? 2;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("semanticCompaction maxTokens must be a positive integer.");
  if (!Number.isInteger(minimumTurns) || minimumTurns < 1) throw new Error("semanticCompaction minimumTurns must be a positive integer.");
  if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1) throw new Error("semanticCompaction keepRecentTurns must be a positive integer.");

  // Work on whichever message array this surface uses. `messages` is
  // Anthropic/Chat-shaped; `input` is Responses-shaped. A string `input` has no
  // turns and is never compacted (it is the one live prompt).
  const field: "messages" | "input" | undefined =
    Array.isArray((request as AnyObject).messages) ? "messages"
      : Array.isArray((request as AnyObject).input) ? "input"
        : undefined;
  if (field === undefined) return noop("No message array to compact (string or absent input).");

  const messages = (request as AnyObject)[field] as unknown[];
  const totalTurns = messages.filter(isRealUserTurn).length;
  if (totalTurns < minimumTurns) return noop(`Only ${totalTurns} user turn(s); below the ${minimumTurns}-turn minimum.`);
  const staleBoundary = totalTurns - keepRecentTurns;
  if (staleBoundary <= 0) return noop("No stale turns: the whole conversation is inside the recent-turn window.");

  const targets = collectStaleToolResults(messages, staleBoundary, maxTokens, countTokens);
  if (targets.length === 0) return noop("No oversized stale tool-result bodies to compact.");

  const tokensBefore = targets.reduce((sum, target) => sum + countTokens(target.text), 0);
  let compactedMessages = messages;
  let bodiesChanged = 0;
  let tokensAfterTargets = 0;

  // Sequential awaits keep the prototype simple to reason about; a real adapter
  // can batch internally. The compactor only ever sees eligible stale text.
  for (const target of targets) {
    const result = await config.compactor.compact({ text: target.text, maxTokens, kind: "tool-result" });
    const compacted = typeof result === "string" ? result : target.text;
    // Never let compaction grow a body: keep the shorter of the two.
    if (compacted.length < target.text.length) {
      compactedMessages = applyCompaction(compactedMessages, target, compacted);
      bodiesChanged += 1;
      tokensAfterTargets += countTokens(compacted);
    } else {
      tokensAfterTargets += countTokens(target.text);
    }
  }

  if (bodiesChanged === 0) {
    return { request, tokensBefore, tokensAfter: tokensBefore, skippedReason: "Compactor returned nothing shorter." };
  }

  const nextRequest: AnyObject = { ...(request as AnyObject), [field]: compactedMessages };
  const estimatedTokensSaved = Math.max(0, tokensBefore - tokensAfterTargets);
  const change: FluxReductionChange = {
    lever: "semantic-compaction",
    lossless: false,
    estimatedTokensSaved,
    detail: `Semantically compacted ${bodiesChanged} oversized stale tool-result body(ies) with the customer's ` +
      `LOCAL compactor (tokens-before ${tokensBefore}, tokens-after ${tokensAfterTargets}, cap ${maxTokens}; ` +
      `stale boundary at turn ${staleBoundary} of ${totalTurns}, keeping the last ${keepRecentTurns} turn(s) ` +
      "verbatim). LOSSY and model-driven: the prompt never left the machine, and the saving may only be billed " +
      `after an approved replay-gate verdict (ref ${config.gateVerdict.ref}). Model output and user turns were ` +
      "never touched.",
  };
  return { request: nextRequest, change, tokensBefore, tokensAfter: tokensAfterTargets };
}

/**
 * Async entry point: the semantic-compaction PRE-PASS followed by the
 * untouched synchronous reduceRequest, with the compaction change merged into
 * the summary so before/after spans the whole pipeline.
 *
 * This is the only place the async lever meets the sync core. reduceRequest
 * itself stays pure and synchronous (see the design note at the top of this
 * file); callers that do not use semantic compaction keep calling reduceRequest
 * directly and never take on a promise.
 */
export async function reduceRequestAsync(
  request: unknown,
  config: FluxTokenReductionConfig = {},
  semantic: SemanticCompactionConfig = {},
): Promise<{ request: unknown; summary: FluxReductionSummary }> {
  const countTokens = config.countTokens ?? semantic.countTokens ?? approximateTokenCount;
  const measure = (value: unknown): number => {
    try {
      return typeof value === "string" ? countTokens(value) : countTokens(JSON.stringify(value) ?? "");
    } catch {
      return 0;
    }
  };
  const originalBefore = isPlainObject(request)
    ? measure((request as AnyObject).instructions) + measure((request as AnyObject).system) +
      measure((request as AnyObject).input) + measure((request as AnyObject).messages) +
      measure((request as AnyObject).tools)
    : 0;

  // The pre-pass shares the reducer's token counter so both measure the same way.
  const pre = await compactStaleContext(request, { ...semantic, countTokens });
  const reduced = reduceRequest(pre.request, config);

  if (pre.change === undefined) return reduced;

  // Merge: the compaction change leads, and before/after is recomputed across
  // the whole pipeline (original request -> fully reduced request), because
  // reduceRequest measured only its own input, which was already compacted.
  const afterAll = isPlainObject(reduced.request)
    ? measure((reduced.request as AnyObject).instructions) + measure((reduced.request as AnyObject).system) +
      measure((reduced.request as AnyObject).input) + measure((reduced.request as AnyObject).messages) +
      measure((reduced.request as AnyObject).tools)
    : originalBefore;
  const changes = [pre.change, ...reduced.summary.changes];
  const summary: FluxReductionSummary = {
    estimatedTokensBefore: originalBefore,
    estimatedTokensAfter: afterAll,
    estimatedTokensSaved: Math.max(0, originalBefore - afterAll),
    estimatedLosslessTokensSaved: changes
      .filter((change) => change.lossless)
      .reduce((sum, change) => sum + change.estimatedTokensSaved, 0),
    changes,
    skipped: false,
  };
  config.onReduction?.(summary);
  return { request: reduced.request, summary };
}
