import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

/**
 * Output-side diagnostics: METERING, not mutation.
 *
 * Ground truth from real agent trajectories (docs/rnd/knowledge/
 * 2026-10-26-output-token-ground-truth.md): ~24% of agent output tokens are
 * lines already present verbatim in the request context (re-printed files,
 * echoed tool results), output is ~29% of a well-cached agent's bill, and
 * the waste concentrates in a minority of large completions. Chat traffic
 * shows the same shape on later turns (p90 re-emission 61% on turn-2+
 * responses in WildChat).
 *
 * FLUX will not mutate model output — that is the deepest lossy territory
 * there is — but it CAN measure the waste per request and put the number in
 * front of the customer: the ledger records how many of a completion's
 * tokens were re-emissions of its own context, and the statement shows what
 * a diff-shaped integration would reclaim. Metering first; any mutation
 * lever earns its way through a replay gate later, sized by these numbers.
 *
 * Method mirrors the trajectory study so the numbers are comparable:
 * line-level, whitespace-normalized, leading line-number prefixes stripped,
 * lines under 8 significant characters ignored. Deterministic, content never
 * stored — only token counts leave this function.
 */

export type OutputReEmission = {
  /** Tokens of the completion text that were inspected (all of it). */
  inspectedOutputTokens: number;
  /** Tokens on lines already present verbatim in the request context. */
  reEmittedOutputTokens: number;
  /** Of the re-emitted tokens, those on lines that look like code. */
  reEmittedCodeTokens: number;
};

const LINE_NUMBER_PREFIX = /^\s*\d+[:.|]\s?/;

function normalizeLine(line: string): string {
  return line.replace(LINE_NUMBER_PREFIX, "").trim().replace(/\s+/g, " ");
}

/** Code-ish line heuristic: enough symbol density or classic code tokens. */
function looksLikeCode(line: string): boolean {
  if (/[{};=()[\]<>]/.test(line) && (line.match(/[{};=()[\]<>.:]/g) ?? []).length >= 3) return true;
  return /^(import |from |def |class |function |const |let |var |return |if |for |while |#include|public |private )/.test(line.trimStart());
}

/** Every string value in a request body, newline-joined, for line extraction. */
export function collectRequestText(value: unknown, depth = 0): string {
  if (depth > 12) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectRequestText(entry, depth + 1)).filter(Boolean).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.values(value).map((entry) => collectRequestText(entry, depth + 1)).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Measure what fraction of a completion is verbatim re-emission of lines the
 * request already contained. Pure and deterministic.
 */
export function measureOutputReEmission(
  requestText: string,
  outputText: string,
  countTokens: TokenCounter = approximateTokenCount,
): OutputReEmission {
  const contextLines = new Set<string>();
  for (const line of requestText.split("\n")) {
    const normalized = normalizeLine(line);
    if (normalized.length >= 8) contextLines.add(normalized);
  }
  let inspected = 0;
  let reEmitted = 0;
  let reEmittedCode = 0;
  for (const line of outputText.split("\n")) {
    const tokens = countTokens(line);
    inspected += tokens;
    const normalized = normalizeLine(line);
    if (normalized.length >= 8 && contextLines.has(normalized)) {
      reEmitted += tokens;
      if (looksLikeCode(normalized)) reEmittedCode += tokens;
    }
  }
  return {
    inspectedOutputTokens: inspected,
    reEmittedOutputTokens: reEmitted,
    reEmittedCodeTokens: reEmittedCode,
  };
}
