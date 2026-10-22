import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { reduceRequest, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import { wirePrompt } from "./agent-fixture.js";

/**
 * The workload matrix: does FLUX reduce token spend on each of the
 * interaction shapes people actually run against foundation models?
 *
 *   node --import tsx evals/run-workload-matrix.ts
 *
 * Five shapes, each a realistic request stream: a multi-agent team (shared
 * system + tools fanned out to sub-agents), an autonomous long-horizon agent
 * (growing history, duplicated retry context), a continuous-memory agent
 * (the same memory block re-injected every turn), a RAG pipeline (templated
 * one-shots with duplicate excerpts and a volatile request id), and batch
 * classification (identical template, tiny varying item).
 *
 * Honesty constraints, stated so the table can be trusted:
 * - LOSSLESS levers only (schema compaction that decodes identically, exact
 *   duplicate removal, prefix repair that reorders without deleting) plus
 *   the 5m cache stamp, which is metadata-only. No quality gate is needed
 *   because no information is removed; lossy levers are excluded here.
 * - The baseline arm is the same stream UNREDUCED and UNSTAMPED, priced with
 *   caching off — which is the measured default state of Claude traffic
 *   (Anthropic's cache is opt-in; our live export recorded a five-turn agent
 *   with zero cache traffic).
 * - Costs come from the cache simulator at catalogued prices
 *   (claude-sonnet-5-5). The simulator models longest-prefix matching; all
 *   figures are SIMULATOR-MEASURED and labelled so wherever published.
 */

type AnyObject = Record<string, unknown>;

const LOSSLESS: FluxTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

const AT = "2026-10-19";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// --- Shared building blocks ------------------------------------------------

const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(14);

const TOOLS = Array.from({ length: 10 }, (_, index) => ({
  name: `tool_${index}`,
  description:
    `Tool ${index} operates on subsystem ${index}. It validates its input against the schema, retries once on ` +
    "transient failure, never mutates shared state without a lock, and returns a compact JSON result. " +
    "Use it only when the orchestrator's plan names this subsystem explicitly.",
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" }, scope: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["id"],
  },
}));

const MEMORY_BLOCK =
  "AGENT MEMORY (persistent): user prefers metric units; deploy window is 14:00-16:00 UTC; the staging DB is " +
  "read-only on Fridays; incident 4312 root cause was a stale feature flag; the review checklist has 9 items; " +
  "always page the on-call before schema changes. ".repeat(6);

const EXCERPTS = Array.from({ length: 8 }, (_, index) =>
  `Excerpt ${index}: clause ${index} of the services agreement sets the notification window, defines the ` +
  "remediation ladder, and assigns liability for third-party outages to the operating party. ".repeat(3));

type Shaped = { atSeconds: number; request: AnyObject; outputTokens: number };

// --- The five shapes --------------------------------------------------------

/** 1 orchestrator + 4 specialists share one system + tool catalogue, 6 rounds. */
function multiAgentTeam(): Shaped[] {
  const stream: Shaped[] = [];
  const agents = ["orchestrator", "search", "coder", "reviewer", "writer"];
  const histories = new Map<string, AnyObject[]>(agents.map((name) => [name, []]));
  for (let round = 0; round < 6; round += 1) {
    for (const [slot, name] of agents.entries()) {
      const history = histories.get(name)!;
      history.push({ role: "user", content: `Round ${round} task for ${name}: advance the plan for ticket 7 (step ${round}).` });
      stream.push({
        atSeconds: round * 40 + slot * 4,
        request: {
          model: "claude-sonnet-5-5", max_tokens: 500,
          system: PREAMBLE, tools: TOOLS,
          messages: [...history],
        },
        outputTokens: 220,
      });
      history.push({ role: "assistant", content: `(${name}) round ${round} done: findings recorded for step ${round}.` });
    }
  }
  return stream;
}

/** One agent, 28 turns, growing history; retries duplicate the failed context verbatim. */
function autonomousAgent(): Shaped[] {
  const stream: Shaped[] = [];
  const history: AnyObject[] = [];
  const RETRY_BLOCK = "Tool tool_3 failed: transient 503 from subsystem 3; identical request will be retried with the same arguments and the same context. ";
  for (let turn = 0; turn < 28; turn += 1) {
    const retry = turn % 4 === 3 ? ` ${RETRY_BLOCK}${RETRY_BLOCK}${RETRY_BLOCK}` : "";
    history.push({ role: "user", content: `Turn ${turn}: continue the migration run.${retry}` });
    stream.push({
      atSeconds: turn * 20,
      request: { model: "claude-sonnet-5-5", max_tokens: 600, system: PREAMBLE, tools: TOOLS, messages: [...history] },
      outputTokens: 320,
    });
    history.push({ role: "assistant", content: `Turn ${turn} complete; files touched logged at step ${turn}.` });
  }
  return stream;
}

