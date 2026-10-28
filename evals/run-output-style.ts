import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lookupPrice,
  publishedModelPrices,
  resolveModelId,
  type LedgerRecord,
  type TokenPrice,
} from "../packages/core/src/index.js";
import { OUTPUT_STYLE_INSTRUCTIONS, type FluxOutputStyle } from "../packages/sdk-js/src/output-style.js";
import { reduceRequest } from "../packages/sdk-js/src/reduce-request.js";
import { replayGate, responseText, type ReplayGrader } from "../packages/sdk-js/src/replay-gate.js";

/**
 * Output-style economics: does a short "say less" instruction pay for itself?
 *
 * No live API key is available where this runs by default, so the default
 * mode models the economics honestly instead of measuring them:
 *
 *   COST    = the instruction's input tokens, priced uncached (1x), as a
 *             cache write (1.25x, first turn) and as a cache read (0.1x,
 *             every later turn: it sits at the end of the stable system
 *             prompt, inside the cached prefix). Token counts are what
 *             reduceRequest ACTUALLY adds, by FLUX's approximate counter,
 *             which overcounts prose by up to 1.28x — so cost is overstated.
 *   BENEFIT = output tokens saved, using PUBLISHED reduction figures. Every
 *             one is a LITERATURE-CLAIM from someone else's workload, never a
 *             FLUX measurement, and is printed with its source.
 *
 * Break-even output length O* is the response length at which saved output
 * equals the instruction's input cost:  O* = I * inputRate / (r * outputRate).
 * Responses longer than O* save money; shorter ones lose it.
 *
 * Workload shapes are the five agents of FLUX's 2026-10-26 live export
 * (evals/live-exports-2026-10-26, real Anthropic usage, n=30 requests). The
 * per-shape savings apply literature-claim reductions to those measured
 * output lengths, so they are ESTIMATES, labelled as such.
 *
 *   --live   with ANTHROPIC_API_KEY set: a real paired A/B through the
 *            replay gate (baseline vs concise/terse/ultra on ten dev
 *            questions, judged by the same model). Costs real money; the
 *            call count is printed. FLUX_LIVE_MODEL overrides the model.
 */

type Mode = Exclude<FluxOutputStyle, "off">;
const MODES: Mode[] = ["concise", "terse", "ultra"];

type Claim = { reduction: number; label: string; source: string; url: string };

// Literature claims. Verified 2026-10-28 by web search; see the URLs.
const CAVEMAN_URL = "https://github.com/JuliusBrussee/caveman";
const JETBRAINS_URL = "https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/";
const ELASTIC_URL = "https://www.elastic.co/search-labs/blog/elastic-caveman-ai-token-reduction";
const INFOWORLD_URL = "https://www.infoworld.com/article/4193775/talk-like-a-caveman-prompts-save-tokens-but-far-less-than-promised.html";

/** Agentic coding: the only paired A/B on real agent tasks. Caveman skill forced on; a ceiling, not a typical. */
const AGENTIC: Claim = {
  reduction: 0.085,
  label: "agentic (JetBrains)",
  source: "JetBrains paired A/B, Caveman skill forced on, Claude Code + Sonnet 5, SkillsBench tasks: " +
    "592k -> 542k output tokens (8.5%), no measurable quality loss (p=0.82 per secondary coverage)",
  url: JETBRAINS_URL,
};

/** Chat-style dev Q&A, per mode: Caveman's own ten-question table (claude-opus-5-5). */
const CHAT: Record<Mode, Claim> = {
  concise: {
    reduction: 1 - 4_334 / 6_983,
    label: "chat (Caveman 'Answer concisely.')",
    source: "Caveman README: 10 dev questions, claude-opus-5-5, 6,983 -> 4,334 output tokens",
    url: CAVEMAN_URL,
  },
  terse: {
    reduction: 1 - 4_119 / 6_983,
    label: "chat (Caveman /caveman)",
    source: "Caveman README: 10 dev questions, /caveman rules, 6,983 -> 4,119 output tokens",
    url: CAVEMAN_URL,
  },
  ultra: {
    reduction: 1 - 2_693 / 6_983,
    label: "chat (Caveman /ultracave)",
    source: "Caveman README: 10 dev questions, /ultracave, 6,983 -> 2,693 output tokens",
    url: CAVEMAN_URL,
  },
};

const ELASTIC: Claim = {
  reduction: 0.636,
  label: "MCP answers (Elastic)",
  source: "Elastic elastic-caveman: 8 scenarios on live MCP data, 1,284 -> 467 response tokens (63.6%)",
  url: ELASTIC_URL,
};

