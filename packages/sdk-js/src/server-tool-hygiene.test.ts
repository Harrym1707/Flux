import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeInvoice, type LedgerRecord } from "../../core/dist/src/index.js";
import { startFluxProxy, usageFromSse, type FluxProxy } from "./proxy.js";
import { meterServerToolHygiene } from "./server-tool-hygiene.js";

type AnyObject = Record<string, any>;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const filler = (words: number, seed: string) =>
  Array.from({ length: words }, (_, index) => `${seed}${index % 97}`).join(" ");

function researchRequest(model: string, tools: AnyObject[], extra: AnyObject = {}): AnyObject {
  return {
    model,
    max_tokens: 1_024,
    system: "You are a research agent.",
    tools,
    messages: [
      { role: "user", content: "Research the topic." },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "topic" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [{ type: "web_search_result", url: "https://example.com/a", title: "A", encrypted_content: filler(1_500, "enc") }],
          },
          { type: "server_tool_use", id: "srvtoolu_2", name: "web_fetch", input: { url: "https://example.com/a" } },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_2",
            content: {
              type: "web_fetch_result",
              url: "https://example.com/a",
              content: { type: "document", source: { type: "text", media_type: "text/plain", data: filler(9_000, "page") } },
            },
          },
          { type: "tool_use", id: "toolu_3", name: "notes", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: filler(2_000, "client") }] },
    ],
    ...extra,
  };
}

const basicTools = [
  { type: "web_search_20250305", name: "web_search" },
  { type: "web_fetch_20250910", name: "web_fetch" },
];

describe("meterServerToolHygiene", () => {
  it("never mutates the request: the serialised bytes are identical before and after", () => {
    const request = researchRequest("claude-sonnet-5-5", basicTools);
    const before = JSON.stringify(request);
    deepFreeze(request);
    meterServerToolHygiene(request);
    expect(JSON.stringify(request)).toBe(before);
  });

  it("counts server-tool result blocks, ignores client tool_result, and reports pinned versions", () => {
    const report = meterServerToolHygiene(researchRequest("claude-sonnet-5-5", basicTools));
    expect(report.webSearchResultBlocks).toBe(1);
    expect(report.webFetchResultBlocks).toBe(1);
    expect(report.clientToolResultBlocksIgnored).toBe(1);
    expect(report.pinnedVersions).toEqual(["web_fetch_20250910", "web_search_20250305"]);
    expect(report.codeExecutionEnabled).toBe(false);
    expect(report.serverToolResultShare).toBeGreaterThan(0.5);
    expect(report.serverToolResultShare).toBeLessThan(1);
    // The client tool_result (2,000 words) is not counted as server-tool content.
    const withoutClient = researchRequest("claude-sonnet-5-5", basicTools);
    withoutClient.messages.pop();
    expect(meterServerToolHygiene(withoutClient).serverToolResultTokensEstimated)
      .toBe(report.serverToolResultTokensEstimated);
  });

  it("recommends dynamic filtering on Sonnet-class routes only, as a labelled literature claim", () => {
    const sonnet = meterServerToolHygiene(researchRequest("claude-sonnet-5-5", basicTools));
    const upgrade = sonnet.advice.find((item) => item.code === "upgrade-to-dynamic-filtering")!;
    expect(upgrade.basis).toBe("literature-claim");
    expect(upgrade.lossy).toBe(true);
    expect(sonnet.advice.some((item) => item.code === "dynamic-filtering-cost-warning-opus")).toBe(false);

    const opus = meterServerToolHygiene(researchRequest("claude-opus-5-5", basicTools));
    expect(opus.advice.some((item) => item.code === "upgrade-to-dynamic-filtering")).toBe(false);
    expect(opus.advice.some((item) => item.code === "dynamic-filtering-cost-warning-opus")).toBe(true);

    const haiku = meterServerToolHygiene(researchRequest("claude-haiku-5-5", basicTools));
    expect(haiku.advice.some((item) => item.code.includes("dynamic-filtering"))).toBe(false);
  });

  it("detects auto-provisioned code execution on 20260209+ web tools, unless they are direct-only", () => {
    const dynamic = meterServerToolHygiene(researchRequest("claude-opus-5-5", [{ type: "web_search_20260318", name: "web_search" }]));
    expect(dynamic.codeExecutionEnabled).toBe(true);
    expect(dynamic.advice.some((item) => item.code === "response-inclusion-excluded")).toBe(true);
    const direct = meterServerToolHygiene(researchRequest("claude-opus-5-5", [
      { type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
    ]));
    expect(direct.codeExecutionEnabled).toBe(false);
  });

  it("suggests max_content_tokens for a large uncapped fetch and context editing on a high share", () => {
    const report = meterServerToolHygiene(researchRequest("claude-sonnet-5-5", basicTools));
    expect(report.advice.map((item) => item.code)).toEqual(expect.arrayContaining([
      "set-max-content-tokens", "set-max-uses", "context-editing-clear-server-results",
    ]));
    const capped = meterServerToolHygiene(researchRequest("claude-sonnet-5-5", [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3, max_content_tokens: 8_000 },
    ], {
      context_management: { edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["web_search"] }] },
    }));
    const codes = capped.advice.map((item) => item.code);
    expect(codes).not.toContain("set-max-content-tokens");
    expect(codes).not.toContain("set-max-uses");
    expect(codes).not.toContain("context-editing-clear-server-results");
    expect(codes).toContain("context-editing-excludes-server-results");
  });

  it("is empty and quiet on a request with no server tools", () => {
    const report = meterServerToolHygiene({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] });
    expect(report.serverToolResultTokensEstimated).toBe(0);
    expect(report.advice).toEqual([]);
  });
});

