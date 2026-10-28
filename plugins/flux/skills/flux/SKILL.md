---
name: flux
description: Route Claude Code through the local FLUX proxy so every API request is reduced before it bills. Starts the proxy, then sets ANTHROPIC_BASE_URL. Use when the user runs /flux or asks to turn FLUX on.
argument-hint: "[--user] [--port 8787] [--force]"
allowed-tools: Bash(node *)
disable-model-invocation: true
---

# /flux: switch FLUX on for Claude Code

Run exactly this, passing the user's arguments through:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/flux-cc.mjs" on $ARGUMENTS
```

What it does, in order (tell the user in two or three lines, no more):

1. Starts the FLUX proxy in the background if it isn't already answering:
   `npx -y -p @flux-ai/sdk flux-proxy` on `http://127.0.0.1:8787`, ledger in `~/.flux/ledger`, log in `~/.flux/proxy.log`.
2. Only once the proxy answers, writes `env.ANTHROPIC_BASE_URL=http://127.0.0.1:8787` into this project's
   `.claude/settings.local.json` (or `~/.claude/settings.json` with `--user`, for every project).
3. Claude Code reads the base URL at startup, so the user must **exit and run `claude` again**. Say this clearly.

Then read the output and report:

- **Exit 0**: FLUX is on. Remind them: `/flux-stats` shows savings, `/flux-off` goes direct again. The plugin's
  SessionStart hook restarts the proxy in later sessions so Claude Code is never left pointing at nothing.
- **Exit 2**: another base URL is already set (often a company gateway). Do not retry with `--force` yourself.
  Explain that FLUX's proxy forwards to api.anthropic.com, so switching would bypass that endpoint, and let the user decide.
- **Exit 1**: the proxy did not start, and settings were left unchanged. Show the last lines of `~/.flux/proxy.log`
  (Node 18+ and network access to npm are the usual causes).

Facts you may state if asked, and nothing beyond them:

- Prompts stay on this machine. The proxy passes the API key or login header through verbatim and stores neither.
  The ledger records usage numbers, lever names and hashes, not content. The proxy sends no telemetry: its only
  outbound traffic is the request itself, to the provider.
- Default levers are lossless (schema compaction, exact-duplicate removal, cache-prefix repair). Responses come back byte-identical.
- FLUX bills 1% of verified savings; a month that saved nothing bills nothing. Published savings figures and their
  labels live in https://github.com/Harrym1707/Flux/blob/main/docs/NUMBERS.md. Never quote a figure that is not in that file.
