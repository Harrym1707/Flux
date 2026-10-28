# FLUX for Claude Code

**Stop paying twice for the same tokens.** This plugin routes Claude Code through the local
[FLUX](https://www.fluxtoken.dev) proxy. Every request is reduced before it bills, and every saving is
written to a hash-chained ledger on your machine.

## Install

```text
/plugin install flux --marketplace Harrym1707/Flux
```

On Claude Code older than 2.1.275, or from your shell:

```bash
claude plugin marketplace add Harrym1707/Flux && claude plugin install flux@flux
```

## Commands

| Command | What it does |
|---|---|
| `/flux` | Starts the proxy (`npx -y -p @flux-ai/sdk flux-proxy` on `127.0.0.1:8787`) and, once it answers, sets `ANTHROPIC_BASE_URL` in this project's `.claude/settings.local.json`. Add `--user` to set it for every project. Restart `claude` afterwards. |
| `/flux-stats` | Shows what FLUX saved. Uses `flux stats` once that ships, and otherwise tallies `~/.flux/ledger` itself (labelled "local tally, not an invoice"). |
| `/flux-off` | Removes the base URL, or restores the one FLUX replaced. `--stop` also stops the proxy. |

A SessionStart hook restarts the proxy in later sessions if FLUX is on, so Claude Code is never left
pointing at a dead port. If the proxy can't start, `/flux` leaves your settings untouched.

**What it never does:** read or store your prompts or keys (the auth header passes through verbatim), send
telemetry, or take over a base URL someone else set (a company gateway, for example) without `--force`.

Every helper is one zero-dependency script, `scripts/flux-cc.mjs`, which you can read in a minute.

## Codex CLI (same proxy, no plugin needed)

FLUX's proxy speaks the OpenAI Responses API. With an **API key** (ChatGPT-login traffic doesn't go to
api.openai.com), start the proxy and add this to `~/.codex/config.toml`:

```toml
model_provider = "flux"

[model_providers.flux]
name = "FLUX proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Not yet exercised end to end against Codex in our harness. Report problems in the issues.

## Cursor

Not shipped. Cursor sends model traffic through its own servers, so there's no one-line way to point
it at a proxy on your machine.

## Numbers

Every savings figure FLUX publishes, with its basis (LIVE or SIMULATOR), is in
[docs/NUMBERS.md](https://github.com/Harrym1707/Flux/blob/main/docs/NUMBERS.md). The fee is 1% of
verified savings. A month that saved nothing bills nothing.
