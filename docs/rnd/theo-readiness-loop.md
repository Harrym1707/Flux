# Theo readiness loop

A continuous build-measure-improve loop driving Theo/Mesh to end-user readiness.
The benchmark (`evals/theo-readiness-bench.ts`) is the reward signal; each
iteration targets the biggest measured gap, keeps a change only if the reward
improves and safety holds, commits, and logs the delta here.

## Reward signal (in priority order)

1. **Safety (hard gate).** Answer-equivalence 100% + zero runtime errors across
   the corpus. A change that regresses safety is reverted, no matter its savings.
2. **Realised savings.** Auto-safe (lossless, live immediately) first; gated
   upside (lossy, behind the replay gate) second.
3. **Coverage.** Of the catalogue levers applicable to a workload, how many Theo
   applies (M / N).
4. **No silent dormancy.** Every workload either saves, or is honestly flagged
   lean (little capturable waste), or surfaces its uncaptured waste as a named
   gap — never saves nothing while waste sits there unmentioned.

## Done criteria (ship-ready)

- Corpus ≥ 8 diverse workload types.
- 100% answer-equivalence + zero errors on every workload.
- Median realised savings above target on workloads that have real waste.
- Zero `DORMANT` workloads (uncaptured waste with no saving and no flag).
- The full pipeline (observe → apply lossless → gate lossy → bill projection)
  runs end-to-end unattended.

## Guardrails

- Branch `theo/readiness-loop`; commit every iteration; **never push/merge to main**.
- All tests green and the honesty invariants intact each iteration.
- Only this loop's own files are committed (the pre-existing uncommitted
  `docs/rnd` / `docs/strategy` / `package.json` / `.gitignore` edits are left alone).

## Iteration protocol

Read `evals/results/theo-readiness.json` → pick the single biggest blocker →
smallest change → re-run the bench → keep only if reward improves and safety
holds (else revert) → `pnpm test` → commit → append a log row below.

## Progress log

### Iteration 0 — baseline (measurement foundation)
Established the branch, this charter, and the benchmark harness over a starter
corpus. Baseline numbers and the first blockers are recorded in
`evals/results/theo-readiness.json`. No Theo logic changed yet — this iteration
only makes "ready" measurable. See the next iterations for the first
reward-driven improvements.

### Iteration 1 — corpus 5 → 9 (clear the CORPUS blocker)
Hypothesis: a bigger, more diverse corpus clears the `CORPUS 5/8` blocker and
surfaces more behaviour for later iterations. Added `long-context-summarize`,
`tool-heavy-agent`, `chatbot-memory`, `translation`.
Delta: corpus 5→9 · median auto-safe 5.96%→6.8% · median realisable
57.89%→60.1% · dormant 0 · no safety regression. **Kept.**
Lead for next: `batch-classifier`, `already-lean`, `translation` all show ~0%
auto-safe but large gated upside — lossless levers don't bite without structural
redundancy, so their *safe* savings hinge entirely on the gate. The top remaining
blocker is now SAFETY: wire an answer-equivalence measurement across the corpus.
