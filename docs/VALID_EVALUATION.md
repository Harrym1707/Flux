# FLUX evaluation data

FLUX compares cost and task quality on the same held-out requests. The router is selected using training records only; quality and cost are then reported on separate test records. Evaluation scores must be normalized to `[0, 1]`, but their meaning comes from the dataset's task-specific scorer. A code benchmark score, exact label match, and a customer acceptance score are not interchangeable.

## Run a public benchmark offline

### Contextual train/validation/test evaluation

For prompt-context routing experiments, use the contextual runner. It separates source rows into deterministic grouped train/validation/test sets, fits prompt-neighbor features on train, selects hyperparameters on validation, and reports cost, token, and joint cost-and-token objectives on the untouched test set:

```bash
corepack pnpm benchmark:contextual -- \\
  --root /path/to/bench-release \\
  --dataset livecodebench \\
  --split test \\
  --models model-a,model-b,model-c \\
  --out reports/livecodebench-contextual.json
```

The router uses local word, bigram, character, workflow, and task-class features with model outcomes from train rows. Validation selects among a fixed grid of neighborhood sizes and local/global weights, and requires at least 100 independent prompt groups by default. The joint objective only selects a per-request model predicted to use no more cost or tokens than the best-single fallback; the validation cohort must also show an aggregate reduction in both. Each router falls back to the train-selected best single model unless the validation cluster-bootstrap lower 95% bound stays within the configured quality-drop limit and its objective improves. Test confidence bounds also resample normalized prompt groups together. Do not tune settings after reading the held-out report; reserve a new seed or dataset for the next iteration.

