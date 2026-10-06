import { evaluateReplay } from "../packages/core/src/replay.js";
import type { ReplayPolicy, ReplayRecord } from "../packages/core/src/types.js";
import { withFlux } from "../packages/sdk-js/src/openai.js";
import { chooseRoute } from "../packages/sdk-js/src/routing.js";
import type { FluxRequestEvent, FluxRoutingPolicy } from "../packages/sdk-js/src/types.js";

const baselineModel = "baseline-model";
const candidateModel = "lower-cost-model";
const records: ReplayRecord[] = Array.from({ length: 200 }, (_, index) => {
  const expected = ["billing", "technical", "other"][index % 3];
  return {
    id: `case-${index}`,
    expected,
    baseline: expected,
    candidate: expected,
    baselineCostUsd: 0.01,
    candidateCostUsd: 0.002,
  };
});
const replayPolicy: ReplayPolicy = {
  evaluator: "classification",
  minimumSamples: 200,
  minimumCandidateAccuracy: 0.95,
  maximumAccuracyDrop: 0.02,
  maximumCandidateErrorRate: 0.01,
  minimumCostSavingsPercent: 20,
};
const report = evaluateReplay(records, replayPolicy);

if (!report.eligibleForReview || report.baselineCostUsd === null || report.candidateCostUsd === null) {
  throw new Error("Demo replay failed its routing eligibility gates.");
}

const routingPolicy: FluxRoutingPolicy = {
  id: "local-demo-v1",
  taskClass: "classification",
  baselineModel,
  minimumSamples: replayPolicy.minimumSamples,
  minimumCandidateAccuracyLower95: replayPolicy.minimumCandidateAccuracy,
  maximumAccuracyDrop: replayPolicy.maximumAccuracyDrop!,
  candidates: [{
    model: candidateModel,
    trafficShare: 0.25,
    approved: true,
    maxOutputTokens: 40,
    evidence: {
      baselineModel,
      candidateModel,
      eligibleForReview: report.eligibleForReview,
      sampleSize: report.sampleSize,
      candidateAccuracyLower95: report.candidateAccuracyLower95,
      accuracyDrop: report.accuracyDrop,
      baselineCostUsd: report.baselineCostUsd,
      candidateCostUsd: report.candidateCostUsd,
    },
  }],
};
const routing = {
  policies: [routingPolicy],
    getRequestKey: (request: unknown) => (request as { metadata?: { jobId?: string } }).metadata?.jobId,
};

const expectedById = new Map(records.map((record) => [record.id, String(record.expected)]));
const liveDriftId = records.find((record) => chooseRoute(
  routing,
  { model: baselineModel, metadata: { jobId: record.id } },
  "classification",
).model === candidateModel)?.id;
if (!liveDriftId) throw new Error("Demo could not find a request in the candidate cohort.");
const events: FluxRequestEvent[] = [];
let fallbackOutputLimit: number | undefined;
const rawClient = {
  responses: {
    async create(request: { model: string; max_output_tokens?: number; metadata?: { jobId?: string } }) {
      const id = request.metadata?.jobId ?? "";
      if (request.model === baselineModel && id === liveDriftId) fallbackOutputLimit = request.max_output_tokens;
      const expected = expectedById.get(id) ?? "other";
      const outputText = request.model === candidateModel && id === liveDriftId ? "wrong-answer" : expected;
      return {
        output_text: outputText,
        usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 200 }, output_tokens: 10 },
      };
    },
  },
};
const client = withFlux(rawClient, {
  applicationId: "flux-routing-demo",
  classify: () => "classification",
  pricingByModel: {
    [baselineModel]: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 8 },
    [candidateModel]: { inputPerMillion: 0.4, cachedInputPerMillion: 0.04, outputPerMillion: 1.6 },
  },
  routing: {
    ...routing,
  },
  exactCache: {
    maxEntries: 500,
    ttlMs: 60_000,
    getScopeKey: (request) => (request as { metadata?: { tenantId?: string } }).metadata?.tenantId,
  },
  qualityCheck: ({ request, response }) => {
    const id = (request as { metadata?: { jobId?: string } }).metadata?.jobId;
    return (response as { output_text?: string }).output_text === expectedById.get(id ?? "");
  },
  onEvent: (event) => events.push(event),
});

for (const record of records) {
  await client.responses.create({
    model: baselineModel,
    max_output_tokens: 120,
    input: "Classify this synthetic support request.",
    metadata: { tenantId: "demo-tenant", jobId: record.id },
  });
}
const cacheRepeat = records.find((record) => record.id !== liveDriftId)!;
await client.responses.create({
  model: baselineModel,
  max_output_tokens: 120,
  input: "Classify this synthetic support request.",
  metadata: { tenantId: "demo-tenant", jobId: cacheRepeat.id },
});
await new Promise<void>((resolve) => setImmediate(resolve));

const candidateAttempts = events.filter((event) => event.modelsAttempted?.includes(candidateModel)).length;
const routedCount = events.filter((event) => event.model === candidateModel).length;
const fallbackCount = events.filter((event) => event.fallbackUsed).length;
const cacheHits = events.filter((event) => event.cacheHit).length;
const tokensAvoided = events.reduce((sum, event) => sum + (event.tokensAvoided ?? 0), 0);
const costAvoided = events.reduce((sum, event) => sum + (event.costAvoidedUsd ?? 0), 0);
const actualSpend = events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
const providerCachedTokens = events.reduce((sum, event) => sum + (event.cachedInputTokens ?? 0), 0);
const allBaselineSpend = events.length * ((300 / 1_000_000) * 2 + (200 / 1_000_000) * 0.2 + (10 / 1_000_000) * 8);
const actualSavingsPercent = allBaselineSpend > 0 ? (1 - actualSpend / allBaselineSpend) * 100 : 0;

console.log("FLUX cost-quality routing MVP · all data is synthetic · no model/API calls\n");
console.log(`Offline quality: ${(report.candidateAccuracy * 100).toFixed(1)}% candidate vs ${(report.baselineAccuracy * 100).toFixed(1)}% baseline`);
console.log(`Candidate 95% lower bound: ${(report.candidateAccuracyLower95 * 100).toFixed(1)}% (floor ${(replayPolicy.minimumCandidateAccuracy * 100).toFixed(1)}%)`);
console.log(`Replay cost: $${report.baselineCostUsd.toFixed(3)} -> $${report.candidateCostUsd.toFixed(3)} (${report.costSavingsPercent?.toFixed(1)}% lower)`);
console.log(`Replay gates: ${report.gates.filter((gate) => gate.passed).length}/${report.gates.length} passed; candidate approved for a 25% stable canary`);
console.log(`Mock routing: ${candidateAttempts}/${events.length} tried ${candidateModel}; ${routedCount} finished on candidate, ${fallbackCount} failed live quality check and fell back to ${baselineModel}`);
console.log(`Candidate output cap: 40 tokens; fallback preserved the original ${fallbackOutputLimit}-token limit`);
console.log(`Exact cache: ${cacheHits} hit, ${tokensAvoided} tokens and $${costAvoided.toFixed(6)} inference cost avoided`);
console.log(`Provider prompt cache: ${providerCachedTokens.toLocaleString()} cached input tokens priced at cache-read rates`);
console.log(`Mock live spend: $${actualSpend.toFixed(5)} vs $${allBaselineSpend.toFixed(5)} all-baseline (${actualSavingsPercent.toFixed(1)}% lower)`);
