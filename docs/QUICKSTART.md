# Quickstart: instrument an OpenAI app

This starter repo is not published to npm yet. These steps run the local telemetry receiver and a working OpenAI example from this repository.

## 1. Install prerequisites and dependencies

Install Node.js 22 or newer. From the repository root, use Corepack to install the workspace dependencies:

```bash
corepack pnpm install
cp .env.example .env
```

For the mock example, no API key is needed. To make a real OpenAI request, set `OPENAI_API_KEY` in `.env` and optionally set `OPENAI_MODEL` to a model available to your account. To see a cost estimate in the dashboard, supply that model's input and output USD rates per million tokens in `FLUX_INPUT_PRICE_PER_MILLION` and `FLUX_OUTPUT_PRICE_PER_MILLION`. Rates are explicitly supplied and are not fetched or updated by FLUX. Keep `.env` private; it is ignored by git.

## 2. Build and start the local receiver

In terminal one:

```bash
corepack pnpm build
corepack pnpm start:api
```

The local dashboard is at `http://127.0.0.1:18787/`. It keeps up to 500 metadata events in memory. Check API health at `http://127.0.0.1:18787/health`.

## 3. Run the mock example (no API key or credits needed)

In terminal two:

```bash
corepack pnpm example:mock
```

This makes no external model call. It prints a mock output and a `FLUX request` event in terminal two; the local dashboard refreshes to show its usage metadata.

To see the offline quality gate, run `corepack pnpm eval:replay`. It compares saved baseline and candidate outputs against labels, checks a quality policy, and reports whether the candidate is eligible for review. Its costs and outputs are fictional fixtures, not product measurements.

To run both baseline and candidate adapters over a local input fixture, run `corepack pnpm replay:run`. Details for custom input datasets and explicitly enabled live OpenAI runs are in [`MODEL_REPLAY.md`](MODEL_REPLAY.md).

Use your own saved comparison with `corepack pnpm eval:replay -- --dataset path/to/dataset.json --policy path/to/policy.json --out report.json`. The report includes a one-sided 95% Wilson lower bound for candidate accuracy; the policy threshold is applied to that conservative bound. The CLI evaluates saved outputs and does not call a model.

To make a real OpenAI request instead, set `OPENAI_API_KEY` in `.env` and run `corepack pnpm example`. The account behind the key must have API credits. Prompt and response contents are not sent to FLUX.

## What you should see

Each event includes a FLUX request ID, application ID, provider, requested model, optional task class and token usage, elapsed time, status, and timestamp. Token usage is only present when the provider returns it. If you provide the model's current per-million input/output prices, FLUX calculates an estimate from returned token counts. It does not fetch or update prices automatically. The SDK remains pass-through; model comparisons run only when you explicitly start the replay command.

For production use, this example receiver still needs durable storage, authentication, tenant isolation, and retention controls. Do not expose the development receiver publicly.
