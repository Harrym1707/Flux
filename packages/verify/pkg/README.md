# @flux-ai/verify

The verification half of [FLUX](https://www.fluxtoken.dev), under MIT.

FLUX bills 1% of verified LLM API savings from an append-only, hash-chained
ledger that lives on the customer's own disk. An honesty claim you cannot
independently check is worthless — so the tools that CHECK FLUX's numbers are
published here, separately, under MIT, with zero dependencies and no network
access. The FLUX product itself is source-available under BUSL-1.1; this
package is not, on purpose.

```bash
npx -y -p @flux-ai/verify flux-verify flux-ledger/proxy-anthropic.jsonl
```

verifies every hash link in the spool and recomputes the invoice from its
events. If your recomputation disagrees with a number FLUX quoted you, yours
wins — that is the contract.

Library use:

```js
import { verifyLedgerChain, recomputeInvoice } from "@flux-ai/verify";
```

Ledger format and methodology: https://www.fluxtoken.dev/methodology.html
