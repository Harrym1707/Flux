import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFlux } from "./wrap.js";

/** A minimal OpenAI-SDK-shaped client that records the request FLUX actually sent. */
function mockOpenAI() {
  const sent: unknown[] = [];
  return {
    sent,
    greeting: "i am the real client",
    chat: {
      completions: {
        create: async (request: unknown) => {
          sent.push(request);
          return {
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 120, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
          };
        },
      },
    },
  };
}

/** A minimal Anthropic-SDK-shaped client (messages.create). */
function mockAnthropic() {
  const sent: unknown[] = [];
  return {
    sent,
    messages: {
      create: async (request: unknown) => {
        sent.push(request);
        return {
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 120, output_tokens: 20 },
        };
      },
    },
  };
}

const DUP =
  "Knowledge base article 4471: refunds to a closed card return to the original payment method where the " +
  "issuer supports it, otherwise the customer wallet within one business day.";

function requestWithDuplicate() {
  return {
    model: "gpt-5",
    messages: [{ role: "user", content: `${DUP}\n\n${DUP}\n\nWhat happens to the refund?` }],
  };
}

describe("wrapFlux (one-import drop-in)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flux-wrap-"));
  });

  it("is a drop-in: the response shape is passed through unchanged", async () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    const res = await openai.chat.completions.create(requestWithDuplicate());
    expect((res as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("ok");
  });

  it("reduces the request before it is sent (the duplicate block is gone on the wire)", async () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    await openai.chat.completions.create(requestWithDuplicate());
    const sent = JSON.stringify(mock.sent[0]);
    // The article text was duplicated in the input; FLUX's lossless dedupe must
    // leave exactly one copy on the wire.
    const occurrences = sent.split("Knowledge base article 4471").length - 1;
    expect(occurrences).toBe(1);
  });

  it("surfaces measured savings from the real ledger, not a token estimate", async () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    await openai.chat.completions.create(requestWithDuplicate());
    const savings = openai.flux.savings();
    expect(savings.requests).toBe(1);
    expect(Number.isFinite(savings.savedUsd)).toBe(true);
    expect(savings.savedUsd).toBeGreaterThanOrEqual(0);
    expect(savings.ledgerPath).toBe(join(dir, "t.jsonl"));
  });

  it("reports zero before any request is made", () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    expect(openai.flux.savings().requests).toBe(0);
  });

  it("passes non-create properties straight through to the client", () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    expect((openai as unknown as { greeting: string }).greeting).toBe("i am the real client");
  });

  it("is model-agnostic: reduces any OpenAI-compatible provider regardless of model id", async () => {
    // Groq / Together / DeepSeek / xAI etc. all speak chat.completions; the only
    // thing that changes is the model string. Reduction is byte-level, so it must
    // fire the same on a non-OpenAI model as on gpt-5.
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    await openai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: `${DUP}\n\n${DUP}\n\nWhat happens to the refund?` }],
    });
    const sent = JSON.stringify(mock.sent[0]);
    expect(sent.split("Knowledge base article 4471").length - 1).toBe(1);
  });

  it("is provider-agnostic: wraps a native Anthropic-SDK client (messages.create) and reduces it", async () => {
    const mock = mockAnthropic();
    const anthropic = wrapFlux(mock, { app: "a", ledgerPath: join(dir, "a.jsonl") });
    const res = await (anthropic as unknown as {
      messages: { create: (r: unknown) => Promise<{ content: { text: string }[] }> };
    }).messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 256,
      messages: [{ role: "user", content: `${DUP}\n\n${DUP}\n\nWhat happens to the refund?` }],
    });
    expect(res.content[0]!.text).toBe("ok");
    const sent = JSON.stringify(mock.sent[0]);
    expect(sent.split("Knowledge base article 4471").length - 1).toBe(1);
    expect((anthropic as unknown as { flux: { savings(): { requests: number } } }).flux.savings().requests).toBe(1);
  });

  it("leaves the request untouched when there is nothing to reduce", async () => {
    const mock = mockOpenAI();
    const openai = wrapFlux(mock, { app: "t", ledgerPath: join(dir, "t.jsonl") });
    const clean = { model: "gpt-5", messages: [{ role: "user", content: "hello there" }] };
    await openai.chat.completions.create(clean);
    expect(mock.sent[0]).toEqual(clean);
  });
});
