import { describe, expect, it } from "vitest";
import { collectRequestText, measureOutputReEmission } from "./output-diagnostics.js";

const CONTEXT = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "The deployment window is 14:00-16:00 UTC and must not be moved.",
].join("\n");

describe("measureOutputReEmission", () => {
  it("counts lines the completion re-emits from the request, code flagged as code", () => {
    const output = [
      "Here is the updated file:",
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "I changed nothing else.",
    ].join("\n");
    const result = measureOutputReEmission(CONTEXT, output);
    expect(result.reEmittedOutputTokens).toBeGreaterThan(0);
    expect(result.reEmittedCodeTokens).toBeGreaterThan(0);
    expect(result.reEmittedOutputTokens).toBeLessThan(result.inspectedOutputTokens);
  });

  it("ignores short lines and strips line-number prefixes before matching", () => {
    const result = measureOutputReEmission(
      "42: The deployment window is 14:00-16:00 UTC and must not be moved.",
      "The deployment window is 14:00-16:00 UTC and must not be moved.\nok",
    );
    expect(result.reEmittedOutputTokens).toBeGreaterThan(0);
  });

  it("reports zero re-emission for novel output", () => {
    const result = measureOutputReEmission(CONTEXT, "A completely novel sentence about gardening practices.");
    expect(result.reEmittedOutputTokens).toBe(0);
    expect(result.inspectedOutputTokens).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const a = measureOutputReEmission(CONTEXT, CONTEXT);
    const b = measureOutputReEmission(CONTEXT, CONTEXT);
    expect(a).toEqual(b);
  });
});

describe("collectRequestText", () => {
  it("collects nested string fields from a request body", () => {
    const text = collectRequestText({
      system: "top rule line that is long enough",
      messages: [{ role: "user", content: [{ type: "text", text: "nested text line long enough" }] }],
    });
    expect(text).toContain("top rule line");
    expect(text).toContain("nested text line");
  });
});
