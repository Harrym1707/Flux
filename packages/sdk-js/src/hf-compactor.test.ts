import { describe, expect, it, vi } from "vitest";
import { approximateTokenCount } from "../../core/dist/src/index.js";
import type { LedgerGateVerdict } from "../../core/dist/src/index.js";
import {
  createLlmlingua2Compactor,
  createLocalSummariserCompactor,
  createTransformersPreserveScorer,
  generatedText,
  importTransformers,
  isForcedUnit,
  llmlinguaCompress,
  MISSING_TRANSFORMERS_MESSAGE,
  percentile,
  renderKept,
  segmentUnits,
  selectUnits,
  SUMMARISER_SYSTEM_PROMPT,
  truncateToTokens,
  type ChatMessage,
  type PreserveScorer,
  type TextGenerator,
  type TextUnit,
  type TransformersModule,
  type UnitScore,
} from "./hf-compactor.js";
import { compactStaleContext } from "./semantic-compaction.js";

/**
 * Unit tests for the bundled local Hugging Face compactors.
 *
 * EVERYTHING here runs against INJECTED FAKES: a fake scorer, a fake
 * transformers.js module (tokenizer + token-classification model + Tensor),
 * and a fake text generator. No model is downloaded and nothing touches the
 * network. These tests prove the selection logic, the transformers.js glue and
 * the fail-safe guarantees — NOT that any real model compresses well. The real-
 * model check lives in hf-compactor.integration.test.ts (skipped by default).
 */

const APPROVED: LedgerGateVerdict = { ref: "gate-run-test", verdict: "approved" };

/** Fake scorer: one preserve probability per unit (by word), all tokens equal, single chunk. */
function wordScorer(probabilityOf: (word: string) => number, chunkSize = Number.POSITIVE_INFINITY): PreserveScorer & { calls: number } {
  const scorer = {
    calls: 0,
    async score(units: readonly TextUnit[]): Promise<UnitScore[]> {
      scorer.calls += 1;
      return units.map((unit, index) => ({ chunk: Math.floor(index / chunkSize), tokenProbs: [probabilityOf(unit.text)] }));
    },
  };
  return scorer;
}

const FILLERS = new Set(["the", "a", "an", "of", "and", "um", "uh", "basically", "really", "very", "just", "so", "that", "is", "was"]);
const fillerLow = (word: string): number => (FILLERS.has(word.toLowerCase().replace(/[^\w]/g, "")) ? 0.05 : 0.9);

function scores(units: TextUnit[], probs: number[], chunk = 0): UnitScore[] {
  return units.map((_, index) => ({ chunk, tokenProbs: [probs[index]] }));
}

describe("percentile (numpy linear interpolation)", () => {
  it("matches numpy.percentile on known values", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([0, 10], 51)).toBeCloseTo(5.1, 10);
    expect(percentile([5, 1, 3], 50)).toBe(3); // unsorted input
  });
});

describe("segmentUnits + renderKept", () => {
  it("splits on whitespace, records lines and indentation, and round-trips when everything is kept", () => {
    const text = "Traceback (most recent call last):\n  File \"app.py\", line 3\n    raise ValueError";
    const units = segmentUnits(text);
    expect(units.map((u) => u.text)).toEqual([
      "Traceback", "(most", "recent", "call", "last):", "File", "\"app.py\",", "line", "3", "raise", "ValueError",
    ]);
    expect(units[5]).toMatchObject({ line: 1, firstOnLine: true, indent: "  " });
    expect(units[9]).toMatchObject({ line: 2, firstOnLine: true, indent: "    " });
    const all = units.map((unit) => ({ unit, probability: 1, forced: false, keep: true }));
    expect(renderKept(all)).toBe(text);
  });

  it("drops fully-dropped lines and keeps surviving lines on their own line", () => {
    const units = segmentUnits("keep this\ndrop drop\n  also kept");
    const keep = [true, true, false, false, true, true];
    const out = renderKept(units.map((unit, i) => ({ unit, probability: 0, forced: false, keep: keep[i] })));
    expect(out).toBe("keep this\n  also kept");
  });
});

