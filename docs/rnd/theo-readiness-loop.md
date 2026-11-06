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

### Iteration 2 — wire the answer-equivalence (safety) measurement
Hypothesis: safety was *asserted*, not *measured* — the top blocker. Wire it: run
the real lossless reducer (`reduceRequest`) on the coding-agent sample and assert
the auto / live-now config applies **only** lossless changes (a lossy change
leaking into the auto path = safety failure the loop must catch).
Delta: **all-lossless ✓** across 8 samples; measured auto-safe 6.12% (vs 7.0%
projected — a sane reducer-vs-model cross-check). Safety now *verified* on 1/9
workloads; no regression (corpus 9, dormant 0). **Kept.**
Next: extend answer-equivalence to the other 8 workloads (needs a per-profile
request synthesiser), then the AUTONOMY blocker (run on a real ledger spool).

### Iteration 3 — extend answer-equivalence to all 9 workloads
Hypothesis: safety was verified on 1/9; extend it across the corpus. Added a
per-profile request synthesiser (verbose tool schemas, a verbatim block re-sent
each turn, stable prefix) and ran `reduceRequest(lossless)` per workload;
coding-agent keeps its real sample.
Delta: **all 9 workloads lossless ✓** — the auto / live-now path applies no
answer-changing change anywhere. SAFETY criterion now measured corpus-wide (was
1/9). No regression (corpus 9, dormant 0). **Kept.**
Lead for next (important): measured auto-safe on the *synthetic* requests is ~0%
for rag-docqa / long-context-summarize / chatbot-memory, while the coverage
*model* projects 6–8% lossless for them. So either the synthesiser isn't creating
a real dedup/cache signal (likely — repeated whole messages may not dedup) or the
model over-projects lossless savings. Reconcile reducer-vs-model before trusting
the projection. Remaining hard blocker: AUTONOMY (run on a real ledger spool).

### Iteration 4 — reconcile reducer-vs-model; report REALISED vs projected auto-safe
Hypothesis (from iteration 3's lead): the auto-safe headline was the coverage
*model's* projection, not what the shipping lossless reducer actually removes.
Root cause found: the model credits `duplicate-context-removal` as a flat 10%
*deterministic* saving on any workload with `history`/`retrievedContext`, but the
shipping reducer's lossless dedup (`dedupeRepeatedBlocks`) only removes exact
blocks repeated *within one message body* — it never compares across turns. So
cross-turn redundancy (repeated memory / re-sent context) is modelled as auto-safe
while the code can only remove it *lossily* (the gated `cross-turn-memory-dedup`).
Change: the bench now plants duplication in the shape the lossless reducer can
actually catch (one exact overlapping chunk *inside* the retrieved-context
message; history left as distinct turns), measures auto-safe through the real
reducer per workload, and reports **realised** (reducer) alongside **projected**
(model), raising a SAVINGS blocker wherever projected − realised > 2pts.
Delta: median auto-safe **realised 0.9%** vs model-projected 6.8% — the honest
number is far lower. Over-projection confirmed on support-chat (6.0%→0.9%),
tool-heavy-agent (23.5%→6.5%), chatbot-memory (6.7%→0.0%). coding-agent realised
6.1% vs projected 7.0% (real sample, close). Safety held (all 9 lossless ✓),
dormant 0, corpus 9, tests 523/523. **Kept** — a lower-but-true headline is the
reward improving (honesty gate), and it surfaced a real over-projection.
Caveat: realised % for rag-docqa/long-context (20%+) is driven by the synthesiser's
chosen overlap geometry, not a claim about real traffic — only the cross-turn
over-projection and coding-agent's real sample are load-bearing here.
Lead for next: the auto-safe (lossless) tier is genuinely small; Mesh's value sits
in the GATED tier (median realisable ~60%). The next blocker is to *prove the
gated savings by replay* — verify the lossy levers hold answer-equivalence on real
output — and then AUTONOMY (run the pipeline on a real ledger spool unattended).
