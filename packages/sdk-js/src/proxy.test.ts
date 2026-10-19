import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { startFluxProxy, usageFromSse, type FluxProxy } from "./proxy.js";

type AnyObject = Record<string, any>;

/**
 * Stub provider: records what it was sent, answers /v1/messages with an
 * Anthropic-shaped JSON (or SSE when the request asked to stream) and
 * /v1/responses with an OpenAI-shaped JSON. Usage is proportional to the
 * request it actually received, so reductions are visible in the ledger.
 */
function stubUpstream(seen: AnyObject[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnyObject;
      seen.push({ path: req.url, headers: req.headers, body });
      const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
      if (req.url === "/v1/messages" && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "ok" } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n`);
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        return;
      }
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_stub",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
        return;
      }
      if (req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_stub",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: inputTokens, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
        }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected path ${req.url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("FLUX proxy mode", () => {
  const seen: AnyObject[] = [];
  let upstream: { server: Server; url: string };
  let proxy: FluxProxy;
  let ledgerDir: string;

  beforeAll(async () => {
    upstream = await stubUpstream(seen);
    ledgerDir = mkdtempSync(join(tmpdir(), "flux-proxy-"));
    proxy = await startFluxProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
    });
  });

  afterAll(async () => {
    await proxy.close();
    upstream.server.close();
  });

  const duplicated = `${"Clause 4471 applies to every refund older than thirty days and must be cited in full. ".repeat(3)}`;

  it("reduces the request before forwarding and returns the provider's bytes untouched", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-flux-application": "app-a" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5-20260514",
        max_tokens: 100,
        system: "You are terse.",
        messages: [{ role: "user", content: `${duplicated}\n\n${duplicated}\n\nSummarise.` }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyObject;
    expect(body.id).toBe("msg_stub");
    expect(body.content[0].text).toBe("ok");

    const sent = seen[seen.length - 1]!;
    // The caller's own credentials passed through verbatim; FLUX added nothing.
    expect(sent.headers["x-api-key"]).toBe("caller-key");
    expect(sent.headers["x-flux-application"]).toBeUndefined();
    // The duplicate block was removed before the provider saw the request.
    const wire = JSON.stringify(sent.body);
    expect(wire.split("Clause 4471").length - 1).toBeLessThan(6);
  });

  it("appends a priced, hash-chained ledger event per request, with estimated-baseline savings billed", async () => {
    const records = readFileSync(join(ledgerDir, "app-a-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: records.length });
    const event = records[0]!.event;
    expect(event.pricingStatus).toBe("priced");
    expect(event.applicationId).toBe("app-a");
    const invoice = recomputeInvoice(records.map((r) => r.event));
    expect(invoice.netVerifiedSavingsUsd).toBeGreaterThan(0);
    expect(invoice.lineItems.some((line) => line.basis === "estimated-baseline")).toBe(true);
  });

  it("streams SSE through and prices the event from the stream's own usage", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-flux-application": "app-b" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5-20260514",
        max_tokens: 100,
        stream: true,
        system: "You are terse.",
        messages: [{ role: "user", content: "Hello." }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The SSE bytes reached the client intact.
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");

    const records = readFileSync(join(ledgerDir, "app-b-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(1);
    const event = records[0]!.event;
    expect(event.pricingStatus).toBe("priced");
    // Output tokens came from the LAST message_delta, not message_start.
    expect(event.usage?.outputTokens).toBe(7);
  });

  it("forwards OpenAI-shaped requests to the OpenAI upstream path", async () => {
    const res = await fetch(`${proxy.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
      body: JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "Hello." }] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AnyObject).id).toBe("resp_stub");
    const sent = seen[seen.length - 1]!;
    expect(sent.path).toBe("/v1/responses");
    expect(sent.headers.authorization).toBe("Bearer caller-key");
  });

  it("rejects paths it does not proxy with a helpful message, touching nothing", async () => {
    const res = await fetch(`${proxy.url}/v1/other`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as AnyObject).error).toContain("base_url");
  });

  it("rejects a non-JSON body without contacting the upstream", async () => {
    const before = seen.length;
    const res = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(seen.length).toBe(before);
  });
});

describe("usageFromSse", () => {
  it("returns undefined for a stream with no readable usage, never a guess", () => {
    expect(usageFromSse("anthropic", "data: {\"type\":\"ping\"}\n\n")).toBeUndefined();
    expect(usageFromSse("openai", "data: [DONE]\n\n")).toBeUndefined();
  });

  it("reads OpenAI Responses usage from response.completed", () => {
    const sse = `data: ${JSON.stringify({ type: "response.created", response: {} })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 }, service_tier: "flex" } })}\n\n`;
    const shaped = usageFromSse("openai", sse) as AnyObject;
    expect(shaped.usage.input_tokens).toBe(10);
    expect(shaped.service_tier).toBe("flex");
  });
});
