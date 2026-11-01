import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { approximateTokenCount } from "../../core/dist/src/index.js";
import {
  createLlmlingua2Compactor,
  createLocalSummariserCompactor,
  createTransformersPreserveScorer,
  DEFAULT_LLMLINGUA2_MODEL,
  DEFAULT_SUMMARISER_MODEL,
  importTransformers,
  segmentUnits,
  type LocalCompactor,
} from "./hf-compactor.js";

/**
 * REAL-MODEL integration test for the bundled Hugging Face compactors.
 *
 * SKIPPED unless FLUX_HF_MODEL_TEST=1 is set AND @huggingface/transformers is
 * installed AND the model can be loaded (downloaded from the Hugging Face Hub
 * or found in the local cache). Run it on a machine with Hub access:
 *
 *   pnpm --filter @flux-ai/sdk add -D @huggingface/transformers@4.3.1
 *   FLUX_HF_MODEL_TEST=1 pnpm vitest run packages/sdk-js/src/hf-compactor.integration.test.ts
 *   git checkout -- packages/sdk-js/package.json pnpm-lock.yaml && pnpm install   # undo; do not commit the add
 *
 * With FLUX_HF_MODEL_TEST=1, a missing package or an unloadable model FAILS the
 * run (a "preconditions" test) rather than silently skipping.
 *
 * Optional overrides: FLUX_HF_LLMLINGUA_MODEL, FLUX_HF_SUMMARISER_MODEL.
 *
 * It asserts the guarantees (shorter, never grows, forced tokens survive,
 * hard cap) and that class 1 really is the "preserve" class (filler words
 * score lower than content words). It PRINTS the observed compression on one
 * synthetic sample for the founder to read; that single number is an
 * observation, not a benchmark, and must not be quoted as a savings figure.
 */

const enabled = process.env.FLUX_HF_MODEL_TEST === "1";
const llmlinguaModel = process.env.FLUX_HF_LLMLINGUA_MODEL ?? DEFAULT_LLMLINGUA2_MODEL;
const summariserModel = process.env.FLUX_HF_SUMMARISER_MODEL ?? DEFAULT_SUMMARISER_MODEL;
const LOAD_TIMEOUT_MS = 15 * 60_000; // first run downloads hundreds of MB

async function probe(make: () => LocalCompactor): Promise<{ compactor?: LocalCompactor; reason?: string }> {
  if (!enabled) return { reason: "FLUX_HF_MODEL_TEST is not 1" };
  try {
    await importTransformers();
  } catch (error) {
    return { reason: (error as Error).message };
  }
  const compactor = make();
  try {
    await compactor.load();
    return { compactor };
  } catch (error) {
    // Loud, because the founder asked for this run explicitly.
    console.warn(`[hf-compactor integration] model not reachable, skipping: ${(error as Error).message}`);
    return { reason: (error as Error).message };
  }
}

const SAMPLE = [
  "$ npm test",
  "> app@1.4.2 test /home/dev/app",
  "> vitest run",
  "",
  "So basically the test runner started up and then it was just, um, collecting all of the test files that it could find in the project.",
  " FAIL  src/billing/invoice.test.ts > computes VAT for EU customers",
  "AssertionError: expected 119.99 to equal 120.00",
  "    at src/billing/invoice.test.ts:42:17",
  "    at runTest (node_modules/vitest/dist/runner.js:880:11)",
  "Basically everything else that the runner looked at was really very fine and there were no other problems of any kind at all.",
  " Test Files  1 failed | 37 passed (38)",
  "      Tests  1 failed | 412 passed (413)",
].join("\n").repeat(3);

const FORCED = ["app@1.4.2", "src/billing/invoice.test.ts:42:17", "119.99", "120.00", "AssertionError:", "(413)"];

// OFFLINE glue check: the real transformers.js + onnxruntime-node path against
// a tiny FAKE model committed under packages/sdk-js/fixtures (an embedding
// lookup, not LLMLingua). Needs the package installed, never the Hub. Proves
// tokenizer/Tensor/logits wiring only; its scores mean nothing.
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
let transformersInstalled = false;
if (enabled) {
  try {
    await importTransformers();
    transformersInstalled = true;
  } catch {
    // reported by probe() below
  }
}

