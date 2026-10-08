import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { estimateTokenCost } from "../packages/core/src/cost.js";
import { evaluateReplay } from "../packages/core/src/replay.js";
import type { ReplayPolicy, ReplayRecord } from "../packages/core/src/types.js";
import { withFlux } from "../packages/sdk-js/src/openai.js";
import type {
  FluxContextProfile,
  FluxRequestContext,
  FluxRequestEvent,
  FluxRoutingPolicy,
} from "../packages/sdk-js/src/types.js";

type Model = {
  id: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWriteInputPerMillion: number;
  outputPerMillion: number;
  outputLengthFactor: number;
};

type Workflow = {
  id: string;
  labels: string[];
  profile: { id: string; version: string; keepInputRatio: number };
};

type SimulationCase = {
  id: string;
  workflow: string;
  index: number;
  expected: string;
  inputTokens: number;
  outputTokens: number;
  difficulty: "low" | "medium" | "high";
  riskLevel: "low" | "high";
};

const models: Model[] = [
  { id: "frontier", inputPerMillion: 2, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5, outputPerMillion: 8, outputLengthFactor: 1 },
  { id: "balanced", inputPerMillion: 0.55, cachedInputPerMillion: 0.055, cacheWriteInputPerMillion: 0.6875, outputPerMillion: 2.2, outputLengthFactor: 0.9 },
  { id: "compact", inputPerMillion: 0.14, cachedInputPerMillion: 0.014, cacheWriteInputPerMillion: 0.175, outputPerMillion: 0.56, outputLengthFactor: 0.78 },
];

const workflows: Workflow[] = [
  { id: "support.triage", labels: ["billing", "technical", "account"], profile: { id: "support-triage-v1", version: "1", keepInputRatio: 0.58 } },
  { id: "invoice.extract", labels: ["complete", "missing_fields", "needs_review"], profile: { id: "invoice-fields-v2", version: "2", keepInputRatio: 0.76 } },
  { id: "thread.reply", labels: ["resolved", "escalate", "ask_followup"], profile: { id: "thread-summary-v1", version: "1", keepInputRatio: 0.42 } },
];

// Synthetic error counts over the low-risk replay cohort. These are workload fixtures,
// not measured provider benchmarks. A changed count deterministically changes the gate.
const candidateErrors: Record<string, Record<string, { full: number; profile: number }>> = {
  "support.triage": {
    balanced: { full: 1, profile: 1 },
    compact: { full: 4, profile: 1 },
  },
  "invoice.extract": {
    balanced: { full: 1, profile: 2 },
    compact: { full: 8, profile: 12 },
  },
  "thread.reply": {
    balanced: { full: 1, profile: 2 },
    compact: { full: 9, profile: 15 },
  },
};

const replayPolicy: ReplayPolicy = {
  evaluator: "classification",
  minimumSamples: 48,
  minimumCandidateAccuracy: 0.84,
  maximumAccuracyDrop: 0.08,
  maximumCandidateErrorRate: 0,
  minimumCostSavingsPercent: 15,
};

const modelById = new Map(models.map((model) => [model.id, model]));
const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
const tokenChoices = [320, 640, 1_200, 2_400, 5_000, 9_500, 18_000, 32_000];
const outputChoices = [32, 56, 96, 160, 260, 420, 680];

const cases: SimulationCase[] = workflows.flatMap((workflow, workflowIndex) =>
  Array.from({ length: 60 }, (_, index) => ({
    id: `${workflow.id}:${String(index + 1).padStart(3, "0")}`,
    workflow: workflow.id,
    index,
    expected: workflow.labels[(index * 7 + workflowIndex) % workflow.labels.length],
    inputTokens: tokenChoices[(index * 5 + workflowIndex * 3) % tokenChoices.length],
    outputTokens: outputChoices[(index * 3 + workflowIndex) % outputChoices.length],
    difficulty: index % 7 === 0 ? "high" as const : index % 3 === 0 ? "medium" as const : "low" as const,
    riskLevel: index % 6 === 0 ? "high" as const : "low" as const,
  })),
);

const caseById = new Map(cases.map((inputCase) => [inputCase.id, inputCase]));
const lowRiskByWorkflow = new Map(workflows.map((workflow) => [
  workflow.id,
  cases.filter((inputCase) => inputCase.workflow === workflow.id && inputCase.riskLevel === "low"),
]));

