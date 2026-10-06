# Cost and quality routing

FLUX routing replaces the configured baseline model for a stable share of requests in a task class. It assigns a candidate only when all configured gates pass:

- a replay report has enough samples and meets the quality floor and allowed accuracy drop;
- the report identifies the same baseline and candidate models and shows lower total candidate cost;
- the candidate is explicitly approved after review;
- the request's stable key falls within that candidate's configured traffic share.

If a policy is missing, invalid, mismatched, or not approved, the SDK sends the original baseline model. Request contents are not used as routing keys; provide a stable, non-sensitive tenant, user, or job identifier with `getRequestKey`. Candidate traffic shares are disjoint stable hash intervals ordered automatically by measured replay cost per request, and must sum to at most 1. Any remaining traffic stays on baseline.

## From replay to live routing

Run a paired replay on your labeled workload. A real-model replay spends API credits, so inspect the case count and prices before starting:

```bash
corepack pnpm replay:run -- --config path/to/replay-config.json --mode openai --out replay-report.json
corepack pnpm route:policy -- --report replay-report.json --task-class support.classification --traffic-share 0.05 --out flux-routing-policy.json
```

The policy command converts the report into the SDK policy shape and leaves `approved` set to `false`. Review the report and generated policy, then explicitly set `approved` to `true`. The report must pass its quality gates and include complete costs for the SDK to route to the candidate. Passing replay gates is not a guarantee of future quality.

Load the reviewed policy into your SDK setup. Define `classify` using cheap, trusted application context: for example, map requests to separate task classes such as `support.simple` and `support.complex`, then attach different candidate policies to those classes. Do not add another model call just to decide which model to call.

```ts
import { readFile } from "node:fs/promises";
import type { FluxRoutingPolicy } from "@flux-ai/sdk";

const routingPolicy = JSON.parse(
  await readFile("flux-routing-policy.json", "utf8"),
) as FluxRoutingPolicy;

const openai = withFlux(rawOpenAI, {
  applicationId: "support-app",
  classify: () => "classification",
  getContext: (request) => {
    const metadata = (request as { metadata?: { workflow?: string; difficulty?: "low" | "medium" | "high"; riskLevel?: "low" | "medium" | "high" } }).metadata;
    return {
      workflow: metadata?.workflow,
      difficulty: metadata?.difficulty,
      riskLevel: metadata?.riskLevel,
    };
  },
  contextProfiles: [{
    id: "support-history-v1",
    version: "1",
    match: { workflow: "support.reply" },
    // Keep this transform stable: it must match the one used to build replay candidateInput.
    transform: (request) => reduceSupportHistory(request),
  }],
  pricingByModel: {
    "gpt-baseline": { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    "gpt-cheaper": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  },
  routing: {
    getRequestKey: (request) => (request as { metadata?: { jobId?: string } }).metadata?.jobId,
    policies: [routingPolicy],
  },
  qualityCheck: ({ request, response }) => validateResponseForTask(request, response),
  exactCache: {
    maxEntries: 1_000,
    ttlMs: 60_000,
    getScopeKey: (request) => (request as { metadata?: { tenantId?: string } }).metadata?.tenantId,
  },
});
```

With a 5% share, stable request keys in that cohort use the candidate; other requests stay on the baseline. A policy can also match exact `workflow`, `difficulty`, and `riskLevel` values. Populate these from trusted application state (for example, the workflow stage already known by your app); do not make another model call just to classify a request. Generate a policy for a specific context with `--workflow`, `--difficulty`, and `--risk-level` on `route:policy`.

Context can reduce cost in two ways: it can choose a cheaper candidate only for workflows where that candidate is reliable, and a versioned `contextProfileId` can select a deterministic prompt/history reducer. For context reduction, replay the baseline's full request against a candidate input produced by the same reducer. Add `candidate.contextProfileId` to the replay config and `candidateInput` to every request case; replay fails closed if any case lacks it. Register the same profile ID and version in `contextProfiles` at runtime. FLUX checks the profile's context match, applies it only on the candidate path, and retries the original request on the baseline if the profile is unavailable, mismatched, or fails. Keep task instructions and necessary evidence, and quality-check the reduced-context candidate against your labeled examples.

To cap candidate output, set `candidate.maxOutputTokens` in the replay config before evaluation; the cap is applied during replay and copied into the generated policy. FLUX will not add a candidate cap after quality evaluation. If the application's quality check rejects a truncated result, FLUX retries the original request on the baseline with its original output limit. Actual savings depend on live token distributions and current provider prices. `pricingByModel` should use current per-model rates to estimate the cost of every attempt. Include provider prompt-cache read and write prices when that model reports those token classes:

```ts
pricingByModel: {
  "gpt-baseline": {
    inputPerMillion: 2.0,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 8.0,
  },
}
```

FLUX prices ordinary input, cache reads, cache writes, and output as separate token groups. If a response reports cached or cache-write tokens but the matching rate is missing, `costUsd` is left unknown instead of undercounting. The SDK event and local dashboard preserve the provider's cache token breakdown. Provider prompt caching is separate from FLUX's opt-in exact-response cache; prompt caching still runs at the provider and may be billed at a different rate. See the [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) for the current usage fields and model-specific behavior.

Supply `qualityCheck` with a cheap task-specific validator when available: schema validation, exact labels, business rules, or an application-level acceptance signal. A rejected candidate or validator error causes one baseline retry. The retry restores the original request, including its original output-token limit. Events sum known tokens and cost across provider attempts, so a fallback that needed two calls is not counted as a one-call saving.

`exactCache` is opt-in and stores completed responses in process memory. It hashes the complete normalized JSON request, selected model, and your required tenant/scope key. It bypasses streaming, tool, continuation, and non-JSON requests; it also bypasses calls that pass provider request options as a second argument. A cache hit reports zero incurred tokens/cost and the previous request's avoided tokens/cost. The cloned response retains the original provider usage metadata, so use the FLUX event for current-request billing. The optional quality check still runs on a cached candidate result. Cache entries hold response content in memory until expiry/eviction; choose scope and TTL to meet your tenant-isolation, freshness, and data-handling requirements. There is no semantic or approximate cache.

## Limits of this first routing slice

The SDK performs stable, quality-gated canary assignment and per-request fallback when the application's validator rejects a candidate. It does not yet learn from delayed user feedback, persist policy state, fetch provider prices, or automatically advance traffic shares. Rollback across requests still means changing the configured share to zero or removing approval; automated circuit breaking requires durable state and a trustworthy quality signal.
