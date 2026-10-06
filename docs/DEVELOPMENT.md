# FLUX Development

## First local milestone

Run the API after building the workspace and copying `.env.example` to `.env`:

```bash
pnpm build
pnpm start:api
```

Then run the example through your own application.

## Before implementing optimisation

Build the baseline measurement path first.

You need:

- request IDs
- provider/model
- input/output token usage
- cost
- latency
- errors
- task class

Only after baseline telemetry is reliable should routing be activated.

## Before production rollout

Every candidate policy needs:

- minimum sample size
- quality metric
- quality threshold
- error threshold
- latency threshold if applicable
- rollout stages
- rollback trigger
- policy version
- audit trail

## GEO development rule

Never create public benchmark numbers until the benchmark can be reproduced from the repository.

The content layer is part of the product, but it must reflect real engineering evidence.
