import { type TokenPrice } from "./cost.js";
/**
 * Composable cost-reduction model.
 *
 * A single lever looks unimpressive. Model routing on LLMRouterBench's MMLU-Pro
 * returned 9.73% and bought it with quality. The levers below are different in
 * two ways: most of them do not touch the answer, and they attack disjoint parts
 * of a request, so they compose rather than compete.
 *
 * A request is modelled as segments, because each lever only reaches some of
 * them. Tool-schema minification cannot help a RAG prompt with no tools, and
 * prefix caching cannot help the one segment that changes every request. Summing
 * headline percentages across levers double-counts; applying them to the
 * segments they actually target does not.
 *
 * Order matters and is fixed: reducers shrink segments first, then caching prices
 * whatever stable tokens remain. Minifying a tool catalogue and then caching it
 * must charge the cache rate on the minified size, not the original.
 *
 * Every lever carries the published evidence for its reduction factor. Those
 * factors come from their authors' benchmarks, not from FLUX measuring them on
 * your traffic, so a projection from this model is a hypothesis to verify by
 * replay, never a realised saving. Realised savings come from provider-reported
 * usage priced through the catalogue.
 */
export type WorkloadSegment = "toolSchemas" | "systemPrompt" | "retrievedContext" | "history" | "userTurn" | "output";
export declare const INPUT_SEGMENTS: readonly WorkloadSegment[];
/**
 * How confident a saving is before it is measured on the customer's own traffic.
 *
 * - `deterministic`: the request is provably equivalent, or the provider bills
 *   the same tokens at a lower rate. Nothing about the answer can change.
 * - `needs-verification`: the prompt or the output budget changes, so quality
 *   has to be shown to hold by replay before the lever is enabled.
 */
export type LeverRisk = "deterministic" | "needs-verification";
export type LeverEvidence = {
    /** Where the reduction factor comes from. */
    source: string;
    /** What that source measured, in its own terms. */
    claim: string;
};
export type Lever = {
    id: string;
    description: string;
    risk: LeverRisk;
    /** Segments this lever can reach; it has no effect on any other. */
    targets: readonly WorkloadSegment[];
    /** Share of targeted tokens removed, between 0 and 1. */
    reduction: number;
    /**
     * How this lever changes the number of calls a task takes. 1 leaves it
     * unchanged, 1.5 adds half a round trip per existing one, 0.3 removes most of
     * them. Above 1 can make a lever net negative however much it trims per
     * prompt, which is the whole reason this field exists: a published bench found
     * progressive disclosure modelled at ~77% delivering ~13%, because the router
     * it adds costs one extra round trip per novel tool call.
     */
    roundTripMultiplier?: number;
    evidence: LeverEvidence;
};
export type WorkloadProfile = {
    name: string;
    /** Requests the projection covers; caching needs more than one to pay off. */
    requests: number;
    /** Mean tokens per request in each segment. */
    segments: Record<WorkloadSegment, number>;
    /**
     * Segments byte-identical across requests, so a provider's prefix cache can
     * serve them. Order is the prompt order: caching stops at the first segment
     * that changes, so anything listed after a volatile segment cannot cache.
     */
    stableSegments: readonly WorkloadSegment[];
};
export type LeverContribution = {
    lever: string;
    risk: LeverRisk;
    tokensRemoved: number;
    costRemovedUsd: number;
    /** Share of the baseline bill this lever alone removes, given the levers before it. */
    sharePercent: number;
    evidence: LeverEvidence;
};
export type SavingsProjection = {
    workload: string;
    requests: number;
    baselineCostUsd: number;
    projectedCostUsd: number;
    savingUsd: number;
    savingPercent: number;
    /** The share achievable without any possibility of changing an answer. */
    deterministicSavingPercent: number;
    /** The additional share that requires a replay check before rollout. */
    needsVerificationSavingPercent: number;
    contributions: LeverContribution[];
    inputTokensBefore: number;
    inputTokensAfter: number;
    outputTokensBefore: number;
    outputTokensAfter: number;
    cachedInputTokens: number;
    /** Calls per task before any lever. */
    roundTripsBefore: number;
    /** Calls per task after every lever's effect on call count. */
    roundTripsAfter: number;
    warnings: string[];
};
/**
 * Published levers, with the evidence for each factor.
 *
 * Factors are deliberately set at or below the conservative end of what each
 * source reports. A model that projects a vendor's best-case number is the thing
 * this project exists to argue against.
 */
export declare const PUBLISHED_LEVERS: Record<string, Lever>;
/**
 * Project the cost of a workload after a set of levers.
 *
 * Caching is applied last and only to stable segments that remain contiguous
 * from the start of the prompt, because providers match on an exact prefix: the
 * first segment that varies ends the cacheable region regardless of what follows.
 */
export declare function projectSavings(profile: WorkloadProfile, levers: Lever[], price: TokenPrice, options?: {
    minimumCacheableTokens?: number;
}): SavingsProjection;
/**
 * Workload shapes the levers behave very differently on. The headline number a
 * customer sees depends far more on which of these they are than on anything
 * FLUX does, which is why one global percentage would be misleading.
 */
export declare const WORKLOAD_ARCHETYPES: Record<string, WorkloadProfile>;
/** Levers applicable to a profile, in the order they should be applied. */
export declare function leversFor(profile: WorkloadProfile): Lever[];
