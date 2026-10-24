#!/usr/bin/env node
// The zero-key FLUX demo: the ENTIRE loop — proxy, reduction, hash-chained
// ledger, independent recomputation — on your machine in ~10 seconds, with
// no API key, no account, and no network access (the "provider" is a local
// stub). DEMO TRAFFIC: the percentages below describe this synthetic run,
// not a claim about your workload — run the proxy on real traffic for that.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recomputeInvoice, startFluxProxy, verifyLedgerChain } from "../index.js";

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const inputTokens = Math.ceil(body.length / 4);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_demo", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "(stub answer)" }], stop_reason: "end_turn",
      usage: { input_tokens: inputTokens, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  });
});
await new Promise((ready) => stub.listen(0, "127.0.0.1", ready));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const ledgerDirectory = mkdtempSync(join(tmpdir(), "flux-demo-"));
const proxy = await startFluxProxy({
  ledgerDirectory,
  anthropicUpstream: stubUrl,
  tokenReduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" },
});

console.log("FLUX zero-key demo — a local stub stands in for the provider; nothing leaves this machine.\n");

const PREAMBLE = "You are a careful assistant on a production team. Verify inputs, cite sources, prefer small reversible steps, and keep answers terse. ".repeat(12);
const TOOLS = Array.from({ length: 8 }, (_, i) => ({
  name: `lookup_${i}`,
  description: `Looks up records in subsystem ${i}. Validates input, retries once on transient failure, returns compact JSON.`,
  input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] },
}));
const EXCERPT = "Clause 4 of the services agreement sets the notification window and assigns liability for third-party outages to the operating party. ".repeat(2);

async function send(name, request) {
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-demo-not-a-real-key", "x-flux-application": name },
    body: JSON.stringify(request),
  });
  await response.arrayBuffer();
}

// 1. A multi-turn agent whose system prompt carries a per-turn clock — the
//    exact shape that LOSES money when cache breakpoints are placed naively.
const history = [];
for (let turn = 0; turn < 5; turn += 1) {
  history.push({ role: "user", content: `Turn ${turn}: continue the migration.` });
  await send("demo-agent", {
    model: "claude-sonnet-5-5", max_tokens: 300,
    system: `Current time: 2026-10-24T09:0${turn}:00Z\n${PREAMBLE}`,
    tools: TOOLS, messages: [...history],
  });
  history.push({ role: "assistant", content: `Turn ${turn} done.` });
}
console.log("1. five-turn agent, per-turn clock in the system prompt: schemas compacted, the clock relocated out of the cacheable prefix, cache_control placed on the stable text only");

// 2. A RAG request that retrieved the same excerpt twice.
await send("demo-rag", {
  model: "claude-sonnet-5-5", max_tokens: 300, system: PREAMBLE,
  messages: [{ role: "user", content: `Context:\n${EXCERPT}\n${EXCERPT}\nQuestion: what does clause 4 require?` }],
});
console.log("2. RAG request with a duplicated excerpt: the exact duplicate removed, question untouched");

// 3. Templated batch items.
for (let item = 0; item < 4; item += 1) {
  await send("demo-batch", {
    model: "claude-sonnet-5-5", max_tokens: 60, system: PREAMBLE, tools: TOOLS.slice(0, 4),
    messages: [{ role: "user", content: `Classify ticket ${item}: printer error E${item}.` }],
  });
}
console.log("3. four templated batch classifications: shared template stamped once, read thereafter");

// 4. An already-lean request FLUX should leave alone.
await send("demo-lean", {
  model: "claude-sonnet-5-5", max_tokens: 60,
  messages: [{ role: "user", content: "Summarise: the meeting moved to 3pm." }],
});
console.log("4. an already-lean request: nothing worth removing\n");

await proxy.close();
stub.close();

for (const spool of readdirSync(ledgerDirectory).sort()) {
  const records = readFileSync(join(ledgerDirectory, spool), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const chain = verifyLedgerChain(records);
  const invoice = recomputeInvoice(records.map((r) => r.event));
  console.log(`${spool}: ${records.length} event(s), chain ${chain.ok ? "VERIFIED" : "BROKEN"} — verdict ${invoice.verdict}, net verified savings $${invoice.netVerifiedSavingsUsd.toFixed(4)}`);
}
console.log(`\nThe spools live at ${ledgerDirectory} — inspect them, or re-verify independently with the MIT verifier:`);
console.log(`  npx -y -p @flux-ai/verify flux-verify ${join(ledgerDirectory, "demo-agent-anthropic.jsonl")}`);
console.log("\nDemo traffic only: these numbers describe this synthetic run, never your workload.");
console.log("Real traffic is one line: point your client baseURL at flux-proxy and keep your own key.");
