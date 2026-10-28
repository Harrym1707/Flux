import { createRequire } from "node:module";
import type { Tiktoken, TiktokenBPE } from "js-tiktoken/lite";
import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

/**
 * Exact token counting for OpenAI models.
 *
 * OpenAI publishes the byte-pair encodings its models use (o200k_base for the
 * gpt-4o / gpt-4.1 / gpt-4.5 / gpt-5 / o-series families, cl100k_base for
 * gpt-4 and gpt-3.5), and js-tiktoken ships the rank tables in the npm
 * package, so for those models a FLUX estimate does not have to be an
 * estimate: the count of a string is exactly what the provider's tokenizer
 * produces for it.
 *
 * What this is NOT:
 *   - It is not a count of a whole request. OpenAI adds per-message framing
 *     tokens and renders tool schemas into its own internal format before
 *     tokenizing, so counting JSON.stringify(request) exactly is still not
 *     the billed prompt_tokens. Provider-verbatim usage remains the only
 *     basis of any realised-saving or billing figure.
 *   - It is not exact for Claude. Anthropic's tokenizer is not public; Claude
 *     ids, and every id this module does not positively recognise, stay on
 *     `approximateTokenCount` and are reported with basis "approximate".
 *
 * The rank tables are ~1-2MB of JSON each, so they are loaded lazily on the
 * first exact count for that encoding (a synchronous require, because
 * TokenCounter is synchronous), and the built encoder is cached for the life
 * of the process. A deployment that never sees an OpenAI model never parses
 * them. js-tiktoken itself is required lazily too, and only after its
 * resolvability is checked: a build that does not ship it (the bundled SDK
 * artifact is dependency-free) degrades to the approximation, labelled
 * "approximate", instead of failing a request.
 */

export type OpenAIEncoding = "o200k_base" | "cl100k_base";

/** Which counter produced a figure. Only "exact:*" is a tokenizer count. */
export type TokenCountBasis = `exact:${OpenAIEncoding}` | "approximate";

/**
 * Model families whose encoding is published (the tiktoken model table).
 * Every pattern is anchored to a family boundary, so "gpt-4o" and "gpt-4.1"
 * can never fall into the gpt-4 (cl100k_base) rule.
 *
 * Deliberately NOT listed, so they fall back to the approximation:
 *   - point releases the pinned tiktoken table does not name (gpt-5.1,
 *     gpt-5.2, ...) and gpt-6: assuming o200k_base for them would be a guess
 *     presented as an exact count;
 *   - gpt-oss (o200k_harmony), legacy completion models (p50k/r50k), and any
 *     id routed through a provider prefix other than openai/ or azure/.
 */
