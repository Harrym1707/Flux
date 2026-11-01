import { describe, expect, it } from "vitest";
import { detectSideCall } from "../packages/sdk-js/src/index.js";
import { buildSession, LMSYS_LIKE, LONG_THREADS, WILDCHAT_LIKE } from "./side-call-fixture.js";

/**
 * The detector against the full rendered fixture: every real user turn
 * (including the adversarial look-alikes) must stay on the chat model, and
 * every Open WebUI side-call must be recognised as its own kind. A false
 * positive here would downgrade a real user turn to the cheap model.
 */
describe("side-call fixture", () => {
  for (const shape of [WILDCHAT_LIKE, LMSYS_LIKE, LONG_THREADS]) {
    it(`detector is exact on "${shape.name}"`, () => {
      const session = buildSession(shape, "claude-sonnet-5-5");
      for (const call of session) {
        const match = detectSideCall(call.request);
        if (call.truth === "main") expect(match, call.request.messages.at(-1)!.content.slice(0, 60)).toBeUndefined();
        else expect(match?.kind).toBe(call.truth);
      }
    });
  }

  it("matches Open WebUI's call frequency: title + tags once per chat, follow-ups every reply", () => {
    const session = buildSession(WILDCHAT_LIKE, "m");
    const count = (truth: string) => session.filter((call) => call.truth === truth).length;
    const chats = WILDCHAT_LIKE.turnsPerConversation.length;
    const turns = WILDCHAT_LIKE.turnsPerConversation.reduce((a, b) => a + b, 0);
    expect(count("title")).toBe(chats);
    expect(count("tags")).toBe(chats);
    expect(count("follow_ups")).toBe(turns);
    expect(count("main")).toBe(turns);
  });
});