/** Caveman's full rule set, for comparison: ~1,160 input tokens per turn (Caveman README). */
const CAVEMAN_RULES_TOKENS = 1_160;

const MODEL_ROWS: Array<{ provider: string; model: string }> = [
  { provider: "anthropic", model: "Sonnet 5.5" },
  { provider: "anthropic", model: "Opus 5.5" },
  { provider: "anthropic", model: "Haiku 5.5" },
  { provider: "anthropic", model: "Fable 5.1" },
  { provider: "openai", model: "gpt-5" },
  { provider: "openai", model: "gpt-5.5" },
  { provider: "openai", model: "gpt-6-astra" },
];
const PRICE_DATE = "2026-10-28";

function priceOf(provider: string, model: string): TokenPrice {
  const lookup = lookupPrice(publishedModelPrices, { provider, model, at: PRICE_DATE });
  if (lookup.status !== "priced") throw new Error(lookup.reason);
  return lookup.price;
}

/** Tokens reduceRequest actually adds for a mode, measured on a real Anthropic-shaped request. */
function addedTokens(mode: Mode): number {
  const { summary } = reduceRequest({
    model: "claude-sonnet-5-5",
    max_tokens: 1024,
    system: "You are a coding agent.",
    messages: [{ role: "user", content: "Fix the failing test." }],
  }, { outputStyle: mode, toolSchemas: false, duplicateContext: false });
  const change = summary.changes.find((entry) => entry.lever === `output-style-${mode}`);
  if (change?.estimatedTokensAdded === undefined) throw new Error(`output-style-${mode} was not applied.`);
  return change.estimatedTokensAdded;
}

function breakEven(instructionTokens: number, inputRate: number, reduction: number, outputRate: number): number {
  return (instructionTokens * inputRate) / (reduction * outputRate);
}

const fmt = (value: number, digits = 0): string =>
  Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "n/a";
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

type Shape = { name: string; requests: number; meanInput: number; meanOutput: number; meanCached: number; spendPerRequest: number; model: string };

function liveShapes(): Shape[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "live-exports-2026-10-26");
  return readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().map((file) => {
    const events = readFileSync(join(dir, file), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as LedgerRecord).event);
    const n = events.length;
    const sum = (pick: (event: (typeof events)[number]) => number): number =>
      events.reduce((total, event) => total + pick(event), 0);
    return {
      name: file.replace(/^anthropic-/, "").replace(/\.jsonl$/, ""),
      requests: n,
      meanInput: sum((event) => event.usage?.inputTokens ?? 0) / n,
      meanOutput: sum((event) => event.usage?.outputTokens ?? 0) / n,
      meanCached: sum((event) => event.usage?.cachedInputTokens ?? 0) / n,
      spendPerRequest: sum((event) => event.actualUsd ?? 0) / n,
      model: events[0]?.model ?? "unknown",
    };
  });
}

