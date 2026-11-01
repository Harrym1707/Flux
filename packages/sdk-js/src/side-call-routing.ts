/**
 * Side-call routing (LOSSY, off by default).
 *
 * Chat front-ends make auxiliary "task" calls next to the real conversation:
 * a chat title, chat tags, follow-up suggestions. Open WebUI sends them to the
 * chat model itself unless an admin configures a separate task model
 * (backend/open_webui/utils/task.py `get_task_model_id` starts from the chat
 * model and only swaps when TASK_MODEL / TASK_MODEL_EXTERNAL is set; both
 * default to ''). Title + tags fire once per new chat, follow-ups after EVERY
 * assistant reply (src/lib/components/chat/Chat.svelte `background_tasks`).
 *
 * This module recognises those calls by their FIXED prompt templates and
 * lets the caller send them to a cheaper model. The main conversation is
 * never touched: a request is only a side-call when it is a single user turn
 * whose text matches a known template head AND its fixed structural tail.
 *
 * Why lossy: the bytes the model reads are unchanged, but a DIFFERENT MODEL
 * reads them, so the response (the title, the tags, the suggestions) can
 * differ. Any saving from this lever needs a replay-gate pass on the
 * customer's own traffic (packages/sdk-js/src/replay-gate.ts) before it
 * could ever bill. FLUX's ledger has no routing lever today, so a routed
 * side-call bills nothing; the event records the swap for visibility only.
 */

export type SideCallKind =
  | "title"
  | "tags"
  | "follow_ups"
  | "search_queries"
  | "autocomplete"
  | "image_prompt";

export type SideCallMatch = {
  kind: SideCallKind;
  /** Which template family matched, e.g. "open-webui" or "librechat". */
  framework: "open-webui" | "librechat";
  signatureId: string;
};

export type FluxSideCallRoutingConfig = {
  /** Must be exactly true to route anything. Absent or false: no effect at all. */
  enabled: boolean;
  /**
   * Model to send recognised side-calls to. A string applies to every
   * provider; an object picks per provider, and a provider with no entry is
   * left on the requested model.
   */
  targetModel: string | { anthropic?: string; openai?: string };
  /**
   * Which kinds to route. Default: title, tags, follow_ups — the three that
   * only decorate the UI. Search-query and autocomplete generation feed real
   * user-facing behaviour and are opt-in.
   */
  kinds?: readonly SideCallKind[];
};

export const DEFAULT_SIDE_CALL_KINDS: readonly SideCallKind[] = ["title", "tags", "follow_ups"];

type Signature = {
  id: string;
  framework: SideCallMatch["framework"];
  kind: SideCallKind;
  /** Must match the start of the (trimmed) prompt. */
  head: RegExp;
  /** Every one must appear somewhere in the prompt. */
  markers: readonly string[];
  /** Must match the end of the (trimmed) prompt; omitted when the template ends in free text. */
  tail?: RegExp;
  /** Requests carrying tools never match unless the signature allows it. */
  allowsTools?: boolean;
};

// Open WebUI templates: backend/open_webui/config.py DEFAULT_*_PROMPT_TEMPLATE
// (main branch, fetched 2026-10-28). The 3-5-word "with an emoji" title head is
// the earlier default, kept so older deployments still match.
const OWUI_HISTORY_TAIL = /### Chat History:\s*<chat_history>[\s\S]*<\/chat_history>$/;
const SIGNATURES: readonly Signature[] = [
  {
    id: "open-webui/title",
    framework: "open-webui",
    kind: "title",
    head: /^### Task:\s*Generate a concise(?:, 3-5 word)? title(?: with an emoji)? summarizing the chat history\./,
    markers: ['"title"'],
    tail: OWUI_HISTORY_TAIL,
  },
  {
    id: "open-webui/tags",
    framework: "open-webui",
    kind: "tags",
    head: /^### Task:\s*Generate 1-3 broad tags categorizing the main themes of the chat history/,
    markers: ['"tags"'],
    tail: OWUI_HISTORY_TAIL,
  },
  {
    id: "open-webui/follow-ups",
    framework: "open-webui",
    kind: "follow_ups",
    head: /^### Task:\s*(?:Predict 3-5 useful messages this user might naturally send next|Suggest 3-5 relevant follow-up questions or prompts)/,
    markers: ['"follow_ups"'],
    tail: OWUI_HISTORY_TAIL,
  },
  {
    id: "open-webui/queries",
    framework: "open-webui",
    kind: "search_queries",
    head: /^### Task:\s*Analyze the chat history to determine the necessity of generating search queries/,
    markers: ['"queries"'],
    tail: OWUI_HISTORY_TAIL,
  },
  {
    id: "open-webui/autocomplete",
    framework: "open-webui",
    kind: "autocomplete",
    head: /^### Task:\s*You are an autocompletion system\./,
    markers: ["<text>", "<type>"],
  },
  {
    id: "open-webui/image-prompt",
    framework: "open-webui",
    kind: "image_prompt",
    head: /^### Task:\s*Generate a detailed prompt for a[mn]? image generation task/,
    markers: ['"prompt"'],
    tail: OWUI_HISTORY_TAIL,
  },
  // LibreChat titles: @librechat/agents src/utils/title.ts (main, fetched
  // 2026-10-28). The structured variant is sent with a tool / response schema.
  {
    id: "librechat/title-completion",
    framework: "librechat",
    kind: "title",
    head: /^Provide a concise, 5-word-or-less title for the conversation, using title case conventions\. Only return the title itself\.\s*Conversation:/,
    markers: [],
  },
  {
    id: "librechat/title-structured",
    framework: "librechat",
    kind: "title",
    head: /^Analyze this conversation and provide:\s*1\. The detected language of the conversation\s*2\. A concise title in the detected language \(5 words or less, no punctuation or quotation\)/,
    markers: [],
    allowsTools: true,
  },
];

