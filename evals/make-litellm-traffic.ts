import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * A LiteLLM spend-log export containing all three horizontal customer shapes,
 * in the schema the proxy actually logs (request_id, prompt_tokens,
 * completion_tokens, spend, cache_hit as the string "True"/"False", end_user,
 * team_id, request_tags, litellm_session_id, optional stored messages).
 *
 * The three streams, and the traps planted in them:
 *
 *   consumer-chat: 50 end users at ~3 requests each, prompts stored, every
 *     prompt sharing one big template. The consumer shape: wide fan-out,
 *     shallow sessions.
 *
 *   saas-docqa: server-templated one-shot traffic for five tenant teams, with
 *     a per-request timestamp INSIDE the template (the classic cache breaker),
 *     a slice of rows answered by LiteLLM's own cache (spend ~0, cache_hit
 *     "True") that must never enter the baseline, and a slice whose logged
 *     spend is inflated 1.5x over catalogue rates (a stale pricing map) that
 *     reconciliation must flag.
 *
 *   internal-agent: 12 tasks of 5 turns with litellm_session_id set and no
 *     stored prompts, which is the default (store_prompts_in_spend_logs off).
 *     Usage-only analysis must still classify and quote it.
 */

const out = resolve(process.argv[2] ?? "sample-traffic");
const AT = "2026-10-08";

const TEMPLATE = [
  "You are the in-app assistant for Acme Notes. Answer briefly and never invent features.",
  ...Array.from({ length: 50 }, (_, index) =>
    `Guideline ${index}: prefer linking to the help centre over restating it, never mention internal tooling, ` +
    "and hand off to support when the user sounds frustrated or mentions billing."),
].join("\n\n");

const DOC_TEMPLATE = [
  "Answer strictly from the provided document excerpts. Cite the excerpt number for every claim.",
  ...Array.from({ length: 40 }, (_, index) =>
    `Policy ${index}: if the excerpts do not contain the answer say so plainly, quote at most two sentences ` +
    "verbatim, and keep the answer under two hundred words."),
].join("\n\n");

type Row = Record<string, unknown>;
const rows: Row[] = [];

// 1. consumer-chat: 50 end users, 3 requests each, prompts stored.
for (let user = 0; user < 50; user += 1) {
  for (let turn = 0; turn < 3; turn += 1) {
    const promptTokens = 2_600 + turn * 180;
    const completionTokens = 220 + (user % 6) * 30;
    rows.push({
      request_id: `consumer-${user}-${turn}`,
      call_type: "acompletion",
      model: "gpt-5",
      model_group: "gpt-5",
      custom_llm_provider: "openai",
      startTime: `${AT}T${String(9 + (user % 8)).padStart(2, "0")}:0${turn}:00Z`,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      // Exact catalogue rates: only the deliberately inflated saas rows drift.
      spend: (promptTokens / 1e6) * 1.25 + (completionTokens / 1e6) * 10,
      cache_hit: "False",
      end_user: `eu-${user}`,
      request_tags: ["consumer-chat"],
      litellm_session_id: `chat-${user}`,
      messages: [
        { role: "system", content: TEMPLATE },
        { role: "user", content: `User ${user}, turn ${turn}: how do I share a note with my team?` },
      ],
    });
  }
}

// 2. saas-docqa: 100 provider calls + 20 gateway cache hits; 10 drift rows.
for (let index = 0; index < 100; index += 1) {
  const inflated = index < 10;
  const promptTokens = 5_200 + (index % 9) * 60;
  const completionTokens = 420 + (index % 7) * 45;
  // gpt-5 published rates: $1.25/M in, $10/M out.
  const catalogueCost = (promptTokens / 1e6) * 1.25 + (completionTokens / 1e6) * 10;
  rows.push({
    request_id: `saas-${index}`,
    call_type: "acompletion",
    model: "gpt-5",
    model_group: "gpt-5",
    custom_llm_provider: "openai",
    startTime: `${AT}T${String(8 + (index % 10)).padStart(2, "0")}:1${index % 6}:00Z`,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    spend: inflated ? catalogueCost * 1.5 : catalogueCost,
    cache_hit: "False",
    team_id: `tenant-${index % 5}`,
    request_tags: ["saas-docqa"],
    messages: [
      {
        role: "system",
        // The planted breaker: a per-request clock at the top of the template.
        content: `Request time: ${AT}T${String(8 + (index % 10)).padStart(2, "0")}:1${index % 6}:00Z\n${DOC_TEMPLATE}`,
      },
      { role: "user", content: `Excerpts for case ${index}. Question: what does clause ${index % 14} require?` },
    ],
  });
}
for (let index = 0; index < 20; index += 1) {
  rows.push({
    request_id: `saas-cachehit-${index}`,
    call_type: "acompletion",
    model: "gpt-5",
    model_group: "gpt-5",
    custom_llm_provider: "openai",
    startTime: `${AT}T12:0${index % 6}:00Z`,
    prompt_tokens: 5_200,
    completion_tokens: 430,
    spend: 0,
    cache_hit: "True",
    team_id: `tenant-${index % 5}`,
    request_tags: ["saas-docqa"],
  });
}

// 3. internal-agent: 12 tasks x 5 turns, sessions set, no prompts stored.
for (let task = 0; task < 12; task += 1) {
  for (let turn = 0; turn < 5; turn += 1) {
    rows.push({
      request_id: `agent-${task}-${turn}`,
      call_type: "acompletion",
      model: "claude-sonnet-5-5-20260514",
      model_group: "sonnet",
      custom_llm_provider: "anthropic",
      startTime: `${AT}T${String(10 + (task % 6)).padStart(2, "0")}:${String(turn * 2).padStart(2, "0")}:00Z`,
      prompt_tokens: 14_000 + turn * 2_400,
      completion_tokens: turn === 4 ? 2_200 : 650,
      spend: ((14_000 + turn * 2_400) / 1e6) * 2 + ((turn === 4 ? 2_200 : 650) / 1e6) * 10,
      cache_hit: "False",
      request_tags: ["internal-agent"],
      metadata: { litellm_session_id: `run-${task}` },
    });
  }
}

const path = resolve(out, "litellm-spend.jsonl");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${path}: ${rows.length} rows (consumer 150, saas 100 + 20 cache hits, agent 60)`);
