import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Helicone and Langfuse exports in their native schemas, with traps planted
 * where each tool's strengths and blind spots are.
 *
 * helicone-requests.jsonl
 *   support-bot: 60 rows whose provider cache is already doing the work
 *     (prompt_cache_read_tokens is 75% of input). The verdict must be
 *     already-optimised, reached from the provider's own numbers.
 *   mobile-app: the consumer shape - 40 end users at 3 requests each via
 *     request_user_id and Helicone-Session-Id, request bodies included -
 *     plus 15 rows served by Helicone's own cache (Helicone-Cache: HIT)
 *     that must never enter the baseline.
 *
 * langfuse-generations.jsonl
 *   checkout-agent: 10 sessions of 5 generations with no input captured,
 *     which is Langfuse's common default. Usage-only analysis must still
 *     classify it as an in-house agent. Eight rows carry a calculated cost
 *     0.6x the published rate - a stale model price - for reconciliation to
 *     flag. SPAN rows are interleaved and must be skipped, not errored.
 */

const out = resolve(process.argv[2] ?? "sample-traffic");
const AT = "2026-10-08";

const TEMPLATE = [
  "You are the in-app helper for the Acme mobile app. Keep answers under three sentences.",
  ...Array.from({ length: 45 }, (_, index) =>
    `Rule ${index}: never promise roadmap dates, never discuss other customers, and route anything about ` +
    "payments or deletion to a human."),
].join("\n\n");

type Row = Record<string, unknown>;
const helicone: Row[] = [];

// support-bot: provider cache already doing the work.
for (let index = 0; index < 60; index += 1) {
  const fresh = 1_500;
  const cached = 4_500;
  const output = 350 + (index % 5) * 40;
  helicone.push({
    request_id: `support-${index}`,
    request_created_at: `${AT}T${String(8 + (index % 9)).padStart(2, "0")}:1${index % 6}:00Z`,
    model: "gpt-5",
    provider: "OPENAI",
    prompt_tokens: fresh,
    prompt_cache_read_tokens: cached,
    completion_tokens: output,
    cost: (fresh / 1e6) * 1.25 + (cached / 1e6) * 0.125 + (output / 1e6) * 10,
    properties: { workload: "support-bot" },
  });
}

// mobile-app: consumer fan-out with sessions, users and stored bodies.
for (let user = 0; user < 40; user += 1) {
  for (let turn = 0; turn < 3; turn += 1) {
    const input = 2_400 + turn * 150;
    const output = 180 + (user % 7) * 25;
    helicone.push({
      request_id: `mobile-${user}-${turn}`,
      request_created_at: `${AT}T${String(9 + (user % 8)).padStart(2, "0")}:0${turn}:00Z`,
      model: "gpt-5",
      provider: "OPENAI",
      prompt_tokens: input,
      completion_tokens: output,
      cost: (input / 1e6) * 1.25 + (output / 1e6) * 10,
      request_user_id: `user-${user}`,
      properties: { "Helicone-Session-Id": `sess-${user}`, workload: "mobile-app" },
      request_body: {
        model: "gpt-5",
        messages: [
          { role: "system", content: TEMPLATE },
          { role: "user", content: `User ${user}, turn ${turn}: why did my sync fail?` },
        ],
      },
    });
  }
}
// Helicone's own cache serving repeats: not baseline.
for (let index = 0; index < 15; index += 1) {
  helicone.push({
    request_id: `mobile-cachehit-${index}`,
    request_created_at: `${AT}T12:0${index % 6}:00Z`,
    model: "gpt-5",
    provider: "OPENAI",
    prompt_tokens: 2_400,
    completion_tokens: 200,
    cost: 0,
    request_user_id: `user-${index}`,
    properties: { "Helicone-Cache": "HIT", workload: "mobile-app" },
  });
}

const langfuse: Row[] = [];
for (let task = 0; task < 10; task += 1) {
  // A span per task, which the adapter must skip rather than report.
  langfuse.push({ id: `span-${task}`, type: "SPAN", traceId: `trace-${task}`, name: "checkout-agent" });
  for (let turn = 0; turn < 5; turn += 1) {
    const input = 12_000 + turn * 2_000;
    const output = turn === 4 ? 2_000 : 600;
    const catalogueCost = (input / 1e6) * 2 + (output / 1e6) * 10;
    const stale = task < 4 && turn < 2; // 8 rows priced from a stale model table.
    langfuse.push({
      id: `gen-${task}-${turn}`,
      type: "GENERATION",
      traceId: `trace-${task}`,
      sessionId: `session-${task}`,
      traceName: "checkout-agent",
      startTime: `${AT}T${String(10 + (task % 6)).padStart(2, "0")}:${String(turn * 2).padStart(2, "0")}:00Z`,
      model: "claude-sonnet-5-5-20260514",
      usageDetails: { input, output, total: input + output },
      calculatedTotalCost: stale ? catalogueCost * 0.6 : catalogueCost,
    });
  }
}

for (const [name, rows] of [
  ["helicone-requests.jsonl", helicone],
  ["langfuse-generations.jsonl", langfuse],
] as const) {
  const path = resolve(out, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(`${path}: ${rows.length} rows`);
}
