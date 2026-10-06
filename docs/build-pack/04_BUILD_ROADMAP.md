# FLUX --- Build Roadmap

## Stage 0 --- Repository foundation

Duration target: 3--5 days.

Create:

``` text
/apps
/packages
/services
/infra
/evals
/examples
/docs
```

Set up:

-   TypeScript monorepo
-   package manager
-   linting
-   formatting
-   unit tests
-   integration tests
-   CI
-   environment management
-   database migrations

------------------------------------------------------------------------

# Stage 1 --- Pass-through SDK

Goal:

Replace:

``` ts
new OpenAI()
```

with:

``` ts
withFlux(new OpenAI())
```

without changing application behaviour.

Acceptance:

-   all supported OpenAI calls pass through unchanged
-   request IDs generated
-   provider metadata captured
-   no meaningful latency regression
-   failure falls back to baseline

------------------------------------------------------------------------

# Stage 2 --- Telemetry

Capture:

-   model
-   provider
-   input tokens
-   output tokens
-   cost
-   latency
-   request type
-   errors
-   retries

Dashboard:

``` text
Spend
Requests
Tokens
Latency
Errors
Models
```

------------------------------------------------------------------------

# Stage 3 --- Task classification

Create task fingerprints.

Start with:

-   classification
-   extraction
-   summarisation
-   generation
-   reasoning
-   coding
-   tool use

Allow customers to override automatic classification.

------------------------------------------------------------------------

# Stage 4 --- Shadow experiments

Customer chooses:

``` text
Baseline: frontier model
Candidate: cheaper model
```

FLUX runs candidate traffic in shadow.

Dashboard:

``` text
QUALITY
98.8% baseline
98.7% candidate

COST
$0.021 baseline
$0.006 candidate

LATENCY
1.8s baseline
1.1s candidate
```

Candidate cannot be activated automatically until policy requirements
are met.

------------------------------------------------------------------------

# Stage 5 --- Quality engine

Implement:

``` text
Evaluator
EvaluatorRegistry
EvaluationDataset
EvaluationRun
EvaluationResult
QualityPolicy
```

Deterministic checks first.

Model judges second.

Custom customer evaluators third.

------------------------------------------------------------------------

# Stage 6 --- Router

Implement:

``` text
PolicyLoader
CandidateSelector
Router
RolloutManager
EscalationManager
RollbackManager
```

Initial rollout:

``` text
1%
5%
10%
25%
50%
100%
```

------------------------------------------------------------------------

# Stage 7 --- Context optimisation

Implement candidate transformations:

``` text
remove_duplicate_context
trim_stale_history
compress_history
filter_irrelevant_retrieval
deduplicate_system_instructions
```

Every transformation creates a candidate request and enters the
evaluation system.

------------------------------------------------------------------------

# Stage 8 --- Semantic cache

Start with exact caching.

Then semantic caching.

Do not make semantic caching production-default until:

-   freshness policy exists
-   invalidation exists
-   task classes are understood
-   false-positive cache rate is measurable

------------------------------------------------------------------------

# Stage 9 --- Agent budget control

Implement:

``` ts
maxCost
maxTokens
maxSteps
maxToolCalls
```

Budget policy actions:

``` text
continue
switch_model
compress_context
stop
escalate
```

------------------------------------------------------------------------

# Stage 10 --- GitHub onboarding

Create GitHub App.

Workflow:

``` text
Install GitHub App
      |
      v
Detect AI provider usage
      |
      v
Create FLUX config
      |
      v
Open optimisation report
```

Do not require repository write access for the initial audit.

------------------------------------------------------------------------

# Stage 11 --- GEO site

Launch:

-   docs
-   benchmarks
-   technical glossary
-   integrations
-   comparison pages
-   case studies
-   open-source repository

Add:

-   sitemap
-   robots.txt
-   structured metadata
-   canonical URLs
-   clear entity information

Keep pages technically useful rather than keyword-stuffed.

------------------------------------------------------------------------

# Stage 12 --- FLUX Signal

Create the AI visibility measurement system.

Track:

-   mention
-   citation
-   link
-   category association
-   factual description
-   source overlap

Use repeated measurements because AI search results can vary between
runs.

------------------------------------------------------------------------

# Stage 13 --- Public benchmark

Publish the first:

# FLUX Inference Economics Benchmark

Methodology must be reproducible.

Measure:

``` text
quality
cost
latency
failure rate
```

Publish raw methodology and limitations.

------------------------------------------------------------------------

# Stage 14 --- Production hardening

Before enterprise launch:

-   SOC 2 preparation
-   audit logging
-   SSO
-   RBAC
-   encryption
-   retention controls
-   private networking
-   data residency
-   self-hosted evaluation
-   incident response
-   policy signing
-   immutable rollout history

------------------------------------------------------------------------

# North-star metrics

### Product

-   \% inference spend optimised
-   cost reduction
-   quality delta
-   latency delta
-   rollback rate
-   optimisation activation rate

### Business

-   time to first identified saving
-   time to first deployed optimisation
-   savings per customer
-   expansion
-   retention

### GEO/GTM

-   organic developer traffic
-   GitHub stars/forks
-   docs-to-signup conversion
-   benchmark citations
-   AI mention rate
-   AI citation rate
-   correct-description rate
-   branded search growth

------------------------------------------------------------------------

# First milestone

Do not try to build "autonomous AI optimisation" immediately.

The first milestone is:

> A developer installs FLUX, connects one provider, replays real
> requests against a cheaper model, and receives statistically
> defensible evidence that the cheaper path meets their quality policy.

Once that works reliably, the rest of the FLUX product has a foundation.
