/**
 * Tokenizer calibration: how wrong is FLUX's approximate counter against the
 * EXACT OpenAI tokenizer, per content class?
 *
 *   node --import tsx evals/run-tokenizer-calibration.ts [--json out.json]
 *
 * Only FLUX-owned, committed text is measured, nothing fabricated and nothing
 * fetched:
 *   - prose (wire-capture prompts): every distinct system / instructions /
 *     message string in evals/wire-captures/*.jsonl;
 *   - prose (agent fixture): the shared agent fixture's preamble and tool
 *     results (evals/agent-fixture.ts, deterministic, committed code);
 *   - prose (markdown docs): README.md and docs/**.md (the built site excluded);
 *   - JSON (tool schemas): the `tools` array of every wire-capture request and
 *     of the agent fixture, serialised the way reduceRequest measures them;
 *   - JSON (request bodies): every wire-capture body, serialised whole;
 *   - JSON (other fixtures): committed .json files under evals/, content/ and
 *     docs/metrics/;
 *   - code (TypeScript): non-test sources of the packages and the API;
 *   - code (Python): evals/trace-analysis/*.py.
 *
 * Signed error is (approximate - exact) / exact: positive = the approximation
 * OVERcounts. "aggregate" weights by tokens (sum over the class); the median
 * and p10/p90 are per sample. The exact counts come from js-tiktoken's own
 * unbounded encoder, and are cross-checked against FLUX's bounded
 * exactTokenCount (the hot-path counter) - any disagreement is printed.
 *
 * This measures OpenAI's tokenizers only. Claude's tokenizer is not public;
 * nothing here says anything about Claude counts.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approximateTokenCount, exactTokenCount } from "../packages/core/src/index.js";
import { PREAMBLE, TASKS, TURNS_PER_TASK, toolResult, tools } from "./agent-fixture.js";

// js-tiktoken is a dependency of @flux/core, so it resolves from there.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(path.join(root, "packages/core/package.json"));
type Encoder = { encode(text: string, allowedSpecial?: string[], disallowedSpecial?: string[]): number[] };
const { Tiktoken } = requireFromCore("js-tiktoken/lite") as { Tiktoken: new (ranks: unknown) => Encoder };
const o200k = new Tiktoken(requireFromCore("js-tiktoken/ranks/o200k_base"));
const cl100k = new Tiktoken(requireFromCore("js-tiktoken/ranks/cl100k_base"));

type AnyObject = Record<string, unknown>;
type Sample = { source: string; text: string };

const rel = (file: string): string => path.relative(root, file);

function walk(dir: string, accept: (file: string) => boolean, skip: (dir: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!skip(full) && name !== "node_modules" && name !== "dist") out.push(...walk(full, accept, skip));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

// ---- wire captures ---------------------------------------------------------

const captureFiles = walk(path.join(root, "evals/wire-captures"), (file) => file.endsWith(".jsonl"));
const captures: Array<{ source: string; body: AnyObject }> = [];
for (const file of captureFiles) {
  readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const row = JSON.parse(line) as { body?: AnyObject };
    if (row.body !== undefined) captures.push({ source: `${rel(file)}:${index + 1}`, body: row.body });
  });
}

/** Every human-language string in a request body, tool schemas excluded. */
function proseStrings(body: AnyObject): string[] {
  const out: string[] = [];
  const pushText = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(pushText);
    else if (value !== null && typeof value === "object") {
      const object = value as AnyObject;
      for (const key of ["text", "content", "output"]) if (key in object) pushText(object[key]);
    }
  };
  pushText(body.system);
  pushText(body.instructions);
  for (const key of ["messages", "input"]) {
    const list = body[key];
    if (typeof list === "string") out.push(list);
    else if (Array.isArray(list)) list.forEach(pushText);
  }
  return out.filter((text) => text.trim() !== "");
}

function distinct(samples: Sample[]): Sample[] {
  const seen = new Set<string>();
  return samples.filter((sample) => !seen.has(sample.text) && seen.add(sample.text) !== undefined);
}

const fixtureProse: Sample[] = [{ source: "evals/agent-fixture.ts PREAMBLE", text: PREAMBLE }];
for (let task = 0; task < TASKS; task += 1) {
  for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
    fixtureProse.push({ source: `evals/agent-fixture.ts toolResult(${task},${turn})`, text: toolResult(task, turn) });
  }
}

