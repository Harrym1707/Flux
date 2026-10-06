# Context layer and multi-model simulation

## Runtime context layer

FLUX receives `taskClass`, `workflow`, `difficulty`, and `riskLevel` from the host application through `getContext`. These should be cheap, trusted facts the application already knows. A routing policy can match any subset of workflow, difficulty, and risk; unmatched traffic remains on the configured baseline.

Candidates can reference a versioned `contextProfileId`. Register that ID in `contextProfiles` with a synchronous transformation and optional exact context match. The transform may shorten history, remove duplicate/tool output, or select the task-relevant request fields. It runs only on the candidate route. Missing profiles, context mismatches, transform exceptions, and failed quality checks retry the untouched request on baseline.

Keep each transform version stable while evaluating it. In replay, provide the full baseline input and the exact transformed `candidateInput` for every case. When the transform changes, bump the profile version and replay again. The dashboard records the profile ID/version with request cost, provider cache usage, model attempts and quality fallback.

## Local simulation

Run:

```bash
corepack pnpm context:simulate
```

The fixed-seed fixture routes 180 requests through three model price/quality tiers and three workflows: support triage, invoice extraction and long-thread replies. Input sizes vary from 320 to 32,000 tokens; output sizes vary; cache reads and writes are charged at separate illustrative rates. Low-risk traffic is eligible for workflow-specific routes. High-risk traffic stays on baseline. The simulator evaluates each model/context-profile pair on a low-risk replay cohort, enforces quality confidence and cost gates, and then runs the approved routes through the same SDK wrapper with a synthetic provider.

The console output compares candidate-only quality with delivered answer quality after fallback, reports input tokens removed by the selected context profile, and shows cost and fallbacks per workflow. To save the complete model/profile matrix and workflow report:

```bash
corepack pnpm context:simulate -- --out /tmp/flux-context-report.json
```

All rates, outputs and quality errors in this simulation are authored fixtures. It makes no model/API calls and does not establish real model quality or savings. For product decisions, replace the synthetic fixtures with labeled requests and paired outputs from each actual model, then use replay and the same quality gates before approving a route.
