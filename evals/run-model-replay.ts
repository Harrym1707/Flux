import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateReplay, runReplayCases } from "../packages/core/src/index.js";
import type {
  ReplayAdapter,
  ReplayInputCase,
  ReplayPolicy,
  ReplayTarget,
} from "../packages/core/src/index.js";

type ReplayConfig = {
  name: string;
  mode: "mock" | "openai";
  pricingIsIllustrative?: boolean;
  pricingSource?: string;
  pricingAsOf?: string;
  baseline: ReplayTarget;
  candidate: ReplayTarget;
  requests: ReplayInputCase[];
};

type Options = {
  config: string;
  policy: string;
  mode?: "mock" | "openai";
  out?: string;
};

class MockAdapter implements ReplayAdapter {
  constructor(
    private readonly baseline: ReplayTarget,
    private readonly candidate: ReplayTarget,
  ) {}

  async invoke(inputCase: ReplayInputCase, target: ReplayTarget) {
    const outputs = inputCase.mockOutputs;
    if (!outputs) throw new Error(`Request ${inputCase.id} lacks mockOutputs.`);
    if (target.provider !== "mock") throw new Error("Mock mode requires mock providers.");

    const isBaseline = target.model === this.baseline.model;
    const isCandidate = target.model === this.candidate.model;
    if (isBaseline === isCandidate) throw new Error(`Target ${target.model} is ambiguous in the mock config.`);

    return {
      output: isBaseline ? outputs.baseline : outputs.candidate,
      inputTokens: outputs.inputTokens,
      outputTokens: isBaseline ? outputs.baselineOutputTokens : outputs.candidateOutputTokens,
    };
  }
}

