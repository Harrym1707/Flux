# Troubleshooting

## Start here: `flux doctor`

```bash
flux doctor
```

It checks, in order, and marks each ✓ / ⚠ / ✗ with a one-line fix:

- **node** — your Node version (22 LTS recommended; older than 20 is a hard fail).
- **runtime** — whether a fetched runtime is cached, or FLUX is running in place.
- **proxy** — whether the proxy is answering on `127.0.0.1:8787`.
- **claude** — Claude Code wiring: what `ANTHROPIC_BASE_URL` points at in
  `~/.claude/settings.json`.
- **service** — whether the always-on launchd service is installed (macOS).
- **ledger** — record count and whether the hash-chain verifies.

Add `--json` for machine-readable output. A hard failure exits non-zero.

## Common issues

### Proxy not running

`doctor` shows `⚠ proxy  not running on :8787`. Start it:

```bash
flux start
```

If you expect the always-on service to be running, check
`flux status`; if it shows the service installed but the proxy down, read
`~/.flux/daemon.log`.

### Claude Code isn't going through FLUX

`doctor`'s **claude** line should read `ANTHROPIC_BASE_URL → http://127.0.0.1:8787`.
If it says "not set" or points elsewhere, run `flux start` (or `flux install`) to
wire it up. If it says `~/.claude/settings.json is not valid JSON`, fix or remove
that file first — FLUX deliberately won't overwrite invalid JSON.

### Node too old

Upgrade to Node 22 LTS from <https://nodejs.org>. FLUX warns on Node 20–21 and
refuses to run on anything older.

### Port 8787 already in use

Something else is on the default port. Run FLUX on another port and point your
client at it:

```bash
flux start --port 9000
```

For the always-on service, use `flux install --port 9000`.

### Checksum or download failure on install

If the bootstrap reports the runtime failed its checksum, it refuses to run that
copy — try again, as it is usually a corrupted download. If it can't reach
`https://www.fluxtoken.dev` on a fresh machine with no cached runtime, check your
connection and retry; an existing install keeps working offline from its cache.

### Ledger chain broken

The ledger should never break. If `doctor` or `verify` reports a broken chain,
run `flux verify` and report it (see [Data and privacy](data-and-privacy.md) for
where the ledger lives).

## Still stuck?

See the project's security and reporting guidance, or open an issue on the
repository.
