import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFlux } from "./openai.js";
import { startFluxProxy } from "./proxy.js";
import { chooseSideCallRoute, detectSideCall, type FluxSideCallRoutingConfig } from "./side-call-routing.js";
import type { FluxRequestEvent } from "./types.js";

type AnyObject = Record<string, any>;

// Open WebUI's task templates share one structure: "### Task:" head, a JSON
// output spec naming the key, then the chat history block at the very end.
function owui(head: string, key: string, history = "USER: plan my week\nASSISTANT: Here is a plan."): string {
  return `### Task:\n${head}\n### Guidelines:\n- Be accurate.\n### Output:\nJSON format: { "${key}": [] }\n` +
    `### Chat History:\n<chat_history>\n${history}\n</chat_history>`;
}

const TITLE = owui("Generate a concise title summarizing the chat history.", "title");
const TITLE_LEGACY = owui("Generate a concise, 3-5 word title with an emoji summarizing the chat history.", "title");
const TAGS = owui("Generate 1-3 broad tags categorizing the main themes of the chat history, along with 1-3 more specific subtopic tags.", "tags");
const FOLLOW_UPS = owui("Predict 3-5 useful messages this user might naturally send next to advance their current objective.", "follow_ups");
const FOLLOW_UPS_LEGACY = owui("Suggest 3-5 relevant follow-up questions or prompts that the user might naturally ask next in this conversation.", "follow_ups");
const QUERIES = owui("Analyze the chat history to determine the necessity of generating search queries, in the given language.", "queries");
const IMAGE = owui("Generate a detailed prompt for am image generation task based on the given language and context.", "prompt");
const AUTOCOMPLETE = "### Task:\nYou are an autocompletion system. Continue the text in `<text>` based on the **completion type** in `<type>`.\n" +
  "<type>General</type>\n<text>The weather tomorrow</text>";
const LIBRECHAT_TITLE = "Provide a concise, 5-word-or-less title for the conversation, using title case conventions. Only return the title itself.\n\n" +
  "Conversation:\nUser: plan my week\nAI: Here is a plan.";
const LIBRECHAT_STRUCTURED = "Analyze this conversation and provide:\n1. The detected language of the conversation\n" +
  "2. A concise title in the detected language (5 words or less, no punctuation or quotation)\n\nUser: hola";

const one = (content: unknown, extra: AnyObject = {}) => ({
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content }],
  ...extra,
});

describe("detectSideCall", () => {
  it.each([
    [TITLE, "title", "open-webui/title"],
    [TITLE_LEGACY, "title", "open-webui/title"],
    [TAGS, "tags", "open-webui/tags"],
    [FOLLOW_UPS, "follow_ups", "open-webui/follow-ups"],
    [FOLLOW_UPS_LEGACY, "follow_ups", "open-webui/follow-ups"],
    [QUERIES, "search_queries", "open-webui/queries"],
    [IMAGE, "image_prompt", "open-webui/image-prompt"],
    [AUTOCOMPLETE, "autocomplete", "open-webui/autocomplete"],
    [LIBRECHAT_TITLE, "title", "librechat/title-completion"],
    [LIBRECHAT_STRUCTURED, "title", "librechat/title-structured"],
  ])("recognises a known template (%#)", (prompt, kind, signatureId) => {
    expect(detectSideCall(one(prompt))).toMatchObject({ kind, signatureId });
  });

  it("accepts text-block content, a leading system message and the Responses API input string", () => {
    expect(detectSideCall(one([{ type: "text", text: TITLE }]))?.kind).toBe("title");
    expect(detectSideCall({ model: "m", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: TAGS }] })?.kind)
      .toBe("tags");
    expect(detectSideCall({ model: "m", input: FOLLOW_UPS })?.kind).toBe("follow_ups");
  });

  it("never matches a real conversation turn, even one quoting a template", () => {
    // A multi-turn conversation whose latest message happens to be a template.
    expect(detectSideCall({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: TITLE },
      ],
    })).toBeUndefined();
    // Near-misses: head without structure, structure plus a trailing question.
    expect(detectSideCall(one("Generate a concise title summarizing the chat history of my book club."))).toBeUndefined();
    expect(detectSideCall(one("### Task:\nGenerate a concise title summarizing the chat history.\nWhy does my template add emojis?")))
      .toBeUndefined();
    expect(detectSideCall(one(`${TAGS}\nWhy does this always return General?`))).toBeUndefined();
    expect(detectSideCall(one('Suggest 3-5 relevant follow-up questions for my GP. Return { "follow_ups": [] }'))).toBeUndefined();
    expect(detectSideCall(one("plan my week"))).toBeUndefined();
  });

  it("rejects tool-carrying, multimodal and malformed requests", () => {
    expect(detectSideCall(one(TITLE, { tools: [{ type: "function", function: { name: "f" } }] }))).toBeUndefined();
    expect(detectSideCall(one([{ type: "text", text: TITLE }, { type: "image_url", image_url: { url: "x" } }]))).toBeUndefined();
    expect(detectSideCall({ model: "m", messages: [{ role: "assistant", content: TITLE }] })).toBeUndefined();
    for (const bad of [null, undefined, "x", 3, [], { messages: "x" }, { messages: [null] }]) {
      expect(detectSideCall(bad)).toBeUndefined();
    }
  });

  it("LibreChat's structured title call may carry its response-schema tool", () => {
    expect(detectSideCall(one(LIBRECHAT_STRUCTURED, { tools: [{ name: "title" }] }))?.kind).toBe("title");
  });

  it("documented limit: a user pasting a whole template verbatim as a first turn is indistinguishable", () => {
    // Byte-identical to the real side-call; the detector cannot tell them
    // apart. The consequence is a cheaper model answering that one turn.
    expect(detectSideCall(one(TITLE))?.kind).toBe("title");
  });
});