class OpenAIResponsesAdapter implements ReplayAdapter {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async invoke(inputCase: ReplayInputCase, target: ReplayTarget) {
    if (target.provider !== "openai") {
      throw new Error(`OpenAI mode does not support provider ${target.provider}.`);
    }
    const response = await this.client.responses.create({
      model: target.model,
      input: inputCase.input,
      ...(target.maxOutputTokens !== undefined ? { max_output_tokens: target.maxOutputTokens } : {}),
    });
    return {
      output: response.output_text,
      inputTokens: response.usage?.input_tokens,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens,
      cacheWriteInputTokens: response.usage?.input_tokens_details?.cache_write_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}

function parseOptions(argv: string[]): Options {
  const options: Record<string, string> = {};
  const allowed = new Set(["config", "policy", "mode", "out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm replay:run -- [--config file] [--policy file] [--mode mock|openai] [--out report.json]");
      process.exit(0);
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${key}`);
    options[name] = argv[++index];
  }
  if (options.mode !== undefined && options.mode !== "mock" && options.mode !== "openai") {
    throw new Error("Mode must be mock or openai.");
  }
  return {
    config: options.config ?? "evals/replay-run.example.json",
    policy: options.policy ?? "evals/replay-policy.example.json",
    mode: options.mode as Options["mode"],
    out: options.out,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function validateConfig(config: ReplayConfig, mode: "mock" | "openai"): void {
  if (!config.name || !Array.isArray(config.requests) || config.requests.length === 0) {
    throw new Error("Replay config needs a name and at least one request.");
  }
  if (!config.baseline?.model || !config.candidate?.model) {
    throw new Error("Replay config needs baseline and candidate model targets.");
  }
  if (config.baseline.model === config.candidate.model && config.baseline.provider === config.candidate.provider) {
    throw new Error("Baseline and candidate targets must differ.");
  }
  if (mode === "mock" && (config.baseline.provider !== "mock" || config.candidate.provider !== "mock")) {
    throw new Error('Mock mode requires both targets to use provider "mock".');
  }
  if (mode === "openai" && (config.baseline.provider !== "openai" || config.candidate.provider !== "openai")) {
    throw new Error('OpenAI mode requires both targets to use provider "openai".');
  }
  if (mode === "openai" && (config.pricingIsIllustrative !== false || !config.pricingSource || !config.pricingAsOf)) {
    throw new Error("OpenAI replay requires current, non-illustrative target prices plus pricingSource and pricingAsOf in the config.");
  }
  for (const target of [config.baseline, config.candidate]) {
    if (target.maxOutputTokens !== undefined &&
        (!Number.isInteger(target.maxOutputTokens) || target.maxOutputTokens < 1)) {
      throw new Error(`Target ${target.model} has invalid maxOutputTokens.`);
    }
    if (target.pricing && (
        !Number.isFinite(target.pricing.inputPerMillion) || target.pricing.inputPerMillion < 0 ||
        !Number.isFinite(target.pricing.outputPerMillion) || target.pricing.outputPerMillion < 0)) {
      throw new Error(`Target ${target.model} has invalid input/output pricing per million tokens.`);
    }
    for (const [name, value] of Object.entries({
      cachedInputPerMillion: target.pricing?.cachedInputPerMillion,
      cacheWriteInputPerMillion: target.pricing?.cacheWriteInputPerMillion,
    })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`Target ${target.model} has invalid ${name} pricing per million tokens.`);
      }
    }
    if (mode === "openai" && !target.pricing) {
      throw new Error(`Target ${target.model} needs explicit input/output pricing per million tokens.`);
    }
  }
  const ids = new Set<string>();
  for (const request of config.requests) {
    if (!request.id || typeof request.input !== "string" || !("expected" in request)) {
      throw new Error("Each request needs a unique id, string input, and expected output.");
    }
    if (ids.has(request.id)) throw new Error(`Duplicate request id: ${request.id}`);
    ids.add(request.id);
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseOptions(argv[0] === "--" ? argv.slice(1) : argv);
  const config = await readJson<ReplayConfig>(resolve(options.config));
  const mode = options.mode ?? config.mode;
  validateConfig(config, mode);
  const policy = await readJson<ReplayPolicy>(resolve(options.policy));

  let adapter: ReplayAdapter;
  if (mode === "mock") {
    adapter = new MockAdapter(config.baseline, config.candidate);
  } else {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI replay requires OPENAI_API_KEY in .env.");
    adapter = new OpenAIResponsesAdapter(apiKey);
  }

  const run = await runReplayCases(config.requests, config.baseline, config.candidate, adapter);
  const report = evaluateReplay(run.records, policy);
  console.log(config.name);
  console.log(`Mode: ${mode}`);
  console.log(`Requests replayed: ${report.sampleSize} (${report.sampleSize * 2} provider calls)`);
  console.log(`Baseline accuracy: ${percent(report.baselineAccuracy)}`);
  console.log(`Candidate accuracy: ${percent(report.candidateAccuracy)}`);
  console.log(`Observed accuracy drop: ${(report.accuracyDrop * 100).toFixed(1)} percentage points`);
  console.log(`Candidate one-sided 95% Wilson lower bound: ${percent(report.candidateAccuracyLower95)}`);
  if (report.costSavingsPercent !== null) {
    console.log(`Cost: $${report.baselineCostUsd!.toFixed(6)} -> $${report.candidateCostUsd!.toFixed(6)} (${report.costSavingsPercent.toFixed(1)}% savings)`);
  } else {
    console.log("Cost: unavailable (provider usage or target pricing missing)");
  }
  if (run.failures.length > 0) {
    console.log(`Provider errors: ${run.failures.map(({ id, side }) => `${id}:${side}`).join(", ")}`);
  }
  if (report.candidateFailureIds.length > 0) {
    console.log(`Candidate failures: ${report.candidateFailureIds.join(", ")}`);
  }
  for (const gate of report.gates) {
    console.log(`${gate.passed ? "PASS" : "FAIL"} ${gate.name}`);
  }
  console.log(`Eligible for review: ${report.eligibleForReview}`);

  if (options.out) {
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify({
      name: config.name,
      mode,
      pricingSource: config.pricingSource,
      pricingAsOf: config.pricingAsOf,
      baseline: config.baseline,
      candidate: config.candidate,
      policy,
      report,
      failures: run.failures.map(({ id, side }) => ({ id, side })),
    }, null, 2)}\n`);
    console.log(`Summary report saved to ${out}`);
  }
  if (run.failures.length > 0 || !report.eligibleForReview) process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Replay failed.";
  console.error(message);
  process.exitCode = 1;
});
