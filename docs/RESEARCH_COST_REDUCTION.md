# Cost reduction research: findings and FLUX priorities

This note consolidates the research-agent review of routing, prompt/context reduction, caching, execution controls and serving optimisations. The papers show promising techniques, but savings and quality depend on the workload and must be measured on FLUX's target jobs.

## Does workflow context help?

Yes, when the context is both cheap to obtain and predictive of which model or prompt shape a task needs. A workflow label such as `support.classification`, `invoice.extraction`, or `code.review`, plus a trusted difficulty/risk value, can choose a different replay-validated policy without asking another model to classify the request. A contextual bandit is a later option once FLUX has a reliable, delayed quality signal and enough traffic; it should not be the first routing mechanism.

Workflow context can also select a deterministic context profile. For example, a support reply may need the current issue and a compact summary of older turns, while a classification step may need only the latest message and a fixed label schema. The profile must preserve task-critical evidence and be evaluated against the full-context baseline. Net savings must include any compressor cost, the changed prompt-token cost, and changed cache reuse. If a separate LLM call is needed to discover the workflow or summarize context, that cost may erase the savings.

## Recommended order

1. **Measure actual request cost.** Attribute input, cached input, cache writes, output and fallback attempts to the route. Unknown price or incomplete provider usage must stay unknown rather than undercount.
2. **Exploit provider prompt caching.** Keep stable instructions, schemas and tool definitions at the start of prompts; put changing user content later; track the actual cached-token rate and bill cache reads/writes using current model prices. Provider prompt caching reuses matching prefixes; it does not make equivalent but differently ordered prompts match.
3. **Reduce avoidable context.** Remove duplicate history and irrelevant retrieved/tool output using deterministic, versioned profiles. Replay the transformed input with task-specific quality checks before rollout.
4. **Route by trusted task context.** Start with static workflow and risk policies built from paired baseline/candidate replay. Then trial learned routers against those baselines with held-out workload data and a quality floor.
5. **Control output and execution.** Evaluate output caps, retry limits, tool-loop limits, and asynchronous batch processing where latency requirements allow. Compare end-to-end cost, including rejected candidate calls and retries.
6. **Explore infrastructure savings later.** Quantization, prefix/KV caching in self-hosted runtimes, batching and speculative decoding can lower serving costs, but need a meaningful volume, hardware/latency benchmarks, and full infrastructure accounting.

## Research anchors

- [FrugalGPT](https://arxiv.org/abs/2305.05176) studies model cascades as a way to trade model quality against inference cost.
- [RouteLLM](https://arxiv.org/abs/2406.18665) learns strong-versus-weak model decisions from preference data; it motivates a learned-router experiment after FLUX has workload-specific evaluations.
- [Adaptive LLM Routing under Budget Constraints](https://aclanthology.org/2025.findings-emnlp.1301/) frames online routing as a contextual bandit. This is relevant to workflow-conditioned adaptation, but requires trustworthy feedback and careful budget/quality guardrails.
- [RECOMP](https://arxiv.org/abs/2310.04408) explores compressing retrieved context and selectively omitting irrelevant augmentation.
- [LLMLingua-2](https://arxiv.org/abs/2403.12968) treats prompt compression as a learned token-selection task. Learned compression should be compared with simpler application-specific pruning, including the compressor's own inference cost.
- The [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents stable-prefix reuse, usage fields such as `cached_tokens` and `cache_write_tokens`, and model-specific prices/behavior.

## FLUX implementation status

The current slice has contextual policy matching (`workflow`, `difficulty`, `riskLevel`), an application-provided context callback, versioned deterministic context transforms, and replay support requiring a candidate input for every case using a context profile. It also prices provider cache reads/writes separately and reports their usage in the local dashboard. The next useful product step is a small per-workflow report comparing ordinary input, cached reads/writes, output, fallback spend, quality and latency before and after each approved policy/profile.