describe("chooseSideCallRoute", () => {
  const on: FluxSideCallRoutingConfig = { enabled: true, targetModel: "claude-haiku-5-5" };

  it("does nothing unless explicitly enabled", () => {
    expect(chooseSideCallRoute(undefined, one(TITLE), "anthropic")).toBeUndefined();
    expect(chooseSideCallRoute({ ...on, enabled: false }, one(TITLE), "anthropic")).toBeUndefined();
    expect(chooseSideCallRoute({ ...on, enabled: "yes" } as never, one(TITLE), "anthropic")).toBeUndefined();
  });

  it("routes the default kinds and leaves opt-in kinds alone", () => {
    expect(chooseSideCallRoute(on, one(TITLE), "anthropic")).toMatchObject({
      targetModel: "claude-haiku-5-5",
      requestedModel: "claude-sonnet-5-5",
      match: { kind: "title" },
    });
    expect(chooseSideCallRoute(on, one(FOLLOW_UPS), "anthropic")?.match.kind).toBe("follow_ups");
    expect(chooseSideCallRoute(on, one(QUERIES), "anthropic")).toBeUndefined();
    expect(chooseSideCallRoute({ ...on, kinds: ["search_queries"] }, one(QUERIES), "anthropic")?.match.kind).toBe("search_queries");
    expect(chooseSideCallRoute({ ...on, kinds: ["title"] }, one(TAGS), "anthropic")).toBeUndefined();
  });

  it("picks the per-provider target and skips requests already on it", () => {
    const perProvider: FluxSideCallRoutingConfig = { enabled: true, targetModel: { openai: "gpt-4o-mini" } };
    expect(chooseSideCallRoute(perProvider, one(TITLE), "anthropic")).toBeUndefined();
    expect(chooseSideCallRoute(perProvider, { ...one(TITLE), model: "gpt-5.5" }, "openai")?.targetModel).toBe("gpt-4o-mini");
    expect(chooseSideCallRoute(on, { ...one(TITLE), model: "claude-haiku-5-5" }, "anthropic")).toBeUndefined();
    expect(chooseSideCallRoute({ enabled: true, targetModel: " " }, one(TITLE), "anthropic")).toBeUndefined();
  });
});

