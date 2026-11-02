# Data and privacy

FLUX asks you to point API traffic carrying your real provider key at a local
proxy. You should not take that on trust. Here is exactly what is stored, where,
and what never leaves your machine.

## What's stored, and where

Everything FLUX writes lives under `~/.flux/`:

| Path | What it is |
|---|---|
| `~/.flux/ledger/` | The hash-chained record of savings and spend — one append-only `.jsonl` spool per app/provider. Yours, auditable, and the sole input to the invoice. |
| `~/.flux/theo-policy.json` | Theo's current policy: which levers are enabled. Written once with defaults if absent. |
| `~/.flux/blind.key` | A per-user HMAC key (32 random bytes, file mode `0600`) for Theo's blind feature stream. Local only; never leaves your machine. |
| `~/.flux/runtime/` | The cached, checksum-verified runtime the bootstrap fetches. |
| `~/.flux/daemon.log` | Output of the always-on service, if installed. |

### The ledger is yours

Each request appends one hash-chained event: usage numbers, lever names, and
hashes — **never your prompt content, never your credentials**. The invoice is a
pure function of this file, which is why you can recompute it yourself. It never
leaves your machine.

Uninstalling the always-on service **keeps the ledger by default**:
`flux uninstall` stops and removes the launchd service and restores Claude Code,
but leaves `~/.flux/ledger` in place so you can still audit it.

## Your API key

- **Never stored.** FLUX only rewrites the base URL; your key stays in the client.
- **Never logged**, and never written to the ledger.
- **Passed straight through** to the upstream provider you configured
  (`https://api.anthropic.com` / `https://api.openai.com` by default).

## The proxy is local-only

- It **binds `127.0.0.1`** — it does not listen on your network.
- It **refuses cross-origin browser requests**, so a web page you visit can't
  reach it.
- Analysis runs entirely on your machine; FLUX never sends your prompts anywhere.

## Verify it yourself

Recompute the invoice from your own ledger, with no network calls:

```bash
flux verify
```

It confirms the build's provenance, that the reducer removes tokens losslessly,
that your ledger's hash-chain verifies, and that the invoice recomputes to the
identical number twice. If FLUX saved you nothing, it says so — the honest
outcome on already-lean traffic.
