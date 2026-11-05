# Supported runtime policy

The Node version MESH supports, where that version is encoded, and how the
installer must check it.

## The floor: Node 22 LTS

**Node 22 LTS is the supported floor.** Node 18 is end-of-life. Node 20 reaches
end-of-life imminently (2026-04). Supporting a runtime past its security-support
window is not something MESH should ask of a user who is pointing real API
traffic through it.

The code today does **not** yet encode this floor — it still targets and
declares older versions (listed below). Raising the floor to Node 22 means
updating every place the version is written, in lockstep, so the three channels
and the two install paths agree.

## Where the version is encoded

Each of these must move together to `node22` / `>=22`:

| File | What it encodes | Current value |
|---|---|---|
| `scripts/build-cli-package.ts:52` | esbuild `target` for bootstrap + runtime | `node20` |
| `scripts/build-cli-package.ts:88` | `@mesh-ai/mesh` `engines.node` | `>=20` |
| `scripts/build-sdk-package.ts:108` | esbuild `target` for the SDK bundles | `node18` |
| `scripts/build-sdk-package.ts:264` | `@mesh-ai/sdk` `engines.node` | `>=18` |
| `scripts/build-verify-package.ts:60` | esbuild `target` for the verify bundles | `node18` |
| `scripts/build-verify-package.ts:197` | `@mesh-ai/verify` `engines.node` | `>=18` |
| `docs/site/install.sh:13-16` | the Node requirement message | "Node.js 20+" |
| `docs/site/start.md:5,11` | the documented requirement | "Node 20+" |

The esbuild `target` governs which language features the bundle may use; the
`engines.node` governs what npm warns on; `install.sh` and `start.md` govern what
the user is told. If these disagree, a user can install a runtime that then fails
at a syntax level, or be told a floor the package doesn't enforce. Keep them
identical.

(For reference, CI already runs newer Node: `release.yml` publishes on Node 24,
`pages.yml`'s geo-audit on Node 22. Those are build-time, not the supported
client floor, but they confirm Node 22+ is the direction.)

## The installer must PARSE the version, not just check existence

Today `install.sh` only checks that `node` is **present**:

```sh
if ! command -v node >/dev/null 2>&1; then ... exit 1; fi
```

(`docs/site/install.sh:13-17`). A user with Node 16 installed passes this check
and then hits an obscure runtime failure. The installer must instead **parse**
`node --version` and refuse below the floor with a clear message — "MESH needs
Node 22+; you have vX" — pointing at nodejs.org, exactly as it already does for
the missing-node case. Existence is not a version check.

## Forward option: a bundled runtime (future track, not current)

A longer-term way out of the Node-floor problem entirely: ship MESH with its own
Node, so the user's installed version stops mattering. Candidates are a Node
**single executable application (SEA)** or a **Bun single binary**, producing one
self-contained executable per platform.

This is a **future track**, not the current plan. It interacts with
`RELEASE-SIGNING.md` (native binaries go to signed GitHub Releases, not git) and
`PLATFORM-MATRIX.md` (one binary per platform/arch). Until then, the floor is a
system Node 22 LTS, enforced at install time by parsing the version.
