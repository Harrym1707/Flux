import { estimateTokenCost } from "./cost.js";
import type {
  ReplayAdapter,
  ReplayInputCase,
  ReplayInvocation,
  ReplayRecord,
  ReplayTarget,
} from "./types.js";

export type ReplayRunFailure = {
  id: string;
  side: "baseline" | "candidate";
  message: string;
};

export type ReplayRunResult = {
  records: ReplayRecord[];
  failures: ReplayRunFailure[];
};

function invocationCost(
  invocation: ReplayInvocation,
  target: ReplayTarget,
): number | undefined {
  if (!target.pricing || invocation.inputTokens === undefined || invocation.outputTokens === undefined) {
    return undefined;
  }
  try {
    return estimateTokenCost(
      invocation.inputTokens,
      invocation.outputTokens,
      target.pricing,
      {
        cachedInputTokens: invocation.cachedInputTokens,
        cacheWriteInputTokens: invocation.cacheWriteInputTokens,
      },
    );
  } catch {
    return undefined;
  }
}

export async function runReplayCases(
  cases: ReplayInputCase[],
  baseline: ReplayTarget,
  candidate: ReplayTarget,
  adapter: ReplayAdapter,
): Promise<ReplayRunResult> {
  if (cases.length === 0) throw new Error("Replay needs at least one input case.");
  if (candidate.contextProfileId && cases.some((inputCase) => typeof inputCase.candidateInput !== "string")) {
    throw new Error(`Candidate context profile ${candidate.contextProfileId} needs candidateInput for every replay request.`);
  }
  const ids = new Set<string>();
  for (const inputCase of cases) {
    if (!inputCase.id || ids.has(inputCase.id)) {
      throw new Error("Replay input IDs must be non-empty and unique.");
    }
    ids.add(inputCase.id);
    if (typeof inputCase.input !== "string") {
      throw new Error(`Replay input ${inputCase.id} must contain a string input.`);
    }
  }

  const records: ReplayRecord[] = [];
  const failures: ReplayRunFailure[] = [];

  // Run one pair at a time to make ordering predictable and keep provider load bounded.
  for (const inputCase of cases) {
    const baselineResult = await invoke(adapter, inputCase, baseline, "baseline", failures);
    const candidateCase = inputCase.candidateInput === undefined
      ? inputCase
      : { ...inputCase, input: inputCase.candidateInput };
    const candidateResult = await invoke(adapter, candidateCase, candidate, "candidate", failures);

    records.push({
      id: inputCase.id,
      expected: inputCase.expected,
      baseline: baselineResult.output,
      candidate: candidateResult.output,
      baselineCostUsd: invocationCost(baselineResult, baseline),
      candidateCostUsd: invocationCost(candidateResult, candidate),
      baselineError: baselineResult.error !== undefined,
      candidateError: candidateResult.error !== undefined,
    });
  }

  return { records, failures };
}

async function invoke(
  adapter: ReplayAdapter,
  inputCase: ReplayInputCase,
  target: ReplayTarget,
  side: ReplayRunFailure["side"],
  failures: ReplayRunFailure[],
): Promise<ReplayInvocation> {
  try {
    const result = await adapter.invoke(inputCase, target);
    if (result.error !== undefined) {
      failures.push({ id: inputCase.id, side, message: result.error });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ id: inputCase.id, side, message });
    return { error: message };
  }
}
