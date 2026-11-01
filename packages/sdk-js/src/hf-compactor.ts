import { approximateTokenCount, type TokenCounter } from "../../core/dist/src/index.js";
import type { SemanticCompactor } from "./semantic-compaction.js";

/**
 * PROTOTYPE: ready-made LOCAL compactors for the semantic-compaction lever,
 * backed by Hugging Face models run on the customer's machine through
 * transformers.js (`@huggingface/transformers`).
 *
 * Two adapters, both implementing `SemanticCompactor`:
 *
 *   - `createLlmlingua2Compactor` — LLMLingua-2 style token DROPPING. A small
 *     BERT-class encoder scores every token with a "preserve" probability and
 *     the lowest-scoring words are dropped until a target rate is met. It never
 *     writes a word that was not in the input, which makes it the safer of the
 *     two for tool output.
 *   - `createLocalSummariserCompactor` — a small instruct model (default
 *     ~0.5B) asked, with a fixed prompt, to rewrite the body shorter. It CAN
 *     paraphrase or hallucinate; the replay gate is what decides if it is good
 *     enough on a customer's traffic.
 *
 * Guarantees, enforced here and covered by tests (hf-compactor.test.ts):
 *   - FULLY LOCAL. Inference runs in-process. The only network traffic is
 *     transformers.js fetching model weights from the Hugging Face Hub on first
 *     use (disable with `transformersEnv: { allowRemoteModels: false }` and a
 *     pre-populated `localModelPath`/`cacheDir`). No prompt text is ever sent
 *     anywhere. No telemetry.
 *   - OPTIONAL dependency. `@huggingface/transformers` is an optional peer
 *     dependency, imported dynamically on first use, so FLUX core installs stay
 *     light. Missing => `load()` rejects with a clear message and `compact()`
 *     returns the original text.
 *   - LAZY + CACHED. Nothing is imported or loaded until the first compaction
 *     (or an explicit `load()`); the loaded model is reused afterwards.
 *   - FAIL-SAFE. Any load error, inference error or timeout returns the ORIGINAL
 *     text unchanged. `compact()` never throws into the request path.
 *   - NEVER GROWS. A result is used only if it is strictly shorter than the
 *     input in both characters and FLUX tokens; otherwise the original is kept.
 *
 * The lever stays LOSSY and gated: these adapters are just compactors; the
 * semantic-compaction pre-pass still refuses to call any compactor without an
 * approved replay-gate verdict, and the ledger still refuses to bill it.
 *
 * NO QUALITY OR COMPRESSION NUMBERS are claimed for either adapter. They were
 * built and tested against injected stubs only (the build machine could not
 * reach huggingface.co). Real-model validation is pending — see
 * docs/rnd/semantic-compaction-design.md for the exact command.
 */

/* ----------------------------------------------------------------------------
 * Minimal structural view of the parts of transformers.js these adapters use.
 * Declared here (rather than imported) so FLUX compiles without the optional
 * dependency installed. Compatible with @huggingface/transformers 3.x and 4.x.
 * ------------------------------------------------------------------------- */

type TensorLike = {
  dims: number[];
  data: ArrayLike<number | bigint>;
  dispose?: () => void;
};

type TokenizerLike = {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
};

