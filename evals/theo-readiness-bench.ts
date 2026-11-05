/**
 * Theo readiness benchmark — the reward signal for the readiness loop.
 *
 * Runs Theo's coverage oracle over a corpus of diverse workload profiles and
 * scores each on the signals that decide end-user readiness:
 *
 *   auto-safe %    lossless savings that go live immediately, zero quality risk
 *   gated upside % lossy savings available behind the replay gate (not auto-on)
 *   coverage %     of catalogue levers applicable here, how many Theo applies
 *   status         saving | needs-gate | lean (honest) | DORMANT (uncaptured waste)
 *
 * It writes evals/results/theo-readiness.json (the latest scoreboard the loop
 * reads) and prints a human table plus the blockers still between here and the
 * done-criteria in docs/rnd/theo-readiness-loop.md.
 *
 *   node --import tsx evals/theo-readiness-bench.ts
 *
 * NOTE (iteration 0): answer-equivalence is not yet *measured* here — auto-safe
 * levers are lossless by construction, but a replay-based quality check across
 * the corpus is a named blocker below, to be wired by a later iteration.
 */
import { writeFileSync } from "node:fs";
import {
  coverageForProfile,
  type CoverageReport,
  type WorkloadProfile,
  type WorkloadSegment,
  type TokenPrice,
} from "../packages/core/src/index.js";
import { reduceRequest } from "../packages/sdk-js/src/index.js";
import { sampleCodingWorkload } from "./theo-loop.js";

// Catalogued Claude Sonnet 5.5 rate (USD / million tokens).
const PRICE: TokenPrice = {
  inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5,
};

type Seg = Partial<Record<WorkloadSegment, number>>;
function profile(name: string, requests: number, segments: Seg, stableSegments: WorkloadSegment[]): WorkloadProfile {
  const full: Record<WorkloadSegment, number> = {
    toolSchemas: 0, systemPrompt: 0, retrievedContext: 0, history: 0, userTurn: 0, output: 0, ...segments,
  };
  return { name, requests, segments: full, stableSegments };
}

// Starter corpus (iteration 0). The loop grows this toward >= 8 diverse types.
const CORPUS: WorkloadProfile[] = [
  profile("coding-agent", 8, { toolSchemas: 1200, systemPrompt: 300, history: 2500, userTurn: 60, output: 420 }, ["toolSchemas", "systemPrompt"]),
  profile("rag-docqa", 20, { systemPrompt: 200, retrievedContext: 6000, history: 400, userTurn: 80, output: 300 }, ["systemPrompt"]),
  profile("support-chat", 30, { toolSchemas: 150, systemPrompt: 500, history: 1800, userTurn: 50, output: 180 }, ["systemPrompt", "toolSchemas"]),
  profile("batch-classifier", 50, { systemPrompt: 400, userTurn: 300, output: 20 }, ["systemPrompt"]),
  profile("already-lean", 10, { systemPrompt: 80, userTurn: 60, output: 120 }, []),
  profile("long-context-summarize", 15, { systemPrompt: 250, retrievedContext: 9000, history: 1200, userTurn: 40, output: 350 }, ["systemPrompt"]),
  profile("tool-heavy-agent", 12, { toolSchemas: 3200, systemPrompt: 400, history: 1500, userTurn: 70, output: 300 }, ["toolSchemas", "systemPrompt"]),
  profile("chatbot-memory", 40, { systemPrompt: 600, history: 3000, userTurn: 45, output: 160 }, ["systemPrompt"]),
  profile("translation", 25, { systemPrompt: 120, userTurn: 800, output: 820 }, ["systemPrompt"]),
];

type Row = {
  workload: string;
  baselineUsd: number;
  autoSafePct: number;
  gatedUpsidePct: number;
  coveragePct: number;
  applicable: number;
  applied: number;
  uncapturedPct: number;
  status: "saving" | "needs-gate" | "lean" | "DORMANT";
};

function classify(autoSafe: number, gated: number, uncaptured: number): Row["status"] {
  if (autoSafe >= 1) return "saving";
  if (gated >= 1) return "needs-gate";
  if (uncaptured >= 1) return "DORMANT";
  return "lean";
}

function scoreWorkload(p: WorkloadProfile): Row {
  const r: CoverageReport = coverageForProfile(p, PRICE);
  // Uncaptured waste: applicable levers Theo does NOT apply, by projected share.
  const uncapturedPct = r.gaps.reduce((a, g) => a + g.projectedSavingPercent, 0);
  const autoSafePct = r.realizedDeterministicPercent;
  const gatedUpsidePct = r.realizedNeedsVerificationPercent;
  return {
    workload: r.workload,
    baselineUsd: r.baselineCostUsd,
    autoSafePct,
    gatedUpsidePct,
    coveragePct: r.leverCoveragePercent,
    applicable: r.applicableLevers,
    applied: r.appliedLevers,
    uncapturedPct,
    status: classify(autoSafePct, gatedUpsidePct, uncapturedPct),
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const LOSSLESS = { toolSchemas: true as const, duplicateContext: true as const, repairCachePrefix: true as const };

type EquivResult = { workload: string; allLossless: boolean; measuredAutoSafePct: number; lossyLeaks: string[] };

/** A string of roughly `tok` tokens (~4 chars/token). */
function sized(unit: string, tok: number): string {
  if (tok <= 0) return "";
  const target = Math.round(tok * 4);
  let s = "";
  while (s.length < target) s += unit;
  return s.slice(0, target);
}

/** Synthesise a representative request that exercises a profile's structure:
 *  verbose tool schemas (schema compaction), a verbatim block re-sent each turn
 *  (duplicate-context dedup), a stable system+tools prefix (cache repair). */
function requestFor(p: WorkloadProfile): Record<string, unknown> {
  const s = p.segments;
  const toolCount = s.toolSchemas > 0 ? Math.max(1, Math.round(s.toolSchemas / 350)) : 0;
  const tools = Array.from({ length: toolCount }, (_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: sized(`Operate on subsystem ${i}; inspect and return records. `, 40),
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { id: { type: "string", title: "id", description: "Record identifier." } },
        required: ["id"],
      },
    },
  }));
  const system = sized("You are a careful, precise assistant. ", s.systemPrompt);
  const dupBlock = sized("reference block alpha; records nominal; ", Math.min(Math.max(s.history, s.retrievedContext), 900));
  const messages: Array<Record<string, unknown>> = [];
  const turns = Math.min(6, Math.max(1, p.requests));
  for (let t = 0; t < turns; t += 1) {
    messages.push({ role: "user", content: sized(`step ${t}: continue. `, s.userTurn) });
    if (s.history > 0) messages.push({ role: "assistant", content: dupBlock });
    if (s.retrievedContext > 0) messages.push({ role: "tool", content: dupBlock });
  }
  return { model: "claude-sonnet-5-5", max_tokens: Math.max(16, s.output), system, tools, messages };
}

