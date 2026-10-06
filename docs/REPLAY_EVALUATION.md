# Offline replay evaluation

The replay evaluator compares recorded baseline and candidate outputs against expected answers. It does not call a model or alter production traffic. Use it to evaluate captured/replayed model results before considering a rollout.

## Dataset format

```json
{
  "name": "Support classification replay",
  "notice": "Optional disclosure shown with the report.",
  "requests": [
    {
      "id": "request-001",
      "expected": "billing",
      "baseline": "billing",
      "candidate": "billing",
      "baselineCostUsd": 0.01,
      "candidateCostUsd": 0.003,
      "candidateError": false
    }
  ]
}
```

Every record needs a unique `id`, `expected`, `baseline`, and `candidate`. Cost values are optional, but totals are reported only when every record has a cost for both paths. Error flags are optional and count as incorrect outputs when set to `true`.

## Policy format

```json
{
  "evaluator": "classification",
  "minimumSamples": 100,
  "minimumCandidateAccuracy": 0.95,
  "maximumAccuracyDrop": 0.02,
  "maximumCandidateErrorRate": 0.01,
  "minimumCostSavingsPercent": 10
}
```

`classification` compares strings after trimming and ignoring case. `exact_match` compares JSON values (object key order is ignored). Candidate accuracy must meet the policy using a one-sided 95% Wilson lower confidence bound; the observed accuracy is reported too. `maximumAccuracyDrop`, when set, gates the observed baseline-to-candidate accuracy difference. Cost savings and error rate gates are optional. Candidate failures and baseline-to-candidate regressions are listed by record ID. A passing report means only that this saved dataset passes the configured gates and is eligible for human review. It does not activate a policy or prove quality on future traffic. The command exits with status `2` when any gate fails, so a blocked candidate can stop a CI workflow.

## Run it

```bash
corepack pnpm eval:replay -- \
  --dataset path/to/dataset.json \
  --policy path/to/policy.json \
  --out report.json
```

If omitted, dataset and policy default to `evals/replay-demo.json` and `evals/replay-policy.example.json`. Those files contain synthetic demonstration data, not measured model results.