describe("forced-token detection (conservative for tool output)", () => {
  it.each([
    "42", "v1.2.3", "src/app.ts:42", "C:\\Users\\x", "https://example.com", "user_id", "__init__",
    "getUserById", "os.path", "std::vector", "key=value", "ERROR", "ENOENT:", "--force", "-v",
    "TypeError:", "failed", "Exception", "undefined", "null,", "0x1f",
  ])("forces %s", (unit) => {
    expect(isForcedUnit(unit)).toBe(true);
  });

  it.each(["the", "basically", "Hello,", "really", "and", "output"])("does not force plain word %s", (unit) => {
    expect(isForcedUnit(unit)).toBe(false);
  });

  it("always forces digits even when conservative mode is off, and honours custom force tokens/patterns", () => {
    expect(isForcedUnit("user_id", { conservative: false })).toBe(false);
    expect(isForcedUnit("port 8080".split(" ")[1], { conservative: false })).toBe(true);
    expect(isForcedUnit("Kubernetes,", { forceTokens: ["Kubernetes"] })).toBe(true);
    expect(isForcedUnit("pod-abc", { forcePatterns: [/^pod-/] })).toBe(true);
  });
});

describe("selectUnits (LLMLingua-2 selection)", () => {
  it("applies the reference threshold percentile(probs, int(100*(1-rate)+1)) with strict >", () => {
    const units = segmentUnits("a b c d e f g h i j");
    const probs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
    const decisions = selectUnits(units, scores(units, probs), { rate: 0.5, conservative: false });
    // q = int(100*0.5 + 1) = 51 -> threshold = percentile(probs, 51) = 0.5 + 0.1*0.59 = 0.559
    const threshold = percentile(probs, 51);
    expect(threshold).toBeCloseTo(0.559, 10);
    expect(decisions.map((d) => d.keep)).toEqual(probs.map((p) => p > threshold));
    expect(decisions.filter((d) => d.keep).map((d) => d.unit.text)).toEqual(["f", "g", "h", "i", "j"]);
  });

  it("uses the mean of a unit's token probabilities as its word probability", () => {
    const units = segmentUnits("alpha beta");
    const decisions = selectUnits(units, [
      { chunk: 0, tokenProbs: [0.2, 0.4] },
      { chunk: 0, tokenProbs: [0.9] },
    ], { rate: 1, conservative: false });
    expect(decisions[0].probability).toBeCloseTo(0.3, 10);
    expect(decisions[1].probability).toBeCloseTo(0.9, 10);
  });

  it.each([0.25, 0.5, 0.75])("targets the keep rate %s (within one unit) on uniform-weight units", (rate) => {
    // letters only so nothing is forced; distinct probabilities
    const words = Array.from({ length: 40 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const units = segmentUnits(words.join(" "));
    const probs = units.map((_, i) => (i * 37 % 40) / 40 + 0.001);
    const kept = selectUnits(units, scores(units, probs), { rate, conservative: false }).filter((d) => d.keep).length;
    expect(Math.abs(kept - rate * units.length)).toBeLessThanOrEqual(1);
  });

  it("weights the percentile by each unit's token count (LLMLingua expands word probs per OAI token)", () => {
    const units = segmentUnits("tiny enormouslylongwordthatcostsmanytokensbecauseitisunsplittable x");
    const counter = (text: string) => (text.length > 20 ? 8 : 1);
    const decisions = selectUnits(units, scores(units, [0.2, 0.9, 0.5]), { rate: 0.5, conservative: false, countTokens: counter });
    // expanded = [0.2, 0.9 x8, 0.5]; 51st percentile is 0.9 -> nothing strictly above it.
    expect(decisions.map((d) => d.keep)).toEqual([false, false, false]);
  });

  it("never drops forced units (numbers, paths, identifiers, errors) even with the lowest probability", () => {
    const text = "the build basically failed at src/index.ts:17 because user_id was really undefined in getUser after 3 retries";
    const units = segmentUnits(text);
    const decisions = selectUnits(units, scores(units, units.map(() => 0.01)), { rate: 0.1, maxTokens: 1 });
    const kept = decisions.filter((d) => d.keep).map((d) => d.unit.text);
    for (const forced of ["failed", "src/index.ts:17", "user_id", "undefined", "getUser", "3"]) {
      expect(kept).toContain(forced);
    }
    for (const filler of ["the", "basically", "really"]) expect(kept).not.toContain(filler);
  });

  it("keeps units whole: output words are an in-order subsequence of input words, never split or invented", async () => {
    const text = "um so the request to /api/v2/users?id=991 returned HTTP 503 and the retry basically just hung";
    const out = await llmlinguaCompress(text, wordScorer(fillerLow), { rate: 0.5 });
    const inWords = text.split(/\s+/);
    let cursor = 0;
    for (const word of out.split(/\s+/)) {
      const found = inWords.indexOf(word, cursor);
      expect(found).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
    expect(out).toContain("/api/v2/users?id=991");
    expect(out).toContain("503");
  });

  it("trims lowest-probability non-forced units until the maxTokens target is met", () => {
    const units = segmentUnits("one two three four five six seven eight");
    const probs = [0.9, 0.8, 0.7, 0.6, 0.95, 0.85, 0.75, 0.65];
    // rate ~1 keeps all but the bottom percentile ("four", 0.6); the 3-token target then trims
    // the lowest remaining (0.65, 0.7, 0.75, 0.8), leaving the three most probable.
    const decisions = selectUnits(units, scores(units, probs), { rate: 1 - 1e-9, maxTokens: 3, conservative: false });
    expect(decisions.filter((d) => d.keep).map((d) => d.unit.text)).toEqual(["one", "five", "six"]);
  });

  it("computes the threshold per chunk, like the reference implementation", () => {
    const units = segmentUnits("a b c d");
    // chunk 0 has low probs, chunk 1 high probs: each chunk keeps its own top half.
    const perChunk: UnitScore[] = [
      { chunk: 0, tokenProbs: [0.1] }, { chunk: 0, tokenProbs: [0.2] },
      { chunk: 1, tokenProbs: [0.8] }, { chunk: 1, tokenProbs: [0.9] },
    ];
    expect(selectUnits(units, perChunk, { rate: 0.5, conservative: false }).map((d) => d.keep)).toEqual([false, true, false, true]);
  });

  it("rejects a scorer that returns the wrong number of scores", () => {
    const units = segmentUnits("a b");
    expect(() => selectUnits(units, [{ chunk: 0, tokenProbs: [1] }], { rate: 0.5 })).toThrow(/does not match/);
  });
});

/** A long, filler-heavy tool output with forced tokens sprinkled in. */
const TOOL_OUTPUT = Array.from({ length: 30 }, (_, i) =>
  `the job that was running basically just reported that the step ${i} finished and so the output is really very fine`,
).join("\n");

describe("createLlmlingua2Compactor (injected scorer)", () => {
  it("derives rate from maxTokens and lands at or under the target when nothing is forced but the line numbers", async () => {
    const compactor = createLlmlingua2Compactor({ loadScorer: async () => wordScorer(fillerLow) });
    const maxTokens = 400;
    const before = approximateTokenCount(TOOL_OUTPUT);
    expect(before).toBeGreaterThan(maxTokens);
    const out = await compactor.compact({ text: TOOL_OUTPUT, maxTokens, kind: "tool-result" });
    expect(approximateTokenCount(out)).toBeLessThanOrEqual(maxTokens);
    expect(out.length).toBeLessThan(TOOL_OUTPUT.length);
    for (let i = 0; i < 30; i += 1) expect(out).toContain(` ${i} `.trim());
  });

  it("is lazy: nothing loads at construction or for bodies already under maxTokens", async () => {
    const loadScorer = vi.fn(async () => wordScorer(fillerLow));
    const compactor = createLlmlingua2Compactor({ loadScorer });
    expect(loadScorer).not.toHaveBeenCalled();
    expect(compactor.loaded).toBe(false);
    expect(await compactor.compact({ text: "short body", maxTokens: 500, kind: "tool-result" })).toBe("short body");
    expect(loadScorer).not.toHaveBeenCalled();
  });

  it("loads once on first use and caches the model across calls, including concurrent ones", async () => {
    const loadScorer = vi.fn(async () => wordScorer(fillerLow));
    const compactor = createLlmlingua2Compactor({ loadScorer, memoSize: 0 });
    await Promise.all([1, 2, 3].map(() => compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })));
    await compactor.compact({ text: TOOL_OUTPUT + " extra", maxTokens: 100, kind: "tool-result" });
    expect(loadScorer).toHaveBeenCalledTimes(1);
    expect(compactor.loaded).toBe(true);
  });

  it("memoises: the same stale body re-sent next turn gets byte-identical output without re-inference", async () => {
    const scorer = wordScorer(fillerLow);
    const compactor = createLlmlingua2Compactor({ loadScorer: async () => scorer });
    const first = await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" });
    const second = await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" });
    expect(second).toBe(first);
    expect(scorer.calls).toBe(1);
  });

  it("FAIL-SAFE: an inference error returns the original text, reports it, and never throws", async () => {
    const onError = vi.fn();
    const compactor = createLlmlingua2Compactor({
      loadScorer: async () => ({ score: async () => { throw new Error("onnx exploded"); } }),
      onError,
    });
    await expect(compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).resolves.toBe(TOOL_OUTPUT);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "onnx exploded" }), "inference");
  });

  it("FAIL-SAFE: a load error returns the original text, and the failed load is not retried until the window passes", async () => {
    const onError = vi.fn();
    const loadScorer = vi.fn(async (): Promise<PreserveScorer> => { throw new Error("hub unreachable"); });
    const compactor = createLlmlingua2Compactor({ loadScorer, onError, retryLoadAfterMs: 60_000 });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(loadScorer).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "hub unreachable" }), "load");
    await expect(compactor.load()).rejects.toThrow("hub unreachable");
  });

  it("retries a failed load once the retry window has passed", async () => {
    let attempts = 0;
    const compactor = createLlmlingua2Compactor({
      retryLoadAfterMs: 0,
      loadScorer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first load fails");
        return wordScorer(fillerLow);
      },
    });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).not.toBe(TOOL_OUTPUT);
    expect(attempts).toBe(2);
  });

  it("FAIL-SAFE: a timeout returns the original text; a slow load keeps going and is used once ready", async () => {
    let releaseLoad: (scorer: PreserveScorer) => void = () => undefined;
    const slowLoad = new Promise<PreserveScorer>((resolve) => { releaseLoad = resolve; });
    const onError = vi.fn();
    const compactor = createLlmlingua2Compactor({ loadScorer: () => slowLoad, timeoutMs: 20, onError });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "timeout");
    releaseLoad(wordScorer(fillerLow));
    await compactor.load();
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).not.toBe(TOOL_OUTPUT);
  });

  it("FAIL-SAFE: a hung inference times out to the original text", async () => {
    const compactor = createLlmlingua2Compactor({
      loadScorer: async () => ({ score: () => new Promise<UnitScore[]>(() => undefined) }),
      timeoutMs: 20,
    });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
  });

  it("NEVER GROWS: when the model keeps everything, the original bytes come back unchanged", async () => {
    const onError = vi.fn();
    const compactor = createLlmlingua2Compactor({ loadScorer: async () => wordScorer(() => 1), rate: 1, onError });
    const text = "word ".repeat(300).trim();
    expect(await compactor.compact({ text, maxTokens: 10, kind: "tool-result" })).toBe(text);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "rejected-output");
  });

  it("NEVER GROWS: output is never longer than input across many random probability assignments", async () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 25; trial += 1) {
      const compactor = createLlmlingua2Compactor({ loadScorer: async () => wordScorer(() => random()), memoSize: 0 });
      const maxTokens = 1 + Math.floor(random() * 600);
      const out = await compactor.compact({ text: TOOL_OUTPUT, maxTokens, kind: "tool-result" });
      expect(approximateTokenCount(out)).toBeLessThanOrEqual(approximateTokenCount(TOOL_OUTPUT));
      expect(out.length).toBeLessThanOrEqual(TOOL_OUTPUT.length);
    }
  });

  it("never throws on malformed input", async () => {
    const compactor = createLlmlingua2Compactor({ loadScorer: async () => wordScorer(fillerLow) });
    const bad = compactor.compact({ text: undefined as unknown as string, maxTokens: 10, kind: "tool-result" });
    await expect(bad).resolves.toBeUndefined();
    await expect(compactor.compact({ text: TOOL_OUTPUT, maxTokens: Number.NaN, kind: "tool-result" })).resolves.toBe(TOOL_OUTPUT);
    await expect(compactor.compact({ text: TOOL_OUTPUT, maxTokens: 0, kind: "tool-result" })).resolves.toBe(TOOL_OUTPUT);
  });

  it("a throwing onError logger cannot break the request path", async () => {
    const compactor = createLlmlingua2Compactor({
      loadScorer: async () => { throw new Error("load"); },
      onError: () => { throw new Error("logger broke"); },
    });
    await expect(compactor.compact({ text: TOOL_OUTPUT, maxTokens: 10, kind: "tool-result" })).resolves.toBe(TOOL_OUTPUT);
  });
});