describe("withFlux side-call routing", () => {
  const response = {
    choices: [{ message: { role: "assistant", content: "{ \"title\": \"Week Plan\" }" } }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
  };
  function client(seen: AnyObject[], failOn?: string) {
    return {
      chat: {
        completions: {
          create: async (request: AnyObject) => {
            seen.push(request);
            if (request.model === failOn) throw new Error("model unavailable");
            return structuredClone(response);
          },
        },
      },
    };
  }

  it("is off by default: the side-call goes to the requested model", async () => {
    const seen: AnyObject[] = [];
    const flux = withFlux(client(seen), { applicationId: "t" });
    await flux.chat.completions.create({ ...one(TITLE), model: "gpt-5.5" });
    expect(seen.map((r) => r.model)).toEqual(["gpt-5.5"]);
  });

  it("routes a side-call, leaves a real turn alone, and records the swap on the event", async () => {
    const seen: AnyObject[] = [];
    const events: FluxRequestEvent[] = [];
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "flux-side-call-")), "ledger.jsonl");
    const flux = withFlux(client(seen), {
      applicationId: "t",
      sideCallRouting: { enabled: true, targetModel: { openai: "gpt-4o-mini" } },
      ledger: { path: ledgerPath, provider: "openai" },
      onEvent: (event) => events.push(event),
    });
    const real = { model: "gpt-5.5", messages: [{ role: "user", content: "plan my week" }] };
    await flux.chat.completions.create(real);
    await flux.chat.completions.create({ ...one(TITLE), model: "gpt-5.5" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.map((r) => r.model)).toEqual(["gpt-5.5", "gpt-4o-mini"]);
    // The routed body is the caller's body with only the model changed.
    expect({ ...seen[1], model: "gpt-5.5" }).toEqual({ ...one(TITLE), model: "gpt-5.5" });
    expect(events[1]).toMatchObject({
      model: "gpt-4o-mini",
      requestedModel: "gpt-5.5",
      routeReason: "side_call_routed",
      routePolicyId: "open-webui/title",
    });
    expect(events[0]!.routeReason).not.toBe("side_call_routed");
    // Nothing about the swap bills: no lever on the record claims a saving.
    const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(Array.isArray(record.event.levers)).toBe(true);
      expect(record.event.levers.filter((lever: AnyObject) => (lever.savedUsd ?? 0) !== 0)).toEqual([]);
    }
  });

  it("falls back to the requested model when the cheap model errors", async () => {
    const seen: AnyObject[] = [];
    const flux = withFlux(client(seen, "gpt-4o-mini"), {
      applicationId: "t",
      sideCallRouting: { enabled: true, targetModel: "gpt-4o-mini" },
    });
    const result = await flux.chat.completions.create({ ...one(TITLE), model: "gpt-5.5" });
    expect(result.choices[0].message.content).toContain("Week Plan");
    expect(seen.map((r) => r.model)).toEqual(["gpt-4o-mini", "gpt-5.5"]);
  });
});

describe("proxy side-call routing", () => {
  async function stub(seen: AnyObject[]): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }

  it("forwards side-calls to the target only when enabled", async () => {
    const seen: AnyObject[] = [];
    const upstream = await stub(seen);
    const dirOff = mkdtempSync(join(tmpdir(), "flux-proxy-side-off-"));
    const dirOn = mkdtempSync(join(tmpdir(), "flux-proxy-side-on-"));
    const off = await startFluxProxy({ ledgerDirectory: dirOff, openaiUpstream: upstream.url });
    const on = await startFluxProxy({
      ledgerDirectory: dirOn,
      openaiUpstream: upstream.url,
      sideCallRouting: { enabled: true, targetModel: { openai: "gpt-4o-mini" } },
    });
    try {
      const post = (url: string, body: AnyObject) => fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify(body),
      });
      await post(off.url, { ...one(FOLLOW_UPS), model: "gpt-5.5" });
      await post(on.url, { ...one(FOLLOW_UPS), model: "gpt-5.5" });
      await post(on.url, { model: "gpt-5.5", messages: [{ role: "user", content: "plan my week" }] });
      expect(seen.map((r) => r.model)).toEqual(["gpt-5.5", "gpt-4o-mini", "gpt-5.5"]);
      const spool = readFileSync(join(dirOn, "proxy-openai.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(spool).toHaveLength(2);
      expect(JSON.stringify(spool[0])).toContain("gpt-4o-mini");
      expect(JSON.stringify(spool[1])).not.toContain("gpt-4o-mini");
    } finally {
      await off.close();
      await on.close();
      upstream.server.close();
    }
  });
  it("falls back to the requested model when the cheap model fails", async () => {
    const seen: AnyObject[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnyObject;
        seen.push(body);
        if (body.model === "gpt-4o-mini") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "overloaded" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "flux-proxy-side-fallback-"));
    const proxy = await startFluxProxy({
      ledgerDirectory: dir,
      openaiUpstream: url,
      sideCallRouting: { enabled: true, targetModel: { openai: "gpt-4o-mini" } },
    });
    try {
      const response = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ ...one(FOLLOW_UPS), model: "gpt-5.5" }),
      });
      expect(response.status).toBe(200);
      expect(seen.map((r) => r.model)).toEqual(["gpt-4o-mini", "gpt-5.5"]);
      const spool = readFileSync(join(dir, "proxy-openai.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(spool).toHaveLength(1);
      expect(JSON.stringify(spool[0])).not.toContain("gpt-4o-mini");
      expect(JSON.stringify(spool[0])).not.toContain("side_call_routed");
    } finally {
      await proxy.close();
      server.close();
    }
  });
});
