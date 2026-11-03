import type { FluxTokenReductionConfig, FluxOutputEffort } from "./reduce-request.js";

/**
 * Theo's per-user policy — the control mechanism between Theo and FLUX.
 *
 * Theo never sits in the request path. His ONLY action is to publish a new version
 * of this document; the proxy reads it and enforces it synchronously. A policy is
 * self-documenting: every lossy lever carries the gate proof (measured saving + the
 * measured quality delta Y + the grader) that justifies it.
 *
 * The load-bearing safety property is in `policyToReductionConfig`: a lossy lever is
 * applied ONLY if it carries a passing gate proof within the route's quality ceiling.
 * A policy therefore CANNOT enable a saving Theo has not proven — the "never degrade
 * the product" rule is enforced here, in code, not by trust.
 *
 * Pure and dependency-free (no node:*), so it loads in any JavaScript runtime.
 */

export type TheoLeverClass = "lossless" | "lossy";

/** The gate proof for a lossy lever: measured on the user's OWN traffic. */
export type TheoGateProof = {
  /** Measured saving on the user's traffic, from provider-reported usage. */
  savingPercent: number;
  /** Measured quality delta Y (<= 0; e.g. -0.3 = a 0.3% drop). */
  qualityDeltaPercent: number;
  /** What graded quality: "task-completion" | "tests" | "behavioural" | a custom name. */
  grader: string;
  provenAt: string;
};

export type TheoLever = {
  /** The reducer lever id (e.g. "tool-schema-compaction", "cache-ttl-5m", "output-effort-low"). */
  lever: string;
  class: TheoLeverClass;
  /** Required for a lossy lever before it can be enforced; absent for lossless. */
  gate?: TheoGateProof;
  /** Lever-specific params (e.g. { maximumTokens: 600 }, { maximumDescriptionTokens: 40 }). */
  params?: Record<string, unknown>;
};

export type TheoPolicy = {
  schemaVersion: 1;
  user: string;
  /** Optional per-route policy; a default route when omitted. */
  route?: string;
  /** Monotonic — publishing a new version is Theo's only action. Rollback = publish a prior one. */
  version: number;
  /** Max quality drop (percent) this route tolerates. Default STRICT; loosened only by the user. */
  qualityCeilingPercent: number;
  levers: TheoLever[];
  updatedAt: string;
};

/** Why a lever in the policy is NOT currently enforced — for Theo's transparency to the user. */
export type WithheldLever = { lever: string; reason: string };

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Whether a lossy lever's proof clears the route's quality ceiling. */
function proofClearsCeiling(lever: TheoLever, ceilingPercent: number): boolean {
  if (lever.gate === undefined) return false;
  const y = lever.gate.qualityDeltaPercent;
  return Number.isFinite(y) && Math.abs(y) <= ceilingPercent;
}

/** Map one lever id (+ params) onto the reducer config. Unknown ids are ignored. */
function applyLever(config: FluxTokenReductionConfig, lever: TheoLever): void {
  const p = lever.params ?? {};
  switch (lever.lever) {
    case "tool-schema-compaction":
      // Lossless tier only (keep descriptions).
      if (config.toolSchemas === undefined) config.toolSchemas = true;
      return;
    case "tool-schema-description-trim":
      config.toolSchemas = {
        descriptions: "truncate",
        ...(typeof p.maximumDescriptionTokens === "number" ? { maximumDescriptionTokens: p.maximumDescriptionTokens } : {}),
      };
      return;
    case "duplicate-context-removal":
      config.duplicateContext = true;
      return;
    case "cache-prefix-repair":
      config.repairCachePrefix = true;
      return;
    case "stale-history-compaction":
      config.historyCompaction = true;
      return;
    case "cross-turn-memory-dedup":
      config.crossTurnMemoryDedup = true;
      return;
    case "fresh-tool-result-cap":
      config.freshToolResultCap = typeof p.maximumTokens === "number" ? { maximumTokens: p.maximumTokens } : true;
      return;
    case "output-cap":
      if (typeof p.maxOutputTokens === "number") config.maxOutputTokens = p.maxOutputTokens;
      return;
    case "execution-tier-flex":
      config.executionTier = "flex";
      return;
    case "cache-ttl-5m":
      config.cacheTtl = "5m";
      return;
    case "cache-ttl-1h":
      config.cacheTtl = "1h";
      return;
    case "output-effort-low":
    case "output-effort-medium":
    case "output-effort-high":
    case "output-effort-xhigh":
    case "output-effort-max":
      config.outputEffort = lever.lever.replace("output-effort-", "") as FluxOutputEffort;
      return;
    default:
      return; // unknown lever id: ignore, never guess.
  }
}

