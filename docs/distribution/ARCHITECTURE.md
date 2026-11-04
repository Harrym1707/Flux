# Distribution architecture

How MESH gets onto a user's machine, and how it stays current. Two channels,
one build. This describes what the code does today; where a channel has a known
weakness, it is named here and detailed in `RELEASE-SIGNING.md`.

## The two channels

MESH ships the same client surface — proxy + reducer + ledger + Theo — through
two independent paths. They differ in how a user obtains the bytes and how
those bytes are trusted.

### 1. npm (tag-automated, OIDC provenance)

Two packages publish from `release.yml` on a `v*` tag push:

- **`@mesh-ai/sdk`** — the library and the `mesh-proxy` / `mesh-quote` /
  `mesh-demo` / `mesh-report` bins. Built by `scripts/build-sdk-package.ts`.
- **`@mesh-ai/mesh`** — the downloadable CLI. Its `mesh` bin is the
  **self-contained runtime**, not the bootstrap: npm already versions the
  package, so there is no CDN/bootstrap indirection on this path
  (`scripts/build-cli-package.ts:78-92`).

Both publish with `npm publish --provenance` under OIDC trusted publishing — no
long-lived npm token exists to steal (`.github/workflows/release.yml:43,48`,
`permissions: id-token: write` at line 24). The workflow rebuilds each artifact
from source at the tagged commit before publishing, so the attestation covers a
tarball that genuinely comes from that commit rather than a committed stale
bundle (`release.yml:40-49`). `npm audit signatures` verifies the attestation;
`SECURITY.md` documents this as the answer to "you're asking me to pipe my key
through an unaudited package."

A third package, **`@mesh-ai/verify`** (`scripts/build-verify-package.ts`), is
published separately under MIT — the independent chain-verify + invoice-recompute
tool. It is part of the trust story, not a delivery channel for the runtime.

### 2. Website curl channel (bootstrap → runtime → manifest)

The channel behind `curl -fsSL https://www.mesh-technology.com/install.sh | sh`. It
exists so a user can install with no npm account and a download they can read in
full before running. Three hosted artifacts, all under `mesh-technology.com`:

| Hosted path | Artifact | Size (committed build) |
|---|---|---|
| `/mesh` | the bootstrap — the file you download | ~3KB (`3354` bytes) |
| `/mesh-runtime` | the client runtime | ~139KB (`139410` bytes) |
| `/mesh-version.json` | the update manifest | `{ version, sha256, runtime }` |

The bootstrap contains **none of the product's code** — only the launcher
(`packages/cli/src/bootstrap.ts:12`). This keeps the download tiny and means the
runtime is always fetched and checksum-verified, never shipped blind.

## The bootstrap → runtime → manifest flow

`packages/cli/src/bootstrap.ts` is the whole flow:

1. **First run:** fetch `/mesh-version.json`, fetch `/mesh-runtime`, verify its
   `sha256` against the manifest, cache it, exec it
   (`bootstrap.ts:48-85`). A checksum mismatch refuses to run the download and
   exits non-zero (`bootstrap.ts:76-80`).
2. **Later runs:** exec the cached runtime immediately with no network. It checks
   for a newer version at most once a day (`CHECK_INTERVAL_MS = 24h`,
   `bootstrap.ts:25,32-36,52-53`) and updates silently in the background of a
   launch. An update that fails to download is skipped if a cached runtime
   already exists (`bootstrap.ts:70-75`).
3. **Offline:** run the cached copy; only a fresh machine with no network and no
   cache errors out (`bootstrap.ts:56-60`).

The bootstrap then execs the runtime via `spawnSync(process.execPath, [RUNTIME,
...args])`, passing `MESH_BOOTSTRAP_PATH` so `mesh install` can register the
**self-updating bootstrap** (not the frozen runtime) with launchd
(`bootstrap.ts:87-97`, consumed at `packages/cli/src/daemon.ts:118-121`).

