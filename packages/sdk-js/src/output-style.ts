import type { TokenCounter } from "../../core/dist/src/index.js";

/**
 * Output concision modes: one short, fixed style instruction appended to the
 * END of the stable system prompt so the model writes fewer output tokens.
 *
 * Output is the dear half of the bill (roughly 5x input on every catalogued
 * Claude and GPT model), so a few instruction tokens that are read at the
 * cached rate after the first write can pay for themselves many times over.
 * Whether they do on a given workload is an empirical question, which is why
 * this lever is LOSSY: it changes what the model writes, it is off by default,
 * and it bills only behind an approved replay-gate verdict.
 *
 * Placement rules, each of which keeps the instruction inside the cached
 * prefix without moving anyone's cache breakpoint:
 *
 * - The instruction bytes are a pure function of the mode: identical on
 *   every turn of every conversation.
 * - Anthropic `system`: a string body gets the instruction appended (before
 *   any per-request tail that prefix repair moved to the end, so the FLUX
 *   cache stamp's stable block still ends before the volatile values); a
 *   block-array body gets ONE new text block appended after the caller's
 *   last block, so a caller-placed breakpoint stays on the block it was on,
 *   covering exactly the bytes it covered. No system prompt: the
 *   instruction becomes the system prompt.
 * - OpenAI Chat Completions: appended to the last message of the LEADING
 *   run of system/developer messages (or a new leading system message).
 * - OpenAI Responses: appended to `instructions` (before any repaired
 *   volatile tail), or set as `instructions` when there are none.
 *
 * Skipped, never applied, when a style instruction could corrupt the format
 * the caller demanded: forced tool choice (Anthropic `tool`/`any`, OpenAI
 * `required`/named function) or structured output (`response_format`,
 * Responses `text.format`, Anthropic `output_format`/`output_config.format`).
 */

export type FluxOutputStyle = "off" | "concise" | "terse" | "ultra";

/**
 * The carve-outs every mode shares. Kept to one sentence on purpose: Caveman's
 * own published comparison shows plain "be concise" captures most of the
 * output saving, while their full rule set costs ~1,160 input tokens per turn.
 */
const CARVE_OUTS =
  "Keep code, commands, file paths, error messages and data exact; full sentences for security warnings " +
  "and irreversible actions.";

export const OUTPUT_STYLE_INSTRUCTIONS: Readonly<Record<Exclude<FluxOutputStyle, "off">, string>> = {
  concise: `Be concise. ${CARVE_OUTS}`,
  terse: `Be terse: no preamble or recap; fragments OK. ${CARVE_OUTS}`,
  ultra: `Fewest words possible: fragments, no preamble or recap. ${CARVE_OUTS}`,
};

export function outputStyleInstruction(style: FluxOutputStyle): string | undefined {
  return style === "off" ? undefined : OUTPUT_STYLE_INSTRUCTIONS[style];
}

type AnyObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a style instruction must NOT be applied to this request, if it must not. */
export function outputStyleSkipReason(request: AnyObject): string | undefined {
  const choice = request.tool_choice;
  if (choice === "required" || choice === "any") {
    return `tool_choice "${choice}" forces a tool call; a prose style could corrupt it.`;
  }
  if (isPlainObject(choice)) {
    const type = choice.type;
    if (type === "tool" || type === "any" || type === "function" || type === "custom" ||
        (type === "allowed_tools" && choice.mode === "required")) {
      return `tool_choice type "${String(type)}" forces a tool call; a prose style could corrupt it.`;
    }
  }
  const responseFormat = request.response_format;
  if (isPlainObject(responseFormat) && responseFormat.type !== undefined && responseFormat.type !== "text") {
    return `response_format "${String(responseFormat.type)}" demands structured output.`;
  }
  const text = request.text;
  if (isPlainObject(text) && isPlainObject(text.format) && text.format.type !== undefined &&
      text.format.type !== "text") {
    return `text.format "${String(text.format.type)}" demands structured output.`;
  }
  if (request.output_format !== undefined && request.output_format !== null) {
    return "output_format demands structured output.";
  }
  const outputConfig = request.output_config;
  if (isPlainObject(outputConfig) && outputConfig.format !== undefined && outputConfig.format !== null) {
    return "output_config.format demands structured output.";
  }
  return undefined;
}

/**
 * Append `addition` to the stable part of `text`. When prefix repair moved
 * per-request lines to the end (`volatileTail`), the addition goes BEFORE
 * them, so the stable block the cache stamp covers still excludes them.
 */