function modelled(): void {
  const added = Object.fromEntries(MODES.map((mode) => [mode, addedTokens(mode)])) as Record<Mode, number>;
  const sonnet = priceOf("anthropic", "Sonnet 5.5");
  const cacheWrite = sonnet.cacheWriteInputPerMillion ?? sonnet.inputPerMillion;
  const cacheRead = sonnet.cachedInputPerMillion ?? sonnet.inputPerMillion;

  console.log("# FLUX output-style economics (MODELLED — no live API key; every reduction is a literature-claim)");
  console.log("");
  console.log("## Instructions (exact bytes FLUX appends to the end of the stable system prompt)");
  console.log("");
  for (const mode of MODES) {
    console.log(`- ${mode} (${added[mode]} tokens added, estimate by FLUX's over-counting counter): "${OUTPUT_STYLE_INSTRUCTIONS[mode]}"`);
  }
  console.log(`- for comparison, Caveman full rules: ~${fmt(CAVEMAN_RULES_TOKENS)} input tokens per turn (literature-claim, ${CAVEMAN_URL})`);
  console.log("");

  console.log("## Literature claims used (none is a FLUX measurement)");
  console.log("");
  for (const claim of [AGENTIC, CHAT.concise, CHAT.terse, CHAT.ultra, ELASTIC]) {
    console.log(`- ${pct(claim.reduction)} — ${claim.source}. ${claim.url}`);
  }
  console.log(`- Secondary coverage of the JetBrains result: ${INFOWORLD_URL}`);
  console.log("");

  console.log(`## Break-even output length per mode — Sonnet 5.5 at catalogued prices (${PRICE_DATE})`);
  console.log("");
  console.log(`Input $${sonnet.inputPerMillion}/M, cache write $${cacheWrite}/M, cache read $${cacheRead}/M, output $${sonnet.outputPerMillion}/M. ` +
    "O* = response length (output tokens) above which the instruction pays for itself. All figures: estimate on literature-claim reductions.");
  console.log("");
  const breakRows: string[][] = [];
  for (const mode of MODES) {
    for (const claim of [AGENTIC, CHAT[mode]]) {
      breakRows.push([
        mode,
        String(added[mode]),
        `${pct(claim.reduction)} ${claim.label}`,
        fmt(breakEven(added[mode], sonnet.inputPerMillion, claim.reduction, sonnet.outputPerMillion)),
        fmt(breakEven(added[mode], cacheWrite, claim.reduction, sonnet.outputPerMillion)),
        fmt(breakEven(added[mode], cacheRead, claim.reduction, sonnet.outputPerMillion), 1),
      ]);
    }
  }
  for (const claim of [AGENTIC, CHAT.terse]) {
    breakRows.push([
      "Caveman full rules",
      fmt(CAVEMAN_RULES_TOKENS),
      `${pct(claim.reduction)} ${claim.label}`,
      fmt(breakEven(CAVEMAN_RULES_TOKENS, sonnet.inputPerMillion, claim.reduction, sonnet.outputPerMillion)),
      fmt(breakEven(CAVEMAN_RULES_TOKENS, cacheWrite, claim.reduction, sonnet.outputPerMillion)),
      fmt(breakEven(CAVEMAN_RULES_TOKENS, cacheRead, claim.reduction, sonnet.outputPerMillion), 1),
    ]);
  }
  console.log(table(
    ["mode", "instr. tokens", "output reduction (literature-claim)", "O* uncached", "O* cache write (turn 1)", "O* cached read (turn 2+)"],
    breakRows,
  ));
  console.log("");

  console.log("## Break-even across catalogued models — concise, agentic 8.5% claim (the conservative case)");
  console.log("");
  console.log(table(
    ["model", "in $/M", "cached $/M", "out $/M", "out/in", "O* uncached", "O* cached"],
    MODEL_ROWS.map(({ provider, model }) => {
      const price = priceOf(provider, model);
      const cached = price.cachedInputPerMillion ?? price.inputPerMillion;
      return [
        `${provider}/${model}`,
        String(price.inputPerMillion),
        String(cached),
        String(price.outputPerMillion),
        `${(price.outputPerMillion / price.inputPerMillion).toFixed(1)}x`,
        fmt(breakEven(added.concise, price.inputPerMillion, AGENTIC.reduction, price.outputPerMillion)),
        fmt(breakEven(added.concise, cached, AGENTIC.reduction, price.outputPerMillion), 1),
      ];
    }),
  ));
  console.log("");

  const shapes = liveShapes();
  console.log("## FLUX workload shapes — live export 2026-10-26 (measured usage), savings ESTIMATED on literature-claims");
  console.log("");
  console.log("Instruction priced UNCACHED (worst case: 4 of 5 live agents had no cache reads). " +
    "Net = output saved minus instruction cost, as a share of that agent's measured spend per request.");
  console.log("");
  const shapeRows: string[][] = [];
  for (const shape of shapes) {
    const resolution = resolveModelId(publishedModelPrices, "anthropic", shape.model);
    if (resolution.status !== "resolved") continue;
    const price = priceOf("anthropic", resolution.model);
    const row = [shape.name, String(shape.requests), fmt(shape.meanInput), fmt(shape.meanOutput), `$${shape.spendPerRequest.toFixed(5)}`];
    for (const mode of MODES) {
      for (const claim of [AGENTIC, CHAT[mode]]) {
        const saved = (claim.reduction * shape.meanOutput * price.outputPerMillion) / 1e6;
        const cost = (added[mode] * price.inputPerMillion) / 1e6;
        row.push(pct((saved - cost) / shape.spendPerRequest));
      }
    }
    shapeRows.push(row);
  }
  console.log(table(
    ["agent", "n", "mean in", "mean out", "spend/req",
      ...MODES.flatMap((mode) => [`${mode} @8.5%`, `${mode} @${pct(CHAT[mode].reduction)}`])],
    shapeRows,
  ));
  console.log("");
  // Which measured shapes fall BELOW the uncached break-even under the
  // conservative agentic claim: there the instruction loses money unless cached.
  const losing: string[] = [];
  for (const shape of shapes) {
    for (const mode of MODES) {
      const threshold = breakEven(added[mode], sonnet.inputPerMillion, AGENTIC.reduction, sonnet.outputPerMillion);
      if (shape.meanOutput < threshold) losing.push(`${shape.name}/${mode} (mean out ${fmt(shape.meanOutput)} < O* ${fmt(threshold)})`);
    }
  }
  console.log("Reading it (estimate): at the cached rate every mode breaks even at a few output tokens, so with " +
    "the cache stamp on the instruction's cost is negligible on every shape. Uncached, under the conservative " +
    `8.5% agentic claim, ${losing.length === 0 ? "no shape falls below O*" : `these fall below O* and LOSE money: ${losing.join("; ")}`}. ` +
    "The real uncertainty is the reduction itself (8.5% on agentic coding, itself a forced-on ceiling, vs " +
    "~38-61% on chat Q&A), which only a live paired A/B on your own traffic settles. Enabling a style rewrites " +
    "the cached prefix ONCE (one cache write of the existing prefix), then stays byte-stable. Lossy: bills only " +
    "with an approved replay-gate verdict.");
  console.log("");
  console.log("## Run the live A/B on your own key (real money; prints the call count)");
  console.log("");
  console.log("    ANTHROPIC_API_KEY=sk-ant-... FLUX_LIVE_MODEL=claude-sonnet-5-5-20260514 node --import tsx evals/run-output-style.ts --live");
}