/** Continuous-learning agent: the same memory block re-injected every turn. */
function memoryAgent(): Shaped[] {
  const stream: Shaped[] = [];
  const history: AnyObject[] = [];
  for (let turn = 0; turn < 16; turn += 1) {
    history.push({ role: "user", content: `${MEMORY_BLOCK}\nTurn ${turn}: handle today's request ${turn}.` });
    stream.push({
      atSeconds: turn * 45,
      request: { model: "claude-sonnet-5-5", max_tokens: 500, system: PREAMBLE, messages: [...history] },
      outputTokens: 260,
    });
    history.push({ role: "assistant", content: `Noted. Turn ${turn} handled per memory.` });
  }
  return stream;
}

/** RAG: templated one-shots; volatile request id up top; duplicate excerpts. */
function ragPipeline(): Shaped[] {
  const stream: Shaped[] = [];
  for (let index = 0; index < 40; index += 1) {
    const picks = [EXCERPTS[index % 8]!, EXCERPTS[(index + 3) % 8]!, EXCERPTS[0]!, EXCERPTS[0]!, EXCERPTS[(index + 5) % 8]!];
    stream.push({
      atSeconds: index * 8,
      request: {
        model: "claude-sonnet-5-5", max_tokens: 400,
        system: `request-id 123e4567-e89b-12d3-a456-4266141740${String(index % 100).padStart(2, "0")}\n${PREAMBLE}`,
        messages: [{ role: "user", content: `Context:\n${picks.join("\n")}\nQuestion ${index}: what does the clause require?` }],
      },
      outputTokens: 180,
    });
  }
  return stream;
}

/** Batch classification: identical template, tiny varying item. */
function batchClassification(): Shaped[] {
  const stream: Shaped[] = [];
  for (let index = 0; index < 60; index += 1) {
    stream.push({
      atSeconds: index * 2,
      request: {
        model: "claude-sonnet-5-5", max_tokens: 60,
        system: PREAMBLE, tools: TOOLS.slice(0, 6),
        messages: [{ role: "user", content: `Classify ticket ${index}: "printer on floor ${index % 9} shows error E${index}."` }],
      },
      outputTokens: 24,
    });
  }
  return stream;
}

// --- Measurement -------------------------------------------------------------

function measure(name: string, build: () => Shaped[]): void {
  const shaped = build();

  const rawStream: SimulatedRequest[] = shaped.map((entry) => ({
    atSeconds: entry.atSeconds, prompt: wirePrompt(entry.request), outputTokens: entry.outputTokens,
  }));
  const raw = simulateCache(rawStream, ANTHROPIC_NO_CACHE, price.price, { countTokens: approximateTokenCount });

  let tokensBefore = 0;
  let tokensAfter = 0;
  const levers = new Map<string, number>();
  const reducedStream: SimulatedRequest[] = shaped.map((entry) => {
    const { request, summary } = reduceRequest(entry.request, { ...LOSSLESS, cacheTtl: "5m" });
    tokensBefore += summary.estimatedTokensBefore;
    tokensAfter += summary.estimatedTokensAfter;
    for (const change of summary.changes) levers.set(change.lever, (levers.get(change.lever) ?? 0) + 1);
    return { atSeconds: entry.atSeconds, prompt: wirePrompt(request as AnyObject), outputTokens: entry.outputTokens };
  });
  const reduced = simulateCache(reducedStream, ANTHROPIC_CACHE_5M, price.price, { countTokens: approximateTokenCount });

  const tokenPct = tokensBefore > 0 ? ((tokensBefore - tokensAfter) / tokensBefore) * 100 : 0;
  const costPct = ((raw.totalCostUsd - reduced.totalCostUsd) / raw.totalCostUsd) * 100;
  const leverList = [...levers.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => `${id}×${count}`).join(", ");

  console.log(`${name.padEnd(22)} ${String(shaped.length).padStart(3)} req  tokens −${tokenPct.toFixed(1).padStart(5)}%  cost −${costPct.toFixed(1).padStart(5)}%  (raw $${raw.totalCostUsd.toFixed(4)} → $${reduced.totalCostUsd.toFixed(4)}, hits ${(reduced.hitRate * 100).toFixed(0)}%)`);
  console.log(`${"".padEnd(22)} levers: ${leverList}`);
  if (reduced.totalCostUsd >= raw.totalCostUsd) {
    console.log(`${"".padEnd(22)} WARNING: no net saving on this shape — a finding, not a failure; investigate before publishing.`);
    process.exitCode = 1;
  }
}

console.log("FLUX workload matrix — lossless levers + 5m cache stamp vs unreduced/unstamped baseline");
console.log(`simulator-measured at catalogued claude-sonnet-5-5 prices (${AT}); no lossy levers; quality unchanged by construction\n`);
measure("multi-agent team", multiAgentTeam);
measure("autonomous agent", autonomousAgent);
measure("memory agent", memoryAgent);
measure("rag pipeline", ragPipeline);
measure("batch classification", batchClassification);
console.log("\nEvery row must save or the run exits non-zero: a shape FLUX cannot reduce is a finding to fix, not to hide.");
