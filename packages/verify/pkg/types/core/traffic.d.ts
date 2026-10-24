import { type PriceCatalogue } from "./price-catalogue.js";
import { type Lever, type WorkloadProfile } from "./savings-model.js";
import { type ToolCatalogueAudit } from "./tool-schema.js";
import { type CachingAnalysis, type OutputCapAdvice, type TokenCounter } from "./token-reduction.js";
/**
 * Ingest real traffic and measure what a reduction would be worth on it.
 *
 * Two tiers of input, because most teams can produce the first immediately and
 * the second only after a conversation about privacy:
 *
 *   Tier 1, usage only (model, token counts, date): prices the baseline, finds
 *     the model mix, and recommends output caps. No prompt text is needed, so
 *     this runs on billing exports.
 *   Tier 2, usage plus prompt text: adds prefix-cache analysis, what is breaking
 *     the cache, duplicate context, and measured tool-schema overhead.
 *
 * Nothing here performs I/O or leaves the process. Prompt text is used to
 * compute counts and hashes and is never copied into a report.
 */
export type TrafficRecord = {
    id: string;
    model: string;
    provider: string;
    /** ISO date the request was billed on, used to resolve the rate that applied. */
    at: string;
    inputTokens: number;
    outputTokens: number;
    /** Input already served from the provider's cache. A saving the customer HAS. */
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    /** Full prompt text, when the log carries it. Enables tier 2 analysis. */
    promptText?: string;
    /** Serialised tool or function definitions sent with the request. */
    toolSchemaText?: string;
    /** Logical grouping. Prompts only share a prefix within one workload. */
    workload: string;
    /**
     * Task this request belongs to, where the log says so. Several requests share
     * one episode id when an agent takes several turns to finish one job.
     */
    episodeId?: string;
};
export type IngestIssue = {
    line: number;
    reason: string;
};
export type IngestResult = {
    records: TrafficRecord[];
    issues: IngestIssue[];
    /** Which adapter matched each record, so an odd result can be traced. */
    adapterCounts: Record<string, number>;
};
/**
 * Normalise one logged row.
 *
 * Accepts the OpenAI Responses and Chat Completions shapes, the Anthropic
 * Messages shape, and a bare usage row, with the request and response either
 * nested under `request`/`response` or flattened onto one object. Returns the
 * adapter that matched so a surprising report can be traced to its parser.
 */
export declare function normaliseTrafficRow(row: unknown, fallbackDate: string, index: number): {
    record: TrafficRecord;
    adapter: string;
} | {
    issue: string;
};
/** Normalise many rows, collecting per-row problems rather than failing the run. */
export declare function ingestTraffic(rows: unknown[], fallbackDate: string): IngestResult;
/**
 * Per-task view of a workload.
 *
 * The unit that matters for agentic traffic, and the one the market does not
 * report. A technique that cuts each prompt by 91% while tripling the number of
 * prompts has saved nothing, and per-request figures cannot show that: one
 * published bench found progressive disclosure modelled at ~77% delivering ~13%
 * in production, because a router adds a round trip per novel tool call.
 *
 * `identified` matters. Without a task identifier in the log every request is
 * its own episode, round trips read as 1.0, and nothing here is informative.
 * It is reported rather than silently assumed.
 */
export type EpisodeStats = {
    episodes: number;
    /** Mean requests per task. This is the round-trip count a technique can change. */
    meanRoundTrips: number;
    maxRoundTrips: number;
    meanInputTokens: number;
    meanOutputTokens: number;
    meanCostUsd?: number;
    /** False when the log carried no task identifier, making the above meaningless. */
    identified: boolean;
};
export type WorkloadMeasurement = {
    workload: string;
    /** Model identifier exactly as the log carried it. */
    model: string;
    /** Catalogue key the identifier resolved to, when it resolved at all. */
    resolvedModel?: string;
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    /** Tokens the provider already served from cache before FLUX touched anything. */
    alreadyCachedInputTokens: number;
    meanToolSchemaTokens: number;
    /** Measured from the request's own tool definitions; absent when none were sent. */
    toolAudit?: ToolCatalogueAudit;
    /** Present only when the log carried prompt text. */
    caching?: CachingAnalysis;
    outputCap?: OutputCapAdvice;
    duplicateContextTokens: number;
    episodes: EpisodeStats;
    baselineCostUsd?: number;
    /** Set when the catalogue cannot price this model on these dates. */
    unpricedReason?: string;
};
export type TrafficMeasurement = {
    requests: number;
    workloads: WorkloadMeasurement[];
    totalBaselineCostUsd: number;
    /** Models the catalogue could not price; their spend is excluded, never assumed zero. */
    unpricedModels: string[];
    /** Share of input tokens already arriving cached, which FLUX must not claim credit for. */
    alreadyCachedShare: number;
    promptTextAvailable: boolean;
    /** True when at least one record carried a task identifier. */
    episodesIdentified: boolean;
    notes: string[];
};
/**
 * Measure a traffic sample.
 *
 * Deliberately conservative in two places. Input already arriving cached is
 * reported separately and never counted as a FLUX saving, because the customer
 * already has it. And a model the catalogue cannot price is named and excluded
 * rather than treated as free, the same discipline applied to benchmark sources.
 */
export declare function measureTraffic(records: TrafficRecord[], catalogue: PriceCatalogue, options?: {
    countTokens?: TokenCounter;
    maximumPromptSample?: number;
}): TrafficMeasurement;
/** Stable fingerprint of a traffic sample, so repeated runs can be compared. */
export declare function trafficFingerprint(records: TrafficRecord[]): string;
/**
 * Turn a measured workload into a profile the savings model can project on.
 *
 * Segments come from what was actually observed rather than assumed: the tool
 * catalogue is measured from the request's own tool definitions, the stable
 * prefix from what the sampled prompts genuinely share, and whatever remains is
 * treated as the volatile body. Tokens already arriving cached are removed from
 * the stable segment, because that saving is the customer's already.
 */
export declare function profileFromMeasurement(measurement: WorkloadMeasurement, options?: {
    repairPrefix?: boolean;
}): WorkloadProfile;
/**
 * Build the lever set a measured workload actually supports.
 *
 * `leversFor` applies published reduction factors to any profile with non-empty
 * segments, which is right for archetype modelling and wrong for a customer
 * report: it credited a 60% output reduction to workloads whose replies were
 * already short and tight, and that was the only lever firing on most samples.
 *
 * Here every factor is either measured from the sample or gated on measured
 * evidence that the lever applies at all:
 *
 *   - Output capping uses the observed length distribution, so a workload with
 *     no long tail is credited nothing.
 *   - Duplicate removal is credited exactly the duplicate tokens found.
 *   - Tool levers keep their published factors, which are deterministic
 *     transformations of a catalogue we measured directly, but only fire when
 *     tool definitions were actually present.
 *   - Reasoning-effort tuning is offered only where mean output is long enough
 *     for reasoning tokens to plausibly dominate, at well under the published
 *     factor, and always as needs-verification.
 *
 * Prompt compression and history compaction are deliberately absent. Their
 * published factors are real but workload-specific, and nothing in a usage log
 * measures whether they transfer. They belong behind a replay check, not in an
 * opening projection.
 */
export declare function leversFromMeasurement(measurement: WorkloadMeasurement): Lever[];
