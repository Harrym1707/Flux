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

export type CustomerSegment =
  | "already-optimised"
  | "consumer-app"
  | "in-house-agent"
  | "application-layer";

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
export function classifySegment(signals: StreamSignals): SegmentClassification {
  const evidence: string[] = [];

  if (signals.alreadyCachedShare > 0.5 || signals.gatewayCacheHitShare > 0.3) {
    if (signals.alreadyCachedShare > 0.5) {
      evidence.push(
        `${(signals.alreadyCachedShare * 100).toFixed(0)}% of input already arrives provider-cached.`,
      );
    }
    if (signals.gatewayCacheHitShare > 0.3) {
      evidence.push(
        `${(signals.gatewayCacheHitShare * 100).toFixed(0)}% of requests are answered by the gateway's own cache.`,
      );
    }
    return { segment: "already-optimised", evidence };
  }

  if (signals.distinctEndUsers >= 20 && signals.requestsPerEndUser <= 5) {
    evidence.push(
      `${signals.distinctEndUsers} distinct end users at ${signals.requestsPerEndUser.toFixed(1)} ` +
      "requests each: traffic fans out across many downstream customers.",
    );
    return { segment: "consumer-app", evidence };
  }

  if (signals.episodesIdentified && signals.meanRoundTrips >= 3) {
    evidence.push(
      `Sessions identified at ${signals.meanRoundTrips.toFixed(1)} calls per task` +
      (signals.toolSchemaShare > 0.1
        ? `, with tool schemas ${(signals.toolSchemaShare * 100).toFixed(0)}% of input`
        : "") + ": multi-turn agent traffic.",
    );
    return { segment: "in-house-agent", evidence };
  }

  evidence.push(
    "Server-side traffic without a wide end-user fan-out or long sessions: " +
    "application-layer calls built from a template.",
  );
  return { segment: "application-layer", evidence };
}

export type QuoteConfidence =
  | "measured-analogue"
  | "needs-prompt-text"
  | "do-not-charge";

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
export function quoteForSegment(
  classification: SegmentClassification,
  signals: StreamSignals,
): SegmentQuote {
  const { segment } = classification;

  if (segment === "already-optimised") {
    return {
      segment,
      bandPercent: [0, 5],
      topLever: "none worth charging for",
      confidence: "do-not-charge",
      doNotCharge: true,
      reasoning: [
        ...classification.evidence,
        "The support-assistant fixture with 77% of input already cached measured 2.4% addressable.",
        "A percent-of-savings fee on savings the customer already has is a refund waiting to happen.",
      ],
    };
  }

  if (segment === "in-house-agent") {
    return {
      segment,
      bandPercent: [25, 35],
      topLever: "output budgeting (replay-gated)",
      confidence: "measured-analogue",
      firmUpBy: "a replay-gate run on ~50 recorded tasks to pick the cap this workload supports",
      reasoning: [
        ...classification.evidence,
        "A/B on 40 five-turn tasks: output cap saved 32.2% at 89% answer completeness; schema work added 1-3%.",
        "Caching is NOT quoted: appended history already hit the provider cache 92% of the time with no FLUX, " +
        "so that saving is the provider's gift, not ours to bill.",
      ],
    };
  }

  if (segment === "consumer-app") {
    const reasoning = [
      ...classification.evidence,
      "Per-user traffic is sparse, and provider caches expire from last use (~5 minutes), so per-user history " +
      "caching decays between visits: at 600s spacing the simulated hit rate fell from 92% to 78% and prefix " +
      "repair's benefit vanished.",
      "The durable lever is the shared system template across ALL users, plus output budgeting.",
    ];
    if (!signals.promptTextAvailable) {
      return {
        segment,
        bandPercent: [5, 40],
        topLever: "shared-template cache repair + output budgeting",
        confidence: "needs-prompt-text",
        firmUpBy: "a sample of ~50 prompts, to measure the shared template and what breaks its prefix",
        reasoning: [
          ...reasoning,
          "Without prompt text the shared-template share is unknown, so the band is wide by design.",
        ],
      };
    }
    return {
      segment,
      bandPercent: signals.prefixBreakersFound ? [20, 45] : [10, 30],
      topLever: signals.prefixBreakersFound
        ? "cache-prefix repair on the shared template"
        : "output budgeting (replay-gated)",
      confidence: "measured-analogue",
      firmUpBy: "a replay-gate run to confirm the output cap",
      reasoning,
    };
  }

  // Application layer: server-templated one-shot traffic, the segment where
  // prefix repair was measured at its strongest.
  if (!signals.promptTextAvailable) {
    return {
      segment,
      bandPercent: [10, 55],
      topLever: "cache-prefix repair (unconfirmed) + output budgeting",
      confidence: "needs-prompt-text",
      firmUpBy: "a sample of ~50 prompts, to confirm the template and find what breaks its prefix",
      reasoning: [
        ...classification.evidence,
        "One-shot templated traffic measured 39.7% from prefix repair alone when a per-request value was " +
        "blocking the cache, and 0% when nothing was. Which of those this stream is cannot be known from " +
        "token counts, hence the wide band.",
      ],
    };
  }
  if (signals.prefixBreakersFound) {
    return {
      segment,
      bandPercent: [35, 55],
      topLever: "cache-prefix repair",
      confidence: "measured-analogue",
      firmUpBy: "enabling repair on a canary slice and reading the provider's cached-token counts",
      reasoning: [
        ...classification.evidence,
        "Per-request values were found inside the shared prefix. The one-shot simulation measured the hit rate " +
        "going from 0% to 78% and cost falling 39.7% when such values were moved out of the prefix.",
      ],
    };
  }
  return {
    segment,
    bandPercent: [5, 25],
    topLever: "output budgeting (replay-gated)",
    confidence: "measured-analogue",
    firmUpBy: "a replay-gate run on ~50 recorded requests",
    reasoning: [
      ...classification.evidence,
      "The template's prefix is already clean, so caching needs no repair; the remaining levers are output " +
      "budgeting and lossless schema compaction.",
    ],
  };
}
