import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  priceServerToolUsage,
  publishedModelPrices,
  publishedServerToolFees,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
  type TokenPrice,
} from "../packages/core/src/index.js";
import { meterServerToolHygiene } from "../packages/sdk-js/src/server-tool-hygiene.js";

/**
 * R&D round 3, team lever "server-tool-ledger-and-hygiene" (autonomous
 * vertical: research agents, Managed-Agents-style loops).
 *
 *   node --import tsx evals/run-team-server-tool-ledger-and-hygiene.ts
 *
 * Two questions, kept apart because they have different bases:
 *
 *  1. LEDGER HONESTY (lossless, bills nothing). Anthropic bills web search at
 *     "$10 USD per 1,000 searches, plus standard token costs" (web-search-tool
 *     page, fetched 2026-11-01). Before this round FLUX's ledger read token
 *     usage only, so that fee vanished from the customer-recomputable record.
 *     The fix records it, attributed to the customer. FLUX saves nothing and
 *     bills nothing on it: netSavingPct for the audit is 0 by construction.
 *
 *  2. ACCUMULATION (what the advise-only meter points at). Server-tool result
 *     blocks must be sent back verbatim every later turn ("Web search results
 *     retrieved throughout a conversation are counted as input tokens, in
 *     search iterations run during a single turn and in subsequent
 *     conversation turns"). We price how much of a 12-turn research loop that
 *     re-bill is, unstamped and stamped (5m cache, reads at 0.1x), and two
 *     LOSSY remedies FLUX only ADVISES (never applies):
 *       - cap: web_fetch max_content_tokens = 8000 (truncation; lossy)
 *       - dyn: dynamic filtering, results 24% smaller (literature-claim, blog
 *         2026-02-17: "24% fewer input tokens" averaged over two benchmarks)
 *         with a +X% output band on the search turns for the filtering code
 *         the model writes (X is NOT published: reasoned sensitivity band).
 *
 * FIXTURE (synthetic; every size labelled):
 *   - system + tool definitions: 3,000 tokens (reasoned: a research agent's
 *     instructions plus web_search/web_fetch/client tool schemas).
 *   - 12 turns, 45 s apart (reasoned: autonomous loop, well inside the 5 min TTL).
 *   - user/tool-feedback message per turn: 200 tokens; assistant output per
 *     turn: 700 tokens (reasoned).
 *   - result block of S tokens at turns 2 and 5, S in {2,500; 8,000; 25,000}.
 *     2,500 and 25,000 are the web-fetch page's own "Average webpage (10 kB):
 *     ~2,500 tokens" and "Large documentation page (100 kB): ~25,000 tokens";
 *     8,000 is the in-between case and the cap value.
 *   - a result is input on the turn it arrives (in-turn search iteration) and
 *     on every later turn (resent verbatim), as the page documents.
 *   - searches per search turn: 3 (page: "Simple factual queries typically use
 *     1-3 searches; comparative or multientity research can use 10 or more"),
 *     with 10 as the heavy case.
 *
 * Token counts are exact by construction: each filler word is one token under
 * FLUX's approximateTokenCount, so the simulator prices exactly the sizes above.
 */

const AT = "2026-10-28";
const TURNS = 12;
const GAP_SECONDS = 45;
const SYSTEM_TOKENS = 3_000;
const USER_TOKENS = 200;
const OUTPUT_TOKENS = 700;
const RESULT_TURNS = new Set([2, 5]);
const RESULT_SIZES = [2_500, 8_000, 25_000];
const CAP = 8_000;
const DYN_REDUCTION = 0.24;
const OUTPUT_BAND = [0, 0.5, 1, 2];

function words(count: number, tag: string): string {
  // "<tag>" then count-1 one-token words; each is <= 4 chars so counts as 1 token.
  const out = [tag];
  for (let index = 1; index < count; index += 1) out.push((index % 1_296).toString(36));
  return out.join(" ");
}

type Arm = { resultTokens: (size: number) => number; searchTurnOutputFactor: number };

