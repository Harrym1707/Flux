# FLUX --- Master Product & Engineering Specification

**Product:** FLUX\
**Positioning:** AI Cost Engineering\
**Tagline:** Make every token count.\
**Core promise:** Reduce AI inference cost without compromising
application-defined output quality.

------------------------------------------------------------------------

## 1. Product thesis

FLUX is an inference optimisation control plane for AI-native software.

It sits between an application and its model providers and continuously:

1.  observes inference traffic;
2.  classifies workloads;
3.  measures cost, latency and quality;
4.  creates candidate optimisations;
5.  evaluates candidates against production-like traffic;
6.  progressively rolls out only proven-safe changes;
7.  automatically rolls back when quality or reliability moves outside
    policy.

FLUX is **not** primarily a token dashboard and should not be positioned
as one.

The gateway/SDK is the enforcement mechanism. The product is the
optimisation system.

------------------------------------------------------------------------

## 2. Non-negotiable product invariant

> FLUX must never optimise for cost at the expense of a customer's
> defined quality contract.

Every optimisation must have one of three states:

-   `OBSERVE` --- measured but not deployed
-   `SHADOW` --- candidate runs alongside production
-   `ACTIVE` --- candidate is serving production traffic

An optimisation can move from SHADOW to ACTIVE only when its evaluation
policy passes.

If a deployed policy breaches its quality, reliability, latency or
safety thresholds, FLUX automatically rolls it back.

------------------------------------------------------------------------

## 3. Optimisation surface

FLUX should eventually optimise four dimensions:

### Model

-   model routing
-   model cascading
-   provider selection
-   reasoning-level selection where supported
-   fallback selection

### Context

-   duplicate context removal
-   irrelevant context filtering
-   history compression
-   prompt deduplication
-   retrieval-context optimisation

### Execution

-   semantic caching
-   request deduplication
-   tool-call reduction
-   agent step budgets
-   retry control
-   early stopping

### Infrastructure

-   provider routing
-   concurrency
-   batching where supported
-   regional/provider failover
-   cost/latency policy

------------------------------------------------------------------------

## 4. Product architecture

``` text
CUSTOMER APPLICATION
        |
        v
+-------------------+
|     FLUX SDK      |
|   or FLUX Proxy   |
+---------+---------+
          |
          v
+-------------------+
|     DATA PLANE    |
|                   |
| Policy lookup     |
| Request classify  |
| Route             |
| Cache             |
| Guard             |
| Provider call     |
+---------+---------+
          |
          +---------------------> MODEL PROVIDERS
          |
          v
+-------------------+
| ASYNC TELEMETRY   |
+---------+---------+
          |
          v
+-------------------+
|   CONTROL PLANE   |
|                   |
| Analytics         |
| Evaluations       |
| Experiments       |
| Optimiser         |
| Policy compiler   |
+---------+---------+
          |
          v
+-------------------+
| FLUX CONTROL UI   |
+-------------------+
```

The data plane must remain extremely lightweight. Expensive evaluation
and optimisation work belongs in the asynchronous control plane.

------------------------------------------------------------------------

## 5. Recommended initial stack

### SDKs

-   TypeScript first
-   Python immediately after
-   OpenAI-compatible wrapper
-   Anthropic-compatible wrapper
-   generic HTTP/provider adapter

### Backend

-   TypeScript
-   Fastify
-   PostgreSQL
-   Redis
-   ClickHouse
-   S3-compatible object storage
-   SQS/Redis Streams initially
-   Kubernetes/ECS only when justified by scale

### Dashboard

-   Next.js
-   TypeScript
-   Tailwind
-   component system with FLUX design tokens

### Infrastructure

-   AWS initially
-   infrastructure as code
-   OpenTelemetry-compatible tracing

Do not introduce Kafka, Kubernetes or a complex feature-store
architecture until traffic justifies them.

------------------------------------------------------------------------

## 6. Core data objects

### InferenceRequest

``` ts
type InferenceRequest = {
  requestId: string;
  applicationId: string;
  taskId?: string;

  provider: string;
  model: string;

  messages: Message[];
  tools?: ToolDefinition[];

  metadata?: Record<string, string>;

  inputTokens?: number;
  outputTokens?: number;

  timestamp: string;
};
```

### InferenceResult

``` ts
type InferenceResult = {
  requestId: string;

  output: unknown;

  inputTokens: number;
  outputTokens: number;

  costUsd: number;
  latencyMs: number;

  provider: string;
  model: string;

  finishReason?: string;
};
```

### QualityPolicy

