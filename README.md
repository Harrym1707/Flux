# FLUX

**AI Cost Engineering — Make every token count.**

FLUX is being built to help AI-native teams find lower-cost inference paths while preserving the quality their applications require.

## Cost and quality routing prototype

The SDK routes a stable share of each task class from a configured baseline to the cheapest approved candidate that passed offline quality and cost gates. An application quality check can reject candidate output and retry on the baseline. Candidate output caps must be evaluated in replay. An opt-in, tenant-scoped exact cache avoids repeat inference for identical safe requests. Request contents are never used as routing keys.

```ts
import OpenAI from "openai";
import { withFlux } from "@flux-ai/sdk";

const openai = withFlux(new OpenAI(), {
  applicationId: "my-app",
  classify: () => "support.classification",
  routing: {
    getRequestKey: (request) => (request as { metadata?: { jobId?: string } }).metadata?.jobId,
    policies: [/* reviewed replay evidence and approved candidate traffic share */],
  },
  qualityCheck: ({ request, response }) => validateForThisTask(request, response),
  onEvent: (event) => console.info("FLUX", event),
});

const result = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Classify this support request.",
});
```

See [`docs/COST_QUALITY_ROUTING.md`](docs/COST_QUALITY_ROUTING.md) for the routing policy format and safety gates. See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for setup and the local telemetry receiver.

Run `corepack pnpm example:mock` to see FLUX work without an OpenAI key or API credits.

Run `corepack pnpm replay:run` for a fully local baseline/candidate replay demonstration. To use live OpenAI models, provide a custom replay config with explicit current prices and run `corepack pnpm replay:run -- --config path/to/config.json --mode openai`; this makes two API calls per case.

Run `corepack pnpm route:demo` for a no-network demonstration of replay gates, SDK routing, and spend comparison. Turn an actual replay report into an unapproved SDK policy with `corepack pnpm route:policy -- --report replay-report.json --task-class your.task.class --traffic-share 0.05`.

Run `corepack pnpm context:simulate` for a local simulation across 3 model tiers, 3 workflows, 180 requests, varied 320–32,000-token prompts, versioned context profiles, risk-aware routing, quality gates and fallback costs. It makes no provider calls; fixture quality is illustrative, not a real-model benchmark. Add `-- --out /tmp/flux-context-report.json` to save the detailed model/workflow report.

## Measure cost and quality on held-out data

Run `corepack pnpm benchmark:run -- --root /path/to/results/bench --dataset mmlu_pro --split test` to import already-computed LLMRouterBench outputs and compare the strongest single model, cheapest static choice, and FLUX's quality-gated workflow route. The importer makes no provider calls and writes JSON plus Markdown reports. For application-specific evidence, explicitly enable the redacted SDK capture and run `corepack pnpm benchmark:captures -- --capture .flux-captures/replay.jsonl --dataset my-workflow`. See [`docs/VALID_EVALUATION.md`](docs/VALID_EVALUATION.md) for data setup, capture privacy, holdout rules, and interpretation.

## Current scope and limits

- OpenAI-compatible `responses.create()` wrapper with stable, task-class-based candidate routing
- Candidate requires reviewed offline replay evidence, enough samples, a quality floor, allowed accuracy drop, and lower measured replay cost
- Application quality checks can trigger a baseline retry; attempted-model tokens and known cost are aggregated
- Candidate output caps must be part of replay evidence
- Workflow, difficulty, and risk context can constrain policies; deterministic, replayed context profiles can reduce candidate prompts
- Context profiles are versioned, can require workflow matches, and are recorded in telemetry
- A local multi-model, multi-token simulation reports candidate quality, confidence bounds, final quality, input tokens, fallbacks and cost by workflow
- Provider prompt-cache reads/writes are counted and costed separately when usage and matching prices are available
- Optional in-memory exact response cache with TTL and required tenant scope; streaming, tools, and continuation calls bypass it
- Unassigned traffic, invalid policies, and unapproved or ineligible candidates stay on the baseline
- Optional per-model prices for estimating real request cost
- Request IDs, model, task class, duration, status and provider token usage when returned
- Local metadata dashboard with recent in-memory events
- Optional cost estimates from user-supplied model prices
- Optional callback for immediate local inspection
- Optional metadata-only telemetry delivery
- Offline replay evaluation for saved baseline/candidate outputs against a quality contract
- Replay-report-to-policy command; candidate approval remains explicit
- Telemetry and callback failures do not affect the provider response

This is an initial routing slice, not autonomous optimization. Candidate rejection can trigger a same-request baseline retry, but FLUX does not yet learn from delayed user feedback or automatically disable a candidate across future requests. Durable policy state and automatic circuit breaking are still to come. The included replay fixture is synthetic; it does not establish real savings or quality equivalence.