describe("optional peer dependency", () => {
  const MISSING = "@flux-ai/definitely-not-installed-transformers";
  const missingImport = () => importTransformers(MISSING);

  it("importTransformers rejects with a clear message when the package cannot be imported", async () => {
    await expect(missingImport()).rejects.toThrow(MISSING_TRANSFORMERS_MESSAGE);
  });

  it("a compactor without the dependency is a no-op for compact() but load() surfaces the clear error", async () => {
    const onError = vi.fn();
    const compactor = createLlmlingua2Compactor({ onError, importTransformers: missingImport });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(onError.mock.calls[0][0].message).toBe(MISSING_TRANSFORMERS_MESSAGE);
    const summariser = createLocalSummariserCompactor({ retryLoadAfterMs: 0, importTransformers: missingImport });
    expect(await summariser.compact({ text: TOOL_OUTPUT, maxTokens: 100, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    await expect(summariser.load()).rejects.toThrow(MISSING_TRANSFORMERS_MESSAGE);
  });
});

/* ------------------------------------------------------------------------
 * Fake transformers.js module, to test the real glue code without a model.
 * Tokenizer: one token per 3 characters; ids are deterministic. Model: logits
 * whose class-1 margin comes from a per-id table, recorded per call.
 * --------------------------------------------------------------------- */

class FakeTensor {
  constructor(public type: string, public data: BigInt64Array | Float32Array, public dims: number[]) {}
  disposed = false;
  dispose() { this.disposed = true; }
}

function fakeTransformers(options: { preserveLogit?: (id: number) => number } = {}) {
  const vocab = new Map<string, number>();
  const pieceToId = (piece: string): number => {
    if (!vocab.has(piece)) vocab.set(piece, 1000 + vocab.size);
    return vocab.get(piece)!;
  };
  const idToPiece = (id: number): string => [...vocab.entries()].find(([, v]) => v === id)?.[0] ?? "";
  const calls: { modelInputs: number[][]; fromPretrained: unknown[]; pipeline: unknown[]; env: Record<string, unknown> } = {
    modelInputs: [], fromPretrained: [], pipeline: [], env: {},
  };
  const preserveLogit = options.preserveLogit ?? ((id: number) => (FILLERS.has(idToPiece(id).replace(/^##/, "")) ? -3 : 3));
  const tokenizer = {
    encode(text: string, opts?: { add_special_tokens?: boolean }): number[] {
      const pieces: string[] = [];
      for (const word of text.split(/\s+/).filter(Boolean)) {
        if (FILLERS.has(word)) { pieces.push(word); continue; }
        for (let i = 0; i < word.length; i += 3) pieces.push((i === 0 ? "" : "##") + word.slice(i, i + 3));
      }
      const ids = pieces.map(pieceToId);
      return opts?.add_special_tokens === false ? ids : [101, ...ids, 102];
    },
  };
  const model = Object.assign(
    async (inputs: Record<string, unknown>) => {
      const ids = [...(inputs.input_ids as FakeTensor).data as BigInt64Array].map(Number);
      calls.modelInputs.push(ids);
      const logits = new Float32Array(ids.length * 2);
      ids.forEach((id, i) => { logits[i * 2] = 0; logits[i * 2 + 1] = preserveLogit(id); });
      return { logits: new FakeTensor("float32", logits, [1, ids.length, 2]) };
    },
    { dispose: vi.fn() },
  );
  const generator: TextGenerator = async (messages) => [{ generated_text: [...messages, { role: "assistant", content: "summary of tool output" }] }];
  const module: TransformersModule = {
    AutoTokenizer: { from_pretrained: async (id, opts) => { calls.fromPretrained.push(["tokenizer", id, opts]); return tokenizer; } },
    AutoModelForTokenClassification: { from_pretrained: async (id, opts) => { calls.fromPretrained.push(["model", id, opts]); return model; } },
    Tensor: FakeTensor as unknown as TransformersModule["Tensor"],
    pipeline: async (task, id, opts) => { calls.pipeline.push([task, id, opts]); return generator; },
    env: calls.env,
  };
  return { module, calls };
}

describe("createTransformersPreserveScorer (fake transformers.js module)", () => {
  it("takes softmax class 1 of the logits per model token and aligns tokens to whitespace units", async () => {
    const { module } = fakeTransformers({ preserveLogit: () => Math.log(3) }); // softmax([0, ln3])[1] = 0.75
    const scorer = await createTransformersPreserveScorer(module, { modelId: "m" });
    const units = segmentUnits("abcdef the xy");
    const result = await scorer.score(units);
    expect(result.map((r) => r.tokenProbs.length)).toEqual([2, 1, 1]); // "abc","##def" | "the" | "xy"
    for (const r of result) for (const p of r.tokenProbs) expect(p).toBeCloseTo(0.75, 6); // float32 logits
  });

  it("chunks to maxSeqLen including [CLS]/[SEP], preferring breaks after a sentence end or newline", async () => {
    const { module, calls } = fakeTransformers();
    const scorer = await createTransformersPreserveScorer(module, { modelId: "m", maxSeqLen: 8 }); // budget 6
    const units = segmentUnits("aa bb cc.\ndd ee ff gg hh ii");
    const result = await scorer.score(units);
    for (const ids of calls.modelInputs) {
      expect(ids.length).toBeLessThanOrEqual(8);
      expect(ids[0]).toBe(101);
      expect(ids[ids.length - 1]).toBe(102);
    }
    // First window could hold 6 units but backs off to the break after "cc." (and the line end).
    expect(result.slice(0, 3).every((r) => r.chunk === 0)).toBe(true);
    expect(result[3].chunk).toBe(1);
    expect(result.every((r) => r.tokenProbs.length === 1)).toBe(true);
  });

  it("disposes tensors after each run", async () => {
    const { module } = fakeTransformers();
    const created: FakeTensor[] = [];
    const Tracking = class extends FakeTensor {
      constructor(type: string, data: BigInt64Array, dims: number[]) { super(type, data, dims); created.push(this); }
    };
    const scorer = await createTransformersPreserveScorer({ ...module, Tensor: Tracking as unknown as TransformersModule["Tensor"] }, { modelId: "m" });
    await scorer.score(segmentUnits("one two"));
    expect(created.length).toBe(2);
    expect(created.every((t) => t.disposed)).toBe(true);
  });

  it("end to end through the compactor: loads tokenizer + token-classification model with options, applies env, drops fillers", async () => {
    const { module, calls } = fakeTransformers();
    const compactor = createLlmlingua2Compactor({
      importTransformers: async () => module,
      modelId: "org/llmlingua-2-onnx",
      dtype: "q8",
      transformersEnv: { allowRemoteModels: false, localModelPath: "/models" },
    });
    const out = await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 300, kind: "tool-result" });
    expect(calls.fromPretrained).toEqual([
      ["tokenizer", "org/llmlingua-2-onnx", { dtype: "q8", device: "cpu" }],
      ["model", "org/llmlingua-2-onnx", { dtype: "q8", device: "cpu" }],
    ]);
    expect(calls.env).toEqual({ allowRemoteModels: false, localModelPath: "/models" });
    expect(out.length).toBeLessThan(TOOL_OUTPUT.length);
    expect(out).not.toMatch(/\bbasically\b/);
    for (let i = 0; i < 30; i += 1) expect(out.split("\n")).toContain(String(i)); // forced digits survive
  });
});

describe("createLocalSummariserCompactor (injected generator)", () => {
  function fakeGenerator(reply: string | (() => Promise<unknown>)) {
    const calls: { messages: ChatMessage[]; options: unknown }[] = [];
    const generator: TextGenerator = async (messages, options) => {
      calls.push({ messages, options });
      if (typeof reply === "function") return reply();
      return [{ generated_text: reply }];
    };
    return { generator, calls };
  }

  it("uses the fixed prompt, greedy decoding, and max_new_tokens = maxTokens", async () => {
    const { generator, calls } = fakeGenerator("step 0..29 finished; output fine");
    const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator });
    const out = await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 64, kind: "tool-result" });
    expect(out).toBe("step 0..29 finished; output fine");
    expect(calls[0].messages).toEqual([
      { role: "system", content: SUMMARISER_SYSTEM_PROMPT },
      { role: "user", content: TOOL_OUTPUT },
    ]);
    expect(calls[0].options).toEqual({ max_new_tokens: 64, do_sample: false, return_full_text: false });
  });

  it("HARD CAP: output is cut to maxTokens FLUX tokens even if the model overruns", async () => {
    const { generator } = fakeGenerator("word ".repeat(200));
    const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator });
    const out = await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 20, kind: "tool-result" });
    expect(approximateTokenCount(out)).toBeLessThanOrEqual(20);
    expect(out.length).toBeGreaterThan(0);
  });

  it("strips reasoning <think> blocks and parses chat-format output", async () => {
    const { generator } = fakeGenerator(async () => [{
      generated_text: [{ role: "user", content: "x" }, { role: "assistant", content: "<think>hmm</think>\nshort summary" }],
    }]);
    const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 50, kind: "tool-result" })).toBe("short summary");
  });

  it("NEVER GROWS: a reply longer than the input is discarded for the original", async () => {
    const text = "a b c d e f g h i j k l m n o p q r s t u v w x y z";
    const inputTokens = approximateTokenCount(text);
    // The reply, even after the hard cap, has fewer tokens but MORE characters than the input.
    const { generator } = fakeGenerator("extraordinarily verbose ".repeat(40));
    const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator });
    expect(await compactor.compact({ text, maxTokens: inputTokens - 1, kind: "tool-result" })).toBe(text);
  });

  it("FAIL-SAFE: empty output, generator errors, malformed output and timeouts all return the original", async () => {
    for (const reply of [
      "   ",
      async () => { throw new Error("oom"); },
      async () => ({ nope: true }),
      () => new Promise(() => undefined),
    ] as const) {
      const { generator } = fakeGenerator(reply as string | (() => Promise<unknown>));
      const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator, timeoutMs: 20 });
      expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 50, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    }
  });

  it("refuses to summarise a body above maxInputTokens (no partial-view summaries)", async () => {
    const { generator, calls } = fakeGenerator("tiny");
    const compactor = createLocalSummariserCompactor({ loadGenerator: async () => generator, maxInputTokens: 50 });
    expect(await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 20, kind: "tool-result" })).toBe(TOOL_OUTPUT);
    expect(calls).toHaveLength(0);
  });

  it("is lazy and loads the text-generation pipeline once with the default q4 dtype on cpu", async () => {
    const { module, calls } = fakeTransformers();
    const importer = vi.fn(async () => module);
    const compactor = createLocalSummariserCompactor({ importTransformers: importer, modelId: "org/small-instruct" });
    expect(importer).not.toHaveBeenCalled();
    await compactor.compact({ text: TOOL_OUTPUT, maxTokens: 50, kind: "tool-result" });
    await compactor.compact({ text: TOOL_OUTPUT + "!", maxTokens: 50, kind: "tool-result" });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(calls.pipeline).toEqual([["text-generation", "org/small-instruct", { dtype: "q4", device: "cpu" }]]);
  });
});

