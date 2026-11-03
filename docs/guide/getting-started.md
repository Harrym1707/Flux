# Getting started

This walks you from a fresh install to Claude Code running through FLUX, then to
an always-on background service. If you have not installed yet, see
[Install](install.md).

## Point Claude Code at FLUX

One command:

```bash
flux start
```

That does three things:

1. Starts the FLUX proxy locally (default `http://127.0.0.1:8787`), writing a
   hash-chained ledger under `~/.flux/ledger`.
2. Writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json` so Claude Code
   talks to FLUX. (It won't overwrite that file if it isn't valid JSON — it
   tells you to fix it first.)
3. Runs **Theo**, who applies only gate-proven levers and reports savings
   verified from your provider's own reported usage — never an estimate.

Now just **use Claude Code exactly as normal**. As requests flow, Theo prints a
running count and the verified amount saved.

### Stopping

Press **Ctrl+C**. FLUX restores `~/.claude/settings.json` to exactly what it was
before (removing `ANTHROPIC_BASE_URL`, or putting back your prior value), closes
the proxy, and prints the session total. Claude Code is never left pointing at a
stopped proxy.

### Options

```bash
flux start --port 9000      # use a different local port
flux start --ledger ~/led   # write the ledger somewhere else
flux start --no-install     # run the proxy only; don't touch ~/.claude/settings.json
```

With `--no-install`, set `ANTHROPIC_BASE_URL` yourself to the proxy URL FLUX
prints.

## Always-on (macOS)

To have every Claude Code session optimised with nothing to start by hand,
install FLUX as a background service:

```bash
flux install
```

This registers a launchd agent (`dev.fluxtoken.flux`) that runs the proxy, starts
at login, and restarts if it stops. It points Claude Code at FLUX permanently and
confirms the proxy actually answered before reporting success. Logs go to
`~/.flux/daemon.log`.

Check in on it any time:

```bash
flux status
```

Turn it off and restore Claude Code (your ledger is kept):

```bash
flux uninstall
```

> Always-on uses macOS launchd. On Linux, `flux install` / `flux uninstall` are
> not wired up yet — use `flux start`, which does the same job while it runs.

## Verify your savings

The savings number is a pure function of a ledger file *you* hold. Recompute it,
with no network calls, any time:

```bash
flux verify
```

It re-proves the build's provenance, confirms the reducer removes tokens
losslessly on a sample request, verifies your ledger's hash-chain, and checks the
invoice recomputes to the identical number twice. If FLUX saved you nothing, it
says so honestly.

## Next

- [Configure](configure.md) — providers and other clients (Cline, Aider, Zed…).
- [Commands](commands.md) — every command and its options.
- [Data and privacy](data-and-privacy.md) — what's stored, and your key's path.
