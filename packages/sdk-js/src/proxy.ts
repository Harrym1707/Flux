import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  normalizeProviderUsage,
  responseServiceTier,
} from "../../core/dist/src/index.js";
import { reduceRequest, type FluxTokenReductionConfig } from "./reduce-request.js";
import { createSavingsLedger, type SavingsLedger } from "./savings-ledger.js";
import type { FluxRequestEvent } from "./types.js";

/**
 * FLUX proxy mode: point an application's base_url here instead of changing
 * its code. The proxy applies the configured token reduction to each request,
 * forwards it to the real provider with the CALLER's own credentials, returns
 * the provider's bytes untouched, and appends one hash-chained ledger event
 * per completed request — the same recomputable record the SDK wrapper writes.
 *
 * The contract, enforced rather than promised:
 * - FLUX never holds keys. Auth headers pass through verbatim; nothing is
 *   stored. Prompts are analysed in-process and never written anywhere — the
 *   ledger records usage numbers, lever names and hashes, not content.
 * - Nothing here may break a request. Reduction never throws (a failure
 *   returns the original request); a ledger failure silently disables the
 *   meter; only an unreachable upstream produces an error, and it is the
 *   upstream's own status and body wherever one exists.
 * - Responses stream through as they arrive. Usage for the ledger is parsed
 *   from the SSE events after the last byte has already been forwarded; a
 *   stream whose usage cannot be read produces an UNPRICED event, never a
 *   guessed one.
 * - Lossless levers only by default. Lossy levers and tier/cache stamps are
 *   per-deployment configuration, exactly as in the SDK.
 */

type AnyObject = Record<string, unknown>;

export type FluxProxyOptions = {
  /** Port to listen on; 0 picks a free one (reported by start()). */
  port?: number;
  /** Directory for the hash-chained ledger spools (one per app + provider). */
  ledgerDirectory: string;
  /** Reduction config applied to every proxied request. Lossless-only default. */
  tokenReduction?: FluxTokenReductionConfig;
  /** Override upstreams, e.g. a mock in tests or an OpenAI-compatible host. */
  anthropicUpstream?: string;
  openaiUpstream?: string;
};

export type FluxProxy = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

const LOSSLESS_DEFAULT: FluxTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

/** Headers that describe the hop, not the request; never forwarded. */
const HOP_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]);

function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // Identity keeps the body parseable for usage extraction without a
  // decompression stage in the request path.
  out["accept-encoding"] = "identity";
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type Surface = {
  provider: "anthropic" | "openai";
  upstreamPath: string;
};

function surfaceOf(path: string): Surface | undefined {
  if (path === "/v1/messages") return { provider: "anthropic", upstreamPath: "/v1/messages" };
  if (path === "/v1/responses") return { provider: "openai", upstreamPath: "/v1/responses" };
  if (path === "/v1/chat/completions") return { provider: "openai", upstreamPath: "/v1/chat/completions" };
  return undefined;
}

/**
 * Merge the usage scattered across a surface's SSE events into one response-
 * shaped object normalizeProviderUsage can read. Returns undefined when the
 * stream carried no readable usage — the event is then unpriced, never guessed.
 */
export function usageFromSse(provider: "anthropic" | "openai", sseText: string): AnyObject | undefined {
  const events: AnyObject[] = [];
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as AnyObject;
      if (typeof parsed === "object" && parsed !== null) events.push(parsed);
    } catch {
      // Non-JSON data lines are legal SSE; skip them.
    }
  }
  if (events.length === 0) return undefined;

  if (provider === "anthropic") {
    // message_start carries the input side; the LAST message_delta carries the
    // final cumulative output_tokens.
    const start = events.find((e) => e.type === "message_start");
    const startUsage = (start?.message as AnyObject | undefined)?.usage as AnyObject | undefined;
    if (startUsage === undefined) return undefined;
    let outputTokens: unknown = startUsage.output_tokens;
    let tier: unknown = (start?.message as AnyObject | undefined)?.service_tier ?? startUsage.service_tier;
    for (const e of events) {
      if (e.type !== "message_delta") continue;
      const deltaUsage = e.usage as AnyObject | undefined;
      if (deltaUsage?.output_tokens !== undefined) outputTokens = deltaUsage.output_tokens;
    }
    return {
      usage: { ...startUsage, output_tokens: outputTokens ?? 0 },
      ...(typeof tier === "string" ? { service_tier: tier } : {}),
    };
  }

  // OpenAI Responses: response.completed carries the whole final response.
  const completed = [...events].reverse().find((e) => e.type === "response.completed");
  const completedResponse = completed?.response as AnyObject | undefined;
  if (completedResponse?.usage !== undefined) return completedResponse;
  // Chat Completions: the final chunk carries usage when the caller asked for
  // it via stream_options.include_usage; otherwise there is nothing to read.
  const withUsage = [...events].reverse().find((e) => e.usage !== undefined && e.usage !== null);
  return withUsage;
}

