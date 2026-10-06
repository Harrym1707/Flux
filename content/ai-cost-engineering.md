# AI Cost Engineering

AI cost engineering is the practice of reducing the total cost of AI inference while preserving the application's required quality, reliability and latency.

The main optimisation surfaces are:

1. **Model selection** — use a lower-cost model when evaluation evidence shows it meets the workload's quality contract.
2. **Context optimisation** — remove redundant or irrelevant input without changing the task outcome.
3. **Caching** — reuse valid responses when the underlying information and task semantics permit it.
4. **Execution control** — prevent unnecessary retries, tool calls and agent steps.
5. **Provider routing** — select among providers based on cost, quality, latency and availability.

A safe optimisation system should not assume that the cheapest model is the best choice. It should measure the candidate against the real workload and define explicit rollback conditions.

## FLUX project status

FLUX is an early-stage project. The current prototype can route a stable canary share to replay-approved models, apply versioned context transforms, retry rejected candidates on the baseline, and account for provider prompt-cache usage and an opt-in exact response cache. Replay evidence is required before candidates can be approved. Online learning, durable policy state and automated circuit breaking are not implemented.