function conversation(size: number, arm: Arm): SimulatedRequest[] {
  const requests: SimulatedRequest[] = [];
  let history = words(SYSTEM_TOKENS, "sys");
  for (let turn = 1; turn <= TURNS; turn += 1) {
    history += " " + words(USER_TOKENS, `u${turn}`);
    if (RESULT_TURNS.has(turn) && size > 0) history += " " + words(arm.resultTokens(size), `r${turn}`);
    const output = RESULT_TURNS.has(turn) ? Math.round(OUTPUT_TOKENS * arm.searchTurnOutputFactor) : OUTPUT_TOKENS;
    requests.push({ atSeconds: (turn - 1) * GAP_SECONDS, prompt: history, outputTokens: output });
    history += " " + words(output, `a${turn}`);
  }
  return requests;
}

function priceFor(model: string): TokenPrice {
  const lookup = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: AT });
  if (lookup.status !== "priced") throw new Error(`${model} unpriced: ${lookup.reason}`);
  return lookup.price;
}

const asIs: Arm = { resultTokens: (size) => size, searchTurnOutputFactor: 1 };
const capped: Arm = { resultTokens: (size) => Math.min(size, CAP), searchTurnOutputFactor: 1 };
const dyn = (band: number): Arm => ({
  resultTokens: (size) => Math.round(size * (1 - DYN_REDUCTION)),
  searchTurnOutputFactor: 1 + band,
});

function cost(size: number, arm: Arm, policy: CachePolicy, price: TokenPrice): number {
  return simulateCache(conversation(size, arm), policy, price, { countTokens: approximateTokenCount }).totalCostUsd;
}

const usd = (value: number) => `$${value.toFixed(4)}`;
const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

// Sanity: the fixture's token counts are what the header says.
{
  const check = conversation(8_000, asIs);
  const last = approximateTokenCount(check[TURNS - 1]!.prompt);
  const expected = SYSTEM_TOKENS + TURNS * USER_TOKENS + 2 * 8_000 + (TURNS - 1) * OUTPUT_TOKENS;
  if (last !== expected) throw new Error(`fixture token count ${last} != ${expected}`);
}

console.log("FLUX R&D r3 - server-tool ledger completeness + accumulation meter");
console.log(`rates: catalogued anthropic Sonnet 5.5 / Opus 5.5 on ${AT}; cache policies ANTHROPIC_NO_CACHE (unstamped) and ANTHROPIC_CACHE_5M (stamped)`);
console.log("");

type Row = Record<string, string>;
const summary: Array<{ model: string; size: number; stamped: boolean; base: number; resultCost: number; cap: number; dynBreakEvenBand?: number; dyn: number[] }> = [];

for (const model of ["Sonnet 5.5", "Opus 5.5"]) {
  const price = priceFor(model);
  const rows: Row[] = [];
  for (const size of RESULT_SIZES) {
    for (const [label, policy] of [["unstamped", ANTHROPIC_NO_CACHE], ["stamped-5m", ANTHROPIC_CACHE_5M]] as const) {
      const base = cost(size, asIs, policy, price);
      const noResults = cost(0, asIs, policy, price);
      const resultCost = base - noResults;
      const cap = cost(size, capped, policy, price);
      const dynCosts = OUTPUT_BAND.map((band) => cost(size, dyn(band), policy, price));
      // Break-even output band (bisection on the monotone cost curve).
      let lo = 0;
      let hi = 20;
      if (cost(size, dyn(hi), policy, price) < base) lo = hi;
      else {
        for (let iteration = 0; iteration < 40; iteration += 1) {
          const mid = (lo + hi) / 2;
          if (cost(size, dyn(mid), policy, price) < base) lo = mid; else hi = mid;
        }
      }
      summary.push({ model, size, stamped: label !== "unstamped", base, resultCost, cap, dyn: dynCosts, dynBreakEvenBand: lo });
      rows.push({
        S: String(size),
        cache: label,
        bill: usd(base),
        "result re-bill": `${usd(resultCost)} (${pct(resultCost / base)})`,
        "cap8k (lossy)": `${pct((base - cap) / base)}`,
        ...Object.fromEntries(OUTPUT_BAND.map((band, index) => [`dyn24 +${band * 100}%out`, pct((base - dynCosts[index]!) / base)])),
        "dyn break-even +out": `${(lo * 100).toFixed(0)}%`,
      });
    }
  }
  console.log(`== ${model} (12-turn research loop; savings are % of that arm's as-is bill) ==`);
  console.table(rows);
}