function modelCost(model: Model, inputTokens: number, outputTokens: number, caseIndex: number): number {
  const cacheWriteInputTokens = caseIndex % 17 === 0 ? Math.floor(inputTokens * 0.18) : 0;
  const cachedInputTokens = cacheWriteInputTokens > 0
    ? 0
    : caseIndex % 3 === 0 ? Math.floor(inputTokens * (caseIndex % 2 === 0 ? 0.45 : 0.24)) : 0;
  return estimateTokenCost(inputTokens, outputTokens, model, { cachedInputTokens, cacheWriteInputTokens });
}

function inputTokensFor(inputCase: SimulationCase, profileId?: string): number {
  const workflow = workflowById.get(inputCase.workflow)!;
  if (!profileId) return inputCase.inputTokens;
  return Math.max(48, Math.round(inputCase.inputTokens * workflow.profile.keepInputRatio));
}

/** One whitespace-delimited fixture unit stands for one synthetic input token. */
function syntheticInputFor(inputCase: SimulationCase): string {
  const contextUnits = Array.from({ length: Math.max(0, inputCase.inputTokens - 2) }, (_, index) => `context${index}`);
  return ["request", ...contextUnits, `task${inputCase.id}`].join(" ");
}

function reduceSyntheticInput(input: string, keepRatio: number): string {
  const units = input.trim().split(/\s+/u).filter(Boolean);
  const targetSize = Math.min(units.length, Math.max(48, Math.round(units.length * keepRatio)));
  if (targetSize === units.length) return input;
  const prefixSize = Math.ceil(targetSize / 2);
  const suffixSize = targetSize - prefixSize;
  return [...units.slice(0, prefixSize), ...units.slice(units.length - suffixSize)].join(" ");
}

function outputTokensFor(inputCase: SimulationCase, model: Model): number {
  return Math.max(8, Math.ceil(inputCase.outputTokens * model.outputLengthFactor));
}

function contextProfiles(): FluxContextProfile[] {
  return workflows.map((workflow) => ({
    id: workflow.profile.id,
    version: workflow.profile.version,
    match: { workflow: workflow.id },
    transform: (request: unknown) => {
      const body = request as { input?: string; metadata?: Record<string, string> };
      return {
        ...body,
        input: reduceSyntheticInput(body.input ?? "", workflow.profile.keepInputRatio),
        metadata: { ...body.metadata, fluxContextProfileId: workflow.profile.id },
      };
    },
  }));
}

function simulatedErrors(workflowId: string, modelId: string, profileId?: string): Set<string> {
  const candidate = candidateErrors[workflowId]?.[modelId];
  if (!candidate) return new Set();
  const cohort = lowRiskByWorkflow.get(workflowId) ?? [];
  const count = profileId ? candidate.profile : candidate.full;
  return new Set(Array.from({ length: count }, (_, errorIndex) => {
    const caseIndex = Math.floor(((errorIndex + 1) * cohort.length) / (count + 1));
    return cohort[caseIndex]?.id;
  }).filter((id): id is string => id !== undefined));
}

type Alternative = {
  workflow: string;
  model: string;
  contextProfileId?: string;
  contextProfileVersion?: string;
  report: ReturnType<typeof evaluateReplay>;
};

function evaluateAlternatives(): Alternative[] {
  const alternatives: Alternative[] = [];
  for (const workflow of workflows) {
    const replayCases = lowRiskByWorkflow.get(workflow.id)!;
    const baseline = models[0];
    const baselineCosts = replayCases.map((inputCase) => modelCost(
      baseline,
      inputCase.inputTokens,
      outputTokensFor(inputCase, baseline),
      inputCase.index,
    ));

    for (const model of models.slice(1)) {
      for (const profileId of [undefined, workflow.profile.id]) {
        const wrongIds = simulatedErrors(workflow.id, model.id, profileId);
        const records: ReplayRecord[] = replayCases.map((inputCase, index) => {
          const candidateInputTokens = inputTokensFor(inputCase, profileId);
          return {
            id: inputCase.id,
            expected: inputCase.expected,
            baseline: inputCase.expected,
            candidate: wrongIds.has(inputCase.id) ? "low_quality_output" : inputCase.expected,
            baselineCostUsd: baselineCosts[index],
            candidateCostUsd: modelCost(
              model,
              candidateInputTokens,
              outputTokensFor(inputCase, model),
              inputCase.index,
            ),
          };
        });
        alternatives.push({
          workflow: workflow.id,
          model: model.id,
          contextProfileId: profileId,
          contextProfileVersion: profileId ? workflow.profile.version : undefined,
          report: evaluateReplay(records, replayPolicy),
        });
      }
    }
  }
  return alternatives;
}