describe("helpers", () => {
  it("generatedText handles string, chat and nested-batch outputs", () => {
    expect(generatedText([{ generated_text: "a" }])).toBe("a");
    expect(generatedText([{ generated_text: [{ role: "assistant", content: "b" }] }])).toBe("b");
    expect(generatedText([[{ generated_text: "c" }]])).toBe("c");
    expect(generatedText([{ generated_text: [{ role: "user", content: "d" }] }])).toBeUndefined();
    expect(generatedText(null)).toBeUndefined();
  });

  it("truncateToTokens respects the cap and cuts at a word boundary", () => {
    const out = truncateToTokens("alpha beta gamma delta epsilon", 3);
    expect(approximateTokenCount(out)).toBeLessThanOrEqual(3);
    expect("alpha beta gamma delta epsilon".startsWith(out)).toBe(true);
    expect(out.endsWith(" ")).toBe(false);
    expect(truncateToTokens("short", 10)).toBe("short");
  });
});

describe("plugged into the gated semantic-compaction pre-pass", () => {
  const conversation = {
    model: "m",
    messages: [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "calling tool" },
      { role: "tool", tool_call_id: "t1", content: TOOL_OUTPUT },
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ],
  };

  it("is never called without an approved gate verdict", async () => {
    const loadScorer = vi.fn(async () => wordScorer(fillerLow));
    const result = await compactStaleContext(conversation, { compactor: createLlmlingua2Compactor({ loadScorer }) });
    expect(result.request).toBe(conversation);
    expect(loadScorer).not.toHaveBeenCalled();
  });

  it("compacts the stale tool result as a lossy change when approved", async () => {
    const result = await compactStaleContext(conversation, {
      compactor: createLlmlingua2Compactor({ loadScorer: async () => wordScorer(fillerLow) }),
      gateVerdict: APPROVED,
    });
    expect(result.change).toMatchObject({ lever: "semantic-compaction", lossless: false });
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });
});