const FAMILY_ENCODINGS: Array<{ pattern: RegExp; encoding: OpenAIEncoding }> = [
  { pattern: /^(?:chatgpt-4o|gpt-4o)(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^gpt-4\.1(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^gpt-4\.5(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^gpt-5(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^o1(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^o3(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^o4-mini(?:-|$)/, encoding: "o200k_base" },
  { pattern: /^gpt-4(?:-|$)/, encoding: "cl100k_base" },
  { pattern: /^gpt-3\.5-turbo(?:-|$)/, encoding: "cl100k_base" },
  { pattern: /^gpt-35-turbo(?:-|$)/, encoding: "cl100k_base" },
  { pattern: /^text-embedding-(?:ada-002|3-small|3-large)$/, encoding: "cl100k_base" },
];

/**
 * The published encoding for an OpenAI model id, or undefined when the id is
 * not one this module positively recognises (callers then fall back to the
 * approximation). Accepts the forms an id reaches FLUX in: dated snapshots
 * (gpt-4o-2024-08-06), fine-tunes (ft:gpt-4o-mini-2024-07-18:org::id), and
 * an openai/ or azure/ routing prefix.
 */
export function openAIEncodingForModel(model: string | undefined): OpenAIEncoding | undefined {
  if (typeof model !== "string") return undefined;
  let id = model.trim().toLowerCase();
  if (id.startsWith("openai/") || id.startsWith("azure/")) id = id.slice(id.indexOf("/") + 1);
  if (id.startsWith("ft:")) id = id.slice(3).split(":")[0] ?? "";
  if (id === "" || id.includes("/")) return undefined;
  return FAMILY_ENCODINGS.find(({ pattern }) => pattern.test(id))?.encoding;
}

let lazyRequire: NodeJS.Require | null | undefined;
/**
 * A require for loading js-tiktoken on demand. ESM builds derive it from
 * import.meta.url; the bundled CJS artifact has no import.meta, so it uses
 * the module's own require. Undefined when neither exists.
 */
function requireLazilyOrUndefined(): NodeJS.Require | undefined {
  if (lazyRequire === undefined) {
    try {
      lazyRequire = createRequire(import.meta.url);
    } catch {
      lazyRequire = typeof require === "function" ? require : null;
    }
  }
  return lazyRequire ?? undefined;
}
function requireLazily(specifier: string): unknown {
  const load = requireLazilyOrUndefined();
  if (load === undefined) throw new Error(`Cannot load ${specifier}: no module loader in this build.`);
  return load(specifier);
}
const RANKS_SPECIFIER: Record<OpenAIEncoding, string> = {
  o200k_base: "js-tiktoken/ranks/o200k_base",
  cl100k_base: "js-tiktoken/ranks/cl100k_base",
};
type LoadedEncoder = { encoder: Tiktoken; pattern: RegExp };
const encoders = new Map<OpenAIEncoding, LoadedEncoder>();
const available = new Map<OpenAIEncoding, boolean>();

/**
 * Whether the exact encoder for `encoding` can be loaded in this process.
 * Resolving a module path does not parse it, so this is cheap and keeps the
 * load lazy.
 */
export function isExactEncodingAvailable(encoding: OpenAIEncoding): boolean {
  let ok = available.get(encoding);
  if (ok === undefined) {
    try {
      const load = requireLazilyOrUndefined();
      if (load === undefined) throw new Error("no module loader");
      load.resolve("js-tiktoken/lite");
      load.resolve(RANKS_SPECIFIER[encoding]);
      ok = true;
    } catch {
      ok = false;
    }
    available.set(encoding, ok);
  }
  return ok;
}

/** True once an encoding's rank table has been parsed in this process. */
export function isEncodingLoaded(encoding: OpenAIEncoding): boolean {
  return encoders.has(encoding);
}

function encoderFor(encoding: OpenAIEncoding): LoadedEncoder {
  let loaded = encoders.get(encoding);
  if (loaded === undefined) {
    const { Tiktoken: Encoder } = requireLazily("js-tiktoken/lite") as typeof import("js-tiktoken/lite");
    const required = requireLazily(RANKS_SPECIFIER[encoding]) as TiktokenBPE | { default: TiktokenBPE };
    const ranks = "default" in required ? required.default : required;
    // The encoder's own pre-tokenisation pattern, compiled the way js-tiktoken compiles it.
    loaded = { encoder: new Encoder(ranks), pattern: new RegExp(ranks.pat_str, "gu") };
    encoders.set(encoding, loaded);
  }
  return loaded;
}

/**
 * js-tiktoken's byte-pair merge is quadratic in the length of one
 * pre-token (measured: a 512-char unbroken run ~27ms, 4,096 chars ~2s, 20,000
 * chars ~60s). Ordinary prose, JSON and code never produce pre-tokens near
 * this length, but a request can carry one (a long run of one character, a
 * DNA string, padding), and a counter on the proxy hot path must not let one
 * field stall a request for a minute. Pre-tokens longer than this are counted
 * in chunks of this size instead: linear time, and the only deviation from
 * the exact count is at the chunk boundaries inside that one run.
 */
export const MAX_EXACT_PRETOKEN_CHARS = 128;

// Any pre-token longer than the cap contains a run this long of either
// non-space non-digit characters or whitespace (digit pre-tokens are at most
// 3 long, and only the first character of a letter or punctuation pre-token
// may be a space), so text without such a run is encoded in one call.
const LONG_RUN = new RegExp(`[^\\s\\p{N}]{${MAX_EXACT_PRETOKEN_CHARS - 2},}|\\s{${MAX_EXACT_PRETOKEN_CHARS - 2},}`, "u");

function chunkBoundary(text: string, index: number): number {
  // Never split a surrogate pair.
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function countBounded(loaded: LoadedEncoder, text: string): number {
  const { encoder, pattern } = loaded;
  if (!LONG_RUN.test(text)) return encoder.encode(text, [], []).length;
  let total = 0;
  let pending = 0;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const piece = match[0];
    if (piece.length <= MAX_EXACT_PRETOKEN_CHARS) continue;
    const start = match.index;
    // Text up to here ends on a pre-token boundary, so encoding it alone
    // yields exactly the tokens it contributes to the whole.
    if (start > pending) total += encoder.encode(text.slice(pending, start), [], []).length;
    const end = start + piece.length;
    for (let at = start; at < end;) {
      const next = Math.min(end, chunkBoundary(text, at + MAX_EXACT_PRETOKEN_CHARS));
      total += encoder.encode(text.slice(at, next), [], []).length;
      at = next;
    }
    pending = end;
  }
  if (pending < text.length) total += encoder.encode(text.slice(pending), [], []).length;
  return total;
}

/**
 * The hot path counts the same strings repeatedly (a request is measured
 * before and after each lever), and an exact count costs several times the
 * approximation, so recent large counts are remembered. Bounded by total
 * characters held, never by request count, so it cannot grow with traffic.
 */
const MEMO_MIN_CHARS = 512;
const MEMO_MAX_CHARS = 4_000_000;
// Insertion order is recency order; entries remember their encoding.
const memo = new Map<string, { encoding: OpenAIEncoding; count: number }[]>();
let memoChars = 0;

function recall(text: string, encoding: OpenAIEncoding): number | undefined {
  const entries = memo.get(text);
  const hit = entries?.find((entry) => entry.encoding === encoding);
  if (entries === undefined || hit === undefined) return undefined;
  memo.delete(text);
  memo.set(text, entries);
  return hit.count;
}

function remember(text: string, encoding: OpenAIEncoding, count: number): void {
  if (text.length > MEMO_MAX_CHARS / 4) return;
  const entries = memo.get(text);
  if (entries === undefined) {
    memo.set(text, [{ encoding, count }]);
    memoChars += text.length;
  } else {
    entries.push({ encoding, count });
  }
  while (memoChars > MEMO_MAX_CHARS) {
    const oldest = memo.keys().next().value as string;
    memo.delete(oldest);
    memoChars -= oldest.length;
  }
}

/**
 * Token count of `text` under `encoding`: exact, except that an unbroken
 * pre-token longer than MAX_EXACT_PRETOKEN_CHARS is counted in chunks (see
 * above). Special-token text such as "<|endoftext|>" is counted as ordinary
 * text, which is how request content reaches the model (the API does not let
 * request text inject control tokens). Throws if js-tiktoken is not
 * installed; tokenCounterForModel is the fail-open path.
 */
export function exactTokenCount(text: string, encoding: OpenAIEncoding): number {
  if (text === "") return 0;
  const loaded = encoderFor(encoding);
  if (text.length < MEMO_MIN_CHARS) return countBounded(loaded, text);
  const known = recall(text, encoding);
  if (known !== undefined) return known;
  const count = countBounded(loaded, text);
  remember(text, encoding, count);
  return count;
}

const exactCounters: Record<OpenAIEncoding, TokenCounter> = {
  o200k_base: (text) => exactTokenCount(text, "o200k_base"),
  cl100k_base: (text) => exactTokenCount(text, "cl100k_base"),
};

/**
 * The best counter FLUX has for `model`: exact for recognised OpenAI ids,
 * the approximation (labelled as such) for everything else, Claude included.
 * Nothing is parsed until the returned counter is first called.
 */
export function tokenCounterForModel(model: string | undefined): { countTokens: TokenCounter; basis: TokenCountBasis } {
  const encoding = openAIEncodingForModel(model);
  return encoding === undefined || !isExactEncodingAvailable(encoding)
    ? { countTokens: approximateTokenCount, basis: "approximate" }
    : { countTokens: exactCounters[encoding], basis: `exact:${encoding}` };
}

/** One-shot form of tokenCounterForModel. */
export function countTokensForModel(text: string, model: string | undefined): number {
  return tokenCounterForModel(model).countTokens(text);
}
