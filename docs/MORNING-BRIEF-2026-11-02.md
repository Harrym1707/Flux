# FLUX distribution — overnight build brief (2026-11-02)

Phase-0 of the distribution/production-readiness program, built on branch
`levers-shim-blind-gateway`. **Full suite: 483/483.** Nothing was deployed,
published, or merged — everything is committed on the branch for your review.

## Done & committed tonight
| Commit | What |
|---|---|
| `security(proxy)` | CSRF-to-localhost defense (Sec-Fetch-Site), spool files 0600/dir 0700, `maxConnections` bound, + test |
| `feat(cli) version/doctor` | `flux version` (+--json), `flux doctor` (Node/proxy/Claude/service/ledger diagnostics); first CLI tests |
| `feat(cli) stop/update` | `flux stop` (non-destructive), `flux update` + `--rollback` (checksum-verified, backup-before-swap) |
| `chore(runtime)` | Node 22 LTS floor; `install.sh` now parses the Node version; `.nvmrc` |
| `docs` | internal `docs/distribution/` (architecture, security model, data map, release-signing plan, runtime policy, platform matrix) + customer `docs/guide/` |
| `test(cli)` | distribution-layer coverage: update/rollback/checksum-reject, settings merge+revert, clean-machine smoke |
| `feat(cli) verify` | real provenance check — re-hashes the cached runtime vs the recorded download checksum (was a no-op) |

## The audit's headline (reassuring)
The proxy was already sound: 127.0.0.1-only bind, Host allowlist (DNS-rebinding
defense, tested), clean non-persisted key passthrough, no SSRF. I had
**over-flagged** the security risk; tonight's changes are defense-in-depth, not
an emergency fix.

## Needs you (gated — not done overnight on purpose)
1. **Release signing in CI** — the website/curl channel's manifest is sha256-only
   (integrity, not authenticity). The plan is cosign-keyless / GitHub attestation
   of the published runtime (matches your npm provenance). It's **documented**
   (`docs/distribution/RELEASE-SIGNING.md`) but **not wired into `release.yml`**,
   because it can only be validated on a real tagged CI run — your call to add +
   tag. The local integrity half (above) is done.
2. **Lint/typecheck CI gates** — the audit found `lint` runs in no workflow and
   full `typecheck` doesn't gate releases. Worth adding, but the repo's ESLint is
   on the old config format; a short daytime task, not a safe blind overnight gate.
3. **Website install section** — the OS-detecting install block + the hero
   off-centre fix are parked (uncommitted); they need a visual pass and the
   deploy is outward. Ready to finish on your go.
4. **Deferred by design:** Windows (service + PowerShell installer + code-signing
   cert), native signed `.pkg`/`.msi` (your Apple/Windows accounts), bundled-Node
   single binary. All documented in `docs/distribution/PLATFORM-MATRIX.md`.

## Decisions I defaulted
- Node **22 LTS** floor (provision/check, not bundle).
- Signing = **cosign keyless** when wired (no private key to custody).
- Platforms tonight = **macOS + Linux + npm** only; Windows deferred.

## To review
`git log main..HEAD` on `levers-shim-blind-gateway`; the PR reflects it once pushed.
Outward steps awaiting your word: push→CI, the review PR, npm publish, and the
site deploy.
