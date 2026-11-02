# Command reference

Run `flux <command> --help` for a command's own options. `flux` with no command
(or `--help`) prints the summary.

## `flux start`

Start the proxy, point Claude Code at it, and run Theo alongside you. Reverts
`~/.claude/settings.json` cleanly on exit (Ctrl+C).

| Option | Meaning |
|---|---|
| `--port <n>` | Port for the local proxy. Default `8787`. |
| `--ledger <dir>` | Where to write the hash-chained ledger. Default `~/.flux/ledger`. |
| `--no-install` | Don't touch `~/.claude/settings.json`; just run the proxy. |
| `--help` | Show usage. |

## `flux status`

Is the service up, and what has Theo saved so far? Reports whether the launchd
service is installed, whether the proxy is answering on `127.0.0.1:8787`, and the
request count plus verified savings and verdict from your ledger.

## `flux install`

Always-on mode (macOS launchd). Copies the self-updating bootstrap to a stable
path (`~/.flux/bin/flux`), writes and loads a launchd agent (`dev.fluxtoken.flux`)
that runs the proxy at login and restarts it if it stops, points Claude Code at
FLUX permanently, and confirms the proxy came up. Logs to `~/.flux/daemon.log`.

| Option | Meaning |
|---|---|
| `--port <n>` | Port for the service's proxy. Default `8787`. |

On non-macOS platforms this reports that it isn't wired up yet and tells you to
use `flux start`.

## `flux uninstall`

Stop and remove the background service and restore Claude Code to normal. **Your
ledger is kept** at `~/.flux/ledger` — recompute it any time with `flux verify`.
macOS only, like `install`.

## `flux verify`

Re-prove FLUX's claims on this machine, with no network calls. Four checks:
provenance (the build commit), reducer (removes tokens losslessly from a sample),
ledger (your hash-chain verifies), and determinism (the invoice recomputes to the
identical number twice). Exits non-zero if any check fails, so it is safe in CI or
a hook.

## `flux doctor`

Diagnose this machine: Node version, the cached runtime, the proxy, Claude Code
wiring, the background service, and the ledger — each marked ✓ / ⚠ / ✗ with a
one-line fix. Pass `--json` for machine-readable output. Exits non-zero on a hard
failure. See [Troubleshooting](troubleshooting.md).

## `flux version`

Print the installed version, build commit, Node version, and platform. Pass
`--json` for machine-readable output. `flux --version` and `flux -v` work too.

## `flux analyse`

Measure a traffic log (OpenAI Responses / Chat Completions, Anthropic Messages,
or bare usage rows) and report what a reduction is worth — entirely locally.
Requires `--input <file.jsonl>` (repeatable). Run `flux analyse --help` for the
full option list. Prompt text is never written to the report; cache-breaking
values are redacted unless `--show-examples` is passed.

## Coming soon

These are being added and are **not yet available** in the shipped command set:

- `flux stop` — stop the background service without uninstalling it (today, use
  `flux uninstall` to remove it, or `flux install` again to re-register it).
- `flux update` — force a runtime update now (today, the bootstrap updates
  itself automatically, checking at most once a day).
