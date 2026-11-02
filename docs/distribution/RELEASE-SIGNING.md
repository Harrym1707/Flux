# Release signing — planned release-trust upgrade

This is a plan, not a shipped feature. Nothing in the repo signs a release today
(`grep -ri cosign/sigstore` over the source finds nothing). This page states the
gap precisely and the chosen fix, so the work is scoped before it starts.

## The gap

The website curl channel delivers the runtime with **integrity but not
authenticity**:

- `/flux-version.json` carries a `sha256` over the runtime bytes, and the
  bootstrap verifies the download against it before running
  (`packages/cli/src/bootstrap.ts:76-80`). That proves the bytes match the
  manifest — nothing more.
- The manifest and the runtime are **committed to git** and **served
  same-origin** from `fluxtoken.dev` (`scripts/build-site.ts:388-403`,
  `.github/workflows/pages.yml`). An attacker — or an accident — that can write
  `docs/site/dist` moves the runtime *and* its sha256 together. The checksum
  attests nothing such an actor couldn't also replace. There is no signature
  binding the manifest to a key only the FLUX release pipeline holds.
- **No downgrade protection.** The bootstrap treats `version` as a plain
  change-detector (`have === manifest.version`, `bootstrap.ts:61`); it will
  happily move to any version the manifest names, including an older one served
  by a rollback attacker.

By contrast the npm channel already has authenticity: `@flux-ai/sdk` and
`@flux-ai/flux` publish with OIDC provenance and no long-lived token
(`.github/workflows/release.yml:17-49`). The website channel should match that
posture.

## The chosen fix: cosign keyless (Sigstore OIDC)

Sign `flux-version.json` in CI with **cosign keyless signing** (Sigstore,
backed by the workflow's OIDC identity). This mirrors the npm channel: no
long-lived private key exists to steal — the signing identity is the GitHub
Actions OIDC token, exactly the credential class provenance already uses.

Concretely:

1. **Sign the manifest in CI.** The release workflow runs `cosign sign-blob` (or
   equivalent) over `flux-version.json`, producing a signature + certificate that
   chain to the workflow's OIDC identity and the Rekor transparency log.
2. **Bootstrap verifies the signature before the sha256.** The order matters:
   authenticity first (is this manifest from the FLUX pipeline?), then integrity
   (do the runtime bytes match what that manifest says?). Only then does the
   bootstrap cache and exec the runtime. This replaces the trust currently placed
   in "whatever is committed at the same origin."
3. **`flux verify` adds a signature / provenance check.** Today `verify`'s
   provenance check is a build-commit string (`packages/cli/src/verify.ts:49-50`).
   It gains a real check: that the cached runtime's manifest signature verifies
   against the expected identity. A tampered or unsigned manifest fails `verify`.
4. **Downgrade protection.** The manifest gains a monotonic version/counter the
   bootstrap refuses to move backward, closing the rollback gap.
5. **Move the website-artifact deploy INTO the signing-enabled release
   workflow.** Today `pages.yml` uploads whatever is hand-committed to
   `docs/site/dist` (`.github/workflows/pages.yml:1-11`), and `release.yml`
   publishes only npm. The fix merges them: the website artifacts
   (`/flux`, `/flux-runtime`, `/flux-version.json`) are rebuilt from source at
   the tag, signed, and deployed **by the release workflow** — so there is no
   path that ships an unsigned or hand-committed runtime to curl users. Signing
   cannot be bypassed because the only deploy route goes through it. This also
   closes the drift risk documented in `ARCHITECTURE.md` (hand-committed website
   runtime vs tag-automated npm).
6. **Future native binaries go to GitHub Releases, not git.** When FLUX ships
   platform binaries (see `PLATFORM-MATRIX.md`), they are published as signed
   GitHub Release assets, not committed into `docs/site/dist`. Git stays for
   source; release artifacts live where they can be signed and versioned.
7. **Stable / beta channel pointers.** Small signed pointer JSONs
   (`stable`, `beta`) name the current manifest per channel, so a beta runtime
   can be promoted to stable by moving a signed pointer rather than rebuilding,
   and a user can opt into a channel explicitly.

## Done-in-CI-only vs locally testable

- **CI-only (cannot be fully exercised on a laptop):** keyless signing itself —
  it needs the workflow's OIDC identity and Rekor; a local `cosign sign-blob`
  would chain to a developer identity, not the release pipeline. The merged
  deploy path, and the "signing cannot be bypassed" property, are properties of
  the workflow and only meaningful in CI.
- **Locally testable:** the bootstrap's verify-signature-then-sha256 logic and
  its refusal behaviour (feed it a manifest with a bad/absent signature, a
  mismatched sha256, and a downgraded version, and assert it refuses each);
  `flux verify`'s new signature check against a fixture; and the manifest's
  monotonic-version comparison. These should ship with unit tests exactly as the
  proxy hardening did (`packages/sdk-js/src/proxy.test.ts:200-329`).
