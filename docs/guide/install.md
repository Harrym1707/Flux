# Install

FLUX is a local HTTP proxy that sits in front of your LLM API traffic, trims
the tokens you were about to pay for twice, and writes a hash-chained ledger you
can recompute yourself. It uses your own API key, passed straight through to the
provider — never stored, never logged.

## Requirements

- **Node 22+** (`flux doctor` treats Node 20 as a warning and anything older as
  a hard failure; 22 LTS is what we recommend and test on).
- **macOS or Linux** today. Windows is coming.

## Install (recommended)

```bash
curl -fsSL https://www.fluxtoken.dev/install.sh | sh
```

Then start it:

```bash
flux start
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
  manifest (`flux-version.json`), and refuses to run it if the checksum does not
  match.
- Later runs execute the cached copy instantly and check for a newer version at
  most once a day, updating quietly in the background.
- Offline, it runs the copy it already has.

The runtime is cached under `~/.flux/runtime`. The launcher never reads, stores,
or forwards your API key.

## Alternative: run without installing

If you have Node already, you can run the launcher through `npx` with nothing to
install:

```bash
npx @flux-ai/flux start
```

## Next

- [Getting started](getting-started.md) — point Claude Code at FLUX.
- [Commands](commands.md) — the full command reference.
- [Troubleshooting](troubleshooting.md) — start with `flux doctor`.
