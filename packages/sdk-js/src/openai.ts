import { randomUUID } from "node:crypto";
import {
  normalizeProviderUsage,
  responseServiceTier as providerResponseServiceTier,
  type NormalizedProviderUsage,
} from "../../core/dist/src/index.js";
import { TelemetryClient } from "./telemetry.js";
import { chooseRoute } from "./routing.js";
import { ExactResponseCache } from "./exact-cache.js";
import { reduceRequest } from "./reduce-request.js";
import { createSavingsLedger, type SavingsLedger } from "./savings-ledger.js";
import type {
  FluxContextProfile,
  FluxEvaluationCaptureAttempt,
  FluxEvaluationCaptureRecord,
  FluxOptions,
  FluxRequestContext,
  FluxRequestEvent,
} from "./types.js";

type AnyObject = Record<PropertyKey, any>;
type Pricing = NonNullable<FluxOptions["pricing"]>;

type TokenUsage = NormalizedProviderUsage;

function validRate(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/**
 * Provider usage through the ONE shared normaliser in packages/core, so the
 * wrapper, the replay gate and the ledger can never disagree about a response:
 * Responses, Chat Completions and Anthropic Messages shapes all parse, cached
 * tokens stay inside the OpenAI totals, Anthropic reads/writes are added to a
 * total-inclusive figure, and an inconsistent cache-write TTL split yields no
 * usage at all rather than a silently repaired one.
 */
function tokenUsage(response: AnyObject | undefined): TokenUsage | undefined {
  const result = normalizeProviderUsage(response);
  return result.status === "ok" ? result.usage : undefined;
}

function usageCost(usage: TokenUsage | undefined, pricing: Pricing | undefined): number | undefined {
  if (!usage || !pricing ||
      (usage.cachedInputTokens > 0 && pricing.cachedInputPerMillion === undefined) ||
      (usage.cacheWriteInputTokens > 0 && pricing.cacheWriteInputPerMillion === undefined)) return undefined;
  // The 1h-TTL share of cache writes bills at its own premium where a rate is
  // configured; with no split reported, every write prices at the base write rate
  // here (the catalogue-backed ledger applies the dispute-safe 1h fallback).
  const write1h = usage.cacheWrite1hInputTokens ?? 0;
  if (write1h > 0 && pricing.cacheWrite1hInputPerMillion === undefined) return undefined;
  const write5m = usage.cacheWriteInputTokens - write1h;
  return (usage.uncachedInputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.cachedInputTokens / 1_000_000) * (pricing.cachedInputPerMillion ?? 0) +
    (write5m / 1_000_000) * (pricing.cacheWriteInputPerMillion ?? 0) +
    (write1h / 1_000_000) * (pricing.cacheWrite1hInputPerMillion ?? 0) +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
}

function matchesContextProfile(profile: FluxContextProfile, context: FluxRequestContext): boolean {
  return Object.entries(profile.match ?? {}).every(([key, value]) =>
    context[key as keyof FluxRequestContext] === value
  );
}

/** Route eligible Responses API calls and preserve the provider's response shape. */
export function withFlux<T extends AnyObject>(client: T, options: FluxOptions): T {
  const profileIds = new Set<string>();
  for (const profile of options.contextProfiles ?? []) {
    if (!profile.id || !profile.version || typeof profile.transform !== "function" || profileIds.has(profile.id)) {
      throw new Error("FLUX context profiles need unique IDs, versions, and transform functions.");
    }
    profileIds.add(profile.id);
  }
  if (options.pricing && (
      !Number.isFinite(options.pricing.inputPerMillion) || options.pricing.inputPerMillion < 0 ||
      !Number.isFinite(options.pricing.outputPerMillion) || options.pricing.outputPerMillion < 0 ||
      !validRate(options.pricing.cachedInputPerMillion) || !validRate(options.pricing.cacheWriteInputPerMillion) ||
      !validRate(options.pricing.cacheWrite1hInputPerMillion))) {
    throw new Error("FLUX pricing rates must be finite, non-negative USD per million tokens.");
  }
  for (const [model, pricing] of Object.entries(options.pricingByModel ?? {})) {
    if (!model || !Number.isFinite(pricing.inputPerMillion) || pricing.inputPerMillion < 0 ||
        !Number.isFinite(pricing.outputPerMillion) || pricing.outputPerMillion < 0 ||
        !validRate(pricing.cachedInputPerMillion) || !validRate(pricing.cacheWriteInputPerMillion) ||
        !validRate(pricing.cacheWrite1hInputPerMillion)) {
      throw new Error("FLUX per-model pricing rates must be finite, non-negative USD per million tokens.");
    }
  }

  const originalResponses = client.responses;
  if (!originalResponses?.create || typeof originalResponses.create !== "function") {
    throw new Error("FLUX currently supports OpenAI-compatible clients with responses.create().");
  }

  const telemetry = new TelemetryClient(options.telemetry);
  const exactCache = options.exactCache ? new ExactResponseCache(options.exactCache) : undefined;
  // Config errors (no path) surface here, at setup time; from the first request
  // on, the ledger is fire-and-forget and can never throw into the request path.
  const ledger: SavingsLedger | undefined = options.ledger ? createSavingsLedger(options.ledger) : undefined;
  const wrappedResponses = new Proxy(originalResponses, {
    get(target, property, receiver) {
      if (property !== "create") return Reflect.get(target, property, receiver);

      return async (request: AnyObject, ...rest: unknown[]) => {
        const requestId = randomUUID();
        const started = performance.now();
        let context: FluxRequestContext = {};
        try {
          context = options.getContext?.(request) ?? {};
        } catch {
          // Context is optional; failed classification leaves requests on baseline.
        }
        let taskClass = context.taskClass;
        if (!taskClass) {
          try {
            taskClass = options.classify?.(request);
          } catch {
            taskClass = undefined;
          }
        }
        context = { ...context, taskClass };
        const model = typeof request?.model === "string" ? request.model : "unknown";

        // Token reduction runs on every request, whatever the routing decision.
        // getContext and classify above were given the caller's own request;
        // everything downstream uses the reduced one, because that is what gets
        // sent, cached and quality-checked.
        const reduction = options.tokenReduction
          ? reduceRequest(request, options.tokenReduction)
          : undefined;
        const effectiveRequest = (reduction?.request ?? request) as AnyObject;

        const route = chooseRoute(options.routing, effectiveRequest, taskClass, context);
        const candidateSelected = route.reason === "candidate_quality_and_cost_gates_passed";
        let fallbackReason: FluxRequestEvent["fallbackReason"];
        let routedRequest: AnyObject = candidateSelected
          ? { ...effectiveRequest, model: route.model }
          : effectiveRequest;
        const contextProfile = candidateSelected && route.contextProfileId
          ? options.contextProfiles?.find((profile) => profile.id === route.contextProfileId)
          : undefined;
        if (candidateSelected && route.contextProfileId) {
          const transform = contextProfile?.transform ?? options.contextTransforms?.[route.contextProfileId];
          if (contextProfile && !matchesContextProfile(contextProfile, context)) {
            fallbackReason = "context_profile_mismatch";
          } else if (!transform) {
            fallbackReason = "context_transform_unavailable";
          } else {
            try {
              const transformed = transform(effectiveRequest, context);
              if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) {
                throw new Error("Context transform must return a request object.");
              }
              routedRequest = { ...(transformed as AnyObject), model: route.model };
            } catch {
              fallbackReason = "context_transform_error";
            }
          }
        }
        if (candidateSelected && route.maxOutputTokens !== undefined) {
          const requestedCap = request.max_output_tokens;
          routedRequest = {
            ...routedRequest,
            max_output_tokens: typeof requestedCap === "number" && Number.isFinite(requestedCap)
              ? Math.min(requestedCap, route.maxOutputTokens)
              : route.maxOutputTokens,
          };
        }
        let cacheKey: string | undefined;
        if (exactCache && rest.length === 0 && fallbackReason === undefined) {
          try {
            const scopeKey = options.exactCache?.getScopeKey(request);
            cacheKey = exactCache.keyFor(routedRequest, scopeKey);
          } catch {
            cacheKey = undefined;
          }
        }
        const cached = cacheKey ? exactCache?.get(cacheKey) : undefined;
        const cacheHit = cached !== undefined;
        let status: FluxRequestEvent["status"] = "succeeded";
        let error: string | undefined;
        let response: unknown;
        let finalModel = cached?.model ?? route.model;
        let qualityCheckPassed: boolean | undefined;
        const attempts: Array<{
          model: string;
          request: AnyObject;
          contextProfileId?: string;
          maxOutputTokens?: number;
          response?: AnyObject;
          error?: string;
        }> = [];
        const create = Reflect.get(target, "create", target);

        try {
          if (cacheHit) {
            response = cached.response;
          } else if (fallbackReason === undefined) {
            attempts.push({
              model: route.model,
              request: routedRequest,
              contextProfileId: candidateSelected ? route.contextProfileId : undefined,
              maxOutputTokens: candidateSelected ? route.maxOutputTokens : undefined,
            });
            try {
              response = await create.call(target, routedRequest, ...rest);
              attempts[attempts.length - 1].response = response as AnyObject;
            } catch (cause) {
              attempts[attempts.length - 1].error = cause instanceof Error ? cause.message : String(cause);
              if (!candidateSelected) throw cause;
              fallbackReason = "candidate_error";
            }
          }

          if (candidateSelected && fallbackReason === undefined && options.qualityCheck) {
            try {
              qualityCheckPassed = await options.qualityCheck({
                request: effectiveRequest,
                response,
                taskClass,
                context,
                candidateModel: route.model,
              });
              if (qualityCheckPassed !== true) fallbackReason = "quality_rejected";
            } catch {
              qualityCheckPassed = false;
              fallbackReason = "quality_check_error";
            }
          }

          if (candidateSelected && fallbackReason !== undefined) {
            finalModel = model;
            attempts.push({ model, request: effectiveRequest });
            response = await create.call(target, effectiveRequest, ...rest);
            attempts[attempts.length - 1].response = response as AnyObject;
          }
          if (!cacheHit && fallbackReason === undefined && cacheKey && response !== undefined) {
            const usage = tokenUsage(response as AnyObject | undefined);
            const pricing = options.pricingByModel?.[route.model] ??
              (route.model === model ? options.pricing : undefined);
            const cost = usageCost(usage, pricing);
            exactCache?.set(cacheKey, {
              response,
              model: route.model,
              inputTokens: usage?.inputTokens,
              uncachedInputTokens: usage?.uncachedInputTokens,
              cachedInputTokens: usage?.cachedInputTokens,
              cacheWriteInputTokens: usage?.cacheWriteInputTokens,
              outputTokens: usage?.outputTokens,
              costUsd: cost,
            });
          }
          return response;
        } catch (cause) {
          status = "failed";
          error = cause instanceof Error ? cause.message : String(cause);
          throw cause;
        } finally {
          const usages = attempts.map(({ response: attemptResponse }) => tokenUsage(attemptResponse));
          const hasAllUsages = attempts.length > 0 && usages.every((usage) => usage !== undefined);
          // The cache-write TTL split totals only when it is known for every
          // write: one attempt with unreported split makes the total's split
          // unknown too, so pricing falls back to the dispute-safe rule rather
          // than treating the unreported share as 5m writes.
          const splitKnownForAll = hasAllUsages && usages.every((usage) =>
            usage!.cacheWriteInputTokens === 0 ||
            (usage!.cacheWrite5mInputTokens !== undefined || usage!.cacheWrite1hInputTokens !== undefined));
          const usageTotals = hasAllUsages ? usages.reduce<TokenUsage>((total, usage) => ({
            inputTokens: total.inputTokens + usage!.inputTokens,
            uncachedInputTokens: total.uncachedInputTokens + usage!.uncachedInputTokens,
            cachedInputTokens: total.cachedInputTokens + usage!.cachedInputTokens,
            cacheWriteInputTokens: total.cacheWriteInputTokens + usage!.cacheWriteInputTokens,
            ...(splitKnownForAll
              ? {
                  cacheWrite5mInputTokens: (total.cacheWrite5mInputTokens ?? 0) + (usage!.cacheWrite5mInputTokens ?? 0),
                  cacheWrite1hInputTokens: (total.cacheWrite1hInputTokens ?? 0) + (usage!.cacheWrite1hInputTokens ?? 0),
                }
              : {}),
            outputTokens: total.outputTokens + usage!.outputTokens,
          }), { inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }) : undefined;
          const emptyCacheUsage: TokenUsage = { inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
          const actualUsage = cacheHit && attempts.length === 0 ? emptyCacheUsage : usageTotals;
          const inputTokens = actualUsage?.inputTokens;
          const outputTokens = actualUsage?.outputTokens;
          const attemptCosts = attempts.map(({ model: attemptedModel, response: attemptResponse }) => {
            const pricing = options.pricingByModel?.[attemptedModel] ??
              (attemptedModel === model ? options.pricing : undefined);
            return usageCost(tokenUsage(attemptResponse), pricing);
          });
          const costUsd = cacheHit && attempts.length === 0
            ? 0
            : attemptCosts.length > 0 && attemptCosts.every((cost) => cost !== undefined)
              ? attemptCosts.reduce<number>((sum, cost) => sum + (cost as number), 0)
              : undefined;
          // Billing reads the tier the provider ANSWERED with, never the one
          // the request asked for: flex that fell back bills standard. The
          // shared core helper reads OpenAI's top-level service_tier and
          // Anthropic's usage.service_tier (standard | priority | batch).
          const serviceTierOf = (attemptResponse: AnyObject | undefined): string | undefined =>
            providerResponseServiceTier(attemptResponse);
          const attemptServiceTiers = attempts.map(({ response: attemptResponse }) =>
            serviceTierOf(attemptResponse) ?? null);
          const responseServiceTier = attempts.length > 0
            ? serviceTierOf(attempts[attempts.length - 1].response)
            : undefined;
          const event: FluxRequestEvent = {
            requestId,
            applicationId: options.applicationId,
            ...(reduction === undefined ? {} : { reduction: reduction.summary }),
            provider: "openai-compatible",
            model: finalModel,
            requestedModel: candidateSelected ? model : undefined,
            taskClass,
            workflow: context.workflow,
            difficulty: context.difficulty,
            riskLevel: context.riskLevel,
            contextProfileId: candidateSelected ? route.contextProfileId : undefined,
            contextProfileVersion: contextProfile?.version,
            routePolicyId: route.policyId,
            routeReason: fallbackReason ? "fallback_to_baseline" : cacheHit ? "exact_cache_hit" : route.reason,
            estimatedCostSavingsPercent: fallbackReason ? undefined : route.estimatedCostSavingsPercent,
            modelsAttempted: attempts.map(({ model: attemptedModel }) => attemptedModel),
            fallbackUsed: fallbackReason !== undefined,
            fallbackReason,
            qualityCheckPassed,
            cacheHit,
            tokensAvoided: cacheHit
              ? (cached.inputTokens ?? 0) + (cached.outputTokens ?? 0)
              : undefined,
            costAvoidedUsd: cacheHit ? cached.costUsd : undefined,
            inputTokens,
            outputTokens,
            uncachedInputTokens: actualUsage?.uncachedInputTokens,
            cachedInputTokens: actualUsage?.cachedInputTokens,
            cacheWriteInputTokens: actualUsage?.cacheWriteInputTokens,
            // Provider-reported TTL split of the cache writes; absent when the
            // provider did not report one, so billing can fall back dispute-safe.
            ...(actualUsage !== undefined &&
                (actualUsage.cacheWrite5mInputTokens !== undefined || actualUsage.cacheWrite1hInputTokens !== undefined)
              ? {
                  cacheWrite5mInputTokens: actualUsage.cacheWrite5mInputTokens ?? 0,
                  cacheWrite1hInputTokens: actualUsage.cacheWrite1hInputTokens ?? 0,
                }
              : {}),
            costUsd,
            responseServiceTier,
            ...(attempts.length > 0 ? { attemptServiceTiers } : {}),
            latencyMs: performance.now() - started,
            status,
            error,
            timestamp: new Date().toISOString(),
          };

          // Synchronous, so the billable record exists before the caller sees
          // the response; emit swallows every failure internally, and the
          // extra try/catch keeps even a broken emitter out of the request path.
          try {
            ledger?.emit(event);
          } catch {
            // The savings meter must never change application behavior.
          }

          void Promise.resolve()
            .then(() => options.onEvent?.(event))
            .catch(() => {
              // Observability callbacks must never change application behavior.
            });
          void telemetry.emit(event);

          const capture = options.evaluationCapture;
          if (capture) {
            void Promise.resolve()
              .then(() => {
                let caseId: string = requestId;
                let groupId: string | undefined;
                try {
                  const supplied = capture.getCaseId?.(request);
                  if (typeof supplied === "string" && supplied.trim() !== "") caseId = supplied;
                } catch {
                  // Capture metadata is best-effort and never changes inference.
                }
                try {
                  const supplied = capture.getGroupId?.(request);
                  if (typeof supplied === "string" && supplied.trim() !== "") groupId = supplied;
                } catch {
                  // A missing group key falls back to the case ID downstream.
                }
                let expected: unknown;
                try {
                  expected = capture.getExpected?.(request);
                } catch {
                  expected = undefined;
                }
                const captureAttempts: FluxEvaluationCaptureAttempt[] = (attempts.length > 0 ? attempts : cacheHit
                  ? [{ model: finalModel, request: routedRequest, response: response as AnyObject, contextProfileId: candidateSelected ? route.contextProfileId : undefined, maxOutputTokens: candidateSelected ? route.maxOutputTokens : undefined }]
                  : []).map((attempt) => {
                  const usage = tokenUsage(attempt.response);
                  const pricing = options.pricingByModel?.[attempt.model] ??
                    (attempt.model === model ? options.pricing : undefined);
                  const attemptCapture: FluxEvaluationCaptureAttempt = {
                    model: attempt.model,
                    contextProfileId: attempt.contextProfileId,
                    maxOutputTokens: attempt.maxOutputTokens,
                    request: attempt.request,
                    response: attempt.response,
                    error: attempt.error,
                    inputTokens: cacheHit && attempts.length === 0 ? 0 : usage?.inputTokens,
                    outputTokens: cacheHit && attempts.length === 0 ? 0 : usage?.outputTokens,
                    costUsd: cacheHit && attempts.length === 0 ? 0 : usageCost(usage, pricing),
                  };
                  if (expected !== undefined && attempt.response !== undefined && capture.score) {
                    try {
                      const score = capture.score(expected, attempt.response, {
                        model: attempt.model,
                        workflow: context.workflow,
                        taskClass,
                      });
                      if (Number.isFinite(score) && score >= 0 && score <= 1) attemptCapture.score = score;
                    } catch {
                      // A missing task score is preferable to changing app behavior.
                    }
                  }
                  return attemptCapture;
                });
                const rawRecord: FluxEvaluationCaptureRecord = {
                  schemaVersion: 1,
                  id: requestId,
                  caseId,
                  ...(groupId ? { groupId } : {}),
                  applicationId: options.applicationId,
                  requestedModel: model,
                  finalModel,
                  taskClass,
                  workflow: context.workflow,
                  difficulty: context.difficulty,
                  riskLevel: context.riskLevel,
                  request,
                  ...(expected !== undefined ? { expected } : {}),
                  attempts: captureAttempts,
                  cacheHit,
                  routeReason: fallbackReason ? "fallback_to_baseline" : cacheHit ? "exact_cache_hit" : route.reason,
                  status,
                  timestamp: new Date().toISOString(),
                };
                const redacted = capture.redact(rawRecord);
                return redacted ? capture.write(redacted) : undefined;
              })
              .catch(() => {
                // Capture/redaction/storage failures never change application behavior.
              });
          }
        }
      };
    },
  });

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "responses") return wrappedResponses;
      return Reflect.get(target, property, receiver);
    },
  });
}