The manifest's `version` field is the short git commit, and `sha256` is over the
exact runtime bytes (`build-cli-package.ts:64-76`). The bootstrap treats
`version` only as a change-detector (`have === manifest.version`,
`bootstrap.ts:61`) — the integrity check is the sha256, not the version string.

## The `~/.mesh` cache layout

The bootstrap caches under `~/.mesh/runtime` (`bootstrap.ts:21-24`):

```
~/.mesh/
  runtime/
    mesh-runtime.mjs    the cached, checksum-verified runtime
    version             the manifest version the cache was written at
    .last-check         epoch-ms of the last manifest check (daily throttle)
  bin/mesh              stable copy of the bootstrap (mesh install, daemon.ts:23)
  ledger/               hash-chained spools (see DATA.md)
  theo-policy.json      Theo's lever policy (start.ts:154-158)
  blind.key             per-user HMAC key, 0600 (start.ts:74-80)
  daemon.log            launchd stdout/stderr (daemon.ts:22)
```

State outside `~/.mesh`: `~/.claude/settings.json` (base-URL wiring),
`~/Library/LaunchAgents/dev.meshtoken.mesh.plist` (the service), and — for SDK
users — `./.mesh/<app>.jsonl` in the app's own cwd
(`packages/sdk-js/src/wrap.ts:79`). Full contract in `DATA.md`.

## The build scripts

- **`scripts/build-cli-package.ts`** produces all three website artifacts plus
  the npm `@mesh-ai/mesh` manifest. It bundles `mesh-runtime.ts` and
  `bootstrap.ts` with esbuild (`target: node20`, `build-cli-package.ts:52`),
  stamps the runtime with the git commit (`__MESH_BUILD_COMMIT__`, line 64),
  computes the sha256, writes the manifest, and **smoke-tests the runtime by
  running `mesh-runtime verify`** — the build fails unless it prints
  `All checks passed` (`build-cli-package.ts:126-130`). Nothing here contacts a
  registry.
- **`scripts/build-site.ts`** hosts them: it copies `packages/cli/pkg/{mesh,
  mesh-runtime, mesh-version.json}` into the site output `docs/site/dist`, and
  copies `install.sh` (`build-site.ts:388-403`). If the CLI package has not been
  built, it warns that `/mesh` will 404 rather than shipping a stale copy
  (`build-site.ts:399-400`).

## Current deploy model: committed dist + GitHub Pages

The website is a **committed static site**. `scripts/build-site.ts` is run
locally; its output `docs/site/dist` — including `mesh`, `mesh-runtime`,
`mesh-version.json`, `install.sh` — is committed to git. `pages.yml` then
uploads the committed `docs/site/dist` to GitHub Pages on a push to `main` that
touches it; the workflow has **no build step and no dependencies**, it only
uploads bytes that were already checked locally
(`.github/workflows/pages.yml:1-5,29-35`).

### The drift risk

The two channels are deployed by different mechanisms, and only one is
automated from a tag:

- **npm** is tag-automated: `release.yml` rebuilds `@mesh-ai/mesh` from source at
  the tagged commit and publishes with provenance. The published runtime
  provably matches the tag.
- **the website runtime is hand-committed**: `/mesh-runtime` and its
  `/mesh-version.json` are whatever a human last built and committed into
  `docs/site/dist`. Nothing enforces that this equals the latest tag, the
  `@mesh-ai/mesh` runtime, or even `packages/cli/pkg`. A forgotten rebuild ships
  a stale runtime to curl users while npm users get the new one; the manifest's
  `version` (a commit hash) is the only signal, and it is only as fresh as
  whoever ran the build.

This is integrity-but-not-authenticity (anyone who can write the repo's
`docs/site/dist` sets what curl users run, and the sha256 is same-origin so it
attests nothing an attacker who moved the runtime couldn't also move) and it is
drift-prone. The fix — moving the website-artifact deploy into the signing
release workflow and signing the manifest — is specified in `RELEASE-SIGNING.md`.