``` ts
type QualityPolicy = {
  policyId: string;
  taskClass: string;

  minimumQuality: number;

  maximumErrorRate?: number;
  maximumLatencyMs?: number;

  requiredChecks: QualityCheck[];

  rollbackWindow: number;
};
```

### RoutingPolicy

``` ts
type RoutingPolicy = {
  policyId: string;
  taskClass: string;

  primary: ModelTarget;

  candidates: ModelCandidate[];

  rolloutPercentage: number;

  qualityPolicyId: string;
};
```

------------------------------------------------------------------------

## 7. Quality model

Never rely on one generic LLM-as-judge score.

FLUX should create task-specific evaluators.

Examples:

### Structured extraction

-   schema valid
-   required fields present
-   values correct
-   hallucination rate
-   exact-match / field-match metrics

### Coding

-   compilation
-   unit tests
-   integration tests
-   static checks
-   behavioural equivalence
-   task completion

### Customer support

-   factual correctness
-   policy compliance
-   relevance
-   hallucination
-   user outcome

### Classification

-   precision
-   recall
-   F1
-   confusion matrix

The quality engine should support deterministic checks first and
model-based judges only where deterministic evaluation is impossible.

------------------------------------------------------------------------

## 8. Shadow evaluation

For a candidate optimisation:

``` text
PRODUCTION REQUEST
       |
       +------> CURRENT PATH ------> USER
       |
       +------> CANDIDATE PATH
                       |
                       v
                  EVALUATION
```

The user receives only the production result.

The candidate is evaluated asynchronously or synchronously depending on
latency requirements.

Store:

-   candidate output
-   baseline output
-   evaluator results
-   cost
-   latency
-   failure modes
-   request class

------------------------------------------------------------------------

## 9. Progressive rollout

Never deploy an optimisation directly to 100%.

Default rollout:

``` text
1% -> 5% -> 10% -> 25% -> 50% -> 100%
```

At each stage calculate:

-   quality delta
-   error delta
-   latency delta
-   cost delta
-   retry delta
-   tool failure delta
-   user outcome delta where available

Rollback automatically if any hard threshold is breached.

------------------------------------------------------------------------

## 10. Model routing

Routing should optimise:

``` text
expected successful outcome
---------------------------
cost + latency + failure cost
```

not simply lowest token price.

A candidate model is eligible only if it has enough historical evidence
for the relevant task class.

Unknown workload:

``` text
unknown -> original model
```

Known and proven workload:

``` text
cheap candidate -> quality guard -> serve
```

Failed quality:

``` text
candidate -> escalate -> primary
```

------------------------------------------------------------------------

## 11. Token/context optimisation

FLUX should detect:

-   repeated system instructions
-   duplicated retrieved documents
-   stale conversation history
-   irrelevant context
-   oversized tool output
-   unnecessary metadata
-   redundant examples

Every optimisation generates:

``` text
baseline_tokens
candidate_tokens
baseline_quality
candidate_quality
estimated_savings
```

No context transformation becomes active without passing its quality
policy.

------------------------------------------------------------------------

## 12. Semantic cache

Cache key should include:

-   normalised task
-   relevant prompt fingerprint
-   semantic embedding
-   model/policy version
-   data-source version
-   TTL
-   customer-defined invalidation keys

Never serve stale cached information where freshness is
business-critical.

------------------------------------------------------------------------

## 13. Agent budgets

Provide:

``` ts
flux.agent({
  budget: {
    maxCostUsd: 0.10,
    maxTokens: 50000,
    maxSteps: 20
  }
});
```

Budget policy can trigger:

-   model downgrade
-   context compression
-   tool restriction
-   escalation
-   stop

A budget action must still respect the quality contract.

------------------------------------------------------------------------

## 14. Privacy

Default principles:

-   do not retain raw prompts/responses unless enabled
-   redact PII before telemetry where possible
-   hash fingerprints
-   encrypt data in transit and at rest
-   tenant-isolate all data
-   customer-controlled retention
-   enterprise self-hosted evaluator option

The SDK should expose:

``` ts
flux.configure({
  telemetry: {
    mode: "metadata_only"
  }
});
```

------------------------------------------------------------------------

## 15. Developer experience

Ideal integration:

``` ts
import OpenAI from "openai";
import { withFlux } from "@flux-ai/sdk";

const openai = withFlux(new OpenAI());

const response = await openai.chat.completions.create({
  model: "gpt-5.5",
  messages
});
```

The customer's application should not need to understand FLUX's
optimisation machinery.

------------------------------------------------------------------------