const alternatives = evaluateAlternatives();
const selectedByWorkflow = new Map<string, Alternative>();
const routingPolicies: FluxRoutingPolicy[] = workflows.flatMap((workflow) => {
  const eligible = alternatives
    .filter((alternative) => alternative.workflow === workflow.id && alternative.report.eligibleForReview)
    .sort((left, right) => left.report.candidateCostUsd! - right.report.candidateCostUsd!);
  const selected = eligible[0];
  if (!selected) return [];
  selectedByWorkflow.set(workflow.id, selected);
  return [{
    id: `simulation-${workflow.id}`,
    taskClass: "assistant-workflow",
    workflow: workflow.id,
    riskLevel: "low",
    baselineModel: models[0].id,
    minimumSamples: replayPolicy.minimumSamples,
    minimumCandidateAccuracyLower95: replayPolicy.minimumCandidateAccuracy,
    maximumAccuracyDrop: replayPolicy.maximumAccuracyDrop!,
    candidates: [{
      model: selected.model,
      trafficShare: 1,
      approved: true,
      contextProfileId: selected.contextProfileId,
      evidence: {
        baselineModel: models[0].id,
        candidateModel: selected.model,
        eligibleForReview: selected.report.eligibleForReview,
        sampleSize: selected.report.sampleSize,
        candidateAccuracyLower95: selected.report.candidateAccuracyLower95,
        accuracyDrop: selected.report.accuracyDrop,
        baselineCostUsd: selected.report.baselineCostUsd!,
        candidateCostUsd: selected.report.candidateCostUsd!,
      },
    }],
  }];
});

const providerCalls: Array<{ caseId: string; workflow: string; model: string; contextProfileId?: string; inputTokens: number; originalInputTokens: number; outputTokens: number }> = [];
const events: FluxRequestEvent[] = [];
const responses = new Map<string, string>();
const correctByCase = new Map(cases.map((inputCase) => [inputCase.id, inputCase.expected]));
const rawClient = {
  responses: {
    async create(request: { model: string; metadata?: Record<string, string>; input?: string }) {
      const caseId = request.metadata?.caseId ?? "";
      const inputCase = caseById.get(caseId);
      const model = modelById.get(request.model);
      if (!inputCase || !model) throw new Error("Simulation received an unknown case or model.");
      const profileId = request.metadata?.fluxContextProfileId;
      const wrongIds = simulatedErrors(inputCase.workflow, model.id, profileId);
      const output = wrongIds.has(caseId) ? "low_quality_output" : inputCase.expected;
      const inputTokens = request.input?.trim().split(/\s+/u).filter(Boolean).length ?? 0;
      const expectedInputTokens = inputTokensFor(inputCase, profileId);
      if (inputTokens !== expectedInputTokens) {
        throw new Error(`Synthetic context transform produced ${inputTokens} token units; expected ${expectedInputTokens}.`);
      }
      const outputTokens = outputTokensFor(inputCase, model);
      const cacheWriteInputTokens = inputCase.index % 17 === 0 ? Math.floor(inputTokens * 0.18) : 0;
      const cachedInputTokens = cacheWriteInputTokens > 0
        ? 0
        : inputCase.index % 3 === 0 ? Math.floor(inputTokens * (inputCase.index % 2 === 0 ? 0.45 : 0.24)) : 0;
      providerCalls.push({ caseId, workflow: inputCase.workflow, model: model.id, contextProfileId: profileId, inputTokens, originalInputTokens: inputCase.inputTokens, outputTokens });
      return {
        output_text: output,
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedInputTokens, cache_write_tokens: cacheWriteInputTokens },
          output_tokens: outputTokens,
        },
      };
    },
  },
};

const client = withFlux(rawClient, {
  applicationId: "flux-context-simulation",
  classify: () => "assistant-workflow",
  getContext: (request) => {
    const metadata = (request as { metadata?: Record<string, string> }).metadata ?? {};
    return {
      workflow: metadata.workflow,
      difficulty: metadata.difficulty as FluxRequestContext["difficulty"],
      riskLevel: metadata.riskLevel as FluxRequestContext["riskLevel"],
    };
  },
  contextProfiles: contextProfiles(),
  pricingByModel: Object.fromEntries(models.map((model) => [model.id, {
    inputPerMillion: model.inputPerMillion,
    cachedInputPerMillion: model.cachedInputPerMillion,
    cacheWriteInputPerMillion: model.cacheWriteInputPerMillion,
    outputPerMillion: model.outputPerMillion,
  }])),
  routing: {
    policies: routingPolicies,
    getRequestKey: (request) => (request as { metadata?: Record<string, string> }).metadata?.caseId,
  },
  qualityCheck: ({ request, response }) => {
    const caseId = (request as { metadata?: Record<string, string> }).metadata?.caseId ?? "";
    return (response as { output_text?: string }).output_text === correctByCase.get(caseId);
  },
  onEvent: (event) => events.push(event),
});