// ---------------------------------------------------------------------------
// Live A/B (only with --live and a key)
// ---------------------------------------------------------------------------

const DEV_QUESTIONS = [
  "Why does my React component re-render on every keystroke, and how do I stop it?",
  "Explain the difference between git rebase and git merge, with the commands.",
  "My Postgres query is slow on a 10M-row table filtered by created_at. What should I check?",
  "How do I safely rotate a leaked AWS access key?",
  "What does `ECONNRESET` mean in a Node.js HTTP client and how do I handle it?",
  "Write a Python function that deduplicates a list while preserving order.",
  "When should I use a Kubernetes StatefulSet instead of a Deployment?",
  "How do I undo the last pushed commit on main without rewriting history?",
  "Why is my Docker image 2 GB and how do I shrink it?",
  "Explain TypeScript's `satisfies` operator with an example.",
];

async function live(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("--live needs ANTHROPIC_API_KEY.");
  const model = process.env.FLUX_LIVE_MODEL ?? "claude-sonnet-5-5-20260514";
  const call = async (request: unknown): Promise<unknown> => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
  let judgeCalls = 0;
  // Same-model judge: does the styled answer keep every fact, command, path and number of the baseline?
  const grade: ReplayGrader = async ({ baselineResponse, candidateResponse }) => {
    judgeCalls += 1;
    const verdict = await call({
      model,
      max_tokens: 5,
      messages: [{
        role: "user",
        content: "REFERENCE:\n" + responseText(baselineResponse) + "\n\nCANDIDATE:\n" + responseText(candidateResponse) +
          "\n\nDoes CANDIDATE keep every fact, command, code line, file path, number and safety warning in " +
          "REFERENCE that a developer needs? Answer only YES or NO.",
      }],
    });
    return /\bYES\b/i.test(responseText(verdict)) ? 1 : 0;
  };
  const resolved = resolveModelId(publishedModelPrices, "anthropic", model);
  const requests = DEV_QUESTIONS.map((question) => ({
    model,
    max_tokens: 2048,
    system: "You are a senior software engineer answering a colleague.",
    messages: [{ role: "user", content: question }],
  }));
  const result = await replayGate({
    requests,
    call,
    candidates: MODES.map((mode) => ({ label: mode, config: { outputStyle: mode, toolSchemas: false } })),
    grade,
    ...(resolved.status === "resolved" ? { price: priceOf("anthropic", resolved.model) } : {}),
  });
  console.log(`# FLUX output-style LIVE A/B — ${model}, ${requests.length} dev questions (MEASURED)`);
  console.log("");
  console.log(table(
    ["mode", "baseline out", "styled out", "output saved", "cost saved", "quality lower-95 (pp)", "gate"],
    result.candidates.map((candidate) => [
      candidate.label,
      fmt(candidate.baselineUsage.outputTokens),
      fmt(candidate.candidateUsage.outputTokens),
      pct(candidate.baselineUsage.outputTokens === 0 ? 0 : candidate.outputTokensSaved / candidate.baselineUsage.outputTokens),
      candidate.costSavingPercent === undefined ? "n/a" : `${candidate.costSavingPercent.toFixed(1)}%`,
      (candidate.lower95QualityDelta * 100).toFixed(1),
      candidate.approved ? "APPROVED" : `rejected: ${candidate.rejectionReason ?? ""}`,
    ]),
  ));
  console.log("");
  console.log(`Provider calls: ${result.calls} replay + ${judgeCalls} judge. n=${requests.length} is small; treat as a smoke A/B.`);
  for (const note of result.notes) console.log(`- ${note}`);
}

if (process.argv.includes("--live")) await live();
else modelled();
