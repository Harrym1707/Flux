import { providerCompactionUsage } from "../../core/dist/src/index.js";
import type { FluxRequestEvent } from "./types.js";

/**
 * The FluxRequestEvent `compaction` field for the provider responses one
 * request actually received (every attempt, never an exact-cache replay, which
 * made no provider call). Undefined when no compaction iteration ran, which is
 * every request without Anthropic's compaction beta. Token counts only.
 */
export function compactionEventField(responses: readonly unknown[]): FluxRequestEvent["compaction"] {
  let iterations = 0;
  let invalid: string | undefined;
  let seen = false;
  let splitKnownForAll = true;
  const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, write5m: 0, write1h: 0 };
  for (const response of responses) {
    const result = providerCompactionUsage(response);
    if (result.status === "none") continue;
    seen = true;
    iterations += result.iterations;
    if (result.status === "invalid") {
      invalid = result.reason;
      continue;
    }
    const usage = result.usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    if (usage.cacheWrite5mInputTokens === undefined && usage.cacheWrite1hInputTokens === undefined) {
      if (usage.cacheWriteInputTokens > 0) splitKnownForAll = false;
    } else {
      total.write5m += usage.cacheWrite5mInputTokens ?? 0;
      total.write1h += usage.cacheWrite1hInputTokens ?? 0;
    }
  }
  if (!seen) return undefined;
  if (invalid !== undefined) return { iterations, invalid };
  const splitReported = splitKnownForAll && total.write5m + total.write1h === total.cacheWriteInputTokens &&
    total.cacheWriteInputTokens > 0;
  return {
    iterations,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cachedInputTokens: total.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens,
    ...(splitReported ? { cacheWrite5mInputTokens: total.write5m, cacheWrite1hInputTokens: total.write1h } : {}),
  };
}