describe("usageFromSse server_tool_use merge", () => {
  it("takes the cumulative server_tool_use from the last message_delta and leaves token fields unchanged", () => {
    const sse = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9, server_tool_use: { web_search_requests: 2 } } })}`,
    ].join("\n\n");
    expect(usageFromSse("anthropic", sse)).toEqual({
      usage: {
        input_tokens: 10, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 2 },
      },
    });
  });
});

/** Stub Anthropic upstream whose responses report server-tool use, as JSON or SSE. */
function stubUpstream(seen: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push(raw);
      const body = JSON.parse(raw) as AnyObject;
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1_000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 50, server_tool_use: { web_search_requests: 6 } } })}\n\n`);
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}

describe("proxy: server-tool fees on the ledger and the opt-in meter", () => {
  const seen: string[] = [];
  let upstream: { server: Server; url: string };
  let plain: FluxProxy;
  let metered: FluxProxy;
  let plainDir: string;
  let meteredDir: string;

  beforeAll(async () => {
    upstream = await stubUpstream(seen);
    plainDir = mkdtempSync(join(tmpdir(), "flux-st-plain-"));
    meteredDir = mkdtempSync(join(tmpdir(), "flux-st-meter-"));
    plain = await startFluxProxy({ ledgerDirectory: plainDir, anthropicUpstream: upstream.url });
    metered = await startFluxProxy({ ledgerDirectory: meteredDir, anthropicUpstream: upstream.url, serverToolMeter: true });
  });

  afterAll(async () => {
    await plain.close();
    await metered.close();
    upstream.server.close();
  });

  const records = (dir: string, app: string): LedgerRecord[] =>
    readFileSync(join(dir, `${app}-anthropic.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);

  const send = (proxy: FluxProxy, app: string, body: AnyObject) => fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k", "x-flux-application": app },
    body: JSON.stringify(body),
  }).then((res) => res.text());

  it("records the per-search fee on the JSON path, attributed to the customer, never billed", async () => {
    await send(plain, "json", researchRequest("claude-sonnet-5-5-20260514", basicTools));
    const event = records(plainDir, "json")[0]!.event;
    expect(event.serverToolUsage).toMatchObject({ webSearchRequests: 2, webFetchRequests: 1, attributedTo: "customer" });
    expect(event.serverToolUsage!.feeUsd).toBeCloseTo(0.02, 12);
    // Meter is off by default: no diagnostics on the spool.
    expect(event.serverToolDiagnostics).toBeUndefined();
    const invoice = recomputeInvoice([event]);
    const { serverToolUsage: _dropped, ...stripped } = event;
    expect(JSON.stringify(recomputeInvoice([stripped]))).toBe(JSON.stringify(invoice));
  });

  it("records the per-search fee on the SSE merge path", async () => {
    await send(plain, "sse", { ...researchRequest("claude-sonnet-5-5-20260514", basicTools), stream: true });
    const event = records(plainDir, "sse")[0]!.event;
    expect(event.pricingStatus).toBe("priced");
    expect(event.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 50 });
    expect(event.serverToolUsage).toMatchObject({ webSearchRequests: 6, feeUsd: 0.06 });
  });

  it("the meter flag forwards byte-identical requests and records diagnostics only", async () => {
    const request = researchRequest("claude-sonnet-5-5-20260514", basicTools);
    const start = seen.length;
    await send(plain, "bytes-plain", request);
    await send(metered, "bytes-meter", request);
    expect(seen[start + 1]).toBe(seen[start]);
    const event = records(meteredDir, "bytes-meter")[0]!.event;
    expect(event.serverToolDiagnostics).toMatchObject({
      webSearchResultBlocks: 1,
      webFetchResultBlocks: 1,
      pinnedVersions: ["web_fetch_20250910", "web_search_20250305"],
      codeExecutionEnabled: false,
    });
    expect(event.serverToolDiagnostics!.serverToolResultShare).toBeGreaterThan(0.5);
    const plainEvent = records(plainDir, "bytes-plain")[0]!.event;
    expect(event.actualUsd).toBe(plainEvent.actualUsd);
    expect(event.levers).toEqual(plainEvent.levers);
  });
});