for (const inputCase of cases) {
  const response = await client.responses.create({
    model: models[0].id,
    input: syntheticInputFor(inputCase),
    metadata: {
      caseId: inputCase.id,
      workflow: inputCase.workflow,
      difficulty: inputCase.difficulty,
      riskLevel: inputCase.riskLevel,
    },
  });
  responses.set(inputCase.id, (response as { output_text: string }).output_text);
}
await new Promise<void>((done) => setImmediate(done));

function tokensFor(inputCase: SimulationCase, model: Model, profileId?: string): { input: number; output: number } {
  return {
    input: inputTokensFor(inputCase, profileId),
    output: outputTokensFor(inputCase, model),
  };
}

const workflowResults = workflows.map((workflow) => {
  const workflowCases = cases.filter((inputCase) => inputCase.workflow === workflow.id);
  const workflowEvents = events.filter((event) => event.workflow === workflow.id);
  const workflowCalls = providerCalls.filter((call) => call.workflow === workflow.id);
  const selected = selectedByWorkflow.get(workflow.id);
  const baseline = models[0];
  const baselineSpend = workflowCases.reduce((sum, inputCase) => {
    const usage = tokensFor(inputCase, baseline);
    return sum + modelCost(baseline, usage.input, usage.output, inputCase.index);
  }, 0);
  const realizedSpend = workflowEvents.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  const finalCorrect = workflowCases.filter((inputCase) => responses.get(inputCase.id) === inputCase.expected).length;
  const highRiskEvents = workflowEvents.filter((event) => event.riskLevel === "high");
  const routedCalls = workflowCalls.filter((call) => call.model !== baseline.id);
  const profiledCalls = workflowCalls.filter((call) => call.contextProfileId !== undefined);
  const profiledInputTokens = profiledCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const profiledInputTokensRemoved = profiledCalls.reduce((sum, call) => sum + call.originalInputTokens - call.inputTokens, 0);
  const baselineEquivalentInputTokens = workflowCases.reduce((sum, inputCase) => sum + inputCase.inputTokens, 0);
  const actualProviderInputTokens = workflowCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const profile = selected?.contextProfileId
    ? `${selected.contextProfileId} v${selected.contextProfileVersion}`
    : "full context";
  return {
    workflow: workflow.id,
    sampleSize: workflowCases.length,
    selectedModel: selected?.model ?? baseline.id,
    contextProfile: profile,
    candidateQuality: selected ? selected.report.candidateAccuracy : 1,
    candidateAccuracyLower95: selected ? selected.report.candidateAccuracyLower95 : 1,
    highRiskBaselineRequests: highRiskEvents.length,
    candidateProviderCalls: routedCalls.length,
    profiledProviderCalls: profiledCalls.length,
    profiledInputTokens,
    inputTokensRemovedByProfileTransforms: profiledInputTokensRemoved,
    baselineEquivalentInputTokens,
    actualProviderInputTokens,
    netInputTokensSavedVsOneBaselineCallPerRequest: baselineEquivalentInputTokens - actualProviderInputTokens,
    finalQuality: finalCorrect / workflowCases.length,
    fallbackCount: workflowEvents.filter((event) => event.fallbackUsed).length,
    baselineSpendUsd: baselineSpend,
    simulatedSpendUsd: realizedSpend,
    simulatedSavingsPercent: baselineSpend > 0 ? (1 - realizedSpend / baselineSpend) * 100 : 0,
  };
});

const modelEvaluations = alternatives.map((alternative) => ({
  workflow: alternative.workflow,
  model: alternative.model,
  contextProfile: alternative.contextProfileId ?? "full",
  sampleSize: alternative.report.sampleSize,
  quality: alternative.report.candidateAccuracy,
  qualityLower95: alternative.report.candidateAccuracyLower95,
  accuracyDrop: alternative.report.accuracyDrop,
  baselineCostUsd: alternative.report.baselineCostUsd,
  candidateCostUsd: alternative.report.candidateCostUsd,
  savingsPercent: alternative.report.costSavingsPercent,
  gatesPassed: alternative.report.gates.filter((gate) => gate.passed).length,
  gatesTotal: alternative.report.gates.length,
  eligible: alternative.report.eligibleForReview,
}));

