import { readFileSync } from "node:fs";
import {
  calculateGeoVisibilityByEngine,
  calculateGeoVisibilityMetrics,
  type GeoObservation,
} from "../packages/core/src/index.js";

/**
 * The GEO visibility loop: log one JSONL row per answer-engine check, get the
 * mention/citation/link rates back per engine — the GTM metric that tells you
 * whether the content is landing.
 *
 *   node --import tsx evals/run-geo-visibility.ts [observations.jsonl]
 *
 * Row shape (see GeoObservation): {"engine":"perplexity","promptId":"cut-claude-costs",
 *  "timestamp":"2026-10-20T09:00:00Z","mentioned":true,"cited":true,"linked":false,
 *  "correctDescription":true,"categoryAssociated":true,"competitorMentions":["litellm"]}
 *
 * Observations are logged by a human (or a future automation with engine
 * access) asking each engine the money questions: "how do I cut my Claude API
 * costs", "LLM cost reduction tools", "is there a tool that verifies LLM
 * savings", and recording what came back.
 */
const path = process.argv[2] ?? "evals/geo-observations.jsonl";
let rows: GeoObservation[];
try {
  rows = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as GeoObservation);
} catch {
  console.log(`No observations at ${path} yet.`);
  console.log("Log one JSONL row per engine check (shape in this file's header), then re-run.");
  process.exit(0);
}
const overall = calculateGeoVisibilityMetrics(rows);
console.log(`overall: ${rows.length} observations | mentioned ${(overall.mentionRate * 100).toFixed(0)}% | cited ${(overall.citationRate * 100).toFixed(0)}% | linked ${(overall.linkRate * 100).toFixed(0)}%`);
for (const [engine, m] of Object.entries(calculateGeoVisibilityByEngine(rows))) {
  console.log(`${engine.padEnd(14)} obs ${String(m.observations).padStart(3)} | mention ${(m.mentionRate * 100).toFixed(0)}% | cite ${(m.citationRate * 100).toFixed(0)}% | link ${(m.linkRate * 100).toFixed(0)}%`);
}
