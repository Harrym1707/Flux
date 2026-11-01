import { approximateTokenCount, type TokenCounter } from "../../core/dist/src/index.js";

/**
 * Server-tool accumulation meter: ADVISE-ONLY, LOSSLESS.
 *
 * Anthropic's web search and web fetch are server tools: the provider runs
 * them and inserts `web_search_tool_result` / `web_fetch_tool_result` blocks
 * into the assistant turn, and the caller must send those blocks back
 * verbatim on every later turn ("send the assistant's content blocks back
 * exactly as you received them, including each result's encrypted_content";
 * "Web search results retrieved throughout a conversation are counted as
 * input tokens, in search iterations run during a single turn and in
 * subsequent conversation turns" — platform.claude.com web-search-tool page,
 * fetched 2026-10-28). A research loop therefore re-bills every result on
 * every turn after it arrives; prompt caching cuts that re-bill to the read
 * rate (0.1x) but does not remove it.
 *
 * This function measures that share and emits advice. It reads the request
 * and NEVER mutates it (a test asserts the serialised bytes are identical
 * before and after). Every recommendation it makes changes model-visible
 * content or tool behaviour, so each is LOSSY: advice only, never applied by
 * FLUX, and it would need the replay gate (replay-gate.ts) before it could
 * ever bill.
 *
 * Client-side `tool_result` blocks are ignored: they are the caller's own
 * tools, already handled by the stale-tool-result lever (backlog P7).
 */

type AnyObject = Record<string, unknown>;

export type ServerToolModelClass = "sonnet" | "opus" | "haiku" | "other";

export type ServerToolAdvice = {
  code:
    | "upgrade-to-dynamic-filtering"
    | "dynamic-filtering-cost-warning-opus"
    | "set-max-content-tokens"
    | "set-max-uses"
    | "context-editing-clear-server-results"
    | "context-editing-excludes-server-results"
    | "response-inclusion-excluded";
  /** Every piece of advice here changes what the model reads or does. */
  lossy: true;
  message: string;
  /** Where the claim in the message comes from. */
  basis: "literature-claim" | "documented-behaviour" | "measured-in-request";
  source?: string;
};

export type ServerToolHygieneReport = {
  model: string;
  modelClass: ServerToolModelClass;
  /** Local approximate token count of system + messages + tools. */
  inspectedInputTokens: number;
  webSearchResultBlocks: number;
  webFetchResultBlocks: number;
  /**
   * ESTIMATE of the tokens those blocks occupy, from FLUX's local counter on
   * the block as sent. web_search results are encrypted on the wire, so their
   * restored size is approximated by payload size; web_fetch text is counted
   * as plaintext. Never a provider-verbatim figure.
   */
  webSearchResultTokensEstimated: number;
  webFetchResultTokensEstimated: number;
  serverToolResultTokensEstimated: number;
  /** serverToolResultTokensEstimated / inspectedInputTokens (0 when empty). */
  serverToolResultShare: number;
  /** Client-side tool_result blocks seen and deliberately NOT counted above. */
  clientToolResultBlocksIgnored: number;
  /** Server-tool type strings pinned in `tools`, e.g. web_search_20250305. */
  pinnedVersions: string[];
  /** True when a code_execution tool is listed or a 20260209+ web tool auto-provisions it. */
  codeExecutionEnabled: boolean;
  advice: ServerToolAdvice[];
};

const DYNAMIC_FILTERING_FROM = 20260209;
const RESPONSE_INCLUSION_FROM = 20260318;
const BLOG = "https://claude.com/blog/improved-web-search-with-dynamic-filtering (2026-02-17)";
const SEARCH_PAGE = "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool";
const FETCH_PAGE = "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool";
const CONTEXT_EDITING_PAGE = "https://platform.claude.com/docs/en/build-with-claude/context-editing";

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serverToolModelClass(model: string): ServerToolModelClass {
  const lowered = model.toLowerCase();
  if (lowered.includes("opus")) return "opus";
  if (lowered.includes("sonnet")) return "sonnet";
  if (lowered.includes("haiku")) return "haiku";
  return "other";
}

