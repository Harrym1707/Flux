# Configuring providers and clients

FLUX is just a local base URL. Point any client that honours a custom base URL at
the proxy and keep your own API key — FLUX passes it through verbatim to the
provider and never stores it.

The proxy listens on `http://127.0.0.1:8787` by default (change it with
`flux start --port <n>` or `flux install --port <n>`).

## Providers

### Anthropic (Messages API)

Base URL: `http://127.0.0.1:8787`

```js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
```

### OpenAI and OpenAI-compatible endpoints

Base URL: `http://127.0.0.1:8787/v1`

```js
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

Any OpenAI-compatible endpoint works the same way — it is only a base URL, so
Python, Go, curl, or any HTTP client is fine. FLUX forwards to the upstream you
configure (`https://api.anthropic.com` / `https://api.openai.com` by default).

## Claude Code

`flux start` and `flux install` wire this up for you automatically by writing
`ANTHROPIC_BASE_URL` into `~/.claude/settings.json`. You don't need to configure
anything by hand. See [Getting started](getting-started.md).

If you ran `flux start --no-install`, set it yourself:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

## Other clients

Any client with an Anthropic (or OpenAI) base-URL setting can route through FLUX.
Point its Anthropic base URL at the proxy and leave your key where it is:

| Client | How to point it at FLUX |
|---|---|
| **Cline** | Set the Anthropic base URL to `http://127.0.0.1:8787`. |
| **Aider** | Set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` in the environment. |
| **Continue** | Set the Anthropic provider's `apiBase` to `http://127.0.0.1:8787`. |
| **Zed** | Set the Anthropic assistant's base URL to `http://127.0.0.1:8787`. |

For OpenAI-style configuration in any of these, use `http://127.0.0.1:8787/v1`.

## Your key never leaves

Whatever the client, FLUX only rewrites the base URL. Your API key stays in the
client, is passed straight through to the provider, and is never stored, logged,
or written to the ledger. See [Data and privacy](data-and-privacy.md).