/**
 * Turn a policy into the reduction config the proxy enforces.
 *
 * Lossless levers apply unconditionally (they cannot change the answer). A lossy
 * lever applies ONLY if it carries a gate proof whose measured quality delta is
 * within the route's ceiling; otherwise it is silently withheld. This is the
 * enforcement point of "never enable a saving we have not proven within budget."
 */
export function policyToReductionConfig(policy: TheoPolicy): FluxTokenReductionConfig {
  const config: FluxTokenReductionConfig = {};
  for (const lever of policy.levers) {
    if (lever.class === "lossy" && !proofClearsCeiling(lever, policy.qualityCeilingPercent)) continue;
    applyLever(config, lever);
  }
  return config;
}

/** The lossy levers present in the policy but NOT enforced, with the reason — for Theo's UX. */
export function withheldLevers(policy: TheoPolicy): WithheldLever[] {
  const out: WithheldLever[] = [];
  for (const lever of policy.levers) {
    if (lever.class !== "lossy") continue;
    if (lever.gate === undefined) {
      out.push({ lever: lever.lever, reason: "no gate proof yet — queued for the live gate" });
    } else if (!proofClearsCeiling(lever, policy.qualityCeilingPercent)) {
      out.push({
        lever: lever.lever,
        reason: `measured quality drop ${Math.abs(lever.gate.qualityDeltaPercent).toFixed(2)}% exceeds the ` +
          `${policy.qualityCeilingPercent}% ceiling for this route`,
      });
    }
  }
  return out;
}

/**
 * Publish a lever into a policy, returning a NEW version (never mutating the input).
 * A lossless lever is added as-is; a lossy lever must carry a gate proof. The version
 * bumps and updatedAt is set by the caller's clock (passed in, so this stays pure).
 */
export function publishLever(policy: TheoPolicy, lever: TheoLever, at: string): TheoPolicy {
  if (lever.class === "lossy" && lever.gate === undefined) {
    throw new Error(`Refusing to publish lossy lever '${lever.lever}' without a gate proof.`);
  }
  const levers = policy.levers.filter((existing) => existing.lever !== lever.lever);
  levers.push(lever);
  return { ...policy, levers, version: policy.version + 1, updatedAt: at };
}

/** A fresh, STRICT default policy for a new user — lossless-only until Theo proves more. */
export function defaultPolicy(user: string, at: string): TheoPolicy {
  return {
    schemaVersion: 1,
    user,
    version: 1,
    qualityCeilingPercent: 2, // strict by default; loosened only by the user's revealed preference
    levers: [
      { lever: "tool-schema-compaction", class: "lossless" },
      { lever: "duplicate-context-removal", class: "lossless" },
      { lever: "cache-prefix-repair", class: "lossless" },
    ],
    updatedAt: at,
  };
}

/** The reducer-lever ids Theo can enforce. */
export function knownLeverIds(): string[] {
  return [
    "tool-schema-compaction", "tool-schema-description-trim", "duplicate-context-removal",
    "cache-prefix-repair", "stale-history-compaction", "cross-turn-memory-dedup",
    "fresh-tool-result-cap", "output-cap", "execution-tier-flex",
    "cache-ttl-5m", "cache-ttl-1h",
    "output-effort-low", "output-effort-medium", "output-effort-high", "output-effort-xhigh", "output-effort-max",
  ];
}
