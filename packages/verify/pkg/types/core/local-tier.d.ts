/**
 * Local-tier router — PROTOTYPE (preview lever, off by default).
 *
 * The orchestration idea: run the requests a small open-weight model handles
 * well (e.g. PrismML's Bonsai, served on a local OpenAI-compatible endpoint at
 * http://127.0.0.1:8080/v1) on THAT model instead of the expensive cloud model,
 * and keep only the hard requests on the cloud. Inference on a model you host is
 * free at the margin, so the saving is the whole cloud cost that request would
 * have incurred — valued here against the same price catalogue that prices every
 * other MESH saving.
 *
 * This is a LOSSY lever: it changes which model answers, so it CAN change the
 * answer. It is therefore off by default and, in production, must be gated by
 * the replay-gate (a replay of the customer's own traffic proving the local
 * model's answers held) before it is ever switched on for real traffic — exactly
 * how MESH treats every other answer-affecting move. Billing uses the cloud cost
 * avoided NET of the customer's own compute, never as if the local model were
 * free of consequence.
 *
 * This module is the pure decision + economics. Wiring the chosen route into the
 * proxy's forwarding path (send a "local" request to policy.endpoint with the
 * caller's own key, translate the model field) is the next step and is kept out
 * of the audited proxy until the gate is in place.
 */
import { type PriceCatalogue, type TokenUsage } from "./price-catalogue.js";
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
export type RouteDecision = {
    route: "local";
    endpoint: string;
    model: string;
    baseline: {
        provider: string;
        model: string;
    };
    reason: string;
} | {
    route: "cloud";
    reason: string;
};
export declare function defaultLocalTierPolicy(overrides?: Partial<LocalTierPolicy>): LocalTierPolicy;
/**
 * Decide whether a request should run on the local open-weight model or stay on
 * the cloud model. Conservative by construction: only small, tool-free requests
 * aimed at an eligible baseline route local; everything else stays cloud, with a
 * reason recorded either way.
 */
export declare function decideRoute(req: LocalTierRequest, policy: LocalTierPolicy): RouteDecision;
/**
 * The cloud cost a locally-run request avoided: the full catalogue-priced cost
 * of that request at its baseline cloud model. Returns null when the baseline is
 * unpriced (then the saving is recorded, never billed — as everywhere in MESH).
 * This is the GROSS cloud spend avoided; the customer's own compute is netted off
 * before any fee.
 */
export declare function cloudCostAvoidedUsd(baseline: {
    provider: string;
    model: string;
}, usage: TokenUsage, catalogue: PriceCatalogue, at: string): number | null;