type TokenClassificationModelLike = {
  (inputs: Record<string, unknown>): Promise<{ logits: TensorLike }>;
  dispose?: () => Promise<unknown> | unknown;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** A text-generation pipeline (callable), as returned by `pipeline("text-generation", ...)`. */
export type TextGenerator = (
  messages: ChatMessage[],
  options: { max_new_tokens: number; do_sample: boolean; return_full_text: boolean },
) => Promise<unknown>;

type PretrainedOptions = {
  dtype?: string;
  device?: string;
  subfolder?: string;
  revision?: string;
};

/** The subset of the `@huggingface/transformers` module these adapters touch. */
export type TransformersModule = {
  AutoTokenizer: { from_pretrained(modelId: string, options?: PretrainedOptions): Promise<TokenizerLike> };
  AutoModelForTokenClassification: {
    from_pretrained(modelId: string, options?: PretrainedOptions): Promise<TokenClassificationModelLike>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
  pipeline(task: "text-generation", modelId: string, options?: PretrainedOptions): Promise<TextGenerator>;
  env?: Record<string, unknown>;
};

/** Settings forwarded to transformers.js `env` before loading (e.g. offline mode). */
export type TransformersEnvOverrides = {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  localModelPath?: string;
  cacheDir?: string;
};

const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

export const MISSING_TRANSFORMERS_MESSAGE =
  `FLUX local compactor: the optional peer dependency "${TRANSFORMERS_PACKAGE}" is not installed. ` +
  `Install it next to FLUX to use the bundled Hugging Face compactors (npm install ${TRANSFORMERS_PACKAGE}). ` +
  "Until then the compactor is a no-op and returns text unchanged.";

/**
 * Dynamic import of the optional peer dependency, with a clear error if it is
 * absent. `specifier` exists only so tests can exercise the missing-package path.
 */
export async function importTransformers(specifier: string = TRANSFORMERS_PACKAGE): Promise<TransformersModule> {
  // A non-literal specifier keeps TypeScript from requiring the package at build time.
  try {
    return (await import(specifier)) as TransformersModule;
  } catch (error) {
    throw new Error(MISSING_TRANSFORMERS_MESSAGE, { cause: error });
  }
}

/* ----------------------------------------------------------------------------
 * Shared fail-safe plumbing.
 * ------------------------------------------------------------------------- */

export type CompactorErrorStage = "load" | "inference" | "timeout" | "rejected-output";

export type FailSafeOptions = {
  /**
   * Wall-clock budget for one `compact()` call, INCLUDING a first-use model
   * load. On timeout the original text is returned; a load that is still in
   * flight keeps going in the background and is used by later calls once ready.
   * Default 10000 ms.
   */
  timeoutMs?: number;
  /** After a failed load, wait this long before trying to load again. Default 300000 ms. */
  retryLoadAfterMs?: number;
  /**
   * Called (never awaited, errors swallowed) whenever the adapter fell back to
   * the original text. Local only: FLUX sends this nowhere. Useful for logging
   * a missing dependency or an unreachable model at startup.
   */
  onError?: (error: unknown, stage: CompactorErrorStage) => void;
  /** FLUX's token counter (rate targeting and the never-grow check). Default: shared approximate counter. */
  countTokens?: TokenCounter;
  /**
   * Remember results per (maxTokens, text) for this many bodies (oldest
   * evicted first), so the same
   * stale body re-sent on the next turn gets byte-identical bytes back instead
   * of being recompacted. In-process only; 0 disables. Default 256.
   */
  memoSize?: number;
};

/** A local compactor with an explicit warm-up hook. */
export type LocalCompactor = SemanticCompactor & {
  /**
   * Eagerly import + load the model. Unlike `compact()`, this REJECTS on
   * failure (e.g. with MISSING_TRANSFORMERS_MESSAGE), so callers can surface a
   * misconfiguration at startup instead of silently getting a no-op.
   */
  load(): Promise<void>;
  /** True once the model is loaded and cached. */
  readonly loaded: boolean;
};

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Lazy, cached, single-flight loader that remembers a failure for `retryAfterMs`. */
function lazyLoader<T>(load: () => Promise<T>, retryAfterMs: number, now: () => number = Date.now) {
  let pending: Promise<T> | undefined;
  let value: T | undefined;
  let ready = false;
  let failure: { error: unknown; at: number } | undefined;
  return {
    get ready() {
      return ready;
    },
    get(): Promise<T> {
      if (ready) return Promise.resolve(value as T);
      if (failure && now() - failure.at < retryAfterMs) return Promise.reject(failure.error);
      if (!pending) {
        failure = undefined;
        pending = (async () => load())().then(
          (loaded) => {
            value = loaded;
            ready = true;
            return loaded;
          },
          (error: unknown) => {
            failure = { error, at: now() };
            pending = undefined;
            throw error;
          },
        );
        // A load that outlives a timed-out call must not become an unhandled rejection.
        pending.catch(() => undefined);
      }
      return pending;
    },
  };
}

function safeCount(countTokens: TokenCounter, text: string): number {
  try {
    const n = countTokens(text);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Wrap an engine in the shared guarantees: lazy load, timeout, never throw,
 * never grow, memoise. `run` receives the loaded engine and returns a candidate.
 */
function failSafeCompactor<E>(
  options: FailSafeOptions,
  loadEngine: () => Promise<E>,
  run: (engine: E, input: { text: string; maxTokens: number; inputTokens: number }) => Promise<string>,
): LocalCompactor {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const countTokens = options.countTokens ?? approximateTokenCount;
  const memoSize = Math.max(0, Math.floor(options.memoSize ?? 256));
  const memo = new Map<string, string>();
  const loader = lazyLoader(loadEngine, options.retryLoadAfterMs ?? 300_000);
  const report = (error: unknown, stage: CompactorErrorStage): void => {
    try {
      options.onError?.(error, stage);
    } catch {
      // A broken logger must never break the request path.
    }
  };

  async function compact(input: { text: string; maxTokens: number; kind: "tool-result" }): Promise<string> {
    const text = input?.text;
    if (typeof text !== "string" || text.length === 0) return text;
    try {
      const maxTokens = input.maxTokens;
      if (!Number.isFinite(maxTokens) || maxTokens < 1) return text;
      const inputTokens = safeCount(countTokens, text);
      if (!Number.isFinite(inputTokens) || inputTokens <= maxTokens) return text;

      const key = `${maxTokens}\u0000${text}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;

      let stage: CompactorErrorStage = "load";
      const work = (async () => {
        const engine = await loader.get();
        stage = "inference";
        return run(engine, { text, maxTokens, inputTokens });
      })();
      work.catch(() => undefined); // a late failure after a timeout must not go unhandled

      let candidate: string | typeof TIMEOUT;
      try {
        candidate = await withTimeout(work, timeoutMs);
      } catch (error) {
        report(error, stage);
        return text;
      }
      if (candidate === TIMEOUT) {
        report(new Error(`FLUX local compactor timed out after ${timeoutMs} ms (${stage}).`), "timeout");
        return text;
      }

      // NEVER GROW: strictly shorter in characters AND in FLUX tokens, and non-empty.
      if (
        typeof candidate !== "string" ||
        candidate.trim().length === 0 ||
        candidate.length >= text.length ||
        safeCount(countTokens, candidate) >= inputTokens
      ) {
        report(new Error("FLUX local compactor output was empty or not shorter; kept the original."), "rejected-output");
        return text;
      }

      if (memoSize > 0) {
        if (memo.size >= memoSize) memo.delete(memo.keys().next().value as string);
        memo.set(key, candidate);
      }
      return candidate;
    } catch (error) {
      report(error, "inference");
      return text;
    }
  }

  return {
    compact,
    async load() {
      await loader.get();
    },
    get loaded() {
      return loader.ready;
    },
  };
}

function applyEnv(tf: TransformersModule, overrides: TransformersEnvOverrides | undefined): void {
  if (!overrides || !tf.env) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) tf.env[key] = value;
  }
}

/* ----------------------------------------------------------------------------
 * LLMLingua-2 style token dropping.
 *
 * Faithful to microsoft/LLMLingua `PromptCompressor` (llmlingua2 path,
 * arXiv 2403.12968) in the parts that matter:
 *   - p_preserve = softmax(logits)[..., 1] per model token (class 1 = keep);
 *   - text is split into <= 512-token chunks (510 + [CLS]/[SEP]), breaking
 *     preferably after a "." or a newline;
 *   - token probabilities are merged into WORD probabilities by mean
 *     (token_to_word="mean");
 *   - forced words get probability 1.0 (force_tokens / force_reserve_digit);
 *   - per chunk, word probabilities are expanded by each word's (FLUX) token
 *     count and the keep threshold is
 *       np.percentile(token_probs, int(100 * (1 - rate) + 1)),
 *     keeping words with p > threshold (or p == threshold == 1.0).
 *
 * Deliberate, CONSERVATIVE deviations for tool output:
 *   - The atomic keep/drop unit is a WHITESPACE-delimited word, not a
 *     sub-punctuation BERT word. So `src/app.ts:42`, `user_id=17`, or
 *     `0x1f3a` is kept or dropped whole — never split.
 *   - Forced units by default include anything with a digit, a path or URL
 *     separator, an identifier shape (snake_case, camelCase, dotted.name,
 *     ns::name, key=value, ALL_CAPS) or an error keyword.
 *   - Line structure and leading indentation of surviving lines are kept
 *     (LLMLingua re-joins words with single spaces, which flattens tables,
 *     stack traces and code).
 *   - After the percentile pass, if the kept text still exceeds `maxTokens`,
 *     the lowest-probability non-forced units are dropped until it fits.
 *     Forced units are never dropped, so a body made mostly of forced units can
 *     stay above `maxTokens` (it is still never longer than the input).
 * ------------------------------------------------------------------------- */

/** One whitespace-delimited unit of the input with its layout. */
export type TextUnit = {
  text: string;
  line: number;
  firstOnLine: boolean;
  /** Leading whitespace of the unit's line (emitted only before the first unit of a line). */
  indent: string;
  /** Preferred chunk break after this unit (ends a sentence or a line). */
  breakAfter: boolean;
};

export function segmentUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  text.split(/\r?\n/).forEach((lineText, line) => {
    const indent = /^[ \t]*/.exec(lineText)?.[0] ?? "";
    const words = lineText.trim().split(/\s+/).filter((word) => word.length > 0);
    words.forEach((word, index) => {
      units.push({
        text: word,
        line,
        firstOnLine: index === 0,
        indent,
        breakAfter: index === words.length - 1 || word.endsWith("."),
      });
    });
  });
  return units;
}

/**
 * Conservative "never drop" shapes for tool output. Each is tested against a
 * whole whitespace unit.
 */
export const DEFAULT_FORCE_PATTERNS: readonly RegExp[] = [
  /\d/, // numbers, versions, line:col, ids, hashes, sizes, exit codes (LLMLingua force_reserve_digit)
  /[/\\]/, // file paths, URLs, flags like a/b
  /\w_|_\w/, // snake_case, CONST_NAMES, __dunder__
  /[a-z][A-Z]/, // camelCase / PascalCase joins
  /\w\.\w/, // dotted identifiers, file.ext, module.attr, hostnames
  /::|->|=>|\w=|=\w/, // namespaces, arrows, key=value
  /^[^A-Za-z]*[A-Z][A-Z]{2,}[^A-Za-z]*$/, // ALLCAPS words: ERROR, WARN, HTTP, ENOENT
  /^-{1,2}\w/, // CLI flags
  /error|exception|fail|fatal|warn|denied|traceback|panic|refused|invalid|missing|undefined|null|timeout/i,
];

export type ForcedUnitOptions = {
  /** Use DEFAULT_FORCE_PATTERNS (recommended for tool output). Default true. */
  conservative?: boolean;
  /** Extra exact strings that must never be dropped (compared with and without surrounding punctuation). */
  forceTokens?: readonly string[];
  /** Extra patterns; a unit matching any of them is never dropped. */
  forcePatterns?: readonly RegExp[];
};

export function isForcedUnit(unit: string, options: ForcedUnitOptions = {}): boolean {
  const bare = unit.replace(/^[^\w]+|[^\w]+$/g, "");
  if (options.forceTokens?.some((token) => token === unit || token === bare)) return true;
  // Digits are always forced, conservative or not (LLMLingua's force_reserve_digit).
  if (/\d/.test(unit)) return true;
  const patterns = [...(options.conservative === false ? [] : DEFAULT_FORCE_PATTERNS), ...(options.forcePatterns ?? [])];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(unit);
  });
}

/** numpy.percentile with the default linear interpolation. `q` in [0, 100]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (Math.min(100, Math.max(0, q)) / 100) * (sorted.length - 1);
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

/** Per-unit model output: which chunk it was scored in, and per-model-token preserve probabilities. */
export type UnitScore = { chunk: number; tokenProbs: number[] };

/**
 * Scores units with a token-classification model. Implementations chunk the
 * units to the model's sequence length themselves and return one entry per
 * input unit, in order.
 */
export type PreserveScorer = {
  score(units: readonly TextUnit[]): Promise<UnitScore[]>;
  dispose?: () => Promise<unknown> | unknown;
};

export type SelectionOptions = ForcedUnitOptions & {
  /** Keep ratio in (0, 1]: the LLMLingua `rate`. */
  rate: number;
  /** Hard target in FLUX tokens; lowest-probability non-forced units are trimmed to meet it. */
  maxTokens?: number;
  countTokens?: TokenCounter;
};

export type UnitDecision = { unit: TextUnit; probability: number; forced: boolean; keep: boolean };

/** The LLMLingua-2 selection step on already-scored units (pure; exported for tests). */
export function selectUnits(units: readonly TextUnit[], scores: readonly UnitScore[], options: SelectionOptions): UnitDecision[] {
  if (scores.length !== units.length) throw new Error("Scorer returned a score count that does not match the unit count.");
  const countTokens = options.countTokens ?? approximateTokenCount;
  const rate = Math.min(1, Math.max(0, options.rate));
  const decisions: UnitDecision[] = units.map((unit, index) => {
    const forced = isForcedUnit(unit.text, options);
    const probs = scores[index].tokenProbs.filter((p) => Number.isFinite(p));
    // token_to_word = "mean". A unit the tokenizer produced no tokens for is kept (conservative).
    const mean = probs.length === 0 ? 1 : probs.reduce((sum, p) => sum + p, 0) / probs.length;
    return { unit, probability: forced ? 1 : mean, forced, keep: true };
  });
  if (rate >= 1) return decisions;

  const weight = (decision: UnitDecision): number => Math.max(1, Math.round(safeCount(countTokens, decision.unit.text)));
  const reduceRate = 1 - rate;
  const q = Math.min(100, Math.trunc(100 * reduceRate + 1));

  const byChunk = new Map<number, UnitDecision[]>();
  decisions.forEach((decision, index) => {
    const chunk = scores[index].chunk;
    const group = byChunk.get(chunk);
    if (group) group.push(decision);
    else byChunk.set(chunk, [decision]);
  });
  for (const chunkDecisions of byChunk.values()) {
    const expanded: number[] = [];
    for (const decision of chunkDecisions) {
      for (let i = 0; i < weight(decision); i += 1) expanded.push(decision.probability);
    }
    const threshold = percentile(expanded, q);
    for (const decision of chunkDecisions) {
      decision.keep = decision.forced || decision.probability > threshold ||
        (threshold === 1 && decision.probability === 1);
    }
  }

  if (options.maxTokens !== undefined) {
    let kept = decisions.filter((d) => d.keep).reduce((sum, d) => sum + weight(d), 0);
    const droppable = decisions
      .filter((d) => d.keep && !d.forced)
      .sort((a, b) => a.probability - b.probability);
    for (const decision of droppable) {
      if (kept <= options.maxTokens) break;
      decision.keep = false;
      kept -= weight(decision);
    }
  }
  return decisions;
}

/** Re-assemble kept units, keeping line breaks and the indentation of surviving lines. */
export function renderKept(decisions: readonly UnitDecision[]): string {
  let out = "";
  let previous: TextUnit | undefined;
  for (const { unit, keep } of decisions) {
    if (!keep) continue;
    if (previous === undefined) {
      out += unit.firstOnLine ? unit.indent : "";
    } else if (unit.line === previous.line) {
      out += " ";
    } else {
      out += "\n" + (unit.firstOnLine ? unit.indent : "");
    }
    out += unit.text;
    previous = unit;
  }
  return out;
}

/** Full LLMLingua-2 style pass over one text with a given scorer (exported for tests). */
export async function llmlinguaCompress(
  text: string,
  scorer: PreserveScorer,
  options: SelectionOptions,
): Promise<string> {
  const units = segmentUnits(text);
  if (units.length === 0) return text;
  const scores = await scorer.score(units);
  return renderKept(selectUnits(units, scores, options));
}

function softmaxAt(row: ArrayLike<number | bigint>, offset: number, width: number, index: number): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < width; i += 1) max = Math.max(max, Number(row[offset + i]));
  let sum = 0;
  for (let i = 0; i < width; i += 1) sum += Math.exp(Number(row[offset + i]) - max);
  return Math.exp(Number(row[offset + index]) - max) / sum;
}

/**
 * The transformers.js scorer: tokenizer + `AutoModelForTokenClassification`,
 * read logits directly and take softmax class 1 (exactly what the Python
 * reference does). The `token-classification` *pipeline* is not used because
 * it reports only the arg-max label's score, not the keep probability.
 *
 * Each whitespace unit is tokenized on its own and the ids are concatenated.
 * For WordPiece (BERT) and SentencePiece (XLM-R) tokenizers whitespace is a
 * hard pre-tokenization boundary, so this matches tokenizing the whole chunk,
 * and it gives an exact unit-to-token alignment without offset mappings.
 */
export async function createTransformersPreserveScorer(
  tf: TransformersModule,
  options: { modelId: string; dtype?: string; device?: string; subfolder?: string; revision?: string; maxSeqLen?: number },
): Promise<PreserveScorer> {
  const pretrained: PretrainedOptions = {};
  if (options.dtype !== undefined) pretrained.dtype = options.dtype;
  if (options.device !== undefined) pretrained.device = options.device;
  if (options.subfolder !== undefined) pretrained.subfolder = options.subfolder;
  if (options.revision !== undefined) pretrained.revision = options.revision;
  const tokenizer = await tf.AutoTokenizer.from_pretrained(options.modelId, pretrained);
  const model = await tf.AutoModelForTokenClassification.from_pretrained(options.modelId, pretrained);
  const maxSeqLen = options.maxSeqLen ?? 512;

  // [CLS] ... [SEP] (BERT) or <s> ... </s> (XLM-R): learn the wrapper from an empty encode.
  const wrapper = tokenizer.encode("", { add_special_tokens: true });
  const prefix = wrapper.slice(0, 1);
  const suffix = wrapper.slice(1);
  const budget = maxSeqLen - prefix.length - suffix.length;
  if (budget < 1) throw new Error("maxSeqLen too small for the tokenizer's special tokens.");

  async function runChunk(ids: number[][]): Promise<number[][]> {
    const flat = [...prefix, ...ids.flat(), ...suffix];
    const inputIds = new tf.Tensor("int64", BigInt64Array.from(flat.map((id) => BigInt(id))), [1, flat.length]);
    const attentionMask = new tf.Tensor("int64", new BigInt64Array(flat.length).fill(1n), [1, flat.length]);
    const { logits } = await model({ input_ids: inputIds, attention_mask: attentionMask });
    try {
      const [, seqLen, classes] = logits.dims;
      if (seqLen !== flat.length || classes < 2) throw new Error("Token-classification logits are not aligned with the inputs.");
      const probs: number[][] = [];
      let position = prefix.length;
      for (const unitIds of ids) {
        const unitProbs: number[] = [];
        for (let i = 0; i < unitIds.length; i += 1) {
          unitProbs.push(softmaxAt(logits.data, (position + i) * classes, classes, 1));
        }
        probs.push(unitProbs);
        position += unitIds.length;
      }
      return probs;
    } finally {
      logits.dispose?.();
      (inputIds as TensorLike).dispose?.();
      (attentionMask as TensorLike).dispose?.();
    }
  }

  return {
    async score(units) {
      // A single unit longer than the window is scored on its first `budget` tokens.
      const ids = units.map((unit) => tokenizer.encode(unit.text, { add_special_tokens: false }).slice(0, budget));
      const results: UnitScore[] = new Array(units.length);
      let chunk = 0;
      let start = 0;
      while (start < units.length) {
        // Greedily fill the window, then back off to the last preferred break (". " or end of line).
        let end = start;
        let used = 0;
        while (end < units.length && used + ids[end].length <= budget) {
          used += ids[end].length;
          end += 1;
        }
        if (end === start) end = start + 1; // cannot happen after slicing, but never loop forever
        if (end < units.length) {
          for (let i = end - 1; i > start; i -= 1) {
            if (units[i].breakAfter) {
              end = i + 1;
              break;
            }
          }
        }
        const probs = await runChunk(ids.slice(start, end));
        for (let i = start; i < end; i += 1) results[i] = { chunk, tokenProbs: probs[i - start] };
        chunk += 1;
        start = end;
      }
      return results;
    },
    dispose: () => model.dispose?.(),
  };
}

/**
 * Default token-classification model: an ONNX export of
 * microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank. Microsoft's
 * own repo ships PyTorch weights, which transformers.js cannot load; this id is
 * the BERT-base ONNX export the @atjsh/llmlingua-2 port documents. It is a
 * THIRD-PARTY export and was NOT verified from the build machine (Hugging Face
 * was unreachable) — pin `revision` and review it before relying on it, or
 * point `modelId` at your own export.
 */
export const DEFAULT_LLMLINGUA2_MODEL = "Arcoldd/llmlingua4j-bert-base-onnx";

export type Llmlingua2CompactorOptions = FailSafeOptions & ForcedUnitOptions & {
  /** Hugging Face model id (or local path) of an LLMLingua-2 ONNX export. */
  modelId?: string;
  /** Model files subfolder. Default "" for the default model (its model.onnx is at the repo root). */
  subfolder?: string;
  revision?: string;
  /** transformers.js dtype, e.g. "fp32" or "q8". Default: the library's default for the device. */
  dtype?: string;
  /** transformers.js device. Default "cpu". */
  device?: string;
  maxSeqLen?: number;
  /**
   * Fixed keep ratio in (0, 1]. Default: derived per body as
   * maxTokens / inputTokens, so the result targets the compactor's maxTokens.
   */
  rate?: number;
  transformersEnv?: TransformersEnvOverrides;
  /** Inject the transformers module (tests, bundlers). Default: dynamic import of the optional peer. */
  importTransformers?: () => Promise<TransformersModule>;
  /** Inject a ready scorer instead of loading a model (tests). Overrides modelId/importTransformers. */
  loadScorer?: () => Promise<PreserveScorer>;
};

/** LLMLingua-2 style token-dropping compactor, run locally via transformers.js. */
export function createLlmlingua2Compactor(options: Llmlingua2CompactorOptions = {}): LocalCompactor {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const modelId = options.modelId ?? DEFAULT_LLMLINGUA2_MODEL;
  const loadScorer = options.loadScorer ?? (async () => {
    const tf = await (options.importTransformers ?? (() => importTransformers()))();
    applyEnv(tf, options.transformersEnv);
    return createTransformersPreserveScorer(tf, {
      modelId,
      dtype: options.dtype,
      device: options.device ?? "cpu",
      subfolder: options.subfolder ?? (modelId === DEFAULT_LLMLINGUA2_MODEL ? "" : undefined),
      revision: options.revision,
      maxSeqLen: options.maxSeqLen,
    });
  });

  return failSafeCompactor(options, loadScorer, (scorer, { text, maxTokens, inputTokens }) => {
    const rate = options.rate ?? Math.min(1, maxTokens / inputTokens);
    return llmlinguaCompress(text, scorer, {
      rate,
      maxTokens,
      countTokens,
      conservative: options.conservative,
      forceTokens: options.forceTokens,
      forcePatterns: options.forcePatterns,
    });
  });
}

/* ----------------------------------------------------------------------------
 * Small generative summariser.
 * ------------------------------------------------------------------------- */

/** The fixed instruction given to the summariser. Not customer-tunable per call, so outputs stay comparable. */
export const SUMMARISER_SYSTEM_PROMPT =
  "You compress tool output that an AI agent saw earlier in a conversation. Rewrite it as briefly as possible " +
  "while keeping every fact the agent may still need. Copy file paths, identifiers, numbers, error messages, " +
  "and values EXACTLY as written. Drop repetition, boilerplate, and formatting noise. Do not add commentary, " +
  "advice, or anything not in the input. Output only the compressed content.";

/**
 * Default summariser: an ONNX build of Qwen2.5-0.5B-Instruct from the
 * onnx-community org. Not verified from the build machine; pin `revision`.
 */
export const DEFAULT_SUMMARISER_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

export type LocalSummariserOptions = FailSafeOptions & {
  modelId?: string;
  revision?: string;
  /** transformers.js dtype. Default "q4" (a ~0.5B model in 4-bit fits easily in CPU memory). */
  dtype?: string;
  /** Default "cpu". */
  device?: string;
  /**
   * Bodies above this many FLUX tokens are returned unchanged rather than
   * summarised from a truncated view. Default 8000.
   */
  maxInputTokens?: number;
  transformersEnv?: TransformersEnvOverrides;
  importTransformers?: () => Promise<TransformersModule>;
  /** Inject a ready generator instead of loading a model (tests). */
  loadGenerator?: () => Promise<TextGenerator>;
  /** Default 30000 ms: generation is slower than classification. */
  timeoutMs?: number;
};

/** Pull the assistant text out of a transformers.js text-generation result. */
export function generatedText(output: unknown): string | undefined {
  const first = Array.isArray(output) ? (Array.isArray(output[0]) ? output[0][0] : output[0]) : output;
  if (typeof first !== "object" || first === null) return undefined;
  const generated = (first as { generated_text?: unknown }).generated_text;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1] as { role?: unknown; content?: unknown } | undefined;
    if (last && last.role === "assistant" && typeof last.content === "string") return last.content;
  }
  return undefined;
}

/** Cut `text` to at most `maxTokens` FLUX tokens, at a whitespace boundary where possible. */
export function truncateToTokens(text: string, maxTokens: number, countTokens: TokenCounter = approximateTokenCount): string {
  if (safeCount(countTokens, text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (safeCount(countTokens, text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const boundary = cut.search(/\s\S*$/);
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
}

/** Small instruct-model summariser, run locally via transformers.js text-generation. */
export function createLocalSummariserCompactor(options: LocalSummariserOptions = {}): LocalCompactor {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const maxInputTokens = options.maxInputTokens ?? 8000;
  const loadGenerator = options.loadGenerator ?? (async () => {
    const tf = await (options.importTransformers ?? (() => importTransformers()))();
    applyEnv(tf, options.transformersEnv);
    const pretrained: PretrainedOptions = { dtype: options.dtype ?? "q4", device: options.device ?? "cpu" };
    if (options.revision !== undefined) pretrained.revision = options.revision;
    return tf.pipeline("text-generation", options.modelId ?? DEFAULT_SUMMARISER_MODEL, pretrained);
  });

  return failSafeCompactor({ ...options, timeoutMs: options.timeoutMs ?? 30_000 }, loadGenerator, async (generate, { text, maxTokens, inputTokens }) => {
    if (inputTokens > maxInputTokens) return text; // never summarise a partial view
    const output = await generate(
      [
        { role: "system", content: SUMMARISER_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      { max_new_tokens: maxTokens, do_sample: false, return_full_text: false },
    );
    const raw = generatedText(output);
    if (raw === undefined) throw new Error("Text-generation output had no generated text.");
    // Reasoning models may emit a think block; it is never part of the compacted body.
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // HARD CAP: max_new_tokens counts model tokens; enforce the ceiling in FLUX tokens too.
    return truncateToTokens(cleaned, maxTokens, countTokens);
  });
}
