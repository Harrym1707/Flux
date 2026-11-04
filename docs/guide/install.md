# Install

MESH is a local HTTP proxy that sits in front of your LLM API traffic, trims
the tokens you were about to pay for twice, and writes a hash-chained ledger you
can recompute yourself. It uses your own API key, passed straight through to the
provider — never stored, never logged.

## Requirements

- **Node 22 LTS or newer.** The runtime is built for Node 22; the installer and
  `mesh doctor` reject anything older. Claude Code already runs on Node 22.
- **macOS or Linux** for the one-line installer. On **Windows**, use the `npx`
  route below — the runtime itself is cross-platform; only the always-on service
  (`mesh install`) is macOS-only today.

## Install (recommended)

```bash
curl -fsSL https://www.fluxtoken.dev/install.sh | sh
```

Then start it:

```bash
mesh start
```

Piping a script to `sh` is worth a look first — the installer is small and
readable:

```bash
curl -fsSL https://www.fluxtoken.dev/install.sh | less
```

## What the install actually does

The one-time setup drops a single tiny launcher (the *bootstrap*). It contains
none of the product code — just enough to fetch and verify the runtime:

- On first run it downloads the runtime, checks its SHA-256 against a published
  manifest (`mesh-version.json`), and refuses to run it if the checksum does not
  match.
- Later runs execute the cached copy instantly and check for a newer version at
  most once a day, updating quietly in the background.
- Offline, it runs the copy it already has.

The runtime is cached under `~/.mesh/runtime`. The launcher never reads, stores,
or forwards your API key.

## Alternative: run without installing (agents, CI, Windows)

If you have Node already, you can run MESH through `npx` with nothing installed
and no changes to your PATH or shell profile — the best route for agents, CI
jobs, containers and Windows:

```bash
npx @mesh-ai/mesh start
```

For a headless setup that wires nothing up for you, start the proxy without
touching Claude Code's config and point your client at it yourself:

```bash
npx @mesh-ai/mesh start --no-install     # prints the proxy URL
# then set ANTHROPIC_BASE_URL=http://127.0.0.1:8787 in your environment
```

`MESH_BASE_URL` overrides where the launcher fetches the runtime from (for a
mirror or an air-gapped cache).

## Next

- [Getting started](getting-started.md) — point Claude Code at MESH.
- [Commands](commands.md) — the full command reference.
- [Troubleshooting](troubleshooting.md) — start with `mesh doctor`.
