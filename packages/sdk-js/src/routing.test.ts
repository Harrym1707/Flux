import { describe, expect, it } from "vitest";
import { withFlux } from "./openai.js";
import type { FluxRoutingPolicy } from "./types.js";

describe("same-model context routes", () => {
  it("applies a reviewed context profile even when the provider model is unchanged", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      responses: {
        async create(request: Record<string, unknown>) {
          seen.push(request);
          return { request, usage: { input_tokens: 12, output_tokens: 2 } };
        },
      },
    };
    const policy: FluxRoutingPolicy = {
      id: "context-only-test",
      taskClass: "support",
      workflow: "reply",
      baselineModel: "same-model",
      minimumSamples: 20,
      minimumCandidateAccuracyLower95: 0.9,
      maximumAccuracyDrop: 0.02,
      candidates: [{
        model: "same-model",
        trafficShare: 1,
        approved: true,
        contextProfileId: "short-history-v1",
        evidence: {
          baselineModel: "same-model",
          candidateModel: "same-model",
          eligibleForReview: true,
          sampleSize: 100,
          candidateAccuracyLower95: 0.95,
          accuracyDrop: 0.01,
          baselineCostUsd: 1,
          candidateCostUsd: 0.8,
        },
      }],
    };
    const wrapped = withFlux(client, {
      applicationId: "test-app",
      getContext: () => ({ taskClass: "support", workflow: "reply" }),
      routing: { policies: [policy], getRequestKey: () => "stable-ticket-id" },
      contextProfiles: [{
        id: "short-history-v1",
        version: "1",
        match: { workflow: "reply" },
        transform: (request) => ({ ...(request as Record<string, unknown>), input: "summarized history" }),
      }],
    });

    await wrapped.responses.create({ model: "same-model", input: "full history" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe("same-model");
    expect(seen[0]!.input).toBe("summarized history");
  });
});
