# Quickstart

> This file previously documented an early telemetry-receiver prototype that
> no longer exists. The real quickstart lives in the [README](../README.md)
> and on [www.mesh-technology.com](https://www.mesh-technology.com). Short version:

```bash
npx -y -p @mesh-ai/sdk mesh-proxy
```

Then point your client at it, keeping your own key:

```js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
```

Every request writes one hash-chained event under `./mesh-ledger/`.
Recompute the invoice yourself:

```bash
node --import tsx evals/run-invoice.ts mesh-ledger/<your-app>-anthropic.jsonl
```
