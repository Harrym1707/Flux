# Quickstart

> This file previously documented an early telemetry-receiver prototype that
> no longer exists. The real quickstart lives in the [README](../README.md)
> and on [www.fluxtoken.dev](https://www.fluxtoken.dev). Short version:

```bash
npx -y -p @flux-ai/sdk flux-proxy
```

Then point your client at it, keeping your own key:

```js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
```

Every request writes one hash-chained event under `./flux-ledger/`.
Recompute the invoice yourself:

```bash
node --import tsx evals/run-invoice.ts flux-ledger/<your-app>-anthropic.jsonl
```
