import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFlux, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../packages/core/src/index.js";

/**
 * Five simple agents, each wrapped in FLUX with the savings ledger on, run to
 * produce a REAL export: a hash-chained ledger spool and the invoice FLUX would
 * bill for each one.
 *
 * The honesty line this harness holds: real savings need real API calls, which
 * need a real key. Set OPENAI_API_KEY and these agents hit the live Responses
 * API, and the printed invoice is a measurement of real traffic — the export
 * the whole project has been waiting for. With no key they run against a
 * deterministic LOCAL model so the FLUX request path, ledger, and invoice are
 * exercised end to end; those numbers are labelled LOCAL-STUB and are a
 * pipeline check, not a savings claim.
 *
 * The five agents are the segments the matrix quotes, so a live run maps
 * one-to-one onto the website's per-segment bands.
 */

const LIVE = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;
const MODEL = process.env.FLUX_LIVE_MODEL ?? "gpt-5";
const ROOT = mkdtempSync(join(tmpdir(), "flux-live-"));

type AnyObject = Record<string, unknown>;

/** A client exposing responses.create — real HTTP when keyed, else local. */
function makeClient(): { responses: { create: (req: AnyObject) => Promise<AnyObject> } } {
  if (!LIVE) {
    // Deterministic local model: answers briefly, reports usage proportional to
    // the request it was actually sent, so reductions show up in the ledger.
    return {
      responses: {
        create: async (req: AnyObject) => {
          const text = `${JSON.stringify(req.instructions ?? "")}${JSON.stringify(req.input ?? req.messages ?? "")}` +
            JSON.stringify(req.tools ?? "");
          const inputTokens = Math.ceil(text.length / 4);
          const cap = typeof req.max_output_tokens === "number" ? req.max_output_tokens : 600;
          const outputTokens = Math.min(cap, 400);
          return {
            id: `local-${Math.abs(hash(text))}`,
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              input_tokens_details: { cached_tokens: 0 },
            },
            ...(typeof req.service_tier === "string" ? { service_tier: req.service_tier } : {}),
          };
        },
      },
    };
  }
  return {
    responses: {
      create: async (req: AnyObject) => {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as AnyObject;
      },
    },
  };
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h;
}

type Agent = {
  name: string;
  segment: string;
  reduction: FluxTokenReductionConfig;
  /** Build the request list this agent would make. */
  requests: () => AnyObject[];
};

const PREAMBLE = [
  "You are a careful assistant. Follow instructions precisely and never invent facts.",
  ...Array.from({ length: 30 }, (_, i) => `Operating rule ${i}: cite sources, escalate anything risky, keep answers tight.`),
].join("\n\n");

const TOOLS = Array.from({ length: 12 }, (_, i) => ({
  type: "function",
  function: {
    name: `lookup_${i}`,
    description: `Look up records in subsystem ${i}. Use this for questions about topic ${i}. Returns a paginated list.`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
}));

const BIG_TOOL_RESULT = Array.from({ length: 20 }, (_, i) =>
  `Record ${i}: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.`).join(" ");

const agents: Agent[] = [
  {
    name: "coding-agent",
    segment: "interactive (busy)",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, historyCompaction: true,
      freshToolResultCap: { maximumTokens: 600 } } as FluxTokenReductionConfig,
    requests: () => Array.from({ length: 5 }, (_, turn) => ({
      model: MODEL,
      instructions: `Current time: 2026-10-13T09:0${turn}:00Z\n${PREAMBLE}`,
      tools: TOOLS,
      input: [
        ...Array.from({ length: turn }, (_, p) => ([
          { role: "user", content: `Step ${p}: inspect account 100${p}.` },
          { role: "assistant", content: BIG_TOOL_RESULT },
        ])).flat(),
        { role: "user", content: "Investigate account 1009 and summarise." },
      ],
      max_output_tokens: 2000,
    })),
  },
  {
    name: "rag-docqa",
    segment: "one-shot templated",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
    // The retriever pastes the same top excerpt under two headings — the
    // classic RAG duplication the duplicate-context lever exists to remove.
    requests: () => Array.from({ length: 6 }, (_, i) => ({
      model: MODEL,
      instructions: `Request time: 2026-10-13T10:1${i}:00Z\n${PREAMBLE}`,
      input: [{ role: "user", content:
        `Excerpts for case ${i}.\n\n${BIG_TOOL_RESULT}\n\n${BIG_TOOL_RESULT}\n\n` +
        `Question: what does clause ${i} require?` }],
    })),
  },
  {
    name: "batch-classifier",
    segment: "async-eligible",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, executionTier: "flex" },
    requests: () => Array.from({ length: 8 }, (_, i) => ({
      model: MODEL,
      instructions: PREAMBLE,
      input: [{ role: "user", content: `Classify ticket ${i}: "my payment failed and I was charged twice".` }],
    })),
  },
  {
    name: "support-chat",
    segment: "consumer",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, maxOutputTokens: 400 },
    // A consumer helpdesk ships its whole verbose tool belt on every turn.
    requests: () => Array.from({ length: 6 }, (_, i) => ({
      model: MODEL,
      instructions: PREAMBLE,
      tools: TOOLS,
      input: [{ role: "user", content: `User ${i}: how do I reset my password?` }],
    })),
  },
  {
    name: "already-lean",
    segment: "already-optimised (expect ~0, do-not-pay-us)",
    // Minimal prompt, no tools, nothing to reduce: the honest zero case.
    reduction: { toolSchemas: true, duplicateContext: true },
    requests: () => Array.from({ length: 5 }, (_, i) => ({
      model: MODEL,
      input: [{ role: "user", content: `Translate "hello ${i}" to French.` }],
    })),
  },
];

