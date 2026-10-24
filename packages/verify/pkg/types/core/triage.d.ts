/**
 * Horizontal customer triage: which kind of traffic is this, and what is FLUX
 * honestly worth on it?
 *
 * The A/B results made one thing unambiguous: the saving FLUX delivers is a
 * property of the WORKLOAD SHAPE, not of FLUX. The same software measured
 * ~2% from caching on a multi-turn agent (whose appended history already hits
 * the provider cache ~90% of the time), ~40% from prefix repair on one-shot
 * templated traffic (whose embedded clock blocked the cache entirely), ~30%
 * from output budgeting where answers had a long tail, and ~3% on a workload
 * that was already well cached.
 *
 * A horizontal product therefore cannot quote one number. It has to classify
 * the stream first and quote the band that stream's shape supports, with the
 * evidence attached — including "you are already optimised, do not pay us",
 * because a percent-of-savings business that charges for savings the customer
 * already has is buying refunds and churn.
 *
 * Deliberately gateway-agnostic: the signals are derivable from any usage log,
 * LiteLLM's spend logs included.
 */
export type StreamSignals = {
    requests: number;
    /** Distinct downstream customers (a gateway's end_user), where known. */
    distinctEndUsers: number;
    requestsPerEndUser: number;
    episodesIdentified: boolean;
    meanRoundTrips: number;
    /** Share of input tokens that are tool/MCP schema. */
    toolSchemaShare: number;
    /** Share of input already arriving at the provider cached. */
    alreadyCachedShare: number;
    /** Share of requests a gateway's own response cache already answers. */
    gatewayCacheHitShare: number;
    promptTextAvailable: boolean;
    prefixBreakersFound: boolean;
    meanInputTokens: number;
};
export type CustomerSegment = "already-optimised" | "consumer-app" | "in-house-agent" | "application-layer";
export type SegmentClassification = {
    segment: CustomerSegment;
    evidence: string[];
};
/**
 * Classify one stream. Rules are ordered so the strongest signal wins:
 * existing optimisation first (nothing honest to sell), then the many-end-user
 * consumer shape, then the session-heavy agent shape, with server-side
 * application traffic as the remainder.
 */
export declare function classifySegment(signals: StreamSignals): SegmentClassification;
export type QuoteConfidence = "measured-analogue" | "needs-prompt-text" | "do-not-charge";
export type SegmentQuote = {
    segment: CustomerSegment;
    /** Honest range for total cost reduction, as percentages of current spend. */
    bandPercent: [number, number];
    topLever: string;
    confidence: QuoteConfidence;
    /** What would turn the band into a firm figure. */
    firmUpBy?: string;
    reasoning: string[];
    doNotCharge?: boolean;
};
/**
 * Quote a band for a classified stream.
 *
 * Every band cites the measurement it is an analogue of; none is a marketing
 * number. Where the deciding evidence (prompt text) is absent, the band is
 * wide and says exactly what would narrow it.
 */
export declare function quoteForSegment(classification: SegmentClassification, signals: StreamSignals): SegmentQuote;