function versionDate(type: string): number | undefined {
  const match = /_(\d{8})$/.exec(type);
  return match ? Number(match[1]) : undefined;
}

function contentBlocks(message: unknown): unknown[] {
  if (!isObject(message)) return [];
  return Array.isArray(message.content) ? message.content : [];
}

/** Measure server-tool result accumulation in one Anthropic Messages request body. Pure; never mutates. */
export function meterServerToolHygiene(
  request: unknown,
  options: { countTokens?: TokenCounter; largeFetchTokens?: number; highShare?: number } = {},
): ServerToolHygieneReport {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const largeFetchTokens = options.largeFetchTokens ?? 8_000;
  const highShare = options.highShare ?? 0.3;
  const body = isObject(request) ? request : {};
  const model = typeof body.model === "string" ? body.model : "unknown";
  const modelClass = serverToolModelClass(model);
  const tools = Array.isArray(body.tools) ? body.tools.filter(isObject) : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const inspectedInputTokens = countTokens(JSON.stringify({
    system: body.system ?? null,
    messages,
    tools,
  }));

  let webSearchResultBlocks = 0;
  let webFetchResultBlocks = 0;
  let webSearchResultTokensEstimated = 0;
  let webFetchResultTokensEstimated = 0;
  let largestFetchTokens = 0;
  let clientToolResultBlocksIgnored = 0;
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (!isObject(block)) continue;
      if (block.type === "web_search_tool_result") {
        webSearchResultBlocks += 1;
        webSearchResultTokensEstimated += countTokens(JSON.stringify(block));
      } else if (block.type === "web_fetch_tool_result") {
        webFetchResultBlocks += 1;
        const tokens = countTokens(JSON.stringify(block));
        webFetchResultTokensEstimated += tokens;
        largestFetchTokens = Math.max(largestFetchTokens, tokens);
      } else if (block.type === "tool_result") {
        clientToolResultBlocksIgnored += 1;
      }
    }
  }
  const serverToolResultTokensEstimated = webSearchResultTokensEstimated + webFetchResultTokensEstimated;
  const serverToolResultShare = inspectedInputTokens === 0 ? 0 : serverToolResultTokensEstimated / inspectedInputTokens;

  const serverTools = tools.filter((tool) =>
    typeof tool.type === "string" && /^(web_search|web_fetch|code_execution)_\d{8}$/.test(tool.type));
  const pinnedVersions = serverTools.map((tool) => tool.type as string).sort();
  const webTools = serverTools.filter((tool) => /^web_(search|fetch)_/.test(tool.type as string));
  const directOnly = (tool: AnyObject): boolean =>
    Array.isArray(tool.allowed_callers) && tool.allowed_callers.length > 0 &&
    tool.allowed_callers.every((caller) => caller === "direct");
  const dynamicTools = webTools.filter((tool) => (versionDate(tool.type as string) ?? 0) >= DYNAMIC_FILTERING_FROM && !directOnly(tool));
  const codeExecutionEnabled = serverTools.some((tool) => (tool.type as string).startsWith("code_execution_")) ||
    dynamicTools.length > 0;

  const advice: ServerToolAdvice[] = [];
  const basicWebTools = webTools.filter((tool) => (versionDate(tool.type as string) ?? 0) < DYNAMIC_FILTERING_FROM);
  if (basicWebTools.length > 0 && modelClass === "sonnet") {
    advice.push({
      code: "upgrade-to-dynamic-filtering",
      lossy: true,
      basis: "literature-claim",
      source: BLOG,
      message: `Pinned ${basicWebTools.map((tool) => tool.type).join(", ")}: on Sonnet-class routes the 20260209+ ` +
        "versions filter results in code before they reach context. Source reports 24% fewer input tokens on " +
        "average and lower price-weighted tokens for Sonnet 4.6 on both benchmarks; not measured on this " +
        "model or workload. Changes what the model reads: needs a replay-gate run before adoption.",
    });
  }
  if (modelClass === "opus" && (basicWebTools.length > 0 || dynamicTools.length > 0)) {
    advice.push({
      code: "dynamic-filtering-cost-warning-opus",
      lossy: true,
      basis: "literature-claim",
      source: BLOG,
      message: "Opus-class route: the source reports price-weighted tokens INCREASED for Opus 4.6 with dynamic " +
        "filtering (accuracy rose). Do not adopt or keep it on cost grounds without measuring on your own traffic.",
    });
  }
  const fetchTools = webTools.filter((tool) => (tool.type as string).startsWith("web_fetch_"));
  if (fetchTools.some((tool) => tool.max_content_tokens === undefined) && largestFetchTokens > largeFetchTokens) {
    advice.push({
      code: "set-max-content-tokens",
      lossy: true,
      basis: "measured-in-request",
      source: FETCH_PAGE,
      message: `A fetched result of ~${largestFetchTokens} tokens (local estimate) is in context and web_fetch sets no ` +
        "max_content_tokens; the tool truncates content above that limit (text only, not PDFs). Truncation " +
        "removes content the model may need: replay-gate before adopting.",
    });
  }
  if (webTools.some((tool) => tool.max_uses === undefined) && (webSearchResultBlocks + webFetchResultBlocks) > 0) {
    advice.push({
      code: "set-max-uses",
      lossy: true,
      basis: "documented-behaviour",
      source: `${SEARCH_PAGE} ; ${FETCH_PAGE}`,
      message: "A web tool sets no max_uses (web_fetch documents \"currently no default limit\"). A cap bounds " +
        "per-request fees and result accumulation; exceeding it returns max_uses_exceeded to the model.",
    });
  }
  const contextManagement = isObject(body.context_management) ? body.context_management : undefined;
  const edits = Array.isArray(contextManagement?.edits) ? contextManagement!.edits.filter(isObject) : [];
  const clearing = edits.filter((edit) => typeof edit.type === "string" && edit.type.startsWith("clear_tool_uses_"));
  if (serverToolResultShare >= highShare && clearing.length === 0) {
    advice.push({
      code: "context-editing-clear-server-results",
      lossy: true,
      basis: "measured-in-request",
      source: CONTEXT_EDITING_PAGE,
      message: `Server-tool results are ~${(serverToolResultShare * 100).toFixed(0)}% of this request (local estimate). ` +
        "clear_tool_uses_20250919 (beta context-management-2025-06-27) clears oldest tool results; it " +
        "invalidates the cached prefix each time it fires, so set clear_at_least high enough to repay the " +
        "re-write. On cached traffic the stale results bill at 0.1x, so the prize is small there.",
    });
  }
  const excluded = clearing.flatMap((edit) => (Array.isArray(edit.exclude_tools) ? edit.exclude_tools : []))
    .filter((name) => name === "web_search" || name === "web_fetch");
  if (excluded.length > 0 && serverToolResultShare >= highShare) {
    advice.push({
      code: "context-editing-excludes-server-results",
      lossy: true,
      basis: "measured-in-request",
      source: CONTEXT_EDITING_PAGE,
      message: `Context editing excludes ${[...new Set(excluded)].join(", ")}, so those results are never cleared and ` +
        `make up ~${(serverToolResultShare * 100).toFixed(0)}% of this request.`,
    });
  }
  const inclusionCapable = dynamicTools.filter((tool) =>
    (versionDate(tool.type as string) ?? 0) >= RESPONSE_INCLUSION_FROM && tool.response_inclusion === undefined);
  if (inclusionCapable.length > 0) {
    advice.push({
      code: "response-inclusion-excluded",
      lossy: true,
      basis: "documented-behaviour",
      source: SEARCH_PAGE,
      message: `${inclusionCapable.map((tool) => tool.type).join(", ")} default to response_inclusion "full"; ` +
        "\"excluded\" drops result blocks consumed by completed code execution from the response. Your " +
        "client then no longer receives them.",
    });
  }

  return {
    model,
    modelClass,
    inspectedInputTokens,
    webSearchResultBlocks,
    webFetchResultBlocks,
    webSearchResultTokensEstimated,
    webFetchResultTokensEstimated,
    serverToolResultTokensEstimated,
    serverToolResultShare,
    clientToolResultBlocksIgnored,
    pinnedVersions,
    codeExecutionEnabled,
    advice,
  };
}