const report = {
  name: "FLUX contextual routing simulation",
  generatedAt: new Date().toISOString(),
  mode: "synthetic_no_provider_calls",
  notice: "Synthetic fixture results validate simulation plumbing only; they are not measured model benchmarks or proof of real-world quality/savings.",
  replayPolicy,
  models,
  workflowResults,
  modelEvaluations,
  totals: {
    requestCount: cases.length,
    providerCallCount: providerCalls.length,
    modelCount: models.length,
    workflowCount: workflows.length,
    overallFinalQuality: cases.filter((inputCase) => responses.get(inputCase.id) === inputCase.expected).length / cases.length,
    overallBaselineSpendUsd: workflowResults.reduce((sum, result) => sum + result.baselineSpendUsd, 0),
    overallSimulatedSpendUsd: workflowResults.reduce((sum, result) => sum + result.simulatedSpendUsd, 0),
    overallBaselineInputTokens: workflowResults.reduce((sum, result) => sum + result.baselineEquivalentInputTokens, 0),
    overallActualProviderInputTokens: workflowResults.reduce((sum, result) => sum + result.actualProviderInputTokens, 0),
    overallInputTokensRemovedByProfileTransforms: workflowResults.reduce((sum, result) => sum + result.inputTokensRemovedByProfileTransforms, 0),
    overallNetInputTokensSavedVsOneBaselineCallPerRequest: workflowResults.reduce((sum, result) => sum + result.netInputTokensSavedVsOneBaselineCallPerRequest, 0),
    fallbackCount: events.filter((event) => event.fallbackUsed).length,
    candidateAttempts: events.filter((event) => event.modelsAttempted?.some((model) => model !== models[0].id)).length,
    allHighRiskRequestsStayedOnBaseline: events.filter((event) => event.riskLevel === "high" && event.model === models[0].id).length ===
      cases.filter((inputCase) => inputCase.riskLevel === "high").length,
  },
};
const totals = report.totals;
const overallSavings = totals.overallBaselineSpendUsd > 0
  ? (1 - totals.overallSimulatedSpendUsd / totals.overallBaselineSpendUsd) * 100
  : 0;

console.log("FLUX contextual routing simulation · synthetic data · no provider calls\n");
console.log(`${totals.requestCount} requests across ${totals.workflowCount} workflows; ${totals.modelCount} model tiers; input sizes from 320 to 32,000 synthetic token units.`);
console.log("Workflow                 Routed model  Context profile             Candidate quality / lower95  Final quality  Profile units removed  Net input saved  Savings");
for (const result of workflowResults) {
  console.log(
    `${result.workflow.padEnd(24)} ${result.selectedModel.padEnd(13)} ${result.contextProfile.padEnd(27)} ` +
    `${(result.candidateQuality * 100).toFixed(1)}% / ${(result.candidateAccuracyLower95 * 100).toFixed(1)}%` +
    `${(result.finalQuality * 100).toFixed(1).padStart(6)}%       ` +
    `${result.inputTokensRemovedByProfileTransforms.toLocaleString().padStart(10)}          ` +
    `${result.netInputTokensSavedVsOneBaselineCallPerRequest.toLocaleString().padStart(8)}       ` +
    `${result.simulatedSavingsPercent.toFixed(1)}%`,
  );
}
console.log(`\nModel/profile evaluations meeting all replay gates: ${modelEvaluations.filter((evaluation) => evaluation.eligible).length}/${modelEvaluations.length}`);
console.log(`Quality-check fallbacks: ${totals.fallbackCount}; high-risk requests stayed on baseline: ${totals.allHighRiskRequestsStayedOnBaseline}`);
console.log(`Overall synthetic spend: $${totals.overallSimulatedSpendUsd.toFixed(4)} vs $${totals.overallBaselineSpendUsd.toFixed(4)} baseline (${overallSavings.toFixed(1)}% lower)`);
console.log(`Synthetic input units: ${totals.overallInputTokensRemovedByProfileTransforms.toLocaleString()} removed by context transforms; ${totals.overallNetInputTokensSavedVsOneBaselineCallPerRequest.toLocaleString()} net saved vs one full-context baseline call per request.`);

const outputIndex = process.argv.indexOf("--out");
if (outputIndex >= 0) {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath || outputPath.startsWith("--")) throw new Error("--out needs a file path.");
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Detailed model/workflow report written to ${absolutePath}`);
}
