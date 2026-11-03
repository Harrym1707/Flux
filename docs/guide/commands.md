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
| `--openai-base <url>` | Send OpenAI-style traffic to this host instead of `api.openai.com` — any OpenAI-compatible provider (Grok, DeepSeek, Mistral, Llama, …). |
| `--anthropic-base <url>` | Send Anthropic traffic to this host instead of `api.anthropic.com`. |
| `--no-install` | Don't touch `~/.claude/settings.json`; just run the proxy. |
| `--help` | Show usage. |

FLUX is **not Claude-specific**. The proxy picks the upstream from each request
(Anthropic's `x-api-key` vs an OpenAI-style bearer) and passes your own key
straight through. Point any OpenAI-style client at it with
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, and use `--openai-base` (or the
`FLUX_OPENAI_UPSTREAM` environment variable) to target a non-OpenAI provider.

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

## `flux stop`

Stop the background service without removing it — the service definition is
kept, and Claude Code reverts to normal so it never points at a stopped proxy.
Resume always-on any time with `flux install`. Your ledger is untouched.

## `flux update`

Update the runtime now instead of waiting for the once-a-day automatic check.
It fetches the manifest and, if newer, downloads and checksum-verifies the
runtime, keeping the current one as a rollback point before swapping it in.

```bash
flux update              # update to the latest verified runtime
flux update --rollback   # restore the previous runtime
```

It never overwrites a working runtime until the replacement passes its checksum.
