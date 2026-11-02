# Data-preservation contract

What lives on a user's disk, and what an upgrade or an uninstall is allowed to
touch. The governing principle: **the ledger is the customer's auditable billing
record, and it is theirs.** FLUX bills from it; the customer recomputes the
invoice from it with `flux verify`. Destroying or rewriting it would destroy the
one thing that makes FLUX's honesty checkable.

## Everything on disk

### Under `~/.flux` (`FLUX_HOME`, `packages/cli/src/start.ts:41`)

| Path | What it is | Survive upgrade? | Survive uninstall? |
|---|---|---|---|
| `ledger/*.jsonl` | hash-chained billing ledger — the customer's record | **MUST** | **MUST** |
| `ledger/*.features.jsonl` | blind learning features (irreversible hashes + counts) | yes | yes |
| `theo-policy.json` | Theo's lever policy for this machine | **MUST** | **MUST** |
| `blind.key` | per-user HMAC key, `0600` | **MUST** | **MUST** |
| `runtime/flux-runtime.mjs` | cached, checksum-verified runtime | **replaceable** | removable |
| `runtime/version`, `runtime/.last-check` | cache bookkeeping | replaceable | removable |
| `bin/flux` | stable copy of the bootstrap (for launchd) | replaceable | removable |
| `daemon.log` | launchd stdout/stderr | replaceable | removable |

Only `runtime/*` (and the derived `bin/`, `daemon.log`) is replaceable.
Everything else is user data.

### State outside `~/.flux`

| Path | What it is | Rule |
|---|---|---|
| `~/.claude/settings.json` | Claude Code config; FLUX sets `env.ANTHROPIC_BASE_URL` | **merge, never replace** |
| `~/Library/LaunchAgents/dev.fluxtoken.flux.plist` | the launchd service | created by `install`, removed by `uninstall` |
| `./.flux/<app>.jsonl` | SDK-embedded ledger in the app's own cwd | the app's data; FLUX never deletes it (`packages/sdk-js/src/wrap.ts:79`) |

## The ledger format

Each spool is append-only JSONL, one `LedgerRecord` per line. Each record is
hash-chained (`packages/core/src/savings-ledger.ts:165-183`):

```
record = { seq, prevHash, eventHash, event }
seq       : 0-based position in the chain
prevHash  : the previous record's eventHash (LEDGER_GENESIS_HASH = 64 zeros at seq 0)
eventHash : sha256( `${seq}\n${prevHash}\n${canonicalJson(event)}` )
```

`verifyLedgerChain` walks the file and fails at the exact seq where `seq`,
`prevHash`, or `eventHash` stops matching (`savings-ledger.ts:194-209`). A
perturbed or missing record is detectable and located. The ledger records usage
numbers, lever names and hashes — **never prompt content, never credentials**
(`SECURITY.md`; `proxy.ts:26-31`).

### Why in-place runtime swaps are safe: chain-resume on restart

A new runtime process does not start a fresh chain. On construction the ledger
reads the spool's tail and resumes from it (`resumeChainTail`,
`packages/sdk-js/src/savings-ledger.ts:273-308`): `previous` is set to the last
record, so the next `emit` continues the chain at `seq + 1` with the correct
`prevHash`. This is what makes the bootstrap's silent in-place runtime update
(`bootstrap.ts:81`) safe — swapping `~/.flux/runtime/flux-runtime.mjs` under a
live, append-only ledger cannot fork or break the chain.

If the tail cannot be parsed, the meter **disables itself** rather than extend a
broken chain (`savings-ledger.ts:279-285,309-313`) — the on-disk record stays
internally consistent even at the cost of dropping events.

## `flux verify` is the acceptance check

`flux verify` (`packages/cli/src/verify.ts`) is how you confirm a FLUX
install — and an upgrade — is intact. It runs four checks: provenance (build
commit), reducer (losslessly removes tokens from a sample), ledger (every spool
chain verifies), and determinism (the invoice recomputes identically twice). It
exits non-zero if any fails, so it is safe in CI or a post-upgrade hook
(`verify.ts:46-118`). After any runtime swap, `flux verify` passing is the signal
that the customer's ledger survived intact.

## The rules

- **Uninstall keeps the ledger by default, and must say so.** `flux uninstall`
  stops and removes the service and clears the base URL, but does **not** touch
  `~/.flux/ledger`, and it prints where the ledger was kept and how to recompute
  it (`packages/cli/src/daemon.ts:151-160`). Any future uninstall that offers to
  remove data must preserve this default and the message.
- **`settings.json` edits are merge-not-replace.** FLUX parses the existing
  JSON, sets only `env.ANTHROPIC_BASE_URL`, and writes the merged object back; if
  the file is not valid JSON it **refuses rather than overwrite**
  (`start.ts:83-98`, `daemon.ts:64-73`). Teardown restores the prior
  `ANTHROPIC_BASE_URL` (or deletes just that key), and removes `env` only if it
  became empty, and the file only if FLUX created nothing worth keeping
  (`start.ts:100-114`, `daemon.ts:75-85`).
- **Never `rm -rf ~/.flux`.** The ledger, `theo-policy.json`, and `blind.key`
  live there. A clean of the cache removes `runtime/` (and `bin/`, `daemon.log`)
  only — never the user-data siblings.