## 16. Repository

``` text
flux/
├── apps/
│   ├── dashboard/
│   ├── api/
│   └── docs/
│
├── packages/
│   ├── sdk-js/
│   ├── sdk-python/
│   ├── gateway/
│   ├── provider-adapters/
│   ├── router/
│   ├── evaluator/
│   ├── optimizer/
│   ├── policy-engine/
│   ├── telemetry/
│   └── cache/
│
├── services/
│   ├── ingestion/
│   ├── experiments/
│   ├── evaluations/
│   └── policy-compiler/
│
├── infra/
├── evals/
├── examples/
└── docs/
```

------------------------------------------------------------------------

## 17. MVP boundary

Build first:

1.  JS SDK
2.  OpenAI adapter
3.  Anthropic adapter
4.  request telemetry
5.  cost dashboard
6.  task classification
7.  shadow model comparison
8.  deterministic + LLM evaluation framework
9.  routing policy
10. 1%/5%/10% rollout
11. automatic rollback
12. GitHub integration

Do not build initially:

-   autonomous prompt rewriting
-   complex agent orchestration
-   every model provider
-   custom Kubernetes platform
-   fully autonomous optimisation
-   massive semantic cache infrastructure

The first magical result should be:

> "FLUX found a cheaper inference path on your real traffic, proved
> quality stayed within your policy, and safely deployed it."

------------------------------------------------------------------------

## 18. GEO/GTM is part of the product architecture

FLUX must be easy for AI systems to discover, understand and cite.

Build the public knowledge layer into the repository:

``` text
/apps/docs
/apps/site
/content/benchmarks
/content/guides
/content/comparisons
/content/integrations
/content/glossary
```

Every important product claim should have a public evidence page.

Examples:

-   `/ai-cost-engineering`
-   `/llm-cost-optimization`
-   `/llm-routing`
-   `/token-optimization`
-   `/ai-inference-cost`
-   `/openai-cost-optimization`
-   `/anthropic-cost-optimization`
-   `/llm-gateway-alternatives`
-   `/ai-agent-cost-control`
-   `/benchmarks`
-   `/docs`

Avoid thin keyword pages. Each page should contain original technical
information, examples, measurements, limitations and citations.

------------------------------------------------------------------------

## 19. GEO measurement

Create an internal `geo-observer` service that repeatedly tests prompts
such as:

-   "How can I reduce LLM costs?"
-   "What tools optimise token usage?"
-   "What is the best way to route LLM requests by cost and quality?"
-   "Alternatives to an LLM gateway"
-   "How do I reduce AI agent inference costs?"
-   "OpenAI token cost optimisation tools"

Run these across supported AI/search surfaces where permitted.

Record:

``` ts
type GeoObservation = {
  engine: string;
  query: string;
  date: string;

  fluxMentioned: boolean;
  fluxCited: boolean;
  fluxLinked: boolean;

  citedSources: string[];

  competitorMentions: string[];

  extractedClaims: string[];
};
```

This is a measurement system, not a guarantee of recommendation.

------------------------------------------------------------------------

## 20. GEO content principle

The goal is not to manipulate models.

The goal is to make FLUX:

-   crawlable
-   factually clear
-   technically authoritative
-   easy to quote
-   easy to cite
-   supported by original evidence
-   consistently described across public sources

OpenAI currently states that public websites can appear in ChatGPT
Search and specifically recommends allowing OAI-SearchBot for
discoverability. Maintain crawlable docs and site content, and expose
clear canonical product facts. See the official OpenAI crawler guidance.

------------------------------------------------------------------------

## 21. Brand system

### Colours

-   FLUX Black: `#0A0A0A`
-   FLUX Blue: `#2563FF`
-   Cool Grey: `#8B8F98`
-   Off White: `#F7F7F5`
-   Light Grey: `#E7E8EB`

### Typeface

Primary: Geist\
Alternative: Inter

### Visual language

-   thin system lines
-   routing diagrams
-   sharp geometry
-   large typography
-   restrained electric blue
-   black/off-white foundation
-   no generic AI imagery

### Voice

Technical, direct, evidence-led.

Never:

> "Revolutionary AI optimisation!"

Prefer:

> "FLUX reduced inference spend 31% while maintaining the customer's
> quality threshold."

Every public performance claim must link to methodology.

------------------------------------------------------------------------

## 22. Core positioning

# FLUX

## AI Cost Engineering

**Make every token count.**

FLUX continuously optimises AI inference --- routing requests, reducing
context and controlling agent spend without compromising
application-defined quality.
