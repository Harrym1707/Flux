/**
 * Local-tier router — PROTOTYPE (preview lever, off by default).
 *
 * The orchestration idea: run the requests a small open-weight model handles
 * well (e.g. PrismML's Bonsai, served on a local OpenAI-compatible endpoint at
 * http://127.0.0.1:8080/v1) on THAT model instead of the expensive cloud model,
 * and keep only the hard requests on the cloud. Inference on a model you host is
 * free at the margin, so the saving is the whole cloud cost that request would
 * have incurred — valued here against the same price catalogue that prices every
 * other FLUX saving.
 *
 * This is a LOSSY lever: it changes which model answers, so it CAN change the
 * answer. It is therefore off by default and, in production, must be gated by
 * the replay-gate (a replay of the customer's own traffic proving the local
 * model's answers held) before it is ever switched on for real traffic — exactly
 * how FLUX treats every other answer-affecting move. Billing uses the cloud cost
 * avoided NET of the customer's own compute, never as if the local model were
 * free of consequence.
 *
 * This module is the pure decision + economics. Wiring the chosen route into the
 * proxy's forwarding path (send a "local" request to policy.endpoint with the
 * caller's own key, translate the model field) is the next step and is kept out
 * of the audited proxy until the gate is in place.
 */
import { lookupPrice, priceUsage, resolveModelId, type PriceCatalogue, type TokenUsage } from "./price-catalogue.js";

/** What the router needs to know about a request to decide its route. */
export type LocalTierRequest = {
  /** The cloud provider the request was aimed at, e.g. "anthropic" / "openai". */
  provider: string;
  /** The cloud model id it would otherwise run on — the baseline for savings. */
  model: string;
  /** Measured prompt size. Big contexts stay on the cloud model. */
  inputTokens: number;
  /** Tool / function definitions present. Tool-use requests stay on the cloud model by default. */
  hasTools: boolean;
};

export type LocalTierPolicy = {
  /** Off by default: this is an answer-changing lever, gated by replay in production. */
  enabled: boolean;
  /** Local OpenAI-compatible server, e.g. http://127.0.0.1:8080/v1 (PrismML Bonsai). */
  endpoint: string;
  /** The open-weight model the endpoint serves. */
  localModel: string;
  /** Cloud model ids eligible to be stood in for (usually the expensive ones). Empty = none. */
  baselineModels: string[];
  /** Only small requests route local; larger prompts stay on the cloud model. */
  maxInputTokens: number;
  /** Keep tool-use requests on the cloud model unless explicitly allowed. */
  allowTools: boolean;
};

export type RouteDecision =
  | { route: "local"; endpoint: string; model: string; baseline: { provider: string; model: string }; reason: string }
  | { route: "cloud"; reason: string };

export function defaultLocalTierPolicy(overrides: Partial<LocalTierPolicy> = {}): LocalTierPolicy {
  return {
    enabled: false,
    endpoint: "http://127.0.0.1:8080/v1",
    localModel: "local",
    baselineModels: [],
    maxInputTokens: 4000,
    allowTools: false,
    ...overrides,
  };
}

/**
 * Decide whether a request should run on the local open-weight model or stay on
 * the cloud model. Conservative by construction: only small, tool-free requests
 * aimed at an eligible baseline route local; everything else stays cloud, with a
 * reason recorded either way.
 */
export function decideRoute(req: LocalTierRequest, policy: LocalTierPolicy): RouteDecision {
  if (!policy.enabled) return { route: "cloud", reason: "local tier disabled" };
  if (req.hasTools && !policy.allowTools) {
    return { route: "cloud", reason: "tool-use request kept on the cloud model" };
  }
  if (req.inputTokens > policy.maxInputTokens) {
    return { route: "cloud", reason: `${req.inputTokens} input tokens over the ${policy.maxInputTokens}-token local-tier limit` };
  }
  if (policy.baselineModels.length > 0 && !policy.baselineModels.includes(req.model)) {
    return { route: "cloud", reason: `${req.model} is not an eligible baseline for the local tier` };
  }
  return {
    route: "local",
    endpoint: policy.endpoint,
    model: policy.localModel,
    baseline: { provider: req.provider, model: req.model },
    reason: "small, tool-free request eligible for the local open-weight tier",
  };
}

/**
 * The cloud cost a locally-run request avoided: the full catalogue-priced cost
 * of that request at its baseline cloud model. Returns null when the baseline is
 * unpriced (then the saving is recorded, never billed — as everywhere in FLUX).
 * This is the GROSS cloud spend avoided; the customer's own compute is netted off
 * before any fee.
 */
export function cloudCostAvoidedUsd(
  baseline: { provider: string; model: string },
  usage: TokenUsage,
  catalogue: PriceCatalogue,
  at: string,
): number | null {
  const resolved = resolveModelId(catalogue, baseline.provider, baseline.model);
  if (resolved.status !== "resolved") return null;
  // Confirm it prices before valuing, so an unpriced baseline returns null
  // rather than throwing or guessing.
  if (lookupPrice(catalogue, { provider: baseline.provider, model: resolved.model, at }).status !== "priced") return null;
  const priced = priceUsage(catalogue, { provider: baseline.provider, model: resolved.model, at }, usage);
  return priced.status === "priced" ? priced.costUsd : null;
}
