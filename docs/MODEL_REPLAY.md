# Baseline and candidate replay

`corepack pnpm replay:run` exercises the replay runner with local fixture outputs. It does not contact a model service or require API credits. The runner invokes the baseline and candidate adapter sequentially for each request, records output, token usage and errors, then applies the replay quality policy.

## Use your own requests

Create a JSON config based on [`evals/replay-run.example.json`](../evals/replay-run.example.json). Each case contains:

- a stable ID;
- the expected answer used by the deterministic evaluator;
- the input sent to both targets;
- mock outputs if you are running in `mock` mode.

Use representative, labelled examples. Avoid personal or confidential data unless you have approval to send it to the configured model provider. The summary report stores metrics, model names, and failure IDs, but not request text or model output text.

## Live OpenAI mode

To make live calls, set both target providers to `openai`, put the exact model IDs in the config, and replace fixture prices with current prices per million input/output tokens. If your provider reports prompt-cache read or write usage, add `cachedInputPerMillion` and/or `cacheWriteInputPerMillion` to each target's pricing. Set `pricingIsIllustrative` to `false`, and record `pricingSource` and `pricingAsOf`. Put `OPENAI_API_KEY` in `.env`, then run:

```bash
corepack pnpm replay:run -- \
  --config path/to/your-replay.json \
  --policy path/to/your-policy.json \
  --mode openai \
  --out replay-summary.json
```

Live mode sends each request once to the baseline and once to the candidate, so it makes two provider calls per case and may incur usage charges. The runner is sequential and does not affect production traffic. It refuses illustrative or missing price inputs in OpenAI mode. If a provider call fails, the case counts as an error and the command exits with status `2`; a quality-policy failure also exits with status `2`.

Prices are supplied by the config author; FLUX does not fetch a pricing catalog in this milestone. Cache reads/writes are costed as separate input-token groups. When cache usage is present and the corresponding price is missing, the replay marks cost unavailable rather than assuming full-price or free tokens. The quality decision uses the offline evaluator's one-sided 95% Wilson lower bound and configured sample/error/savings gates. A passing result is eligible for review, not an automatic production rollout.

To evaluate a contextual reduction, set `candidate.contextProfileId` and provide a `candidateInput` alongside each full baseline `input`. `candidateInput` must be the exact candidate prompt your app's deterministic profile transform will produce. Replay compares the full baseline request with that reduced candidate request; it rejects a profile run if candidate inputs are missing.
