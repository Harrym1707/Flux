/**
 * Measure what the FLUX proxy ADDS to a request's latency — the first
 * question every engineer asks before putting anything in their request path.
 *
 *   node --import tsx evals/run-proxy-overhead.ts
 *
 * Method, stated so the number can be checked:
 * - A stub upstream on loopback answers every POST with a realistic Anthropic
 *   Messages response, instantly. Provider and network latency are therefore
 *   EXCLUDED by construction: what remains is FLUX's own per-request work
 *   (parse, reduce, forward, re-serialize, ledger append).
 * - Two arms run the SAME realistic agent traffic (the measurement fixture's
 *   multi-turn requests: sizeable system prompt, 12 tool schemas, growing
 *   history) at pinned concurrency against the SAME stub:
 *     direct  — client -> stub
 *     proxied — client -> FLUX proxy (full lossless stack + 5m cache stamp) -> stub
 * - Overhead at each percentile is proxied minus direct. Warmup requests are
 *   excluded. Results are from THIS machine's loopback; absolute values vary
 *   by hardware, but the overhead is the honest quantity either way.
 *
 *   FLUX_OVERHEAD_REQUESTS     requests per arm (default 400)
 *   FLUX_OVERHEAD_CONCURRENCY  in-flight cap (default 8)
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { startFluxProxy } from "../packages/sdk-js/src/index.js";
import { buildAnthropicRequest } from "./agent-fixture.js";

const REQUESTS = Number(process.env.FLUX_OVERHEAD_REQUESTS ?? 400);
const CONCURRENCY = Number(process.env.FLUX_OVERHEAD_CONCURRENCY ?? 8);
const WARMUP = 25;

const STUB_RESPONSE = JSON.stringify({
  id: "msg_overhead_stub", type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "Acknowledged. Proceeding with the plan." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1800, output_tokens: 40 },
});

function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const sink: Buffer[] = [];
      request.on("data", (chunk: Buffer) => sink.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(STUB_RESPONSE);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("stub failed to bind");
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** The traffic both arms replay: 50 distinct 4-turn agent conversations. */
function trafficBody(sequence: number): string {
  const task = sequence % 50;
  const turn = sequence % 4;
  return JSON.stringify(buildAnthropicRequest(task, turn, 9 + (turn % 3)));
}

async function runArm(baseUrl: string, label: string): Promise<number[]> {
  const durations: number[] = [];
  let sequence = 0;
  const total = REQUESTS + WARMUP;
  async function worker(): Promise<void> {
    for (;;) {
      const mine = sequence;
      sequence += 1;
      if (mine >= total) return;
      const body = trafficBody(mine);
      const started = performance.now();
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-overhead-stub" },
        body,
      });
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      if (response.status !== 200) throw new Error(`${label}: upstream answered ${response.status}`);
      if (mine >= WARMUP) durations.push(elapsed);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return durations;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

const summarize = (durations: number[]) => {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
};

const stub = await startStub();
const ledgerDirectory = mkdtempSync(join(tmpdir(), "flux-overhead-"));
const proxy = await startFluxProxy({
  port: 0,
  ledgerDirectory,
  anthropicUpstream: stub.url,
  tokenReduction: {
    toolSchemas: true,
    duplicateContext: true,
    repairCachePrefix: true,
    historyCompaction: true,
    cacheTtl: "5m",
  },
});

// Direct first, then proxied, interleaved once more in reverse order so a
// warming machine cannot flatter the proxy arm.
const directA = await runArm(stub.url, "direct");
const proxiedA = await runArm(proxy.url, "proxied");
const proxiedB = await runArm(proxy.url, "proxied");
const directB = await runArm(stub.url, "direct");

const direct = summarize([...directA, ...directB]);
const proxied = summarize([...proxiedA, ...proxiedB]);

const sampleBytes = Buffer.byteLength(trafficBody(3));
console.log(`FLUX proxy overhead — ${REQUESTS * 2} requests/arm (+${WARMUP * 2} warmup), concurrency ${CONCURRENCY}, ~${(sampleBytes / 1024).toFixed(1)} KB request bodies`);
console.log(`stub upstream on loopback (instant): provider/network latency excluded by construction`);
console.log(`node ${process.version} · ${process.platform}/${process.arch} · ${new Date().toISOString().slice(0, 10)}`);
console.log("");
console.log(`arm      p50       p95       p99       mean`);
const row = (label: string, s: ReturnType<typeof summarize>) =>
  console.log(`${label.padEnd(8)} ${s.p50.toFixed(2).padStart(6)} ms ${s.p95.toFixed(2).padStart(6)} ms ${s.p99.toFixed(2).padStart(6)} ms ${s.mean.toFixed(2).padStart(6)} ms`);
row("direct", direct);
row("proxied", proxied);
console.log("");
console.log(`FLUX adds: p50 ${(proxied.p50 - direct.p50).toFixed(2)} ms · p95 ${(proxied.p95 - direct.p95).toFixed(2)} ms · p99 ${(proxied.p99 - direct.p99).toFixed(2)} ms · mean ${(proxied.mean - direct.mean).toFixed(2)} ms`);
console.log("");
console.log("Provable-savings statement: this run measures added latency only; it bills nothing and claims no savings.");

await proxy.close();
stub.server.close();
rmSync(ledgerDirectory, { recursive: true, force: true });