function readLedger(path: string): LedgerRecord[] {
  try {
    return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerRecord);
  } catch {
    return [];
  }
}

console.log(`=== FLUX live-agent run — mode: ${LIVE ? `LIVE (OpenAI ${MODEL})` : "LOCAL-STUB (no OPENAI_API_KEY)"} ===`);
if (!LIVE) {
  console.log("No key set, so these numbers are a PIPELINE CHECK, not a savings claim.");
  console.log("Set OPENAI_API_KEY to turn this into a real-traffic export.\n");
}

const summary: Array<{ agent: string; segment: string; requests: number; chainOk: boolean; billedUsd: number; verdict: string }> = [];

for (const agent of agents) {
  const ledgerPath = join(ROOT, `${agent.name}.jsonl`);
  const client = withFlux(makeClient() as never, {
    applicationId: agent.name,
    tokenReduction: agent.reduction,
    ledger: { path: ledgerPath, provider: "openai" },
  }) as unknown as { responses: { create: (r: unknown) => Promise<unknown> } };

  const planned = agent.requests();
  process.stdout.write(`${agent.name} (${planned.length} requests): `);
  let ok = 0;
  let failed = 0;
  for (const req of planned) {
    try {
      await client.responses.create(req);
      ok += 1;
      process.stdout.write(".");
    } catch (cause) {
      failed += 1;
      process.stdout.write("x");
      if (failed === 1) process.stdout.write(`\n  ${agent.name}: request error — ${(cause as Error).message}\n  `);
    }
  }
  process.stdout.write(" done\n");

  const records = readLedger(ledgerPath);
  const chain = verifyLedgerChain(records);
  const invoice = recomputeInvoice(records.map((r) => r.event), { feePercent: 15 });
  summary.push({
    agent: agent.name,
    segment: agent.segment,
    requests: ok,
    chainOk: chain.ok,
    billedUsd: invoice.netVerifiedSavingsUsd,
    verdict: invoice.verdict,
  });
}

console.log(`${"agent".padEnd(18)} ${"segment".padEnd(42)} ${"reqs".padStart(5)} ${"chain".padStart(6)} ${"net saved $".padStart(12)} verdict`);
console.log("-".repeat(100));
for (const row of summary) {
  console.log(
    `${row.agent.padEnd(18)} ${row.segment.padEnd(42)} ${String(row.requests).padStart(5)} ` +
    `${(row.chainOk ? "ok" : "BAD").padStart(6)} ${row.billedUsd.toFixed(6).padStart(12)} ${row.verdict}`,
  );
}
console.log(`\nLedger spools written under ${ROOT} (one JSONL per agent).`);
console.log(LIVE
  ? "LIVE run: the net-saved figures above are measured on real OpenAI traffic — this is a real export."
  : "LOCAL-STUB run: the request path, ledger hash-chain and invoice are all exercised; add a key for real numbers.");

if (process.env.FLUX_LIVE_KEEP !== "1") rmSync(ROOT, { recursive: true, force: true });
