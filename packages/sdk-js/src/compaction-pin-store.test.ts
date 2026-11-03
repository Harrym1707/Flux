import { describe, expect, it } from "vitest";
import { CompactionPinStore } from "./compaction-pin-store.js";

describe("CompactionPinStore", () => {
  it("is a miss the first time and a hit on the same body, cap, and kind afterwards", () => {
    const pins = new CompactionPinStore();
    expect(pins.get("some stale body", 500, "tool-result")).toBeUndefined();
    pins.set("some stale body", 500, "tool-result", "short summary");
    expect(pins.get("some stale body", 500, "tool-result")).toEqual({ compacted: "short summary" });
  });

  it("pins the 'not shorter, use original' outcome too, not just a successful compaction", () => {
    const pins = new CompactionPinStore();
    pins.set("some stale body", 500, "tool-result", null);
    expect(pins.get("some stale body", 500, "tool-result")).toEqual({ compacted: null });
  });

  it("is keyed on the exact text: a single different byte is a miss", () => {
    const pins = new CompactionPinStore();
    pins.set("some stale body", 500, "tool-result", "summary A");
    expect(pins.get("some stale bodY", 500, "tool-result")).toBeUndefined();
  });

  it("is keyed on maxTokens: the same body at a different cap is a separate entry", () => {
    const pins = new CompactionPinStore();
    pins.set("some stale body", 500, "tool-result", "summary at 500");
    expect(pins.get("some stale body", 200, "tool-result")).toBeUndefined();
    pins.set("some stale body", 200, "tool-result", "summary at 200");
    expect(pins.get("some stale body", 500, "tool-result")).toEqual({ compacted: "summary at 500" });
    expect(pins.get("some stale body", 200, "tool-result")).toEqual({ compacted: "summary at 200" });
  });

  it("is keyed on kind: the same text under a different kind is a separate entry", () => {
    const pins = new CompactionPinStore();
    pins.set("x", 500, "tool-result", "a");
    expect(pins.get("x", 500, "other-kind")).toBeUndefined();
  });

  it("rejects a non-positive-integer maxEntries", () => {
    expect(() => new CompactionPinStore(0)).toThrow();
    expect(() => new CompactionPinStore(-1)).toThrow();
    expect(() => new CompactionPinStore(1.5)).toThrow();
  });

  it("evicts the least-recently-used entry once over capacity, and a get() counts as use", () => {
    const pins = new CompactionPinStore(2);
    pins.set("a", 10, "tool-result", "A");
    pins.set("b", 10, "tool-result", "B");
    // Touch "a" so it is no longer the least-recently-used.
    expect(pins.get("a", 10, "tool-result")).toEqual({ compacted: "A" });
    pins.set("c", 10, "tool-result", "C"); // over capacity: evicts "b", the true LRU.
    expect(pins.size).toBe(2);
    expect(pins.get("a", 10, "tool-result")).toEqual({ compacted: "A" });
    expect(pins.get("c", 10, "tool-result")).toEqual({ compacted: "C" });
    expect(pins.get("b", 10, "tool-result")).toBeUndefined();
  });
});
