/**
 * Round-3 verification tests for the Anthropic-shaped fixture remap.
 *
 * These pin the four properties the round-3 build relies on:
 *   1. buildAnthropicRequest carries the instructions/input bytes VERBATIM
 *      into system/messages, with tools and metadata passed through untouched.
 *   2. answer() reaches the identical verdict on either shape, for every one
 *      of the 200 (task, turn) pairs in the default fixture.
 *   3. wirePrompt() is identical across the two shapes (the shapes differ
 *      only in key names, and wirePrompt reads system ?? instructions and
 *      input ?? messages in the same wire positions).
 *   4. The widenings are byte no-ops on the OpenAI shape: the widened
 *      wirePrompt reproduces the pre-widening formula byte-for-byte, and an
 *      OpenAI-shaped request never carries the Anthropic keys, so the ??
 *      fallbacks can never fire there.
 */
import { describe, expect, it } from "vitest";

import {
  TASKS,
  TURNS_PER_TASK,
  answer,
  buildAnthropicRequest,
  buildRequest,
  wirePrompt,
  type AnyObject,
} from "./agent-fixture.js";

const clockHourOf = (taskIndex: number): number => 8 + (taskIndex % 10);

describe("buildAnthropicRequest", () => {
  it("carries instructions/input bytes verbatim into system/messages, tools and metadata untouched", () => {
    for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
      const clockHour = clockHourOf(taskIndex);
      for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
        const openai = buildRequest(taskIndex, turn, clockHour);
        const anthropic = buildAnthropicRequest(taskIndex, turn, clockHour);
        expect(anthropic.model).toBe("claude-sonnet-4-5");
        expect(anthropic.system).toBe(openai.instructions);
        expect(JSON.stringify(anthropic.messages)).toBe(JSON.stringify(openai.input));
        expect(JSON.stringify(anthropic.tools)).toBe(JSON.stringify(openai.tools));
        expect(JSON.stringify(anthropic.metadata)).toBe(JSON.stringify(openai.metadata));
        // The remap renames keys; it never invents or drops content fields.
        expect(anthropic.instructions).toBeUndefined();
        expect(anthropic.input).toBeUndefined();
      }
    }
  });

  it("answer() reaches the identical verdict on either shape for all 200 (task, turn) pairs", () => {
    let pairs = 0;
    for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
      const clockHour = clockHourOf(taskIndex);
      for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
        const fromOpenai = answer(buildRequest(taskIndex, turn, clockHour));
        const fromAnthropic = answer(buildAnthropicRequest(taskIndex, turn, clockHour));
        expect(fromAnthropic).toEqual(fromOpenai);
        pairs += 1;
      }
    }
    expect(pairs).toBe(TASKS * TURNS_PER_TASK);
  });

  it("wirePrompt() is identical across the two shapes (modulo the shape keys)", () => {
    for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
      const clockHour = clockHourOf(taskIndex);
      for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
        expect(wirePrompt(buildAnthropicRequest(taskIndex, turn, clockHour)))
          .toBe(wirePrompt(buildRequest(taskIndex, turn, clockHour)));
      }
    }
  });
});

describe("the widenings are byte no-ops on the OpenAI shape", () => {
  it("widened wirePrompt reproduces the pre-widening formula byte-for-byte", () => {
    const preWidening = (request: AnyObject): string =>
      `${String(request.instructions ?? "")}\n${JSON.stringify(request.tools ?? [])}\n` +
      JSON.stringify(request.input ?? []);
    for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
      const clockHour = clockHourOf(taskIndex);
      for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
        const request = buildRequest(taskIndex, turn, clockHour);
        expect(wirePrompt(request)).toBe(preWidening(request));
        // The ?? fallbacks can never fire on this shape.
        expect(request.system).toBeUndefined();
        expect(request.messages).toBeUndefined();
        expect(Array.isArray(request.input)).toBe(true);
        expect(typeof request.instructions).toBe("string");
      }
    }
  });

  it("instructions/input win over poison system/messages keys, so the fallback order is right", () => {
    const request = buildRequest(3, 2, clockHourOf(3));
    const poisoned: AnyObject = {
      ...request,
      system: "POISON-SYSTEM",
      messages: [{ role: "user", content: "POISON latest reference R-999-999" }],
    };
    expect(answer(poisoned)).toEqual(answer(request));
    // wirePrompt reads system ?? instructions, so a present `system` wins by
    // design on a genuinely Anthropic-shaped request - but the OpenAI-shaped
    // fixture never carries one (asserted above), keeping the widening a
    // byte no-op there. Here we only pin the input ?? messages order:
    const inputPoisonedOnly: AnyObject = { ...request, messages: poisoned.messages };
    expect(wirePrompt(inputPoisonedOnly)).toBe(wirePrompt(request));
  });
});