type AnyObject = Record<string, unknown>;

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") return undefined;
    const typed = block as AnyObject;
    if ((typed.type === "text" || typed.type === "input_text") && typeof typed.text === "string") {
      parts.push(typed.text);
    } else {
      // Images, tool results, documents: never a plain side-call.
      return undefined;
    }
  }
  return parts.join("\n");
}

/**
 * The single user prompt of a request, or undefined when the request is not
 * shaped like a one-shot task call. Leading system/developer messages are
 * allowed (a deployment may prepend one); anything else — a second user
 * turn, an assistant turn, a tool turn — means this is a real conversation.
 */
function singleUserPrompt(request: AnyObject): string | undefined {
  // OpenAI Responses API: `input` as a plain string is one user turn.
  if (typeof request.input === "string" && request.messages === undefined) return request.input;
  const messages = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input) ? request.input : undefined;
  if (!messages) return undefined;
  const turns = messages.filter((message) => {
    const role = (message as AnyObject | null)?.role;
    return role !== "system" && role !== "developer";
  });
  if (turns.length !== 1) return undefined;
  const turn = turns[0] as AnyObject | null;
  if (turn === null || typeof turn !== "object" || turn.role !== "user") return undefined;
  return textOf(turn.content);
}

function hasTools(request: AnyObject): boolean {
  return (Array.isArray(request.tools) && request.tools.length > 0) ||
    (Array.isArray(request.functions) && request.functions.length > 0);
}

/** Recognise an auxiliary side-call by its fixed template. Never throws. */
export function detectSideCall(request: unknown): SideCallMatch | undefined {
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request)) return undefined;
    const body = request as AnyObject;
    const prompt = singleUserPrompt(body)?.trim();
    if (!prompt) return undefined;
    const tools = hasTools(body);
    for (const signature of SIGNATURES) {
      if (tools && signature.allowsTools !== true) continue;
      if (!signature.head.test(prompt)) continue;
      if (!signature.markers.every((marker) => prompt.includes(marker))) continue;
      if (signature.tail && !signature.tail.test(prompt)) continue;
      return { kind: signature.kind, framework: signature.framework, signatureId: signature.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type SideCallRouteDecision = {
  match: SideCallMatch;
  targetModel: string;
  requestedModel: string;
};

/**
 * Decide whether to send a request to the side-call target model. Returns
 * undefined (leave the request alone) unless routing is explicitly enabled,
 * the request is a recognised side-call of an enabled kind, a target exists
 * for this provider, and the request is not already on that target.
 */
export function chooseSideCallRoute(
  config: FluxSideCallRoutingConfig | undefined,
  request: unknown,
  provider: "anthropic" | "openai",
): SideCallRouteDecision | undefined {
  if (config?.enabled !== true) return undefined;
  const target = typeof config.targetModel === "string"
    ? config.targetModel
    : config.targetModel?.[provider];
  if (typeof target !== "string" || target.trim() === "") return undefined;
  const requestedModel = (request as AnyObject | null)?.model;
  if (typeof requestedModel !== "string" || requestedModel === target) return undefined;
  const match = detectSideCall(request);
  if (!match) return undefined;
  const kinds = config.kinds ?? DEFAULT_SIDE_CALL_KINDS;
  if (!kinds.includes(match.kind)) return undefined;
  return { match, targetModel: target, requestedModel };
}
