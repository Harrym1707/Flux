import { type TokenCounter } from "./token-reduction.js";
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
 * MESH will not mutate model output — that is the deepest lossy territory
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
/** Every string value in a request body, newline-joined, for line extraction. */
export declare function collectRequestText(value: unknown, depth?: number): string;
/**
 * Measure what fraction of a completion is verbatim re-emission of lines the
 * request already contained. Pure and deterministic.
 */
export declare function measureOutputReEmission(requestText: string, outputText: string, countTokens?: TokenCounter): OutputReEmission;
