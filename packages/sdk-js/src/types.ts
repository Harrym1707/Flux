import type { LedgerGateVerdict, PriceCatalogue } from "../../core/dist/src/index.js";
import type { FluxReductionSummary, FluxTokenReductionConfig } from "./reduce-request.js";
export type FluxTelemetryConfig = {
  /**
   * Where to POST usage metadata. Unset (the default) means telemetry is OFF
   * and nothing is ever sent anywhere. There is no mode that sends content:
   * events carry usage numbers and lever names, never prompts, and provider
   * error text is masked before send.
   */
  endpoint?: string;
};

export type FluxRequestEvent = {
  /** What reduction removed from this request, when reduction is configured. */
  reduction?: FluxReductionSummary;
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
  /**
   * Provider-reported TTL split of the cache writes (Anthropic
   * usage.cache_creation). Present as a PAIR only when the provider reported
   * the split; absent means unknown, and billing uses FLUX's stamped TTL when
   * available (otherwise the 1h premium, dispute-safe), never assumes 5m.
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  costUsd?: number;
  /**
   * service_tier as reported on the final RESPONSE, never the requested one: a
   * flex request that 429s and falls back to standard bills standard and earns
   * zero tier savings. Absent when the provider reports none.
   */
  responseServiceTier?: string;
  /** Response service_tier per attempt, aligned with modelsAttempted; null where unreported. */
  attemptServiceTiers?: Array<string | null>;
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

export type FluxEvaluationCaptureAttempt = {
  model: string;
  contextProfileId?: string;
  maxOutputTokens?: number;
  request: unknown;
  response?: unknown;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  score?: number;
};

/** Content-bearing local evaluation record. Enable only with an explicit redactor. */
export type FluxEvaluationCaptureRecord = {
  schemaVersion: 1;
  id: string;
  caseId: string;
  /** Optional stable, non-sensitive group ID used to keep related prompts in one split. */
  groupId?: string;
  applicationId: string;
  requestedModel: string;
  finalModel: string;
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  request: unknown;
  expected?: unknown;
  attempts: FluxEvaluationCaptureAttempt[];
  cacheHit?: boolean;
  routeReason?: string;
  status: "succeeded" | "failed";
  timestamp: string;
};

export type FluxEvaluationCaptureConfig = {
  /** Stable ID across deliberate replays of the same application test case. */
  getCaseId?: (request: unknown) => string | undefined;
  /** Optional stable group key, ideally a one-way hash of the normalized input. */
  getGroupId?: (request: unknown) => string | undefined;
  /** Optional trusted answer/label from a test fixture or application outcome. */
  getExpected?: (request: unknown) => unknown;
  /** Task-specific scorer returning a normalized value in [0, 1]. */
  score?: (expected: unknown, response: unknown, meta: { model: string; workflow?: string; taskClass?: string }) => number;
  /** Required privacy boundary: return a sanitized copy, or undefined to discard the record. */
  redact: (record: FluxEvaluationCaptureRecord) => FluxEvaluationCaptureRecord | undefined;
  /** Write sanitized records locally or to an explicitly chosen sink. */
  write: (record: FluxEvaluationCaptureRecord) => void | Promise<void>;
};

/**
 * Opt-in savings ledger: an append-only, hash-chained JSONL spool of billable
 * events, one per request, written synchronously from the event path. Off by
 * default; every write is wrapped so a full disk or bad path can never throw
 * into the request path. The spool is the billing source of truth a customer
 * recomputes themselves with `recomputeInvoice`.
 */
export type FluxSavingsLedgerConfig = {
  /** Append-only JSONL file; parent directories are created on first write. */
  path: string;
  /** Provider key used to resolve rates in the catalogue. Default "openai". */
  provider?: string;
  /** Rates to pin event pricing against. Default: the published catalogue. */
  catalogue?: PriceCatalogue;
  /**
   * Replay-gate verdict reference per lossy lever id. A lossy lever's savings
   * bill only when its verdict here is "approved"; unknown lossy levers are
   * recorded and never billed.
   */
  gateVerdicts?: Record<string, LedgerGateVerdict>;
  /** Optional task correlation so a failed task's turns are excluded from the invoice. */
  getCorrelation?: (event: FluxRequestEvent) => { taskId?: string; turnIndex?: number } | undefined;
  /**
   * Optional measured counterfactual cost (standard tier, no levers) in USD for
   * this request, from a replay/counterfactual measurement path. Stored on the
   * event; the measured token-reduction delta bills only when it is present.
   */
  getBaselineUsd?: (event: FluxRequestEvent) => number | undefined;
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
    /** 1h-TTL cache writes bill at their own premium (Anthropic: 2x base input). */
    cacheWrite1hInputPerMillion?: number;
    outputPerMillion: number;
  };
  pricingByModel?: Record<string, {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    /** 1h-TTL cache writes bill at their own premium (Anthropic: 2x base input). */
    cacheWrite1hInputPerMillion?: number;
    outputPerMillion: number;
  }>;
  telemetry?: FluxTelemetryConfig;
  classify?: (request: unknown) => string | undefined;
  getContext?: (request: unknown) => FluxRequestContext;
  /**
   * Token reduction applied to every request, independent of routing. Omit to
   * leave requests untouched.
   */
  tokenReduction?: FluxTokenReductionConfig;
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
  /** Off by default. Captures request/response content only when explicitly configured. */
  evaluationCapture?: FluxEvaluationCaptureConfig;
  /** Off by default. Appends hash-chained billable events to a local JSONL spool. */
  ledger?: FluxSavingsLedgerConfig;
  onEvent?: (event: FluxRequestEvent) => void;
};