const classes: Array<{ name: string; samples: Sample[] }> = [
  {
    name: "prose: wire-capture prompts",
    samples: distinct(captures.flatMap(({ source, body }) => proseStrings(body).map((text) => ({ source, text })))),
  },
  {
    // Kept separate: 200 near-identical tool results would otherwise swamp the
    // capture prompts in a token-weighted aggregate.
    name: "prose: agent fixture (preamble + tool results)",
    samples: distinct(fixtureProse),
  },
  {
    name: "prose: markdown docs",
    samples: [
      path.join(root, "README.md"),
      ...walk(path.join(root, "docs"), (file) => file.endsWith(".md"), (dir) => dir.endsWith(path.join("site", "dist"))),
    ]
      // The note that records this script's output is left out, so the table
      // it holds reproduces exactly from the commit that added it.
      .filter((file) => rel(file) !== "docs/rnd/2026-10-28-exact-openai-tokens.md")
      .map((file) => ({ source: rel(file), text: readFileSync(file, "utf8") })),
  },
  {
    name: "JSON: tool schemas",
    samples: distinct([
      ...captures
        .filter(({ body }) => Array.isArray(body.tools) && body.tools.length > 0)
        .map(({ source, body }) => ({ source, text: JSON.stringify(body.tools) })),
      { source: "evals/agent-fixture.ts tools()", text: JSON.stringify(tools()) },
    ]),
  },
  {
    name: "JSON: request bodies (captures)",
    samples: distinct(captures.map(({ source, body }) => ({ source, text: JSON.stringify(body) }))),
  },
  {
    name: "JSON: other committed fixtures",
    samples: [
      ...walk(path.join(root, "evals"), (file) => file.endsWith(".json")),
      ...walk(path.join(root, "content"), (file) => file.endsWith(".json")),
      ...walk(path.join(root, "docs/metrics"), (file) => file.endsWith(".json")),
    ].map((file) => ({ source: rel(file), text: readFileSync(file, "utf8") })),
  },
  {
    name: "code: TypeScript sources",
    samples: ["packages/core/src", "packages/sdk-js/src", "packages/providers/src", "packages/cli/src", "apps/api/src"]
      .flatMap((dir) => walk(path.join(root, dir), (file) => file.endsWith(".ts") && !file.endsWith(".test.ts")))
      .map((file) => ({ source: rel(file), text: readFileSync(file, "utf8") })),
  },
  {
    name: "code: Python",
    samples: walk(path.join(root, "evals/trace-analysis"), (file) => file.endsWith(".py"))
      .map((file) => ({ source: rel(file), text: readFileSync(file, "utf8") })),
  },
];

// ---- measure ---------------------------------------------------------------

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
};
const signed = (approx: number, exact: number): number => (approx - exact) / exact;
const pct = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

type Row = {
  name: string;
  samples: number;
  chars: number;
  exactO200k: number;
  exactCl100k: number;
  approximate: number;
  quarterChars: number;
  aggregateError: number;
  medianError: number;
  p10Error: number;
  p90Error: number;
  aggregateErrorVsCl100k: number;
  quarterCharsErrorVsO200k: number;
  charsPerToken: number;
};

let boundedMismatches = 0;
const rows: Row[] = [];
for (const { name, samples } of classes) {
  if (samples.length === 0) throw new Error(`No committed fixtures found for class "${name}".`);
  let chars = 0;
  let exactO = 0;
  let exactC = 0;
  let approx = 0;
  let quarter = 0;
  const perSample: number[] = [];
  for (const { source, text } of samples) {
    const o = o200k.encode(text, [], []).length;
    const bounded = exactTokenCount(text, "o200k_base");
    if (bounded !== o) {
      boundedMismatches += 1;
      console.warn(`bounded counter differs on ${source}: exact ${o}, bounded ${bounded}`);
    }
    const a = approximateTokenCount(text);
    chars += text.length;
    exactO += o;
    exactC += cl100k.encode(text, [], []).length;
    approx += a;
    quarter += Math.ceil(text.length / 4);
    if (o > 0) perSample.push(signed(a, o));
  }
  perSample.sort((left, right) => left - right);
  rows.push({
    name,
    samples: samples.length,
    chars,
    exactO200k: exactO,
    exactCl100k: exactC,
    approximate: approx,
    quarterChars: quarter,
    aggregateError: signed(approx, exactO),
    medianError: quantile(perSample, 0.5),
    p10Error: quantile(perSample, 0.1),
    p90Error: quantile(perSample, 0.9),
    aggregateErrorVsCl100k: signed(approx, exactC),
    quarterCharsErrorVsO200k: signed(quarter, exactO),
    charsPerToken: chars / exactO,
  });
}

console.log("Tokenizer calibration: approximateTokenCount vs exact o200k_base (js-tiktoken 1.0.21)");
console.log("signed error = (approx - exact) / exact; + means the approximation OVERcounts\n");
console.log("| class | n | chars | exact o200k | approx | aggregate err | median | p10 | p90 | err vs cl100k | ceil(len/4) err | chars/token |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  console.log(
    `| ${row.name} | ${row.samples} | ${row.chars} | ${row.exactO200k} | ${row.approximate} | ` +
    `${pct(row.aggregateError)} | ${pct(row.medianError)} | ${pct(row.p10Error)} | ${pct(row.p90Error)} | ` +
    `${pct(row.aggregateErrorVsCl100k)} | ${pct(row.quarterCharsErrorVsO200k)} | ${row.charsPerToken.toFixed(2)} |`,
  );
}
console.log(`\nbounded hot-path counter vs unbounded encoder: ${boundedMismatches} mismatching sample(s)`);

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1) {
  const out = process.argv[jsonFlag + 1];
  if (out === undefined) throw new Error("--json needs a path.");
  writeFileSync(out, `${JSON.stringify({ tokenizer: "o200k_base", package: "js-tiktoken@1.0.21", rows }, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
