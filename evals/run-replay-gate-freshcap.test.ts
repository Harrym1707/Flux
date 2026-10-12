import { describe, expect, it } from "vitest";
import { agentGrader, replayUsage } from "../packages/sdk-js/src/index.js";
import { type AnyObject } from "./agent-fixture.js";
import {
  FRESH_CAP_ISOLATION,
  buildFixtureRequests,
  createSimulatedProvider,
  runFreshCapGate,
} from "./run-replay-gate-freshcap.js";

/**
 * The gate wrapper is itself part of the evidence chain: if its responses did
 * not parse, or identical runs did not grade 1, or a destroyed reference did
 * not hard-fail, then a gate approval would mean nothing. These tests pin
 * those properties.
 */

describe("replay gate over the fresh tool-result cap", () => {
  it("produces responses the gate's own usage parser accepts", async () => {
    const provider = createSimulatedProvider();
    provider.beforeRun("test");
    const requests = buildFixtureRequests();
    // A late turn, so the request carries history and the cache has warmed.
    for (const request of requests.slice(0, 4)) await provider.call(request);
    const usage = replayUsage(await provider.call(requests[4]!));
    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBeGreaterThan(0);
    expect(usage!.outputTokens).toBeGreaterThan(0);
    expect(usage!.cachedInputTokens).toBeGreaterThan(0);
    expect(usage!.cachedInputTokens).toBeLessThanOrEqual(usage!.inputTokens);
  });

  it("grades two identical runs of the same request as exactly 1", async () => {
    const requests = buildFixtureRequests();
    const request = requests.find((row) => Number((row.metadata as AnyObject).turn) === 4)!;
    const provider = createSimulatedProvider();
    const grade = agentGrader();
    provider.beforeRun("baseline");
    const baselineResponse = await provider.call(request);
    provider.beforeRun("candidate");
    const candidateResponse = await provider.call(request);
    expect(await grade({ request, baselineResponse, candidateResponse })).toBe(1);
  });

  it("hard-fails a request whose latest reference was stripped", async () => {
    const requests = buildFixtureRequests();
    const request = requests.find((row) => Number((row.metadata as AnyObject).turn) === 4)!;
    const stripped = JSON.parse(JSON.stringify(request)) as AnyObject;
    stripped.input = (stripped.input as AnyObject[]).map((message) =>
      typeof message.content === "string"
        ? { ...message, content: message.content.replaceAll("latest reference", "redacted") }
        : message);

    const provider = createSimulatedProvider();
    const grade = agentGrader();
    provider.beforeRun("baseline");
    const baselineResponse = await provider.call(request);
    provider.beforeRun("candidate");
    const candidateResponse = await provider.call(stripped);
    // The shared fixture's answer() fails the task, so the simulated response
    // diverges in both tool name and embedded reference: a hard zero.
    expect(await grade({ request, baselineResponse, candidateResponse })).toBe(0);
  });

  it("approves the isolated fresh cap at exactly zero quality delta with tokens saved", async () => {
    // The first 8 tasks (40 requests) include a 4,000-token and an
    // 1,800-token task, so the long-output tail is represented.
    const subset = buildFixtureRequests()
      .filter((row) => Number((row.metadata as AnyObject).taskIndex) < 8);
    const result = await runFreshCapGate(subset, [FRESH_CAP_ISOLATION]);
    const verdict = result.candidates[0]!;
    expect(verdict.failed).toBe(0);
    expect(verdict.graded).toBe(subset.length);
    expect(verdict.meanQualityDelta).toBe(0);
    expect(verdict.lower95QualityDelta).toBe(0);
    expect(verdict.inputTokensSaved).toBeGreaterThan(0);
    expect(verdict.approved).toBe(true);
    expect(result.approved?.label).toBe(FRESH_CAP_ISOLATION.label);
  });
});