[LLMRouterBench](https://github.com/ynulihao/LLMRouterBench) publishes per-model JSON results with prompt-level scores, token counts, costs, and outputs. Download and extract the upstream data using the authors' instructions; FLUX does not automatically download the large archive or load pickled data.

If the results contain one split such as `test`, FLUX makes a deterministic 70/30 train/test partition grouped by normalized exact prompt. Selection uses the 70% side and metrics use the remaining 30%:

```bash
corepack pnpm benchmark:run -- \
  --root /path/to/LLMRouterBench/results/bench \
  --dataset mmlu_pro \
  --split test \
  --models model-a,model-b,model-c \
  --out reports/mmlu-pro.json
```

The Hugging Face `bench-release.tar.gz` release also works directly after extraction. It mixes `bench-release/<dataset>/<split>/<model>/<result>.json` and `bench-release/<dataset>/<model>/<result>.json` layouts; pass the extracted `bench-release` directory as `--root`, the exact dataset folder as `--dataset`, and the source file's embedded split as `--split`. FLUX supports both layouts, merges model results when both appear, and checks each file's dataset and split metadata. For example:

```bash
corepack pnpm benchmark:run -- \
  --root /path/to/bench-release \
  --dataset arenahard \
  --split test \
  --out reports/arenahard.json
```

If the results include independent train/validation and test folders, preserve them instead:

```bash
corepack pnpm benchmark:run -- \
  --root /path/to/LLMRouterBench/results/bench \
  --dataset mmlu_pro \
  --train-split validation \
  --test-split test \
  --out reports/mmlu-pro.json
```

Each model folder may contain multiple timestamped JSON files; the importer selects the lexically latest JSON file, aligns records by `index`, and rejects prompt/answer mismatches or missing paired outputs. The report contains three test-set results: the strongest full-context single model selected on train, the cheapest static choice selected on train, and FLUX's per-workflow quality-gated route. It includes mean quality, cost, input/output token counts, route counts, cost savings, and a paired bootstrap lower 95% bound for quality change. No inference calls are made.

To score a router implementation's test decisions against that same output matrix, supply a JSONL file with one decision per held-out record:

```json
{"id":"mmlu_pro:42","router":"RouteLLM","choice":"model-folder-name","routingCostUsd":0.0002,"routingInputTokens":18,"routingOutputTokens":2}
```

Pass it with `--routes path/to/decisions.jsonl`. The `id` is `dataset:index`; `choice` must exactly match an imported model folder. Provide router inference cost and token overhead; use zero cost for a no-inference router. If routing cost is omitted, FLUX reports quality but marks total cost and savings unavailable. LLMRouterBench provides adapters for published routing baselines, but FLUX does not launch those implementations yet: produce their held-out per-case decisions with the chosen baseline's prescribed training split, then FLUX scores them on the shared model outputs.

Scores and costs remain benchmark-specific. Before comparing results, check that all model outputs were graded by the same official task scorer and that the source cost fields use the same currency/pricing basis. Public benchmark results establish generic routing behavior; they cannot prove savings on a team's app workload.

## Evaluate your own workload

For app-specific evidence, create a fixture of representative requests with stable test case IDs, task context, and an expected answer or trusted scorer. Invoke each model on the same cases using the existing replay runner, your test harness, or FLUX's opt-in SDK capture. Keep development/selection cases separate from final holdout cases.

The SDK capture is off by default. It stores prompt/response content only if `evaluationCapture` is explicitly configured, and requires a redactor. This example intentionally stores only token/cost/score data and a one-way group key; adapt it to your app's data policy:

```ts
import { createHash } from "node:crypto";
import { createLocalJsonlCapture, withFlux } from "@flux-ai/sdk";

const fixtureMetadata = new WeakMap<object, { caseId: string; groupId: string; expected: unknown }>();
function registerFixture(request: object, caseId: string, expected: unknown, normalizedInput: string) {
  fixtureMetadata.set(request, {
    caseId,
    groupId: createHash("sha256").update(normalizedInput.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex"),
    expected,
  });
  return request;
}

const capture = createLocalJsonlCapture(
  ".flux-captures/replay.jsonl",
  (record) => ({
    ...record,
    request: { model: (record.request as { model?: string }).model },
    expected: undefined,
    attempts: record.attempts.map(({ model, contextProfileId, maxOutputTokens, inputTokens, outputTokens, costUsd, score, error }) => ({
      model,
      contextProfileId,
      maxOutputTokens,
      request: { model },
      inputTokens,
      outputTokens,
      costUsd,
      score,
      error,
    })),
  }),
  {
    getCaseId: (request) => fixtureMetadata.get(request as object)?.caseId,
    getGroupId: (request) => fixtureMetadata.get(request as object)?.groupId,
    getExpected: (request) => fixtureMetadata.get(request as object)?.expected,
    score: (expected, response) => scoreForYourTask(expected, response),
  },
);

const client = withFlux(rawOpenAI, {
  applicationId: "my-app",
  pricingByModel: currentModelPricing,
  evaluationCapture: capture,
});

// In the test harness, register the request object and reuse its caseId for each model.
await client.responses.create(registerFixture({ model: "gpt-model", input: "..." }, "case-001", expectedLabel, "normalized input"));
```

`scoreForYourTask` must return a value from `0` (failure) to `1` (success). Use an application test oracle, deterministic schema/business-rule validator, or a human-reviewed quality label where appropriate. Do not use a model judge as the only ground truth without checking its reliability. The example uses a `WeakMap` so test labels and IDs stay out of provider requests. Set `getCaseId` to the same value when replaying a case across models. `getGroupId` should return the same non-sensitive hash for related or duplicate prompts so they cannot leak across train/test partitions.

For one capture file, FLUX creates a reproducible 70/30 grouped partition:

```bash
corepack pnpm benchmark:captures -- \
  --capture .flux-captures/replay.jsonl \
  --dataset support-replies \
  --out reports/support-replies.json
```

Or provide already separated capture files:

```bash
corepack pnpm benchmark:captures -- \
  --train-capture .flux-captures/train.jsonl \
  --test-capture .flux-captures/holdout.jsonl \
  --dataset support-replies \
  --out reports/support-replies.json
```

Each case must have paired results from at least two choices, complete provider token usage, and configured prices. Disable `exactCache` while collecting routing-comparison captures: cache hits are rejected because they are not independent model inference samples. Same-model context profiles and output caps are kept as distinct choices in the evaluation; the report maps those choices back to the provider model. Incomplete prices, errors, missing scores, duplicate draws, or train/test overlap stop the run rather than silently making a cheaper path look better.

## What counts as valid evidence

- Reuse the same cases, expected answers, scorer, provider settings, and price snapshot for every strategy.
- Choose workflow/context rules on training data only; do not tune them after looking at the holdout report.
- Keep related prompts together across splits and preserve a final holdout for each meaningful workflow.
- Report quality alongside cost and tokens. A lower bill is not a win if the task score falls beyond the agreed quality margin.
- Record the dataset version, model IDs, scorer version, prices and date, split seed, and routing thresholds alongside the JSON/Markdown report.
- Treat public benchmark reports as generic evidence and customer workload reports as app-specific evidence. Neither is a guarantee of future spend or quality.

The public importer follows the [LLMRouterBench result format](https://github.com/ynulihao/LLMRouterBench) and its [published result archive](https://huggingface.co/datasets/NPULH/LLMRouterBench).
