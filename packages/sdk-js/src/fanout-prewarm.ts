import { anthropicCacheableMinimumTokens } from "../../core/dist/src/model-prices.js";
import { approximateTokenCount, type TokenCounter } from "../../core/dist/src/token-reduction.js";

/**
 * The multi-agent FAN-OUT cache race, and the one lossless fix for it.
 *
 * An orchestrator spawning a review/research team dispatches N sub-agent
 * calls together (Promise.all, LangGraph's Send API, CrewAI's parallel
 * tasks). Every sibling shares an identical prefix — the Claude Agent SDK's
 * own subagent docs confirm this: a fresh subagent context still inherits
 * the project's CLAUDE.md-equivalent instructions and the team's tool
 * definitions from the parent, just not its conversation history — plus
 * whatever briefing the orchestrator handed the whole team.
 *
 * A provider's prompt cache is a WRITE made visible to later reads only once
 * the writing call's response has actually come back. Dispatched together,
 * none of N concurrent calls can read a sibling's write before it exists:
 * every one of them independently pays the provider's cache-WRITE premium
 * for the identical shared prefix, and nothing ever reads it back. Measured
 * in evals/run-multiagent-fanout.ts: simply turning MESH's cache stamp on
 * for this shape, with no change to dispatch order, is a NEGATIVE lever — it
 * adds the write premium with no offsetting read.
 *
 * The fix changes nothing about content (lossless by construction, not by
 * gate): issue ONE pre-warm call carrying just the shared prefix, with a
 * trivial instruction and a tiny output cap, and wait for it to complete
 * BEFORE dispatching the real N calls. One call now pays the write; every
 * sibling after it reads the warm cache instead.
 *
 * This is a planning function, not a network call: MESH's proxy sees one
 * request at a time and has no visibility into a caller's own fan-out, so
 * the orchestrator (or its framework adapter) must call this once it has
 * assembled a batch, await the returned `prewarm` request if one is given,
 * then dispatch `dispatch` exactly as it would have anyway.
 */

type AnyObject = Record<string, unknown>;

export type FanoutPrewarmOptions = {
  /** Below this many requests there is nothing to race, so nothing to fix. Default 2. */
  minimumBatchSize?: number;
  /**
   * Below this many shared prefix tokens, pre-warming cannot pay for itself:
   * the provider will not cache the prefix at all. Defaults to the SMALLER
   * of the two providers' published minimums (1,024; 2,048 on Anthropic
   * Haiku models) via `anthropicCacheableMinimumTokens`, so the default is
   * conservative rather than tuned to either provider.
   */
  minimumSharedPrefixTokens?: number;
  countTokens?: TokenCounter;
};

export type FanoutPrewarmPlan = {
  /**
   * The single request to send and await before the rest, or null when
   * pre-warming would not help. Byte-identical shared prefix to every
   * request in `dispatch`; its own instruction and output cap are the only
   * difference, so it is as cheap as a prefix write can be made.
   */
  prewarm: AnyObject | null;
  /** The original requests, UNCHANGED, in their original order. */
  dispatch: readonly AnyObject[];
  /** Present when prewarm is null: why. */
  reason?: string;
};

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function systemOf(request: AnyObject): unknown {
  return request.system ?? request.instructions ?? null;
}

function toolsOf(request: AnyObject): unknown {
  return request.tools ?? null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * Plan a pre-warm for a batch of requests about to be dispatched together.
 *
 * Pure and synchronous: it never sends a request itself, never mutates its
 * input, and returns `dispatch` unchanged on every path — a caller that
 * ignores `prewarm` gets back exactly the batch it passed in.
 */
export function planFanoutPrewarm(
  requests: readonly AnyObject[],
  options: FanoutPrewarmOptions = {},
): FanoutPrewarmPlan {
  const minimumBatchSize = options.minimumBatchSize ?? 2;
  const countTokens = options.countTokens ?? approximateTokenCount;

  if (requests.length < minimumBatchSize) {
    return { prewarm: null, dispatch: requests, reason: "batch is too small for a race to matter" };
  }
  if (!requests.every(isPlainObject)) {
    return { prewarm: null, dispatch: requests, reason: "not every request in the batch is a plain object" };
  }

  const first = requests[0]!;
  const sharedSystem = systemOf(first);
  const sharedTools = toolsOf(first);
  const systemText = stableStringify(sharedSystem);
  const toolsText = stableStringify(sharedTools);

  const allShared = requests.every(
    (request) => stableStringify(systemOf(request)) === systemText && stableStringify(toolsOf(request)) === toolsText,
  );
  if (!allShared) {
    return { prewarm: null, dispatch: requests, reason: "requests in this batch do not share an identical system/tools prefix" };
  }

  const model = typeof first.model === "string" ? first.model : "";
  const minimumSharedPrefixTokens = options.minimumSharedPrefixTokens ?? anthropicCacheableMinimumTokens(model);
  const sharedPrefixTokens = countTokens(`${systemText}\n${toolsText}`);
  if (sharedPrefixTokens < minimumSharedPrefixTokens) {
    return {
      prewarm: null,
      dispatch: requests,
      reason: `shared prefix is only ~${sharedPrefixTokens} tokens, below the ${minimumSharedPrefixTokens}-token ` +
        "minimum either provider will cache, so pre-warming could not pay for itself",
    };
  }

  // Anthropic shape carries `messages`; OpenAI's Responses shape carries
  // `input`. Mirror whichever one the batch actually uses so the pre-warm
  // request is valid on the same endpoint as the real calls.
  const prewarmMessage = { role: "user", content: "Acknowledge receipt of context." };
  const prewarm: AnyObject = {
    ...(typeof first.model === "string" ? { model: first.model } : {}),
    ...(first.system !== undefined ? { system: first.system } : {}),
    ...(first.instructions !== undefined ? { instructions: first.instructions } : {}),
    ...(first.tools !== undefined ? { tools: first.tools } : {}),
    ...(Array.isArray(first.messages) ? { messages: [prewarmMessage] } : {}),
    ...(Array.isArray(first.input) ? { input: [prewarmMessage] } : {}),
    // Anthropic and OpenAI spell the output cap differently; set whichever
    // the batch's own shape would read, defaulting to Anthropic's name.
    max_output_tokens: 4,
    metadata: { meshFanoutPrewarm: true },
  };

  return { prewarm, dispatch: requests };
}