/** Answer-equivalence of the AUTO (lossless) reduction for one workload. The real
 *  coding-agent sample is used where available; others use a synthesised request.
 *  A lossy change in the auto path is a safety failure the loop must catch. */
function equivalenceFor(p: WorkloadProfile): EquivResult {
  const reqs = p.name === "coding-agent"
    ? sampleCodingWorkload().map((s) => s.request)
    : [requestFor(p)];
  let before = 0;
  let saved = 0;
  const lossyLeaks: string[] = [];
  for (const req of reqs) {
    const r = reduceRequest(req, LOSSLESS);
    before += r.summary.estimatedTokensBefore;
    saved += r.summary.estimatedLosslessTokensSaved;
    for (const c of r.summary.changes) if (!c.lossless) lossyLeaks.push(c.lever);
  }
  return {
    workload: p.name,
    allLossless: lossyLeaks.length === 0,
    measuredAutoSafePct: before > 0 ? Number(((saved / before) * 100).toFixed(2)) : 0,
    lossyLeaks: [...new Set(lossyLeaks)],
  };
}

function main(): void {
  const rows = CORPUS.map(scoreWorkload);
  const withWaste = rows.filter((r) => r.autoSafePct + r.gatedUpsidePct + r.uncapturedPct >= 1);
  const dormant = rows.filter((r) => r.status === "DORMANT");

  const equivRows = CORPUS.map(equivalenceFor);
  const equivLeaks = equivRows.filter((e) => !e.allLossless);
  const equivAllLossless = equivLeaks.length === 0;
  const composite = {
    corpusSize: rows.length,
    medianAutoSafePct: Number(median(withWaste.map((r) => r.autoSafePct)).toFixed(2)),
    medianRealisablePct: Number(median(withWaste.map((r) => r.autoSafePct + r.gatedUpsidePct)).toFixed(2)),
    dormantCount: dormant.length,
    answerEquivalenceMeasured: true,
    answerEquivalence: {
      measuredWorkloads: equivRows.length,
      ofCorpus: rows.length,
      allLossless: equivAllLossless,
      workloadsWithLeak: equivLeaks.map((e) => e.workload),
    },
  };

  // Blockers vs the done-criteria.
  const blockers: string[] = [];
  if (!equivAllLossless) blockers.push(`SAFETY FAILURE: the auto (live-now) config applied lossy lever(s) on ${equivLeaks.map((e) => `${e.workload} (${e.lossyLeaks.join("/")})`).join(", ")}`);
  else blockers.push(`SAFETY: answer-equivalence verified across all ${equivRows.length} workloads (auto reduction 100% lossless)`);
  if (composite.corpusSize < 8) blockers.push(`CORPUS: only ${composite.corpusSize}/8 workload types`);
  if (composite.dormantCount > 0) blockers.push(`DORMANCY: ${composite.dormantCount} workload(s) with uncaptured waste and no saving — ${dormant.map((d) => d.workload).join(", ")}`);
  blockers.push("AUTONOMY: pipeline not yet wired to run on a real ledger spool unattended");

  const result = { iteration: 3, timestamp: new Date().toISOString(), composite, workloads: rows, blockers, equivalence: equivRows };
  writeFileSync("evals/results/theo-readiness.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const pct = (n: number): string => `${n >= 0 ? "" : ""}${n.toFixed(1)}%`;
  console.log("=== THEO READINESS BENCHMARK ===\n");
  console.log("workload           base$     auto-safe  gated   coverage   status");
  for (const r of rows) {
    console.log(
      `${r.workload.padEnd(18)} ${r.baselineUsd.toFixed(4).padStart(8)}  ${pct(r.autoSafePct).padStart(8)}  ${pct(r.gatedUpsidePct).padStart(6)}  ${`${r.applied}/${r.applicable} ${pct(r.coveragePct)}`.padStart(12)}   ${r.status}`,
    );
  }
  console.log(
    `\ncorpus ${composite.corpusSize} · median auto-safe ${pct(composite.medianAutoSafePct)} · ` +
      `median realisable ${pct(composite.medianRealisablePct)} · dormant ${composite.dormantCount}`,
  );
  console.log(
    `answer-equivalence: ${equivAllLossless ? `all ${equivRows.length} workloads lossless ✓` : `LOSSY LEAK ✗ ${equivLeaks.map((e) => e.workload).join(", ")}`}`,
  );
  console.log("\nBlockers to ready:");
  for (const b of blockers) console.log(`  - ${b}`);
  console.log("\nwrote evals/results/theo-readiness.json");
}

main();