describe.skipIf(!transformersInstalled)("real transformers.js runtime with a tiny local fixture model (offline)", () => {
  it("loads from a local path with remote models disabled, scores per unit, chunks, and compacts", async () => {
    const tf = await importTransformers();
    const env = tf.env ?? {};
    const saved = { allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath };
    const errors: string[] = [];
    const options = { modelId: "tiny-lingua", dtype: "fp32", maxSeqLen: 16 };
    const compactor = createLlmlingua2Compactor({
      ...options,
      transformersEnv: { allowRemoteModels: false, localModelPath: fixturesDir },
      onError: (error, stage) => errors.push(`${stage}: ${(error as Error).message}`),
    });
    try {
      await compactor.load();
      const scorer = await createTransformersPreserveScorer(tf, options);
      const units = segmentUnits("um the job finished\nbasically step 3 reported src/index.ts:17");
      const scores = await scorer.score(units);
      expect(scores).toHaveLength(units.length);
      expect(new Set(scores.map((s) => s.chunk)).size).toBeGreaterThan(1); // 16-token window forces >1 chunk
      expect(scores[2].tokenProbs[0]).toBeGreaterThan(scores[0].tokenProbs[0]); // fixture: "job" > "um"
      const text = Array.from({ length: 12 }, (_, i) => `um so the job was basically just running and the step ${i} finished really fine`).join("\n");
      const out = await compactor.compact({ text, maxTokens: 120, kind: "tool-result" });
      expect(errors).toEqual([]);
      expect(out.length).toBeLessThan(text.length);
      for (let i = 0; i < 12; i += 1) expect(out).toContain(`step ${i}`);
    } finally {
      // The env is module-global; restore it so the Hub-backed suites below can download.
      Object.assign(env, saved);
    }
  }, 120_000);
});

const llmlingua = await probe(() => createLlmlingua2Compactor({ modelId: llmlinguaModel, timeoutMs: LOAD_TIMEOUT_MS }));

describe.skipIf(!llmlingua.compactor)(`LLMLingua-2 compactor with a real model (${llmlinguaModel})`, () => {
  it("class 1 is the preserve class: fillers score below content words", async () => {
    const tf = await importTransformers();
    const scorer = await createTransformersPreserveScorer(tf, {
      modelId: llmlinguaModel,
      subfolder: llmlinguaModel === DEFAULT_LLMLINGUA2_MODEL ? "" : undefined,
    });
    const units = segmentUnits("um so basically the quarterly revenue forecast increased because enterprise renewals accelerated");
    const scores = await scorer.score(units);
    const mean = (words: string[]) => {
      const picked = units.flatMap((unit, i) => (words.includes(unit.text) ? scores[i].tokenProbs : []));
      return picked.reduce((a, b) => a + b, 0) / picked.length;
    };
    const filler = mean(["um", "so", "basically", "the"]);
    const content = mean(["quarterly", "revenue", "forecast", "enterprise", "renewals"]);
    console.info(`[hf-compactor integration] mean p_preserve filler=${filler.toFixed(3)} content=${content.toFixed(3)}`);
    expect(content).toBeGreaterThan(filler);
  }, LOAD_TIMEOUT_MS);

  it("compresses tool output, never grows, and keeps every forced token", async () => {
    const maxTokens = Math.floor(approximateTokenCount(SAMPLE) / 2);
    const out = await llmlingua.compactor!.compact({ text: SAMPLE, maxTokens, kind: "tool-result" });
    const before = approximateTokenCount(SAMPLE);
    const after = approximateTokenCount(out);
    console.info(`[hf-compactor integration] llmlingua2 sample: ${before} -> ${after} FLUX tokens (target ${maxTokens}); ONE synthetic sample, not a benchmark\n${out}`);
    expect(out).not.toBe(SAMPLE);
    expect(after).toBeLessThan(before);
    for (const token of FORCED) expect(out).toContain(token);
  }, LOAD_TIMEOUT_MS);
});

const summariser = await probe(() => createLocalSummariserCompactor({ modelId: summariserModel, timeoutMs: LOAD_TIMEOUT_MS }));

// With FLUX_HF_MODEL_TEST=1 the founder asked for a REAL-model run. If the
// package or a model could not be loaded, the suites above skip — and a green
// run with skipped suites would look like a validation that never happened. So
// fail loudly instead, naming what is missing.
describe.runIf(enabled)("real-model validation preconditions (FLUX_HF_MODEL_TEST=1)", () => {
  it("@huggingface/transformers is installed and both real models loaded", () => {
    const problems = [
      ...(transformersInstalled ? [] : ["@huggingface/transformers is not installed"]),
      ...(llmlingua.compactor ? [] : [`LLMLingua-2 model ${llmlinguaModel}: ${llmlingua.reason}`]),
      ...(summariser.compactor ? [] : [`summariser model ${summariserModel}: ${summariser.reason}`]),
    ];
    if (problems.length > 0) {
      throw new Error(`Real-model validation did NOT run (see docs/rnd/semantic-compaction-design.md): ${problems.join("; ")}`);
    }
  });
});

describe.skipIf(!summariser.compactor)(`local summariser with a real model (${summariserModel})`, () => {
  it("returns a shorter body within the hard cap", async () => {
    const maxTokens = 120;
    const out = await summariser.compactor!.compact({ text: SAMPLE, maxTokens, kind: "tool-result" });
    console.info(`[hf-compactor integration] summariser sample: ${approximateTokenCount(SAMPLE)} -> ${approximateTokenCount(out)} FLUX tokens (cap ${maxTokens}); ONE synthetic sample, not a benchmark\n${out}`);
    expect(out).not.toBe(SAMPLE);
    expect(approximateTokenCount(out)).toBeLessThanOrEqual(maxTokens);
  }, LOAD_TIMEOUT_MS);
});
