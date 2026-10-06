# FLUX --- Technical Architecture

## 1. Runtime model

FLUX has two planes.

### Data plane

Latency-sensitive.

Responsibilities:

-   intercept request
-   load policy
-   classify known workload
-   select candidate
-   enforce budget
-   invoke provider
-   collect telemetry
-   return result

### Control plane

Asynchronous.

Responsibilities:

-   analyse traffic
-   identify optimisation opportunities
-   run shadow experiments
-   evaluate candidates
-   create policies
-   compile policies
-   publish policy versions
-   monitor rollouts

------------------------------------------------------------------------

## 2. Data plane

``` text
SDK
 |
 v
Request Normaliser
 |
 v
Policy Cache
 |
 +--> no policy --> Baseline Provider
 |
 +--> policy
       |
       v
Candidate Selector
       |
       v
Quality Guard / Budget Guard
       |
       v
Provider Adapter
       |
       v
Response
       |
       +----> async telemetry
```

Policy lookups should normally be local/in-memory/Redis-backed.

Never perform an expensive database query or LLM call in the hot path
unless explicitly required.

------------------------------------------------------------------------

## 3. Provider abstraction

``` ts
interface ModelProvider {
  name: string;

  complete(
    request: NormalizedRequest
  ): Promise<NormalizedResponse>;

  estimateCost(
    request: NormalizedRequest
  ): Promise<number>;

  supports(
    capability: string
  ): boolean;
}
```

Provider adapters:

``` text
OpenAIProvider
AnthropicProvider
GoogleProvider
OpenRouterProvider
GenericOpenAICompatibleProvider
```

The generic adapter is important for developer adoption.

------------------------------------------------------------------------

## 4. Normalised request

``` ts
type NormalizedRequest = {
  requestId: string;
  tenantId: string;

  taskClass?: string;

  model: {
    provider: string;
    name: string;
  };

  messages: NormalizedMessage[];

  tools?: NormalizedTool[];

  parameters: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: unknown;
  };

  metadata: Record<string, string>;
};
```

------------------------------------------------------------------------

## 5. Routing engine

Routing must be deterministic once a policy is selected.

``` ts
interface Router {
  route(
    request: NormalizedRequest,
    policy: RoutingPolicy
  ): RoutingDecision;
}
```

Decision:

``` ts
type RoutingDecision = {
  target: ModelTarget;
  reason: string;
  policyId: string;
  policyVersion: number;
};
```

Example reason:

``` text
task_class=classification
candidate=small-model
quality_evidence=99.4%
threshold=99.0%
estimated_cost_reduction=71%
rollout=10%
```

------------------------------------------------------------------------

## 6. Evaluation architecture

``` text
Production traces
       |
       v
Dataset Builder
       |
       +------> Baseline
       |
       +------> Candidate
                    |
                    v
              Evaluator Fanout
                    |
       +------------+------------+
       v            v            v
 deterministic   judge       custom
       |            |            |
       +------------+------------+
                    |
                    v
             Evaluation Result
                    |
                    v
             Policy Decision
```

Evaluation results should support confidence intervals and minimum
sample sizes.

Do not activate a policy based on one or two examples.

------------------------------------------------------------------------

## 7. Policy compiler

Human-readable policy:

``` yaml
task: customer_support.classification

baseline:
  provider: openai
  model: gpt-x

candidate:
  provider: openai
  model: cheaper-model

quality:
  metric: f1
  minimum: 0.985

rollout:
  stages:
    - 0.01
    - 0.05
    - 0.10
    - 0.25
    - 0.50
    - 1.00
```

Compiler converts this into a runtime-optimised policy.

------------------------------------------------------------------------

## 8. Storage

### PostgreSQL

Transactional state:

-   tenants
-   applications
-   users
-   models
-   policies
-   experiments
-   evaluations
-   rollout states

### ClickHouse

High-volume events:

-   inference events
-   token usage
-   latency
-   routing decisions
-   quality measurements

### Redis

Hot state:

-   policy cache
-   rollout percentage
-   rate limits
-   semantic cache metadata
-   budget counters

### Object storage

Large objects:

-   evaluation datasets
-   optional traces
-   benchmark artifacts

------------------------------------------------------------------------

## 9. Event schema

``` ts
type InferenceEvent = {
  eventId: string;
  timestamp: string;

  tenantId: string;
  applicationId: string;

  requestId: string;

  taskClass?: string;

  provider: string;
  model: string;

  inputTokens: number;
  outputTokens: number;

  costUsd: number;
  latencyMs: number;

  policyId?: string;
  policyVersion?: number;

  routeReason?: string;

  quality?: {
    score?: number;
    passed?: boolean;
  };
};
```

------------------------------------------------------------------------

## 10. Security

Every request is tenant-scoped.

Enforce:

``` text
tenant_id
application_id
policy_id
```

at every persistence boundary.

No cross-tenant cache entries.

Use signed policy versions and immutable audit events for production
decisions.

------------------------------------------------------------------------

## 11. Failure behaviour

If FLUX control plane is unavailable:

``` text
FLUX SDK
   |
   v
cached policy?
   |
  YES ---> use cached policy
   |
   NO
   |
   v
baseline provider
```

The application should continue working.

FLUX should fail open to the customer's baseline unless the customer
explicitly chooses fail-closed behaviour.

------------------------------------------------------------------------

## 12. Latency budget

Target:

-   local SDK overhead: \<5ms p50
-   policy lookup: \<2ms p50 with cache
-   no network call for normal policy decisions
-   async telemetry should not block response

Measure these continuously.

------------------------------------------------------------------------

## 13. Quality-safe optimisation loop

``` text
OBSERVE
   |
   v
IDENTIFY
   |
   v
SIMULATE
   |
   v
SHADOW
   |
   v
EVALUATE
   |
   +---- fail ----> DISCARD
   |
   v
1% ROLLOUT
   |
   +---- fail ----> ROLLBACK
   |
   v
5%
   |
   v
10%
   |
   v
...
   |
   v
100%
```

This loop is the core FLUX product.
