import { describe, expect, it } from "vitest";
import { ARMS, buildSession, measureArm } from "./run-tool-output-compression.js";

describe("read-less eval (tool-output compression, net of caching)", () => {
  const stream = buildSession({ includeHtml: false });
  const [a, b, c] = ARMS.map((arm) => measureArm(arm, stream));

  it("every arm carries FLUX's cache stamp on every request, so the comparison is net of caching", () => {
    for (const result of [a!, b!, c!]) expect(result.stampedRequests).toBe(stream.length);
  });

  it("every arm is byte-stable across turns (compressed once, re-sent identically)", () => {
    for (const result of [a!, b!, c!]) expect(result.byteStable, result.id).toBe(true);
  });

  it("lossless never costs more than baseline, lossy saves more than lossless", () => {
    expect(b!.simulatorCostUsd).toBeLessThanOrEqual(a!.simulatorCostUsd);
    expect(c!.simulatorCostUsd).toBeLessThan(b!.simulatorCostUsd);
    expect(b!.breakpointCostUsd).toBeLessThanOrEqual(a!.breakpointCostUsd);
    expect(c!.breakpointCostUsd).toBeLessThan(b!.breakpointCostUsd);
  });

  it("the file read passes verbatim in every arm, and the lossless arm reports no lossy savings", () => {
    expect(b!.byType["file-read"]).toEqual(a!.byType["file-read"]);
    expect(c!.byType["file-read"]).toEqual(a!.byType["file-read"]);
    expect(b!.lossySaved).toBe(0);
    expect(c!.lossySaved).toBeGreaterThan(0);
  });
});