console.log("");
console.log("== Caching vs the 're-billed every turn' cost (derived from the rows above) ==");
const cacheRows: Row[] = [];
for (const model of ["Sonnet 5.5", "Opus 5.5"]) {
  for (const size of RESULT_SIZES) {
    const unstamped = summary.find((row) => row.model === model && row.size === size && !row.stamped)!;
    const stamped = summary.find((row) => row.model === model && row.size === size && row.stamped)!;
    cacheRows.push({
      model,
      S: String(size),
      "re-bill unstamped": usd(unstamped.resultCost),
      "re-bill stamped": usd(stamped.resultCost),
      "removed by cache": pct(1 - stamped.resultCost / unstamped.resultCost),
      "cap8k saving stamped $": usd(stamped.base - stamped.cap),
      "dyn24 +0% saving stamped $": usd(stamped.base - stamped.dyn[0]!),
    });
  }
}
console.table(cacheRows);

console.log("");
console.log("== Ledger understatement: web-search fee the token-only ledger omitted (derived) ==");
const perSearch = priceServerToolUsage(publishedServerToolFees, {
  provider: "anthropic",
  at: AT,
  usage: { webSearchRequests: 1, webFetchRequests: 0, codeExecutionRequests: 0 },
});
console.log(`per search request: ${usd(perSearch.feeUsd ?? 0)} (catalogued from ${publishedServerToolFees.entries[0]!.provenance.source})`);
const ledgerRows: Row[] = [];
for (const searchesPerTurn of [3, 10]) {
  const searches = searchesPerTurn * RESULT_TURNS.size;
  const fee = priceServerToolUsage(publishedServerToolFees, {
    provider: "anthropic",
    at: AT,
    usage: { webSearchRequests: searches, webFetchRequests: 0, codeExecutionRequests: 0 },
  }).feeUsd ?? 0;
  for (const row of summary.filter((entry) => entry.size === 8_000)) {
    ledgerRows.push({
      model: row.model,
      cache: row.stamped ? "stamped-5m" : "unstamped",
      searches: String(searches),
      "fee omitted": usd(fee),
      "token bill (S=8000)": usd(row.base),
      "understated by": pct(fee / (row.base + fee)),
    });
  }
}
console.table(ledgerRows);

console.log("");
console.log("== Meter on the final turn (lossless: request bytes compared before/after) ==");
const filler = (count: number, tag: string) => words(count, tag);
const finalRequest = {
  model: "claude-sonnet-5-5-20260514",
  max_tokens: 4_096,
  system: filler(SYSTEM_TOKENS, "sys"),
  tools: [
    { type: "web_search_20250305", name: "web_search" },
    { type: "web_fetch_20250910", name: "web_fetch" },
  ],
  messages: [
    { role: "user", content: filler(USER_TOKENS, "u1") },
    { role: "assistant", content: [{ type: "text", text: filler(OUTPUT_TOKENS, "a1") }] },
    { role: "user", content: filler(USER_TOKENS, "u2") },
    {
      role: "assistant",
      content: [
        { type: "server_tool_use", id: "srvtoolu_2", name: "web_fetch", input: { url: "https://example.com/docs" } },
        {
          type: "web_fetch_tool_result",
          tool_use_id: "srvtoolu_2",
          content: {
            type: "web_fetch_result",
            url: "https://example.com/docs",
            content: { type: "document", source: { type: "text", media_type: "text/plain", data: filler(25_000, "r2") } },
          },
        },
        { type: "text", text: filler(OUTPUT_TOKENS, "a2") },
      ],
    },
    { role: "user", content: filler(USER_TOKENS, "u3") },
  ],
};
const before = JSON.stringify(finalRequest);
const report = meterServerToolHygiene(finalRequest);
const after = JSON.stringify(finalRequest);
console.log(`bytes identical: ${before === after} (${before.length} bytes)`);
console.log(`server-tool result share (local estimate): ${pct(report.serverToolResultShare)}; pinned: ${report.pinnedVersions.join(", ")}; code execution: ${report.codeExecutionEnabled}`);
console.log(`advice: ${report.advice.map((line) => line.code).join(", ")}`);
const opusReport = meterServerToolHygiene({ ...finalRequest, model: "claude-opus-5-5" });
console.log(`advice on the same request routed to Opus: ${opusReport.advice.map((line) => line.code).join(", ")}`);

console.log("");
console.log("netSavingPct (audit/meter, billed by FLUX): 0 - the ledger half records customer spend, the meter half only advises.");