/** Start the FLUX proxy. Resolves once the server is listening. */
export function startFluxProxy(options: FluxProxyOptions): Promise<FluxProxy> {
  const reduction = options.tokenReduction ?? LOSSLESS_DEFAULT;
  const upstreams = {
    anthropic: (options.anthropicUpstream ?? "https://api.anthropic.com").replace(/\/$/, ""),
    openai: (options.openaiUpstream ?? "https://api.openai.com").replace(/\/$/, ""),
  };
  const ledgers = new Map<string, SavingsLedger>();
  const ledgerFor = (applicationId: string, provider: "anthropic" | "openai"): SavingsLedger => {
    const key = `${applicationId}\n${provider}`;
    const existing = ledgers.get(key);
    if (existing !== undefined) return existing;
    const safeApp = applicationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "proxy";
    const ledger = createSavingsLedger({
      path: join(options.ledgerDirectory, `${safeApp}-${provider}.jsonl`),
      provider,
    });
    ledgers.set(key, ledger);
    return ledger;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0]!;

    // Transparent GET passthrough (model lists, etc.): no reduction, no
    // ledger event, bytes forwarded both ways. The provider is picked the way
    // the providers themselves do: x-api-key is Anthropic's header.
    if (req.method === "GET" && path.startsWith("/v1/")) {
      const provider = req.headers["x-api-key"] !== undefined ? "anthropic" : "openai";
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(`${upstreams[provider]}${req.url}`, {
          headers: forwardHeaders(req),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (cause) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Upstream unreachable: ${(cause as Error).message}` }));
        return;
      }
      const passHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name.toLowerCase())) passHeaders[name] = value;
      });
      res.writeHead(upstreamResponse.status, passHeaders);
      res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
      return;
    }

    const surface = req.method === "POST" ? surfaceOf(path) : undefined;
    if (surface === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "FLUX proxy forwards POST /v1/messages (Anthropic), /v1/responses and " +
          "/v1/chat/completions (OpenAI-compatible). Point your client's base_url at this server.",
      }));
      return;
    }

    const rawBody = await readBody(req);
    let body: AnyObject | undefined;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as AnyObject;
    } catch {
      body = undefined;
    }
    if (body === undefined || typeof body !== "object") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The request body is not a JSON object." }));
      return;
    }

    // Reduce. reduceRequest never throws; a failure returns the original.
    const { request: reducedRequest, summary } = reduceRequest(body, reduction);
    const sendBody = JSON.stringify(reducedRequest);
    const applicationIdHeader = req.headers["x-flux-application"];
    const applicationId = (Array.isArray(applicationIdHeader) ? applicationIdHeader[0] : applicationIdHeader) ?? "proxy";
    const headers = forwardHeaders(req);
    delete headers["x-flux-application"];
    headers["content-type"] = "application/json";

    const startedAt = Date.now();
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstreams[surface.provider]}${surface.upstreamPath}`, {
        method: "POST",
        headers,
        body: sendBody,
        signal: AbortSignal.timeout(600_000),
      });
    } catch (cause) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream unreachable: ${(cause as Error).message}` }));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    res.writeHead(upstreamResponse.status, responseHeaders);

    // Stream the provider's bytes through as they arrive, accumulating a copy
    // (bounded) for usage extraction AFTER the client has everything.
    const chunks: Buffer[] = [];
    let accumulated = 0;
    const ACCUMULATION_CAP = 32 * 1024 * 1024;
    if (upstreamResponse.body !== null) {
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        if (accumulated < ACCUMULATION_CAP) {
          chunks.push(Buffer.from(value));
          accumulated += value.byteLength;
        }
      }
    }
    res.end();

    // Ledger event, after the response is fully forwarded. Never throws.
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      let responseShaped: AnyObject | undefined;
      if (contentType.includes("text/event-stream")) {
        responseShaped = usageFromSse(surface.provider, text);
      } else {
        try {
          responseShaped = JSON.parse(text) as AnyObject;
        } catch {
          responseShaped = undefined;
        }
      }
      const usageResult = responseShaped === undefined
        ? undefined
        : normalizeProviderUsage(responseShaped);
      const usage = usageResult?.status === "ok" ? usageResult.usage : undefined;
      const tier = responseShaped === undefined ? undefined : responseServiceTier(responseShaped);
      const event: FluxRequestEvent = {
        requestId: randomUUID(),
        applicationId,
        provider: `${surface.provider}-compatible`,
        model: typeof body.model === "string" ? body.model : "unknown",
        latencyMs: Date.now() - startedAt,
        status: upstreamResponse.ok ? "succeeded" : "failed",
        timestamp: new Date(startedAt).toISOString(),
        ...(summary.skipped ? {} : { reduction: summary }),
        ...(usage === undefined ? {} : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          uncachedInputTokens: usage.uncachedInputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          ...(usage.cacheWrite5mInputTokens === undefined ? {} : {
            cacheWrite5mInputTokens: usage.cacheWrite5mInputTokens,
            cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens ?? 0,
          }),
        }),
        ...(tier === undefined ? {} : { responseServiceTier: tier }),
      };
      ledgerFor(applicationId, surface.provider).emit(event);
    } catch {
      // The meter must never affect the request path.
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "FLUX proxy internal error." }));
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done, fail) =>
          server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