export function appendBeforeVolatileTail(text: string, addition: string, volatileTail: readonly string[]): string {
  const tailText = volatileTail.join("\n");
  if (volatileTail.length > 0 && tailText.trim() !== "" &&
      (text === tailText || text.endsWith(`\n${tailText}`))) {
    // `stable` keeps its trailing separator newline (see stampAnthropicCacheTtl).
    const stable = text === tailText ? "" : text.slice(0, -tailText.length);
    return stable.trim() === "" ? `${addition}\n${tailText}` : `${stable}\n${addition}\n${tailText}`;
  }
  return text.trim() === "" ? addition : `${text}\n\n${addition}`;
}

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

export type OutputStyleResult =
  | { applied: true; addedTokens: number; target: string }
  | { applied: false; reason: string };

/**
 * Apply the style instruction to `next` IN PLACE (the caller passes its own
 * shallow copy; nested arrays are copied before mutation). Idempotent: a
 * request whose system prompt already carries the exact instruction is left
 * alone, so a re-reduced request never gets it twice.
 */
export function applyOutputStyle(
  next: AnyObject,
  style: FluxOutputStyle,
  volatileTails: { system: readonly string[]; instructions: readonly string[] },
  countTokens: TokenCounter,
): OutputStyleResult {
  const instruction = outputStyleInstruction(style);
  if (instruction === undefined) return { applied: false, reason: "off" };
  const skip = outputStyleSkipReason(next);
  if (skip !== undefined) return { applied: false, reason: skip };
  const added = (before: unknown, after: unknown): number =>
    Math.max(0, countTokens(textOf(after)) - countTokens(textOf(before)));

  const model = typeof next.model === "string" ? next.model.toLowerCase() : "";
  const messages = Array.isArray(next.messages) ? next.messages : undefined;
  const chatSystemRoles = new Set(["system", "developer"]);
  const hasChatSystemMessage = messages?.some((message) =>
    isPlainObject(message) && typeof message.role === "string" && chatSystemRoles.has(message.role)) ?? false;
  const anthropicShaped = messages !== undefined && model.includes("claude") && !hasChatSystemMessage;

  if (textOf(next.system).includes(instruction) || textOf(next.instructions).includes(instruction)) {
    return { applied: false, reason: "The instruction is already present." };
  }

  if (anthropicShaped) {
    const before = next.system;
    if (next.system === undefined || next.system === null ||
        (typeof next.system === "string" && next.system.trim() === "")) {
      next.system = instruction;
    } else if (typeof next.system === "string") {
      next.system = appendBeforeVolatileTail(next.system, instruction, volatileTails.system);
    } else if (Array.isArray(next.system)) {
      next.system = [...next.system, { type: "text", text: instruction }];
    } else {
      return { applied: false, reason: "The system prompt has an unrecognised shape." };
    }
    return { applied: true, addedTokens: added(before, next.system), target: "system" };
  }

  if (messages !== undefined) {
    // The instruction contains no JSON-escaped characters, so it matches
    // inside a serialised content array as well as a plain string.
    if (messages.some((message) => isPlainObject(message) && typeof message.role === "string" &&
      chatSystemRoles.has(message.role) && textOf(message.content).includes(instruction))) {
      return { applied: false, reason: "The instruction is already present." };
    }
    let lead = -1;
    while (lead + 1 < messages.length) {
      const message = messages[lead + 1];
      if (!isPlainObject(message) || typeof message.role !== "string" || !chatSystemRoles.has(message.role)) break;
      lead += 1;
    }
    const copy = [...messages];
    if (lead === -1) {
      copy.unshift({ role: "system", content: instruction });
      next.messages = copy;
      return { applied: true, addedTokens: countTokens(instruction), target: "messages[0] (new system message)" };
    }
    const target = copy[lead] as AnyObject;
    const content = target.content;
    let updated: unknown;
    if (typeof content === "string") updated = appendBeforeVolatileTail(content, instruction, []);
    else if (Array.isArray(content)) updated = [...content, { type: "text", text: instruction }];
    else return { applied: false, reason: "The system message has an unrecognised content shape." };
    copy[lead] = { ...target, content: updated };
    next.messages = copy;
    return { applied: true, addedTokens: added(content, updated), target: `messages[${lead}] (${target.role})` };
  }

  if (next.instructions === undefined || next.instructions === null ||
      (typeof next.instructions === "string" && next.instructions.trim() === "")) {
    if (next.input === undefined) return { applied: false, reason: "No recognised request surface." };
    next.instructions = instruction;
    return { applied: true, addedTokens: countTokens(instruction), target: "instructions" };
  }
  if (typeof next.instructions === "string") {
    const before = next.instructions;
    next.instructions = appendBeforeVolatileTail(before, instruction, volatileTails.instructions);
    return { applied: true, addedTokens: added(before, next.instructions), target: "instructions" };
  }
  return { applied: false, reason: "The instructions have an unrecognised shape." };
}
