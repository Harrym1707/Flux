export type FluxTelemetryConfig = {
  endpoint?: string;
  mode?: "metadata_only" | "content";
};

export type FluxRequestEvent = {
  requestId: string;
  applicationId: string;
  provider: string;
  model: string;
  requestedModel?: string;
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  contextProfileId?: string;
  contextProfileVersion?: string;
  routePolicyId?: string;
  routeReason?: string;
  estimatedCostSavingsPercent?: number;
  modelsAttempted?: string[];
  fallbackUsed?: boolean;
  fallbackReason?: "quality_rejected" | "quality_check_error" | "candidate_error" | "context_transform_unavailable" | "context_transform_error" | "context_profile_mismatch";
  qualityCheckPassed?: boolean;
  cacheHit?: boolean;
  tokensAvoided?: number;
  costAvoidedUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  status: "succeeded" | "failed";
  error?: string;
  timestamp: string;
};

export type FluxRoutingEvidence = {
  baselineModel: string;
  candidateModel: string;
  eligibleForReview: boolean;
  sampleSize: number;
  candidateAccuracyLower95: number;
  accuracyDrop: number;
  baselineCostUsd: number;
  candidateCostUsd: number;
};

export type FluxRoutingCandidate = {
  model: string;
  /** Share of requests assigned to this candidate, from 0 to 1. */
  trafficShare: number;
  /** Explicit human approval after reviewing the offline replay report. */
  approved: boolean;
  evidence: FluxRoutingEvidence;
  /** Optional lower output-token cap for this candidate. The baseline request is unchanged on fallback. */
  maxOutputTokens?: number;
  /** Versioned deterministic context-reduction transform evaluated in replay. */
  contextProfileId?: string;
};

export type FluxRoutingPolicy = {
  id: string;
  taskClass: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  baselineModel: string;
  minimumSamples: number;
  minimumCandidateAccuracyLower95: number;
  maximumAccuracyDrop: number;
  candidates: FluxRoutingCandidate[];
};

export type FluxRoutingConfig = {
  policies: FluxRoutingPolicy[];
  /** Return a stable, non-sensitive key such as tenant/user or job ID. */
  getRequestKey: (request: unknown) => string | undefined;
};

export type FluxExactCacheConfig = {
  /** Maximum completed responses retained in this client process. */
  maxEntries: number;
  /** Cache entry lifetime in milliseconds. */
  ttlMs: number;
  /** Return an isolation scope such as tenant ID; returning undefined disables caching for that request. */
  getScopeKey: (request: unknown) => string | undefined;
};

export type FluxRequestContext = {
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
};

/** A deterministic, versioned context transformation that can be replayed before rollout. */
export type FluxContextProfile = {
  id: string;
  version: string;
  /** Optional guard; every supplied field must exactly match the request's trusted context. */
  match?: Partial<Pick<FluxRequestContext, "taskClass" | "workflow" | "difficulty" | "riskLevel">>;
  /** Transform synchronously to avoid adding another model call to the inference path. */
  transform: (request: unknown, context: FluxRequestContext) => unknown;
};

export type FluxOptions = {
  applicationId: string;
  pricing?: {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    outputPerMillion: number;
  };
  pricingByModel?: Record<string, {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    outputPerMillion: number;
  }>;
  telemetry?: FluxTelemetryConfig;
  classify?: (request: unknown) => string | undefined;
  getContext?: (request: unknown) => FluxRequestContext;
  contextProfiles?: readonly FluxContextProfile[];
  /** @deprecated Use versioned contextProfiles for replayable context transformations. */
  contextTransforms?: Record<string, (request: unknown, context: FluxRequestContext) => unknown>;
  routing?: FluxRoutingConfig;
  /** Return false or throw to retry a routed candidate request on the baseline model. */
  qualityCheck?: (input: {
    request: unknown;
    response: unknown;
    taskClass?: string;
    context?: FluxRequestContext;
    candidateModel: string;
  }) => boolean | Promise<boolean>;
  /** Opt-in, in-memory exact response cache. Tool/conversation/streaming requests are bypassed. */
  exactCache?: FluxExactCacheConfig;
  onEvent?: (event: FluxRequestEvent) => void;
};
